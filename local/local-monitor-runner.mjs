import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(directory, 'local-monitor-cdp-v2.mjs');
const source = await fs.readFile(sourcePath, 'utf8');

function replaceBlock(input, startMarker, endMarker, replacement, description) {
  const startIndex = input.indexOf(startMarker);
  const endIndex = input.indexOf(endMarker, startIndex);
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
    throw new Error(`Could not locate ${description} boundaries in local-monitor-cdp-v2.mjs.`);
  }
  return input.slice(0, startIndex) + replacement + input.slice(endIndex);
}

const newSelectVariant = String.raw`function fullcountHeadingPattern(kind, value) {
  const escaped = String(value).replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
  const label = kind === 'colour' ? '(?:COLOR|カラー|色)' : '(?:SIZE|サイズ|商品サイズ)';
  return new RegExp(label + '\\s*[:：]\\s*' + escaped + '(?:\\s|$)', 'i');
}

async function fullcountVariantSelected(page, kind, value) {
  const text = (await bodyText(page)).replace(/\\s+/g, ' ');
  return fullcountHeadingPattern(kind, value).test(text);
}

async function waitForFullcountVariant(page, kind, value, timeoutMs = 7_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fullcountVariantSelected(page, kind, value)) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

async function locateFullcountTile(page, kind, value) {
  const target = await page.evaluate(({ kind, value }) => {
    const normalise = input => String(input || '').replace(/\\s+/g, ' ').trim();
    const escapeRegex = input => String(input).replace(/[.*+?^$()|[\\]\\\\{}]/g, '\\$&');
    const escaped = escapeRegex(value);
    const pattern = kind === 'colour'
      ? new RegExp('^' + escaped + '(?:\\s|$)', 'i')
      : new RegExp('^' + escaped + '(?:\\s|$)', 'i');

    const roots = [document];
    const elements = [];
    const seen = new Set();
    for (let rootIndex = 0; rootIndex < roots.length; rootIndex++) {
      for (const element of roots[rootIndex].querySelectorAll('*')) {
        if (!seen.has(element)) {
          seen.add(element);
          elements.push(element);
        }
        if (element.shadowRoot && !roots.includes(element.shadowRoot)) roots.push(element.shadowRoot);
      }
    }

    const candidates = [];
    const addCandidate = element => {
      if (!element || candidates.some(item => item.element === element)) return;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return;

      const rect = element.getBoundingClientRect();
      if (rect.width < 55 || rect.height < 30 || rect.width > 700 || rect.height > 240) return;

      const text = normalise(element.innerText || element.textContent);
      if (!text || text.length > 180 || !pattern.test(text)) return;

      const border =
        parseFloat(style.borderTopWidth || '0') +
        parseFloat(style.borderRightWidth || '0') +
        parseFloat(style.borderBottomWidth || '0') +
        parseFloat(style.borderLeftWidth || '0') +
        parseFloat(style.outlineWidth || '0');
      const tileShape = kind === 'colour'
        ? rect.width >= 180 && rect.height >= 42
        : rect.width >= 85 && rect.width <= 250 && rect.height >= 48;
      const clickable = ['BUTTON', 'LABEL', 'A'].includes(element.tagName) ||
        element.getAttribute('role') === 'button' ||
        style.cursor === 'pointer';
      const exact = normalise(text).toUpperCase() === String(value).toUpperCase();
      const area = rect.width * rect.height;
      const preferredArea = kind === 'colour' ? 24_000 : 11_000;
      const score =
        (border > 0 ? 5_000_000 : 0) +
        (tileShape ? 3_000_000 : 0) +
        (clickable ? 500_000 : 0) +
        (exact ? 250_000 : 0) -
        Math.abs(area - preferredArea);

      candidates.push({ element, text, score });
    };

    for (const element of elements) {
      const text = normalise(element.innerText || element.textContent);
      if (!text || text.length > 180 || !pattern.test(text)) continue;
      let current = element;
      for (let depth = 0; current && depth < 7; depth++) {
        addCandidate(current);
        if (current.parentElement) current = current.parentElement;
        else {
          const root = current.getRootNode?.();
          current = root?.host || null;
        }
      }
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    best.element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = best.element.getBoundingClientRect();
    return {
      text: best.text,
      tag: best.element.tagName.toLowerCase(),
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height
    };
  }, { kind, value });

  if (!target) return null;
  await page.waitForTimeout(500);
  return target;
}

async function clickFullcountTile(page, kind, value) {
  if (await fullcountVariantSelected(page, kind, value)) {
    result.diagnostics.push(`${kind} ${value} was already selected.`);
    return true;
  }

  const target = await locateFullcountTile(page, kind, value);
  if (!target) {
    result.diagnostics.push(`Could not locate the bordered ${kind} ${value} tile.`);
    return false;
  }

  result.diagnostics.push(
    `Located ${kind} ${value} tile: ${target.text} [${target.tag}, ${Math.round(target.width)}x${Math.round(target.height)}].`
  );

  for (const yFraction of [0.5, 0.35, 0.65]) {
    const x = target.x + target.width / 2;
    const y = target.y + target.height * yFraction;
    await page.mouse.move(x, y, { steps: 10 });
    await page.mouse.click(x, y, { delay: 120 });
    result.diagnostics.push(`Mouse-clicked ${kind} ${value} tile at ${Math.round(x)},${Math.round(y)}.`);
    if (await waitForFullcountVariant(page, kind, value, 2_500)) {
      result.diagnostics.push(`${kind} ${value} confirmed in the selection heading.`);
      return true;
    }
  }

  return false;
}

async function selectVariant(page) {
  const colourSelected = await clickFullcountTile(page, 'colour', 'ONE WASH');
  result.w33.colour_selected = colourSelected;
  if (!colourSelected) throw new Error('ONE WASH tile could not be selected or confirmed.');
  await page.waitForTimeout(600);

  const sizeSelected = await clickFullcountTile(page, 'size', '33');
  result.w33.size_selected = sizeSelected;
  if (!sizeSelected) throw new Error('Size 33 tile could not be selected or confirmed.');
  await page.waitForTimeout(800);
}`;

const newQuantityReader = String.raw`async function readQuantity(page) {
  const labelledQuantity = /(?:quantity|数量|個数)\s*[:：]?\s*(\d+)/i;
  const pageText = (await bodyText(page)).replace(/\s+/g, ' ');
  const textMatch = pageText.match(labelledQuantity);
  if (textMatch) {
    const quantity = parseQuantity(textMatch[1]);
    if (quantity !== null) {
      result.diagnostics.push('Quantity read from labelled page text: ' + quantity + '.');
      return quantity;
    }
  }

  const controls = page.locator([
    'select[name*="quantity" i]', 'select[id*="quantity" i]', 'select[aria-label*="quantity" i]',
    'select[name*="qty" i]', 'select[id*="qty" i]', 'select[aria-label*="qty" i]',
    'select[aria-label*="数量"]', 'select[aria-label*="個数"]',
    'input[name*="quantity" i]', 'input[id*="quantity" i]', 'input[aria-label*="quantity" i]',
    'input[name*="qty" i]', 'input[id*="qty" i]', 'input[aria-label*="qty" i]',
    'input[aria-label*="数量"]', 'input[aria-label*="個数"]'
  ].join(','));

  for (let index = 0; index < await controls.count(); index++) {
    const control = controls.nth(index);
    try {
      if (!await control.isVisible()) continue;
      let raw = await control.inputValue().catch(() => '');
      if (!raw) raw = await control.locator('option:checked').textContent().catch(() => '');
      const quantity = parseQuantity(raw);
      if (quantity !== null) {
        result.diagnostics.push('Quantity read from explicitly labelled control: ' + quantity + '.');
        return quantity;
      }
    } catch {}
  }

  return null;
}`;

let runtimeSource = replaceBlock(
  source,
  'async function selectVariant(page) {',
  '\nasync function clickPurchaseProcedure(page) {',
  newSelectVariant,
  'selectVariant'
);

runtimeSource = replaceBlock(
  runtimeSource,
  'async function readQuantity(page) {',
  '\nasync function verifyConfirmation(page) {',
  newQuantityReader,
  'readQuantity'
);

if (process.env.RAKUTEN_KEEP_ITEM === '1') {
  const cleanupCall = 'await removeVerifiedItem(outcome.page);';
  const occurrences = runtimeSource.split(cleanupCall).length - 1;
  if (occurrences !== 2) {
    throw new Error(`Expected two cleanup calls in local-monitor-cdp-v2.mjs, found ${occurrences}.`);
  }
  runtimeSource = runtimeSource.replaceAll(
    cleanupCall,
    "result.diagnostics.push('Verified item retained in the dedicated profile for the visible setup test.');"
  );
}

const generatedPath = path.join(directory, '.local-monitor-cdp-v2-runtime.mjs');
await fs.writeFile(generatedPath, runtimeSource);

if (process.env.RAKUTEN_PATCH_ONLY === '1') {
  console.log(`Generated patched monitor: ${generatedPath}`);
} else {
  await import(`${pathToFileURL(generatedPath).href}?run=${Date.now()}`);
}
