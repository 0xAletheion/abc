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
  const marker = 'rakuten-monitor-' + kind + '-' + Date.now() + '-' + Math.random().toString(16).slice(2);

  for (const frame of page.frames()) {
    try {
      const found = await frame.evaluate(({ value, kind, marker }) => {
        const normalise = input => String(input || '').replace(/\s+/g, ' ').trim();
        const escape = input => String(input).replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
        const escaped = escape(value);
        const pattern = kind === 'size'
          ? new RegExp('^(?:(?:Size|サイズ)\\s*)?' + escaped + '(?:\\s|$)', 'i')
          : new RegExp('^' + escaped + '(?:\\s|$)', 'i');

        for (const old of document.querySelectorAll('[data-rakuten-monitor-target]')) {
          old.removeAttribute('data-rakuten-monitor-target');
        }

        const all = [...document.querySelectorAll('*')];
        let anchorTop = null;
        for (const element of all) {
          const text = normalise(element.innerText || element.textContent);
          if (!/^(?:商品詳細を選択|Select product details)$/i.test(text)) continue;
          const rect = element.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            anchorTop = rect.top;
            break;
          }
        }

        const matches = [];
        for (const element of all) {
          const style = getComputedStyle(element);
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;

          const rect = element.getBoundingClientRect();
          if (rect.width < 18 || rect.height < 12 || rect.width > 500 || rect.height > 260) continue;
          if (anchorTop !== null && (rect.bottom < anchorTop - 40 || rect.top > anchorTop + 1_250)) continue;

          const text = normalise(element.innerText || element.textContent);
          if (!text || text.length > 220 || !pattern.test(text)) continue;

          const upperText = text.toUpperCase();
          const upperValue = String(value).toUpperCase();
          const exactLabels = kind === 'size'
            ? [upperValue, 'SIZE ' + upperValue, 'SIZE' + upperValue, 'サイズ' + upperValue]
            : [upperValue];
          const exact = exactLabels.includes(upperText);
          const hasPrice = /\d{1,3}(?:,\d{3})\s*(?:円|yen)/i.test(text);
          const clickable = ['BUTTON', 'LABEL', 'A'].includes(element.tagName) ||
            element.getAttribute('role') === 'button' ||
            typeof element.onclick === 'function' ||
            getComputedStyle(element).cursor === 'pointer';
          const inViewport = rect.bottom > 0 && rect.top < innerHeight;
          const area = rect.width * rect.height;
          const score =
            (exact ? 10_000_000 : 0) +
            (hasPrice ? 2_000_000 : 0) +
            (clickable ? 500_000 : 0) +
            (inViewport ? 100_000 : 0) -
            area;

          matches.push({ element, text, score, area });
        }

        if (!matches.length) return null;
        matches.sort((a, b) => b.score - a.score || a.area - b.area);
        const best = matches[0];
        best.element.setAttribute('data-rakuten-monitor-target', marker);
        best.element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        return {
          text: best.text,
          tag: best.element.tagName.toLowerCase(),
          score: best.score
        };
      }, { value, kind, marker });

      if (!found) continue;
      await page.waitForTimeout(500);
      const locator = frame.locator('[data-rakuten-monitor-target="' + marker + '"]').first();
      if (!await locator.count()) continue;
      watchResult.diagnostics.push(
        'Rendered-DOM scan located exact ' + kind + ' ' + value + ' target: ' + found.text +
        ' [' + found.tag + ']'
      );
      return { locator, text: found.text, frameUrl: frame.url() };
    } catch (error) {
      watchResult.diagnostics.push(
        'Target scan skipped one frame for ' + kind + ' ' + value + ': ' + error.message
      );
    }
  }

  watchResult.diagnostics.push(kind + ' ' + value + ' target tile was not found by the rendered-DOM scan.');
  return null;
}

async function clickExactTargetTile(target, description, watchResult) {
  try {
    await target.locator.scrollIntoViewIfNeeded();
    await target.locator.click({ force: true, timeout: 6_000 });
    watchResult.diagnostics.push('Force-clicked exact ' + description + ' rendered target.');
    await new Promise(resolve => setTimeout(resolve, 1_300));
    return true;
  } catch (error) {
    watchResult.diagnostics.push('Exact ' + description + ' click failed: ' + error.message);
    return false;
  }
}

function selectedVariantHeadingPattern(value, kind) {
  const escaped = escapeRegExp(value);
  if (kind === 'size') {
    return new RegExp(
      '(?:商品サイズ|Product\\s*size)\\s*[:：]\\s*(?:(?:Size|サイズ)\\s*)?' + escaped + '\\b',
      'i'
    );
  }
  return new RegExp(
    '(?:COLOR|カラー|色)\\s*[:：]\\s*' + escaped + '\\b',
    'i'
  );
}

async function waitForVariantSelection(page, value, kind) {
  const deadline = Date.now() + 7_000;
  const pattern = selectedVariantHeadingPattern(value, kind);

  while (Date.now() < deadline) {
    const text = (await bodyText(page)).replace(/\s+/g, ' ');
    if (pattern.test(text)) return true;
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

      const clicked = await clickExactTargetTile(target, kind + ' ' + value, watchResult);
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
