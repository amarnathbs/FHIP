# Document2 (4) WP-G truth table (F15 background bank-statement import, PO-D24-03)

Branch feat/doc2-4-wp-g-bank-import-job-20261021, base origin/main 9cce1cf (contains WP-E, 93ecf93). Evidence labels: UNIT-TESTED, PGLITE-VERIFIED (a real Postgres engine with this repository's whole migration chain), DEV-verified (project vqycarelcoijzwlpkpcz only), NOT PERFORMED. Nothing here is PRODUCTION-VERIFIED.

## What the repository already had for background work (audited before choosing)

| Candidate | Finding | Usable for this? |
|---|---|---|
| Scheduled routes with a shared secret | 14 `cron/*` routes (`x-cron-secret` against `CRON_SECRET`): FDH and AIE purge sweeps, FDH and AIE malware-scan sweeps, monthly report, Premium expiry reminders, NAV/benchmark/market-index jobs (pc6 selective hydration, nav2 correction worker ...). `CRON_SECRET` is already forwarded to the runtime by `amplify.yml` | Yes: the pattern for the backstop |
| Scheduler | `pg_cron` + `pg_net` jobs registered by migrations 0135, 0149, 0174, 0187-0193, 0205, 0222, 0228, 0232, 0238, 0252, 0267 (secret read from the Supabase Vault at call time); AWS EventBridge Scheduler documented in `DEPLOYMENT.md` section 6 as the alternative | Yes: the mechanism for the backstop schedule. No DEV-reachable app origin exists, so a DEV schedule cannot fire |
| Job tables | `fdh_ingestion_jobs` (0046): "NO WORKER IS IMPLEMENTED"; one `document_extract` row per upload, no lease, no checkpoint; `aie_*` and `ii_*` hydration tables belong to other programmes | No: no lease or checkpoint. Its row is still closed by finalize exactly as before |
| Long-running worker / queue (SQS, Lambda, Step Functions) | None. Amplify runs Next.js SSR/Lambda with a 28 s request limit | No |
| Cost cap | `aie_reserve_ai_cost_v2` / settle (0284): atomic per-user daily cap (US$1) and global allowance, called by the shared gateway for every provider call | Reused unchanged, once per AI part |

Conclusion: no queue exists, so the worker is built from what exists: a durable job table, bounded lease-guarded slices, driven by the signed-in page and by one more scheduled route.

## Rows

| Field | Content |
|---|---|
| Finding | F15 follow-up, PO-D24-03: "long bank PDF/CSV import" must stop doing extraction inside the 28 s request |
| PO comment / decision | Background job with status polling: admission (authenticate, entitlement, owner/account, malware) -> create or resume ONE idempotent job -> 202 + job id; a worker parses/extracts (CSV, certified PDF, AI fallback); durable states; UI polls and resumes after refresh; exactly-once rows; dead-job detection, safe retry, partial staging cleaned; preserve owner-before-upload, malware admission, raw lifecycle, strict deletion, cost cap, idempotency keys |
| Current truth before this work (origin/main, WP-E merged) | The two process routes read the whole statement in the request. WP-E made a killed run recoverable (live/dead run, retry) and logged, but a statement whose single reading needs more than 28 s still could not finish: real bank PDF in an unrecognised layout through the AI took 29.6 s for 25 lines and 66 s for 120 lines; CSV 1,500 rows 20 s (latency-inflated); AI reading is one call capped at 80 lines |
| Root cause | The unit of work was the whole statement inside one request. There is no worker to move it to |
| Architecture chosen | Durable job (`fdh_bank_import_jobs`, `fdh_bank_import_job_chunks`, migration 0310) + atomic lease claim on the database clock + slices of bounded work (read -> persist -> finalize; or read -> AI parts -> person checks -> confirmed plan -> persist -> finalize) driven by (a) `POST /bank-import-jobs/{id}/advance` from the open page and (b) `POST /bank-import-jobs/cron/advance` from a scheduler as backstop. Every slice recomputes what is left from the database; every job write is fenced by the lease holder |
| Regression? | Not a regression: the synchronous design predates owner-before-upload; the AI fallback (23-09-2026) and Premium AI (14-10-2026) made the long path the normal path |
| Severity | High |
| Fix | See `DOCUMENT2_4_REPORT_WP-G.md` |
| Tests | `tests/unit/doc2_4_wpG_*.test.ts` (6 files), negative controls `scripts/doc2_4_wp_g_negative_controls.mjs` |
| DEV proof | AI part timing on the real provider: DEV-verified. The job run on DEV: NOT PERFORMED (migration 0310 is not on DEV and no agent can run DDL on DEV); the driver `scripts/doc2_4_wp_g_dev_run.ts` is ready |
| Verdict | CONDITIONAL (see the report) |
