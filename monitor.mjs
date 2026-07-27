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
    border_style: null,
    has_cross: null,
    has_sold_out_text: null,
    selectable: false,
    purchase_control_active: false,
    cart_confirmed: false,
    genuinely_available: false,
    tile_text: null
  },
  diagnostics: [],
  error: null
};

function parseYen(text) {
  const matches = [...text.matchAll(/(?:¥|￥)?\s*([0-9]{1,3}(?:,[0-9]{3})+)\s*(?:円|circle)?/g)];
  return matches.map(m => Number(m[1].replaceAll(',', ''))).filter(Number.isFinite);
}

async function fetchJpyPerGbp() {
  const sources = [
    {
      name: 'open.er-api.com',
      url: 'https://open.er-api.com/v6/latest/GBP',
      read: data => data?.rates?.JPY
    },
    {
      name: 'frankfurter.app',
      url: 'https://api.frankfurter.app/latest?from=GBP&to=JPY',
      read: data => data?.rates?.JPY
    }
  ];

  for (const source of sources) {
    try {
      const response = await fetch(source.url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const rate = Number(source.read(data));
      if (Number.isFinite(rate) && rate > 0) {
        result.diagnostics.push(`FX source: ${source.name}`);
        return rate;
      }
    } catch (error) {
      result.diagnostics.push(`FX source failed (${source.name}): ${error.message}`);
    }
  }
  throw new Error('Unable to retrieve a valid GBP/JPY rate');
}

async function clickIfVisible(locator, description) {
  try {
    if (await locator.first().isVisible({ timeout: 3_000 })) {
      await locator.first().click({ timeout: 5_000 });
      result.diagnostics.push(`Clicked ${description}`);
      return true;
    }
  } catch (error) {
    result.diagnostics.push(`Could not click ${description}: ${error.message}`);
  }
  return false;
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

    // Price: anchor around the product number first, then use the sticky purchase panel as fallback.
    const priceCandidates = await page.evaluate(() => {
      const clean = value => (value || '').replace(/\s+/g, ' ').trim();
      const all = [...document.querySelectorAll('body *')];
      const candidates = [];
      for (const el of all) {
        const text = clean(el.innerText);
        if (!text || text.length > 400) continue;
        if (/30,580/.test(text) || /\d{1,3}(?:,\d{3})\s*円/.test(text)) {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          candidates.push({
            text,
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            color: style.color,
            fontSize: style.fontSize
          });
        }
      }
      return candidates;
    });

    const preferredPriceTexts = priceCandidates
      .filter(c => /30,580|\d{1,3}(?:,\d{3})\s*円/.test(c.text))
      .map(c => c.text);
    const prices = preferredPriceTexts.flatMap(parseYen).filter(p => p >= 10_000 && p <= 100_000);
    const frequency = new Map();
    for (const price of prices) frequency.set(price, (frequency.get(price) || 0) + 1);
    const ranked = [...frequency.entries()].sort((a, b) => b[1] - a[1]);
    result.listed_price_jpy = ranked[0]?.[0] ?? null;
    if (!result.listed_price_jpy) throw new Error('Could not extract the live listed yen price');
    result.diagnostics.push(`Listed price extracted: ¥${result.listed_price_jpy.toLocaleString('en-GB')}`);

    // Select colour first if needed.
    await clickIfVisible(page.getByText('ONE WASH', { exact: true }), 'ONE WASH');
    await page.waitForTimeout(1_000);

    // Find the smallest clickable/interactive element whose own visible text starts with size 33.
    const size33 = page.locator('button, label, [role="button"], li, div').filter({ hasText: /^\s*33(?:\s|$)/ }).filter({
      hasNot: page.locator('button, label, [role="button"], li, div').filter({ hasText: /\b(?:28|29|30|31|32|34|36|38)\b/ })
    });

    let tile = null;
    const count = await size33.count();
    for (let i = 0; i < count; i++) {
      const candidate = size33.nth(i);
      try {
        const box = await candidate.boundingBox();
        const text = (await candidate.innerText()).trim();
        if (box && box.width >= 50 && box.width <= 400 && box.height >= 30 && box.height <= 250 && /^33(?:\s|$)/.test(text)) {
          tile = candidate;
          break;
        }
      } catch {}
    }

    if (!tile) throw new Error('Could not identify the rendered size 33 tile');
    result.w33.found = true;
    result.w33.tile_text = (await tile.innerText()).trim();

    const tileState = await tile.evaluate(el => {
      const style = getComputedStyle(el);
      const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
      const disabled = el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true';
      return {
        borderStyle: style.borderTopStyle || style.borderStyle,
        text,
        disabled,
        pointerEvents: style.pointerEvents,
        cursor: style.cursor
      };
    });

    result.w33.border_style = tileState.borderStyle;
    result.w33.has_cross = /[×✕✖]/.test(tileState.text);
    result.w33.has_sold_out_text = /売り切れ/.test(tileState.text);
    result.w33.selectable = tileState.borderStyle === 'solid' && !result.w33.has_cross && !result.w33.has_sold_out_text && !tileState.disabled && tileState.pointerEvents !== 'none';
    result.diagnostics.push(`W33 tile: border=${tileState.borderStyle}, cross=${result.w33.has_cross}, soldOut=${result.w33.has_sold_out_text}`);

    if (result.w33.selectable) {
      await tile.click({ timeout: 5_000 });
      await page.waitForTimeout(1_000);
    }

    const addToCart = page.getByText(/Add to cart|買い物かごに入れる|かごに追加/i).first();
    const proceed = page.getByText(/Proceed to purchase|購入手続きへ|ご購入手続きへ/i).first();
    let purchaseActive = false;
    for (const control of [addToCart, proceed]) {
      try {
        if (await control.isVisible({ timeout: 2_000 }) && await control.isEnabled()) {
          purchaseActive = true;
          break;
        }
      } catch {}
    }
    result.w33.purchase_control_active = purchaseActive;

    // Confirm cart only through Add to cart; never click Proceed to purchase.
    if (result.w33.selectable && purchaseActive) {
      try {
        if (await addToCart.isVisible({ timeout: 2_000 }) && await addToCart.isEnabled()) {
          await addToCart.click({ timeout: 8_000 });
          await page.waitForTimeout(3_000);
          const postCartText = await page.locator('body').innerText();
          result.w33.cart_confirmed = /買い物かご|cart/i.test(postCartText) && /33/.test(postCartText);
          await page.screenshot({ path: 'artifacts/page-after-cart.png', fullPage: true });
        }
      } catch (error) {
        result.diagnostics.push(`Cart test inconclusive: ${error.message}`);
      }
    }

    result.w33.genuinely_available = result.w33.selectable && result.w33.purchase_control_active;

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
    const output = [
      `alert_triggered=${result.alert_triggered}`,
      `w33_available=${result.w33.genuinely_available}`,
      `listed_price_jpy=${result.listed_price_jpy ?? ''}`,
      `effective_price_jpy=${result.effective_price_jpy ?? ''}`,
      `jpy_per_gbp=${result.jpy_per_gbp ?? ''}`,
      `effective_price_gbp=${result.effective_price_gbp ?? ''}`,
      `price_trigger_met=${result.price_trigger_met}`,
      `gbp_trigger_met=${result.gbp_trigger_met}`,
      `error_present=${Boolean(result.error)}`
    ].join('\n') + '\n';
    await fs.appendFile(process.env.GITHUB_OUTPUT, output);
  }
}

await main();
