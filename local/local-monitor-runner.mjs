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
    throw new Error('Could not locate ' + description + ' boundaries in local-monitor-cdp-v2.mjs.');
  }
  return input.slice(0, startIndex) + replacement + input.slice(endIndex);
}

const newBodyText = String.raw`async function bodyText(target) {
  if (target && typeof target.frames === 'function') {
    const parts = [];
    for (const frame of target.frames()) {
      const text = await frame.locator('body').innerText().catch(() => '');
      if (text) parts.push(text);
    }
    return parts.join('\n');
  }
  return await target.locator('body').innerText().catch(() => '');
}`;

const newSelectVariant = String.raw`async function frameText(page) {
  return (await bodyText(page)).replace(/\s+/g, ' ');
}

async function variantSelected(page, kind, value) {
  const text = await frameText(page);
  if (kind === 'colour') {
    return /(?:COLOR|カラー|色)\s*[:：]\s*ONE WASH(?:\s|$)/i.test(text);
  }
  return /(?:SIZE|サイズ|商品サイズ)\s*[:：]\s*33(?:\s|$)/i.test(text);
}

async function tryCandidate(page, candidate, description, kind, value) {
  try {
    if (!await candidate.isVisible()) return false;
    await candidate.scrollIntoViewIfNeeded();

    const box = await candidate.boundingBox().catch(() => null);
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 120 });
    } else {
      await candidate.click({ force: true, timeout: 3_000 });
    }

    for (let attempt = 0; attempt < 8; attempt++) {
      if (await variantSelected(page, kind, value)) {
        result.diagnostics.push('Selected ' + description + ' across Rakuten frames.');
        return true;
      }
      await page.waitForTimeout(250);
    }

    await candidate.evaluate(element => {
      const control = element.closest('label,button,[role="button"],a') || element;
      control.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      control.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      control.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      if (typeof control.click === 'function') control.click();
    }).catch(() => {});

    for (let attempt = 0; attempt < 8; attempt++) {
      if (await variantSelected(page, kind, value)) {
        result.diagnostics.push('Selected ' + description + ' by DOM click fallback.');
        return true;
      }
      await page.waitForTimeout(250);
    }
  } catch (error) {
    result.diagnostics.push(description + ' candidate failed: ' + error.message);
  }
  return false;
}

async function clickAcrossFrames(page, locatorFactories, description, kind, value) {
  const frames = page.frames();
  result.diagnostics.push('Searching ' + frames.length + ' frame(s) for ' + description + '.');

  for (const frame of frames) {
    for (const factory of locatorFactories) {
      const locator = factory(frame);
      const count = await locator.count().catch(() => 0);
      if (count) {
        result.diagnostics.push('Found ' + count + ' ' + description + ' candidate(s) in frame ' + frame.url() + '.');
      }
      for (let index = 0; index < count; index++) {
        if (await tryCandidate(page, locator.nth(index), description, kind, value)) return true;
      }
    }
  }
  return false;
}

async function selectVariant(page) {
  const colourSelected = await clickAcrossFrames(
    page,
    [
      frame => frame.getByText('ONE WASH', { exact: true }),
      frame => frame.locator('label').filter({ hasText: /^\s*ONE WASH\s*$/i }),
      frame => frame.getByRole('button', { name: /^\s*ONE WASH\s*$/i }),
      frame => frame.locator('[data-value="ONE WASH"],input[value="ONE WASH"],button[value="ONE WASH"]')
    ],
    'ONE WASH',
    'colour',
    'ONE WASH'
  );
  result.w33.colour_selected = colourSelected;
  if (!colourSelected) throw new Error('ONE WASH could not be selected across any Rakuten frame.');
  await page.waitForTimeout(700);

  const sizeSelected = await clickAcrossFrames(
    page,
    [
      frame => frame.locator('input[value="33"],button[value="33"],[data-value="33"]'),
      frame => frame.getByRole('button', { name: /^\s*33(?:\s|$)/ }),
      frame => frame.locator('label').filter({ hasText: /^\s*33(?:\s|$)/ }),
      frame => frame.getByText(/^\s*33(?:\s|$)/)
    ],
    'size 33',
    'size',
    '33'
  );
  result.w33.size_selected = sizeSelected;
  if (!sizeSelected) throw new Error('Size 33 could not be selected across any Rakuten frame.');
  await page.waitForTimeout(1_000);
}`;

const newPurchase = String.raw`async function clickPurchaseProcedure(page) {
  let best = null;
  let bestArea = -1;
  let bestFrameUrl = '';

  for (const frame of page.frames()) {
    const candidates = frame.locator('button,[role="button"],a').filter({
      hasText: /購入手続きへ|購入手続き|Proceed to purchase|Purchase procedure/i
    });

    const count = await candidates.count().catch(() => 0);
    for (let index = 0; index < count; index++) {
      const candidate = candidates.nth(index);
      try {
        if (!await candidate.isVisible()) continue;
        const box = await candidate.boundingBox();
        if (!box) continue;
        const area = box.width * box.height;
        if (area > bestArea) {
          best = candidate;
          bestArea = area;
          bestFrameUrl = frame.url();
        }
      } catch {}
    }
  }

  if (!best) throw new Error('No visible 購入手続きへ control was found in any Rakuten frame.');
  await best.scrollIntoViewIfNeeded();
  const box = await best.boundingBox();
  if (!box) throw new Error('購入手続きへ had no clickable bounding box.');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 120 });
  result.w33.purchase_button_clicked = true;
  result.diagnostics.push('Clicked 購入手続きへ in frame ' + bestFrameUrl + '.');
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

  for (const frame of page.frames()) {
    const controls = frame.locator([
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
        if (quantity !== null) return quantity;
      } catch {}
    }
  }
  return null;
}`;

let runtimeSource = replaceBlock(
  source,
  'async function bodyText(page) {',
  '\nasync function safeScreenshot(page, name) {',
  newBodyText,
  'bodyText'
);

runtimeSource = replaceBlock(
  runtimeSource,
  'async function selectVariant(page) {',
  '\nasync function clickPurchaseProcedure(page) {',
  newSelectVariant,
  'selectVariant'
);

runtimeSource = replaceBlock(
  runtimeSource,
  'async function clickPurchaseProcedure(page) {',
  '\nfunction confirmationScore(text) {',
  newPurchase,
  'clickPurchaseProcedure'
);

runtimeSource = replaceBlock(
  runtimeSource,
  'async function readQuantity(page) {',
  '\nasync function verifyConfirmation(page) {',
  newQuantityReader,
  'readQuantity'
);

const mainStart = 'async function main() {\n  await acquireLock();\n  let context;\n  try {\n    const browser = await chromium.connectOverCDP(CDP_ENDPOINT);';
const mainReplacement = 'async function main() {\n  await acquireLock();\n  let browser;\n  let context;\n  try {\n    browser = await chromium.connectOverCDP(CDP_ENDPOINT);';
if (!runtimeSource.includes(mainStart)) {
  throw new Error('Could not locate the Fullcount main/CDP connection block.');
}
runtimeSource = runtimeSource.replace(mainStart, mainReplacement);

const finallyStart = "  } finally {\n    await fs.writeFile(path.join(ARTIFACT_DIR, 'result.json'), JSON.stringify(result, null, 2));";
const finallyReplacement = "  } finally {\n    if (browser) await browser.close().catch(() => {});\n    await fs.writeFile(path.join(ARTIFACT_DIR, 'result.json'), JSON.stringify(result, null, 2));";
if (!runtimeSource.includes(finallyStart)) {
  throw new Error('Could not locate the Fullcount final result-write block.');
}
runtimeSource = runtimeSource.replace(finallyStart, finallyReplacement);

if (process.env.RAKUTEN_KEEP_ITEM === '1') {
  const cleanupCall = 'await removeVerifiedItem(outcome.page);';
  const occurrences = runtimeSource.split(cleanupCall).length - 1;
  if (occurrences !== 2) {
    throw new Error('Expected two cleanup calls in local-monitor-cdp-v2.mjs, found ' + occurrences + '.');
  }
  runtimeSource = runtimeSource.replaceAll(
    cleanupCall,
    "result.diagnostics.push('Verified item retained in the dedicated profile for the visible setup test.');"
  );
}

const generatedPath = path.join(directory, '.local-monitor-cdp-v2-runtime.mjs');
await fs.writeFile(generatedPath, runtimeSource);

if (process.env.RAKUTEN_PATCH_ONLY === '1') {
  console.log('Generated patched monitor: ' + generatedPath);
} else {
  await import(pathToFileURL(generatedPath).href + '?run=' + Date.now());
}
