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
    basket_opened: false,
    product_confirmed: false,
    colour_confirmed: false,
    size_confirmed: false,
    price_confirmed: false,
    quantity: null,
    quantity_confirmed: false,
    cart_confirmed: false,
    genuinely_available: false,
    selector_used: null
  },
  diagnostics: [],
  error: null
};

function parseYen(text) {
  const matches = [...String(text).matchAll(/(?:¥|￥)?\s*([0-9]{1,3}(?:,[0-9]{3})+)\s*(?:円|circle)?/g)];
  return matches.map(m => Number(m[1].replaceAll(',', ''))).filter(Number.isFinite);
}

function parsePositiveInteger(value) {
  const match = String(value ?? '').match(/\d+/);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isInteger(number) && number >= 0 && number <= 99 ? number : null;
}

async function fetchJpyPerGbp() {
  const sources = [
    ['open.er-api.com', 'https://open.er-api.com/v6/latest/GBP', d => d?.rates?.JPY],
    ['frankfurter.app', 'https://api.frankfurter.app/latest?from=GBP&to=JPY', d => d?.rates?.JPY]
  ];

  for (const [name, url, reader] of sources) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const rate = Number(reader(await response.json()));
      if (Number.isFinite(rate) && rate > 0) {
        result.diagnostics.push(`FX source: ${name}`);
        return rate;
      }
    } catch (error) {
      result.diagnostics.push(`FX source failed (${name}): ${error.message}`);
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
        await item.click({ timeout: 8_000 });
        result.diagnostics.push(`Clicked ${description}`);
        return item;
      }
    } catch (error) {
      result.diagnostics.push(`Could not click ${description} candidate ${i + 1}: ${error.message}`);
    }
  }
  return null;
}

async function selectSize33(page) {
  const candidates = [
    ['input[value="33"]', page.locator('input[value="33"]')],
    ['button[value="33"]', page.locator('button[value="33"]')],
    ['[data-value="33"]', page.locator('[data-value="33"]')],
    ['label containing exact 33', page.locator('label').filter({ hasText: /^\s*33(?:\s|$)/ })],
    ['button named 33', page.getByRole('button', { name: /^\s*33(?:\s|$)/ })],
    ['visible text starting 33', page.getByText(/^\s*33(?:\s|$)/)]
  ];

  for (const [name, locator] of candidates) {
    const clicked = await clickFirstVisible(locator, `size 33 via ${name}`);
    if (clicked) return name;
  }
  return null;
}

async function openShoppingBasket(page) {
  const candidates = [
    page.getByRole('link', { name: /Shopping basket|買い物かご|ショッピングカート/i }),
    page.getByText(/Shopping basket|買い物かご|ショッピングカート/i),
    page.locator('a[href*="basket" i], a[href*="cart" i]')
  ];

  for (const locator of candidates) {
    const count = await locator.count();
    for (let i = 0; i < count; i++) {
      const item = locator.nth(i);
      try {
        if (!await item.isVisible() || !await item.isEnabled()) continue;
        await Promise.all([
          page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {}),
          item.click({ timeout: 8_000 })
        ]);
        await page.waitForTimeout(3_000);
        const text = await page.locator('body').innerText();
        if (/Shopping basket|買い物かご|ショッピングカート|Purchase procedure/i.test(text)) {
          result.diagnostics.push('Opened Shopping basket');
          return true;
        }
      } catch (error) {
        result.diagnostics.push(`Shopping basket candidate failed: ${error.message}`);
      }
    }
  }
  return false;
}

async function readBasketQuantity(page) {
  const preferred = page.locator([
    'select[name*="quantity" i]',
    'select[id*="quantity" i]',
    'select[name*="qty" i]',
    'select[id*="qty" i]',
    'input[name*="quantity" i]',
    'input[id*="quantity" i]',
    'input[name*="qty" i]',
    'input[id*="qty" i]'
  ].join(','));

  const broad = page.locator('select, input[type="number"], input[inputmode="numeric"]');
  for (const locator of [preferred, broad]) {
    const count = await locator.count();
    for (let i = 0; i < count; i++) {
      const control = locator.nth(i);
      try {
        if (!await control.isVisible()) continue;
        let raw = await control.inputValue().catch(() => '');
        if (!raw && await control.evaluate(el => el.tagName === 'SELECT')) {
          raw = await control.locator('option:checked').textContent().catch(() => '');
        }
        const quantity = parsePositiveInteger(raw);
        if (quantity !== null) {
          result.diagnostics.push(`Basket quantity read from form control: ${quantity}`);
          return quantity;
        }
      } catch {}
    }
  }

  const text = await page.locator('body').innerText();
  const textMatch = text.match(/(?:quantity|数量|個数)\s*[:：]?\s*(\d+)/i);
  if (textMatch) {
    const quantity = parsePositiveInteger(textMatch[1]);
    if (quantity !== null) {
      result.diagnostics.push(`Basket quantity read from page text: ${quantity}`);
      return quantity;
    }
  }

  const badgeCandidates = page.locator('[aria-label*="basket" i], [aria-label*="cart" i], a[href*="basket" i], a[href*="cart" i]');
  const badgeCount = await badgeCandidates.count();
  for (let i = 0; i < badgeCount; i++) {
    try {
      const textValue = (await badgeCandidates.nth(i).innerText()).trim();
      const quantity = parsePositiveInteger(textValue);
      if (quantity !== null && quantity > 0) {
        result.diagnostics.push(`Basket quantity inferred from basket badge: ${quantity}`);
        return quantity;
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

    const selectorUsed = await selectSize33(page);
    if (!selectorUsed) throw new Error('Could not select size 33 through any rendered control');
    result.w33.found = true;
    result.w33.selection_attempted = true;
    result.w33.selector_used = selectorUsed;
    await page.waitForTimeout(1_500);
    await page.screenshot({ path: 'artifacts/page-after-size33.png', fullPage: true });

    const addToCart = await clickFirstVisible(
      page.getByText(/Add to cart|買い物かごに入れる|かごに追加/i),
      'Add to cart'
    );
    result.w33.purchase_control_active = Boolean(addToCart);
    if (!addToCart) throw new Error('Size 33 was selected, but no active Add to cart control was available');

    await page.waitForTimeout(3_000);
    await page.screenshot({ path: 'artifacts/page-after-add.png', fullPage: true });

    result.w33.basket_opened = await openShoppingBasket(page);
    if (!result.w33.basket_opened) throw new Error('Add to cart was clicked, but the Shopping basket page could not be opened');
    await page.screenshot({ path: 'artifacts/page-basket.png', fullPage: true });

    const basketText = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    result.w33.product_confirmed = /FCP-1110W|Fullcount Jeans 1110|Fullcount.*1110/i.test(basketText);
    result.w33.colour_confirmed = /COLOR\s*[:：]?\s*ONE WASH/i.test(basketText);
    result.w33.size_confirmed = /SIZE\s*[:：]?\s*33\b/i.test(basketText);
    result.w33.price_confirmed = basketText.includes(result.listed_price_jpy.toLocaleString('en-GB'));
    result.w33.quantity = await readBasketQuantity(page);
    result.w33.quantity_confirmed = Number.isInteger(result.w33.quantity) && result.w33.quantity >= 1;

    result.w33.cart_confirmed =
      result.w33.product_confirmed &&
      result.w33.colour_confirmed &&
      result.w33.size_confirmed &&
      result.w33.quantity_confirmed;
    result.w33.genuinely_available = result.w33.cart_confirmed;

    result.diagnostics.push(
      `Basket verification: product=${result.w33.product_confirmed}, colour=${result.w33.colour_confirmed}, size=${result.w33.size_confirmed}, price=${result.w33.price_confirmed}, quantity=${result.w33.quantity}`
    );

    if (!result.w33.cart_confirmed) {
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
