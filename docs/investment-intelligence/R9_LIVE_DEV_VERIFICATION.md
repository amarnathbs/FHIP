# R9 Live DEV Verification

## Status: BLOCKED — migration `0067` is drafted but NOT applied to DEV

Spec sections 96-118 ask for 20 live-DEV cases plus 12 independently-reconciled live cases. This environment has **no DDL-execution credential** — no `DATABASE_URL`, no `exec_sql`-shaped RPC, no linked Supabase CLI (an established, pre-existing constraint of this session, confirmed again here: `SUPABASE_SERVICE_ROLE_KEY` grants REST read/write within the existing schema, never `CREATE TABLE`/`ALTER TABLE`). Migration `0067_ii_r9_review_centre.sql` is delivered as a file for a human to apply manually, exactly like every migration in this project's history (`0058`, `0064-0066`, etc. were all applied this same way).

Because `ii_review_items`, `ii_review_rule_registry`, and `ii_goal_allocations.linked_investment_id` do not yet exist on live DEV (`vqycarelcoijzwlpkpcz`), **every one of R9's new API routes would 500 against live DEV today** (`relation "ii_review_items" does not exist` / `column "linked_investment_id" does not exist"`). Attempting to run a live-DEV test harness against them before the migration is applied would not produce genuine evidence — it would only prove the expected pre-migration failure mode. No such test was run, and none is fabricated here.

## What WAS verified against a real PostgreSQL engine

`scripts/ii_r9_certification.mjs` runs the exact same 67 migrations (including `0067`) through PGlite — a real embedded Postgres, not a mock — and exercises RLS, dedup constraints, allocation-cap constraints, and the no-double-counting invariant with real SQL, real negative controls, and a harness sanity check (`auth.uid()` genuinely reads the intended session before any isolation claim is trusted). This is the closest available substitute to live DEV verification given the credential constraint, and is reported as exactly that — a substitute, not live DEV itself.

## Required next step (out of this session's authority)

1. A human with DEV DDL access applies `supabase/migrations/0067_ii_r9_review_centre.sql` to `vqycarelcoijzwlpkpcz`.
2. Only then can the 20 LIVE-R9-001..020 cases and the 12 independently-reconciled cases (spec sections 97-118) be executed for real, using this session's existing `.env.local` service-role access plus a running `next dev` instance (`.claude/launch.json` already configured in this worktree) to exercise the actual API routes end-to-end.
3. Until step 1 happens, R9's live-DEV certification section of the final verdict is honestly reported as **0/20 executed (blocked, not failed)** — see `R9_ACCEPTANCE_REPORT.md`.
