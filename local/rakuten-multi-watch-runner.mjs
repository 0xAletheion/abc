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

const selectVariantsReplacement = String.raw`async function targetVariantSoldOut(page, value, kind, watchResult) {
  const pattern = variantRegex(value, kind);
  const candidates = page
    .locator('button,label,[role="button"],li,div,span')
    .filter({ hasText: pattern });

  for (let index = 0; index < await candidates.count(); index++) {
    const candidate = candidates.nth(index);
    try {
      if (!await candidate.isVisible()) continue;
      const text = String(await candidate.innerText().catch(() => ''))
        .replace(/\s+/g, ' ')
        .trim();
      if (!text || text.length > 220 || !pattern.test(text)) continue;

      if (/売り切れ|売切れ|sold\s*out|out\s*of\s*stock/i.test(text)) {
        watchResult.selection[kind + '_sold_out'] = true;
        watchResult.sold_out_message_seen = true;
        watchResult.status = 'unavailable';
        watchResult.diagnostics.push(
          kind + ' ' + value + ' is explicitly marked sold out on its target tile: ' + text
        );
        return true;
      }
    } catch {}
  }

  return false;
}

async function selectVariants(page, watch, watchResult) {
  for (const kind of watch.selectionOrder) {
    const value = kind === 'size' ? watch.size : watch.colour;
    if (!value) continue;

    if (await targetVariantSoldOut(page, value, kind, watchResult)) {
      return { status: 'unavailable' };
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
  "      await safeScreenshot(page, `${watch.id}-sold-out-tile`, watchResult);",
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
