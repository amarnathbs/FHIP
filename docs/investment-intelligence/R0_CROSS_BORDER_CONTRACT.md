# R0 — Cross-Border Contract

Status: FINAL (R0)
Depends on: `R0_CURRENT_STATE_DISCOVERY.md` (section 8 — `reportingValue()`/`convertToReportingCurrency()` verified), `R0_NET_WORTH_DEDUP_CONTRACT.md` (scenario 9)

## 1. Principle

Investment Intelligence keeps source-country values. FHIP's existing cross-border/household services remain solely responsible for household base-currency translation (design principle, spec Section 12). Investment Intelligence must never overwrite an INR source value merely because the household's reporting currency is AUD.

## 2. What every canonical position carries

Per `R0_CANONICAL_DATA_CONTRACT.md`'s cross-cutting conventions, every money-bearing Investment Intelligence entity (`ii_accounts`, `ii_transactions`, `ii_holding_snapshots`, `ii_prices_nav`) carries:

- `country_code` — the instrument/account's jurisdiction.
- `currency_code` — the position's own **source** currency, always the currency the source document/statement was denominated in. Never converted at ingestion, never converted at publication.
- (where relevant) `owner_member_id` residency is resolved through the existing `household_members` reference table, not duplicated as a new field — Investment Intelligence reads residency where a downstream rule needs it, it does not own that concept.
- Local tax-status context — deferred entirely to the India adapter's future tax-rule reference data (`ii_tax_rule_versions`), never baked into the core position record; not populated in R0/R1 (no tax analytics built).

## 3. How this actually reaches household base-currency treatment

Traced against live code (`R0_CURRENT_STATE_DISCOVERY.md` section 8): `computeDashboard()`'s `reportingValue(rowCurrencyCode, amount)` converts a row's own-currency amount to the household's reporting currency **at read/aggregation time**, using `convertToReportingCurrency()` (`lib/engines/fx.ts`), immediately before it enters `totalInvestments`/`totalAssets`/`totalRetirement`/`totalLiabilities` and the allocation chart. Per-country breakdowns (`investmentByCountry`, `assetsByCountry`, `retirementByCountry`) deliberately do **not** go through this conversion — they show source-country values "as recorded," by the existing code's own design (confirmed in `dashboard.ts`'s comments, quoted in the discovery report).

Because publishing (`R0_FHIP_PUBLISHING_CONTRACT.md`) writes `investments.currency_code`/`current_value` as the **unconverted source value** (INR stays INR), this FX behaviour requires **zero changes**: a published Indian mutual fund flows into `totalInvestments` (AUD-equivalent, converted at aggregation time) and into `investmentByCountry` (INR, as recorded) exactly the same way a manually-entered INR investment row already does today. Investment Intelligence does not need its own FX conversion logic for household aggregation — it inherits the existing one for free by publishing into the same table `computeDashboard()` already converts correctly.

## 4. Design test (spec Section 19F)

**Setup**: Indian MF source value = ₹5,00,000 (INR); FHIP household base currency = AUD.

1. `ii_holding_snapshots.value = 500000`, `currency_code = 'INR'` — the certified canonical value, never touched by any AUD conversion.
2. Publishing writes `investments.current_value = 500000`, `investments.currency_code = 'INR'`, `investments.country_code = 'IN'` — identical to the snapshot; no conversion happens at this step either.
3. `computeDashboard()` reads this row, calls `reportingValue('INR', 500000)`, which (per the existing `convertToReportingCurrency()` implementation) divides by the AUD/INR rate to produce the AUD-equivalent figure that is added into `totalInvestments` and, therefore, `netWorth` — this AUD-equivalent number is a **derived, in-memory** value, never written back over the INR source figure.
4. `investmentByCountry` (and any Investment-Intelligence-specific per-position display) continues to show ₹5,00,000 — the preserved INR canonical value.

**Result**: the INR canonical value is preserved exactly as required, while the household AUD net-worth figure reflects it correctly — proven without any new FX code, entirely by publishing into the same table the existing FX-aware aggregation already covers. See `R0_TESTING_AND_VERIFICATION.md` section F for the corresponding test record.

## 5. Scope limits

R0/R1 does not extend country/currency support beyond the two already seeded (`AU`/`AUD`, `IN`/`INR`) — Investment Intelligence's India adapter targets exactly the country FHIP itself already supports as a household jurisdiction. Australia's future adapter (`R0_DOMAIN_ARCHITECTURE.md`) will reuse this identical mechanism without change, since nothing above is India-specific.
