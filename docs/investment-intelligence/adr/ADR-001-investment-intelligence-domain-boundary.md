# ADR-001: Investment Intelligence Domain Boundary

## Status
Accepted (R0)

## Context
Investment Intelligence is a new, large FHIP module (statement ingestion, holdings reconciliation, analytics, tax, X-ray, goal linkage, reporting, adviser collaboration — 15 eventual capabilities per the R0 spec). Existing FHIP already has Assets, Investments, Retirement, Goals and Forecasting modules that partially overlap in subject matter (`R0_CURRENT_STATE_DISCOVERY.md`). Without an explicit boundary, Investment Intelligence risks either duplicating existing calculation logic (a second net-worth or forecasting engine) or becoming so entangled with existing registers that it can't evolve independently (e.g. adding a CAS parser without touching `computeDashboard()`).

## Decision
Investment Intelligence is a domain **sitting beside** Assets/Investments/Retirement/Goals/Forecasting, with exactly one write path into the rest of FHIP: the publishing layer (`R0_FHIP_PUBLISHING_CONTRACT.md`). It owns everything upstream of publication (source documents, transactions, holdings, tax lots, analytics, insights) and nothing downstream of it (net worth calculation, goal engine, forecasting engine all remain untouched and canonical elsewhere). See `R0_DOMAIN_ARCHITECTURE.md` for the full responsibility table (A–M).

## Alternatives considered
1. **Investment Intelligence as a standalone app/service** — rejected per spec's own framing ("Investment Intelligence is NOT a standalone application") and because it would duplicate auth, RLS, and household concepts already solved in FHIP.
2. **Investment Intelligence embedded directly inside the existing `investments` table/module** (extend `investments` with import-related columns rather than a separate schema) — rejected because it would conflate a summary/publishing surface with a full provenance-tracked ledger, directly violating design principle 3, and would make the manual-entry path and the imported path inseparable, undermining "must never overwrite original source evidence" (principle 6).
3. **A single flat schema with no publishing boundary** (Investment Intelligence tables feed Dashboard/Forecasting directly) — rejected because it would require rewriting `computeDashboard()`, every forecast calculator, and `reportSections.ts` to understand a second set of tables, a large, high-risk, unnecessary change given those functions already work correctly against the existing registers (`R0_CURRENT_STATE_DISCOVERY.md` section 8).

## Consequences
- Positive: `computeDashboard()`, Forecasting, Reports, and Goals require **zero code changes** to support Investment Intelligence (`R0_FORECASTING_CONTRACT.md`, `R0_GOAL_INTEGRATION_CONTRACT.md`).
- Positive: Investment Intelligence can evolve its own ingestion/analytics pipeline independently without risking the stability of existing, tested modules.
- Negative: introduces an explicit publish/reconcile step rather than instant end-to-end automation — an imported statement does not appear in Dashboard until it clears the publishing gate (deliberate, since publishing blocks on unmapped owners, per `R0_FHIP_PUBLISHING_CONTRACT.md`).
- Negative: two "logical" investment records can transiently exist (a canonical `ii_*` position and its published `investments` row) — mitigated by the single-target-per-position dedup mechanism (`R0_NET_WORTH_DEDUP_CONTRACT.md`).

## Migration implications
No existing table is altered by this decision alone; all new `ii_*` tables are additive. The only touch point on an existing table is the (nullable, additive) linkage from `ii_fhip_publications.published_row_id` to `investments`/`assets`/`retirement_accounts` — no schema change is required on those tables themselves for this ADR (columns needed for publishing metadata, if any, are deferred to `R1_IMPLEMENTATION_SPEC.md`).

## Testing implications
Baseline regression (`R0_TESTING_AND_VERIFICATION.md` section A) must remain green throughout, since this ADR implies zero source changes to existing calculation code. R1's acceptance gate must include a design/integration test proving a published position reaches `computeDashboard()`'s net worth exactly once (`R0_NET_WORTH_DEDUP_CONTRACT.md` section 3).
