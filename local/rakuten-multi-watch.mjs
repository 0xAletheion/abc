import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CDP_ENDPOINT = process.env.RAKUTEN_CDP_ENDPOINT || 'http://127.0.0.1:9222';
const ARTIFACT_DIR = path.join(ROOT, 'artifacts-local');
const LOCK_FILE = path.join(ARTIFACT_DIR, 'monitor.lock');
const STATE_FILE = path.join(ARTIFACT_DIR, 'watch-state.json');
const KEEP_ITEM = process.env.RAKUTEN_KEEP_ITEM === '1';
const ASSUMED_COUPON_JPY = 1_000;

const WATCHES = [
  {
    id: 'fullcount-1110-w33',
    name: 'Fullcount 1110W W33',
    url: 'https://item.rakuten.co.jp/realmoon/1110w/',
    productPattern: /FCP-1110W|Fullcount Jeans 1110|フルカウント.*1110/i,
    size: '33',
    colour: 'ONE WASH',
    selectionOrder: ['colour', 'size'],
    alertMode: 'price',
    baselineJpy: 30_580,
    gbpTrigger: 135,
    assumedCouponJpy: ASSUMED_COUPON_JPY
  },
  {
    id: 'studio-dartisan-8173-l-white',
    name: "Studio D'Artisan 8173 white size L",
    url: 'https://item.rakuten.co.jp/barbizon/sd8173/?variantId=r-sku00000003',
    productPattern: /(?:STUDIO\s+D['’´]?ARTISAN|ステュディオ.*ダルチザン).*8173|\b8173\b/i,
    size: 'L',
    colour: 'white',
    selectionOrder: ['size', 'colour'],
    alertMode: 'stock'
  },
  {
    id: 'studio-dartisan-8186-m',
    name: "Studio D'Artisan 8186 size M",
    url: 'https://item.rakuten.co.jp/auc-americanbass/10018065/',
    productPattern: /(?:STUDIO\s+D['’´]?ARTISAN|ステュディオ.*ダルチザン).*8186|\b8186\b/i,
    size: 'M',
    colour: null,
    selectionOrder: ['size'],
    alertMode: 'stock'
  }
];

const result = {
  checked_at: new Date().toISOString(),
  environment: 'ordinary-chrome-cdp-multi-watch-v1',
  keep_item: KEEP_ITEM,
  alert_triggered: false,
  watches: [],
  diagnostics: [],
  error: null
};

function parseYen(text) {
  return [...String(text).matchAll(/(?:¥|￥)?\s*([0-9]{1,3}(?:,[0-9]{3})+)\s*(?:円|circle|yen)?/gi)]
    .map(match => Number(match[1].replaceAll(',', '')))
    .filter(Number.isFinite);
}

function parseQuantity(value) {
  const match = String(value ?? '').match(/\d+/);
  if (!match) return null;
  const quantity = Number(match[0]);
  return Number.isInteger(quantity) && quantity >= 0 && quantity <= 99 ? quantity : null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function processIsAlive(pid) {
  try {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock() {
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(LOCK_FILE, 'wx');
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
      await handle.close();
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const contents = await fs.readFile(LOCK_FILE, 'utf8').catch(() => '');
      const lockedPid = Number(contents.split(/\r?\n/)[0]);
      if (processIsAlive(lockedPid)) {
        throw new Error(`Another local Rakuten monitor run is already active (PID ${lockedPid}).`);
      }
      await fs.rm(LOCK_FILE, { force: true });
      result.diagnostics.push(`Removed stale monitor lock for PID ${lockedPid || 'unknown'}.`);
    }
  }
  throw new Error('Could not acquire the monitor lock.');
}

async function releaseLock() {
  await fs.rm(LOCK_FILE, { force: true }).catch(() => {});
}

async function readState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function writeState(state) {
  if (KEEP_ITEM) return;
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

async function bodyText(page) {
  return await page.locator('body').innerText().catch(() => '');
}

async function safeScreenshot(page, name, watchResult) {
  try {
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, `${name}.png`),
      fullPage: true,
      timeout: 12_000
    });
  } catch (error) {
    watchResult.diagnostics.push(`Screenshot skipped (${name}): ${error.message}`);
  }
}

async function openProduct(page, watch, watchResult) {
  const waits = [0, 20_000, 60_000];
  for (let attempt = 1; attempt <= waits.length; attempt++) {
    if (waits[attempt - 1]) {
      const delay = waits[attempt - 1] + Math.floor(Math.random() * 7_501);
      watchResult.diagnostics.push(`Rakuten retry ${attempt - 1}: waiting ${(delay / 1000).toFixed(1)} seconds.`);
      await page.waitForTimeout(delay);
    }

    await page.goto(watch.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(4_000);
    const text = await bodyText(page);

    if (/Reference\s*#18\.|Access Denied|request rejected/i.test(text)) {
      throw new Error('Rakuten returned its Reference #18 security-block page.');
    }

    if (!/アクセスが集中|アクセスが混み合|ページが表示しづら|時間をおいて再度|try again later|temporarily unavailable|too many requests|service unavailable/i.test(text)) {
      return;
    }

    watchResult.diagnostics.push(`Rakuten congestion page detected on attempt ${attempt}.`);
  }

  throw new Error('Rakuten remained on its congestion page after retries.');
}

async function humanClick(page, locator, description, watchResult) {
  const count = await locator.count();
  for (let index = 0; index < count; index++) {
    const candidate = locator.nth(index);
    try {
      if (!await candidate.isVisible() || !await candidate.isEnabled()) continue;
      await candidate.scrollIntoViewIfNeeded();
      const box = await candidate.boundingBox();
      if (!box) continue;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
      await page.waitForTimeout(140);
      await page.mouse.down();
      await page.waitForTimeout(100);
      await page.mouse.up();
      watchResult.diagnostics.push(`Clicked ${description}.`);
      return true;
    } catch (error) {
      watchResult.diagnostics.push(`${description} candidate ${index + 1} failed: ${error.message}`);
    }
  }
  return false;
}

function variantRegex(value, kind) {
  const escaped = escapeRegExp(value);
  if (kind === 'size') {
    return new RegExp(`^\\s*(?:Size\\s*)?${escaped}(?:\\s|$)`, 'i');
  }
  return new RegExp(`^\\s*${escaped}(?:\\s|$)`, 'i');
}

async function clickVariant(page, value, kind, watchResult) {
  const textRegex = variantRegex(value, kind);
  const exactValue = String(value);
  const candidates = [
    page.locator(`input[value="${exactValue}"]`),
    page.locator(`button[value="${exactValue}"]`),
    page.locator(`[data-value="${exactValue}"]`),
    page.getByRole('button', { name: textRegex }),
    page.locator('label').filter({ hasText: textRegex }),
    page.getByText(textRegex)
  ];

  for (const locator of candidates) {
    if (await humanClick(page, locator, `${kind} ${value}`, watchResult)) {
      await page.waitForTimeout(800);
      return true;
    }
  }

  return false;
}

function sizePattern(size) {
  const escaped = escapeRegExp(size);
  return new RegExp(`(?:SIZE|サイズ|商品サイズ|Product\\s*size)\\s*[:：]?\\s*(?:Size\\s*)?${escaped}\\b`, 'i');
}

function colourPattern(colour) {
  if (!colour) return null;
  return new RegExp(`(?:COLOR|カラー|色)\\s*[:：]?\\s*${escapeRegExp(colour)}\\b`, 'i');
}

async function variantAlreadySelected(page, value, kind) {
  const text = (await bodyText(page)).replace(/\s+/g, ' ');
  if (kind === 'size') return sizePattern(value).test(text);
  return colourPattern(value).test(text);
}

async function selectVariants(page, watch, watchResult) {
  for (const kind of watch.selectionOrder) {
    const value = kind === 'size' ? watch.size : watch.colour;
    if (!value) continue;

    if (await variantAlreadySelected(page, value, kind)) {
      watchResult.selection[`${kind}_selected`] = true;
      watchResult.diagnostics.push(`${kind} ${value} was already selected by the product URL/page state.`);
      continue;
    }

    const clicked = await clickVariant(page, value, kind, watchResult);
    watchResult.selection[`${kind}_selected`] = clicked;
    if (!clicked) throw new Error(`${kind} ${value} could not be selected.`);
  }
}

async function clickPurchaseProcedure(page, watchResult) {
  const candidates = page.locator('button,[role="button"],a').filter({
    hasText: /^(?:\s*購入手続きへ\s*|\s*購入手続き\s*|\s*Proceed to purchase\s*|\s*Purchase procedure\s*)$/i
  });

  let best = null;
  let bestScore = -Infinity;
  for (let index = 0; index < await candidates.count(); index++) {
    const candidate = candidates.nth(index);
    try {
      if (!await candidate.isVisible() || !await candidate.isEnabled()) continue;
      const box = await candidate.boundingBox();
      if (!box) continue;
      const score = box.width * box.height + (box.x > 700 ? 100_000 : 0);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    } catch {}
  }

  if (!best) throw new Error('No active 購入手続きへ control was found.');
  const clicked = await humanClick(page, best, '購入手続きへ', watchResult);
  watchResult.purchase_button_clicked = clicked;
  if (!clicked) throw new Error('購入手続きへ could not be clicked.');
}

function confirmationScore(text, watch) {
  let score = 0;
  if (watch.productPattern.test(text)) score += 12;
  if (sizePattern(watch.size).test(text)) score += 12;
  if (!watch.colour || colourPattern(watch.colour).test(text)) score += 8;
  if (/(?:quantity|数量|個数)\s*[:：]?\s*\d+/i.test(text)) score += 8;
  if (/買い物かご|Shopping basket|Purchase procedure|購入手続き/i.test(text)) score += 4;
  return score;
}

async function waitForPurchaseOutcome(context, productPage, watch, watchResult) {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    const productText = (await bodyText(productPage)).replace(/\s+/g, ' ');
    if (/この商品は売り切れです|This product is sold out/i.test(productText)) {
      watchResult.sold_out_message_seen = true;
      watchResult.status = 'unavailable';
      watchResult.diagnostics.push(`${watch.name} unavailable: sold-out message appeared after 購入手続きへ.`);
      await safeScreenshot(productPage, `${watch.id}-sold-out`, watchResult);
      return { status: 'unavailable', page: productPage };
    }

    let bestPage = null;
    let bestScore = -1;
    for (const page of context.pages()) {
      let isItemPage = false;
      try {
        isItemPage = new URL(page.url()).hostname === 'item.rakuten.co.jp';
      } catch {}
      if (isItemPage) continue;

      const text = (await bodyText(page)).replace(/\s+/g, ' ');
      const score = confirmationScore(text, watch);
      if (score > bestScore) {
        bestScore = score;
        bestPage = page;
      }
    }

    const requiredScore = watch.colour ? 40 : 32;
    if (bestPage && bestScore >= requiredScore) {
      watchResult.confirmation_page_opened = true;
      return { status: 'available', page: bestPage };
    }

    await productPage.waitForTimeout(500);
  }

  throw new Error('After clicking 購入手続きへ, neither the confirmation page nor the sold-out message appeared.');
}

async function readQuantity(page, watchResult) {
  const text = (await bodyText(page)).replace(/\s+/g, ' ');
  const textMatch = text.match(/(?:quantity|数量|個数)\s*[:：]?\s*(\d+)/i);
  if (textMatch) {
    const quantity = parseQuantity(textMatch[1]);
    if (quantity !== null) {
      watchResult.diagnostics.push(`Quantity read from labelled page text: ${quantity}.`);
      return quantity;
    }
  }

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
      if (quantity !== null) return quantity;
    } catch {}
  }

  return null;
}

async function verifyConfirmation(page, watch, watchResult) {
  const text = (await bodyText(page)).replace(/\s+/g, ' ');
  watchResult.product_confirmed = watch.productPattern.test(text);
  watchResult.size_confirmed = sizePattern(watch.size).test(text);
  watchResult.colour_confirmed = !watch.colour || colourPattern(watch.colour).test(text);
  watchResult.quantity = await readQuantity(page, watchResult);
  watchResult.quantity_confirmed = Number.isInteger(watchResult.quantity) && watchResult.quantity >= 1;
  watchResult.genuinely_available =
    watchResult.product_confirmed &&
    watchResult.size_confirmed &&
    watchResult.colour_confirmed &&
    watchResult.quantity_confirmed;
  watchResult.status = watchResult.genuinely_available ? 'available' : 'ambiguous';

  watchResult.diagnostics.push(
    `Confirmation: product=${watchResult.product_confirmed}, colour=${watchResult.colour_confirmed}, size=${watchResult.size_confirmed}, quantity=${watchResult.quantity}.`
  );

  if (!watchResult.genuinely_available) {
    throw new Error(`Confirmation page did not verify ${watch.name} with quantity at least 1.`);
  }
}

async function extractPrice(page) {
  const candidateTexts = await page.evaluate(() => [...document.querySelectorAll('body *')]
    .map(element => (element.innerText || '').replace(/\s+/g, ' ').trim())
    .filter(value => value && value.length <= 400 && /\d{1,3}(?:,\d{3})\s*(?:円|circle|yen)/i.test(value)));

  const prices = candidateTexts.flatMap(parseYen).filter(price => price >= 1_000 && price <= 200_000);
  const frequencies = new Map();
  for (const price of prices) frequencies.set(price, (frequencies.get(price) || 0) + 1);
  return [...frequencies.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

async function removeVerifiedItem(page, watchResult) {
  const candidates = [
    page.getByRole('button', { name: /Delete|削除する|削除/i }),
    page.getByText(/^(?:Delete|削除する|削除)$/i)
  ];

  for (const locator of candidates) {
    if (await humanClick(page, locator, 'Delete confirmed item', watchResult)) {
      watchResult.diagnostics.push('Removed the verified item from the dedicated profile.');
      await page.waitForTimeout(1_000);
      return;
    }
  }

  watchResult.diagnostics.push('Could not remove the verified item; it may remain in the dedicated profile.');
}

async function fetchJpyPerGbp(watchResult) {
  const sources = [
    ['open.er-api.com', 'https://open.er-api.com/v6/latest/GBP', data => data?.rates?.JPY],
    ['frankfurter.app', 'https://api.frankfurter.app/latest?from=GBP&to=JPY', data => data?.rates?.JPY]
  ];

  for (const [name, url, read] of sources) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const rate = Number(read(await response.json()));
      if (Number.isFinite(rate) && rate > 0) {
        watchResult.diagnostics.push(`FX source: ${name}`);
        return rate;
      }
    } catch (error) {
      watchResult.diagnostics.push(`FX source failed (${name}): ${error.message}`);
    }
  }

  throw new Error('Unable to retrieve a live GBP/JPY rate.');
}

function notifyWindows(title, body, url) {
  const script = path.join(ROOT, 'local', 'notify.ps1');
  const child = spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Title', title, '-Body', body, '-Url', url
  ], { detached: true, stdio: 'ignore' });
  child.unref();
}

function shouldNotifyStock(previous, watchResult) {
  return watchResult.genuinely_available && previous?.status !== 'available';
}

function shouldNotifyPrice(previous, watchResult) {
  if (!watchResult.qualifies) return false;
  return !previous?.qualifies || previous?.listed_price_jpy !== watchResult.listed_price_jpy;
}

async function checkWatch(context, page, watch, previousState) {
  const watchResult = {
    id: watch.id,
    name: watch.name,
    url: watch.url,
    target_size: watch.size,
    target_colour: watch.colour,
    alert_mode: watch.alertMode,
    checked_at: new Date().toISOString(),
    listed_price_jpy: null,
    assumed_coupon_jpy: watch.assumedCouponJpy ?? null,
    effective_price_jpy: null,
    jpy_per_gbp: null,
    effective_price_gbp: null,
    price_trigger_met: false,
    gbp_trigger_met: false,
    qualifies: false,
    alert_triggered: false,
    selection: {
      size_selected: false,
      colour_selected: watch.colour ? false : null
    },
    purchase_button_clicked: false,
    sold_out_message_seen: false,
    confirmation_page_opened: false,
    product_confirmed: false,
    colour_confirmed: false,
    size_confirmed: false,
    quantity: null,
    quantity_confirmed: false,
    genuinely_available: false,
    status: 'unknown',
    diagnostics: [],
    error: null
  };

  try {
    await openProduct(page, watch, watchResult);
    const initialText = await bodyText(page);
    if (!watch.productPattern.test(initialText)) {
      throw new Error('Rendered product identifier was not found.');
    }

    watchResult.listed_price_jpy = await extractPrice(page);
    if (!watchResult.listed_price_jpy) throw new Error('Live listed price could not be extracted.');

    await selectVariants(page, watch, watchResult);
    await safeScreenshot(page, `${watch.id}-selected`, watchResult);
    await clickPurchaseProcedure(page, watchResult);

    const outcome = await waitForPurchaseOutcome(context, page, watch, watchResult);
    if (outcome.status === 'unavailable') return watchResult;

    await safeScreenshot(outcome.page, `${watch.id}-confirmation`, watchResult);
    await verifyConfirmation(outcome.page, watch, watchResult);

    if (watch.alertMode === 'price') {
      watchResult.effective_price_jpy = watchResult.listed_price_jpy - watch.assumedCouponJpy;
      watchResult.jpy_per_gbp = await fetchJpyPerGbp(watchResult);
      watchResult.effective_price_gbp = Number((watchResult.effective_price_jpy / watchResult.jpy_per_gbp).toFixed(2));
      watchResult.price_trigger_met = watchResult.listed_price_jpy < watch.baselineJpy;
      watchResult.gbp_trigger_met = watchResult.effective_price_gbp < watch.gbpTrigger;
      watchResult.qualifies = watchResult.genuinely_available && (watchResult.price_trigger_met || watchResult.gbp_trigger_met);
      watchResult.alert_triggered = !KEEP_ITEM && shouldNotifyPrice(previousState, watchResult);

      if (watchResult.alert_triggered) {
        const triggers = [
          watchResult.price_trigger_met ? `listed price below ¥${watch.baselineJpy.toLocaleString('en-GB')}` : null,
          watchResult.gbp_trigger_met ? `assumed-coupon price below £${watch.gbpTrigger}` : null
        ].filter(Boolean).join(' and ');
        notifyWindows(
          `${watch.name} deal available`,
          `Confirmed in basket. Listed ¥${watchResult.listed_price_jpy.toLocaleString('en-GB')}; assumed ¥${watch.assumedCouponJpy.toLocaleString('en-GB')} discount = ¥${watchResult.effective_price_jpy.toLocaleString('en-GB')} / £${watchResult.effective_price_gbp.toFixed(2)}. Trigger: ${triggers}.`,
          watch.url
        );
      }
    } else {
      watchResult.qualifies = watchResult.genuinely_available;
      watchResult.alert_triggered = !KEEP_ITEM && shouldNotifyStock(previousState, watchResult);
      if (watchResult.alert_triggered) {
        const colourText = watch.colour ? `, ${watch.colour}` : '';
        notifyWindows(
          `${watch.name} is in stock`,
          `${watch.name}${colourText} has been confirmed in the Rakuten basket with quantity ${watchResult.quantity}. Listed price ¥${watchResult.listed_price_jpy.toLocaleString('en-GB')}.`,
          watch.url
        );
      }
    }

    if (KEEP_ITEM) {
      watchResult.diagnostics.push('Verified item retained for the visible test run.');
    } else {
      await removeVerifiedItem(outcome.page, watchResult);
    }
  } catch (error) {
    watchResult.status = watchResult.status === 'unavailable' ? 'unavailable' : 'error';
    watchResult.error = error.stack || error.message;
    await safeScreenshot(page, `${watch.id}-error`, watchResult);
  }

  return watchResult;
}

function legacyFullcountFields(fullcount) {
  return {
    product_url: fullcount?.url ?? WATCHES[0].url,
    listed_price_jpy: fullcount?.listed_price_jpy ?? null,
    assumed_coupon_jpy: ASSUMED_COUPON_JPY,
    effective_price_jpy: fullcount?.effective_price_jpy ?? null,
    jpy_per_gbp: fullcount?.jpy_per_gbp ?? null,
    effective_price_gbp: fullcount?.effective_price_gbp ?? null,
    price_trigger_met: fullcount?.price_trigger_met ?? false,
    gbp_trigger_met: fullcount?.gbp_trigger_met ?? false,
    w33: fullcount ? {
      colour_selected: fullcount.selection.colour_selected,
      size_selected: fullcount.selection.size_selected,
      purchase_button_clicked: fullcount.purchase_button_clicked,
      sold_out_message_seen: fullcount.sold_out_message_seen,
      confirmation_page_opened: fullcount.confirmation_page_opened,
      product_confirmed: fullcount.product_confirmed,
      colour_confirmed: fullcount.colour_confirmed,
      size_confirmed: fullcount.size_confirmed,
      quantity: fullcount.quantity,
      quantity_confirmed: fullcount.quantity_confirmed,
      genuinely_available: fullcount.genuinely_available,
      status: fullcount.status
    } : null
  };
}

async function main() {
  await acquireLock();

  try {
    const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    const context = browser.contexts()[0];
    if (!context) throw new Error('Chrome exposed no browser context through CDP.');

    const page = context.pages().find(item => /rakuten\.co\.jp/i.test(item.url())) || context.pages()[0] || await context.newPage();
    const state = await readState();
    const nextState = { ...state };

    for (const watch of WATCHES) {
      const watchResult = await checkWatch(context, page, watch, state[watch.id]);
      result.watches.push(watchResult);
      result.alert_triggered ||= watchResult.alert_triggered;

      nextState[watch.id] = {
        checked_at: watchResult.checked_at,
        status: watchResult.status,
        genuinely_available: watchResult.genuinely_available,
        qualifies: watchResult.qualifies,
        listed_price_jpy: watchResult.listed_price_jpy
      };
    }

    await writeState(nextState);

    const fullcount = result.watches.find(item => item.id === 'fullcount-1110-w33');
    Object.assign(result, legacyFullcountFields(fullcount));

    const errors = result.watches.filter(item => item.error);
    if (errors.length) {
      result.error = errors.map(item => `${item.name}: ${item.error.split('\n')[0]}`).join(' | ');
    }
  } catch (error) {
    result.error = error.stack || error.message;
  } finally {
    await fs.mkdir(ARTIFACT_DIR, { recursive: true });
    await fs.writeFile(path.join(ARTIFACT_DIR, 'result.json'), JSON.stringify(result, null, 2));
    await fs.appendFile(path.join(ARTIFACT_DIR, 'history.ndjson'), `${JSON.stringify(result)}\n`);
    await releaseLock();
  }

  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.error ? 1 : 0;
}

await main();
