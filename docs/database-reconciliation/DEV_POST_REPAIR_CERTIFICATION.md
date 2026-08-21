# DEV certification

**Environment: DEV `vqycarelcoijzwlpkpcz`.**
**Production `twwpnltizhtjxhamyoxt`: NOT TARGETED, NOT CONTACTED, NOT MODIFIED.**

The project reference was re-confirmed from `.env.local` before every DEV-facing
action, and every script in this reconciliation aborts if the URL does not
contain `vqycarelcoijzwlpkpcz`.

## Headline result

**DEV needed no schema repair.** It already matches the canonical schema
reconstructed from the migration definitions, across every in-scope object.

**No DDL was executed against DEV during this work.** All DEV access was
read-only schema introspection plus two constraint probes that were rejected by
the database (see below) and therefore wrote nothing.

## Zero writes to DEV — and why

This sandbox has no DDL capability against DEV, verified this session rather
than assumed:

| Attempt | Result |
|---|---|
| `supabase` CLI | not installed |
| `psql` / `pg_dump` | not installed |
| `POST /rest/v1/rpc/exec_sql` | `404 PGRST202` |
| `POST /rest/v1/rpc/execute_sql` | `404 PGRST202` |
| `POST /rest/v1/rpc/run_sql` | `404 PGRST202` |
| `POST /rest/v1/rpc/sql` | `404 PGRST202` |
| `POST /rest/v1/rpc/query` | `404 PGRST202` |
| `GET /rest/v1/schema_migrations` (public) | `404 PGRST205` |
| `GET` with `Accept-Profile: supabase_migrations` | `406 PGRST106` — only `public` and `graphql_public` exposed |

This matches every prior phase of this project: all 48 applied migrations were
run by the Product Owner pasting SQL into the Supabase Dashboard SQL editor.
`0049` requires the same handoff.

## Migration ledger findings

**There is no populated migration ledger.** `supabase_migrations` is not
exposed through PostgREST and no `schema_migrations` table exists in `public`.
Because every migration was applied through the Dashboard SQL editor — which
does not write ledger rows — Supabase never recorded a version for any of the 48
migrations.

This is the mechanical explanation for the whole defect: **no runner ever
evaluated migration identity, so nothing ever detected that two files claimed
version 0031.** Both simply ran. It also means there is no historical ledger to
rewrite, falsify, or preserve — a point the reconciliation strategy depends on.

## Technique used for each DEV claim

| Claim | Technique |
|---|---|
| Table exists / does not exist | PostgREST OpenAPI schema, `GET /rest/v1/` with the service-role key (enumerates every exposed relation) |
| Column names, types, defaults, nullability | Same OpenAPI document, per-relation `properties` |
| CHECK constraint contents | Behavioural `INSERT` probe with a negative control (below) |
| Row counts | `Prefer: count=exact` with `Range: 0-0`, aggregate only — no row content read |
| RLS behaviour | Certified on the fresh rebuild, not on shared DEV — production RLS was never weakened to test it |

## Expected vs DEV

Full matrix: `II_RESOURCES_EXPECTED_VS_DEV.md`.

| Scope | Result |
|---|---|
| In-scope tables in expected schema | 54 |
| In-scope tables in live DEV | 54 |
| Missing in DEV | **0** |
| Extra in DEV | **0** |
| Classified MATCH | **54 / 54** |
| Columns compared | **676** |
| Columns missing in DEV | **0** |
| Columns extra in DEV | **0** |
| Type mismatches | **0** |

Per module: Investment Intelligence 33/33 tables, Resources 20/20, Phase 0C 1/1,
FDH 24/24 (unchanged).

**Comparator negative control.** Deleting one column and injecting one fake
column into the comparison input made the comparator report exactly one missing
and one extra, proving it detects drift in both directions rather than passing
vacuously.

## The `financial_section_status` question, resolved

| Stage | Finding |
|---|---|
| **Expected** | `0031_financial_section_status.sql` creates a table named **`user_financial_section_status`** — columns `user_id`, `section`, `status`, `updated_at`; PK `(user_id, section)`; FK `user_id → auth.users(id) ON DELETE CASCADE`; CHECK on `section` (8 values) and on `status`; RLS enabled with policy *"own financial section status"* (`auth.uid() = user_id`, USING and WITH CHECK). `0032` widens the `status` CHECK to add `reviewed_with_data`. Three `ON CONFLICT DO NOTHING` backfills seed `not_applicable` rows from `user_profiles`. |
| **DEV before** | `financial_section_status` — **never existed, and was never supposed to.** `GET /rest/v1/financial_section_status` returns `404 PGRST205` with PostgREST's own hint *"Perhaps you meant the table 'public.user_financial_section_status'"*. The earlier "missing" report inferred the object name from the migration filename. |
| | `user_financial_section_status` — **present and populated**: 97 rows, e.g. `section=liabilities, status=reviewed_zero, updated_at=2026-08-15T07:33:56Z`. |
| **Repair** | **None required.** The table was never missing. It is re-emitted idempotently by `0049` purely so a fresh database can build it; against DEV that statement is a no-op. |
| **DEV after** | Unchanged — 97 rows, same structure. |
| **Fresh rebuild** | Present, structurally identical, RLS enabled, policy present. |

**Constraint verification by differential probe.** Schema introspection cannot
show CHECK bodies, so both migrations' constraints were confirmed behaviourally:

| Probe | Result | Interpretation |
|---|---|---|
| `status = 'reviewed_with_data'` | `409` / `23503` foreign-key violation | Passed the CHECK, failing later on the FK — so **0032's widened constraint is applied** |
| `status = 'BOGUS_VALUE'` (negative control) | `400` / `23514` CHECK violation | The CHECK is real and does reject invalid input |

Had only 0031's narrower constraint been present, `reviewed_with_data` would
have been rejected with `23514` exactly as `BOGUS_VALUE` was. It was not. Both
probes used a non-existent user id, so both were rejected and **neither wrote a
row**.

## Data preservation

`0049` has not been applied to DEV. These are the pre-application aggregate
counts (counts only — no row content was read), and the expected delta.

**Total: 5,669 rows across 54 in-scope tables. Expected delta on applying
0049: 0 for every table.**

Every object `0049` creates already exists in DEV; every `CREATE` is guarded
with `IF NOT EXISTS`, every `INSERT` with `ON CONFLICT DO NOTHING`, and there is
no `DROP TABLE`, no `DROP COLUMN` and no data-type change anywhere in it. The
zero-delta expectation was verified empirically: re-applying `0049` to an
already-reconciled database changed nothing across columns, constraints,
indexes, policies, RLS enablement and function bodies.

Largest populated tables, for reference:

| Module | Table | Rows |
|---|---|---|
| Resources | `resource_audit_log` | 4,224 |
| Resources | `resource_posts` | 306 |
| Resources | `resource_post_categories` | 279 |
| Resources | `resource_workflow_history` | 237 |
| Resources | `resource_post_tags` | 134 |
| Phase 0C | `user_financial_section_status` | 97 |
| Resources | `resource_post_versions` | 95 |
| Resources | `resource_related_content` | 79 |
| Investment Intelligence | `ii_audit_events` | 87 |
| Investment Intelligence | `ii_risk_free_rates` | 16 |
| Investment Intelligence | `ii_instrument_identifiers` | 9 |
| Investment Intelligence | `ii_instruments` | 8 |
| Investment Intelligence | `ii_sources` | 8 |

Full per-table counts were captured at reconciliation time and can be
regenerated read-only at any point.

## Convergence

| | Expected | Fresh rebuild | Live DEV | Converged |
|---|---|---|---|---|
| Investment Intelligence tables | 33 | 33 | 33 | YES |
| Resources tables | 20 | 20 | 20 | YES |
| Phase 0C tables | 1 | 1 | 1 | YES |
| FDH tables | 24 | 24 | 24 | YES |
| Total exposed relations | 155 | 155 | 155 | YES |
| In-scope columns | 676 | 676 | 676 | YES |

All four perspectives required by this reconciliation — repository migration
lineage, expected Investment Intelligence schema, expected Resources schema, and
actual DEV schema — plus the fresh-database rebuild, agree.

## Outstanding action

Apply `supabase/migrations/0049_reconcile_phase0c_resources_lineage.sql` to DEV
via the Supabase Dashboard SQL editor (Product Owner). Expected outcome: success,
zero rows affected. This is a consistency formality; DEV is already correct
without it.
