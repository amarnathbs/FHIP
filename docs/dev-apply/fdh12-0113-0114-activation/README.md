# DEV apply package: FDH-12 hotfix migrations 0113 and 0114

> ## RESOLVED — 2026-08-31. BOTH MIGRATIONS ARE NOW IN EFFECT ON DEV.
>
> The Product Owner re-applied both, this time pasting each migration file in
> **full** rather than a partial selection — the suspected cause of the original
> non-effect. Live round 3 then returned **262 PASS / 0 FAIL**, with all 17 of
> round 2's failing checks passing individually and the `0114` guard messages
> matching the migration source verbatim. See
> `docs/financial-data-hub/FDH12_LIVE_DEV_CERTIFICATION.md`.
>
> This package is retained as the historical record of the non-effect and the
> diagnosis. `02_dev_verification.sql` is still useful and still read-only —
> re-running it should now report both migrations `IN EFFECT`. Everything below
> describes DEV **before** 2026-08-31.

**Status at the time of writing (2026-08-30): BOTH MIGRATIONS ARE NOT IN EFFECT
ON DEV.** They were reported
applied on 2026-08-30 with no error. The live re-certification run that
followed proves otherwise, twice over and from two independent directions.

Nothing in this package has been applied anywhere by the agent that wrote it —
no CLI project link, no reachable SQL-execution RPC, no connection string, the
same documented limitation as every prior release's DEV/production migration
step in this repo. Production is never touched by this package.

## The evidence that they are not in effect

Every line below is real output from hosted DEV (`vqycarelcoijzwlpkpcz`),
captured as an ordinary **authenticated end user** over PostgREST — no service
role, no SQL access.

### 0113 — the approve RPC still cannot succeed

Called by the statement's own owner, on a row genuinely in `approval_status =
'pending'`:

```
POST /rest/v1/rpc/fdh12_approve_retirement_statement
-> 400 {"code":"P0001",
        "message":"fdh_retirement_statements: this field is system-authoritative
                   and may not be written directly by the authenticated role"}

approval_status after: pending      approved_at: null      approved_by: null
```

That is verbatim the unfixed 0112 behaviour, and verbatim the FDH12-LD-1
defect signature. The full user journey therefore still terminates at the
approve step.

A caution for the next verification attempt: calling the same RPC **as the
service role** returns `"fdh12_approve_retirement_statement: authentication
required"`. That response is emitted by 0112's version of the function too, so
it distinguishes "the function exists" from "the function is missing" but says
nothing about whether 0113 landed. Only an authenticated-owner call does.

### 0114 — the provenance columns are still unguarded

Same authenticated user, their own `retirement_accounts` row:

```
PATCH retirement_accounts {"source_type":"retirement_statement_import"} -> 200 SUCCEEDED
PATCH retirement_accounts {"last_imported_at":"<chosen timestamp>"}     -> 200 SUCCEEDED
PATCH retirement_accounts {"last_import_application_id":null,
                           "last_imported_at":null}                     -> 200 SUCCEEDED
```

Cross-tenant, the integrity hole itself — Tenant B rewriting **B's own** row so
that it claims to have been written by **Tenant A's** import:

```
PATCH retirement_accounts?id=eq.<B's own account>
      {"last_import_application_id":"<Tenant A's fhip_import_applications.id>"}
-> 200 SUCCEEDED
```

### The positive control that rules out a bad request shape

Same user, same session, same request shape, same column name, on the FDH-9
table that already carries the equivalent 0091 guard:

```
PATCH income_sources {"last_imported_at":"<same timestamp>"}
-> 400 {"code":"P0001",
        "message":"income_sources: source_type/last_import_application_id/
                   last_imported_at are import-bridge provenance and may not be
                   written directly by the authenticated role"}
```

The guard pattern works in this database. It is simply absent from
`retirement_accounts`.

## What to do

1. Run `02_dev_verification.sql` in the DEV SQL Editor and paste the result
   grid back. It is read-only. PART D gives a one-line verdict per migration;
   PART A2 says whether 0114's two triggers exist at all and whether they are
   enabled; PART B says whether 0113's fix reached **both** of the two function
   bodies it replaces.
2. Re-apply whichever migration PART D reports as `NOT IN EFFECT`. Both files
   are `create or replace` / `drop trigger if exists` only — no schema change,
   no data change, safe to re-run, and safe to re-run even if partially
   applied:
   - `supabase/migrations/0113_fdh12_approve_rpc_authoritative_write_fix.sql`
   - `supabase/migrations/0114_fdh12_retirement_provenance_guards.sql`
3. Re-run `02_dev_verification.sql` and confirm PART D reads `APPLIED AND IN
   EFFECT` on both rows.
4. Re-run the live suite: `node scripts/fdh12_live_dev_certification.mjs`
   against a `next dev` started from this worktree on port 3212.

## A likely cause worth checking first

0113 replaces two functions and 0114 creates two functions plus two triggers.
If the SQL editor was given only part of a file — a selected region rather than
the whole buffer, which Supabase Studio will happily run and report as
successful — the result is exactly what is observed: no error, and no effect.
PART B is written specifically to catch the half-applied case, because it tests
both of 0113's replaced bodies independently rather than assuming that finding
one implies the other.
