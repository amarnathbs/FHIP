# FDH-9 — Live DEV Certification

**STATUS: NOT PERFORMED. Migration 0091 has never been applied to any live
Supabase project — DEV or production. This is a genuine, structural
limitation of this execution environment, not a skipped step.**

## What was checked, fresh, in this pass (2026-08-26)

Per the standing hard rule for this dispatch ("check first, but the prior
hardening pass on this same branch found none") and spec section 9's own
fallback instruction, this pass re-verified — rather than assumed — the
environment's DDL capability:

| Checked | Result |
|---|---|
| `supabase` CLI on PATH | Not found (`command not found`) |
| `SUPABASE_ACCESS_TOKEN` in env | Not set |
| `DATABASE_URL` / `POSTGRES_URL` / any Postgres connection string in the repo, `.env.local`, `.env.example` | None found |
| Supabase Management API token anywhere in repo/env | None found |
| `~/.supabase` | Exists, contains only `telemetry.json` and an empty `traces/` directory — no stored credentials |
| `.env.local` contents | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (a REST API key, not a DDL-capable credential), plus unrelated `CRON_SECRET`/`RESEND_API_KEY`/`CONTACT_FROM_EMAIL` |

The service-role key present is a PostgREST-level credential (bypasses RLS
for REST calls) — it cannot execute arbitrary DDL, run a migration file, or
create a table. There is no code path available to this agent that can apply
`supabase/migrations/0091_fdh9_payslip_income_intelligence.sql` to a live
database.

This matches the prior hardening pass's own finding on this same branch
exactly — re-confirmed independently rather than taken on faith.

## Per spec section 9's required report format

> FDH-9 migration ready: **YES**.
> Migration: `supabase/migrations/0091_fdh9_payslip_income_intelligence.sql`.
> PGlite: **76/76 PASS** (see `FDH9_PGLITE_CERTIFICATION.md`).
> DEV application required: **YES**.
>
> **Exact owner action:**
> 1. Confirm the target Supabase project is DEV, not production (check the
>    project ref against the known DEV project id before proceeding — do not
>    guess).
> 2. Apply the migration via one of:
>    - `supabase db push` (from a machine with the Supabase CLI installed and
>      `supabase login`/`SUPABASE_ACCESS_TOKEN` configured for the DEV
>      project), or
>    - pasting the full contents of
>      `supabase/migrations/0091_fdh9_payslip_income_intelligence.sql` into
>      the DEV project's Supabase Studio SQL Editor and running it as a
>      single statement batch (the pattern this project has used for prior
>      phases — see `FDH-2`'s closure notes on SQL-editor quirks: temp tables
>      do not survive multi-statement dispatch there, and `RAISE NOTICE`
>      output is not shown in the Studio UI, so success is confirmed by the
>      structural checks below, not by console output).
> 3. Independently verify (do **not** rely on "migration completed
>    successfully" alone): `fdh_payroll_events` present, `fdh_payroll_
>    components` present, `fhip_import_proposals` present, `fhip_import_
>    proposal_fields` present, `fhip_import_applications` present,
>    `fdh9_apply_income_proposal` present (function), `fdh9_approve_
>    payroll_event` present (function), RLS enabled on all five new tables,
>    the `trg_*_authoritative_write` triggers present, the unique
>    `(user_id, payslip_fingerprint)` index present, the unique
>    `(bank_match_transaction_id)` partial index present.
> 4. **After the owner applies the migration: RESUME LIVE DEV CERTIFICATION**
>    — run `scripts/fdh9_live_dev_certification.mjs` (already prepared,
>    unmodified by this pass) against the real DEV project with synthetic
>    Tenant A / Tenant B identities, covering: same-tenant direct-PATCH
>    forgery (BLOCKED, live), forged application record (BLOCKED, live),
>    payroll authoritative-field forgery (must follow the documented
>    authority model), cross-tenant Income target / bank link (BLOCKED, no
>    mutation to either tenant), atomic rollback (all-or-nothing, live),
>    concurrent apply (exactly one success, live), stale proposal (live),
>    and — new to this pass's scope — the **HTTP route layer itself**
>    exercised end-to-end against the real running Next.js app (AU complete
>    journey, India complete journey, No Apply, Update Existing, Add New,
>    Keep Existing, Selected Fields, Stale Proposal, Duplicate Apply,
>    Tenant A/B), per spec section 70. Then run the DEV cleanup step (spec
>    section 71) and independently re-query DEV to confirm zero synthetic
>    rows remain.

## Do not mark DEV PASS

No claim in this report or any other FDH-9 document should be read as
asserting live-DEV certification occurred. Every certification claim in this
pass's other documents is scoped explicitly to PGlite (a real Postgres engine
run locally) or to route-level logic tests — never to a live Supabase
project.
