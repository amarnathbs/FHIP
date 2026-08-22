# 0058 reconciliation — clean-rebuild certification

Tool: `node scripts/db-rebuild-check/replay.mjs` (PGlite/WASM, isolated,
in-memory — no connection to DEV). Re-run independently in this session
(2026-08-23), twice in succession, on integration-branch commit `3e65043`
plus this reconciliation's own doc/tooling commits.

## Result

```
REPLAY COMPLETE: 63/63 migrations applied with zero manual intervention
PLATFORM SUBSTITUTIONS (2):
  - 0010_module9_reports.sql: "create extension if not exists pg_cron;" -> no-op (shimmed)
  - 0010_module9_reports.sql: "create extension if not exists pg_net;" -> no-op (shimmed)
FRESH-REBUILD MANIFEST: {"tables":170,"columns":2221,"constraints":2274,"indexes":513,"policies":197,"functions":13,"triggers":2,"views":0}
tables=170 rls_enabled=170 rls_disabled=0
ii tables: 38
resource tables: 20
fdh tables: 34
user_financial_section_status present: true
```

- **63/63 migrations replay cleanly** from an empty database, `0001`
  through `0063`, in filename order — including `0058_fdh3_document_
  lifecycle_upload_storage.sql` and the renumbered `0059`-`0063` R6 chain,
  immediately adjacent, with no version gap and no collision.
- **170 tables, all 170 RLS-enabled** (`rls_disabled=0`).
- The two platform substitutions (`pg_cron`/`pg_net` extension no-ops) are
  pre-existing and unrelated to this reconciliation — present in every
  clean-rebuild run across this project's history, shimmed because PGlite
  does not ship those extensions.
- Module table counts (ii=38, resources=20, fdh=34) match the counts
  established by the prior migration-lineage reconciliation and FDH-2
  closure, confirming no table was accidentally dropped, duplicated, or
  misattributed by this reconciliation's renumbering.

## Idempotency (order/run-to-run equivalence)

The replay was executed twice, back to back, in two independent PGlite
instances:

```
node scripts/db-rebuild-check/replay.mjs > replay1.txt
node scripts/db-rebuild-check/replay.mjs > replay2.txt
diff replay1.txt replay2.txt
-> (no output — files are byte-identical)
```

Both runs produced **byte-identical** output — same table/column/
constraint/index/policy/function/trigger counts, same RLS-enabled count,
same module breakdowns. This is expected (nothing about the SQL content
changed by the rename, only the filenames the replay script sorts by), and
is confirmed here rather than assumed, per the governance spec's explicit
requirement (section G).

## Order equivalence (relative execution order of the two disjoint chains)

Since FDH-3's `0058` and Investment Intelligence R6's `0059`-`0063` are
schema-disjoint (confirmed object-by-object in `0058_FDH3_MANIFEST.md` /
`0058_II_R6_MANIFEST.md`), their relative execution order should not affect
the final schema. Verified directly rather than assumed: a second, isolated
migration directory was built with FDH-3's file renamed to sort AFTER the
entire R6 chain (`9058_fdh3_document_lifecycle_upload_storage.sql`, R6's
internal `0059`→`0063` order preserved), and replayed independently:

```
  ok 0057_fdh2_closure_research_corrections.sql
  ok 0059_ii_r6_p1_tax_engine.sql
  ok 0060_ii_r6_final_reference_seed.sql
  ok 0061_ii_r6_final_tax_profile.sql
  ok 0062_ii_r6_final_rls_forgery_fix.sql
  ok 0063_ii_r6_debt_fund_fix_reference_seed.sql
  ok 9058_fdh3_document_lifecycle_upload_storage.sql

REPLAY COMPLETE: 63/63 migrations applied with zero manual intervention
FRESH-REBUILD MANIFEST: {"tables":170,"columns":2221,"constraints":2274,"indexes":513,"policies":197,"functions":13,"triggers":2,"views":0}
```

The resulting schema fingerprint (`fresh_manifest.json`, full table/column/
constraint/index/policy/function/trigger dump) is **byte-for-byte identical**
to the normal-order run's manifest (`diff` produced no output). Order does
not matter, confirming the `CONFLICTING = none` classification is not just
a name-collision absence but a genuine behavioural independence.

## What this proves

A fresh Supabase/Postgres database — with no manual intervention, no
paste-order guessing, no "run this file before that one" tribal knowledge —
reconstructs the full FHIP schema deterministically from `supabase/
migrations` alone. Before this reconciliation, that was not true: two
different files both claimed `0058`, so a naive lexicographic replay would
either apply both under an arbitrary tie-broken order (masking the
collision) or a stricter tool would refuse to proceed at all. Both failure
modes are now closed.
