import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(directory, 'rakuten-multi-watch.mjs');
const generatedPath = path.join(directory, '.rakuten-multi-watch-runtime-v4.mjs');
const NL = String.fromCharCode(10);
let source = (await fs.readFile(sourcePath, 'utf8')).replace(/\r\n/g, NL);

function replaceBlock(input, startMarker, endMarker, replacement, description) {
  const startIndex = input.indexOf(startMarker);
  const endIndex = input.indexOf(endMarker, startIndex);
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
    throw new Error(`Could not locate runtime patch boundaries for ${description}.`);
  }
  return input.slice(0, startIndex) + replacement + input.slice(endIndex);
}

function replaceExactlyOnce(input, pattern, replacement, description) {
  const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
  const matches = input.match(new RegExp(pattern.source, flags)) ?? [];
  if (matches.length !== 1) {
    throw new Error(`Expected one patch match for ${description}, found ${matches.length}.`);
  }
  return input.replace(pattern, replacement);
}

source = replaceExactlyOnce(
  source,
  /    selectionOrder: \['size', 'colour'\],\n    alertMode: 'stock'/,
  [
    "    selectionOrder: ['size', 'colour'],",
    '    visualSizeIndex: 2,',
    '    visualSizeCount: 5,',
    '    visualColourIndex: 0,',
    '    visualColourCount: 1,',
    "    alertMode: 'stock'"
  ].join(NL),
  '8173 geometry metadata'
);

source = replaceExactlyOnce(
  source,
  /    selectionOrder: \['size'\],\n    alertMode: 'stock'/,
  [
    "    selectionOrder: ['size'],",
    '    visualSizeIndex: 0,',
    '    visualSizeCount: 4,',
    "    alertMode: 'stock'"
  ].join(NL),
  '8186 geometry metadata'
);

const variantRegexReplacement = String.raw`function variantRegex(value, kind) {
  const escaped = escapeRegExp(value);
  if (kind === 'size') {
    return new RegExp('^\\s*(?:(?:Size|サイズ)\\s*)?' + escaped + '(?:\\s|$)', 'i');
  }
  return new RegExp('^\\s*' + escaped + '(?:\\s|$)', 'i');
}`;

source = replaceBlock(
  source,
  'function variantRegex(value, kind) {',
  NL + 'async function clickVariant(page, value, kind, watchResult) {',
  variantRegexReplacement,
  'variantRegex'
);

const selectVariantsReplacement = String.raw`async function scrollToVariantArea(page, watchResult) {
  const anchors = [
    page.getByText(/商品詳細を選択|Select product details/i).first(),
    page.getByText(/商品サイズ|Product size/i).first(),
    page.getByText(/^SIZE\\s*[:：]?/i).first()
  ];

  for (const anchor of anchors) {
    try {
      if (await anchor.count() && await anchor.isVisible()) {
        await anchor.scrollIntoViewIfNeeded();
        await page.waitForTimeout(1_200);
        watchResult.diagnostics.push('Scrolled to the Rakuten product-detail selector.');
        return;
      }
    } catch {}
  }

  await page.evaluate(() => {
    window.scrollTo({ top: Math.floor(document.body.scrollHeight * 0.55), behavior: 'instant' });
  });
  await page.waitForTimeout(1_200);
  watchResult.diagnostics.push('Used fallback scroll to locate the Rakuten product-detail selector.');
}

function selectedVariantHeadingPattern(value, kind) {
  const escaped = escapeRegExp(value);
  if (kind === 'size') {
    return new RegExp(
      '(?:商品サイズ|Product\\s*size)\\s*[:：]\\s*(?:(?:Size|サイズ)\\s*)?' + escaped + '(?:\\s|$)',
      'i'
    );
  }
  return new RegExp(
    '(?:COLOR|カラー|色)\\s*[:：]\\s*' + escaped + '(?:\\s|$)',
    'i'
  );
}

async function variantIsSelected(page, value, kind) {
  const pattern = selectedVariantHeadingPattern(value, kind);
  const text = (await bodyText(page)).replace(/\\s+/g, ' ');
  return pattern.test(text);
}

async function waitForVariantSelection(page, value, kind, timeoutMs = 7_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await variantIsSelected(page, value, kind)) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

async function locateDeepTile(page, value, kind, watchResult) {
  const marker = 'rakuten-monitor-target-' + Date.now() + '-' + Math.random().toString(16).slice(2);

  for (const frame of page.frames()) {
    try {
      const found = await frame.evaluate(({ value, kind, marker }) => {
        const normalise = input => String(input || '').replace(/\\s+/g, ' ').trim();
        const escapeRegex = input => String(input).replace(/[.*+?^$()|[\\]\\\\{}]/g, '\\$&');
        const escaped = escapeRegex(value);
        const targetPattern = kind === 'size'
          ? new RegExp('^(?:(?:Size|サイズ)\\s*)?' + escaped + '(?:\\s|$)', 'i')
          : new RegExp('^' + escaped + '(?:\\s|$)', 'i');

        const roots = [document];
        const allElements = [];
        const seen = new Set();

        for (let rootIndex = 0; rootIndex < roots.length; rootIndex++) {
          const root = roots[rootIndex];
          for (const element of root.querySelectorAll('*')) {
            if (!seen.has(element)) {
              seen.add(element);
              allElements.push(element);
            }
            if (element.shadowRoot && !roots.includes(element.shadowRoot)) {
              roots.push(element.shadowRoot);
            }
          }
        }

        for (const element of allElements) {
          element.removeAttribute('data-rakuten-monitor-target');
        }

        let anchorTop = null;
        for (const element of allElements) {
          const text = normalise(element.innerText || element.textContent);
          if (!/^(?:商品詳細を選択|Select product details)$/i.test(text)) continue;
          const rect = element.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            anchorTop = rect.top;
            break;
          }
        }

        const candidates = [];
        const candidateSet = new Set();
        const addCandidate = element => {
          if (!element || candidateSet.has(element)) return;
          candidateSet.add(element);

          const style = getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return;

          const rect = element.getBoundingClientRect();
          if (rect.width < 45 || rect.height < 28 || rect.width > 430 || rect.height > 220) return;
          if (anchorTop !== null && (rect.bottom < anchorTop - 60 || rect.top > anchorTop + 1_300)) return;

          const text = normalise(element.innerText || element.textContent);
          if (!text || text.length > 220 || !targetPattern.test(text)) return;

          const priceCount = (text.match(/\\d{1,3}(?:,\\d{3})\\s*(?:円|yen)/gi) || []).length;
          if (priceCount > 1) return;

          const hasPrice = priceCount === 1;
          const borderLike = parseFloat(style.borderTopWidth || '0') > 0 || parseFloat(style.borderLeftWidth || '0') > 0;
          const clickable = ['BUTTON', 'LABEL', 'A'].includes(element.tagName) ||
            element.getAttribute('role') === 'button' ||
            style.cursor === 'pointer';
          const tileShape = rect.width >= 75 && rect.width <= 260 && rect.height >= 50 && rect.height <= 180;
          const area = rect.width * rect.height;
          const score =
            (hasPrice ? 5_000_000 : 0) +
            (tileShape ? 2_000_000 : 0) +
            (borderLike ? 700_000 : 0) +
            (clickable ? 300_000 : 0) -
            Math.abs(area - 13_000);

          candidates.push({ element, text, score, area });
        };

        for (const element of allElements) {
          const text = normalise(element.innerText || element.textContent);
          if (!text || text.length > 220 || !targetPattern.test(text)) continue;

          let current = element;
          for (let depth = 0; current && depth < 8; depth++) {
            addCandidate(current);
            if (current.parentElement) {
              current = current.parentElement;
            } else {
              const root = current.getRootNode && current.getRootNode();
              current = root && root.host ? root.host : null;
            }
          }
        }

        if (!candidates.length) return null;
        candidates.sort((a, b) => b.score - a.score || a.area - b.area);
        const best = candidates[0];
        best.element.setAttribute('data-rakuten-monitor-target', marker);
        best.element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const rect = best.element.getBoundingClientRect();
        return {
          text: best.text,
          tag: best.element.tagName.toLowerCase(),
          width: rect.width,
          height: rect.height
        };
      }, { value, kind, marker });

      if (!found) continue;
      await page.waitForTimeout(450);
      const locator = frame.locator('[data-rakuten-monitor-target="' + marker + '"]').first();
      if (!await locator.count()) continue;
      const box = await locator.boundingBox();
      if (!box) continue;

      watchResult.diagnostics.push(
        'Deep scan located ' + kind + ' ' + value + ' tile container: ' + found.text +
        ' [' + found.tag + ', ' + Math.round(found.width) + 'x' + Math.round(found.height) + ']'
      );
      return { locator, box, text: found.text };
    } catch (error) {
      watchResult.diagnostics.push(
        'Deep tile scan skipped one frame for ' + kind + ' ' + value + ': ' + error.message
      );
    }
  }

  watchResult.diagnostics.push(kind + ' ' + value + ' tile container was not found by deep scan.');
  return null;
}

async function clickTileCentre(page, target, description, watchResult) {
  try {
    const box = target.box || await target.locator.boundingBox();
    if (!box) return false;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y, { steps: 10 });
    await page.waitForTimeout(150);
    await page.mouse.click(x, y, { delay: 120 });
    watchResult.diagnostics.push(
      'Mouse-clicked centre of ' + description + ' tile at ' + Math.round(x) + ',' + Math.round(y) + '.'
    );
    await page.waitForTimeout(1_200);
    return true;
  } catch (error) {
    watchResult.diagnostics.push(description + ' centre click failed: ' + error.message);
    return false;
  }
}

async function headingBox(page, kind) {
  const patterns = kind === 'size'
    ? [/商品サイズ\\s*[:：]\\s*未選択/i, /Product\\s*size\\s*[:：]\\s*(?:Not selected|Unselected)/i]
    : [/(?:COLOR|カラー|色)\\s*[:：]\\s*(?:Not selected|未選択)/i];

  for (const pattern of patterns) {
    const candidates = page.getByText(pattern);
    for (let index = 0; index < await candidates.count(); index++) {
      const candidate = candidates.nth(index);
      try {
        if (!await candidate.isVisible()) continue;
        await candidate.scrollIntoViewIfNeeded();
        const box = await candidate.boundingBox();
        if (box) return box;
      } catch {}
    }
  }
  return null;
}

async function clickByGeometry(page, watch, value, kind, watchResult) {
  const index = kind === 'size' ? watch.visualSizeIndex : watch.visualColourIndex;
  const count = kind === 'size' ? watch.visualSizeCount : watch.visualColourCount;
  if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1) return false;

  const box = await headingBox(page, kind);
  if (!box) {
    watchResult.diagnostics.push('Could not find the unselected ' + kind + ' heading for geometry fallback.');
    return false;
  }

  const viewport = page.viewportSize() || await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const usableWidth = Math.min(Math.max(viewport.width - box.x - 24, 240), 920);
  const span = usableWidth / count;
  const baseX = box.x + span * (index + 0.5);
  const xOffsets = [-0.22, 0, 0.22];
  const yOffsets = kind === 'size' ? [58, 72, 88] : [58, 72];

  for (const xOffset of xOffsets) {
    for (const yOffset of yOffsets) {
      const x = baseX + span * xOffset;
      const y = box.y + box.height + yOffset;
      await page.mouse.move(x, y, { steps: 10 });
      await page.waitForTimeout(140);
      await page.mouse.click(x, y, { delay: 120 });
      watchResult.diagnostics.push(
        'Geometry-clicked ' + kind + ' ' + value + ' at ' + Math.round(x) + ',' + Math.round(y) +
        ' (tile ' + (index + 1) + ' of ' + count + ').'
      );
      if (await waitForVariantSelection(page, value, kind, 1_800)) return true;
    }
  }

  return false;
}

async function selectStockVariant(page, watch, value, kind, watchResult) {
  if (await variantIsSelected(page, value, kind)) {
    watchResult.selection[kind + '_selected'] = true;
    watchResult.selection[kind + '_confirmed_selected'] = true;
    watchResult.diagnostics.push(kind + ' ' + value + ' was already selected in the heading.');
    return true;
  }

  const target = await locateDeepTile(page, value, kind, watchResult);
  if (target) {
    const clicked = await clickTileCentre(page, target, kind + ' ' + value, watchResult);
    if (clicked && await waitForVariantSelection(page, value, kind)) {
      watchResult.selection[kind + '_selected'] = true;
      watchResult.selection[kind + '_confirmed_selected'] = true;
      watchResult.diagnostics.push(kind + ' ' + value + ' confirmed selected after tile-centre click.');
      return true;
    }
    watchResult.diagnostics.push(kind + ' ' + value + ' tile-centre click did not change the heading; trying geometry fallback.');
  }

  const geometrySelected = await clickByGeometry(page, watch, value, kind, watchResult);
  watchResult.selection[kind + '_selected'] = geometrySelected;
  watchResult.selection[kind + '_confirmed_selected'] = geometrySelected;
  if (geometrySelected) {
    watchResult.diagnostics.push(kind + ' ' + value + ' confirmed selected after geometry fallback.');
  }
  return geometrySelected;
}

async function selectVariants(page, watch, watchResult) {
  if (watch.alertMode === 'stock') {
    await scrollToVariantArea(page, watchResult);
  }

  for (const kind of watch.selectionOrder) {
    const value = kind === 'size' ? watch.size : watch.colour;
    if (!value) continue;

    if (watch.alertMode === 'stock') {
      const selected = await selectStockVariant(page, watch, value, kind, watchResult);
      if (!selected) {
        throw new Error(kind + ' ' + value + ' could not be selected or confirmed by the Rakuten heading.');
      }
      continue;
    }

    const clicked = await clickVariant(page, value, kind, watchResult);
    watchResult.selection[kind + '_selected'] = clicked;
    if (!clicked) throw new Error(kind + ' ' + value + ' could not be selected.');
  }

  if (watch.alertMode === 'stock') {
    const text = (await bodyText(page)).replace(/\\s+/g, ' ');
    if (/この商品は売り切れです|This product is sold out/i.test(text)) {
      watchResult.sold_out_message_seen = true;
      watchResult.status = 'unavailable';
      watchResult.diagnostics.push(
        'Target variant selection was confirmed, then Rakuten displayed the page-level sold-out message.'
      );
      return { status: 'unavailable' };
    }
  }

  return { status: 'selected' };
}`;

source = replaceBlock(
  source,
  'async function selectVariants(page, watch, watchResult) {',
  NL + 'async function clickPurchaseProcedure(page, watchResult) {',
  selectVariantsReplacement,
  'selectVariants'
);

const callStart = '    await selectVariants(page, watch, watchResult);';
const callEnd = '    await safeScreenshot(page, `${watch.id}-selected`, watchResult);';
const callStartIndex = source.indexOf(callStart);
const callEndIndex = source.indexOf(callEnd, callStartIndex);
if (callStartIndex < 0 || callEndIndex < 0) {
  throw new Error('Could not locate the selectVariants call site.');
}
const selectionCallReplacement = [
  '    const selectionOutcome = await selectVariants(page, watch, watchResult);',
  "    if (selectionOutcome.status === 'unavailable') {",
  '      await safeScreenshot(page, `${watch.id}-sold-out-selected`, watchResult);',
  '      return watchResult;',
  '    }',
  '    await safeScreenshot(page, `${watch.id}-selected`, watchResult);'
].join(NL);
source = source.slice(0, callStartIndex) + selectionCallReplacement + source.slice(callEndIndex + callEnd.length);

await fs.writeFile(generatedPath, source);

if (process.env.RAKUTEN_PATCH_ONLY === '1') {
  console.log(`Generated patched multi-watch: ${generatedPath}`);
} else {
  await import(`${pathToFileURL(generatedPath).href}?run=${Date.now()}`);
}
