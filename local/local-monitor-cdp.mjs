import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCT_URL = 'https://item.rakuten.co.jp/realmoon/1110w/';
const CDP_ENDPOINT = process.env.RAKUTEN_CDP_ENDPOINT || 'http://127.0.0.1:9222';
const ARTIFACT_DIR = path.join(ROOT, 'artifacts-local');
const LOCK_FILE = path.join(ARTIFACT_DIR, 'monitor.lock');
const BASELINE_JPY = 30_580;
const ASSUMED_COUPON_JPY = 1_000;
const GBP_TRIGGER = 135;
const BOOTSTRAP = process.argv.includes('--bootstrap');

const result = {
  checked_at: new Date().toISOString(),
  environment: 'ordinary-chrome-cdp-direct-purchase',
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
    purchase_button_clicked: false,
    confirmation_page_opened: false,
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

async function bodyText(page) {
  return await page.locator('body').innerText().catch(() => '');
}

async function safeScreenshot(page, name) {
  try {
    await page.screenshot({ path: path.join(ARTIFACT_DIR, `${name}.png`), fullPage: true, timeout: 12_000 });
  } catch (error) {
    result.diagnostics.push(`Screenshot skipped (${name}): ${error.message}`);
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
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
      result.diagnostics.push(`Removed stale monitor lock for PID ${lockedPid || 'unknown'}.`);
      await fs.rm(LOCK_FILE, { force: true });
    }
  }

  throw new Error('Could not acquire the local monitor lock.');
}

async function releaseLock() {
  await fs.rm(LOCK_FILE, { force: true }).catch(() => {});
}

async function classifyRakutenFailure(page) {
  const text = await bodyText(page);
  if (/Reference\s*#18\.|Access Denied|request rejected/i.test(text)) return 'security-block';
  if (/アクセスが集中|アクセスが混み合|ページが表示しづら|時間をおいて再度|try again later|temporarily unavailable|too many requests|service unavailable/i.test(text)) return 'congestion';
  return null;
}

async function openProductWithRetry(page) {
  const waits = [0, 20_000, 60_000];

  for (let attempt = 1; attempt <= waits.length; attempt++) {
    if (waits[attempt - 1]) {
      const jitter = Math.floor(Math.random() * 7_501);
      const delay = waits[attempt - 1] + jitter;
      result.diagnostics.push(`Rakuten retry ${attempt - 1}: waiting ${(delay / 1000).toFixed(1)} seconds.`);
      await page.waitForTimeout(delay);
    }

    await page.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(4_000);
    const failure = await classifyRakutenFailure(page);
    if (!failure) return;
    result.diagnostics.push(`Rakuten ${failure} page detected on attempt ${attempt}.`);
    if (failure === 'security-block') {
      throw new Error('Rakuten blocked the ordinary Chrome session at its security edge (Reference #18 page).');
    }
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
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
      await page.waitForTimeout(140);
      await page.mouse.down();
      await page.waitForTimeout(100);
      await page.mouse.up();
      result.diagnostics.push(`Clicked ${description} with a mouse event.`);
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

async function clickPurchaseProcedure(page) {
  const candidates = page.locator('button,[role="button"],a').filter({
    hasText: /^(?:\s*購入手続きへ\s*|\s*購入手続き\s*|\s*Proceed to purchase\s*|\s*Purchase procedure\s*)$/i
  });

  const count = await candidates.count();
  let best = null;
  let bestScore = -Infinity;

  for (let index = 0; index < count; index++) {
    const candidate = candidates.nth(index);
    try {
      if (!await candidate.isVisible() || !await candidate.isEnabled()) continue;
      const box = await candidate.boundingBox();
      if (!box) continue;
      const score = box.width * box.height + (box.x > 700 ? 100_000 : 0);
      result.diagnostics.push(`Purchase-procedure candidate ${index + 1} score=${Math.round(score)}.`);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    } catch {}
  }

  if (!best) throw new Error('No active 購入手続きへ / Proceed to purchase control was found.');

  const oldUrl = page.url();
  const clicked = await humanClick(page, best, '購入手続きへ / Proceed to purchase');
  result.w33.purchase_button_clicked = Boolean(clicked);
  if (!clicked) throw new Error('The 購入手続きへ / Proceed to purchase control could not be clicked.');

  await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(3_000);
  result.diagnostics.push(`Purchase navigation: ${oldUrl} -> ${page.url()}`);
}

async function chooseConfirmationPage(context) {
  let bestPage = null;
  let bestScore = -Infinity;

  for (const page of context.pages()) {
    const text = (await bodyText(page)).replace(/\s+/g, ' ');
    let score = 0;
    if (/FCP-1110W|Fullcount Jeans 1110|フルカウント.*1110/i.test(text)) score += 10;
    if (/COLOR\s*[:：]?\s*ONE WASH/i.test(text)) score += 10;
    if (/SIZE\s*[:：]?\s*33\b/i.test(text)) score += 10;
    if (/(?:quantity|数量|個数)\s*[:：]?\s*\d+/i.test(text)) score += 8;
    if (/買い物かご|Shopping basket|Purchase procedure|購入手続き/i.test(text)) score += 4;
    if (score > bestScore) {
      bestScore = score;
      bestPage = page;
    }
  }

  result.diagnostics.push(`Confirmation-page selection score=${bestScore}.`);
  return bestPage;
}

async function readQuantity(page) {
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
  const match = text.match(/(?:quantity|数量|個数)\s*[:：]?\s*(\d+)/i);
  return match ? parseQuantity(match[1]) : null;
}

async function verifyConfirmation(page) {
  const text = (await bodyText(page)).replace(/\s+/g, ' ');
  if (/商品情報が変更されました|product information has changed/i.test(text)) {
    throw new Error('Rakuten rejected the selected product as stale product information.');
  }

  result.w33.product_confirmed = /FCP-1110W|Fullcount Jeans 1110|フルカウント.*1110/i.test(text);
  result.w33.colour_confirmed = /COLOR\s*[:：]?\s*ONE WASH/i.test(text);
  result.w33.size_confirmed = /SIZE\s*[:：]?\s*33\b/i.test(text);
  result.w33.quantity = await readQuantity(page);
  result.w33.quantity_confirmed = Number.isInteger(result.w33.quantity) && result.w33.quantity >= 1;
  result.w33.confirmation_page_opened = result.w33.product_confirmed;
  result.w33.genuinely_available =
    result.w33.product_confirmed &&
    result.w33.colour_confirmed &&
    result.w33.size_confirmed &&
    result.w33.quantity_confirmed;

  result.diagnostics.push(
    `Confirmation verification: product=${result.w33.product_confirmed}, colour=${result.w33.colour_confirmed}, size=${result.w33.size_confirmed}, quantity=${result.w33.quantity}`
  );

  if (!result.w33.genuinely_available) {
    throw new Error('Confirmation page did not show FCP-1110W / ONE WASH / size 33 with quantity at least 1.');
  }
}

async function removeVerifiedItem(page) {
  const candidates = [
    page.getByRole('button', { name: /Delete|削除する|削除/i }),
    page.getByText(/^(?:Delete|削除する|削除)$/i)
  ];
  for (const locator of candidates) {
    const clicked = await humanClick(page, locator, 'Delete confirmed item');
    if (clicked) {
      result.diagnostics.push('Removed the verified item from the dedicated profile.');
      await page.waitForTimeout(1_000);
      return;
    }
  }
  result.diagnostics.push('Could not remove the verified item; it may remain in the dedicated profile.');
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

async function bootstrap(context) {
  const page = context.pages().find(item => /rakuten\.co\.jp/i.test(item.url())) || context.pages()[0] || await context.newPage();
  await openProductWithRetry(page);
  console.log('\nOrdinary Chrome is open with the dedicated Rakuten profile.');
  console.log('Manually select ONE WASH and size 33, then click 購入手続きへ.');
  console.log('When the confirmation page shows FCP-1110W / ONE WASH / SIZE 33 / quantity 1, return here and press Enter.');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('Press Enter when the manual confirmation test is complete... ');
  rl.close();

  const confirmationPage = await chooseConfirmationPage(context);
  if (!confirmationPage) throw new Error('Could not find the Rakuten confirmation page after the manual test.');
  await safeScreenshot(confirmationPage, 'bootstrap-confirmation');
  await verifyConfirmation(confirmationPage);
  await removeVerifiedItem(confirmationPage);
}

async function runCheck(context) {
  const page = context.pages().find(item => /rakuten\.co\.jp/i.test(item.url())) || context.pages()[0] || await context.newPage();
  await openProductWithRetry(page);
  await safeScreenshot(page, 'product');

  const initialText = await bodyText(page);
  if (!/FCP-1110W|Fullcount Jeans 1110|フルカウント.*1110/i.test(initialText)) {
    throw new Error('Rendered product identifiers were not found.');
  }

  const candidateTexts = await page.evaluate(() => [...document.querySelectorAll('body *')]
    .map(element => (element.innerText || '').replace(/\s+/g, ' ').trim())
    .filter(value => value && value.length <= 400 && (/30,580/.test(value) || /\d{1,3}(?:,\d{3})\s*円/.test(value))));
  const prices = candidateTexts.flatMap(parseYen).filter(price => price >= 10_000 && price <= 100_000);
  const frequencies = new Map();
  for (const price of prices) frequencies.set(price, (frequencies.get(price) || 0) + 1);
  result.listed_price_jpy = [...frequencies.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  if (!result.listed_price_jpy) throw new Error('Live listed price could not be extracted.');

  await selectVariant(page);
  await safeScreenshot(page, 'selected-w33');
  await clickPurchaseProcedure(page);

  const confirmationPage = await chooseConfirmationPage(context);
  if (!confirmationPage) throw new Error('Could not find the Rakuten confirmation page after clicking 購入手続きへ.');
  await safeScreenshot(confirmationPage, 'confirmation');
  await verifyConfirmation(confirmationPage);

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
      `W33 is confirmed. Listed ¥${result.listed_price_jpy.toLocaleString('en-GB')}; assumed ¥1,000 discount = ¥${result.effective_price_jpy.toLocaleString('en-GB')} / £${result.effective_price_gbp.toFixed(2)}. Trigger: ${trigger}.`
    );
  }

  await removeVerifiedItem(confirmationPage);
}

async function main() {
  await acquireLock();
  let context;
  let errorPage;

  try {
    const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    context = browser.contexts()[0];
    if (!context) throw new Error('Chrome exposed no browser context through CDP.');
    errorPage = context.pages()[0];
    if (BOOTSTRAP) await bootstrap(context);
    else await runCheck(context);
  } catch (error) {
    result.error = error.stack || error.message;
    if (context) {
      errorPage = await chooseConfirmationPage(context) || errorPage;
      if (errorPage) await safeScreenshot(errorPage, 'error');
    }
  } finally {
    await fs.writeFile(path.join(ARTIFACT_DIR, 'result.json'), JSON.stringify(result, null, 2));
    await fs.appendFile(path.join(ARTIFACT_DIR, 'history.ndjson'), `${JSON.stringify(result)}\n`);
    await releaseLock();
  }

  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.error ? 1 : 0;
}

await main();
