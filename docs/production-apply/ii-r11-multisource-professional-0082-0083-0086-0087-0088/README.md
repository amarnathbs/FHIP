# Production apply package: II-R11 Multi-source & Professional Expansion (0082/0083/0086/0087/0088)

Prepared by an agent with **no ability to execute SQL against production**
and **no authorization to push to `origin/main`**. Everything in this folder
is for a human to run. Nothing here has been applied to production.

## Ledger (confirmed 2026-08-26 via read-only publishable-key REST probes with negative controls against `app.financialhealthplatform.com`'s live production Supabase project `twwpnltizhtjxhamyoxt`, `scripts/ii_r11_production_readonly_schema_check.mjs`)

| Migration | Repository | DEV | PROD | Action needed |
|---|---|---|---|---|
| `0082_ii_r11_cross_source_reconciliation.sql` | present, frozen | Applied (superseded in effect by 0086, see that file's own header — DEV's actual CHECK constraints came from 0086's replay, not 0082 directly) | **NOT applied** (`ii_source_precedence_policy` absent: PGRST205) | Apply `01_0082_...sql` |
| `0083_ii_r11_professional_access.sql` | present, frozen | Applied, live-verified (13/13 professional cert) | **NOT applied** (all six `professional_*` tables absent: PGRST205) | Apply `02_0083_...sql` after 0082 |
| `0086_ii_r11_0082_completion.sql` | present, frozen | Applied — idempotent full replay of 0082's effects, confirmed the actual live source of DEV's constraints | **NOT applied** (same absent table as 0082) | Apply `03_0086_...sql` after 0083 — it is a complete, idempotent replay of 0082, safe to run regardless of 0082's own success |
| `0087_ii_r11_authoritative_forgery_guard.sql` | present, frozen | Applied, live-verified (closed LIVE-R11-P11 same-user authoritative forgery) | **Cannot be confirmed present or absent via anon-key REST** — it only alters RLS policies + adds a trigger on `ii_transactions`/`ii_reconciliation_cases`, both of which already exist in production from 0033/0035 regardless of R11's own apply state. See "0087/0088 verification limits" below. | Apply `04_0087_...sql` after 0086 |
| `0088_ii_r11_report_access_log_cascade_fix.sql` | present, frozen | Applied, live-verified (FK cascade fix) | **Cannot be confirmed present or absent via anon-key REST** — same reasoning as 0087; also its target column (`professional_report_access_log`) does not exist in production at all until 0083 lands. | Apply `05_0088_...sql` after 0087 |

### Canonical ordering context (why these five numbers, not others)

Production's migration ledger, confirmed via the same read-only method, currently
stands at: `0001`–`0078`, `0084`, `0085`, `0089`, `0090` (87 files would exist if
R11 were merged in; without it, 82). This exactly matches the certified
integration tree built alongside this package (see
`docs/investment-intelligence/R11_MIGRATION_RECONCILIATION.md` for the
0084→0086 renumber history). **0079/0080/0081 are real, allocated migration
numbers belonging to the not-yet-merged `feature/app-review-remainder-input-ux-currency-onboarding`
branch — they are absent from both DEV and production on purpose (not part of
main, not part of this package) and must not be treated as a gap to fill.**

Applying this package brings production's migration ledger to exactly the
same 87-file set already certified on DEV and in the fresh integration branch
— no migration is skipped, no number is cherry-picked out of canonical order.
`0084`/`0085`/`0089`/`0090` are **prerequisites already satisfied** in
production (confirmed independently in this same check — see script output)
and require no action here.

## How to apply

1. Open the production Supabase project's SQL Editor (project `twwpnltizhtjxhamyoxt`, the one serving `app.financialhealthplatform.com` — **not** the DEV project `vqycarelcoijzwlpkpcz`).
2. Run `01_0082_ii_r11_cross_source_reconciliation.sql` in full.
3. Run `02_0083_ii_r11_professional_access.sql` in full.
4. Run `03_0086_ii_r11_0082_completion.sql` in full (idempotent completion/replay of 0082 — safe even though 0082 was just applied fresh in step 2, by design).
5. Run `04_0087_ii_r11_authoritative_forgery_guard.sql` in full.
6. Run `05_0088_ii_r11_report_access_log_cascade_fix.sql` in full.
7. Run `06_production_verification.sql` (Part A first — read-only; Part B second — self-cleaning, wrapped in a transaction that always rolls back). Paste the full output back.
8. Optionally also re-run `node scripts/ii_r11_production_readonly_schema_check.mjs` (from the fresh integration branch, or any branch carrying it) as an independent cross-check — every ABSENT line for `ii_source_precedence_policy` and the six `professional_*` tables should flip to PRESENT.

None of these five files are self-wrapped in an explicit `begin;`/`commit;`
block (unlike `0084`, which is) — this is a genuine property of how they were
authored on DEV, not something this package may alter (migrations 0082,
0083, 0086, 0087, 0088 are frozen and must not be edited, renamed, or
re-wrapped). If your SQL Editor does not already treat one pasted script as a
single implicit transaction, wrap each file's contents in `begin; ... commit;`
yourself before running it, or run all five inside one manually-opened
transaction so a failure partway through does not leave a half-applied file.

## 0087/0088 verification limits (read this before treating the ledger table above as final)

`0087` and `0088` do not create new tables or columns — they alter **RLS
policies**, add **one trigger** (`trg_ii_reconciliation_cases_authoritative_write`
on `ii_reconciliation_cases`), and replace **two foreign-key constraints**
(on `professional_report_access_log`, a table that itself doesn't exist until
`0083` lands). None of `pg_policies`, `information_schema.triggers`, or
`information_schema.table_constraints` are exposed via PostgREST to an
anonymous/publishable-key caller by default, so **no read-only REST probe run
by this agent can prove whether 0087/0088 were already, separately, applied
to production before this package**. Given production is confirmed to have
0% of 0082/0083/0086 applied (their tables are genuinely absent), and given
this project's own standing collision-guard discipline (never apply migrations
out of canonical order), it is a reasonable — but not independently
proven — inference that 0087/0088 are equally unapplied. `06_production_verification.sql`
Part A queries `pg_policies`/`pg_trigger`/`information_schema` directly via the
SQL Editor (which runs with full catalogue visibility, unlike anon REST) to
settle this definitively before you apply anything — **run Part A first, by
itself, before running any of the `0*.sql` files above**, to confirm none of
0087/0088's objects already exist under a different application path.

A full **live-behavioural** proof that 0087's forgery guard rejects a real
same-user forgery attempt in production (matching the DEV reproduction in
`R11_ACCEPTANCE_REPORT.md`, LIVE-R11-P11) requires either:
- a human with the production **service-role key** running the equivalent of
  `scripts/r11_professional_live_dev_tests.mjs` against production with a
  real synthetic auth user (created via Supabase Admin API, not exposed to
  the anon/publishable key this agent has), or
- the SQL-level trigger/constraint checks in `06_production_verification.sql`
  Part B, which simulate the same forgery attempt directly in SQL (bypassing
  PostgREST/RLS-as-the-only-gate distinction) inside a transaction that
  always rolls back.

This agent did **not** create a real production auth user, request a
service-role key, or perform any write against production. Both are
explicitly out of this agent's authorization and technical ability in this
environment.

## What was and was not verified by the agent

- **Verified (read-only, publishable-key REST, negative-controlled):**
  current absence of `ii_source_precedence_policy` and all six
  `professional_*` tables in production; presence of all four prerequisite
  migrations' objects (`0078` property_liability_links, `0084`/`0089`/`0090`
  SMSF tables + RPCs, confirmed independently of and consistent with the
  SMSF package's own ledger).
- **NOT performed by the agent — requires human execution:**
  - Actually applying `01`–`05`.
  - `06_production_verification.sql` Part A's catalogue-level confirmation
    that 0087/0088's specific policies/trigger/constraints are not already
    present under a different path (recommended to run FIRST, before
    applying anything).
  - `06_production_verification.sql` Part B's live behavioural simulation of
    the 0087 forgery guard and 0088 cascade fix — mutating statements
    against production, outside this agent's authorization and technical
    ability. The script is self-cleaning (rolls back its own transaction)
    but must be run by a human.
  - A real end-to-end reproduction of LIVE-R11-P11 against production using
    the production service-role key, which this agent does not have and
    must not seek.
