import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(directory, 'local-monitor-cdp-v2.mjs');
const source = await fs.readFile(sourcePath, 'utf8');

const newQuantityReader = String.raw`async function readQuantity(page) {
  const labelledQuantity = /(?:quantity|数量|個数)\s*[:：]?\s*(\d+)/i;

  // Rakuten's visible basket text contains "数量: 1". Read this first so
  // unrelated numeric controls elsewhere on the page cannot be mistaken for
  // the basket quantity.
  const pageText = (await bodyText(page)).replace(/\s+/g, ' ');
  const textMatch = pageText.match(labelledQuantity);
  if (textMatch) {
    const quantity = parseQuantity(textMatch[1]);
    if (quantity !== null) {
      result.diagnostics.push('Quantity read from labelled page text: ' + quantity + '.');
      return quantity;
    }
  }

  // Fallback: inspect only controls explicitly labelled as quantity controls.
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

const startMarker = 'async function readQuantity(page) {';
const endMarker = '\nasync function verifyConfirmation(page) {';
const startIndex = source.indexOf(startMarker);
const endIndex = source.indexOf(endMarker, startIndex);

if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) {
  throw new Error('Could not locate the readQuantity function boundaries in local-monitor-cdp-v2.mjs.');
}

let runtimeSource = source.slice(0, startIndex) + newQuantityReader + source.slice(endIndex);

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
