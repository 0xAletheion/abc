import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const PRODUCT_URL = 'https://item.rakuten.co.jp/realmoon/1110w/';
const BASELINE_JPY = 30_580;
const ASSUMED_COUPON_JPY = 1_000;
const GBP_TRIGGER = 135;

const result = {
  checked_at: new Date().toISOString(),
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
    found: false,
    selection_attempted: false,
    purchase_control_active: false,
    cart_confirmed: false,
    genuinely_available: false,
    selector_used: null
  },
  diagnostics: [],
  error: null
};

function parseYen(text) {
  const matches = [...text.matchAll(/(?:¥|￥)?\s*([0-9]{1,3}(?:,[0-9]{3})+)\s*(?:円|circle)?/g)];
  return matches.map(m => Number(m[1].replaceAll(',', ''))).filter(Number.isFinite);
}

async function fetchJpyPerGbp() {
  for (const source of [
    ['open.er-api.com', 'https://open.er-api.com/v6/latest/GBP', d => d?.rates?.JPY],
    ['frankfurter.app', 'https://api.frankfurter.app/latest?from=GBP&to=JPY', d => d?.rates?.JPY]
  ]) {
    try {
      const response = await fetch(source[1], { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const rate = Number(source[2](await response.json()));
      if (Number.isFinite(rate) && rate > 0) {
        result.diagnostics.push(`FX source: ${source[0]}`);
        return rate;
      }
    } catch (error) {
      result.diagnostics.push(`FX source failed (${source[0]}): ${error.message}`);
    }
  }
  throw new Error('Unable to retrieve a valid GBP/JPY rate');
}

async function clickFirstVisible(locator, description) {
  const count = await locator.count();
  for (let i = 0; i < count; i++) {
    const item = locator.nth(i);
    try {
      if (await item.isVisible() && await item.isEnabled()) {
        await item.click({ timeout: 7_000 });
        result.diagnostics.push(`Clicked ${description}`);
        return item;
      }
    } catch {}
  }
  return null;
}

async function main() {
  await fs.mkdir('artifacts', { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'ja-JP',
    viewport: { width: 1600, height: 1200 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    await page.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(5_000);
    await page.screenshot({ path: 'artifacts/page-initial.png', fullPage: true });

    const bodyText = await page.locator('body').innerText();
    if (!bodyText.includes('FCP-1110W') && !bodyText.includes('Fullcount Jeans 1110')) {
      throw new Error('Expected product identifiers were not found on the rendered page');
    }
    result.diagnostics.push('Rendered product page confirmed');

    const priceCandidates = await page.evaluate(() => [...document.querySelectorAll('body *')]
      .map(el => (el.innerText || '').replace(/\s+/g, ' ').trim())
      .filter(text => text && text.length <= 400 && (/30,580/.test(text) || /\d{1,3}(?:,\d{3})\s*円/.test(text))));
    const prices = priceCandidates.flatMap(parseYen).filter(p => p >= 10_000 && p <= 100_000);
    const frequency = new Map();
    for (const price of prices) frequency.set(price, (frequency.get(price) || 0) + 1);
    result.listed_price_jpy = [...frequency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    if (!result.listed_price_jpy) throw new Error('Could not extract the live listed yen price');
    result.diagnostics.push(`Listed price extracted: ¥${result.listed_price_jpy.toLocaleString('en-GB')}`);

    await clickFirstVisible(page.getByText('ONE WASH', { exact: true }), 'ONE WASH');
    await page.waitForTimeout(1_000);

    const candidates = [
      ['input[value="33"]', page.locator('input[value="33"]')],
      ['button[value="33"]', page.locator('button[value="33"]')],
      ['[data-value="33"]', page.locator('[data-value="33"]')],
      ['label exact text 33', page.locator('label').filter({ hasText: /^\s*33\s*$/ })],
      ['button exact text 33', page.getByRole('button', { name: /^\s*33\s*$/ })],
      ['exact visible text 33', page.getByText(/^\s*33\s*$/, { exact: true })]
    ];

    for (const [name, locator] of candidates) {
      const clicked = await clickFirstVisible(locator, `size 33 via ${name}`);
      if (clicked) {
        result.w33.found = true;
        result.w33.selection_attempted = true;
        result.w33.selector_used = name;
        break;
      }
    }

    if (!result.w33.selection_attempted) {
      throw new Error('Could not select size 33 through any rendered control');
    }
    await page.waitForTimeout(1_500);
    await page.screenshot({ path: 'artifacts/page-after-size33.png', fullPage: true });

    const addToCartCandidates = page.getByText(/Add to cart|買い物かごに入れる|かごに追加/i);
    const addToCart = await clickFirstVisible(addToCartCandidates, 'Add to cart');
    result.w33.purchase_control_active = Boolean(addToCart);

    if (!addToCart) throw new Error('Size 33 was selected, but no active Add to cart control was available');

    await page.waitForTimeout(4_000);
    const cartText = await page.locator('body').innerText();
    const productConfirmed = /FCP-1110W|Fullcount Jeans 1110|Fullcount.*1110/i.test(cartText);
    const cartContext = /買い物かご|ショッピングカート|cart|商品をかごに追加/i.test(cartText);
    const sizeConfirmed = /(?:サイズ|SIZE|Size)\s*[:：]?\s*33\b|\b33\b/.test(cartText);
    result.w33.cart_confirmed = productConfirmed && cartContext && sizeConfirmed;
    result.w33.genuinely_available = result.w33.cart_confirmed;
    await page.screenshot({ path: 'artifacts/page-after-cart.png', fullPage: true });

    if (!result.w33.cart_confirmed) {
      throw new Error('Add to cart was clicked, but the resulting page did not confirm the correct product and size 33');
    }
    result.diagnostics.push('ONE WASH / W33 successfully confirmed in cart');

    result.effective_price_jpy = result.listed_price_jpy - ASSUMED_COUPON_JPY;
    result.jpy_per_gbp = await fetchJpyPerGbp();
    result.effective_price_gbp = Number((result.effective_price_jpy / result.jpy_per_gbp).toFixed(2));
    result.price_trigger_met = result.listed_price_jpy < BASELINE_JPY;
    result.gbp_trigger_met = result.effective_price_gbp < GBP_TRIGGER;
    result.alert_triggered = result.w33.genuinely_available && (result.price_trigger_met || result.gbp_trigger_met);
  } catch (error) {
    result.error = error.stack || error.message;
    try { await page.screenshot({ path: 'artifacts/page-error.png', fullPage: true }); } catch {}
  } finally {
    await fs.writeFile('artifacts/result.json', JSON.stringify(result, null, 2));
    await browser.close();
  }

  console.log(JSON.stringify(result, null, 2));
  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT, [
      `alert_triggered=${result.alert_triggered}`,
      `w33_available=${result.w33.genuinely_available}`,
      `listed_price_jpy=${result.listed_price_jpy ?? ''}`,
      `effective_price_jpy=${result.effective_price_jpy ?? ''}`,
      `jpy_per_gbp=${result.jpy_per_gbp ?? ''}`,
      `effective_price_gbp=${result.effective_price_gbp ?? ''}`,
      `price_trigger_met=${result.price_trigger_met}`,
      `gbp_trigger_met=${result.gbp_trigger_met}`,
      `error_present=${Boolean(result.error)}`
    ].join('\n') + '\n');
  }
}

await main();
