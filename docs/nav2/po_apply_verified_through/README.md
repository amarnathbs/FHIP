# Risk-free "confirmed through" date: migration 0294, the new control, and your steps (DEV first)

Written 19-10-2026 for the Product Owner. Nothing here is applied anywhere. Nothing here is DEV or production evidence: every figure you paste back is the evidence. The full finding is in `docs/nav2/RISK_FREE_VERIFIED_THROUGH_REPORT_2026-10-19.md`.

Rules that stay: the address bar of the Supabase dashboard must contain `vqycarelcoijzwlpkpcz` for every DEV step and `twwpnltizhtjxhamyoxt` for every production step. Never paste an e-mail address, key or password back to me. If a step shows something other than what it says, stop and send me what you saw. Production has NO managed backups, so the backup step (section 4, step 2) is not optional.

## 1. What this is, in five lines

- On 19-10-2026 the repo rate series still showed "confirmed through 02-10-2026" after you submitted the rate file with 19-10-2026 typed in. The code path that moves that date works (proved against the real database function), so the likely reasons are the ones the screen hid from you: the date you typed was refused as a day in the future (the database used the UTC day, which is still 18-10-2026 on the morning of 19-10-2026 in India or Australia), or it was answered like a success when it could not move the date. SQL `P2` below settles which one it was, from facts.
- Migration `0294` fixes the day (India calendar day), makes the answer say whether the date moved, makes the weekly T-bill series ignore a date, and adds a dedicated function that confirms the repo rate is still current with only a date and a reason (no file).
- The screen gets a new box "Confirm the repo rate is still current", the "Verified through" field is cleared when you change the series, and a date typed for the T-bill series shows a warning and is not saved.
- The T-bill date 02-10-2026 that is stored today is harmless (the rate lookup, the freshness figure and the monitoring figure for a weekly series all ignore it). Leave it.
- The 02-10-2026 date of the repo series is fixed through the new box (section 5), not with a raw SQL update.

## 2. The files

| File | What it does | Writes? |
|---|---|---|
| `sql/P1_read_only_state.sql` | the two series, the date each is confirmed through, the last rate day | no |
| `sql/P2_read_only_what_happened_on_19_10.sql` | every upload batch, newest first | no |
| `sql/P3_read_only_state_log.sql` | every switch, terms and confirmed-through change, newest first | no |
| `sql/P4_read_only_function_version.sql` | which upload function does the database hold (the 0260 one with the re-submitted-file branch, or the 0294 one)? | no |
| `sql/B1_backup_series_and_log.sql` | copies the series table and the state log | two backup tables |
| `sql/B2_backup_check.sql` | proves the copies | no |
| `sql/0294_apply.sql` | migration 0294, one paste, safe to run twice (a byte-for-byte copy of `supabase/migrations/0294_nav2_risk_free_confirm_verified_through.sql`, a test keeps them equal) | three functions, no table, no row |
| `sql/C0294_check_after.sql` | one row, every value must be true | no |
| `sql/rollback_0294.sql` | step 2 of the rollback (section 6) | drops two functions |
| `sql/B3_drop_backups_after_release.sql` | removes the two backup tables, after a week | drops two backup tables |

Every file passes the editor-safety rules of `tests/unit/nav2/nav2MigrationPartsAndEditorSafety.test.ts` (checked by `tests/unit/nav2/nav2RiskFreeVerifiedThroughPackage.test.ts`).

## 3. DEV first

1. Open the DEV SQL editor. Run `P1_read_only_state.sql` and `P4_read_only_function_version.sql`. Paste the rows back. Expect `has_same_file_confirmation` true, `new_version` false and `confirm_function` false.
2. Run `sql/0294_apply.sql` (one paste). Expect "Success. No rows returned".
3. Run `sql/C0294_check_after.sql`. Expect one row, every value true. Run `P4` again: both true.
4. Deploy the code to DEV, or use the DEV preview of this branch. Sign in to DEV as an administrator who holds the risk-free upload permission. Open Admin, Risk-free Rate Data.
5. On the screen, check each of these and tell me what you saw:
   a. Change the Series dropdown after typing a date in "Verified through": the date field empties.
   b. Choose the T-bill series, type 02-10-2026 in "Verified through": an amber box says the date will not be saved.
   c. The new box "Confirm the repo rate is still current" shows "last rate change", "confirmed current through" and "today in India".
   d. Type a reason shorter than 20 characters and press the button: a red message under the button names the reason field.
   e. Type tomorrow's date with a long enough reason: the message says the day is still in the future and names today in India.
   f. Type today's India date with a long enough reason: a green message says the rate is confirmed current through that day. The History panel, "Switch and terms changes", has one new line that says "confirmed-through date" and shows your reason. If DEV holds no repo rate yet, the box refuses with "no published rate yet": that is correct, load a repo rate first.
   g. Press it again with the same date: a red message says the series is already confirmed through that day and a confirmation must be later. Nothing changes.

## 4. Production

Only after your own go-ahead and only after section 3 went as described.

1. Production SQL editor. Run `P1`, `P2`, `P3`, `P4` (all read only). Paste the four results back. `P2` and `P3` show whether the 19-10-2026 press ever reached the database: if there is no batch and no "Verified-through" row dated 19-10-2026, the screen refused it before the database was called, which is what the fix addresses.
2. Run `B1_backup_series_and_log.sql`, then `B2_backup_check.sql`. Expect saved equals now for both, and `copies_locked_to_service_role` true. Paste the row back.
3. Run `sql/0294_apply.sql` (one paste). Expect "Success. No rows returned". Run `C0294_check_after.sql`: one row, every value true. Paste it back.
4. Push the code (the two lines are in my report, a plain fast-forward, never force). Wait until Amplify shows Deployed. The order database first, code second is the safe one: the old screen keeps working with the new function (the function only adds to its answer), and the new screen against the old function still uploads and shows "the database did not report whether the date moved" and a 503 on the new box that names migration 0294.
5. Do section 5.

## 5. Fixing the repo rate date 02-10-2026 through the governed control (not a raw update)

1. Sign in to production as the administrator who holds the risk-free upload permission. Open Admin, Risk-free Rate Data.
2. In the box "Confirm the repo rate is still current" read the line: last rate change 07-10-2026, confirmed current through 02-10-2026, today in India.
3. "Confirmed through": type the day you actually checked the Reserve Bank of India announcements, normally today (19-10-2026 or later), as DD-MM-YYYY. Never a day you did not check.
4. "Reason": write what you checked, at least 20 characters, for example: Checked the RBI press releases up to today: no repo rate change since 07-10-2026.
5. Press "Confirm the repo rate is still current". Expect the green message "Recorded: the repo rate is confirmed current through 19-10-2026 (it was 02-10-2026)."
6. Check: the Series table row for the repo rate says "Fresh: N day(s) since last confirmed complete (19-10-2026); stale after 90" (N is 0 on the day you confirm). History, "Switch and terms changes", shows one new line with your reason and "by you".
7. Read-only proof, `P1` again: the repo row shows 19-10-2026, the T-bill row still shows 02-10-2026 (harmless, leave it). `P3` shows the new row. Paste both back.

## 6. Rollback

Nothing is lost by a rollback: 0294 touches no table, row or column.
1. Run `docs/nav2/po_apply_production/sql/parts/0260d.sql` again. It puts the upload function back exactly as it was.
2. Run `sql/rollback_0294.sql` (drops the two new functions).
3. Revert the code (the new box then shows nothing useful against the old database, and the old screen is back).
A confirmation row already written in the state log stays (it is permanent by design).

## 7. December 2026 re-verification (what to do and by when)

The repo rate is a policy-change series: the platform uses the last rate only while the series is confirmed current. It is stale 90 days after the confirmed-through date. If you confirm through 19-10-2026 the last safe day is **17-01-2027**: a Fund analytics report that needs the repo rate for a day after that reports the rate as unavailable.

1. Read the date of the Reserve Bank of India Monetary Policy Committee decision in early December 2026 from the RBI calendar (I have not verified that date and do not state it).
2. On the announcement day or after it, read the RBI press release.
3. If the repo rate is UNCHANGED: open the box "Confirm the repo rate is still current", type that day as "Confirmed through" and a reason such as: MPC decision of that day: repo rate unchanged at 5.50 percent (RBI press release). No file.
4. If the repo rate CHANGED: use "Upload rates (CSV)" with a one-row file for the repo series (observation_date = the day the new rate takes effect, value_percent = the new rate, frequency policy_change, the RBI press release as source_document, source_url, retrieved_on = today). Choose the repo series, check the file, type the same day as "Verified through", tick the attestation, upload. The answer under the button must say "The series is now confirmed through" that day. Then the box is not needed.
5. Whatever happened, confirm that the Series table now shows "Fresh" for the repo rate with the new day.
6. Put the next deadline in your calendar: 90 days after the day you confirmed, minus a week.
7. An RBI change between meetings is possible: if you read of one, do step 4 the same day.

## 8. Admin Architecture Standard

Capability affected: `riskFreeDataUpload` (`admin_users.can_upload_risk_free_data`). No new capability: confirming a series is an upload duty. The switch capability does not allow it.

| Clause | How it is met | Test |
|---|---|---|
| s2 capability | `confirm_risk_free_verified_through` checks `is_risk_free_data_admin()` inside; the route calls `requireRiskFreeCapability('upload')` | `nav2RiskFreeVerifiedThroughPglite.test.ts` (switch-only, no capability, ordinary user, anon refused with 42501), `nav2RiskFreeAdminRoutes.test.ts` (401 and 403 on the new route, fail-closed matrix, NC-A1) |
| s4 four layers | database function, route, page guard and nav entry are the existing ones | direct API: 401/403 matrix; database bypass: the function called directly as each wrong caller; direct table write refused |
| s6 privileged function | SECURITY DEFINER, fixed search_path, explicit jsonb return, execute revoked from public and anon, no dynamic SQL | catalog test in the PGlite suite |
| s8 explicit failure | every refusal is an exception with a sentence; the route turns it into 422 with that sentence, 403 for a capability refusal, 503 when the function is missing | `nav2RiskFreeVerifiedThroughRoutesPglite.test.ts` |
| s9 data boundary | global reference data only | no user data is read |
| s13 fail closed | a read or database error is an explicit error, never a success | route tests |
| s18 back navigation | no new page | the screen keeps its existing back link |

No exception to the standard is requested.
