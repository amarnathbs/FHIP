# DEV evidence -- Premium Upload Entitlement (15-10-2026)

Evidence class: **DEV-verified** (the real route handlers of this branch, running locally, against the real DEV Supabase project `vqycarelcoijzwlpkpcz`). Not production.

* Branch commit under test: `fadfcd2` (`feat/premium-upload-entitlement-20261014`); later commits touched only tests and documentation.
* Users: two EXISTING DEV fixture accounts from the forecasting fixture set (`forecast.tc065@example.test` Free, `forecast.tc078@example.test` Premium, Premium window ending 30-11-2026). Sessions were minted for them through the admin magic-link flow: no password was typed or created, no user was created, no subscription was changed.
* Counters were read with the DEV service role before and after. The only rows written were the ones in the end-to-end section, all removed afterwards.

## Free fixture (id `ea92e844`, entitlement `{"plan_tier":"free","effective_to":null}`)

* `GET /api/financial-data-hub/upload-status` -> `import_access = premium_required`
* **28 of 28** requests refused with HTTP 403 `PREMIUM_REQUIRED`; unexpected 5xx: none.
* The requests carried REAL file bytes / multipart bodies, and spoofed plan claims (query string, header, body) on two routes.
* Counters before == after: **true** (documents, upload sessions, audit events, ingestion jobs, AIE intakes, II source documents, storage objects): `{"fdh_statement_uploads":0,"fdh_upload_sessions":0,"fdh_document_audit_events":0,"fdh_ingestion_jobs":0,"aie_document_intake":0,"ii_source_documents":1,"storage_objects_for_user":0}`.

| Surface | Kind | HTTP | Code |
|---|---|---|---|
| fdh.upload_session.create | admission | 403 | PREMIUM_REQUIRED |
| fdh.upload_session.complete | admission | 403 | PREMIUM_REQUIRED |
| fdh.bank_csv.upload | admission | 403 | PREMIUM_REQUIRED |
| fdh.bank_pdf.upload | admission | 403 | PREMIUM_REQUIRED |
| fdh.liability_statement.upload | admission | 403 | PREMIUM_REQUIRED |
| fdh.investment_statement.upload | admission | 403 | PREMIUM_REQUIRED |
| fdh.retirement_statement.upload | admission | 403 | PREMIUM_REQUIRED |
| aie.intake.upload | admission | 403 | PREMIUM_REQUIRED |
| aie.insurance.intake | admission | 403 | PREMIUM_REQUIRED |
| aie.fdh_bank.intake | admission | 403 | PREMIUM_REQUIRED |
| aie.investment_intelligence.intake | admission | 403 | PREMIUM_REQUIRED |
| ii.source_document.upload | admission | 403 | PREMIUM_REQUIRED |
| ii.source_document.parse_fixture | admission | 403 | PREMIUM_REQUIRED |
| fdh.bank_csv.detect | run_start | 403 | PREMIUM_REQUIRED |
| fdh.bank_csv.map | run_start | 403 | PREMIUM_REQUIRED |
| fdh.bank_csv.process | run_start | 403 | PREMIUM_REQUIRED |
| fdh.bank_pdf.process | run_start | 403 | PREMIUM_REQUIRED |
| fdh.bank_pdf.ai_fallback_confirm | run_start | 403 | PREMIUM_REQUIRED |
| fdh.payslip.process | run_start | 403 | PREMIUM_REQUIRED |
| fdh.payslip.ai_fallback_confirm | run_start | 403 | PREMIUM_REQUIRED |
| fdh.liability_statement.process | run_start | 403 | PREMIUM_REQUIRED |
| fdh.liability_statement.ai_fallback_confirm | run_start | 403 | PREMIUM_REQUIRED |
| fdh.investment_statement.process | run_start | 403 | PREMIUM_REQUIRED |
| fdh.investment_statement.ai_fallback_confirm | run_start | 403 | PREMIUM_REQUIRED |
| fdh.retirement_statement.process | run_start | 403 | PREMIUM_REQUIRED |
| fdh.retirement_statement.ai_fallback_confirm | run_start | 403 | PREMIUM_REQUIRED |
| aie.investment_intelligence.process | run_start | 403 | PREMIUM_REQUIRED |
| ii.source_document.process | run_start | 403 | PREMIUM_REQUIRED |

## Premium fixture (id `6f10dec4`, entitlement `{"plan_tier":"premium","effective_to":"2026-11-30"}`)

* `import_access = allowed`; **0 of 28** refused by the capability; ENTITLEMENT_UNAVAILABLE: 0; unexpected 5xx: none.
* These are empty / invalid / random-id probes (they cannot persist anything); counters before == after: true.

| Surface | Kind | HTTP | Code |
|---|---|---|---|
| fdh.upload_session.create | admission | 422 | - |
| fdh.upload_session.complete | admission | 422 | - |
| fdh.bank_csv.upload | admission | 422 | - |
| fdh.bank_pdf.upload | admission | 422 | - |
| fdh.liability_statement.upload | admission | 422 | - |
| fdh.investment_statement.upload | admission | 403 | - |
| fdh.retirement_statement.upload | admission | 400 | - |
| aie.intake.upload | admission | 403 | - |
| aie.insurance.intake | admission | 403 | - |
| aie.fdh_bank.intake | admission | 403 | - |
| aie.investment_intelligence.intake | admission | 403 | - |
| ii.source_document.upload | admission | 422 | - |
| ii.source_document.parse_fixture | admission | 422 | - |
| fdh.bank_csv.detect | run_start | 404 | - |
| fdh.bank_csv.map | run_start | 422 | - |
| fdh.bank_csv.process | run_start | 404 | - |
| fdh.bank_pdf.process | run_start | 404 | - |
| fdh.bank_pdf.ai_fallback_confirm | run_start | 422 | - |
| fdh.payslip.process | run_start | 404 | - |
| fdh.payslip.ai_fallback_confirm | run_start | 422 | - |
| fdh.liability_statement.process | run_start | 422 | - |
| fdh.liability_statement.ai_fallback_confirm | run_start | 422 | - |
| fdh.investment_statement.process | run_start | 422 | - |
| fdh.investment_statement.ai_fallback_confirm | run_start | 422 | - |
| fdh.retirement_statement.process | run_start | 400 | - |
| fdh.retirement_statement.ai_fallback_confirm | run_start | 422 | - |
| aie.investment_intelligence.process | run_start | 403 | - |
| ii.source_document.process | run_start | 404 | - |

## Premium end-to-end admission (one real document, then cleanup)

* create upload session -> 200; complete upload (real PDF bytes) -> 200, `processing_status = queued`.
* Admission audit event metadata: `{"source_type":"pdf_native","document_type":"tax_document","import_entitlement":"premium"}` (the Premium-at-admission stamp).
* Counters before -> after admission: documents 0 -> 1, sessions 0 -> 1, storage objects 1 -> 2.
* The user's own document delete -> HTTP 200 (it marks the document rejected and schedules purge; the raw object is removed by the scheduled purge sweep, so the evidence script removed that one object itself).
* Cleanup on DEV, for the rows/objects the script created only: fdh-source-documents:1 object(s); then the document and session rows. Final counters for the fixture user: documents 0, sessions 0, ingestion jobs 0, storage objects = baseline (1). **6 immutable audit events remain** (document id nulled): audit evidence by design.

## Performance (this machine -> remote DEV Supabase; network round trip dominates)

* The entitlement read (own row, session JWT, RLS): p50 161 ms, p95 197 ms over 40 reads.
* Warm route latency, p50 / p95 ms: Free refusal bank CSV upload 720 / 1013; Premium validation (same route, passes the gate) 699 / 760; upload-status Free 710 / 957, Premium 716 / 788. The gate costs one single-row indexed read per guard (an FDH upload runs the guard at the route, at createUploadSession and at completeUpload: three reads, no provider call, no N+1). Re-measure on production from the real region.

## What this does NOT prove

* Premium extraction -> review -> Apply for each domain (payslip, bank, card/loan, investment, retirement) was **not re-run live** here: the Premium path is proved to be admitted and unchanged by route tests, and the parsers are untouched. The AU investment statement route needs an AU Premium fixture, which DEV does not have (its only Premium fixtures are India).
* The downgrade lifecycle (Premium admits, then the plan becomes Free) is **unit-tested** (stateful fake, `tests/unit/premiumUploadServices.test.ts`), not exercised on DEV: that would require flipping a shared fixture's subscription.
* Production: not verified (no production access in this run).

## Browser evidence (the built-in browser against the same local server and DEV data)

* Free (India fixture), desktop 1280 px: Income, Expenses, Liabilities and Investments each show manual Add and the Import control as a locked **Premium** link (`/profile?from=import-<domain>`), with no file input. Retirement shows the lock notice with the PO wording and no file input. India CAS (`/investment-intelligence/data`) at **375 px** shows the lock notice, no horizontal scroll, no file input, no upload button. The upgrade link lands on Profile (Billing).
* Premium (India fixture): all six surfaces show the working Import control / file input and no lock chrome.
