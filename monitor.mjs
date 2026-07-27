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
  j