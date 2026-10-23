// Independent J. Press W34 stock watch; no browser and no Rakuten dependencies.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'artifacts-local');
const productUrl = 'https://jpress.com/products/khaki-unwashed-cotton-chino-trim-fit';
const selectionUrl = productUrl + '?variant=43871276138543';
const variantId = '43871276138543';
const expectedHandle = 'khaki-unwashed-cotton-chino-trim-fit';
const size = '34';
const resultFile = path.join(artifacts, 'jpress-w34-result.json');
const historyFile = path.join(artifacts, 'jpress-w34-history.ndjson');
const stateFile = path.join(artifacts, 'jpress-w34-state.json');
const alertFile = path.join(artifacts, 'jpress-w34-alert.txt');

await fs.mkdir(artifacts, { recursive: true });
const result = {
  checked_at: new Date().toISOString(),
  name: 'J. Press Ivy Essential Khaki Chino - Trim Fit W34',
  url: selectionUrl,
  variant_id: variantId,
  target_size: size,
  status: 'unknown',
  variant_available: null,
  alert_triggered: false,
  source: 'Shopify public product JSON (variant-level available flag)',
  error: null
};

let previousState = { alert_armed: true };
try {
  const prior = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  if (typeof prior.alert_armed === 'boolean') previousState = prior;
} catch {}

try {
  const endpoint = productUrl + '.js?_=' + Date.now();
  const response = await fetch(endpoint, {
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    cache: 'no-store',
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error('Shopify product request returned HTTP ' + response.status);
  const json = await response.json();

  if (json.handle && json.handle !== expectedHandle) {
    throw new Error('Unexpected product handle: ' + json.handle);
  }
  if (!/khaki/i.test(String(json.title || '')) || !/trim/i.test(String(json.title || ''))) {
    throw new Error('Unexpected product title: ' + String(json.title));
  }
  if (!Array.isArray(json.variants)) throw new Error('No variants array in product response');

  const matching = json.variants.filter(item => String(item.id) === variantId);
  if (matching.length !== 1) throw new Error('Exact W34 variant ID not found (count=' + matching.length + ')');
  const variant = matching[0];
  const optionTexts = [
    variant.title, variant.option1, variant.option2, variant.option3,
    ...(Array.isArray(variant.options) ? variant.options : [])
  ].filter(value => value != null).map(value => String(value));
  const hasW34 = optionTexts.some(value => /(?:^|[^0-9])34(?:$|[^0-9])/.test(value));
  if (!hasW34) {
    throw new Error('Variant ID exists, but its size could not be verified as 34: ' + optionTexts.join(' / '));
  }
  if (typeof variant.available !== 'boolean') throw new Error('Variant availability is not a boolean');

  result.variant_title = variant.title || null;
  result.status = variant.available ? 'available' : 'unavailable';
  result.variant_available = variant.available;
  if (variant.available) {
    result.alert_triggered = previousState.alert_armed !== false;
    previousState.alert_armed = false;
  } else {
    previousState.alert_armed = true;
  }
  previousState.last_status = result.status;
  previousState.last_checked_at = result.checked_at;

  await fs.writeFile(stateFile, JSON.stringify(previousState, null, 2) + '\n');
  if (result.alert_triggered) {
    await fs.writeFile(
      alertFile,
      'J. Press Ivy Essential Khaki Chino - Trim Fit, W34 reported AVAILABLE\n' +
      'Checked: ' + result.checked_at + '\n' +
      'Variant: ' + variantId + '\n' +
      'Product: ' + selectionUrl + '\n' +
      'Verify at checkout before relying on stock.\n'
    );
  }
} catch (error) {
  // A failed request is UNKNOWN, not "out of stock" or "in stock".
  result.error = String(error?.message || error);
}

await fs.writeFile(resultFile, JSON.stringify(result, null, 2) + '\n');
await fs.appendFile(historyFile, JSON.stringify(result) + '\n');
console.log(JSON.stringify(result, null, 2));
if (result.status === 'unknown') process.exitCode = 2;
