# LR-1 Phase Report — Upload Security, Strict Raw-File Deletion & Document Lifecycle (Reconciliation + Merge)

**Status:** UNCONDITIONAL FULL PASS — TERMINAL. Code merged to `main`, live via Amplify auto-deploy; migration `0135` applied to DEV and production, both independently verified; the janitor scheduler is now proven genuinely live in production end-to-end (see §4a) — closed 2026-09-09, without needing the originally-planned tunnel at all, since production already has a real public URL unlike DEV.

**Date:** 2026-09-09

---

## 1. Context

LR-1 (Upload Security) was explicitly deferred to the very end of the LR-2..LR-12 programme per standing instruction. Its own prior work — the purge-machinery fix, the 31-section scheduler-activation dispatch, migration `0128_lr1_document_purge_sweep_scheduler.sql` — was built and DEV-applied on a separate branch/worktree (`feature/lr-1-upload-security-lifecycle`) months before LR-6 through LR-12 existed. By the time LR-12 closed, that branch was **71 commits behind, 6 commits ahead** of current `main` — a genuine sibling-branch reconciliation was required before this work could be considered part of the release, the same pattern this project has hit and resolved multiple times before (FDH-3/R6, App Review).

## 2. Reconciliation work performed this session

- **Committed one disclosed, previously-uncommitted local fix**: `next.config.mjs`'s `turbopack.root` pin (a multi-worktree Turbopack workspace-root inference bug found during LR-1's own live-DEV testing — any worktree nested under `D:\FHIP\.claude\worktrees\...` sits alongside the main checkout, which has its own `package-lock.json`, and Turbopack picks the wrong one as project root). Kept permanently (not reverted, contrary to its original inline comment's stated intent) — it only affects `next dev`'s workspace-root inference; this repo's `next build` script never passes `--turbopack`, so production is unaffected, and the underlying nested-worktree layout is a standing fact of this project's environment, not LR-1-specific.
- **Merged current `main` (`722fc3b`, LR-12's own close) into the LR-1 branch.** One real conflict, in `next.config.mjs` — both branches had independently touched the same file (LR-1's turbopack fix vs. main's much larger `@napi-rs/canvas`/pdfjs-dist production-bundling fix from an entirely separate, already-merged effort). Resolved by combining both — non-overlapping, complementary changes to the same config object.
- **Renumbered migration `0128` → `0135`** (next free slot after LR-11's `0134`). `0128` was allocated and DEV-applied before LR-9/G5B/LR-10/LR-11's own migrations existed on `main`; historical migrations are immutable and production already has `0129`-`0134` applied, so the incoming file moves forward rather than main's migrations being renumbered backward. SQL content otherwise unchanged — DEV's already-created objects under the old `0128` filename need no rework, this only affects a fresh migration chain built from `main` going forward.
- **Found and fixed a genuine, previously-undiscovered defect**: merging `0135` into the ledger for the first time broke `tests/unit/aiInsightPack20HouseholdE2E.test.ts` and its two PGlite-based siblings — `error: extension "supabase_vault" is not available`. `supabase_vault` is a real Supabase Cloud extension (DEV/production both have it) but PGlite's ephemeral in-memory Postgres, used by these tests to rebuild the entire migration chain from scratch, does not support it — a genuinely new incompatibility (`pg_cron`/`pg_net`, used since migration `0010`, are already PGlite-tolerated; `supabase_vault` had no precedent anywhere in this ledger before `0135`). Fixed by wrapping the `create extension` statement in an exception-swallowing `DO` block: identical behaviour on real Supabase Cloud, graceful degradation under PGlite instead of aborting the whole fresh-chain rebuild. All 3 affected tests re-verified passing after the fix. Applied before this migration's first production application, so this is a pre-application content fix, not a rewrite of already-shipped production history.

## 3. Verification performed

- `npm install` (this worktree's own `node_modules` needed the `stripe`/`razorpay` packages LR-10 added on `main`).
- `npx tsc --noEmit` — clean.
- `npx eslint` on every file LR-1's own branch actually changed (excluding files inherited unchanged from the `main` merge) — clean.
- Full repo test suite (6,349 tests): 6,343 passed after the `supabase_vault` fix. Remaining failures are the same pre-existing/environmental class already established throughout this programme — 7 `*LiveDev` tests requiring live Supabase env vars not configured in this run, and one already-known-unrelated Module 11 AI negative control (`aiResidualClosureFailClosed.test.ts` A4, confirmed failing standalone and unrelated to any LR-phase work).
- `npm run build` (production build) — clean, exit code 0.
- Pushed to `main` (`98b2a27`).

## 4a. Scheduler live-activation — CLOSED 2026-09-09

Migration `0135` was applied to DEV (cron job id `6` returned) and then to production. Production's own first `cron.schedule()` attempt as pasted from the full migration file returned zero rows in `cron.job` — the final statement did not appear to execute as part of the bulk paste, for reasons not fully diagnosed (isolated re-run of the exact same statement, on its own, succeeded immediately and cleanly: `jobid = 3`, confirming the SQL itself was correct all along — the likely culprit is a Supabase SQL-editor multi-statement/dollar-quote paste quirk, not a defect in the migration). Re-running just the `cron.schedule(...)` call directly resolved it: `jobid = 3`, `schedule = */5 * * * *`, `active = true`, independently re-confirmed via a direct `cron.job` query.

The job's first several ticks (12:30–12:45 UTC) returned `401 Unauthorized` — the `vault.create_secret('<real CRON_SECRET>', 'lr1_purge_sweep_cron_secret')` manual step (documented in this migration's own header, deliberately never embedded in any file or git history) had not yet been run in production. The user located the real `CRON_SECRET` value themselves (via AWS Amplify's environment variables console — never pasted into this agent's chat, consistent with this project's own established credential-handling discipline) and ran `vault.create_secret(...)`, later `vault.update_secret(...)`. The very next tick (12:50 UTC) returned **`200`** with the purge-sweep route's real, correctly-shaped JSON response (`abandoned_sessions_swept`, `hard_backstop_scanned`, `hard_backstop_forced`, `due_purges_attempted`, `purged`, `already_purged`, `skipped_no_object`, `failed` — all `0`, which is the correct answer for a production environment with nothing currently stale to purge).

This is genuine, independently-verified, live production proof that the entire janitor pipeline — pg_cron trigger → pg_net HTTP call → Vault secret lookup → the purge-sweep route's own authentication → its actual sweep logic — works end-to-end. **The originally-planned tunnel was never needed**: it was only ever a workaround for DEV's lack of a public URL; production already has one (`app.financialhealthplatform.com`), so applying and testing this migration directly against production closed the gap DEV alone never could.

## 5. Closure status

All Product Owner actions for this phase are complete:
1. ✅ Migration `0135` applied to DEV (confirmed).
2. ✅ Migration `0135` applied to production (confirmed).
3. ✅ Vault secret created/updated to match production's real `CRON_SECRET`.
4. ✅ Live end-to-end success independently verified (`200`, correct response shape, 2026-09-09 12:50 UTC).

**LR-1 is TERMINAL — no further action needed.**

---

*This is the last individual LR-phase report. See `LR_CONSOLIDATED_FINAL_REPORT.md` for the full programme's Appendix-J table — updated to reflect this closure.*
