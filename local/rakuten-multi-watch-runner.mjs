import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(directory, 'rakuten-multi-watch.mjs');
const generatedPath = path.join(directory, '.rakuten-multi-watch-runtime.mjs');
let source = await fs.readFile(sourcePath, 'utf8');

function replaceBlock(input, startMarker, endMarker, replacement, description) {
  const startIndex = input.indexOf(startMarker);
  const endIndex = input.indexOf(endMarker, startIndex);
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
    throw new Error(`Could not locate runtime patch boundaries for ${description}.`);
  }
  return input.slice(0, startIndex) + replacement + input.slice(endIndex);
}

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
  '\nasync function clickVariant(page, value, kind, watchResult) {',
  variantRegexReplacement,
  'variantRegex'
);

const selectVariantsReplacement = String.raw`async function scrollToVariantArea(page, watchResult) {
  const anchors = [
    page.getByText(/商品詳細を選択|Select product details/i).first(),
    page.getByText(/商品サイズ|Product size/i).first(),
    page.getByText(/^SIZE\s*[:：]?/i).first()
  ];

  for (const anchor of anchors) {
    try {
      if (await anchor.count() && await anchor.isVisible()) {
        await anchor.scrollIntoViewIfNeeded();
        await page.waitForTimeout(1_400);
        watchResult.diagnostics.push('Scrolled to the Rakuten product-detail selector.');
        return;
      }
    } catch {}
  }

  await page.evaluate(() => {
    window.scrollTo({ top: Math.floor(document.body.scrollHeight * 0.55), behavior: 'instant' });
  });
  await page.waitForTimeout(1_400);
  watchResult.diagnostics.push('Used fallback scroll to locate the Rakuten product-detail selector.');
}

async function findExactTargetTile(page, value, kind, watchResult) {
  const pattern = variantRegex(value, kind);
  const candidates = page
    .locator('button,label,[role="button"],li,div,span')
    .filter({ hasText: pattern });

  const matches = [];
  for (let index = 0; index < await candidates.count(); index++) {
    const candidate = candidates.nth(index);
    try {
      if (!await candidate.isVisible()) continue;
      const text = String(await candidate.innerText().catch(() => ''))
        .replace(/\s+/g, ' ')
        .trim();
      if (!text || text.length > 220 || !pattern.test(text)) continue;

      const box = await candidate.boundingBox();
      if (!box || box.width < 35 || box.height < 25) continue;

      const hasPrice = /\d{1,3}(?:,\d{3})\s*(?:円|yen)/i.test(text);
      const tagName = await candidate.evaluate(element => element.tagName.toLowerCase()).catch(() => '');
      const role = await candidate.getAttribute('role').catch(() => '');
      const interactive = /^(button|label)$/.test(tagName) || role === 'button';
      const score = (hasPrice ? 1_000_000 : 0) + (interactive ? 100_000 : 0) - (box.width * box.height);
      matches.push({ locator: candidate, text, score });
    } catch {}
  }

  if (!matches.length) {
    watchResult.diagnostics.push(kind + ' ' + value + ' target tile was not found after scrolling.');
    return null;
  }

  matches.sort((a, b) => b.score - a.score);
  const selected = matches[0];
  await selected.locator.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(450);
  watchResult.diagnostics.push('Located exact ' + kind + ' ' + value + ' tile: ' + selected.text);
  return selected;
}

async function clickExactTargetTile(page, target, description, watchResult) {
  try {
    await target.locator.scrollIntoViewIfNeeded();
    const box = await target.locator.boundingBox();
    if (!box) return false;

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 10 });
    await page.waitForTimeout(180);
    await page.mouse.down();
    await page.waitForTimeout(120);
    await page.mouse.up();
    watchResult.diagnostics.push('Clicked exact ' + description + ' tile by coordinates.');
    await page.waitForTimeout(1_200);
    return true;
  } catch (error) {
    watchResult.diagnostics.push('Exact ' + description + ' tile click failed: ' + error.message);
    return false;
  }
}

async function waitForVariantSelection(page, value, kind) {
  const deadline = Date.now() + 6_000;
  const pattern = kind === 'size' ? sizePattern(value) : colourPattern(value);

  while (Date.now() < deadline) {
    const text = (await bodyText(page)).replace(/\s+/g, ' ');
    if (pattern && pattern.test(text)) return true;
    await page.waitForTimeout(300);
  }

  return false;
}

async function selectVariants(page, watch, watchResult) {
  if (watch.alertMode === 'stock') {
    await scrollToVariantArea(page, watchResult);
  }

  for (const kind of watch.selectionOrder) {
    const value = kind === 'size' ? watch.size : watch.colour;
    if (!value) continue;

    if (watch.alertMode === 'stock') {
      const target = await findExactTargetTile(page, value, kind, watchResult);
      if (!target) throw new Error(kind + ' ' + value + ' target tile could not be located.');

      const clicked = await clickExactTargetTile(page, target, kind + ' ' + value, watchResult);
      watchResult.selection[kind + '_selected'] = clicked;
      if (!clicked) throw new Error(kind + ' ' + value + ' target tile could not be clicked.');

      const selected = await waitForVariantSelection(page, value, kind);
      watchResult.selection[kind + '_confirmed_selected'] = selected;
      if (!selected) {
        throw new Error(kind + ' ' + value + ' click did not change the Rakuten selection heading.');
      }

      watchResult.diagnostics.push(
        kind + ' ' + value + ' confirmed selected in the Rakuten heading.'
      );
      continue;
    }

    const clicked = await clickVariant(page, value, kind, watchResult);
    watchResult.selection[kind + '_selected'] = clicked;
    if (!clicked) throw new Error(kind + ' ' + value + ' could not be selected.');
  }

  if (watch.alertMode === 'stock') {
    const text = (await bodyText(page)).replace(/\s+/g, ' ');
    if (/この商品は売り切れです|This product is sold out/i.test(text)) {
      watchResult.sold_out_message_seen = true;
      watchResult.status = 'unavailable';
      watchResult.diagnostics.push(
        'Target variant was selected, then Rakuten displayed the page-level sold-out message.'
      );
      return { status: 'unavailable' };
    }
  }

  return { status: 'selected' };
}`;

source = replaceBlock(
  source,
  'async function selectVariants(page, watch, watchResult) {',
  '\nasync function clickPurchaseProcedure(page, watchResult) {',
  selectVariantsReplacement,
  'selectVariants'
);

const selectionCallPattern = /    await selectVariants\(page, watch, watchResult\);\r?\n    await safeScreenshot\(page, `\$\{watch\.id\}-selected`, watchResult\);/;
const selectionCallReplacement = [
  '    const selectionOutcome = await selectVariants(page, watch, watchResult);',
  "    if (selectionOutcome.status === 'unavailable') {",
  '      await safeScreenshot(page, `${watch.id}-sold-out-selected`, watchResult);',
  '      return watchResult;',
  '    }',
  '    await safeScreenshot(page, `${watch.id}-selected`, watchResult);'
].join('\n');

const matches = source.match(new RegExp(selectionCallPattern.source, 'g')) ?? [];
if (matches.length !== 1) {
  throw new Error(`Expected one selectVariants call site, found ${matches.length}.`);
}
source = source.replace(selectionCallPattern, selectionCallReplacement);

await fs.writeFile(generatedPath, source);

if (process.env.RAKUTEN_PATCH_ONLY === '1') {
  console.log(`Generated patched multi-watch: ${generatedPath}`);
} else {
  await import(`${pathToFileURL(generatedPath).href}?run=${Date.now()}`);
}
