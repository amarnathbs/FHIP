# Automatic weekly RBI 91-day T-bill refresh (pack prepared 05-11-2026, rebuilt as three short steps 09-11-2026)

Product Owner decision 05-11-2026: stop loading the T-bill by hand. The app already contains the job (NAV2 Stage 2, built 03-10-2026): it reads RBI's own HTML pages politely, a fixed parser reads the auction result, the weekly NSDP page cross-checks it, and a publication gate decides what to write. It has never run in production because its switch was OFF and nothing scheduled it. This pack turns it on in the order the NAV2 release plan asks for (stage D): dry run, compare with RBI by eye, then schedule.

## What changed on 09-11-2026, and why

The first real production dry run (request 199247) came back **HTTP 504 with an empty body**. Amplify ends every request at 28 seconds whatever the route declares, and one call that reads robots.txt, the month listing, the release and the weekly page, paced at 4 seconds, did not fit. The job is now cut into **three short steps**, one per call:

| Step | What the call does | Requests to RBI |
|---|---|---|
| listing | robots.txt, then the month listing (and the month archive when the listing shows another month) | robots.txt + 1 page (2 pages for another month) |
| release | the one "Treasury Bills: Full Auction Result" release; the fixed parser reads it | 1 page (robots.txt is not read again) |
| decide | the weekly NSDP page; cross-check; the decision; the writes | 1 page |

Each step keeps what it read in a small table, `ii_risk_free_refresh_stage` (migration 0318): numbers and pointers only, never page text. The route simply does "the next step", so the schedule calls it four times, five minutes apart (three steps and one spare for a slow answer). A call that finds the week already done makes no request. A step never starts a request after 12 seconds and no request may last more than 10, so a step ends in about 22 seconds at the very worst. The request budget for the week is the same four pages as before.

**Correction to what I said earlier.** The cron run has no AI second opinion. The AI reader needs a person to attribute the cost to (the per-user daily cap, migration 0284), and a scheduled run has none, so the run is the fixed parser plus the NSDP cross-check. That is enough to publish (a single reading with a matching NSDP value is published, and a mismatch or a missing NSDP page goes to review), but it is not "two independent readings".

## What the job does on each week

| Case | What happens |
|---|---|
| The latest Wednesday auction is already stored | No T-bill request. Only the weekly page is read, to confirm the policy rate. |
| RBI has published a result, the parser reads it and the NSDP value matches | The yield is written as a new row (entry kind `weekly_refresh_job`). A stored value is never overwritten. |
| RBI printed "-" and no bids were accepted (like 21-10-2026) | A documented gap row is written, reason `no_accepted_bids`. |
| The parser failed (changed layout) or the NSDP value differs or is missing | **Nothing is published.** A review item with the evidence is queued for you. |
| The release is not out yet | Nothing is written. The job waits 6 hours and then the next window starts the week again. |
| RBI refuses a page (403, 429, a verification page, a robots refusal) | The job stops, makes **no further request for 6 hours**, queues one review item, and the failure counter goes up. Load the rate by upload until RBI allows the read again. |
| A slow answer or a timeout | Nothing is decided; the next call tries the same step again. |
| The policy repo rate | The job only confirms the stored rate (moves the "verified through" date). A different value becomes a review item and is never written automatically. |

Failure alerting today: a review item for a blocked or doubtful read, plus the failure counter and last success time on the switch row (shown by `6_READ_ONLY_after.sql`). There is no e-mail alert.

RBI's terms: the site says "All Rights Reserved". You accepted that risk on 03-10-2026, and the report keeps "Source: Reserve Bank of India".

## Steps (production, project `twwpnltizhtjxhamyoxt`; each file in a new empty SQL tab)

| Step | File | What it does | Send me |
|---|---|---|---|
| 1 | `1_READ_ONLY_prechecks.sql` | Read only. Ten checks. Every row should say true except "step table exists" (until step 1b) and "switch is OFF" (if you already did step 2). | the result |
| 1b | `1b_APPLY_0318_stage_table.sql` | Creates the small step table (migration 0318). Adds a table only; no rate, review item or setting is touched. | "done" |
| 2 | `2_SWITCH_ON.sql` | Turns the switch on. Alone it does nothing: no schedule exists yet and manual calls are dry runs. (Already done on production.) | "done" |
| 3 | `3_DRY_RUN_request.sql` | Sends one dry run to the app. **Run it three times** (a minute apart): the first call does the listing step, the second the release step, the third the decide step. Reads RBI politely, writes no rate and no review item. | each request id |
| 4b | `4b_READ_ONLY_response_by_request_id.sql` | After each call, wait about 40 seconds, change the 0 in it to that call's request id and run it. | each whole row |
| 4 | `4_READ_ONLY_dry_run_response.sql` | The answer of the latest refresh call, found by its version text (other jobs share the response table). 4b is the sure way. | the whole row |
| | | **Compare by eye:** the release call (second) shows the yield the parser read; open the RBI release for the 04-11-2026 auction and check it. The third call says what the job would publish. I will compare too. Only go on if they agree. | |
| 5 | `5_SCHEDULE_weekly_refresh.sql` | Registers the two schedules (migration 0319). Wednesday 21:00 to 21:15 India time, then Thursday and Friday 09:00 to 09:15 India time, four calls five minutes apart. | "done" |
| 6 | `6_READ_ONLY_after.sql` | Read only. Shows the two jobs, the switch, the latest step rows, the latest series rows and the last runs. Run it again after the first Wednesday. | the result |

What each dry-run answer should say (`content_start` of 4b):

- call 1: `"step":"listing"`, `"mode":"dry_run"`, `listing` found with the release date, `requests` pages 1 and robots 1, `elapsedMs` well under 25000;
- call 2: `"step":"release"`, `reading.parser` with the auction date, cut-off price and yield, `requests` pages 1 and robots 0;
- call 3: `"step":"decide"`, `tbill` with the outcome (`publish` and the yield, or `no_release_yet`), `repo`, `wrote` both null.

A dry run's only write is the scratch row in the step table; it never writes a rate or a review item and never marks the week done. If a call says `"step":"waiting"`, RBI refused something and the job is cooling off: send me the row.

Rollback at any time: `ROLLBACK_switch_off_and_unschedule.sql` removes both schedules and switches the job off. Nothing already stored is deleted, and the step table stays (it holds numbers only).

## Notes

- Step 5 only registers anything on a database that carries the production marker row (`platform_deployment_environment`). Step 1 checks that it does.
- Migration 0317 (the first schedule, one call per run) was never applied. If it ever is, 0319 replaces its two jobs (same names), so the old way cannot keep calling.
- A 401 in step 4 means the vault secret and the app's `CRON_SECRET` differ. Stop and send it to me.
- Manual upload keeps working exactly as before, whatever the job does.
- The vault secret used is `pc6_reference_ingest_cron_secret`, the same one the NAV schedules (0187, 0188) use.
- What the automated tests prove: the three steps decide and write exactly what the one-request run does on the same pages; every step ends inside 28 seconds even when RBI takes six seconds per request; a refusal stops the job for six hours; a finished week makes no request; the migrations register exactly the two jobs on a production-marked database and nothing otherwise; every pack file runs on a database built from the repository's own migrations; fourteen deliberate breaks of the code were each caught. What they cannot prove: how fast the real RBI site answers from Amplify, a real scheduler firing, and the real call to RBI. That is what the three dry-run calls and the first Wednesday run are for, and the `requestMillis` and `elapsedMs` figures in each answer show the real speed.
