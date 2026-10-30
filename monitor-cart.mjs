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
    selected: false,
    modern_cart_button_clicked: false,
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
    await page.screenshot({ path: `artifacts/${name}.png`, timeout: 8_000 });
  } catch (error) {
    result.diagnostics.push(`Screenshot skipped (${name}): ${error.message}`);
  }
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
  throw new Error('Unable to retrieve a live GBP/JPY rate');
}

async function clickFirstUsable(locator, description) {
  const count = await locator.count();
  for (let index = 0; index < count; index++) {
    const candidate = locator.nth(index);
    try {
      if (!await candidate.isVisible() || !await candidate.isEnabled()) continue;
      await candidate.click({ timeout: 8_000 });
      result.diagnostics.push(`Clicked ${description}`);
      return true;
    } catch (error) {
      result.diagnostics.push(`${description} candidate ${index + 1} failed: ${error.message}`);
    }
  }
  return false;
}

async function selectW33(page) {
  await clickFirstUsable(page.getByText('ONE WASH', { exact: true }), 'ONE WASH');
  await page.waitForTimeout(800);

  const candidates = [
    page.locator('input[value="33"]'),
    page.locator('button[value="33"]'),
    page.locator('[data-value="33"]'),
    page.getByRole('button', { name: /^\s*33(?:\s|$)/ }),
    page.locator('label').filter({ hasText: /^\s*33(?:\s|$)/ })
  ];

  for (const candidate of candidates) {
    if (await clickFirstUsable(candidate, 'size 33')) return true;
  }
  return false;
}

async function clickModernAddToCart(page) {
  const labels = page.getByText(/^(?:Add to cart|かごに追加|買い物かごに入れる)$/i);
  const count = await labels.count();

  for (let index = 0; index < count; index++) {
    const label = labels.nth(index);
    try {
      if (!await label.isVisible()) continue;

      const metadata = await label.evaluate(element => {
        const action = element.closest('button,[role="button"],a,input[type="submit"],input[type="button"]');
        return {
          label: (element.textContent || '').trim(),
          actionTag: action?.tagName || null,
          actionText: (action?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
          actionClass: action?.className || null,
          disabled: Boolean(action?.disabled) || action?.getAttribute('aria-disabled') === 'true'
        };
      });
      result.diagnostics.push(`Cart candidate ${index + 1}: ${JSON.stringify(metadata)}`);
      if (metadata.disabled) continue;

      const parentButton = label.locator('xpath=ancestor::button[1]');
      if (await parentButton.count()) {
        await parentButton.click({ force: true, timeout: 8_000 });
      } else {
        const parentRoleButton = label.locator('xpath=ancestor::*[@role="button"][1]');
        if (await parentRoleButton.count()) {
          await parentRoleButton.click({ force: true, timeout: 8_000 });
        } else {
          await label.evaluate(element => {
            const action = element.closest('button,[role="button"],a,input[type="submit"],input[type="button"]') || element;
            action.click();
          });
        }
      }

      result.diagnostics.push(`Force-clicked modern Add to cart candidate ${index + 1}`);
      return true;
    } catch (error) {
      result.diagnostics.push(`Modern cart candidate ${index + 1} failed: ${error.message}`);
    }
  }
  return false;
}

async function openBasket(page) {
  const candidates = [
    page.getByRole('link', { name: /Shopping basket|買い物かご|ショッピングカート/i }),
    page.locator('a').filter({ hasText: /Shopping basket|買い物かご|ショッピングカート/i }),
    page.locator('a[href*="basket" i],a[href*="cart" i]')
  ];

  for (const locator of candidates) {
    const count = await locator.count();
    for (let index = 0; index < count; index++) {
      const link = locator.nth(index);
      try {
        if (!await link.isVisible()) continue;
        const href = await link.getAttribute('href');
        if (href) {
          await page.goto(new URL(href, page.url()).href, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        } else {
          await link.click({ force: true, timeout: 8_000 });
          await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {});
        }
        await page.waitForTimeout(2_000);
        return true;
      } catch (error) {
        result.diagnostics.push(`Basket link candidate ${index + 1} failed: ${error.message}`);
      }
    }
  }
  return false;
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
    await safeScreenshot(page, 'initial');

    const bodyText = await page.locator('body').innerText();
    if (!/FCP-1110W|Fullcount Jeans 1110/i.test(bodyText)) {
      throw new Error('Rendered product identifiers were not found');
    }

    const candidateTexts = await page.evaluate(() => [...document.querySelectorAll('body *')]
      .map(element => (element.innerText || '').replace(/\s+/g, ' ').trim())
      .filter(text => text && text.length <= 400 && (/30,580/.test(text) || /\d{1,3}(?:,\d{3})\s*円/.test(text))));
    const prices = candidateTexts.flatMap(parseYen).filter(price => price >= 10_000 && price <= 100_000);
    const frequencies = new Map();
    for (const price of prices) frequencies.set(price, (frequencies.get(price) || 0) + 1);
    result.listed_price_jpy = [...frequencies.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    if (!result.listed_price_jpy) throw new Error('Live listed price could not be extracted');

    result.w33.selected = await selectW33(page);
    if (!result.w33.selected) throw new Error('Size 33 could not be selected');
    await page.waitForTimeout(1_000);
    await safeScreenshot(page, 'selected-w33');

    result.w33.modern_cart_button_clicked = await clickModernAddToCart(page);
    if (!result.w33.modern_cart_button_clicked) throw new Error('Modern Add to cart button could not be clicked');
    await page.waitForTimeout(4_000);

    result.w33.basket_opened = await openBasket(page);
    if (!result.w33.basket_opened) throw new Error('Shopping basket could not be opened');
    await safeScreenshot(page, 'basket');

    const basketText = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    if (/商品情報が変更されました|product information has changed/i.test(basketText)) {
      throw new Error('Rakuten rejected the cart submission as stale product information');
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

    result.diagnostics.push(`Basket: product=${result.w33.product_confirmed}, colour=${result.w33.colour_confirmed}, size=${result.w33.size_confirmed}, quantity=${result.w33.quantity}`);
    if (!result.w33.genuinely_available) {
      throw new Error('Basket did not confirm FCP-1110W / ONE WASH / size 33 with quantity at least 1');
    }

    result.effective_price_jpy = result.listed_price_jpy - ASSUMED_COUPON_JPY;
    result.jpy_per_gbp = await fetchJpyPerGbp();
    result.effective_price_gbp = Number((result.effective_price_jpy / result.jpy_per_gbp).toFixed(2));
    result.price_trigger_met = result.listed_price_jpy < BASELINE_JPY;
    result.gbp_trigger_met = result.effective_price_gbp < GBP_TRIGGER;
    result.alert_triggered = result.w33.genuinely_available && (result.price_trigger_met || result.gbp_trigger_met);
  } catch (error) {
    result.error = error.stack || error.message;
    await safeScreenshot(page, 'error');
  } finally {
    await fs.writeFile('artifacts/result.json', JSON.stringify(result, null, 2));
    await fs.writeFile('artifacts/page.html', await page.content().catch(() => ''));
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
