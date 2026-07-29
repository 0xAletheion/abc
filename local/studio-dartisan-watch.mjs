import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CDP_ENDPOINT = process.env.RAKUTEN_CDP_ENDPOINT || 'http://127.0.0.1:9222';
const ARTIFACT_DIR = path.join(ROOT, 'artifacts-local');
const RESULT_FILE = path.join(ARTIFACT_DIR, 'result.json');
const HISTORY_FILE = path.join(ARTIFACT_DIR, 'history.ndjson');
const STATE_FILE = path.join(ARTIFACT_DIR, 'studio-watch-state.json');
const KEEP_ITEM = process.env.RAKUTEN_KEEP_ITEM === '1';

const WATCHES = [
  {
    id: 'studio-dartisan-8173-l-white',
    name: "Studio D'Artisan 8173 white size L",
    url: 'https://item.rakuten.co.jp/barbizon/sd8173/?variantId=r-sku00000003',
    productPattern: /(?:STUDIO\s+D['’´]?\s*ARTISAN|ステュディオ.*ダルチザン).*8173|\b8173\b/i,
    size: 'L',
    sizeIndex: 2,
    sizeCount: 5,
    colour: 'white',
    colourAliases: ['white', 'ホワイト'],
    colourIndex: 0,
    colourCount: 1
  },
  {
    id: 'studio-dartisan-8186-m',
    name: "Studio D'Artisan 8186 size M",
    url: 'https://item.rakuten.co.jp/auc-americanbass/10018065/',
    productPattern: /(?:STUDIO\s+D['’´]?\s*ARTISAN|ステュディオ.*ダルチザン).*8186|\b8186\b/i,
    size: 'M',
    sizeIndex: 0,
    sizeCount: 4,
    colour: null,
    colourAliases: [],
    colourIndex: null,
    colourCount: null
  }
];

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseYen(text) {
  return [...String(text).matchAll(/(?:¥|￥)?\s*([0-9]{1,3}(?:,[0-9]{3})+)\s*(?:円|circle|yen)?/gi)]
    .map(match => Number(match[1].replaceAll(',', '')))
    .filter(Number.isFinite);
}

function parseQuantity(text) {
  const match = String(text).match(/(?:quantity|数量|個数)\s*[:：]?\s*(\d+)/i);
  return match ? Number(match[1]) : null;
}

async function bodyText(page) {
  return await page.locator('body').innerText().catch(() => '');
}

async function screenshot(page, name, result) {
  try {
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, `${name}.png`),
      fullPage: true,
      timeout: 12_000
    });
  } catch (error) {
    result.diagnostics.push(`Screenshot skipped (${name}): ${error.message}`);
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function openProduct(page, watch, result) {
  await page.goto(watch.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(4_000);
  const text = await bodyText(page);
  if (/Reference\s*#18\.|Access Denied|request rejected/i.test(text)) {
    throw new Error('Rakuten returned its Reference #18 security-block page.');
  }
  if (!watch.productPattern.test(text)) {
    throw new Error('Rendered product identifier was not found.');
  }
}

async function extractPrice(page) {
  const text = await bodyText(page);
  const prices = parseYen(text).filter(value => value >= 1_000 && value <= 200_000);
  const frequencies = new Map();
  for (const value of prices) frequencies.set(value, (frequencies.get(value) || 0) + 1);
  return [...frequencies.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function sizeHeadingPattern(size) {
  const value = escapeRegExp(size);
  return new RegExp(
    `(?:商品サイズ|Product\\s*size|SIZE)\\s*[:：]\\s*(?:(?:サイズ|Size)\\s*)?${value}(?:\\s|$)`,
    'i'
  );
}

function colourHeadingPattern(aliases) {
  if (!aliases?.length) return null;
  const values = aliases.map(escapeRegExp).join('|');
  return new RegExp(`(?:COLOR|カラー|色)\\s*[:：]\\s*(?:${values})(?:\\s|$)`, 'i');
}

async function selected(page, watch, kind) {
  const text = (await bodyText(page)).replace(/\s+/g, ' ');
  return kind === 'size'
    ? sizeHeadingPattern(watch.size).test(text)
    : colourHeadingPattern(watch.colourAliases).test(text);
}

async function waitSelected(page, watch, kind, timeout = 7_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await selected(page, watch, kind)) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

async function exactHeadingBox(page, kind) {
  const patterns = kind === 'size'
    ? [
        /^(?:商品サイズ|Product\s*size|SIZE)\s*[:：]\s*(?:未選択|Not selected|Unselected)$/i,
        /^(?:商品サイズ|Product\s*size|SIZE)\s*[:：]/i
      ]
    : [
        /^(?:COLOR|カラー|色)\s*[:：]\s*(?:未選択|Not selected|Unselected)$/i,
        /^(?:COLOR|カラー|色)\s*[:：]/i
      ];

  for (const pattern of patterns) {
    const candidates = page.getByText(pattern);
    let best = null;
    let bestArea = Infinity;
    for (let index = 0; index < await candidates.count(); index++) {
      const candidate = candidates.nth(index);
      try {
        if (!await candidate.isVisible()) continue;
        const text = String(await candidate.innerText()).replace(/\s+/g, ' ').trim();
        if (!pattern.test(text)) continue;
        const box = await candidate.boundingBox();
        if (!box) continue;
        const area = box.width * box.height;
        if (area < bestArea) {
          best = candidate;
          bestArea = area;
        }
      } catch {}
    }
    if (best) {
      await best.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      return await best.boundingBox();
    }
  }
  return null;
}

async function detectTileRow(page, headingBox, expectedCount, result, kind) {
  const row = await page.evaluate(({ headingBox, expectedCount }) => {
    const collectRoots = () => {
      const roots = [document];
      for (let i = 0; i < roots.length; i++) {
        for (const element of roots[i].querySelectorAll('*')) {
          if (element.shadowRoot && !roots.includes(element.shadowRoot)) roots.push(element.shadowRoot);
        }
      }
      return roots;
    };

    const rects = [];
    for (const root of collectRoots()) {
      for (const element of root.querySelectorAll('*')) {
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;

        const rect = element.getBoundingClientRect();
        if (rect.width < 70 || rect.width > 300 || rect.height < 38 || rect.height > 190) continue;
        if (rect.top < headingBox.y + headingBox.height + 4 || rect.top > headingBox.y + headingBox.height + 230) continue;
        if (rect.left < headingBox.x - 35) continue;

        const border =
          parseFloat(style.borderTopWidth || '0') +
          parseFloat(style.borderRightWidth || '0') +
          parseFloat(style.borderBottomWidth || '0') +
          parseFloat(style.borderLeftWidth || '0');
        const outline = parseFloat(style.outlineWidth || '0');
        if (border <= 0 && outline <= 0) continue;

        const text = String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
        if (text.length > 220) continue;

        rects.push({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          text
        });
      }
    }

    const unique = [];
    for (const item of rects) {
      if (unique.some(other =>
        Math.abs(other.x - item.x) < 3 &&
        Math.abs(other.y - item.y) < 3 &&
        Math.abs(other.width - item.width) < 4 &&
        Math.abs(other.height - item.height) < 4
      )) continue;
      unique.push(item);
    }

    const groups = [];
    for (const item of unique) {
      let group = groups.find(entry => Math.abs(entry.y - item.y) < 14);
      if (!group) {
        group = { y: item.y, items: [] };
        groups.push(group);
      }
      group.items.push(item);
    }

    const scored = groups.map(group => {
      const items = group.items
        .sort((a, b) => a.x - b.x)
        .filter((item, index, array) => index === 0 || item.x - (array[index - 1].x + array[index - 1].width) > -20);
      const countDistance = Math.abs(items.length - expectedCount);
      const startDistance = items.length ? Math.abs(items[0].x - headingBox.x) : 10_000;
      return { items, score: countDistance * 1_000 + startDistance };
    }).filter(group => group.items.length >= expectedCount);

    scored.sort((a, b) => a.score - b.score);
    return scored[0]?.items.slice(0, expectedCount) ?? null;
  }, { headingBox, expectedCount });

  if (row) {
    result.diagnostics.push(
      `${kind} tile row detected: ${row.map(item => `${Math.round(item.x)},${Math.round(item.y)},${Math.round(item.width)}x${Math.round(item.height)}`).join(' | ')}`
    );
  }
  return row;
}

async function clickTargetTile(page, watch, kind, result) {
  if (await selected(page, watch, kind)) {
    result.diagnostics.push(`${kind} already confirmed selected.`);
    return true;
  }

  const index = kind === 'size' ? watch.sizeIndex : watch.colourIndex;
  const count = kind === 'size' ? watch.sizeCount : watch.colourCount;
  const value = kind === 'size' ? watch.size : watch.colour;

  const heading = await exactHeadingBox(page, kind);
  if (!heading) {
    result.diagnostics.push(`Could not locate the ${kind} heading.`);
    return false;
  }

  const row = await detectTileRow(page, heading, count, result, kind);
  if (row?.[index]) {
    const tile = row[index];
    const x = tile.x + tile.width / 2;
    const y = tile.y + tile.height / 2;
    await page.mouse.move(x, y, { steps: 10 });
    await page.mouse.click(x, y, { delay: 120 });
    result.diagnostics.push(`Clicked ${kind} ${value} at detected tile centre ${Math.round(x)},${Math.round(y)}.`);
    if (await waitSelected(page, watch, kind)) return true;
    result.diagnostics.push(`Detected-row click did not confirm ${kind} ${value}; trying calibrated geometry.`);
  } else {
    result.diagnostics.push(`No reliable ${kind} tile row found; using calibrated geometry.`);
  }

  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const gap = 14;
  const maximumRowWidth = count * 180;
  const rowWidth = Math.min(viewport.width - heading.x - 24, maximumRowWidth);
  const tileWidth = (rowWidth - gap * (count - 1)) / count;
  const x = heading.x + index * (tileWidth + gap) + tileWidth / 2;

  for (const offset of [62, 76, 90]) {
    const y = heading.y + heading.height + offset;
    await page.mouse.move(x, y, { steps: 10 });
    await page.mouse.click(x, y, { delay: 120 });
    result.diagnostics.push(`Geometry-clicked ${kind} ${value} at ${Math.round(x)},${Math.round(y)}.`);
    if (await waitSelected(page, watch, kind, 2_500)) return true;
  }

  return false;
}

async function clickPurchase(page, result) {
  const candidates = page.locator('button,[role="button"],a').filter({
    hasText: /購入手続きへ|Proceed to purchase|Purchase procedure/i
  });

  let best = null;
  let bestArea = -1;
  for (let index = 0; index < await candidates.count(); index++) {
    const candidate = candidates.nth(index);
    try {
      if (!await candidate.isVisible() || !await candidate.isEnabled()) continue;
      const box = await candidate.boundingBox();
      if (!box) continue;
      const area = box.width * box.height;
      if (area > bestArea) {
        best = candidate;
        bestArea = area;
      }
    } catch {}
  }

  if (!best) return false;
  await best.scrollIntoViewIfNeeded();
  const box = await best.boundingBox();
  if (!box) return false;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y, { steps: 10 });
  await page.mouse.click(x, y, { delay: 120 });
  result.purchase_button_clicked = true;
  result.diagnostics.push(`Clicked 購入手続きへ at ${Math.round(x)},${Math.round(y)}.`);
  return true;
}

function sizeConfirmationPattern(size) {
  const value = escapeRegExp(size);
  return new RegExp(
    `(?:SIZE|サイズ|商品サイズ|Product\\s*size)\\s*[:：]?\\s*(?:(?:サイズ|Size)\\s*)?${value}(?:\\s|$)`,
    'i'
  );
}

function colourConfirmationPattern(aliases) {
  if (!aliases?.length) return null;
  return new RegExp(`(?:COLOR|カラー|色)\\s*[:：]?\\s*(?:${aliases.map(escapeRegExp).join('|')})(?:\\s|$)`, 'i');
}

async function waitOutcome(context, productPage, watch, result) {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    const productText = (await bodyText(productPage)).replace(/\s+/g, ' ');
    if (/この商品は売り切れです|This product is sold out/i.test(productText)) {
      result.sold_out_message_seen = true;
      result.status = 'unavailable';
      result.diagnostics.push('Target was selected and purchase was attempted; Rakuten displayed the sold-out message.');
      return { status: 'unavailable', page: productPage };
    }

    for (const page of context.pages()) {
      let hostname = '';
      try { hostname = new URL(page.url()).hostname; } catch {}
      if (hostname === 'item.rakuten.co.jp') continue;

      const text = (await bodyText(page)).replace(/\s+/g, ' ');
      const product = watch.productPattern.test(text);
      const size = sizeConfirmationPattern(watch.size).test(text);
      const colour = !watch.colour || colourConfirmationPattern(watch.colourAliases).test(text);
      const quantity = parseQuantity(text);

      if (product && size && colour && Number.isInteger(quantity) && quantity >= 1) {
        result.confirmation_page_opened = true;
        result.product_confirmed = true;
        result.size_confirmed = true;
        result.colour_confirmed = true;
        result.quantity = quantity;
        result.quantity_confirmed = true;
        result.genuinely_available = true;
        result.status = 'available';
        result.diagnostics.push(`Basket confirmation: product=true, size=true, colour=${colour}, quantity=${quantity}.`);
        return { status: 'available', page };
      }
    }

    await productPage.waitForTimeout(400);
  }

  throw new Error('After 購入手続きへ, neither a sold-out outcome nor a valid basket confirmation appeared.');
}

async function removeItem(page, result) {
  const candidates = [
    page.getByRole('button', { name: /Delete|削除する|削除/i }),
    page.getByText(/^(?:Delete|削除する|削除)$/i)
  ];
  for (const candidate of candidates) {
    for (let index = 0; index < await candidate.count(); index++) {
      const item = candidate.nth(index);
      try {
        if (!await item.isVisible() || !await item.isEnabled()) continue;
        await item.click();
        result.diagnostics.push('Removed verified Studio D’Artisan item from the basket.');
        return;
      } catch {}
    }
  }
  result.diagnostics.push('Could not remove the verified Studio D’Artisan item.');
}

function notifyWindows(title, body, url) {
  const scriptPath = path.join(ROOT, 'local', 'notify.ps1');
  const child = spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    '-Title', title, '-Body', body, '-Url', url
  ], { detached: true, stdio: 'ignore' });
  child.unref();
}

async function checkWatch(context, page, watch, previous) {
  const result = {
    id: watch.id,
    name: watch.name,
    url: watch.url,
    target_size: watch.size,
    target_colour: watch.colour,
    alert_mode: 'stock',
    checked_at: new Date().toISOString(),
    listed_price_jpy: null,
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
    await openProduct(page, watch, result);
    result.listed_price_jpy = await extractPrice(page);
    if (!result.listed_price_jpy) throw new Error('Live listed price could not be extracted.');

    const sizeSelected = await clickTargetTile(page, watch, 'size', result);
    result.selection.size_selected = sizeSelected;
    if (!sizeSelected) throw new Error(`size ${watch.size} could not be selected or confirmed.`);

    if (watch.colour) {
      const colourSelected = await clickTargetTile(page, watch, 'colour', result);
      result.selection.colour_selected = colourSelected;
      if (!colourSelected) throw new Error(`colour ${watch.colour} could not be selected or confirmed.`);
    }

    await screenshot(page, `${watch.id}-selected`, result);

    const purchaseClicked = await clickPurchase(page, result);
    if (!purchaseClicked) throw new Error('購入手続きへ could not be clicked.');

    const outcome = await waitOutcome(context, page, watch, result);
    if (outcome.status === 'available') {
      result.qualifies = true;
      result.alert_triggered = !KEEP_ITEM && previous?.status !== 'available';
      if (result.alert_triggered) {
        notifyWindows(
          `${watch.name} is in stock`,
          `${watch.name} was confirmed in the Rakuten basket with quantity ${result.quantity}. Listed price ¥${result.listed_price_jpy.toLocaleString('en-GB')}.`,
          watch.url
        );
      }

      if (KEEP_ITEM) {
        result.diagnostics.push('Verified item retained for the visible test run.');
      } else {
        await removeItem(outcome.page, result);
      }
    }
  } catch (error) {
    result.status = result.status === 'unavailable' ? 'unavailable' : 'error';
    result.error = error.stack || error.message;
    await screenshot(page, `${watch.id}-error`, result);
  }

  return result;
}

function fullcountWatchFromBase(base) {
  return {
    id: 'fullcount-1110-w33',
    name: 'Fullcount 1110W W33',
    url: base.product_url || 'https://item.rakuten.co.jp/realmoon/1110w/',
    target_size: '33',
    target_colour: 'ONE WASH',
    alert_mode: 'price',
    checked_at: base.checked_at,
    listed_price_jpy: base.listed_price_jpy ?? null,
    assumed_coupon_jpy: base.assumed_coupon_jpy ?? 1_000,
    effective_price_jpy: base.effective_price_jpy ?? null,
    jpy_per_gbp: base.jpy_per_gbp ?? null,
    effective_price_gbp: base.effective_price_gbp ?? null,
    price_trigger_met: base.price_trigger_met ?? false,
    gbp_trigger_met: base.gbp_trigger_met ?? false,
    alert_triggered: base.alert_triggered ?? false,
    selection: {
      size_selected: base.w33?.size_selected ?? false,
      colour_selected: base.w33?.colour_selected ?? false
    },
    purchase_button_clicked: base.w33?.purchase_button_clicked ?? false,
    sold_out_message_seen: base.w33?.sold_out_message_seen ?? false,
    confirmation_page_opened: base.w33?.confirmation_page_opened ?? false,
    product_confirmed: base.w33?.product_confirmed ?? false,
    colour_confirmed: base.w33?.colour_confirmed ?? false,
    size_confirmed: base.w33?.size_confirmed ?? false,
    quantity: base.w33?.quantity ?? null,
    quantity_confirmed: base.w33?.quantity_confirmed ?? false,
    genuinely_available: base.w33?.genuinely_available ?? false,
    status: base.w33?.status ?? (base.error ? 'error' : 'unknown'),
    diagnostics: base.diagnostics ?? [],
    error: base.error ?? null
  };
}

async function main() {
  await fs.mkdir(ARTIFACT_DIR, { recursive: true });

  const base = await readJson(RESULT_FILE, {});
  const state = await readJson(STATE_FILE, {});
  const nextState = { ...state };
  const studioResults = [];

  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    const context = browser.contexts()[0];
    if (!context) throw new Error('Chrome exposed no browser context through CDP.');
    const page = context.pages().find(item => /rakuten\.co\.jp/i.test(item.url())) || context.pages()[0] || await context.newPage();

    for (const watch of WATCHES) {
      const watchResult = await checkWatch(context, page, watch, state[watch.id]);
      studioResults.push(watchResult);
      nextState[watch.id] = {
        checked_at: watchResult.checked_at,
        status: watchResult.status,
        genuinely_available: watchResult.genuinely_available,
        listed_price_jpy: watchResult.listed_price_jpy
      };
    }
  } catch (error) {
    for (const watch of WATCHES.slice(studioResults.length)) {
      studioResults.push({
        id: watch.id,
        name: watch.name,
        url: watch.url,
        target_size: watch.size,
        target_colour: watch.colour,
        alert_mode: 'stock',
        checked_at: new Date().toISOString(),
        listed_price_jpy: null,
        genuinely_available: false,
        status: 'error',
        diagnostics: [],
        error: error.stack || error.message
      });
    }
  }

  if (!KEEP_ITEM) {
    await fs.writeFile(STATE_FILE, JSON.stringify(nextState, null, 2));
  }

  const fullcount = fullcountWatchFromBase(base);
  base.environment = 'ordinary-chrome-cdp-three-watch-v5';
  base.watches = [fullcount, ...studioResults];
  base.alert_triggered = Boolean(base.alert_triggered || studioResults.some(item => item.alert_triggered));

  const errors = [
    fullcount.error ? `${fullcount.name}: ${String(fullcount.error).split('\n')[0]}` : null,
    ...studioResults.filter(item => item.error).map(item => `${item.name}: ${String(item.error).split('\n')[0]}`)
  ].filter(Boolean);
  base.error = errors.length ? errors.join(' | ') : null;

  await fs.writeFile(RESULT_FILE, JSON.stringify(base, null, 2));
  await fs.appendFile(HISTORY_FILE, `${JSON.stringify(base)}\n`);
  console.log(JSON.stringify(base, null, 2));
  process.exitCode = base.error ? 1 : 0;
}

await main();
