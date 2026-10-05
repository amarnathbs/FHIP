# 0269 and 0270: two database fixes found in NAV2 Stage 3 (hand-over, DEV first)

Both files are in `supabase/migrations/`. Neither is applied anywhere. Both are small, forward-only and safe to run twice. Apply them to DEV only, in this order, then run the checks below. Production only after your own go-ahead.

Editor safety: each file passes the repository's editor-safety rules (`tests/unit/nav2/nav2MigrationPartsAndEditorSafety.test.ts` scans every migration numbered 0260 and above): ASCII only, no semicolon or quote inside a comment, no "from/into/join + word" inside a comment, no percent sign. Paste the whole file into the Supabase SQL editor and run it. If the editor ever complains, tell me the line and I will split it.

Numbers: 0269 and 0270 were free on every local branch on 06-10-2026 (the promo hardening branch holds 0264 to 0268). The two checker scripts cannot see unmerged branches, so re-check the numbers at merge.

## 0269 - a stored report can be read only while the owner is Premium

- Found: the report API answers 403 after Premium lapses, but the table policy only checked ownership. A lapsed user could still read the whole stored report straight from the table with their own session (reproduced on DEV with a fixture user: the direct read returned the report JSON).
- Changes: adds `nav2_viewer_has_premium()` (the same rule as every other reader: plan premium, start empty or not after today, end empty or not before today, end inclusive, UTC date) and replaces the select policy `own_read_nav2_fund_analytics_reports` with `auth.uid() = user_id and nav2_viewer_has_premium()`.
- Check on DEV after applying (SQL editor):

```
select policyname, qual from pg_policies where tablename = 'nav2_fund_analytics_reports';
select proname from pg_proc where proname = 'nav2_viewer_has_premium';
```

  The policy text must mention `nav2_viewer_has_premium`. Then, from the repository: `node scripts/nav2_stage3/j5_security.mjs` (server on port 3981). The check "PREMIUM LOST, DIRECT DATABASE READ" must turn from FAIL to PASS.
- Rollback: recreate the 0261 policy (`using (auth.uid() = user_id)`) and drop the function.

## 0270 - the monitoring snapshot answers inside the time limit

- Found: the admin page "Fund analytics health" showed an error on DEV, because `nav2_monitoring_snapshot()` returned "canceling statement due to statement timeout" for a signed-in administrator. Its three storage figures scanned the price table (about three million rows) three times.
- Changes: replaces only those three queries (one count of the table, one count of the rows on or after the changeover, the held instruments counted one by one on their key). Every figure keeps its meaning and value (proven equal to the 0262 function on a synthetic data set); the authorisation check, suppression rule and grants are unchanged.
- Check on DEV after applying: open `/admin/investment-intelligence/nav2-monitoring` as an administrator who holds the reference-data quality capability. The page must show the figures instead of an error. The timing cannot be proven offline, so this page load is the proof. If it still times out, tell me: the next step is to read the three counts from the catalogue estimate and label them approximate.
- Rollback: apply the function body of 0262 again.
