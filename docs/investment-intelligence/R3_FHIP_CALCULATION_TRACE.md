# R3 — FHIP Calculation Trace

Status: FINAL (R3) — spec section 69. Every step below names a real file, function, and DB object; none is hypothetical.

## Full path: canonical II position → net worth

```
1. ii_holding_snapshots row (certified, immutable)
     table: ii_holding_snapshots (migration 0033)
     columns used: id, account_id, instrument_id, as_of_date, value, currency_code, quality_status

2. ii_portfolio_truth_status row (current certification determination)
     table: ii_portfolio_truth_status (migration 0041)
     read by: loadPositionContext() in
              lib/services/investment-intelligence/investmentPublicationService.ts

3. InvestmentPublicationService.publishPosition(userId, positionId, options)
     file: lib/services/investment-intelligence/investmentPublicationService.ts
     calls: evaluateEligibility(), detectDuplicateCandidates(),
            resolveCostBaseStatus/Value(), resolveAnnualContribution(),
            resolveRiskBand(), mapInstrumentClassToMasterItemKey/InvestmentType(),
            mapRelationshipToOwner()
            (all in lib/services/investment-intelligence/publicationLogic.ts)

4. WRITE 1 — investments row (INSERT for a new position, or UPDATE in place
   for a linked-manual-row / refresh)
     table: investments (migration 0003, extended by 0004 and 0042)
     columns written: current_value, currency_code, country_code, institution,
       cost_base, annual_contribution, risk_profile, owner, master_item_key,
       investment_type, source_type='investment_intelligence_published',
       ii_canonical_account_id, ii_canonical_instrument_id,
       ii_source_quality_status

5. WRITE 2 — ii_fhip_publications row (the ONLY entity with a direct FK
   into investments — R0_CANONICAL_DATA_CONTRACT.md section 1)
     table: ii_fhip_publications (migration 0034, extended by 0042)
     columns written: canonical_position_id, account_id, instrument_id,
       publication_target='investments', published_row_id (-> investments.id),
       status='published', published_value, source_currency, source_country,
       idempotency_key
     DB constraint enforcing "exactly once": uidx_ii_fhip_publications_
       one_active_position on (account_id, instrument_id) where status='published'

6. lib/services/dashboardData.ts — loadDashboard(userId)
     query: supabase.from('investments').select(...).eq('user_id', userId)
            .eq('is_active', true)
     (the published row is now indistinguishable, to this query, from any
      manually-entered row — it IS a row in the same table)

7. lib/engines/dashboard.ts — computeDashboard(input, currency, fxRateAudInr)
     line ~514: const totalInvestments = input.investments.reduce(
       (sum, r) => sum + reportingValue(r.currency_code, r.current_value), 0)
     line ~517: const netWorth = totalAssets + totalInvestments +
       totalRetirement - totalLiabilities

8. Dashboard UI / Reports (lib/engines/reportSections.ts,
   lib/engines/reportSectionsPremium.ts) / Forecast calculators
   (lib/engines/forecast/investmentCalculator.ts, netWorthCalculator.ts)
   — ALL READ FROM THE SAME computeDashboard() OUTPUT OR THE SAME
   investments TABLE. ZERO changes made to any of these files in R3.
```

## Exclusion path (what keeps this to exactly once)

```
- A second publish attempt for the SAME snapshot: short-circuited by the
  idempotency_key lookup in publishPosition() before any write; backstopped
  by unique(canonical_position_id) on ii_fhip_publications (migration 0034,
  unchanged).
- A second publish attempt for a DIFFERENT snapshot of the SAME economic
  position while one is already active: blocked at the database level by
  uidx_ii_fhip_publications_one_active_position (migration 0042) — a second
  concurrent INSERT with status='published' for the same (account_id,
  instrument_id) is a constraint violation, not merely an application check.
- A manual row confirmed as the same investment: converted IN PLACE
  (UPDATE, same investments.id) — never a second INSERT
  (investmentPublicationService.ts's publishPosition(), 
  options.linkToExistingInvestmentId branch).
- Unpublish/archive: investments.is_active set to false — excluded from
  step 6's query BEFORE it ever reaches computeDashboard() (no filtering
  logic needed inside the engine itself).
```

## What was NOT touched (verified)

`git diff main --stat -- lib/engines/dashboard.ts lib/engines/forecast/ lib/services/dashboardData.ts lib/engines/reportSections.ts lib/engines/reportSectionsPremium.ts` (run for real, against `main`, exit 0, zero output) confirms **zero lines changed** in any of these files — R3 adds new columns/rows upstream of them and relies entirely on their existing, unmodified read paths, exactly as `R0_NET_WORTH_DEDUP_CONTRACT.md` section 1 designed for.
