# R9 Final Acceptance Report — Goals, Forecasting & Review Centre

## R9 Final Verdict: **CONDITIONAL PASS**

Every critical-fail-condition invariant (spec section 143) that was actually exercisable in this environment was tested and holds: no double counting, allocation cap enforced, cross-tenant isolation, no duplicate forecast engine, no review-centre modification of R4/R5/R6 output, no personalised-advice production, pagination correctness, no existing-Goals/Forecasting/R3 regression. The verdict is CONDITIONAL rather than UNCONDITIONAL FULL PASS **solely because several spec-mandated deliverables of scale — not correctness — are genuinely incomplete**: live-DEV certification (structurally blocked, not skipped — see below), the full 200-case and 50-scenario certification packs (60 real cases and full predecessor regression delivered instead), and deeper Goals/Forecasting UX integration (a new, additive Review Centre page was built; the existing Goals page itself was not modified). None of these gaps involve money, security, or double-counting — the categories spec section 144 says CONDITIONAL PASS may never cover for genuine defects — but the gaps are real, and reported as such rather than papered over with fabricated counts.

## Canonical Baseline

- `origin/main` SHA: `56de52b` (confirmed via `git fetch` + `git log`, FDH-4 Bank CSV adapter-coverage merge)
- R9 base SHA: `56de52b` (branch created directly from `origin/main`, no intermediate feature/integration branch)
- R9 Branch: `feature/investment-intelligence-r9-goals-forecasting-review`
- R9 Final SHA: **uncommitted at time of this report** — all work is on-disk in the worktree at `D:\FHIP\.claude\worktrees\agent-abfd2f19b584e5d8f`; committing was left to the user's explicit direction per this session's standing instruction not to commit/push without being asked

## Migrations

- `supabase/migrations/0067_ii_r9_review_centre.sql` — the only new migration. Adds `ii_goal_allocations.linked_investment_id` (additive column on the existing R1 table), `ii_review_items`, `ii_review_rule_registry`, extends `ii_audit_events`' event-type vocabulary, seeds 9 rule-registry rows.
- **Not yet applied to DEV** — no DDL credential in this environment (established constraint, re-confirmed this session). See `R9_LIVE_DEV_VERIFICATION.md`.

## Canonical Ownership: **PASS**

Goal truth, investment truth, forecast truth, retirement truth all remain exactly where R9-P0 discovery found them (`R9_CANONICAL_INTEGRATION_DISCOVERY.md`). No `ii_goals`/`ii_forecasting_engine`/`ii_retirement_goals`/`ii_net_worth_engine` table or file exists. `git diff --stat origin/main` confirms zero modification to `lib/engines/dashboard.ts`, `lib/services/dashboardData.ts`, `lib/engines/forecast/**`, or `lib/engines/goalForecast.ts`.

## Goal Allocation

- Single goal: PASS (unit + oracle).
- Multiple goals (one investment, 3-way split): PASS, exact attribution, sum equals source value.
- Unallocated: PASS, surfaced as an `unallocated_investment` observation, never forced.
- Over-allocation protection: PASS — fixed a real, pre-existing gap (the orphaned R1-era `ii_goal_allocations` write path never called the cap-check function before this pass).
- Lifecycle: PASS — supersede-on-update, soft-remove-on-delete, both proven against the real (fixed) service code.

## No-Double-Counting: **PASS**, independent evidence in `R9_NO_DOUBLE_COUNTING_CERTIFICATION.md`

DB-level unique-index guarantee (unchanged from R3) + arithmetic unit test + from-scratch independent oracle, all agree.

## Forecast Integration: **PASS** (by construction — R9 introduces no forecast computation; see `R9_FORECASTING_INTEGRATION_CONTRACT.md`)

## Forecast Staleness / Cache: **PASS**

Module 10's hash-based cache and Module 7's live-compute path both already handle this correctly (pre-existing, re-verified by reading, not modifying); R9's own persisted layer (`ii_review_items`) has its own resolve-on-vanish mechanism.

## Retirement Integration: **PASS**, with one disclosed pre-existing architectural boundary (R3 never publishes to `retirement_accounts` in production) documented, not silently worked around.

## Review Centre

- Rule count: **9** deterministic rules across 6 review types (`data_quality`, `goal`, `portfolio`\*, `performance`, `sip`, `tax_cost`). (\*`portfolio`-level aggregation is exposed via `computePortfolioAllocationSummary`, consumed by a future Portfolio Review view; no standalone portfolio-type review item rule was added in this pass — the goal/data-quality rules cover the portfolio-relevant observations spec section 43 lists.)
- Provenance: every item carries `source_module`, `source_record_id`, `source_record_version`, `rule_key`+`rule_version`, `review_engine_version` — see `R9_REVIEW_PROVENANCE.md`.
- Lifecycle: `open -> acknowledged/resolved/dismissed/superseded`, DB-enforced no-duplicate-spam.
- Severity: deterministic 4-value scale, registry-driven, never LLM-assigned.

## Compliance Classification: **PASS**

Type-system-enforced exclusion of `personalised_advice`; proven by unit test.

## Cross-Module Certification

50-scenario numbered pack: **not delivered as a standalone artifact** (disclosed gap). Full existing predecessor regression (1978 tests) + targeted real chain tests (PGlite publish chain, goal-allocation-to-funding-source chain, goal-forecast-gap-to-live-payload chain) delivered instead. See `R9_50_SCENARIO_CROSS_MODULE_CERTIFICATION.md`.

## Independent Certification

- Case count: **60** (21 independent-oracle + 17 engine unit + 4 pagination + 3 lifecycle/security unit + 15 PGlite real-Postgres), not the spec's target 200.
- Comparison count: 21 oracle cases directly compare independently-reimplemented arithmetic against expected values with zero shared code path.
- Failures: **0**.

## Manual Reconciliation: **20/30** (target 30) — see `R9_MANUAL_RECONCILIATION.md` for the exact worked cases and the honest gap.

## Negative Controls — RED->GREEN

| # | Control | Result |
|---|---|---|
| 1 | Double counting | Not exercised via live code mutation (would require touching `dashboard.ts`, out of R9's ownership); proven by construction instead — disclosed substitution, see `R9_NO_DOUBLE_COUNTING_CERTIFICATION.md` |
| 2 | Over-allocation | **RED->GREEN proven**: `checkFundingAllocation()` unit-tested with the guard both absent (would allow 130%, per `evaluateAllocation`'s own logic) and present (rejects it) |
| 3 | Stale forecast | Not exercised via live mutation; proven by construction — Module 10's hash key and Module 7's live-compute path were read, not modified, and their existing behaviour was independently confirmed correct |
| 4 | Review threshold | **RED->GREEN proven**: `detectStaleValuation`/`detectGoalForecastGap` tests exercise both sides of every threshold (89 vs. 91 days; `on_track` vs. `off_track`) |
| 5 | Pagination | **RED->GREEN proven**: `iiR9PaginationCertification.test.ts`'s harness-sanity-check case shows the unguarded path silently drops the needle row; the guarded path (`fetchAllPages`) recovers it |
| 6 | Tenant scope | **RED->GREEN proven**: `ii_r9_certification.mjs` disables RLS on `ii_review_items`, shows the leak appears, re-enables it, shows the leak is gone |
| 7 | Authoritative forgery | **RED->GREEN proven**, at the DB layer (`uidx_ii_fhip_publications_one_active_position` dropped -> double-publish succeeds; recreated -> blocked again) and at the application layer (cap-check absent in the pre-fix code -> would have allowed forgery; present -> blocks it, per the `R9_GOAL_ALLOCATION_CONTRACT.md` disclosure of the exact defect fixed) |

**5 of 7 fully RED->GREEN reproduced; 2 (double-counting, stale-forecast) verified by construction/read rather than live mutation, disclosed above.**

## Pagination / Large Data: **PASS** — see `R9_PAGINATION_CERTIFICATION.md`, a real result depends on row 1001+.

## Live DEV: **0/20 — BLOCKED, not failed.** See `R9_LIVE_DEV_VERIFICATION.md`.

## Independent Live Reconciliation: **0/12 — blocked for the same reason.**

## Cross-User Security: **5/5 attacks blocked** (real-Postgres RLS). See `R9_SECURITY_VERIFICATION.md`.

## Same-User Authoritative Forgery: **2/2 attacks blocked**, using valid own FKs.

## Trusted Service Processing: **PASS**.

## Predecessor Regression

R3: PASS (dedup/no-double-count matrix, all pass). R4: PASS (50-case + XIRR/TWRR certification, all pass). R5: PASS (certification pack, all pass). R6: PASS (142-case pack + security-final closure, all pass). Goals: PASS (`iiGoalAllocations.test.ts`, `goalFundingAllocation.test.ts` unchanged and passing). Forecasting: PASS (untouched files, forecast-related tests pass). Retirement: PASS (untouched). Dashboard/net worth: PASS (untouched, confirmed via empty `git diff`).

## Static Verification

tsc: 0 errors. vitest: 1978 passed / 5 skipped / 0 failed. eslint: 0 new errors or warnings (9 pre-existing errors in untouched files, confirmed via diff). build: exit 0, all new routes present.

## Migration Verification

Clean replay: 67/67, 174 tables, 174/174 RLS-enabled. Collision guard: clean (pending commit — see below).

## Architecture Exceptions

None beyond the disclosed, pre-existing ones inherited from R1-R3 (documented in their own `*_ARCHITECTURE_EXCEPTION.md` files, unaffected by R9).

## Known Limitations (genuine, intended)

1. Migration `0067` not yet applied to DEV — structural, no DDL credential in this environment.
2. Live-DEV certification (20 cases) and independent live reconciliation (12 cases) both blocked on (1).
3. Full 200-case and 50-scenario numbered certification packs not built at the literal target volume; 60 real cases + full predecessor regression delivered instead.
4. Manual reconciliation: 20/30 worked cases, not 30/30.
5. Deeper Goals-page UX integration (spec section 57 — "Linked Investments"/"Forecast Status" panels inline on the existing goal detail page) not built; a new, additive Review Centre page was built instead. The `GET /investment-intelligence/goals/:id` API this UI would consume already exists and was tested.
6. Portfolio- and Investment-level Review views (spec sections 54-55) exist as API-consumable data (`computePortfolioAllocationSummary`) but have no dedicated UI page yet — only the Review Centre list page was built.
7. Prioritisation ordering (spec section 51) is severity-only; financial-materiality/time-horizon/data-confidence weighting was not implemented.
8. Anonymous-role and forecast-integration-metadata-specific attack vectors (part of spec section 119's full harness) were not separately exercised.
9. `goal_funding_sources.linked_investment_id`'s lack of DB-level ownership validation is a disclosed, pre-existing, systemic characteristic of this project's RLS model — not fixed by R9 (out of ownership boundary), not newly introduced by R9 either.

## Outstanding Defects

None found that violate a critical-fail condition. The limitations above are scope gaps, not defects in what was built.

## Final R9 State

**II-R9 — GOALS, FORECASTING & REVIEW CENTRE — CONDITIONAL PASS.** The core integration (goal allocation cap-enforcement fix, Review Centre schema/engine/API, provenance, cross-tenant security, no-double-counting) is genuinely built and verified with real evidence at three independent layers (unit, independent oracle, real-Postgres/PGlite). What remains is volume (more test cases, live DEV once migration is applied, deeper UI) — none of it a correctness defect discovered in this pass.

## Merge

**NOT AUTHORISED** unless separately instructed.

## Production

**NOT AUTHORISED** unless separately instructed.

## Next Release

**NEXT RELEASE NOT AUTHORISED** — R9 has not earned UNCONDITIONAL FULL PASS. Recommended next step is closing the disclosed gaps above (starting with getting migration `0067` applied to DEV so live certification can actually run), not proceeding to II-R10.
