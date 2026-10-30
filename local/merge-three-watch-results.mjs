import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT_DIR = path.join(ROOT, 'artifacts-local');
const FULLCOUNT_RESULT = path.join(ARTIFACT_DIR, 'result.json');
const STUDIO_8173_RESULT = path.join(ARTIFACT_DIR, 'studio-8173-result.json');
const STUDIO_8186_RESULT = path.join(ARTIFACT_DIR, 'studio-8186-result.json');
const COMBINED_RESULT = path.join(ARTIFACT_DIR, 'three-watch-result.json');
const COMBINED_HISTORY = path.join(ARTIFACT_DIR, 'three-watch-history.ndjson');

function errorMessage(label, filePath, error) {
  return `${label} result could not be read at ${filePath}: ${error.message}`;
}

async function readJsonOrFallback(filePath, label, fallbackFactory) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    return fallbackFactory(errorMessage(label, filePath, error));
  }
}

function firstMeaningfulError(value) {
  if (!value) return null;
  return String(value).split(/\r?\n/)[0].trim() || null;
}

function fullcountFallback(message) {
  return {
    checked_at: new Date().toISOString(),
    environment: 'ordinary-chrome-cdp-fullcount-missing-result',
    product_url: 'https://item.rakuten.co.jp/realmoon/1110w/',
    listed_price_jpy: null,
    assumed_coupon_jpy: 1_000,
    effective_price_jpy: null,
    jpy_per_gbp: null,
    effective_price_gbp: null,
    price_trigger_met: false,
    gbp_trigger_met: false,
    alert_triggered: false,
    w33: {
      colour_selected: false,
      size_selected: false,
      purchase_button_clicked: false,
      sold_out_message_seen: false,
      confirmation_page_opened: false,
      product_confirmed: false,
      colour_confirmed: false,
      size_confirmed: false,
      quantity: null,
      quantity_confirmed: false,
      genuinely_available: false,
      status: 'error'
    },
    diagnostics: [message],
    error: message
  };
}

function studioFallback(message, definition) {
  return {
    checked_at: new Date().toISOString(),
    environment: `ordinary-chrome-cdp-${definition.id}-missing-result`,
    watches: [{
      id: definition.id,
      name: definition.name,
      url: definition.url,
      target_size: definition.size,
      target_colour: definition.colour,
      listed_price_jpy: null,
      selection: {
        size_selected: false,
        colour_selected: false
      },
      purchase_button_clicked: false,
      sold_out_message_seen: false,
      confirmation_page_opened: false,
      quantity: null,
      genuinely_available: false,
      status: 'error',
      diagnostics: [message],
      error: message
    }],
    alert_triggered: false,
    error: message
  };
}

function fullcountWatch(base) {
  const w33 = base.w33 ?? {};
  return {
    id: 'fullcount-1110-w33',
    name: 'Fullcount 1110W W33',
    url: base.product_url ?? 'https://item.rakuten.co.jp/realmoon/1110w/',
    target_size: '33',
    target_colour: 'ONE WASH',
    alert_mode: 'price',
    checked_at: base.checked_at ?? null,
    listed_price_jpy: base.listed_price_jpy ?? null,
    assumed_coupon_jpy: base.assumed_coupon_jpy ?? 1_000,
    effective_price_jpy: base.effective_price_jpy ?? null,
    jpy_per_gbp: base.jpy_per_gbp ?? null,
    effective_price_gbp: base.effective_price_gbp ?? null,
    price_trigger_met: Boolean(base.price_trigger_met),
    gbp_trigger_met: Boolean(base.gbp_trigger_met),
    alert_triggered: Boolean(base.alert_triggered),
    selection: {
      colour_selected: Boolean(w33.colour_selected),
      size_selected: Boolean(w33.size_selected)
    },
    purchase_button_clicked: Boolean(w33.purchase_button_clicked),
    sold_out_message_seen: Boolean(w33.sold_out_message_seen),
    confirmation_page_opened: Boolean(w33.confirmation_page_opened),
    product_confirmed: Boolean(w33.product_confirmed),
    colour_confirmed: Boolean(w33.colour_confirmed),
    size_confirmed: Boolean(w33.size_confirmed),
    quantity: Number.isInteger(w33.quantity) ? w33.quantity : null,
    quantity_confirmed: Boolean(w33.quantity_confirmed),
    genuinely_available: Boolean(w33.genuinely_available),
    status: w33.status ?? (base.error ? 'error' : 'unknown'),
    diagnostics: Array.isArray(base.diagnostics) ? base.diagnostics : [],
    error: base.error ?? null
  };
}

function isolatedStudioWatch(base, expectedId, label) {
  const watches = Array.isArray(base.watches) ? base.watches : [];
  const watch = watches.find(item => item?.id === expectedId) ?? watches[0];
  if (watch) return watch;

  const message = `${label} result did not contain a watch row.`;
  return studioFallback(message, {
    id: expectedId,
    name: label,
    url: null,
    size: null,
    colour: null
  }).watches[0];
}

function latestTimestamp(values) {
  const valid = values
    .map(value => Date.parse(value ?? ''))
    .filter(Number.isFinite);
  return valid.length ? new Date(Math.max(...valid)).toISOString() : new Date().toISOString();
}

const studio8173Definition = {
  id: 'studio-dartisan-8173-l-white',
  name: "Studio D'Artisan 8173 white size L",
  url: 'https://item.rakuten.co.jp/barbizon/sd8173/?variantId=r-sku00000003',
  size: 'L',
  colour: 'white'
};

const studio8186Definition = {
  id: 'studio-dartisan-8186-m',
  name: "Studio D'Artisan 8186 size M",
  url: 'https://item.rakuten.co.jp/auc-americanbass/10018065/',
  size: 'M',
  colour: null
};

await fs.mkdir(ARTIFACT_DIR, { recursive: true });

const fullcountBase = await readJsonOrFallback(
  FULLCOUNT_RESULT,
  'Fullcount',
  fullcountFallback
);
const studio8173Base = await readJsonOrFallback(
  STUDIO_8173_RESULT,
  'Studio 8173',
  message => studioFallback(message, studio8173Definition)
);
const studio8186Base = await readJsonOrFallback(
  STUDIO_8186_RESULT,
  'Studio 8186',
  message => studioFallback(message, studio8186Definition)
);

const watches = [
  fullcountWatch(fullcountBase),
  isolatedStudioWatch(studio8173Base, studio8173Definition.id, studio8173Definition.name),
  isolatedStudioWatch(studio8186Base, studio8186Definition.id, studio8186Definition.name)
];

const errors = watches
  .map(watch => firstMeaningfulError(watch.error) ? `${watch.name}: ${firstMeaningfulError(watch.error)}` : null)
  .filter(Boolean);

const combined = {
  ...fullcountBase,
  checked_at: latestTimestamp(watches.map(watch => watch.checked_at)),
  combined_at: new Date().toISOString(),
  environment: 'ordinary-chrome-cdp-three-watch-validated-v2',
  watches,
  alert_triggered: watches.some(watch => Boolean(watch.alert_triggered)),
  error: errors.length ? errors.join(' | ') : null
};

const serialized = JSON.stringify(combined, null, 2);
await fs.writeFile(COMBINED_RESULT, serialized);
await fs.writeFile(FULLCOUNT_RESULT, serialized);
await fs.appendFile(COMBINED_HISTORY, `${JSON.stringify(combined)}\n`);

console.log(serialized);
process.exitCode = combined.error ? 1 : 0;
