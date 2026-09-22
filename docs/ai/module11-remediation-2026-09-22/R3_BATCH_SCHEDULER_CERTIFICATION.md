# R3 — Real Async/Batch + Monthly Scheduler (Module 11.3)

**Programme:** Module 11 AI Remediation, 2026-09-22 · **ADR:** `ADR-M11-002-monthly-insight-pack-scheduling.md` (same folder)
**Verdict:** **CONDITIONAL PASS** — fully built and certified under real Postgres (PGlite, real migration chain, real SQL lease functions, real orchestrator/pipeline); the real OpenAI Batch API round-trip proven live; **live-DEV execution of the scheduler is blocked on applying migration 0176 (DDL) to DEV**, and **provider-native batch pricing is blocked on the OpenAI project being entitled to the batch model** (fallback transport shipped and certified).

Evidence classes: **CODE**, **TEST** (vitest executed this session), **DEV** (live), **LIVE-OPENAI** (real provider call).

| Brief § | Requirement | Where | Evidence |
|---|---|---|---|
| 23 | Discover infra; smallest compatible architecture; no bespoke in-process cron | ADR §"Deployment infrastructure discovered" | CODE: 7 existing `x-cron-secret` routes, 3 pg_cron migrations, Vault precedent (0135), runbook precedent (0155). Chosen: pg_cron + pg_net → `POST /api/ai/cron/insight-pack-monthly`. |
| 24 | ADR-M11-002 with trigger/worker/locking/retry/recovery/cost/batch/tenant/visibility | ADR | Written; all nine headings covered. |
| 25 | Eligibility: Premium + certified snapshot + no equivalent pack + batch switch + budget | `schedulerService.ts` `runSubmitPhase()` | TEST (PGlite): Free subject never in the universe; entitlement-gate false → `not_premium`; no snapshot → `no_certified_snapshot`; same identity READY → `current_pack_exists` (18/18 in the retry run); admission ceilings via real `ai_admit_request()`. |
| 26 | No calendar-only generation | same | TEST: the premium subject with no certified snapshot is SKIPPED in every period. |
| 27 | Identity/duplicate control | `0176` unique `(billing_period, user_id)`; lease index; pack identity unchanged | TEST: second submit tick in the same period → discovered 0 / submitted 0 / one provider submission total; concurrent claim → `lease_held_by_another_run`; expired lease reclaimed + recorded `LEASE_EXPIRED`. |
| 28 | Real batch adapter: submit / provider id / custom id / poll / success / partial / cancel / cost | `lib/ai/providers/openaiBatchProvider.ts` | TEST (fetch double, 6 cases). **LIVE-OPENAI:** `batch_6ab24e76…` submitted (file `file-LvHR…`), `validating → in_progress → completed` over 6 polls, matched by custom_id — item result `403 project not entitled to gpt-4o-mini-2024-07-18-batch` (no completion tokens billed). Fallback per §28 ¶2: `SyncFanoutBatchProvider` (governed queue preserved, standard pricing, `cost_pricing_basis='standard'`), default via `MODULE11_AI_BATCH_MODE`. |
| 29 | Association by stable request id, out-of-order | `applyPollResults()` | TEST: mock returns reversed order; adversarial mismatched id dropped (pre-existing test still passes); duplicate result for one id applied once. |
| 30 | 20 jobs: 18 valid / 1 provider failure / 1 grounding failure | `aiR3SchedulerPglite.test.ts` | TEST: 18 READY, 2 FAILED (`PROVIDER_UNAVAILABLE`, `grounding_failure:overall_financial_summary`), every READY pack's `snapshot_id` matches its own subject, 18 subjects with stored answers, batch `PARTIAL 18/2`. |
| 31 | Bounded, classified retries | `isRetryableFailureCode()`; `NON_RETRYABLE_FAILURE_PREFIXES` | TEST: grounding failure terminal (FAILED, not re-admitted); provider failure re-admitted once. Defect found+fixed: retried pack not re-parented to the new batch (its result was dropped as "unmatched"). |
| 32 | 24h regeneration cadence | unchanged cooldown + job `SKIPPED regeneration_cooldown` | TEST: fresh identity <24h after generation → skipped, no submission. |
| 33 | Manually-triggerable DEV certification path | `POST /api/admin/ai/insight-packs/scheduler/run` (admin, R4) and `dryRun`; `aiR3SchedulerPglite.test.ts` walks discovery → claim → dup suppression → provider call → validation → persistence → stored-answer retrieval → cleanup (zero residue) | TEST: 15/15. **DEV: blocked** — 0176 is DDL, no DDL path from this environment (re-probed). |
| — | Cron route auth | `aiR3CronRouteAuth.test.ts` | TEST: 401 without/with wrong secret and when `CRON_SECRET` unset; reconcile runs before submit. |

Regression: pre-existing batch suites (`aiInsightPackBatchOrchestrator` 9, `…Pglite` 1, `20HouseholdE2E`, `IsolatedKillSwitch`) unchanged and passing after the submit/reconcile split; full Module 11 estate 1086/1087 (the one pre-existing failure, see R2 §5).

Not done / needs an operator: apply 0176 to DEV and production; create the Vault secret; register the schedule (statement in the ADR); flip `scheduler_enabled` through the admin screen; have the account owner enable the batch model on the OpenAI project, then set `MODULE11_AI_BATCH_MODE=provider_batch`.
