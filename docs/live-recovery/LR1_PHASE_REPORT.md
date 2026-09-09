# LR-1 Phase Report — Upload Security, Strict Raw-File Deletion & Document Lifecycle (Reconciliation + Merge)

**Status:** CONDITIONAL PASS — code merged to `main` and live via Amplify auto-deploy; the janitor scheduler's own live-activation proof remains blocked on a publicly-reachable DEV URL, unchanged from before this reconciliation.

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

## 4. What remains open (unchanged from before this reconciliation)

The **janitor scheduler's live-activation proof** is still blocked exactly as before: `pg_net` (Supabase Cloud) cannot reach a `next dev` server running only on localhost, and no standing publicly-reachable DEV deployment of this app exists. The user's own explicit decision stands: they will run a tunnel themselves (e.g. `npx localtunnel --port <this worktree's dev server port>`) and paste back the resulting public URL, rather than using an Amplify preview deployment. This reconciliation did not attempt to re-run that proof — it was purely a code/migration-ledger reconciliation so LR-1's work could actually become part of the release.

## 5. What the Product Owner needs to do next

1. Apply migration `0135_lr1_document_purge_sweep_scheduler.sql` to **DEV** (safe, idempotent re-run of the same SQL DEV already ran once under the old `0128` filename — the migration unschedules-then-reschedules its own cron job by name, and the `supabase_vault` extension creation is `if not exists`).
2. Once confirmed, apply the same migration to **production**.
3. When ready, run a tunnel against this worktree's dev server and paste back the public URL so the janitor's actual reachability can finally be proven live — the one remaining item in the entire LR-2..LR-12 programme.

---

*This is the last individual LR-phase report. Next: the consolidated final matrix report (LR-2 through LR-12) per the master spec's own "Required final report template".*
