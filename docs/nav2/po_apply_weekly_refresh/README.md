# Automatic weekly RBI 91-day T-bill refresh (pack prepared 05-11-2026)

Product Owner decision 05-11-2026: stop loading the T-bill by hand. The app already contains the job (NAV2 Stage 2, built 03-10-2026): it reads RBI's own HTML pages politely, reads each auction result twice (a fixed parser and an AI second opinion), and a publication gate decides what to write. It has never run in production because its switch is OFF and nothing schedules it. This pack turns it on in the order the NAV2 release plan asks for (stage D): dry run, compare with RBI by eye, then schedule.

Nothing here changes any code. The only new repository file is migration `0317` (the schedule), which does nothing on any database that is not marked production and does nothing at all while the switch is OFF.

## What the job does on each run

| Case | What happens |
|---|---|
| The latest Wednesday auction is already stored | No T-bill request. Nothing written. |
| RBI has published a result and parser and AI agree | The yield is written as a new row (entry kind `weekly_refresh_job`). A stored value is never overwritten. |
| RBI printed "-" and no bids were accepted (like 21-10-2026) | A documented gap row is written, reason `no_accepted_bids`. |
| Parser and AI disagree, or the page layout changed | **Nothing is published.** A review item with the evidence is queued for you. |
| The release is not out yet | Nothing is written. The Thursday and Friday runs try again. |
| RBI refuses a page (403, 429, a verification page) | The whole run stops, nothing is bypassed, a review item says so, and the failure counter goes up. Load the rate by upload until RBI allows the read again. |
| The policy repo rate | The job only confirms the stored rate (moves the "verified through" date). A different value becomes a review item and is never written automatically. |

Failure alerting today: a review item for a blocked or doubtful read, plus the failure counter and last success time on the switch row (shown by `6_READ_ONLY_after.sql`). There is no e-mail alert.

RBI's terms: the site says "All Rights Reserved". You accepted that risk on 03-10-2026, and the report keeps "Source: Reserve Bank of India".

## Steps (production, project `twwpnltizhtjxhamyoxt`; each file in a new empty SQL tab)

| Step | File | What it does | Send me |
|---|---|---|---|
| 1 | `1_READ_ONLY_prechecks.sql` | Read only. Nine checks, every row should say true. | the result |
| 2 | `2_SWITCH_ON.sql` | Turns the switch on. Alone it does nothing: no schedule exists yet and manual calls are dry runs. | "done" |
| 3 | `3_DRY_RUN_request.sql` | Sends one dry run to the app. Reads RBI, writes nothing. The secret never leaves the database. | the request id |
| 4 | `4_READ_ONLY_dry_run_response.sql` | Wait about 60 seconds after step 3. Shows the refresh job's answer (other jobs share the same response table, so it filters on the job's version text): counts, outcomes and reasons only. | the whole row |
| 4b | `4b_READ_ONLY_response_by_request_id.sql` | The sure way to find the answer: change the 0 in it to the request id step 3 returned. Other scheduled jobs write to the same response table every minute, so step 4 can miss a late or failed answer. | the whole row |
| | | **Compare by eye:** open the RBI release for the 04-11-2026 auction and check the yield the dry run says it would publish. I will compare it too. Only go on if they agree. | |
| 5 | `5_SCHEDULE_weekly_refresh.sql` | Registers the two schedules (this is migration 0317). Wednesday 21:00 India time, then Thursday and Friday 09:00 India time. | "done" |
| 6 | `6_READ_ONLY_after.sql` | Read only. Shows the two jobs, the switch, the latest series rows and the last runs. Run it again after the first Wednesday run. | the result |

Rollback at any time: `ROLLBACK_switch_off_and_unschedule.sql` removes both schedules and switches the job off. Nothing already stored is deleted.

## Notes

- Step 5 only registers anything on a database that carries the production marker row (`platform_deployment_environment`). Step 1 checks that it does.
- A 401 in step 4 means the vault secret and the app's `CRON_SECRET` differ. Stop and send it to me.
- Manual upload keeps working exactly as before, whatever the job does.
- The vault secret used is `pc6_reference_ingest_cron_secret`, the same one the NAV schedules (0187, 0188) use.
- What the automated tests prove: the migration registers exactly the two jobs on a production-marked database and nothing otherwise, runs twice without duplicating, never switches the job on, and every file in this pack runs on a database built from the repository's own migrations. What they cannot prove: a real scheduler firing or a real call to RBI. That is what steps 3 and 4 and the first Wednesday run are for.
