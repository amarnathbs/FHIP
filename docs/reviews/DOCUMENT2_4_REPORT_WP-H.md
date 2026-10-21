# DOCUMENT2 (4) WP-H report: replacement-upload integrity (F5 / F6 / F14 closure items)

Branch `feat/doc2-4-wp-h-replacement-integrity-20261021`, based on `origin/main` 9cce1cf (includes WP-B). No migration (range 0312-0313 unused). No production access. Nothing pushed. DEV project `vqycarelcoijzwlpkpcz` only; the synthetic DEV user was created WITHOUT a password and everything the run created was deleted and re-queried (zero residue).

Evidence labels: UNIT-TESTED, PGLITE-VERIFIED (real migration chain replayed into in-memory Postgres), DEV-verified (real DEV database and Storage, services called directly), PRODUCTION-VERIFIED (NOT PERFORMED anywhere). Browser click-through: NOT PERFORMED.

## Gap A: is the copy the same logical statement?

Rule (module `lib/services/investment-intelligence/replacementIdentity.ts`, enforced in `replaceSourceDocumentFile`, i.e. server side, BEFORE the object is stored or the row's file reference is switched):

The copy is read with the same deterministic parsers the process route uses (read only) and compared with what the old statement retained after its file was deleted: `source_detected`, `document_type_detected`, `statement_period_start/end`, `statement_as_of_date` (else the latest holding line it wrote), the folios and fund houses of the accounts its holdings / transactions / transaction links point at, the ISINs of those funds, and `owner_member_id` against the printed holder.

| Finding | Result | Why |
|---|---|---|
| Different provider (e.g. KFintech copy for a CAMS statement); different statement type | REJECT, cannot be confirmed | different statement |
| Periods do not overlap (inclusive of a shared single day) | REJECT | a different statement, upload it as new |
| No folio in common | REJECT | different account |
| Printed holder is exactly another household member | REJECT | K.7: never re-filed silently |
| Copy unreadable while the old statement was recognised | REJECT | cannot verify |
| Periods overlap but start or end differ by more than 3 days | CONFIRM | extended or trimmed re-download is legitimate but must be seen |
| Only the as-of date can be compared and differs by more than 3 days | CONFIRM | |
| Copy prints no period / date while the old one had one | CONFIRM | cannot be checked |
| Some retained folios missing, or extra folios; same folio under another fund house; no shared ISIN | CONFIRM | |
| Holder name matches nobody in the household (noisy names) | CONFIRM | shown masked |
| Old statement kept nothing at all (never read) / copy unreadable and old unrecognised | CONFIRM | nothing to compare; the person sees what the copy actually is |
| Everything that was retained agrees | MATCH | signals not retained are listed as "not compared", never as agreement |

"Materially different" is explicit: 3 calendar days at each end (`PERIOD_TOLERANCE_DAYS`) absorbs a registrar rolling a period end over a weekend or holiday; anything wider (a different month, quarter, financial year) is a different period. No overlap at all is a rejection, partial overlap a confirmation. The PO can change the constant.

Confirmation protocol: the first call returns 409 `replacement_needs_confirmation` with the differences in plain words (India dd-mm-yyyy, Australia dd/mm/yyyy, folios shown as "ending 4455", holder masked) and a one-line summary of what the file is. The screen shows them with "Yes, this is the same statement. Attach this copy" / "No, choose a different file". The second call carries `confirmDifferences=<codes>`; the server recomputes the differences from the bytes and only accepts codes that are actually confirmable and actually present. A rejection code in the list changes nothing (negative control). The confirmation (and the old and new period) goes on the audit trail. A password-protected copy needs its password for the check (422 `password_required_for_check` / `wrong_password_for_check`); it is used only for that read and never stored, logged or echoed.

Ordering with the malware gate: new `scanReplacementCandidate` runs the real scan on the copy BEFORE anything parses it and before the document row is touched (pending -> 409 `malware_scan_pending`, the screen waits and retries; blocked -> 422; scanner or migration 0196 unavailable -> 503, fail closed). With the scan off (today's documented default) nothing changes. The verdict is recorded on the row after the copy is attached.

Retained-provenance-missing: no retained period -> compared on provider, folios, ISIN, owner and the period is reported "not compared". Nothing retained at all (the statement never parsed, e.g. password-required) -> `nothing_retained_to_compare`, needs confirmation after the person sees what the copy is. This adds one confirmation to the most common F5/F6 case (a password-required old statement); that is the safest rule and is a PO call.

Files: new `replacementIdentity.ts`; changed `sourceDocumentReplacement.ts`, `realScanAdmission.ts` (two additive exports), the replacement route, `ReplacementCopyControl.tsx`, and `documentProcessing.ts` (one minimal edit, see Found 2: owned by WP-B / merged).

## Gap B: no duplicate economics (full before/after oracle)

`tests/unit/support/pgliteSupabase.ts` is a Supabase-shaped client over PGlite, so the REAL `processSourceDocument`, `replaceSourceDocumentFile`, `publishPosition`, `refreshPosition` and `selectInvestments` run on the REAL migration chain (unique fingerprints, holding unique key, CHECKs, FKs). Statements are real PDFs through the real pdf-parse and CAMS parser. The oracle counts and sums, per user: accounts, instruments and identifiers, transactions (count, amount, units), transaction source links, holding snapshots (count, units, value), publications (published / all), canonical Investments (active count and value), the Net Worth investments leg (published total, line count, unpublished bucket), portfolio truth rows; bookkeeping (parse runs, audit events, cases) is tracked separately.

PGLITE-VERIFIED (`iiWphReplacementNoDuplicateEconomicsPglite`, 8 tests):
- Same statement re-downloaded: replacement + reprocess, again with another file, again with identical bytes: economic diff = {} at every step; 1 account, 1 fund, 2 transactions, 1 holding, 1 publication, 1 investment, Net Worth 7,800.00 counted once; one `ii_source_documents` row, same id and owner; blocking cases unchanged.
- Extended copy (one more purchase, a month later): refused without confirmation with the database untouched; confirmed, the only economic differences are +1 transaction (2,650.00 / 50 units), +1 link, +1 holding date; no new account, fund or identifier; refreshing the publication updates the ONE canonical investment in place to 10,600.00 (Net Worth counted once); second pass: diff = {}.
- Unrelated statement: refused (`no_common_folio`, `period_no_overlap`, `schemes_differ`), row and storage untouched, no new instrument.
- Two-user cross-tenant: other user gets 404; both users' oracles and the row unchanged.
- NEGATIVE CONTROL: if the account stops matching (closed), the same replacement DOES duplicate accounts, transactions (2 -> 4) and holdings; the oracle names them and "second pass changed economics" goes red, so the oracle can detect duplication.
- Deployment-order test (Found 2).

DEV-verified (`tests/live-dev/iiWphReplacementNoDuplicateLiveDev.test.ts`, run 21-10-2026, tag `wph-1792550558344`, evidence `docs/reviews/evidence_wp_h/dev_oracle_wph-1792550558344.json`): real PDFs, real Storage, real DEV schema, real instrument matching and fingerprints. Same statement x3: accounts 1, funds 1, transactions 2 (7,500.00), links 2, holdings 1 (7,800.00), published 1, investments 1 (7,800.00), Net Worth 7,800.00 at every step. Extended copy: 2 -> 3 transactions, 1 -> 2 holdings, refresh -> investment 10,600.00, Net Worth 10,600.00 once, second pass unchanged. Unrelated statement refused, cross-user 404, row identical.

## Found while doing it

1. The PDF library detaches its input buffer. Reading the copy and then storing the same bytes would have stored an empty file; the mocked text layer in unit tests hid it, the real-PDF oracle caught it. Fixed (copy handed to the library), with a regression test and a mutation check.
2. DEV is missing the three parse-run counters of migration 0159. The pipeline's final run update failed unchecked, the run stayed `running`, and Reprocess / replacement within 10 minutes answered "already being processed". The run is now closed without the counters when the full update fails (logged); PGlite test with the columns dropped, mutation-checked. The DEV counters themselves (`new_transactions_count` etc.) therefore could not be read from the DEV database; the processing summary values were asserted instead.
3. The Review centre control never forced a re-read (`forceReparse={false}`), so for an already parsed statement "Done" could mean the cached old run. The control now always forces a re-parse (idempotent).
4. DOCUMENTED LIMIT, not changed: a replacement that corrects a figure for an as-of date already recorded does not overwrite it (holding snapshots are insert-if-absent per account, fund and date). Nothing duplicates, but a corrected closing value for an existing date is ignored. If the PO wants corrections to land, that is a separate decision (it changes the snapshot immutability rule).

## Tests and checks

New: `iiWphReplacementIdentity` 31, `iiWphReplacementIdentityService` 33 (negative controls: period mismatch accepted, folios ignored, provider ignored, owner ignored, a rejection treated as confirmable: each turns its scenario red, plus an all-green run proving the controls fail for the right reason), `iiWphReplacementRouteAndControl` 10, `iiWphReplacementScanGate` 10, `iiWphReplacementNoDuplicateEconomicsPglite` 8, `iiWphSqlPackPglite` 9. `iiWpbReplacementAndMissingFile` adapted to scan-before-read. Run together with all `iiWpb*`: 14 files, 214 tests pass. Wider run (`tests/unit/ii*`, premiumUpload*, ownerBeforeUpload*, aie*, fdh11*): 276 files pass; the one failure is `iiNetWorthNavRemarkPublishFlow` (date-dependent, already listed as failing identically on main in the WP-B report). `tsc --noEmit` (8 GB heap): only the two known errors. eslint clean on every touched file. `git checkout -- scripts/` applied after the runs.

## What the PO must do

1. DEV, read only: run `docs/reviews/po_apply_wp_h/01_READ_ONLY_check_parse_run_counters.sql`. Result 1 must show three columns; if not, migration 0159 is not applied on DEV (DDL is a PO action; this agent did not apply it). Run the same pack on production: the code now copes either way, but the processing summary needs the counters.
2. DEV, browser (NOT PERFORMED here): as a Premium user with a processed India statement whose file is deleted, run pack 02 (before), use "Upload replacement copy" with (a) the same PDF re-downloaded: expect a normal success and pack 02 identical except parse runs / audit events; (b) a PDF of a different year or fund house: expect a plain refusal with day-first dates and nothing changed; (c) an extended-period copy: expect the confirmation list and button; confirm and compare pack 02 (only the new transaction, holding date and, after Publish refresh, the investment value change); (d) a password-protected copy with and without its password. Repeat (a) a second time: pack 02 unchanged.
3. Decide: the 3-day tolerance; whether a never-read (password-required) statement should need the confirmation step (current rule: yes); whether corrected figures for an existing as-of date should be allowed to overwrite (limit 4).
4. Production stays gated: the replacement upload is still Premium-gated (`ii.source_document.replacement`) and behind the existing malware / readiness switches; nothing here enables anything. The real malware scan path (S3 + GuardDuty) with the new ordering is UNIT-TESTED with mocks only; NOT PERFORMED against the real scanner.

## Honest limits

- DEV run called the services with the user id (as earlier live suites do): the HTTP route, session and Premium gate were not exercised on DEV (unit-tested with mocks); `publishPosition` used the service-role client in place of the cookie client.
- Provider-difference is tested with the comparison on a swapped `sourceKey`, not with a real KFintech statement (fixtures are CAMS). Folio statements and AU documents are not covered by this check (India MF statements only).
- Holder-name comparison depends on the parser's printed name and is deliberately never a hard stop except an exact match to another member.
- The identity check parses the copy inside the replacement request (bounded by the 20 MB file limit); a password-protected copy needs its password up front.
- No browser run; screen behaviour is verified through the pure functions and markup tests.
- The in-memory Postgres is PGlite replaying the repo's migrations, not DEV or production; DEV differs from it at least by migration 0159.

Admin Architecture Standard: not applicable (no Admin route, capability or screen touched).
