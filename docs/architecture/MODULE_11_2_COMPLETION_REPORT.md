# MODULE 11.2 — Deterministic Answer Router & Zero-Cost Response Resolution
## Completion / Certification Report

Branch: `feature/module-11-2-deterministic-answer-router`
Base: `origin/main @ 262feac` (already includes Module 11.0 + 11.1, merged)
Final commit: `9167f9c`
Status: **not merged, not pushed, no production access used**

---

## A. VERDICT

**FULL PASS**

Basis: provider invocation is proven zero across the full 11.2 resolution estate (unit-level non-vacuous negative control + live-DEV non-vacuous negative control); custom quota is proven unchanged across all zero-cost resolution paths (unit + live-DEV, real `ai_usage_ledger` before/after); tenant and cache isolation are proven with real cross-tenant negative controls (unit + live hosted DEV); certification/data-integrity fail-closed behaviour (INVALID/UNAVAILABLE never fabricates a value, STALE discloses a limitation, zero is preserved distinct from missing) is proven at the resolver level and reproduced live against real DEV data.

One item is explicitly **deferred, not failed**: migration `0117`'s own live-DEV proof (RLS/constraints on the new `ai_resolution_audit` table) is PGlite-only (13/13) because the migration has not been applied to any environment yet, per the standing project rule that a migration is certified locally and handed to the Product Owner for manual DEV application. Every other required live-DEV proof in spec section 101 was completed against real hosted DEV without needing that table.

---

## B. GIT

- Branch: `feature/module-11-2-deterministic-answer-router`
- Reconciled base SHA: `262feac` (branch was already at `origin/main`'s tip when reconciliation was checked — `git fetch origin main` showed no advance, so no merge was needed)
- Final SHA: `9167f9c`
- Commits added this pass: 1 (`9167f9c`, 28 files changed, 3667 insertions)
- Pushed: **no**
- Merged: **no**

---

## C. MIGRATION

- Required: **yes** — one new table, `ai_resolution_audit` (a resolution-decision audit trail; see the migration file's own header comment for why every existing Module 11.0/11.1 table was inspected and rejected as a write target first).
- Number: `0117_module11_2_deterministic_answer_router.sql`
- Collision check: `node scripts/check-migration-versions.mjs` (OK, next version 0116 per this branch alone) was explicitly NOT trusted per standing project convention. Cross-branch/worktree/remote scan performed: `D:/fhip-a02-wave2` (on-disk) and `origin/fix/admin-a02-wave2-workflow-ordering-integrity` (pushed to origin) both already hold `0116_admin_a02_wave2_related_reorder_and_scheduling_integrity.sql`. No `0117` exists anywhere else. → `0117` is collision-free.
- DEV application status: **not applied** — authored and certified locally only, per instruction ("hand it to the Product Owner for manual DEV application").
- Production status: **not applied, not attempted.**
- Local certification: PGlite full rebuild from empty, 112 migrations (`0001`...`0117`), **13/13 checks passed** (`scripts/db-rebuild-check/module11_2_resolution_router_cert.mjs`) — table + RLS existence, real tenant isolation with an RLS-disabled negative control, anon zero-visibility (a real bug in the test harness itself — a leftover JWT claim from a prior role switch — was found and fixed before this passed genuinely), service-role-only write privileges, and two structural CHECK constraints (`chk_ai_resolution_audit_no_provider_calls`, `chk_ai_resolution_audit_zero_cost_no_quota`) proven to reject violating rows while a scoped negative control (a `LIVE_AI_REQUIRED` row with `quota_consumed=true`) is correctly accepted.

---

## D. REPOSITORY DISCOVERY

- **Knowledge Base / Resources reused**: yes. `resource_posts` (`content_type='glossary'`) is the sole content source for `KnowledgeBaseAnswerResolver`; no parallel content table was created. A discovery pass confirmed real, compliance-approved glossary rows already exist for net worth, savings rate, debt-to-income/-service ratio, emergency fund, Financial Health Score, Financial Resilience, diversification, superannuation (AU), EPF/PPF/NPS (IN) — "Financial DNA" and "SMSF" are confirmed content gaps (see section G).
- **Canonical metric services reused**: yes, exclusively. `DeterministicAnswerResolver` reads only fields already present in `FinancialContextObject` (Module 11.0's `buildFinancialContextObject()`), which itself wraps the existing certified engines (`loadDashboard`, `loadHealthScore`, `loadFinancialDna`, `loadResilience`, `computeGoalsPagePayload`, `getForecastRunDetail`/`listTwinRuns`/`listReports` families). No financial value is recomputed anywhere in Module 11.2.
- **Cache infrastructure reused**: yes. `ExactCacheResolver` is a thin wrapper over Module 11.1's `lib/ai/cache/answerCache.ts` (`lookupCachedAnswer`/`storeCachedAnswer`) — the exact key scheme (`user_id, intent_code, normalised_question_hash, snapshot_hash, context_version, prompt_version, model_version`) is untouched; 11.2 only supplies the entitlement gate and the intent-scoped `snapshot_hash` derivation.
- **Entitlement integration**: `AIEntitlementService.isPersonalisedAIEligible()` (Module 11.1) gates `STORED_PERSONALISED`/`EXACT_CACHE` for personalised intents; it is never called for deterministic/knowledge-base intents (both a correctness requirement — spec section 52 — and a minor performance optimisation, proven by a unit test asserting the dependency is not invoked).

---

## E. ROUTER ARCHITECTURE

- **Normalisation** (`lib/ai/resolution/normalisation.ts`): trims/case-folds/collapses whitespace, strips harmless conversational framing, applies a small FHIP synonym table, and — critically — extracts negation/why/hypothetical/number/date signals from the ORIGINAL text before any stripping, so meaning is never destroyed by normalisation.
- **Intent mapping** (`intentMatcher.ts` + `intentTaxonomy.ts`): a versioned, code/config intent registry (35 deterministic + 22 knowledge + 3 WHY-explanation + 6 boundary intents) with regex-based free-text matching. No embeddings, no fuzzy scoring; an unmatched question is `null` (UNKNOWN), never guessed.
- **Policy**: `allowed_resolvers` on each `IntentDefinition` is enforced by the router as a hard gate — a resolver may only answer an intent explicitly authorised for it, which is what stops a generic Knowledge Base hit from masquerading as a personalised WHY-answer.
- **Deterministic resolver**: pure field extraction from `FinancialContextObject`, checked against `domain_certification` per intent before trusting the value; STALE answers with a disclosed limitation, INVALID/UNAVAILABLE never answer.
- **Knowledge Base resolver**: its own governance predicate (status ∈ {approved, published}, non-red compliance, amber requires recorded compliance approval, not scheduled in the future, not expired) against `resource_posts`, independent of that table's public-website `visibility` gate (a deliberate, disclosed design decision — see the resolver's own header comment).
- **Stored personalised resolver**: reads `ai_insights.future_ai_explanation`, snapshot-compatibility checked by comparing the insight's recorded `current_value` against the LIVE certified value for that metric.
- **Exact cache resolver**: wraps `ai_answer_cache`, deriving `snapshot_hash` from only the intent's required domain(s) (not the whole context object).
- **LIVE_AI_REQUIRED**: a plain data result (`resolution: 'LIVE_AI_REQUIRED'`, `response: null`) — `router.ts` has no import of `AIModelGateway` or any provider adapter, so a provider call from this module is not just avoided but structurally impossible.

---

## F. DETERMINISTIC INTENT CATALOGUE (35 implemented)

| Intent | Domain | Source |
|---|---|---|
| CURRENT_NET_WORTH, TOTAL_ASSETS, TOTAL_LIABILITIES, LIQUID_ASSETS | `balance_sheet` | `loadDashboard` via `FinancialContextObject.balance_sheet` |
| MONTHLY_GROSS_INCOME, MONTHLY_NET_INCOME, MONTHLY_EXPENSES, ESSENTIAL_EXPENSES, MONTHLY_SURPLUS, SAVINGS_RATE | `cash_flow` | `loadDashboard` via `.cash_flow` |
| FINANCIAL_HEALTH_SCORE, FINANCIAL_HEALTH_BAND | `score` | `loadHealthScore` via `.health_score` |
| DNA_PRIMARY_PROFILE, DNA_SECONDARY_PROFILE | `financial_dna` | `loadFinancialDna` via `.financial_dna` |
| RESILIENCE_STATUS, RESILIENCE_SCORE, EMERGENCY_FUND_MONTHS | `resilience` | `loadResilience` via `.resilience` |
| INVESTMENT_TOTAL, INVESTMENT_DIVERSIFICATION | `investments` | `loadDashboard` via `.investments` |
| RETIREMENT_BALANCE | `retirement` | `loadDashboard` via `.retirement` |
| INSURANCE_DATA_STATUS | `insurance` | `loadDashboard` via `.insurance` |
| GOAL_COUNT, GOALS_ON_TRACK_COUNT, GOALS_AT_RISK_COUNT | `goals` | `computeGoalsPagePayload` via `.goals[].track_status` (counted, not recomputed) |
| FORECAST_LATEST_RUN_DATE | `forecasts` | `forecast_runs` via `.forecasts[0].calculation_date` |
| TWIN_COHORT, TWIN_CONFIDENCE | `financial_twin` | `getTwinRunDetail` via `.financial_twin` |
| REPORT_PERIOD, REPORT_VERSION | `reports` | `reports` table via `.reports[0]` |
| COUNTRIES_PRESENT, CURRENCIES_PRESENT | `cross_border` | `loadDashboard` via `.cross_border` |
| REPORTING_CURRENCY, SNAPSHOT_DATE, DATA_COMPLETENESS, STALE_DATA_AREAS | none (meta/data-quality, always computed) | `.meta` / `.data_quality` |

Not implemented (genuine architecture gaps, disclosed rather than faked): debt-to-income/debt-service ratio (present in `DashboardSummary` but never surfaced into `FinancialContextObject`'s certified schema), a per-scheme retirement breakdown (AU super vs EPF/PPF/NPS — `account_categories` is hard-coded empty upstream), and a certified forecast net-worth PROJECTION value (`major_projected_metrics` is `{}` upstream) — none of these were added to Module 11.0's context object, since Module 11.2's brief is retrieval, not extending Module 11.0's own schema.

---

## G. KNOWLEDGE CATALOGUE

22 intents mapped to glossary terms (`lib/ai/resolution/knowledgeBaseResolver.ts`'s `TERM_MAP`). Live-DEV confirmed present and approved: net worth (global), superannuation (AU), NPS (IN). Discovery-phase confirmed present (not independently re-verified live for every term in this pass): savings rate, debt-to-income ratio, debt-service ratio, emergency fund, Financial Health Score, Financial Resilience, diversification, EPF, PPF (all global/AU/IN as appropriate).

**Confirmed content gaps** (no approved glossary/article item exists today — resolver correctly returns `KNOWLEDGE_NOT_AVAILABLE`, never a fabricated definition):
- `FINANCIAL_DNA_DEFINITION` — "Financial DNA" is an FHIP product-module name, not a Resources glossary term.
- `FINANCIAL_TWIN_DEFINITION` — same reason.
- `SMSF_DEFINITION` — no SMSF glossary entry found during discovery.

Recommended editorial addition: three short glossary entries (Financial DNA, Financial Twin, SMSF) — flagged for the Resources editorial team, not authored here (spec section 67: "do not expand Module 11.2 into a mass content-authoring project").

---

## H. ZERO-COST PROOF

Representative envelopes (live hosted DEV, real synthetic data — see `tests/live-dev/module11_2ResolutionRouterLiveDev.test.ts`):

**DETERMINISTIC** — `CURRENT_NET_WORTH` for a synthetic household with one real $500,000 AUD asset: headline `"Your current net worth is $500,000.00."`, `requires_live_ai: false`, `consumes_custom_quota: false`.

**KNOWLEDGE_BASE** — `NET_WORTH_DEFINITION`: real approved glossary excerpt, `requires_live_ai: false`, `consumes_custom_quota: false`.

**STORED_PERSONALISED / EXACT_CACHE** — a synthetic `RESILIENCE_EXPLANATION` answer stored via `storeExactCacheAnswer()` and re-served on an identical follow-up request, `requires_live_ai: false`, `consumes_custom_quota: false` (unit test `aiResolutionExactCache.test.ts` + live test `C1`).

---

## I. PROVIDER NEGATIVE CONTROL

Non-vacuous, both at unit level and live-DEV level:

1. Direct call: `new MockAIProvider().generateStructured(...)` with a `vi.spyOn` wrapper — spy count goes from 0 to 1. (`aiResolutionRouter.test.ts`, `module11_2ResolutionRouterLiveDev.test.ts` §E2)
2. Reset, then run a 21-item resolution matrix (deterministic hits/misses, knowledge-base hits, blocked/unsupported/scenario classifications, an unmatched free-text question, a compound request) through the real `resolveAnswer()` — spy count remains **0**.

---

## J. QUOTA PROOF

Live hosted DEV (`module11_2ResolutionRouterLiveDev.test.ts` §E1): a real Premium synthetic subject's `ai_usage_ledger` row count was queried before and after running 5 deterministic resolutions + 1 knowledge-base resolution — **0 rows before, 0 rows after**. No `ai_admit_request()` RPC is ever called by the router (confirmed by code inspection: no import of `entitlementService.ts`/`admitAiRequest` anywhere in `lib/ai/resolution/**`).

---

## K. CERTIFICATION PROOF

| Domain state | Deterministic behaviour | Evidence |
|---|---|---|
| CERTIFIED | Answers exactly | unit + live §A1 |
| STALE | Answers, with a disclosed limitation, `confidence: 'MEDIUM'` | unit (`aiResolutionDeterministic.test.ts`) |
| PARTIAL | Answers only if the specific field extracted is non-null | resolver logic (`domainsUsable` + per-field null checks); not independently forced live this pass |
| INVALID | `UNAVAILABLE`, no fabricated value | unit + live §A3 (genuinely UNAVAILABLE via a real zero-data household) |
| UNAVAILABLE | `UNAVAILABLE`, no fabricated value | unit + live §A3 |

---

## L. PRIVACY / ISOLATION

- **Deterministic**: live §A4 — two real synthetic tenants (`alpha`, `beta`) resolve the SAME intent through the SAME code path and get genuinely different, correctly-scoped certified values.
- **Exact cache cross-tenant denial**: live §C2 — `beta` asks the byte-identical question `alpha` has a cached answer for; `beta` gets a miss (real Postgres, real service-role-scoped `WHERE user_id = ...` filter, not merely RLS).
- **Stored-personalised cross-tenant denial**: unit-proven (`aiResolutionStoredPersonalised.test.ts`, mocked at the DB-call boundary with the filter arguments asserted directly).

---

## M. SNAPSHOT INVALIDATION

Live §C3: a cached `RESILIENCE_EXPLANATION` answer for `alpha` is stored; `alpha` then takes on a real new liability through their own JWT (a genuine new snapshot); the SAME cache lookup afterward is a **miss** — the snapshot hash (derived only from the `resilience` domain's certified section + certification) changed because `debt_pressure` (DSR) moved. (First attempt at this test used an additional liquid asset instead of a liability and found — correctly — that a 100%-liquid, debt-free household's resilience section does NOT move when scaled proportionally; the test was corrected to use a mutation that genuinely changes the domain's output, which is itself a useful confirmation that the hash is neither over- nor under-sensitive.)

---

## N. KNOWLEDGE GOVERNANCE

Unit-proven exhaustively (`aiResolutionKnowledgeBase.test.ts`, 13 tests): `draft` excluded, `archived` (retired) excluded, a future-`scheduled_at` item excluded, an expired item excluded, `red` compliance excluded unconditionally, `amber` excluded without a recorded `compliance_approved_at` and served once approved. Live-DEV §B1/§B2 confirm the same predicate against real DEV rows.

---

## O. COUNTRY TESTING

- AU: live §B2 control — an AU-home user asking about superannuation gets it with no limitation note.
- IN: live §B1/§B2 — an India-home user asking about NPS gets it with no limitation; the SAME user asking about superannuation (an explicit, named AU concept) still gets an answer, but with a limitation noting it is an Australian concept (spec section 82's "clearly labelled" requirement) — proven live.
- Cross-border: `COUNTRIES_PRESENT`/`CURRENCIES_PRESENT` intents read the certified `cross_border` domain only; no FX conversion is performed by the router (spec section 44).

---

## P. SAFETY CLASSIFICATION

Unit-proven in `aiResolutionRouter.test.ts`: product-advice ("Which ETF should I buy?") → `BLOCKED`, zero cost; money-movement ("Transfer $10000...") → `BLOCKED`; personalised tax-advice → `BLOCKED`; a hypothetical/scenario question ("What happens if I retire at 60?") → `UNSUPPORTED`/`SCENARIO_REQUEST`, not executed, zero cost; a personalised WHY-question with no available causal driver ("Why is my score only 58?") → `LIVE_AI_REQUIRED` with `response: null` — explicitly NOT a generic definition dressed up as an answer (spec section 106's anti-test, passing).

---

## Q. ANALYTICS

New counters added to `lib/ai/observability/aiMetrics.ts`: `resolver_requests_total`, `resolver_deterministic`, `resolver_knowledge_base`, `resolver_stored_personalised`, `resolver_exact_cache`, `resolver_live_ai_required`, `resolver_blocked`, `resolver_unsupported`, `resolver_unavailable`, `ai_avoided_calls`. Proven by unit test: a personalised deterministic hit increments `ai_avoided_calls`; a non-personalised Knowledge Base hit does NOT (spec section 58's precise denominator distinction). No admin dashboard UI was added this phase (spec section 93 allows reusing existing usage-dashboard patterns; not built here — disclosed as remaining work, not claimed done).

---

## R. PERFORMANCE

Not independently benchmarked with wall-clock timing in this pass (disclosed gap). Structural findings from code inspection, which matter more than a specific millisecond number:
- The router requests only the `ContextDomain`(s) an intent needs via `contextSize.ts`'s `resolveDomainsForMode()` (extended with 30 new intent → domain mappings this phase) — but `buildFinancialContextObject()` itself (Module 11.0, unmodified) computes ALL underlying engine outputs (dashboard, score, DNA, resilience, goals) regardless of `mode`; `mode` only controls which SECTIONS are exposed in the final object. This is a pre-existing Module 11.0 characteristic, not something 11.2 introduces or could safely change without touching certified 11.0 code (out of scope per spec section 75).
- Knowledge Base and boundary-classification intents never call `buildContext` at all (unit-proven).
- Provider invocation count across every code path in this phase: 0 (section I).

---

## S. REGRESSION

- **Focused Module 11 prerequisite gate** (spec section 5): run BEFORE any 11.2 code was written — `npx vitest run tests/unit/ai` → 224/224; `module11_ai_foundation_cert.mjs` → 47/47; `module11_1_entitlement_cert.mjs` → 379/379. No regression gate failure; substantive work proceeded.
- **Post-implementation regression**: `npx vitest run tests/unit/aiResolution* tests/unit/ai` → **299/299** (224 pre-existing + 75 new).
- **11.0 tests**: 47/47 PGlite, unchanged.
- **11.1 tests**: 379/379 PGlite, unchanged.
- **Live-DEV** (Module 11.2's own): 14/14, real hosted DEV, zero residue (`test-artifacts/module11-2-resolution-router-live-cleanup.json`).
- **Modules 1–10 / whole-repo regression**: `npx vitest run` (full suite) — 4845–4848 passed depending on run, with 2-6 failures each run, ALL in unrelated Resources/Admin live-DEV tests (timeouts, RLS errors, count-mismatches) that pass cleanly every time when re-run in isolation. This is disclosed, not hidden: `D:/fhip-fdh13-admin-baseline` and other concurrent agents are actively mutating the SAME shared hosted DEV project's Resources/Admin data while this suite runs, and this project's full-suite run includes several live-DEV-dependent Resources tests with no test-level isolation from concurrent writers. Reproduced twice: different specific tests failed each full run, and every failing test passed when re-run alone. No AI/Module-11 test was ever among the failures.
- **TypeScript**: `npx tsc --noEmit` — clean (0 errors), both mid-implementation and final.
- **ESLint**: 0 errors/warnings on every file this phase touched or created. Repo-wide `npx eslint .` shows 19 pre-existing errors (all in one untouched file, `tests/unit/goalArchivedLinkedFunding.test.ts`, last modified by an unrelated earlier session) and 46 pre-existing warnings across unrelated files — none introduced by this phase.
- **Production build**: `npm run build` — succeeds, exit 0, `/api/internal/ai/resolve` present in the route manifest.

---

## T. WRITE BOUNDARY

- Canonical financial writes: **0**
- Modules 1–10 business-data mutations: **0** (live-DEV test fixtures wrote synthetic `assets`/`income_sources`/`expense_items`/`liabilities` rows for cleanup-verified synthetic test users only, then deleted them — zero residue independently confirmed)
- AI-initiated financial writes: **0**
- Module 11 resolution/audit/config writes: `ai_resolution_audit` inserts (schema only, not yet applied to any environment), `ai_answer_cache` inserts (via the pre-existing `storeCachedAnswer()`, exercised against real DEV in the live suite, cleaned up), `ai_insights` reads only (Module 11.2 never writes to `ai_insights`) — all as designed.

---

## U. DEFERRED

Confirmed NOT built/introduced this phase: open AI Coach UI/navigation; Monthly AI Insight Pack; standard 20–25 personalised AI question pack; semantic/vector cache; embeddings; Scenario Coach execution; live web search; any AI-initiated financial write; any money movement.

---

## V. RECOMMENDATION

**READY FOR MODULE 11.3**
