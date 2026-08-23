# R3 — FHIP Field Mapping Spec

Status: FINAL (R3)
Confirmed against live code: `supabase/migrations/0004_financial_data_grid.sql` (column definitions), `lib/validation/investment.ts` (Zod schema), `lib/grid/configs.ts` (`investmentGridConfig`), `lib/engines/dashboard.ts` (`bucketInvestmentType`, `MASTER_INVESTMENT_ITEM_TO_BUCKET`), `lib/engines/forecast/investmentCalculator.ts` (`resolveAssetClass`, `MASTER_ITEM_TO_ASSET_CLASS`) — every mapping below is implemented in `lib/services/investment-intelligence/publicationLogic.ts` and exercised by `tests/unit/iiR3PublicationLogic.test.ts`.

## ITEM

**Source**: `ii_instruments.instrument_class` → `mapInstrumentClassToMasterItemKey()`. R3 production: `mutual_fund → 'managed_funds'` (matches `seed_master_items.sql` row `('investment', 'managed_funds', 'Managed Funds', 40)` exactly). Every other instrument class currently maps to `null` (structural, not yet activated — see `R3_PUBLISHING_ARCHITECTURE.md` section 4). Never the raw CAS scheme name (`ii_instruments.instrument_name`, e.g. "HDFC Flexi Cap Fund - Growth (Direct Plan)") — that value is published separately into `investments.investment_name`, matching how a manual row's free-text name already works.

`investments.investment_type` (the Zod-validated column, `lib/validation/investment.ts`'s 6-value enum) is populated in lockstep via `mapInstrumentClassToInvestmentType()`: `mutual_fund → 'managed_fund'`. This keeps `dashboard.ts`'s `bucketInvestmentType()`/`investmentCalculator.ts`'s `resolveAssetClass()` correctly classifying the row via their secondary signal even in the (R3-unused but tested) case `master_item_key` is unset.

## OWNER — corrects an R0 imprecision (see `R3_ARCHITECTURE_EXCEPTION.md` Exception 1)

**Source**: `ii_accounts.owner_member_id` → `household_members.relationship` → `mapRelationshipToOwner()` → `investments.owner` (the role ENUM the column actually is, confirmed against migration `0004` — **not** a `household_members.id` FK, which the column's type makes structurally impossible).

| `household_members.relationship` | `investments.owner` |
|---|---|
| `self` | `self` |
| `spouse` | `spouse` |
| `partner` | `spouse` (closest existing enum value — documented decision) |
| `child` | `child` |
| `parent` | `other` |
| `other_dependant` | `other` |
| `other` | `other` |

**Blocking rule** (unchanged from R0): if `ii_accounts.owner_member_id` is null (statement holder not yet confirmed against a household member), `evaluateEligibility()` returns `NOT_ELIGIBLE` with `OWNER_UNRESOLVED` — publication never reaches the point of an INSERT, matching `investments.owner`'s `not null default 'self'` constraint never being silently defaulted to.

## INSTITUTION

**Source**: `ii_instruments.amc_name` (migration `0041`'s mutual-fund-variant column) if present, else `ii_accounts.institution_name`, published into `investments.institution` (plain nullable text). R3 publishes one row per canonical position (see Exception 2) — the "Multiple AMCs" aggregated display remains a future portfolio-summary UI concern, not a publishing-time transformation, exactly as `R0_FHIP_PUBLISHING_CONTRACT.md` specified.

## CURRENT VALUE

**Source**: the certified `ii_holding_snapshots.value` for the position, published into `investments.current_value`, **unconverted** (see `R3_CROSS_BORDER_PUBLISHING.md`). Retained alongside on `ii_fhip_publications`: `published_value`, `source_currency`, `source_country`, the snapshot's `as_of_date` (via `canonical_position_id`), and `ii_source_quality_status` on the `investments` row itself (`certified|warning|incomplete`) — so the grid/badge can always show "as of [date], quality [status]" without a stale value silently presenting as today's live figure. A `certified_with_warnings` Portfolio Truth status is allowed to publish (`REVIEW_REQUIRED` in the eligibility gate, not `NOT_ELIGIBLE`) but is visibly flagged.

## COST BASE

**Source**: aggregated `ii_tax_lots.units_remaining × cost_per_unit` across open lots for the position, gated by `resolveCostBaseStatus()`/`resolveCostBaseValue()`:

| Condition | `cost_base_status` | `investments.cost_base` |
|---|---|---|
| No open lots | `not_available` | `null` |
| Open lots, `history_completeness ∈ {complete_from_inception, complete_from_known_opening_balance}` | `certified` | aggregated figure |
| Open lots, `history_completeness ∈ {partial_history, holdings_only}` | `partial` | aggregated figure |
| Open lots, completeness unrecorded | `unknown` | `null` |

Never fabricated/back-solved — `null` publishes exactly where the existing, already-tested `investmentUnrealisedGain = totalInvestments - (cost_base ?? current_value)` fallback (`dashboard.ts`) already treats a null cost base as zero unrealised gain, the same safe behaviour any manual row with no cost base entered already has.

## ANNUAL CONTRIBUTION — the critical rule (spec section 19)

**Source**: `resolveAnnualContribution(confirmedAnnualPlan)` — `investments.annual_contribution` is populated **only** from a value the caller explicitly passes as `confirmedAnnualContribution` on the publish request (i.e. a user-confirmed forward plan surfaced through the UI, never auto-derived). No R3 code path reads `ii_transactions` SIP history to compute this field. When absent, `annual_contribution` publishes as `null` with `annual_contribution_source='none'` — verified by `tests/unit/iiR3PublicationLogic.test.ts`'s "never inferred from history" suite and cross-checked against `investmentPublicationService.ts`'s `publishPosition()`, which never queries `ii_transactions` at all.

## RISK PROFILE

**Source**: `resolveRiskBand(instrumentClass)` — publishes the **investment risk band** (never a personal risk-tolerance concept, which does not exist anywhere in FHIP — confirmed absent from `user_profiles` and every other table in R0 discovery) into the existing `investments.risk_profile` enum. R3 has no certified per-instrument volatility reference data (`ii_analytics_results` is schema-only, unpopulated per `R0_CANONICAL_DATA_CONTRACT.md`) — every instrument class therefore resolves to `'unknown'`, a deliberate, correct value, not a placeholder bug.

## COUNTRY / CURRENCY / SOURCE METADATA

`investments.country_code` ← `ii_accounts.country_code` (India: `IN`). `investments.currency_code` ← `ii_holding_snapshots.currency_code`, **never pre-converted** (India: `INR`) — see `R3_CROSS_BORDER_PUBLISHING.md`. Source/provenance retained on `ii_fhip_publications` (not new free columns on `investments`, matching R0's own instruction): `canonical_position_id`, `source_document` lineage (reachable via `ii_holding_snapshots.source_document_id`), last-certified date, publication date, `cost_base_status`, quality status.

## GOAL LINKS

Unchanged from R0/R1 — R3 does not modify `ii_goal_allocations` or `goal_funding_sources` sync logic (`R0_GOAL_INTEGRATION_CONTRACT.md`). See `R3_NO_DOUBLE_COUNT_CERTIFICATION.md` question 8.
