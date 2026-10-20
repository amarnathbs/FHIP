# Migration 0260 (parts a-e), 0261, 0262 and 0263: reconciliation evidence

Status: generated 06-10-2026 from the migration files in this repository. The PGlite proof is complete. The DEV comparison is **partial**: the read-only REST comparison matched exactly, and the catalog comparison (constraints, indexes, policies, grants, triggers, function bodies) is **not yet run**, because it needs SQL access to DEV that this session does not have. Nothing here touched production or wrote to DEV.

## 1. How the expected shape is obtained (not a hand list)

`scripts/nav2_schema_inventory.mjs prove` replays the whole migration chain up to 0259 in an in-process Postgres (PGlite, with the platform shim in `scripts/db-rebuild-check/shim.sql`), applies 0260-0263, and then runs ONE catalog query (`docs/nav2/dev_inventory/nav2_catalog_inventory.sql`) that returns, for every table the four migrations create plus the two capability columns on `admin_users`: every column (type, nullability, default, length, precision, identity), every constraint with its full definition, every index definition, the row-level-security flag and every policy, every table grant to `anon` and `authenticated`, every trigger definition, and for every function the identity arguments, result type, security mode, volatility, execute rights for the three roles, an exact body hash and a body hash that ignores comments and whitespace. The result is `docs/nav2/dev_inventory/expected_inventory.json`.

A bare `create table if not exists` proves nothing about a table that already exists with a different shape, so the comparison is on the real columns and constraints. The script's `compare` mode reports missing, extra and different entries by name; a function whose body differs only in comments (the hand-patched editor-safe copies) is reported separately as a comment-only difference.

## 2. What the four migrations create (from the generated inventory)

| Table | Created in | Columns | Constraints | Indexes | RLS | Policies | Triggers |
|---|---|---|---|---|---|---|---|
| `ii_risk_free_batches` | 0260a | 16 | 18 | 3 | on | 1 | 2 |
| `ii_risk_free_corrections` | 0260c | 9 | 11 | 1 | on | 1 | 2 |
| `ii_risk_free_observations` | 0260b | 14 | 19 | 3 | on | 1 | 2 |
| `ii_risk_free_refresh_attempts` | 0263 | 10 | 11 | 2 | on | 0 | 0 |
| `ii_risk_free_review_items` | 0260c | 12 | 10 | 2 | on | 1 | 0 |
| `ii_risk_free_series` | 0260a, 0260c | 11 | 16 | 1 | on | 1 | 0 |
| `ii_risk_free_series_state_log` | 0260c | 9 | 11 | 1 | on | 1 | 1 |
| `nav2_correction_events` | 0262 | 10 | 9 | 3 | on | 0 | 0 |
| `nav2_fund_analytics_reports` | 0261 | 16 | 21 | 3 | on | 1 | 1 |
| `nav2_report_nav_dependencies` | 0261 | 7 | 10 | 3 | on | 1 | 0 |
| `nav2_report_render_tokens` | 0261 | 5 | 8 | 2 | on | 0 | 0 |
| `nav2_result_cache` | 0261 | 13 | 9 | 4 | on | 0 | 0 |

`admin_users` gains `can_upload_risk_free_data` and `can_switch_risk_free_series` (part a). Four job-control rows are inserted DISABLED (`nav2_risk_free_weekly_refresh`, `nav2_fund_analytics`, `nav2_trigger_planner`, `nav2_correction_worker`, part e) and the two risk-free series are seeded with the PO-accepted terms (part a).

| Function | Created in | Result | Mode | Execute |
|---|---|---|---|---|
| `commit_risk_free_upload(p_series_id text, p_file_sha256 text, p_file_name text, p_rows jsonb, p_attested boolean, p_attestation_text text, p_entry_kind text, p_verified_through date)` | 0260d | jsonb | security definer | anon no, authenticated yes, service_role yes |
| `correct_risk_free_observation(p_series_id text, p_date date, p_new_value numeric, p_reason text)` | 0260e | jsonb | security definer | anon no, authenticated yes, service_role yes |
| `ii_risk_free_append_only()` | 0260b | trigger | invoker | anon yes, authenticated yes, service_role yes |
| `ii_risk_free_obs_guard()` | 0260b | trigger | invoker | anon yes, authenticated yes, service_role yes |
| `is_risk_free_data_admin()` | 0260a | boolean | security definer | anon no, authenticated yes, service_role yes |
| `is_risk_free_series_switch_admin()` | 0260a | boolean | security definer | anon no, authenticated yes, service_role yes |
| `nav2_capture_reference_correction()` | 0262 | trigger | security definer | anon yes, authenticated yes, service_role yes |
| `nav2_capture_risk_free_correction()` | 0262 | trigger | security definer | anon yes, authenticated yes, service_role yes |
| `nav2_monitor_cell(p_value bigint, p_user_derived boolean)` | 0262 | jsonb | invoker | anon no, authenticated yes, service_role yes |
| `nav2_monitoring_snapshot()` | 0262 | jsonb | security definer | anon no, authenticated yes, service_role yes |
| `nav2_refresh_attempt_summary()` | 0263 | jsonb | security definer | anon no, authenticated yes, service_role yes |
| `nav2_reports_immutable()` | 0261 | trigger | invoker | anon yes, authenticated yes, service_role yes |
| `pc6_nav_row_is_candidate(p_instrument_id uuid, p_price_date date, p_changeover_date date)` | 0261 | boolean | invoker | anon no, authenticated no, service_role yes |
| `record_risk_free_refresh_results(p_series_id text, p_rows jsonb, p_review_items jsonb, p_verified_through date)` | 0260d | jsonb | security definer | anon no, authenticated no, service_role yes |
| `resolve_risk_free_review_item(p_item_id uuid, p_decision text, p_note text)` | 0260e | jsonb | security definer | anon no, authenticated yes, service_role yes |
| `set_risk_free_series_state(p_series_id text, p_enabled boolean, p_terms_status text, p_reason text)` | 0260e | jsonb | security definer | anon no, authenticated yes, service_role yes |

Total in the inventory: 134 columns, 153 constraints, 28 indexes, 8 policies, 48 grants to anon or authenticated, 9 triggers, 16 functions.

## 3. Behaviour from empty, from partial, from complete, and on re-run (PGlite proof)

`node scripts/nav2_schema_inventory.mjs prove`, run on 06-10-2026 (about three minutes):

| Case | What was applied | Result |
|---|---|---|
| 1. From EMPTY, hand-run order | 0260 parts a, b, c, d, e one at a time, then 0261, 0262, 0263 | inventory hash `8e2b716727c50403` |
| 2. From EMPTY, CLI order | the whole 0260 file, then 0261, 0262, 0263 | **identical** hash |
| 3. From PARTIAL | part a alone (the half-applied shape), then every part, then 0261-0263 | **identical** hash |
| 4. From COMPLETE, re-run | every file applied a second time, parts and the whole file | **no error**, **identical** hash |

So the parts, the whole file and a half-applied start all end in exactly the same database, and re-running is harmless. This is PGlite evidence, not DEV evidence.

## 4. DEV comparison

### 4.1 Done: read-only REST comparison (`node scripts/nav2_schema_inventory.mjs dev-openapi`)

Run against `vqycarelcoijzwlpkpcz` (the script aborts unless the host is that project and aborts if any `PRODUCTION_` variable is present; it prints no key). Result on 06-10-2026: **13 tables, 134 columns, 11 callable functions: exact match** on table presence, column names, NOT NULL status, coarse column types, and which functions are callable. This also shows that 0263 (`ii_risk_free_refresh_attempts`, `nav2_refresh_attempt_summary`) is present on DEV.

### 4.2 Not yet done: catalog comparison (constraints, indexes, RLS policies, grants, triggers, function bodies)

The REST interface does not report these and this session has no SQL access to DEV. The operator runs, in the DEV SQL editor, the single read-only query in `docs/nav2/dev_inventory/nav2_catalog_inventory.sql`, saves the returned value as `actual.json` and runs `node scripts/nav2_schema_inventory.mjs compare actual.json`. Until that is done, the claim "DEV matches 0260-0263 exactly" is **not** made for constraints, indexes, policies, grants, triggers and function bodies.

Known, expected difference to look for: the hand-patched editor-safe copies of 0260e, 0261 and 0262 changed comment and string text only, so DEV function bodies may differ from the repository in comments; the comparison reports that as comment-only, not as a failure.

## 5. Re-running the checks

```
node scripts/nav2_schema_inventory.mjs prove           # regenerate the expected inventory and the four-state proof
node scripts/nav2_schema_inventory.mjs dev-openapi     # read-only DEV comparison (needs the DEV-only .env.local)
node scripts/nav2_schema_inventory.mjs sql             # the catalog query, to paste in the SQL editor
node scripts/nav2_schema_inventory.mjs compare actual.json
node scripts/nav2_0260_0262_pglite_verification.mjs    # the 80 behavioural checks (also NAV2_APPLY_MODE=parts and =partial)
```
