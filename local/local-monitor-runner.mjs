import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(directory, 'local-monitor-cdp-v2.mjs');
const source = await fs.readFile(sourcePath, 'utf8');

const oldQuantityReader = `async function readQuantity(page) {
  const controls = page.locator([
    'select[name*="quantity" i]', 'select[id*="quantity" i]',
    'select[name*="qty" i]', 'select[id*="qty" i]',
    'input[name*="quantity" i]', 'input[id*="quantity" i]',
    'input[name*="qty" i]', 'input[id*="qty" i]',
    'select', 'input[type="number"]'
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

  const text = await bodyText(page);
  const match = text.match(/(?:quantity|数量|個数)\\s*[:：]?\\s*(\\d+)/i);
  return match ? parseQuantity(match[1]) : null;
}`;

const newQuantityReader = `async function readQuantity(page) {
  const labelledQuantity = /(?:quantity|数量|個数)\\s*[:：]?\\s*(\\d+)/i;

  const selects = page.locator('select');
  for (let index = 0; index < await selects.count(); index++) {
    const control = selects.nth(index);
    try {
      if (!await control.isVisible()) continue;

      const selectedText = ((await control.locator('option:checked').textContent().catch(() => '')) || '')
        .replace(/\\s+/g, ' ')
        .trim();
      const directMatch = selectedText.match(labelledQuantity);
      if (directMatch) {
        const quantity = parseQuantity(directMatch[1]);
        if (quantity !== null) {
          result.diagnostics.push(\`Quantity read from labelled selected option: \${quantity}.\`);
          return quantity;
        }
      }

      const metadata = await control.evaluate(element => {
        const attributes = [
          element.getAttribute('aria-label'),
          element.getAttribute('name'),
          element.getAttribute('id')
        ].filter(Boolean).join(' ');

        let node = element;
        let surroundingText = '';
        for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
          const text = (node.innerText || '').replace(/\\s+/g, ' ').trim();
          if (text && text.length <= 500) surroundingText += \` \${text}\`;
        }
        return { attributes, surroundingText };
      });

      const labelledContext = \`\${metadata.attributes} \${metadata.surroundingText}\`;
      if (/(?:quantity|数量|個数|qty)/i.test(labelledContext)) {
        const quantity = parseQuantity(selectedText || await control.inputValue().catch(() => ''));
        if (quantity !== null) {
          result.diagnostics.push(\`Quantity read from labelled select control: \${quantity}.\`);
          return quantity;
        }
      }
    } catch {}
  }

  const inputs = page.locator([
    'input[name*="quantity" i]', 'input[id*="quantity" i]', 'input[aria-label*="quantity" i]',
    'input[name*="qty" i]', 'input[id*="qty" i]', 'input[aria-label*="qty" i]',
    'input[aria-label*="数量"]', 'input[aria-label*="個数"]'
  ].join(','));

  for (let index = 0; index < await inputs.count(); index++) {
    const control = inputs.nth(index);
    try {
      if (!await control.isVisible()) continue;
      const quantity = parseQuantity(await control.inputValue().catch(() => ''));
      if (quantity !== null) {
        result.diagnostics.push(\`Quantity read from labelled input control: \${quantity}.\`);
        return quantity;
      }
    } catch {}
  }

  const text = (await bodyText(page)).replace(/\\s+/g, ' ');
  const match = text.match(labelledQuantity);
  const quantity = match ? parseQuantity(match[1]) : null;
  if (quantity !== null) result.diagnostics.push(\`Quantity read from labelled page text: \${quantity}.\`);
  return quantity;
}`;

const quantityOccurrences = source.split(oldQuantityReader).length - 1;
if (quantityOccurrences !== 1) {
  throw new Error(`Expected one legacy quantity reader in local-monitor-cdp-v2.mjs, found ${quantityOccurrences}.`);
}

let runtimeSource = source.replace(oldQuantityReader, newQuantityReader);

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
await import(`${pathToFileURL(generatedPath).href}?run=${Date.now()}`);
