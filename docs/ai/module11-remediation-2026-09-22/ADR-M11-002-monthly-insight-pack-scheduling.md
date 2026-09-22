# ADR-M11-002 — Monthly Insight Pack Scheduling & Batch Execution

**Status:** Accepted for DEV (2026-09-22) · production activation deferred to the R7 plan
**Programme:** Module 11 AI Remediation, R3 · **Brief:** §§22–33
**Supersedes:** nothing (the pre-R3 code had batch *types* and an in-process mock only — source audit PH-03)

## Context

Module 11.3's Insight Pack was generatable only by an admin calling `POST /api/admin/ai/insight-packs/generate` for one user at a time, with a synchronous mock provider. The commercial design (spec §§25–26) is a *monthly, asynchronous, cost-controlled, resumable, idempotent* generation across every eligible Premium household. R2 made a real provider available; R3 has to make it run unattended without inventing infrastructure this deployment does not have.

## Deployment infrastructure discovered (brief §23)

| Fact | Evidence |
|---|---|
| App runs on AWS Amplify Hosting (Next.js server runtime, ephemeral compute, no console access from agents) | `amplify.yml`, `DEPLOYMENT.md`, memory |
| **The project's ONE established scheduler** is Supabase **pg_cron + pg_net** posting to a Next.js route protected by the shared `x-cron-secret` header (`CRON_SECRET`) | migrations `0010` (reports monthly), `0135` (LR1 purge sweep), `0149` (AIE purge); routes `app/api/reports/cron/monthly-generate`, `app/api/*/cron/*` (7 routes) |
| Secret handling precedent: the cron secret is read from **Supabase Vault** at fire time, never written into a migration | migration `0135` header |
| Precedent for *not* registering the schedule from a migration under the autonomous-agent override: `0155` (PC6) / NAV1 — statement lives in an operator runbook | `0155` §15, `pc6-selective-hydration/route.ts` header |
| No EventBridge/Lambda/SQS/worker exists anywhere in the repo; no AWS credentials with relevant permissions are available to agents | grep; memory (G8 Amplify-API access blocked) |

## Decision

1. **Trigger:** pg_cron + pg_net → `POST /api/ai/cron/insight-pack-monthly` with `x-cron-secret` (Vault-sourced). No in-process cron, no new AWS service. Smallest architecture compatible with what exists; identical shape to the seven existing scheduled routes.
2. **Idempotent monthly ledger:** `ai_insight_pack_scheduler_jobs` with `unique (billing_period, user_id)` — a subject is discovered at most once per UTC billing month regardless of how many ticks run or how many workers race (§27). *A new month opens a ledger; it never by itself generates* (§26): every discovered subject is re-checked for Premium entitlement, a certified current snapshot, and "no equivalent READY/PARTIAL pack for the same snapshot + context hash + pack schema + prompt version" before admission.
3. **Two resumable phases, separate invocations:** `submit` (discover → per-household admission through the unchanged `ai_admit_request()` → **one** provider submission → packs `GENERATING` with `provider_batch_id` and `admission_id` persisted) and `reconcile` (poll open batches whose `next_poll_at` has passed → rebuild each household's certified context in the reconciling process and **require its hash to equal the admitted hash** → apply results by `requestId` → finalise/refund the reservation). A household whose data changed while the batch was in flight fails closed (`context_changed_before_reconcile`) — it is never grounded against a context the provider never saw.
4. **Locking:** a `SECURITY DEFINER` lease claim (`ai_insight_pack_scheduler_claim`) backed by a **partial unique index** (`one RUNNING run per phase`); stale leases expire automatically and are recorded `LEASE_EXPIRED`. No advisory locks (session-scoped, incompatible with PostgREST pooling), no app-side mutex. Overlapping cron ticks and a concurrent admin manual run collapse to one execution (§27).
5. **Provider-native batch:** `OpenAIBatchProvider` implements the existing provider-neutral `BatchCapableProvider` contract over OpenAI's Files + Batches API (`custom_id` = FHIP request id, `/v1/chat/completions` bodies with the same strict `json_schema`, `store:false`, 24h window, output matched **by custom_id only** — never by line order, §29). Poll results persist `provider_status`, `poll_count`, `next_poll_at`; a batch that exceeds the poll budget is cancelled and its households failed closed with reservations refunded.
6. **Kill switches:** existing `ai_globally_enabled` (both phases), existing `batch_generation_enabled` (submit; reconcile deliberately still collects already-paid-for batches), and a **new** `ai_platform_controls.scheduler_enabled` (ships **false**; gates only cron-triggered submit so an admin/dev manual run remains possible for certification). Every per-household admission gate is unchanged.
7. **Retries (§31):** bounded (`maxRetries` 3 per identity); `isRetryableFailureCode()` never retries grounding, certification, safety, hard-cost-limit, ranking-producer, identity-mismatch or context-changed failures as if transient. Transient = provider outage/timeout/rate limit/missing result/batch expiry. A retried pack is **re-parented to the new batch** (defect found by the PGlite certification, fixed).
8. **Cost control:** unchanged ceilings via `ai_admit_request()` + `maxHouseholdsPerRun` per tick + `dryRun`. Attribution: per-pack `estimated_cost_usd` stays at the conservative **standard** rate; the batch row records `actual_cost_usd` at the **batch** rate (50%) with `cost_pricing_basis='batch'`, or standard with `'standard'` for the fan-out transport.
9. **Cadence (§32):** the existing 24h automatic-regeneration cooldown is honoured (`REGENERATION_RATE_LIMITED` → job `SKIPPED regeneration_cooldown`); the monthly ledger is the explicit monthly cycle; admin forced regeneration keeps its own audited carve-out.
10. **Tenant isolation:** the session-less context builder (`buildFinancialContextObject(userId, { client: serviceRole })`) keeps every read filtered by the explicit `userId` and every write blocked by the certified-source wrapper; reconciliation matches by request id and re-verifies `snapshot_id` and context hash per household; results with unknown ids are dropped, never re-attributed.
11. **Operational visibility:** `ai_insight_pack_scheduler_runs` (one row per invocation with counts/errors/lease) and the jobs ledger, surfaced by the Admin AI Operations screen (R4).

### Finding that changed the default transport (§28, second paragraph)

The first live OpenAI Batch API probe (`scripts/module11/real_batch_dev_probe.ts`, 2026-09-22) completed the mechanical round trip — file upload accepted, `batch_6ab24e76…` created, `validating → in_progress → completed` observed over 6 polls (~2 min), output/error line matched by `custom_id` — but the single item returned **`403 Project proj_E5kI… does not have access to model gpt-4o-mini-2024-07-18-batch`**. The credential's OpenAI *project* is not entitled to the batch model variant. That is an account-console setting for the account owner, not code.

Therefore, as the brief's own fallback rule requires, the governed async job queue is preserved and a second transport is provided **without pretending to be provider-native**: `SyncFanoutBatchProvider` executes each admitted household through the synchronous adapter inside the submit invocation (standard pricing, `cost_pricing_basis='standard'`), and the scheduler reconciles in the same invocation (`completesSynchronously`). `MODULE11_AI_BATCH_MODE` selects `sync_fanout` (default) or `provider_batch`; `MODULE11_SCHEDULER_MAX_HOUSEHOLDS_PER_RUN` bounds a tick (default 5 / 50). Switching to `provider_batch` once the project is entitled is a config change with no code change.

## Consequences

- Cron cadence recommendation: every 15 minutes. `reconcile` is a no-op when nothing is open; `submit` discovers only subjects not yet ledgered this month, so the month's work drains at ≤ `max households` per tick with no calendar-date logic in the app.
- Migration `0176` is **DDL** (new tables/columns/functions) and there is **no DDL path to DEV from this environment** (re-probed 2026-09-22). The scheduler is therefore certified under PGlite with the real migration chain and real SQL functions (`tests/unit/aiR3SchedulerPglite.test.ts`, 15 cases), and live-DEV execution of the scheduler is **blocked on an operator applying 0176 to DEV** — recorded as such in R6/R7.
- Nothing is scheduled by any migration. Activation is a human-present operator step (below).

## Operator runbook (NOT executed by this programme)

1. Apply migration `0176` (Supabase dashboard / CLI). Verify `select scheduler_enabled from ai_platform_controls` is `false`.
2. Create the Vault secret once per project (value = that environment's `CRON_SECRET`; never commit it):
   `select vault.create_secret('<CRON_SECRET value>', 'module11_insight_pack_cron_secret');`
3. Register the schedule (replace the origin; production origin is `https://app.financialhealthplatform.com`):
   ```sql
   select cron.unschedule('module11-insight-pack-monthly')
   where exists (select 1 from cron.job where jobname = 'module11-insight-pack-monthly');
   select cron.schedule(
     'module11-insight-pack-monthly',
     '*/15 * * * *',
     $$
     select net.http_post(
       url := '<APP_ORIGIN>/api/ai/cron/insight-pack-monthly',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'module11_insight_pack_cron_secret')
       ),
       body := '{"phase":"both"}'::jsonb
     );
     $$
   );
   ```
4. Runtime env: `MODULE11_AI_PROVIDER=openai`, `OPENAI_API_KEY`, optionally `MODULE11_AI_BATCH_MODE=provider_batch` (only after the OpenAI project is entitled to the batch model) and `MODULE11_SCHEDULER_MAX_HOUSEHOLDS_PER_RUN`.
5. Flip `ai_platform_controls.scheduler_enabled = true` through the Admin AI Operations screen (audited) — the last step, after a dry run (`{"phase":"submit","dryRun":true}`) has been inspected.
6. Rollback: set `scheduler_enabled=false` (immediate; in-flight provider batches are still reconciled), or `cron.unschedule('module11-insight-pack-monthly')`.
