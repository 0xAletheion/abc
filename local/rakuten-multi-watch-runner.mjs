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

async function inspectTargetVariant(page, value, kind, watchResult) {
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
      if (!box) continue;
      const tagName = await candidate.evaluate(element => element.tagName.toLowerCase()).catch(() => '');
      const role = await candidate.getAttribute('role').catch(() => '');
      const interactive = /^(button|label)$/.test(tagName) || role === 'button';
      const soldOut = /売り切れ|売切れ|sold\s*out|out\s*of\s*stock/i.test(text);
      const hasPrice = /\d{1,3}(?:,\d{3})\s*(?:円|yen)/i.test(text);
      const score = (interactive ? 1_000_000 : 0) + (hasPrice ? 100_000 : 0) - (box.width * box.height);
      matches.push({ locator: candidate, text, soldOut, score });
    } catch {}
  }

  if (!matches.length) {
    watchResult.diagnostics.push(kind + ' ' + value + ' target tile was not found after scrolling.');
    return { found: false, soldOut: false, locator: null, text: '' };
  }

  const soldOutMatch = matches.find(match => match.soldOut);
  const selected = soldOutMatch || matches.sort((a, b) => b.score - a.score)[0];
  await selected.locator.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(400);
  watchResult.diagnostics.push(
    'Inspected exact ' + kind + ' ' + value + ' tile: ' + selected.text
  );
  return { found: true, soldOut: selected.soldOut, locator: selected.locator, text: selected.text };
}

async function selectVariants(page, watch, watchResult) {
  if (watch.alertMode === 'stock') {
    await scrollToVariantArea(page, watchResult);
  }

  for (const kind of watch.selectionOrder) {
    const value = kind === 'size' ? watch.size : watch.colour;
    if (!value) continue;

    if (watch.alertMode === 'stock') {
      const target = await inspectTargetVariant(page, value, kind, watchResult);
      if (target.found && target.soldOut) {
        watchResult.selection[kind + '_sold_out'] = true;
        watchResult.sold_out_message_seen = true;
        watchResult.status = 'unavailable';
        watchResult.diagnostics.push(kind + ' ' + value + ' is explicitly marked sold out.');
        return { status: 'unavailable' };
      }

      if (target.found) {
        const clicked = await humanClick(page, target.locator, kind + ' ' + value, watchResult);
        watchResult.selection[kind + '_selected'] = clicked;
        if (!clicked) throw new Error(kind + ' ' + value + ' target tile could not be clicked.');
        await page.waitForTimeout(1_000);
        continue;
      }
    }

    const clicked = await clickVariant(page, value, kind, watchResult);
    watchResult.selection[kind + '_selected'] = clicked;
    if (!clicked) throw new Error(kind + ' ' + value + ' could not be selected.');
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
  '      await safeScreenshot(page, `${watch.id}-sold-out-tile`, watchResult);',
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
