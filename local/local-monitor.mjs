import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCT_URL = 'https://item.rakuten.co.jp/realmoon/1110w/';
const PROFILE_DIR = process.env.RAKUTEN_PROFILE_DIR || path.join(ROOT, '.rakuten-profile');
const ARTIFACT_DIR = path.join(ROOT, 'artifacts-local');
const LOCK_FILE = path.join(ARTIFACT_DIR, 'monitor.lock');
const BASELINE_JPY = 30_580;
const ASSUMED_COUPON_JPY = 1_000;
const GBP_TRIGGER = 135;
const BOOTSTRAP = process.argv.includes('--bootstrap');
const HEADLESS = process.env.RAKUTEN_HEADLESS === '1' && !BOOTSTRAP;

const result = {
  checked_at: new Date().toISOString(),
  environment: 'local-persistent-chrome',
  product_url: PRODUCT_URL,
  listed_price_jpy: null,
  assumed_coupon_jpy: ASSUMED_COUPON_JPY,
  effective_price_jpy: null,
  jpy_per_gbp: null,
  effective_price_gbp: null,
  price_trigger_met: false,
  gbp_trigger_met: false,
  alert_triggered: false,
  w33: {
    colour_selected: false,
    size_selected: false,
    cart_button_clicked: false,
    basket_opened: false,
    product_confirmed: false,
    colour_confirmed: false,
    size_confirmed: false,
    quantity: null,
    quantity_confirmed: false,
    genuinely_available: false
  },
  diagnostics: [],
  error: null
};

function parseYen(text) {
  return [...String(text).matchAll(/(?:¥|￥)?\s*([0-9]{1,3}(?:,[0-9]{3})+)\s*(?:円|circle)?/g)]
    .map(match => Number(match[1].replaceAll(',', '')))
    .filter(Number.isFinite);
}

function parseQuantity(value) {
  const match = String(value ?? '').match(/\d+/);
  if (!match) return null;
  const quantity = Number(match[0]);
  return Number.isInteger(quantity) && quantity >= 0 && quantity <= 99 ? quantity : null;
}

async function safeScreenshot(page, name) {
  try {
    await page.screenshot({ path: path.join(ARTIFACT_DIR, `${name}.png`), fullPage: true, timeout: 12_000 });
  } catch (error) {
    result.diagnostics.push(`Screenshot skipped (${name}): ${error.message}`);
  }
}

async function acquireLock() {
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });
  try {
    const handle = await fs.open(LOCK_FILE, 'wx');
    await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
    await handle.close();
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Another local Rakuten monitor run is already active.');
    throw error;
  }
}

async function releaseLock() {
  await fs.rm(LOCK_FILE, { force: true }).catch(() => {});
}

async function isCongestionPage(page) {
  const text = await page.locator('body').innerText().catch(() => '');
  return /アクセスが集中|アクセスが混み合|ページが表示しづら|時間をおいて再度|try again later|temporarily unavailable|too many requests|service unavailable/i.test(text);
}

async function openProductWithRetry(page) {
  const waits = [0, 20_000, 60_000];
  for (let attempt = 1; attempt <= waits.length; attempt++) {
    if (waits[attempt - 1]) {
      const jitter = Math.floor(Math.random() * 7_501);
      const delay = waits[attempt - 1] + jitter;
      result.diagnostics.push(`Congestion retry ${attempt - 1}: waiting ${(delay / 1000).toFixed(1)} seconds.`);
      await page.waitForTimeout(delay);
    }

    await page.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(4_000);
    if (!await isCongestionPage(page)) return;
    result.diagnostics.push(`Rakuten congestion page detected on attempt ${attempt}.`);
  }
  throw new Error('Rakuten remained on its congestion page after local retries.');
}

async function humanClick(page, locator, description) {
  const count = await locator.count();
  for (let index = 0; index < count; index++) {
    const candidate = locator.nth(index);
    try {
      if (!await candidate.isVisible() || !await candidate.isEnabled()) continue;
      await candidate.scrollIntoViewIfNeeded();
      const box = await candidate.boundingBox();
      if (!box) continue;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y, { steps: 6 });
      await page.waitForTimeout(120);
      await page.mouse.down();
      await page.waitForTimeout(90);
      await page.mouse.up();
      result.diagnostics.push(`Clicked ${description} with a real mouse event.`);
      return candidate;
    } catch (error) {
      result.diagnostics.push(`${description} candidate ${index + 1} failed: ${error.message}`);
    }
  }
  return null;
}

async function selectVariant(page) {
  const colour = await humanClick(page, page.getByText('ONE WASH', { exact: true }), 'ONE WASH');
  result.w33.colour_selected = Boolean(colour);
  if (!colour) throw new Error('ONE WASH could not be selected.');
  await page.waitForTimeout(700);

  const sizeCandidates = [
    page.locator('input[value="33"]'),
    page.locator('button[value="33"]'),
    page.locator('[data-value="33"]'),
    page.getByRole('button', { name: /^\s*33(?:\s|$)/ }),
    page.locator('label').filter({ hasText: /^\s*33(?:\s|$)/ }),
    page.getByText(/^\s*33(?:\s|$)/)
  ];

  for (const locator of sizeCandidates) {
    const clicked = await humanClick(page, locator, 'size 33');
    if (clicked) {
      result.w33.size_selected = true;
      await page.waitForTimeout(1_000);
      return;
    }
  }
  throw new Error('Size 33 could not be selected.');
}

async function findBestCartButton(page) {
  const candidates = page.locator('button,[role="button"],a').filter({ hasText: /^(?:\s*Add to cart\s*|\s*かごに追加\s*|\s*買い物かごに入れる\s*)$/i });
  const count = await candidates.count();
  let best = null;
  let bestScore = -Infinity;

  for (let index = 0; index < count; index++) {
    const candidate = candidates.nth(index);
    try {
      if (!await candidate.isVisible() || !await candidate.isEnabled()) continue;
      const score = await candidate.evaluate(element => {
        let node = element;
        let score = 0;
        for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
          const text = (node.innerText || '').replace(/\s+/g, ' ');
          if (/ONE WASH/i.test(text)) score += 5;
          if (/(?:SIZE|サイズ)\s*[:：]?\s*33\b/i.test(text)) score += 8;
          if (/30,580/.test(text)) score += 2;
          if (text.length > 5_000) score -= 4;
        }
        return score;
      });
      result.diagnostics.push(`Cart button candidate ${index + 1} score=${score}.`);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    } catch {}
  }
  return best;
}

async function addToCart(page) {
  const button = await findBestCartButton(page);
  if (!button) throw new Error('No usable Add to cart button was found.');

  const responsePromise = page.waitForResponse(
    response => /cart|basket|purchase|order|item/i.test(response.url()),
    { timeout: 12_000 }
  ).catch(() => null);

  const clicked = await humanClick(page, button, 'the selected-variant Add to cart button');
  result.w33.cart_button_clicked = Boolean(clicked);
  if (!clicked) throw new Error('The selected-variant Add to cart button could not be clicked.');

  const response = await responsePromise;
  if (response) result.diagnostics.push(`Cart-related response: ${response.status()} ${response.url()}`);
  await page.waitForTimeout(3_000);
}

async function openBasket(page) {
  const candidates = [
    page.getByRole('link', { name: /Shopping basket|買い物かご|ショッピングカート/i }),
    page.locator('a').filter({ hasText: /Shopping basket|買い物かご|ショッピングカート/i }),
    page.locator('a[href*="basket" i],a[href*="cart" i]')
  ];

  for (const locator of candidates) {
    const clicked = await humanClick(page, locator, 'Shopping basket');
    if (!clicked) continue;
    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2_500);
    const text = await page.locator('body').innerText().catch(() => '');
    if (/Shopping basket|買い物かご|ショッピングカート|Purchase procedure/i.test(text)) {
      result.w33.basket_opened = true;
      return;
    }
  }
  throw new Error('Shopping basket could not be opened.');
}

async function readBasketQuantity(page) {
  const controls = page.locator([
    'select[name*="quantity" i]', 'select[id*="quantity" i]',
    'select[name*="qty" i]', 'select[id*="qty" i]',
    'input[name*="quantity" i]', 'input[id*="quantity" i]',
    'input[name*="qty" i]', 'input[id*="qty" i]',
    'select', 'input[type="number"]'
  ].join(','));

  const count = await controls.count();
  for (let index = 0; index < count; index++) {
    const control = controls.nth(index);
    try {
      if (!await control.isVisible()) continue;
      let raw = await control.inputValue().catch(() => '');
      if (!raw) raw = await control.locator('option:checked').textContent().catch(() => '');
      const quantity = parseQuantity(raw);
      if (quantity !== null) return quantity;
    } catch {}
  }

  const text = await page.locator('body').innerText();
  const match = text.match(/(?:quantity|数量|個数)\s*[:：]?\s*(\d+)/i);
  return match ? parseQuantity(match[1]) : null;
}

async function verifyBasket(page) {
  const basketText = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  if (/商品情報が変更されました|product information has changed/i.test(basketText)) {
    throw new Error('Rakuten rejected the local cart submission as stale product information.');
  }

  result.w33.product_confirmed = /FCP-1110W|Fullcount Jeans 1110|Fullcount.*1110/i.test(basketText);
  result.w33.colour_confirmed = /COLOR\s*[:：]?\s*ONE WASH/i.test(basketText);
  result.w33.size_confirmed = /SIZE\s*[:：]?\s*33\b/i.test(basketText);
  result.w33.quantity = await readBasketQuantity(page);
  result.w33.quantity_confirmed = Number.isInteger(result.w33.quantity) && result.w33.quantity >= 1;
  result.w33.genuinely_available =
    result.w33.product_confirmed &&
    result.w33.colour_confirmed &&
    result.w33.size_confirmed &&
    result.w33.quantity_confirmed;

  result.diagnostics.push(
    `Basket verification: product=${result.w33.product_confirmed}, colour=${result.w33.colour_confirmed}, size=${result.w33.size_confirmed}, quantity=${result.w33.quantity}`
  );

  if (!result.w33.genuinely_available) {
    throw new Error('Basket did not confirm FCP-1110W / ONE WASH / size 33 with quantity at least 1.');
  }
}

async function removeVerifiedItem(page) {
  const deleteCandidates = [
    page.getByRole('button', { name: /Delete|削除/i }),
    page.getByText(/^(?:Delete|削除)$/i)
  ];
  for (const locator of deleteCandidates) {
    const clicked = await humanClick(page, locator, 'Delete basket item');
    if (clicked) {
      result.diagnostics.push('Removed the verified item from the dedicated monitor basket.');
      await page.waitForTimeout(1_000);
      return;
    }
  }
  result.diagnostics.push('Could not remove the verified item; the dedicated profile basket may retain it.');
}

async function fetchJpyPerGbp() {
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
        result.diagnostics.push(`FX source: ${name}`);
        return rate;
      }
    } catch (error) {
      result.diagnostics.push(`FX source failed (${name}): ${error.message}`);
    }
  }
  throw new Error('Unable to retrieve a live GBP/JPY rate.');
}

function notifyWindows(title, body) {
  const script = path.join(ROOT, 'local', 'notify.ps1');
  const child = spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Title', title, '-Body', body, '-Url', PRODUCT_URL
  ], { detached: true, stdio: 'ignore' });
  child.unref();
}

async function bootstrap(page) {
  await openProductWithRetry(page);
  console.log('\nDedicated Rakuten monitor profile is open.');
  console.log('Manually select ONE WASH and size 33, add it to the basket, and open Shopping basket.');
  console.log('Confirm that the basket shows FCP-1110W / ONE WASH / SIZE 33, then return here and press Enter.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('Press Enter when the manual basket test is complete... ');
  rl.close();
  await safeScreenshot(page, 'bootstrap-final');
}

async function runCheck(page) {
  await openProductWithRetry(page);
  await safeScreenshot(page, 'product');

  const bodyText = await page.locator('body').innerText();
  if (!/FCP-1110W|Fullcount Jeans 1110/i.test(bodyText)) throw new Error('Rendered product identifiers were not found.');

  const candidateTexts = await page.evaluate(() => [...document.querySelectorAll('body *')]
    .map(element => (element.innerText || '').replace(/\s+/g, ' ').trim())
    .filter(text => text && text.length <= 400 && (/30,580/.test(text) || /\d{1,3}(?:,\d{3})\s*円/.test(text))));
  const prices = candidateTexts.flatMap(parseYen).filter(price => price >= 10_000 && price <= 100_000);
  const frequencies = new Map();
  for (const price of prices) frequencies.set(price, (frequencies.get(price) || 0) + 1);
  result.listed_price_jpy = [...frequencies.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  if (!result.listed_price_jpy) throw new Error('Live listed price could not be extracted.');

  await selectVariant(page);
  await safeScreenshot(page, 'selected-w33');
  await addToCart(page);
  await openBasket(page);
  await safeScreenshot(page, 'basket');
  await verifyBasket(page);

  result.effective_price_jpy = result.listed_price_jpy - ASSUMED_COUPON_JPY;
  result.jpy_per_gbp = await fetchJpyPerGbp();
  result.effective_price_gbp = Number((result.effective_price_jpy / result.jpy_per_gbp).toFixed(2));
  result.price_trigger_met = result.listed_price_jpy < BASELINE_JPY;
  result.gbp_trigger_met = result.effective_price_gbp < GBP_TRIGGER;
  result.alert_triggered = result.w33.genuinely_available && (result.price_trigger_met || result.gbp_trigger_met);

  if (result.alert_triggered) {
    const trigger = [
      result.price_trigger_met ? 'listed price below ¥30,580' : null,
      result.gbp_trigger_met ? 'assumed-coupon price below £135' : null
    ].filter(Boolean).join(' and ');
    notifyWindows(
      'Fullcount 1110 W33 deal available',
      `W33 is in the basket. Listed ¥${result.listed_price_jpy.toLocaleString('en-GB')}; assumed ¥1,000 discount = ¥${result.effective_price_jpy.toLocaleString('en-GB')} / £${result.effective_price_gbp.toFixed(2)}. Trigger: ${trigger}.`
    );
  }

  await removeVerifiedItem(page);
}

async function main() {
  await acquireLock();
  await fs.mkdir(PROFILE_DIR, { recursive: true });

  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: 'chrome',
      headless: HEADLESS,
      viewport: null,
      locale: 'ja-JP',
      args: BOOTSTRAP ? [] : ['--start-minimized']
    });
    const pages = context.pages();
    const page = pages[0] || await context.newPage();

    if (BOOTSTRAP) await bootstrap(page);
    else await runCheck(page);
  } catch (error) {
    result.error = error.stack || error.message;
    if (context) {
      const page = context.pages()[0];
      if (page) await safeScreenshot(page, 'error');
    }
  } finally {
    await fs.writeFile(path.join(ARTIFACT_DIR, 'result.json'), JSON.stringify(result, null, 2));
    await fs.appendFile(path.join(ARTIFACT_DIR, 'history.ndjson'), `${JSON.stringify(result)}\n`);
    if (context) await context.close().catch(() => {});
    await releaseLock();
  }

  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.error ? 1 : 0;
}

await main();
