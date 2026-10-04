# Factsheet benchmark reader: operating instructions

Status: BUILT, SHIPS OFF, NOT SCHEDULED. Migration `0252`. Admin Architecture Standard sections 2, 4, 6, 7, 8, 9, 13, 15 apply (see the capability table below).

## What it does

Once a month, for the schemes users actually hold (an instrument with at least one transaction that is neither `reversed` nor `review_required`), it reads the fund house's OWN latest factsheet (or SID / addendum) and records the benchmark the fund house DECLARES: the Tier-1 and additional benchmark names, the composition of a composite, the source document (address, title, document date), when it was read, a SHA-256 of the exact bytes, how it was extracted and how sure we are. **Facts only. It never reads, stores or shows performance figures, index levels or returns from a factsheet.**

History is append-only. Each reading is a dated record. An unchanged benchmark is just "confirmed on that month". A changed benchmark (or composition) is a NEW effective-dated version (effective from the date the document states; otherwise the first day of the document's month, flagged `estimated`) and goes to the admin review queue. The earlier version stays on record, so a holding period that straddles a change can use the benchmark in force for each portion (`buildTimeline` / `portionsForHolding` in `factsheetReader/decision.ts`).

## What is published, and what is not

| Situation | What happens |
|---|---|
| A scheme's first reading, clean single index, verified catalogue entry, high confidence, complete evidence | Recorded as "awaiting confirmation". Nothing is published. |
| The same benchmark again in a LATER month, still deterministic (text-pattern pass), same verified entry, evidence complete | Proposed and published through the existing `auto_publish_benchmark_mapping` (effective from the FIRST sighting's date). |
| A changed benchmark | New version, `pending_review`, an `admin_judgement` proposal if it matches a verified series. Never auto-published. |
| A composite, a gold / silver price, an index the catalogue does not hold | Recorded as `unsupported_composite` / `unsupported_commodity` / `no_catalogue_match` with the composition stored. Review queue. Never published. The scheme is shown as "Declared benchmark: <name> (cannot be compared with the data we hold)" and is NOT given a category benchmark. |
| Read by the AI pass only; text-pattern and AI disagree; low confidence; a document type of "other"; no document date; a conflict with an admin-entered mapping | Review queue. Never auto-published. |
| A price index vs a total-return requirement | Never matched (the existing `benchmarkNameMatcher`). |

## The two gates and the switch

1. **Terms gate (per source).** `ii_factsheet_sources.terms_review_status` must be `approved`. `not_reviewed` (the default for every seeded row), `under_review` and `declined` all REFUSE before any request is made. This is how the pipeline stays off until the fund-house terms question (counsel / PO review) is settled.
2. **Kill switch.** `ii_reference_job_control.factsheet_benchmark_reader`, shipped `enabled = false`. Off, missing or unreadable = no work: no fetch, no write.
3. **Dry run.** Body `{ "dryRun": true }` reports what the run WOULD fetch and extract. It makes no network request and writes nothing, whatever the switch says, so it is always safe to run.
4. **AI pass** is separately off: it needs `FACTSHEET_READER_AI_ENABLED=true` AND the AIE provider configured (`AIE_AI_PROVIDER=openai`, `AIE_OPENAI_API_KEY`); it runs only when the pattern pass failed, at most 5 times a run, on a bounded excerpt of the public document (scheme name + benchmark-bearing lines only, never user data), and its answer is validated against a strict schema and against the document text. An AI-only reading can never auto-publish.

## Fetching manners (enforced in code, tested offline)

Descriptive User-Agent; `robots.txt` read once per host per run and honoured (an unreadable robots file means "do not fetch from this host"); one request at a time and at least 3 s between two requests to the same host; conditional requests (`If-None-Match` / `If-Modified-Since`); hard caps of 15 MB and 45 s per document (a larger document is skipped as "document too large", never truncated); no retries within a run (a failure is retried by a later run, at most 3 times per source per month); never bypasses a block (401 / 403 / 429 or an HTML interstitial where a PDF was expected stops that host for the run); no login, no cookies; only the exact registered URLs on the official-domain allow-list (`FACTSHEET_ALLOWED_HOST_SUFFIXES`); redirects only to another allow-listed host, each re-checked against robots.

## Enabling (a deliberate, human-present step; none of this was done)

1. Apply migration `0252` (after `0241` and `0251`) to the target environment.
2. Settle the fund-house terms question. For each source you accept, an entitlement approver records it:
   * preferred: Market Index Data > Mappings > "Factsheet sources" > "Approve terms" (an entitlement approver's session; the note records who reviewed which terms, and when; it is checked again by `set_factsheet_source_terms_status` and written to the governance log);
   * operator fallback (SQL editor, owner role): `update ii_factsheet_sources set terms_review_status = 'approved', terms_reviewed_by = '<admin user id>', terms_reviewed_at = now(), terms_review_note = '<note of at least 10 characters>' where source_key = '<key>';` then record it with `select public.ii_bm_log_event('factsheet_source_terms_status_set', 'ii_factsheet_sources', id, null, jsonb_build_object('terms_review_status','approved'), '<note>') from ii_factsheet_sources where source_key = '<key>';`.
3. Run a dry run first and read the plan.
4. Register the schedule (not created by any migration), reusing the existing cron secret like the other jobs. Monthly is enough; a weekly tick lets failed fetches retry (re-runs within a month are idempotent):
   ```sql
   select cron.schedule(
     'factsheet-benchmark-reader',
     '15 4 3,10,17 * *',  -- 04:15 UTC on the 3rd, 10th and 17th: first reading, then retries
     $$
     select net.http_post(
       url := '<REPLACE_WITH_REACHABLE_APP_ORIGIN>/api/investment-intelligence/cron/factsheet-benchmark-reader',
       headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'pc6_reference_ingest_cron_secret')),
       body := jsonb_build_object('dryRun', true)
     );
     $$
   );
   ```
   Keep `dryRun: true` until the output looks right, then flip it to `false` AND set `ii_reference_job_control.factsheet_benchmark_reader.enabled = true` with the reason cleared.

## Disabling and rolling back

* Stop all work: `update ii_reference_job_control set enabled = false, disabled_reason = '<why>' where job_key = 'factsheet_benchmark_reader';` (or `cron.unschedule`).
* Stop one source: set `ii_factsheet_sources.enabled = false` or its terms status to `declined`.
* Nothing the reader recorded needs to be undone to disable it: versions and ledger rows are facts, kept for audit. A mapping it auto-published can be closed through the normal mapping review. The migration adds no column to an existing table, so it needs no down-migration.

## Admin surface and capabilities (Admin Architecture Standard)

| Surface | Capability | Notes |
|---|---|---|
| Market Index Data > Mappings > "Factsheet changes to review" (GET) | `view` (existing) | explicit 401 / 403; 503 if migration not applied; no personal data, no holder count |
| Decide a queued change (POST `.../factsheet/changes/[id]/review`) | `catalogue` (existing) | approve uses the existing `review_benchmark_mapping` path inside `review_factsheet_change` |
| Held-schemes list: last factsheet check and "declared, cannot be compared" | `view` (existing) | fail soft before migration |
| Market Index Data > Mappings > "Factsheet sources" (GET list) | `view` (existing) | AMC, document type, address, AMFI code, terms status, last result; reviewer identity is not returned |
| Set a source's terms status (POST `.../factsheet/sources/[id]/terms`: Approve terms / Mark not reviewed / Reject terms, note of 10+ characters required) | `entitlementApprove` (existing), and again inside `set_factsheet_source_terms_status` | audited in the governance log; friendly 503 when 0252 is not applied |
| The job itself | service role + `CRON_SECRET` | its only cross-user read returns instrument identities |

No new capability. No exception to the standard was requested.

## Known limitations

* No URL was fetched to build or test this. The registered URLs come from the 3 October 2026 research (each read once by hand). Whether they still resolve, whether the text-pattern pass reads the REAL documents (real PDFs lay text out differently from the synthetic fixtures), and whether pdf-parse extracts the cover and key-information pages of real SIDs well are all UNVERIFIED.
* SBI factsheet URLs carry a per-file `sfvrsn` token, so the seeded factsheets are one-off documents; a new month's factsheet needs a new registered URL (the registry supports `{YYYY}`, `{MM}`, `{MONTH}` templates but none is seeded).
* The ICICI complete factsheet is expected to exceed the size cap (research: over 10 MB) and will end each month as "document too large".
* No AMFI-hosted SID is seeded (none of the two read belongs to a held scheme).
* A scheme's first auto-published mapping starts on the first sighting's date (document month start, flagged estimated) unless the document states one; earlier periods fall to the category reference.
* Matching a held instrument to a source is by exact AMFI scheme code only (Regular and Direct plans have different codes: add each). A rename does not matter to matching: ICICI Prudential Dividend Yield Equity Fund became ICICI Prudential Dividend Yield Fund w.e.f. 26-08-2026 (code 129310); a holding whose statement still prints the old name is matched by the code, and the source searches both names in the document (`document_scheme_aliases`).
* A mapping the reader publishes starts from the date the document states; if it states none, from the first-sighting document month, flagged "estimated". It is never backdated. Examples from the supplied documents: ICICI Nifty 500 TRI states 01-01-2022; the HDFC change from 65:35 to 50:50 states no date in either SID (so it is estimated); SBI Multi Asset's composite states 31-10-2023 and its earlier benchmark is not named.

Future-review owner: Product Owner (benchmark governance).
