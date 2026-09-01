# FDH-16 — Full Integration Architecture

REUSED PRIOR CERTIFIED EVIDENCE (FDH-14/FDH-15 architecture discovery), re-confirmed by fresh source grep this
round (see `FDH16_SCOPE_AND_CERTIFICATION_PLAN.md`'s §247 table for exactly what was re-run).

## The chain, mapped to actual code

```
FINANCIAL DOCUMENT / MANUAL INPUT
  Manual: app/api/{income,expenses,assets,liabilities,investments,retirement}/route.ts
          -> lib/services/registry.ts (makeRegistry().save()/create()) -> direct RLS-scoped insert
  FDH:    app/(app)/financial-data-hub upload surfaces -> FDH-3 storage -> FDH-4/5 CSV/PDF parsers
        ↓
FDH INGESTION / EVIDENCE  (fdh_transactions, fdh_payroll_events, fdh_liability_statements,
                            fdh_investment_statements, fdh_retirement_statements, ...)
        ↓
NORMALISATION / CLASSIFICATION  (lib/financial-data-hub/*, economicTypeEngine.ts — FDH-6)
        ↓
RECONCILIATION  (bank-matching per domain — FDH-9/10/11/12's own matching modules)
        ↓
USER REVIEW  (FDH-7 approval workflow; fhip_import_proposals status machine — FDH-15)
        ↓
PROPOSAL / APPROVED EVIDENCE  (fhip_import_proposals, fhip_import_proposal_fields)
        ↓
COMPARE  (proposal fields vs existing canonical values — client review UI)
        ↓
EXPLICIT USER DECISION  (add_new / update_existing / apply_selected_fields / keep_existing)
        ↓
ATOMIC CANONICAL APPLY  (SECURITY DEFINER RPCs: fdh9_apply_income_proposal, fdh10_apply_liability_proposal,
                          fdh12_apply_retirement_proposal; applyAuStatementActivity.ts/applyAuStatementPosition.ts
                          for AU Investment — typed function, not a generic RPC)
        ↓
CANONICAL FHIP FINANCIAL MODEL  (income_sources, expense_items, assets, liabilities, investments,
                                  retirement_accounts, ii_transactions/ii_holding_snapshots, smsf_funds)
        ↓
CALCULATIONS  (lib/engines/dashboard.ts computeDashboard(); lib/engines/forecast/*)
        ↓
DASHBOARD  (lib/services/dashboardData.ts loadDashboard() -> app/api/dashboard/summary/route.ts)
        ↓
SCORES / DNA / RESILIENCE / TWIN  (lib/engines/{score,dna,resilience,twin}* — fresh grep this round: 0 `fdh_*`
                                     references anywhere in lib/engines/**)
        ↓
FORECASTING  (lib/engines/forecast/* — fresh grep this round: 0 `fdh_*` references)
        ↓
REPORTS / EXPORTS  (lib/services/reportSnapshotResolver.ts — fresh grep this round: reads only canonical
                     tables — user_profiles, households, income_sources, expense_items, assets, liabilities,
                     investments, insurance_policies, goal_snapshots, future_financial_commitments — 0 `fdh_*`)
```

## Fresh finding this round: the universal "FDH never becomes a second financial system" grep

```
grep -rln "fdh_" lib/engines            -> (no matches)
grep -rln "fdh_" lib/engines/forecast   -> (no matches)
grep -n  "fdh_\|from('" lib/services/reportSnapshotResolver.ts -> canonical tables only, 0 fdh_* hits
```

This is a fresh, source-verified, whole-codebase confirmation of spec §15 ("FDH evidence rows counted directly
by downstream modules: 0") across every intelligence/forecast/report engine in one pass, not merely the single
domain (`fdh11Isolation.test.ts`, Investment-only) the existing `vitest` suite already checked (that test is
REUSED evidence, independently re-run this round as part of the full suite — see `FDH16_LIVE_DEV_CERTIFICATION.md`).

## Investment canonical split (a genuine architectural nuance, resolved by REUSED evidence)

`lib/services/dashboardData.ts` reads the **legacy `investments` table** for its `totalInvestments` figure, not
`ii_accounts`/`ii_holding_snapshots` (Investment Intelligence's own richer schema, per FDH-14's canonical
ownership matrix). The bridge between the two is Investment Intelligence's own **publishing** mechanism
(`lib/services/investment-intelligence/investmentPublicationService.ts` — R3's "FHIP publishing + no-double-
counting" certification, UNCONDITIONAL FULL PASS, `c2e447b`, three provenance-loss bugs found+fixed across two
rounds). This round did not re-derive or re-test the publishing mechanism itself (REUSED, not fresh) — it is
flagged here for transparency, not asserted as newly re-proven.
