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

**Correction to what I said earlier.** The cron run has no AI second opinion. The AI reader needs a person to attribute the cost to (the per-user daily cap, migration 0284), and a scheduled run has none, so the run is the fixed parser alone. It is not "two independent readings".

**Second correction, and the Product Owner decision of 13-11-2026 ("option A").** The first real production dry run found that RBI's weekly NSDP page runs about **two weeks behind** the auction: on Friday 13-11-2026 its latest week was the one ended 30-10-2026, while the auction was 11-11-2026. The gate used to compare the auction with that older week, so every fresh auction (11-11-2026 at 5.8681%) was sent to review as `nsdp_mismatch` and nothing could ever publish automatically. The rule is now:

- The NSDP figure is compared **only when its week is the auction's week**. A page that has not reached that week is "not yet", never a mismatch.
- When the page is "not yet", the **parser's reading publishes on the release's own checks**: the yield follows from the printed cut-off price, the auction is a Wednesday, it is later than the stored value, and it is within 0.5 percentage points of the previous stored value. With no previous stored value, a Thursday auction, a changed layout, or any failed check, the case goes to review as before.
- Such a value carries the mark **`nsdp_pending`** in its checks (step 6 shows it as `checks=`).
- When the page catches up (about two weeks later) the same week is **compared**: a match changes nothing; a difference queues a review item `nsdp_backcheck_mismatch` with both figures. **The stored value is never changed by the job.**
- A page that cannot be read, or whose week is already **later** than the auction's, still sends the case to review.

## What the job does on each week

| Case | What happens |
|---|---|
| The latest Wednesday auction is already stored | No T-bill request. Only the weekly page is read, to confirm the policy rate. |
| RBI has published a result, the parser reads it, the release's own checks pass and the weekly page matches **or has not reached that week yet** | The yield is written as a new row (entry kind `weekly_refresh_job`). A stored value is never overwritten. When the page had not reached the week, the row carries `nsdp_pending` and is compared with the page later. |
| RBI printed "-" and no bids were accepted (like 21-10-2026) | A documented gap row is written, reason `no_accepted_bids`. |
| The parser failed (changed layout), a release check fails, the weekly page covers the week and **differs**, the page cannot be read, or its week is already later than the auction's | **Nothing is published.** A review item with the evidence is queued for you. |
| The week is missed (RBI had no release in any window) | The next windows look for it again for four weeks and load it with the same checks. If the current week is still not loaded after Saturday 03:44 UTC, one review item and one e-mail say so. |
| An earlier `nsdp_pending` value differs from the weekly page once the page shows its week | The stored value is **left as it is**. A review item `nsdp_backcheck_mismatch` with both figures is queued: compare with the RBI release and correct by upload if the release was misread. |
| The release is not out yet | Nothing is written. The job waits 6 hours and then the next window starts the week again. |
| RBI refuses a page (403, 429, a verification page, a robots refusal) | The job stops, makes **no further request for 6 hours**, queues one review item, and the failure counter goes up. Load the rate by upload until RBI allows the read again. |
| A slow answer or a timeout | Nothing is decided; the next call tries the same step again. |
| The policy repo rate | The job only confirms the stored rate (moves the "verified through" date). A different value becomes a review item and is never written automatically. |

Failure alerting today: a review item for a blocked or doubtful read, plus the failure counter and last success time on the switch row (shown by `6_READ_ONLY_after.sql`). There is no e-mail alert.

RBI's terms: the site says "All Rights Reserved". You accepted that risk on 03-10-2026, and the report keeps "Source: Reserve Bank of India".

## Catch-up and the e-mail alert (Product Owner decision 13-11-2026)

**Catch-up.** Each call first works out which of the last **four** weekly auctions has no stored row. A week counts as covered when a row (a value or a documented gap) is dated Monday to Friday of that week, so a holiday-shifted Thursday auction is not mistaken for a missing Wednesday. The job works on the current week first. When that is done (or waiting for a release that is not out yet) it works on the **newest missing earlier week**, with the same three steps and the same gate, one auction per three calls. Rules that keep it safe:

- an earlier week that was already decided (for example sent to review) is never retried; a week that is cooling off is skipped;
- **a refusal by RBI on any auction stops requests for every auction** until its six hours are over; a release that is merely not out yet for an old week does not block the current one;
- the gate publishes a catch-up on the release's own checks, comparing with the nearest earlier stored value (not the latest) for the 0.5 point band, and marks it `nsdp_not_comparable` when the weekly page has already moved past that week (or `nsdp_pending` when it is only a week behind). Every other check still applies: weekday, the yield following from the printed price, nothing already stored for that date, a covering page still decides, an AI-only reading still needs the page;
- a catch-up of an earlier month uses the month archive form of RBI's listing page, which has **not** been exercised against the live site yet (the current month, which covers a missed 04-11-2026, does not need it).

**E-mail alert.** An e-mail goes out through the same Resend mail path as the Contact form, only on a **live** call and only **once per case**. The case is first recorded as one open review item (the database keeps one open item per date), and the e-mail is sent only when that item is new. Three cases: RBI refused a page; a result was not published and waits in the review queue; the current week is still not loaded after the Friday windows and the **Saturday retry** (checked after Saturday 03:44 UTC, just before the last call of the Saturday window). A dry run never sends. A missing setting, a provider that is down or a slow answer never fails the step; the answer shows a `mail` line (`sent`, `not_configured`, `failed`, `skipped_time`).

**One setting is needed for the e-mail:** `RISK_FREE_ALERT_TO_EMAIL`, the address that receives the alert, as an environment variable in the Amplify app (the build already forwards names beginning `RISK_FREE_ALERT_`, and the sender and API key are the ones the Contact form uses). Without it nothing is sent and the review item still records the case.

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
| 5 | `5_SCHEDULE_weekly_refresh.sql` | Registers the two schedules (migration 0320, which replaces what 0319 registered, so it is right whether or not 0319 was applied). Wednesday 21:00 to 21:15 India time, then Thursday, Friday and Saturday 09:00 to 09:15 India time, four calls five minutes apart. | "done" |
| 6 | `6_READ_ONLY_after.sql` | Read only. Shows the two jobs, the switch, the latest step rows, the latest series rows and the last runs. Run it again after the first Wednesday. | the result |

What each dry-run answer should say (`content_start` of 4b):

- call 1: `"step":"listing"`, `"mode":"dry_run"`, `listing` found with the release date, `requests` pages 1 and robots 1, `elapsedMs` well under 25000;
- call 2: `"step":"release"`, `reading.parser` with the auction date, cut-off price and yield, `requests` pages 1 and robots 0;
- call 3: `"step":"decide"`, `tbill` with the outcome (`publish` and the yield, or `no_release_yet`), `repo`, `wrote` both null, and a `backCheck` line when the weekly page was read. With the weekly page behind the auction, the outcome is `publish` and its detail lists `nsdp_pending` among the checks.

A dry run's only write is the scratch row in the step table; it never writes a rate or a review item and never marks the week done. If a call says `"step":"waiting"`, RBI refused something and the job is cooling off: send me the row.

Rollback at any time: `ROLLBACK_switch_off_and_unschedule.sql` removes both schedules and switches the job off. Nothing already stored is deleted, and the step table stays (it holds numbers only).

## Notes

- Step 5 only registers anything on a database that carries the production marker row (`platform_deployment_environment`). Step 1 checks that it does.
- Migration 0317 (the first schedule, one call per run) was never applied. If it ever is, 0319 replaces its two jobs (same names), so the old way cannot keep calling.
- A 401 in step 4 means the vault secret and the app's `CRON_SECRET` differ. Stop and send it to me.
- Manual upload keeps working exactly as before, whatever the job does.
- The vault secret used is `pc6_reference_ingest_cron_secret`, the same one the NAV schedules (0187, 0188) use.
- What the automated tests prove: the three steps decide and write exactly what the one-request run does on the same pages; every step ends inside 28 seconds even when RBI takes six seconds per request; a refusal stops the job for six hours; a finished week makes no request; the migrations register exactly the two jobs on a production-marked database and nothing otherwise; every pack file runs on a database built from the repository's own migrations; fourteen deliberate breaks of the code were each caught. What they cannot prove: how fast the real RBI site answers from Amplify, a real scheduler firing, and the real call to RBI. That is what the three dry-run calls and the first Wednesday run are for, and the `requestMillis` and `elapsedMs` figures in each answer show the real speed.
