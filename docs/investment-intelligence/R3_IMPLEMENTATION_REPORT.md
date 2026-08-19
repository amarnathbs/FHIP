# R3 — Implementation Report

Status: FINAL (R3)

## Branch / commits

- Base: `b950a48` (R2 final commit, `feature/investment-intelligence-r2-cas-portfolio-truth`, independently FULL PASS as of 2026-08-20).
- Branch: `feature/investment-intelligence-r3-fhip-publishing`, created via `git checkout b950a48 -b feature/investment-intelligence-r3-fhip-publishing`.
- R3 commit: `e90325b` — "feat(investment-intelligence-r3): FHIP publishing integration + no-double-count core".
- 19 files changed, 2,825 insertions, 46 deletions (against `b950a48`). Zero pre-existing files deleted; zero pre-existing test files modified.

## What was built

1. **Migration `0042_ii_r3_fhip_publishing_bridge.sql`** — economic-position identity + full lineage on `ii_fhip_publications`; source markers (`source_type`, `ii_publication_id`, `pre_publication_manual_snapshot`, etc.) on `investments`/`assets`/`retirement_accounts`; the relaxed/corrected uniqueness fix (see `R3_ARCHITECTURE_EXCEPTION.md`); the DB-level one-active-publication-per-position guarantee; extended audit-event vocabulary. Additive only — every ALTER either adds a nullable/defaulted column or replaces one constraint with a strict superset / an equivalent narrower-scoped partial index.
2. **`lib/services/investment-intelligence/publicationLogic.ts`** — pure, DB-free decision logic (routing re-export, ITEM/OWNER/COST BASE/RISK BAND/ANNUAL CONTRIBUTION mapping, eligibility gate, duplicate detection, financial impact, refresh ordering, cross-border currency preview, idempotency key). 100% unit-testable without a database — this is deliberate, given the sandbox's DB-migration-application constraint.
3. **`lib/services/investment-intelligence/investmentPublicationService.ts`** — `InvestmentPublicationService`: `checkEligibility`, `buildPreview`, `publishPosition`, `refreshPosition`, `unpublishPosition`, `republishPosition`. Compensating-state atomicity, idempotency-key short-circuit.
4. **7 new/modified API routes** under `app/api/investment-intelligence/positions/[id]/{eligibility,preview,publish,refresh}` and `app/api/investment-intelligence/publications/{route,[id]/unpublish,[id]/republish}` — bounded, one operation each, all authenticated + RLS-scoped.
5. **Direct-edit protection** — `app/api/investments/[id]/route.ts` PATCH/DELETE now reject attempts to modify protected fields or archive a published row outside the II lifecycle.
6. **Minimal UI** — a "Publish to FHIP" preview/confirm flow added to `InvestmentIntelligenceClient.tsx`; a source badge + locked protected fields added to the shared `FinancialDataGrid.tsx` (scoped to `source_type='investment_intelligence_published'` rows only — zero behaviour change for the other 6 registers this component also renders).
7. **106 new tests** across 4 files (`tests/unit/iiR3*.test.ts`) — see `R3_TESTING_AND_VERIFICATION.md`.
8. **11 documentation files** — this report plus the 10 others listed in `R3_ACCEPTANCE_REPORT.md`.

## A real bug found and fixed during implementation

The first version of `detectDuplicateCandidates()` did not require institution to match as a structural signal, only owner+category — a unit test built directly from the spec's own section-32 worked example (Institution A/500,000 vs Institution B/520,000, same owner, same category) failed, because value-proximity + owner + category alone cleared the match threshold, incorrectly flagging two genuinely different investments as a duplicate. The fix — requiring institution match whenever both sides know it, falling back to approximate-value only when institution is unknown — is now the implemented, tested behaviour. This is documented in detail in `R3_DUPLICATE_RESOLUTION_SPEC.md` section 2 and demonstrates the testing discipline the brief asked for: a real defect caught by a real test, not merely a designed-to-pass assertion.

## What was deliberately NOT built (scope firewall, spec section 84)

No XIRR/CAGR/TWRR, no benchmark/alpha/beta/Sharpe/Sortino, no rolling returns, no SIP benchmark analytics, no X-ray/stock overlap/sector concentration, no tax/exit-load/TER calculations, no Monte Carlo, no recommendations/portfolio optimisation, no adviser workflows, no dedicated India II report, no second forecast/goal engine. Confirmed by direct review of every new file — none references any of these concepts.
