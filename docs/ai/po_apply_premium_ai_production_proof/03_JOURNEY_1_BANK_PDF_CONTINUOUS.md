# 3. Journey 1: one continuous bank-PDF journey (the proof that matters most)

**Goal.** One real document travels the whole path on production, and every step leaves evidence that you can compare with a number you did not
get from the app: a Premium account that was never in the former pilot uploads a bank PDF whose layout the deterministic reader legitimately
cannot read; it is scanned for real; the text is read locally and masked; a real gpt-4o-mini request is made; the answer is validated and
reconciled by the existing deterministic code; the structured result is stored durably; the original is deleted and the deletion verified;
**you accept after the deletion**; the right canonical rows appear; and a replay changes nothing and costs nothing.

**DEV rehearsal (DEV-verified, 19/10/2026).** The same journey, the same files and the same expected values ran 20 of 20 on DEV against a local
build of `main` (real DEV scan, real gpt-4o-mini): `evidence/dev_rehearsal_bank_journeys_19-10-2026.json`. Differences from production that
remain: production's scan role and bucket, production's keys and ledger, the browser screens (the rehearsal drove the same API routes the
screens call; **no browser screen was driven**), and the 3-hour clock shift used for the deletion step (section 6, variant B).

## 0. Before you start

1. `README.md` steps 1 to 6 are done: build commit known, `sql/A01` all true, Amplify checked, accounts created, baseline taken.
2. Accounts (create them yourself through the normal sign-up, with mailboxes you control, and choose your own passwords; nobody else sees them):
   **P1** Premium (Admin, Premium grant, 1 to 3 days) and **outside** the former two-e-mail pilot; **P2** a second Premium account, also outside the pilot;
   **F1** Free; **X1** a former pilot e-mail with **no** active Premium (skip if both former pilot accounts are Premium; say so in the evidence).
   Copy each account's user id from Supabase, Authentication, Users (`sql/E10` shows the plan).
3. Files: `synthetic/DOC-B1_bank_statement_kestrel_coast_aug2026.pdf` (P1) and `DOC-B2_...` (P2). Check the SHA-256 against `synthetic/MANIFEST.sha256`.
4. Open `synthetic/EXPECTED_VALUES.md` next to this page. Take the **baseline**: `sql/A02` and `sql/E05`; write down `settled_usd`, `total_attempts`, `remaining`.
5. Separate each evidence reading by time: write the Melbourne time (dd/mm/yyyy hh:mm) before each action.

## 1. The steps

| # | Account | Action in the app | Expected | Evidence to capture (sanitized) |
|---|---|---|---|---|
| 1.1 | P1 | Expenses, Import. Choose the owner **Self** (the screen asks before the file). Choose **DOC-B1**. Upload | The upload is accepted. No "Premium" message. The screen moves to "checking" and then to processing | Time. Document id (address bar or network tab, 8 characters of it is enough in the report). Screen text. `sql/E10` (P1 is `premium_today` true and not a pilot address) |
| 1.2 | P1 | wait | The security scan finishes (DEV: instant, earlier production run: about 5 seconds; allow up to 20 minutes, the scan window) | `sql/E01`: `malware_scan_status` **clean**; `scan_has_object_version` true; `scan_version_matches_expected`, `scan_etag_matches_expected`, `scan_object_key_matches_expected` all **true** (the clean verdict is bound to the exact stored object); `malware_scan_decided_at`; `scan_copy_purge_verified` **absent** (see finding F-4) |
| 1.3 | P1 | (automatic) | The deterministic reader runs and cannot read this institution's layout. An **AI-read draft** screen appears with the statement figures for your review. Nothing has been written yet | Screenshot (mask nothing needed, the data is synthetic). `sql/E02`: `pdf_native_extraction_started` then `bank_statement_ai_fallback_attempted` then `bank_statement_ai_fallback_draft_ready` |
| 1.4 | P1 | Read the draft against the sheet | Exactly the DOC-B1 table: 6 lines (03/08, 05/08, 09/08, 14/08, 19/08, 26/08/2026), amounts 2,450.00 in, 1,380.00 / 164.85 / 212.30 out, 500.00 in, 38.60 out; running balances as printed; opening **3,215.40**; closing **4,369.65**; period 01/08/2026 to 31/08/2026; institution Kestrel Coast Community Bank; no account digits | Your comparison table: expected, actual, equal yes or no, per row. Any difference is a **finding**: record it, do not edit the draft to hide it |
| 1.5 | (sql) | Model and cost evidence | One real request: `ai_model` **gpt-4o-mini**, `provider_request_id_count` **1**, input tokens about 1,400 and output about 400 (DEV: 1,377 and 396), settled cost **under US$0.01** (DEV: US$0.000444), reserved ceiling about US$0.009 | `sql/E02` (the draft_ready row) and `sql/E04` (the attempt: reserved, settled, model, tokens, outcome `success`, running total). `sql/A02` again: `settled_usd` rose by exactly the attempt's settled amount; `reserved_usd` back to what it was; `total_attempts` +1 |
| 1.6 | (sql) | Durable review record | The structured draft is stored and waiting | `sql/E03`, column `drafts`: `pending_review:bank_statement:rows=6`. `transactions` **0** (nothing canonical yet). `processing_status` **processing** |
| 1.7 | P1 | Do nothing for now, or reload the page | The draft is offered again (no second reading) | `sql/E04`: still one attempt. `sql/A02`: `total_attempts` unchanged |
| 1.8 | (sql) | **Deletion of the original and its scan copy** | See section 6: the original is removed at acceptance, or by the background cleanup once it is older than 50 minutes (worst case 55) | `sql/E01`: `raw_document_purge_status` **purged**; `original_reference_still_set` false; `original_object_still_stored` **false**; `scan_copy_purge_verified` **absent**. Also look in Supabase, Storage, bucket `fdh-source-documents`: the object is gone |
| 1.9 | P1 | **Accept the draft after step 1.8 shows `purged`** (variant B, section 6) | "Imported" screen. The statement is imported once | Time of acceptance later than the time `sql/E01` showed `purged` |
| 1.10 | (sql) | Canonical result | 6 transactions on the new account; money out **1,795.75**; money in **2,950.00**; reconciliation **reconciled**, variance **0**; certification **certified**; processing **approved** | `sql/E03`: `transactions` 6, `money_out` 1795.75, `money_in` 2950.00, `reconciliation_status` reconciled, `reconciliation_variance` 0, `certification_status` certified. `drafts` now `confirmed:bank_statement:rows=6` |
| 1.11 | P1 | Downstream display | Expenses (August 2026) and the statement list show the six lines; the account carries the institution name | Screenshot of the statement summary and the Expenses month. If a total looks different from the sheet, record both numbers (categorisation can move a total between lines, but the six lines and their signs cannot change) |
| 1.12 | P1 | **Replay**: upload DOC-B1 again | The screen recognises it as a copy of the earlier upload and goes to the original result. No new reading | `sql/E04`: still one attempt. `sql/A02`: `total_attempts` and `settled_usd` unchanged |
| 1.13 | P1 | **Double accept**: click Accept twice quickly on a second statement, or reload after accepting | One write only | `sql/E03`: `transactions` still 6. `sql/E04`: attempts unchanged |
| 1.14 | P2 | Open the DOC-B1 document address while signed in as P2 | Not found or refused. P2 sees none of P1's data | Screenshot; `sql/E03` for P2's own document later shows only P2 rows |
| 1.15 | P2 | Repeat steps 1.1 to 1.10 with **DOC-B2** (variant A is fine) | Independent draft and result: 6 lines, opening 8,120.55, closing 8,594.25, out **2,630.45**, in **3,104.15**, reconciled, certified | `E01` to `E04` for P2's document id |
| 1.16 | P2 | Optional 1b: upload **DOC-B3** after DOC-B2 | The reading reports **9,300.00 as printed**. After acceptance: reconciliation **failed**, variance **43.95**, certification **review_required** (never certified); the screen asks for attention | `sql/E03`. If B3 is certified, that is a **defect**: stop and report |
| 1.17 | all | Cost roll-up | Whole session under US$0.01 per document; P1's `running_counted_usd_today` far below US$1.00 | `sql/E04` for each account, `sql/E05`, `sql/A02` |

## 2. What each expectation proves

| Claim | Proved by |
|---|---|
| Premium admission through the normal app | 1.1 and `E10` |
| Real scan, clean verdict bound to the uploaded object | 1.2: version, ETag and object key of the verdict equal those recorded when the object was uploaded (the decision function also rejects any mismatch, UNIT-TESTED) |
| Legitimate parser shortfall (nothing disabled) | 1.3: the deterministic reader started and fell through; the unit test runs the same reader over the file and over a control statement it reads natively (UNIT-TESTED) |
| Local extraction and masking before anything leaves | The text is extracted in the server, masked locally and re-scanned before the call; the unit test shows no planted personal detail survives and every figure survives (UNIT-TESTED); the draft shows no account digits |
| Real gpt-4o-mini request | 1.5: model, request id count, tokens |
| Strict schema validation and deterministic reconciliation | The model's answer must satisfy a strict schema; every printed figure is checked against the page text; the rows are re-run through the existing duplicate, rollforward and certification code (UNIT-TESTED, including negative controls: an invented line and a dropped line both fail to reconcile) |
| Durable structured review data | 1.6 |
| Verified deletion of original and derivative copies | 1.8: storage, purge status, and the scan copy's verified-absent record |
| Acceptance after deletion works | 1.9 and 1.10 (DEV-verified with a clock shift; this is the production confirmation) |
| Correct canonical writes and downstream display | 1.10 and 1.11 |
| Idempotent replay, no second charge, no duplicate write | 1.7, 1.12, 1.13 |

## 3. If a step fails

Stop at the first unexpected result. Capture `sql/E01`, `E02`, `E04`, the screen text, and the time. Use the reason table in
`01_PRODUCTION_CONFIGURATION.md` section 5. Do not retry blindly: a retry of the same file is a replay and is answered from the first result.

## 4. Why the original may still exist for a while (read this before step 1.8)

The product deletes the uploaded original **when the person accepts** (PO decision 01/10/2026, `purgeRawDocumentAfterAiConfirm`) and, whatever
happens, by a hard backstop: any original older than **50 minutes** is purged by the cleanup job that runs every **5 minutes**, so the worst case is
55 minutes. While a draft waits, the structured result is already durable, so review and acceptance never need the file. That is the design the
proof checks. It means "deletion before acceptance" happens only if the person takes longer than about an hour to accept. Hence two variants.

## 5. Variant A: natural (use for DOC-B2)

Accept as soon as you have compared the draft. The original is deleted straight after the accept. Evidence: `E01` after acceptance shows `purged`.

## 6. Variant B: acceptance after deletion (use for DOC-B1)

Compare the draft, then **wait** until `sql/E01` shows `raw_document_purge_status = purged` and `original_object_still_stored = false` (about 55
minutes after the upload; run `E01` every 10 minutes; the page can stay open, or reopen the import panel, which offers the waiting draft).
Then accept. If the draft cannot be reopened from the screen after the wait, record **NOT PERFORMED** for 1.9 with a screenshot and the time; do
not recreate the document. The cleanup job's health is `sql/A03` and `A04`: no run in the last hour means variant B will not complete on time and
is itself a finding.
