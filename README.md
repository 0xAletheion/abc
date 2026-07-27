# Rakuten Fullcount 1110 W33 Watch

This repository uses Playwright and GitHub Actions to inspect the rendered Rakuten product page for Fullcount 1110/1110W in size 33.

## Rules

- Product: https://item.rakuten.co.jp/realmoon/1110w/
- Baseline listed price: ¥30,580
- Assumed coupon deduction: ¥1,000 on every run
- W33 available only when the rendered size-33 tile has a solid border, no `×`, no `売り切れ`, and an active purchase control
- Alert when W33 is available and either:
  - listed price is below ¥30,580; or
  - `(listed price - ¥1,000)` converts to below £135 using the retrieved GBP/JPY rate

## Evidence

Every run uploads:

- full-page screenshot before interaction
- screenshot after cart interaction where possible
- `result.json` with price, W33 state, FX rate, trigger calculations and diagnostics

Qualifying deals create or update a GitHub issue titled **Fullcount 1110 W33 deal available**. Parsing/runtime failures create or update **Rakuten monitor needs attention**.

The workflow runs hourly at minute 17 and can also be started manually from the Actions tab.
