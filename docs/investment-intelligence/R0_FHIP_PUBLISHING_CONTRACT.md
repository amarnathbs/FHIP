# R0 — FHIP Publishing Contract

Status: FINAL (R0)
Depends on: `R0_CURRENT_STATE_DISCOVERY.md` (section 4 — confirms every field below against live code), `R0_CANONICAL_DATA_CONTRACT.md`

## 1. What "publishing" means

Publishing is the **only** mechanism by which an Investment Intelligence canonical position becomes visible in the existing FHIP Investments screen (and, through `computeDashboard()`, in Dashboard/Reports/Forecasting). It is implemented as one `ii_fhip_publications` row per canonical position mapping onto exactly one `investments`/`assets`/`retirement_accounts` row (`R0_CANONICAL_DATA_CONTRACT.md`). The existing Investments/Assets/Retirement grids remain, unmodified, "summary/publishing surfaces, not a second independent transaction ledger" (design principle 3) — a published row looks, to `computeDashboard()`, `reportSections.ts`, and `forecastData.ts`, exactly like any manually-entered row, because it *is* a row in the same table, just one whose lifecycle is now driven by Investment Intelligence rather than direct user typing.

## 2. Field-by-field mapping

Confirmed against live code (`lib/grid/configs.ts`'s `investmentGridConfig`, `lib/validation/investment.ts`, `app/api/investments/route.ts`) — not assumed.

### ITEM
**Source**: canonical investment asset class / user-facing category, derived from `ii_instruments.instrument_class` (`R0_CANONICAL_DATA_CONTRACT.md`) mapped to the existing `master_financial_items` catalogue's `investment` category (`R0_CURRENT_STATE_DISCOVERY.md` section 2.1) — e.g. India Mutual Fund → `managed_funds` master item, consistent with the catalogue key `dashboard.ts`'s `MASTER_INVESTMENT_ITEM_TO_BUCKET` and `investmentCalculator.ts`'s `MASTER_ITEM_TO_ASSET_CLASS` already resolve. **This choice is deliberate, not incidental**: publishing into the *existing* `master_item_key` vocabulary, rather than inventing a parallel "Item" label scheme, is what keeps a published row correctly bucketed by every engine that already keys off `master_item_key` (`R0_CURRENT_STATE_DISCOVERY.md` section 8, section 11) with zero engine changes.

### OWNER
**Source**: canonical legal/household owner — `ii_accounts.owner_member_id` (once confirmed) resolved to a `household_members.id`, published into `investments.owner`. **Publishing must be blocked** (position stays in `ii_fhip_publications.status != 'published'`, surfaced as an actionable "needs owner confirmation" item, never silently defaulted to `'self'`) if the source/legal owner on the statement cannot be safely mapped to an existing FHIP household member. This is a hard gate, not a warning — `investments.owner` has a `not null default 'self'` constraint today (`R0_CURRENT_STATE_DISCOVERY.md` section 4), so an unmapped owner must never reach the point of an INSERT at all.

### INSTITUTION
**Source**: provider / AMC / investment institution — `ii_accounts.institution_name`, published into `investments.institution` (a plain nullable text column today, confirmed in schema). Portfolio-level aggregation (a rollup view, not a per-row publish) may show "Multiple AMCs" when one logical portfolio spans several published rows — this is a display concern for a future release's portfolio summary UI, not a publishing-time transformation of the per-row `institution` value itself.

### CURRENT VALUE
**Source**: latest certified `ii_holding_snapshots` row for the position, published into `investments.current_value`. Must carry (in `ii_fhip_publications`, not by inventing new columns on `investments`) the snapshot's `as_of_date`, its `source_document_id` (or NAV-refresh source), and `quality_status` (`certified|warning|incomplete`). A `warning`/`incomplete` snapshot may still publish (so the user isn't blocked from seeing an approximate value) but must be visibly flagged wherever `investments.current_value` is displayed — an R1 UI decision, not an R0 schema one.

### COST BASE
**Source**: remaining canonical cost basis, aggregated from open `ii_tax_lots` for the position, published into `investments.cost_base` (nullable numeric today — confirmed, `R0_CURRENT_STATE_DISCOVERY.md` section 4). Must carry a confidence status (derived from whether the tax-lot history is complete back to the account's opening, or truncated because the earliest statement available doesn't reach the true acquisition date). **Where lot history is incomplete, cost base must publish as `null`, never as a guessed value** — `investments.cost_base` is already nullable and `dashboard.ts`'s `investmentUnrealisedGain` calculation already falls back to `cost_base ?? current_value` (i.e. zero unrealised gain) when null, so this is the existing, safe, already-tested behaviour for "we don't know the cost base," not a new fallback that needs inventing.

### ANNUAL CONTRIBUTION
**Meaning**: planned ongoing annual contribution — **not** automatically equal to historical twelve-month cash flow reconstructed from `ii_transactions`. A recurring SIP detected in the transaction ledger may *suggest* a value (surfaced as a system-suggested default the user can accept or override), but `investments.annual_contribution` is published only from the user's confirmed forward-looking plan. This matters concretely because `investmentCalculator.ts`'s forecast (`R0_CURRENT_STATE_DISCOVERY.md` section 7) uses `monthlyContribution` to project *forward* — silently equating a historical SIP total with a forward plan would misrepresent a SIP the user has already paused or intends to change.

### RISK PROFILE
**Source**: this field must be semantically separated from the user's personal risk tolerance (a concept that, per discovery, does not currently exist anywhere as a distinct stored attribute — no "risk tolerance" column was found on `user_profiles` or elsewhere). Publish using the concept **Investment Risk / Risk Band**, derived from `ii_instruments.instrument_class` and, where available, category-level volatility reference data — into the existing `investments.risk_profile` enum (`conservative|balanced|growth|high_growth|unknown`, confirmed in schema). `unknown` is the correct published value, not a guess, whenever the instrument's risk band cannot be derived.

### COUNTRY/MARKET
**Source**: `ii_instruments.country_of_domicile` / `ii_accounts.country_code`, published into `investments.country_code`. India: `IN` (matches the existing seeded `countries` row exactly — `R0_CURRENT_STATE_DISCOVERY.md` section 7).

### CURRENCY
**Source**: `ii_holding_snapshots.currency_code` (the position's own source-country currency, never pre-converted — `R0_CROSS_BORDER_CONTRACT.md`), published into `investments.currency_code`. Indian local portfolio: `INR`.

### SOURCE / LAST UPDATED
**Source**: linked metadata surfaced from `ii_fhip_publications`/`ii_source_documents`/`ii_holding_snapshots`, displayed alongside the published row (not stored as new free columns on `investments` — this is a join-time display concern). Example: "Imported via Investment Intelligence — Last reconciled/valued: [`ii_holding_snapshots.as_of_date`] — Quality: [`quality_status`]." A manually-entered `investments` row (no `ii_fhip_publications` row referencing it) simply shows no such badge, preserving today's behaviour exactly.

### GOAL LINKS
One investment position may support no goal, one goal, or multiple goals — via `ii_goal_allocations`, which keeps `goal_funding_sources.linked_investment_id` (the existing, live goal-linkage mechanism) in sync rather than duplicating the investment (`R0_GOAL_INTEGRATION_CONTRACT.md`).

## 3. Publication is not automatic entry into the ledger

A published `investments` row does **not** become a second transaction ledger. All corrections, refreshes, and reconciliation happen upstream in `ii_transactions`/`ii_holding_snapshots`/`ii_reconciliation_cases`; publishing re-runs (produces a new `ii_fhip_publications` row / updates the existing one's `last_republished_at`) to push a corrected value down into the same `investments.id` row. The user may still directly edit a published `investments` row through the existing grid UI (that capability is not removed — design principle 3 says these screens remain "summary/publishing surfaces," not that they become read-only); such a manual edit is recorded as a **user correction layered on top of** the certified canonical record, never as a mutation of the original source evidence (`R0_SOURCE_PROVENANCE_CONTRACT.md`), and a subsequent republish must reconcile rather than silently clobber the user's edit — the exact mechanism (last-write-wins with a warning vs. a merge prompt) is an R1 UX decision, flagged as an open item in `R0_ACCEPTANCE_REPORT.md`.
