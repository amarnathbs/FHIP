# DOCUMENT2 (4) WP-H2 report: the real malware scan blocks password-protected statements, and mishandles a scan that has not finished

Branch `feat/doc2-4-wp-h2-scan-pending-handling-20261022`, based on `origin/main` 5c9fa63 (WP-H, Amplify 328). No migration (range 0315-0316 unused). No production access. Nothing pushed. One dependency added (`@cantoo/pdf-lib` 2.11.1, MIT, 4 small transitive packages; `package.json` and `package-lock.json` change).

Evidence labels: UNIT-TESTED, PGLITE-VERIFIED, DEV-verified, PRODUCTION-VERIFIED. **DEV-verified and PRODUCTION-VERIFIED: NOT PERFORMED** for the scan itself. The DEV env file this agent can use holds only the Supabase variables; the AWS scan bucket settings (`AIE_MALWARE_*`) are not there, so the real GuardDuty behaviour on an encrypted PDF could not be observed. Everything below about GuardDuty is established from the code and AWS's documented behaviour, not from a live tag.

## 1. Root cause (from the code)

The path an encrypted PDF takes with `AIE_REAL_MALWARE_SCAN_ENABLED=true`:

1. `uploadForRealMalwareScan` puts the file as uploaded in the scan bucket; GuardDuty Malware Protection for S3 tags the object `GuardDutyMalwareScanStatus`. A password-protected PDF cannot be opened by a scanner, so the expected tag is `UNSUPPORTED` (documented AWS meaning: the file type or content, for example an encrypted file, cannot be scanned). CONFIRMED BY CODE: nothing in the repo handles that tag specially.
2. `scanPolling.ts` `mapTagToScanStatus`: `UNSUPPORTED` / `ACCESS_DENIED` -> `scanStatus: SKIPPED`.
3. `scanResultHandler.ts` `decideScanResult`: `SKIPPED` -> `block_unsupported_or_access_denied`.
4. `realScanGate.ts` `mapDecisionToStatus`: -> stored status `suspicious` (detail `UNSUPPORTED: ...`).
5. First upload / process (`realScanAdmission.ts` `applyVerdict`, old): any status other than clean or pending -> `blockSourceDocument` = document `parse_failed` with `parse_error=malware_scan_suspicious`, stored file purged, HTTP 422 "could not be cleared by our security scan ... has been deleted". This is exactly the "Parse failed" row the PO sees.
6. Replacement (WP-H, my code): `suspicious` -> `blocked` -> 422 with the same sentence.

Every CAMS / KFintech statement is password-protected (PO evidence: the 204 KB file is encrypted), so with the real scan on, every genuine statement was refused on first upload AND on replacement. Size is not a factor.

### Which outcome produced which answer (before this change)

| Gate outcome | Stored status | First upload / process | Replacement |
|---|---|---|---|
| tag absent after the inline poll (3 tries, 0.4 s apart) | `pending` | 409 pending | 409 pending, **state discarded** |
| `NO_THREATS_FOUND` | `clean` | admitted | admitted |
| `THREATS_FOUND` | `malicious` | 422 blocked, file deleted | 422 blocked |
| `UNSUPPORTED` / `ACCESS_DENIED` / unrecognised result | `suspicious` | 422 blocked, file deleted | 422 blocked |
| `FAILED`; S3 upload or verify failure; AWS settings missing | `scan_failed` | 422 blocked, **file deleted** | 503 |
| deadline passed (20 min) | `scan_timeout` | 422 blocked, **file deleted** | 503 |
| identity / version / account mismatch | `unknown` | 422 blocked, **file deleted** | 422 blocked |

So a scan that merely did not finish, a scanner outage and a mismatch were all reported as "your file failed the safety scan" and, on the first-upload path, destroyed the file.

### What presses 1 / 2 / 3 most plausibly were (replacement)

- Presses 1 and 2 (409 pending, spinner over 2 minutes): my replacement pre-scan wrote **no row state**, and every press uploaded the file again to the scan bucket under a fresh random key (`buildRealScanObjectKey` ends in a new UUID), polled that new object for about 1.2 s, then returned 409. The screen retried every 3 s for 120 s, so about 40 brand-new objects were created and none was ever polled for longer than 1.2 s. The pending state was not carried anywhere. That is a defect in our handling regardless of GuardDuty latency, and it matches "spinner then 409".
- Press 3 (422 "could not be cleared ... deleted"): the most plausible cause is one of those objects being tagged within the 1.2 s window with `UNSUPPORTED` (encrypted PDF) -> `suspicious` -> blocked. Less likely alternatives, none excluded: `THREATS_FOUND` (a genuine detection; implausible for a genuine statement), an `unknown` identity mismatch. `scan_timeout` / deadline expiry cannot be it: the replacement path maps those to 503 and, within one call, the deadline is 20 minutes ahead. The delete-access-denied finding (F-4) is about removing the scan copy AFTER a verdict; it does not decide the verdict.
- The first-upload evidence (same sentence, row `Parse failed`) is the same chain, steps 1 to 5.

Honest uncertainty: I did not see the tag. If the PO's pack 01 (below) returns `suspicious` with detail kind `UNSUPPORTED` on the failed statements, the cause is confirmed. If it returns `malicious`, `scan_failed` or `unknown`, this analysis is wrong for that file and the new audit events will name the actual code.

## 2. The fix

### 2a. Scan the decrypted bytes of a password-protected statement (first upload and replacement)

`scanPrepare.ts` `prepareBytesForScan`: if the PDF is encrypted, open it IN MEMORY with the person's password (the library handles AES-256, AES-128, RC4-128, RC4-40: all four tested) and hand the DECRYPTED bytes to the scanner. Outcomes: `as_is`, `decrypted`, `password_needed`, `wrong_password`, `cannot_decrypt`. Rules kept:
- The password is never stored, logged, audited, put in a URL or sent to the scan bucket; library error text is dropped; only a closed set of outcomes leaves the module. A test greps console output, audit events, database writes, the gate call arguments and returned results for the password.
- The decrypted copy exists only in process memory and as the scan object, which the existing strict-deletion purge removes after the verdict. It is never stored in Supabase Storage or the database.
- Missing or wrong password is the ordinary password flow, never a scan verdict, and deletes nothing. Wrong attempts are counted by the same shared limiter and window as the parser path (a failed parse-run row with `password_supplied`, value never stored) and checked before decrypting.
- No weakening: a plain PDF is scanned as it is; an UNSUPPORTED plain file stays blocked; a protection the library cannot open (`cannot_decrypt`) is refused as `unreadable_protection`; with the scan off nothing changes.
- First upload: the password is not known at upload, so for a protected file the upload route does not send it to the scanner and does not refuse it; the scan is deferred to the process call, which carries the password (`ensureIiRealScanAdmissible(user, id, { password })`). Nothing parses the stored bytes before that (the process route gates every parse; checked: `processSourceDocument` is otherwise reachable only from `resolve-instrument` and `amend`, see finding below). A missing or wrong password returns the existing `password_required` state (document status, one blocking case, same audit event).
- Replacement: the form's password is used for the scan and then for the identity check, exactly as before.

Residual exposure, stated plainly: opening the encrypted container means a pure-JavaScript PDF structure parser runs on the file before the scanner has seen anything. Only the person's own password opens it and nothing is executed or stored. The decrypted copy is re-serialised by the library, so the scanner sees an equivalent decrypted file, not the identical bytes, and the copy keeps the original container objects (nothing is removed, so no byte is hidden from the scanner). **The one thing I could not verify is that GuardDuty now returns a clean tag for such a decrypted copy**; see the PO checks.

### 2b. A scan that did not finish is never "blocked and deleted"

`scanRefusal.ts`: three outcomes, three wordings, one place (`scanRefusalHttp`) used by the upload, process and replacement routes.

| Situation | Outcome | HTTP and code | Stored file |
|---|---|---|---|
| scan still running | pending | 409 `malware_scan_pending`: "still being scanned ... nothing was deleted ... try again in a minute" | kept |
| threats found, unrecognised result | blocked | 422 `malware_scan_blocked` (the old sentence, only for a real finding) | deleted |
| UNSUPPORTED on a plain file | blocked | 422 `malware_scan_unsupported`: "cannot check this kind of file ... deleted ... if it is password protected enter its password" | deleted |
| timeout, FAILED, ACCESS_DENIED, identity mismatch, S3 failure | unavailable | 503 `malware_scan_incomplete`: "could not be completed ... not a finding about your file ... not been deleted" | kept; the next call scans again |
| scan on but not configured / 0196 absent | unavailable | 503 `malware_scan_unavailable` | kept |
| password missing / wrong / protection unreadable / too many attempts | password step | `password_required` state, 422 `unreadable_protection`, 429 | kept |

### 2c. Pending survives across presses (replacement)

`candidateHash` (SHA-256 of the file as uploaded) is stored in the scan reference JSON on the document row (no schema change). Press 1 uploads once and stores the pending state; press 2 with the same file continues polling the SAME S3 object; a clean verdict reached between presses is admitted and kept (not reset on attach); a clean verdict older than 30 minutes is not reused; a different file starts its own scan. Per-request poll budget is now 8 attempts 2 s apart (about 15 s, inside the 28 s web limit) for replacement and process, instead of 3 attempts 0.4 s apart; the screens keep retrying every 3 s for up to 2 minutes and now say "nothing was deleted".

### 2d. Reason codes without a schema change

Every refusal writes an `ii_audit_events` row of the existing type `document_processing_failed` with metadata `{ reason: 'malware_scan_refused', outcome: blocked|unavailable|refused, refusal: <code>, scanStatus }`: codes only, never content, a file name or a password. The scan state of a replacement candidate (status, detail, deadline) is also on the document row. Read-only pack `docs/reviews/po_apply_wp_h2/01_READ_ONLY_scan_state_and_refusals.sql` returns both (PGlite-verified, editor-safe, read only).

## 3. Tests (all PGLITE/UNIT; real parsers and real PDF library, scanner and storage stubbed)

- `iiWph2ScanPrepare` 13: four ciphers: locked for pdf.js, no password -> `password_needed`, wrong -> `wrong_password`, right -> decrypted bytes readable with no password and original untouched; owner-only protection; plain PDF containing the text `/Encrypt`; csv; password never in results or console.
- `iiWph2ScanAdmission` 45: stored-status classification table; honest wording; upload deferral (protected file not sent to the scanner), plain and owner-only decrypted scans; process: no/wrong/right password, attempt limit before decryption, THREATS_FOUND on a decrypted copy blocked and purged with a reason code and no password anywhere, final refusals not rescanned; timeout/failed/unknown/access-denied kept and rescanned, UNSUPPORTED plain file blocked; pending carried across presses (one upload, same object continued, clean on a later press admitted); poll budget bound; replacement presses (hash-keyed state, different file, 30-minute reuse, password cases, reason on row and audit trail); end to end replacement of a protected statement across three presses with the real replacement service.
- `iiWph2ScanRoutes` 12: process route: password step state, every refusal status/code/wording, password only reaches the gate and parser and is never echoed.
- `iiWph2SqlPackPglite` 3.
- Negative controls (mutation-checked, each turned named tests red, then restored): timeout treated as blocked-and-deleted (5 tests red); encrypted original sent to the scanner (decrypted-bytes test red); pending not continued (the persistence tests red).
- Updated for the new contract: `fdh11AuPublishJourney`, `iiWpbReplacementAndMissingFile`, `aieMalwareScanStateRepository`; the WP-H `iiWphReplacementScanGate` suite was superseded by `iiWph2ScanAdmission`.
- Wider run (`ii*`, `premiumUpload*`, `ownerBeforeUpload*`, `aie*`, `fdh11*`, `fdh3*`, `malware*`, `lr1*`): 288 files pass; the 2 other failures (`iiNetWorthNavRemarkPublishFlow` date-dependent, `lr1UploadSecurityRawFileLifecycle`) fail identically on main per the WP-B report. `tsc --noEmit`: only the two known errors. eslint clean on touched files.

## 4. Findings outside this change

- `resolve-instrument` and `resolutions/[caseId]/amend` call `processSourceDocument` directly, without the scan gate. They only matter while a stored file exists (rare, files are purged), but they would parse a never-scanned stored file. Not changed here; a candidate for the gate to move inside `processSourceDocument`.
- Other PDF paths with the same encrypted-PDF weakness are not touched: FDH bank PDF, AIE intake, retirement PDFs run their own `initiateRealMalwareScan` call sites and would receive `UNSUPPORTED` for a protected PDF too. `prepareBytesForScan` is reusable there.
- DEV had no `ii_source_documents.malware_scan_*` evidence reachable by this agent.

## 5. What the PO must do

1. Run `docs/reviews/po_apply_wp_h2/01_READ_ONLY_scan_state_and_refusals.sql` on production (read only). Result 1: failed statements should show `suspicious` with detail kind `UNSUPPORTED` if the diagnosis is right. After deploy, Result 2 lists every refusal with its code.
2. Operator checklist (AWS, read only, we have no access): (a) S3 console, scan bucket `AIE_MALWARE_S3_BUCKET`, prefix `ii/`, open a recent object of a failed statement: Properties -> Tags -> `GuardDutyMalwareScanStatus` (expected `UNSUPPORTED`). Do not download the object. (b) GuardDuty console -> Malware Protection for S3 -> the protection plan -> scan history: the same object key, status Skipped, reason unsupported. (c) CloudWatch log group `/aws/guardduty/malware-scan-events` (if the plan publishes to it), filter on the object key: `scanResultStatus`. (d) Amplify function logs: the gate logs only `ii real-scan: the scan is on but migration 0196 is not applied` and `ii real-scan block could not be recorded`; it never logged verdicts before this change, so there is no timeout line to find; the new audit rows replace that.
3. After deploy, on a statement you have the password for: upload it, enter the password when asked, expect the scan to run on the decrypted copy. Then check the S3 tag of THAT object: it must now be `NO_THREATS_FOUND`. If it is still `UNSUPPORTED`, the decrypted copy is not scannable either and the design needs a decision (for example refusing protected statements while the scan is on). Also confirm the scan copy is gone from the bucket afterwards. Never type or share the password anywhere else; none is stored by this change.
4. Confirm the replacement of the same statement across presses shows "still being scanned ... nothing was deleted" and then proceeds, and that no statement is marked failed because a scan timed out.
5. Dependency approval: `@cantoo/pdf-lib` is new (MIT, maintained fork of pdf-lib with encryption support). If you do not want a new dependency, the alternative is to refuse protected statements while the scan is on, which blocks all CAS uploads.

## 6. Honest limits

- GuardDuty's actual verdict on an encrypted PDF and on the decrypted copy: NOT OBSERVED (no AWS access). The `UNSUPPORTED` diagnosis is from the code path plus AWS documentation.
- The real CAMS / KFintech cipher was not available; AES-256, AES-128, RC4-128 and RC4-40 synthetic files are tested. A cipher variant the library cannot open is refused as `unreadable_protection` with its own wording, never silently passed.
- No browser click-through. The first-upload route test covers the process route; the upload route change is the shared `scanRefusalHttp` mapping (covered by the helper tests, not by a route-level test).
- The decrypted copy scanned is a re-serialisation by the library, not the identical decrypted stream bytes.
