# R6 — Integrated DEV Certification (Modules 11.1–11.6)

**Programme:** Module 11 AI Remediation, 2026-09-22 · **Brief:** §§50–57
**Branch state certified:** `feature/module11-ai-remediation-2026-09-22` merged with `origin/main` @ `17e7f3c` (PR #8, AIE-1 final closure) — one additive `.env.example` conflict resolved; `amplify.yml` auto-merged with the Module 11 forwarding intact; `check:migrations:against-main` clean (0175–0178 collision-free; main now carries 0173/0174).

Evidence classes: **TEST** (vitest / PGlite executed this session), **DEV** (live DEV project), **CODE** (inspection). Where a brief item's live-DEV proof is blocked, it says so — nothing below is rounded up.

| § | Module / requirement | Result | Evidence |
|---|---|---|---|
| 50 | 11.1 entitlement, 10-question quota, billing periods, rate limiting, concurrency, cost ceiling, kill switches | **PASS (TEST + DEV)** | Existing 11.1 estate re-run in the full suite (`aiEntitlementEnforcement`, `aiEntitlementServiceAndCapabilities` — 9 sub-capabilities now); `scripts/db-rebuild-check/module11_1_entitlement_cert.mjs` 376/379 (the 3 failures assert the original 12-task seed and **fail identically on an untouched tree** — 0121 made it 13; pre-existing, not this programme); R2 PGlite matrix exercised the real `ai_admit_request()` for provider-disabled, model-inactive, live-provider-disabled, cost hard stop and the real rate limiter (fired at the 13th admission); DEV: quota 10→10 across two real-provider packs. Admin UI: R4 (built; live render blocked on 0177). Real model cost metadata: registry row priced from OpenAI's page, cost recorded on packs/runs live. |
| 51 | 11.2 resolution order DETERMINISTIC → KB → STORED → EXACT_CACHE → LIVE_AI_REQUIRED; DB invariants | **PASS (TEST)** | Existing `aiResolutionRouter`/`Deterministic`/`KnowledgeBase`/`StoredPersonalised`/`ExactCache`/`Normalisation`/`IntentMatching` suites pass unchanged; `module11_2_resolution_router_cert.mjs` 13/13 on the merged chain (RLS + CHECK invariants). |
| 52 | 11.3 real provider, real prompt, real model, real cost, grounding, batch/scheduler, stored reuse, no custom-quota spend | **PASS (DEV) for provider/prompt/model/cost/grounding/stored reuse/quota; CONDITIONAL for scheduler (PGlite-only)** | R2 DEV runs (READY, PASS 6/6, $0.002357, prompt v2, gpt-4o-mini-2024-07-18, 5 stored answers, quota 10→10); R3 PGlite 15/15 + real Batch API round trip; `module11_3_insight_pack_cert.mjs` 30/30 (updated for prompt v2). |
| 53 | 11.4 all 25 standard questions, provider 0, quota 0; SQ-AI-013 still deferred | **PASS (TEST)** | `aiStandardQuestionProviderProof` (150 resolutions, 0 provider), `aiR2ZeroCostRegressionOpenAiConfigured` (same with OpenAI configured + network tripwire), `aiStandardQuestionHouseholdMatrix`, `aiStandardQuestionService`; SQ-AI-013 → `DEFERRED_CAPABILITY` unchanged (no certified deterministic rate-stress source exists in the FCO). SQ-AI-003/025 now DETERMINISTIC via 11.6. |
| 54 | 11.5 all contextual Explain targets, provider 0, quota 0, current/historical snapshot binding | **PASS (TEST)** | `aiContextualExplanationProviderProof` (gates 119/120), `…SnapshotAndTenancy`, `…MatrixAndPerformance`, `…Api`, `…UiContract` unchanged and passing; R2/R6 zero-cost regressions cover every target under OpenAI configuration. |
| 55 | 11.6 rules / ranking / suppression / max 3, provider 0, quota 0 | **PASS (TEST)** | `aiNbaEngine.test.ts` 35/35 (R5 report). |
| 56 | Integrated positive/negative provider control | **PASS (TEST)** | `aiR6IntegratedProviderControl.test.ts`: ONE adapter spy + ONE network tripwire: pack → adapter 0→1; then 75 standard-question resolutions + 3× every contextual target + 20 NBA evaluations → adapter still 1, OpenAI network 0, `ai_admit_request` 0, custom questions 0. |
| 57 | Modules 1–10 regression; no Module 1–10 code modified | **PASS (CODE) / TEST see below** | `git diff --name-only <merge-base>..HEAD` = 80 files, **all** under `lib/ai/**`, `app/api/ai/**`, `app/api/admin/ai/**`, `app/api/admin/me`, `app/api/internal/ai/**`, `app/(app)/admin/ai-operations`, `app/(app)/ai-insights`, `components/admin/AiOperationsClient.tsx`, `components/aiInsights/**`, `lib/admin/adminNav.ts`, `lib/services/aiOperationsAdmin.ts`, `tests/**`, `docs/ai/**`, `supabase/migrations/0175–0178`, `scripts/module11/**`, `scripts/db-rebuild-check/module11_3_*`, `amplify.yml`, `.env.example`. Zero files under `lib/engines/**`, `lib/services/{dashboard,score,dna,resilience,goals,twin,reports,forecast}*`, or their pages. The one Module 11.0 touch outside `lib/ai/insightPack|providers|nba|admin` is `financialContextObject.ts` (optional injected base client; default path unchanged). Full unit suite: see the addendum line below (populated from the run log). |

## Full-suite result (addendum)

`npx vitest run` on the merged tree (2026-09-22): **438 files, 8,281 tests — 8,250 passed, 26 failed, 5 skipped** (286 s). Every failure was individually attributed:

| Failing file | Count | Attribution | Action |
|---|---|---|---|
| `adminAnalyticsPhaseAMeRoute.test.ts` | 17 | **Pre-existing** — fails identically on the untouched tree `d1ce449` (asserts 5 capabilities / 1 role read; PC6/PC7 made it 7 before this programme; now 9) | none (Standard §14) |
| `countryGateAccessMatrix.test.ts` | 1 | **Pre-existing** (asserts no account-deletion route; LR-9 added one) | none |
| `aiResidualClosureFailClosed.test.ts › A4` | 1 | **Pre-existing** (R2 §5) | none |
| `resourcesR1_1.test.ts` | 1 | **Pre-existing** 5 s timeout, reproduced alone on the untouched tree | none |
| `fdh1Isolation.test.ts` | 1 | **Introduced by `origin/main` PR #8** (`lib/shared/pdfStructuralScan.ts`, commit `9efd674`), not by this branch (passes on `d1ce449`) | flagged to the AIE/FDH owners |
| `m12cServerOnlySecretBoundary.test.ts` | 1 | `ENVIRONMENT_VARIABLES.md` must mirror `amplify.yml`'s forward line: already drifting on `main` (`STRIPE_`/`RAZORPAY_` never mirrored) and this branch added two terms | **fixed** in this branch (doc updated; test passes) |
| `resourcesAdminR1_2`, `m12aFdhBankAccuracyCorpus` ×2, `m12bInsuranceAccuracyCorpus` | 4 | Load-related under the full parallel run (5 s timeouts / count drift from concurrent fixtures); **all pass when run in isolation** | none |

Net: **0 failures attributable to Module 11 remediation code**; 1 doc drift fixed. Modules 1–10 engines/services/pages: unchanged and their suites pass.

## Blocked / disclosed (carried into R7 pre-conditions)

1. Migrations 0176, 0177, 0178 are DDL and cannot be applied to DEV from this environment (no exec-SQL RPC, no Management token, no DB URL — re-probed 2026-09-22). Their behaviour is certified under PGlite with the real chain; live DEV proof of the scheduler run, the Admin AI Operations page and the NBA audit table is owed once an operator applies them.
2. The OpenAI project is not entitled to `gpt-4o-mini-…-batch`; provider-native batch pricing is available only after the account owner enables it (config switch, no code).
3. Pre-existing failures unrelated to this programme, reproduced on an untouched tree: `tests/unit/aiResidualClosureFailClosed.test.ts › A4` and the 12-vs-13 seed-count assertions in the 11.0/11.1 PGlite cert scripts. Recorded, not fixed (brief §57 / Standard §14).
4. `approved_by` on the DEV `gpt-4o-mini` row is null (service-role activation script); production step 4 uses the admin route.
