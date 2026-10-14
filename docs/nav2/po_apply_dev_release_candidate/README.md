# NAV2 release candidate: DEV hand-over (Product Owner applies, agent verifies)

Written 15-10-2026. **DEV only.** Project check before every step: the address bar of the Supabase dashboard must contain `vqycarelcoijzwlpkpcz` (DEV). It must NOT contain `twwpnltizhtjxhamyoxt` (production). Nothing in this folder is for production; the production pack is `docs/nav2/po_apply_production/`.

Why this exists: DEV already holds NAV2 migrations 0260 to 0263 and 0269 to 0271 (applied earlier by you). The release candidate adds two small migrations (0281 report idempotency key, 0282 held-back statement line count), changes the guard at the top of 0261 (not needed again on DEV: the guard accepts the text DEV already has), and needs the catalog comparison that could not be run before (the REST interface does not show constraints, indexes, policies, grants, triggers or function bodies).

## Rules

1. One file at a time. Paste the whole file, press Run. Read-only files answer ONE row (or one JSON value). Migration files answer "Success. No rows returned".
2. Every file here can be run twice safely.
3. If the editor shows an error, stop and send the error text exactly as shown and the file name. Do not edit the SQL by hand. (If you write SQL yourself: never write the words into, from or join followed by a word in a comment or a string. The editor mistook such words for statements on DEV once.)
4. Never paste a key, token, password or e-mail address back.

## The order

| # | Paste | Expect | What to send back |
|---|---|---|---|
| 1 | `sql/00_state_readonly.sql` | one row: 12 tables, 2 admin columns, 16 functions, 0281 false, 0282 false, the switches | the row |
| 2 | `sql/01_weekly_refresh_off.sql` | Success (it only changes the weekly switch if it is not already OFF; it was OFF when this was written) | "ok" |
| 3 | `sql/02_retention_function_identity.sql` | one row: `is_0261` true (DEV holds the 0261 text) or `is_0219` true; service role only | the row |
| 4 | `sql/02b_retention_function_behaviour.sql` | one row: every answer that is present equals its expected value | the row |
| 5 | `sql/02d_retention_fund_analytics_pin.sql` | one row: the pin answers are false, or `pin_sample_found` false (no report yet, acceptable) | the row |
| 6 | `sql/03_catalog_inventory.sql` | ONE jsonb value (named inventory) | save the value as `actual.json` in the repository folder and tell me, or paste it into a file I can read; I run `node scripts/nav2_schema_inventory.mjs compare actual.json` |
| 7 | `sql/10_migration_0281.sql` then `sql/11_check_0281.sql` | Success, then one row all true | the check row |
| 8 | `sql/12_migration_0282.sql` then `sql/13_check_0282.sql` | Success, then one row all true | the check row |
| 9 | `sql/03_catalog_inventory.sql` again | the same JSON, now with the two columns, the index, the constraint and the function of steps 7 and 8 | the value |
| 10 | `sql/00_state_readonly.sql` again | 0281 true, 0282 true, 17 functions | the row |
| 11 | `sql/30_fixture_residue_readonly.sql` (at the very end, after the agent has cleaned up) | all zero except `audit_events` and `manual_investments` | the row |

`sql/02c_retention_function_text.sql` is only needed if step 3 shows both `is_0219` and `is_0261` false: it prints the live function text.

Rollbacks (only if something goes wrong): `sql/90_rollback_0281.sql`, `sql/91_rollback_0282.sql`. Issued reports are not touched.

## What the agent does with the answers

* Step 6 and 9: the comparison with `docs/nav2/dev_inventory/expected_inventory.json` (derived by replaying the migrations from empty, from the historic partial 0260 state, from complete, and on re-run, all four identical).
* Steps 3, 4, 5: the retention function identity (arguments, return type, owner, grants, normalized checksum) and its behaviour on real rows.
* Steps 7 and 8 unlock the DEV proof of the idempotency key and of the held-back count. Until they are applied those two are PGlite-verified and unit-tested only.
