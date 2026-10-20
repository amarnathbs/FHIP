# DOCUMENT2 (4) WP-B report: Review lifecycle and actions (F5, F6, F7, F8, F13, F14)

Branch `fix/doc2-4-wp-b-review-lifecycle-20261020`, based on `origin/main` 534bfb0. No migration was needed (range 0300-0303 unused). No production access, nothing pushed.

Evidence labels used: UNIT-TESTED (vitest, in-memory database that applies every filter), PGLITE-VERIFIED (real migration ledger replayed into an in-memory Postgres), DEV-verified, PRODUCTION-VERIFIED. **Nothing in this report is DEV-verified or PRODUCTION-VERIFIED: this agent had no DEV credentials and did not use production ones.** DEV proof is NOT PERFORMED and the steps are listed under "What the PO must do". No browser run was possible either (no DOM test tooling in the repo, no credentials), so screen behaviour is verified through the API/service chain behind each button, the rendered markup and the pure wording functions, not by clicking.

## The architecture rule applied

Raw statement files are temporary by design: `purgeSourceDocumentStorage` deletes the file right after every successful parse and the 24 hour backstop deletes everything else. A deleted file is not a bug and raw retention was NOT restored. Resolution works from retained structured data, or through a controlled replacement upload attached to the same logical document, or, when the information no longer exists, a governed close that keeps history.

## Finding by finding

### F5 and F6 (unresolvable old statement cases; dead "Resolve on statement" / "Review statement")

Root cause. (1) The Statements and data row drew `Document password` + `Reprocess` for every `parsed` statement and `Submit password and process` for `password_required` ones, with no knowledge that the file is gone; the only possible result was `Could not retrieve the stored document`. (2) `processSourceDocument` then opened a parse run and, for a document that had never failed, wrote `parse_failed / storage_download_failed`. (3) The Review list is a snapshot with no knowledge of the statement behind each item, so it kept sending people to "open the statement and enter the password". (4) Archived statements still showed open issues.

Fix.
- `lib/services/investment-intelligence/caseLifecycle.ts` (pure): classifies every case by what it really needs and whether the file is needed. Table: owner selection (no file), instrument resolution (choice saved without the file; applying it needs a replacement copy, said plainly), transaction classification (no file), source conflict (no file), password and reprocess (file needed), corrected file (file needed), informational (acknowledge only), anything else judged from retained data.
- `processSourceDocument` refuses a file-dependent run up front with the typed status `source_file_not_stored` and a plain sentence; it opens no parse run, uses no password attempt and never rewrites the document status.
- The statements list and the summary route return `has_stored_file` (never the storage path). The screen hides password and Reprocess when there is no file and offers `Upload replacement copy`.
- The Review list is enriched at read time with each item's live lifecycle. Items needing a deleted file show the explanation, `Upload replacement copy` and the governed `Close, I no longer have the file`, plus a bulk `Close all N stale items` banner. Closing is governed: server re-derives staleness, explicit confirm, status `resolved` with method `user_closed_stale_case`, evidence kept on the case, audit event, empty statements archived (never deleted), positions of statements that do have data re-evaluated from retained data.
- Review items whose case was closed elsewhere are resolved when the Review tab opens (`POST /review/sync`), so Review and Data tab agree.
- Resolve-instrument and amend return `needsReplacementCopy` and the Review screen says so instead of implying the statement was updated.
- `Re-evaluate all positions` (`POST /source-documents/[id]/reevaluate`) is the "rebuild from retained structured data" action; it never reads the file.

Tests. `iiWpbCaseLifecycle` (33), `iiWpbReplacementAndMissingFile` (16, behavioural incl. a named regression and negative controls), `iiWpbStaleCasesAndReviewSync` (23), `iiWpbRoutes` (14, includes cross-tenant 404s), `iiWpbSqlPacksPglite`. Mutation check: disabling the guard turned the two named regression tests red; restoring turned them green.

Verdict: CONDITIONAL (UNIT-TESTED, PGLITE-VERIFIED; DEV not performed, screens not clicked).

### F14 (re-upload refused as duplicate)

Root cause. `POST /source-documents` treats every same-bytes upload as an accidental duplicate (`identical_upload_different_owner` / `deduplicated`), so a document whose file was deleted could never be re-attached.

Fix. `POST /source-documents/[id]/replacement` (`sourceDocumentReplacement.ts`): attaches the new copy to the SAME `ii_source_documents` row (same id, same owner, same history; never a second document), updates only file reference, checksum, size and name, records the lineage on the audit trail (`upload` event with `controlledReplacement`, `replacementOf`, previous and new file name, checksum prefixes), re-runs the structural admission and resets and re-runs the real malware gate on the new bytes, revives a discarded statement, and refuses: file still stored (that is a real duplicate), a file already attached to a different statement of the person (names it), wrong type, failed structural check, another user's statement (404). Premium-gated before the body is read, exactly like the first upload. The screen then calls the ordinary process route with the password and `forceReparse` for an already-parsed statement. That path is idempotent (transactions matched by fingerprint, holdings upsert on account, instrument and date, cases opened idempotently), so no duplicate holdings, transactions or net worth. The ordinary upload route still refuses an accidental duplicate.

HONEST LIMIT. The in-memory database cannot match an existing instrument by name, so the no-duplicate-transactions/holdings property is not re-proved here; it rests on the pre-existing, live-DEV-proven fingerprint path. It must be confirmed in DEV (step 4 below). Also: nothing checks that a replacement copy covers the same period as the original; whatever it contains is deduplicated by fingerprint and attributed to the statement's existing owner.

Verdict: CONDITIONAL.

### F7 (buttons not working)

Findings per button (all traced button, route, service, DB):
- Re-evaluate: the recalculation worked, but there was no busy state, no result and the reason a position stayed `Needs review` (`blocking_reasons`) was never shown. Now: busy and disabled while running, a one-line outcome next to the button (`describeReevaluationOutcome`), and for every blocking code a what / why / how / call to action (`describeTruthBlocker`: owner links to the Review tab, an open blocking case scrolls to the issues, a unit variance says Re-evaluate cannot change it and names the real fix, a fuller consolidated statement). `Re-evaluate all positions` added.
- Publish to FHIP: the panel opened below the whole statement list with its errors shown only in the banner at the top of the page; now scrolled into view, errors and results inline, duplicate-click guard, list reloaded afterwards.
- Resolve (generic): busy state, inline result, Review items synced. For case types that have a real resolver (instrument, classification, conflict) the Data tab no longer offers a generic Resolve that only marks the case closed; it links to the Review tab action.
- Acknowledge and Dismiss: failures were swallowed and Dismiss was undone by the next refresh (`upsertReviewItems` looked only at open or acknowledged rows, so it inserted a fresh open row for the same unchanged condition). Fixed: per-item busy, visible errors, and a dismissal holds while the evidence is unchanged (raised again only if the evidence really changes).
- Amend, owner, instrument, transaction classification, open statement: unchanged mechanisms; instrument outcome now surfaced (see F5/F6).

Tests. `iiWpbReevaluateEndToEnd` drives the REAL certify route and `recertifyPosition`: blocked on owner, owner chosen and case resolved then Re-evaluate certifies; negative control (owner chosen, blocking case left open) still blocks and names the case; a unit variance stays blocked after Re-evaluate and says why. `iiWpbStaleCasesAndReviewSync` holds the dismissed-regeneration regression plus controls. Mutation check turned the regression red.

Verdict: CONDITIONAL (the button loop is proved through the API/service chain; clicking in a browser was not possible).

### F8 (about 50 `owner unmatched` rows)

Root cause. Every reprocess of a statement with no upload-time owner opened a fresh `owner_unmatched` case for every folio (12 folios x several reprocesses), the owner branch ignored an owner a person had already chosen, and certification marked the account `unresolved_owner` again.

Fix. `openReconciliationCase` has an opt-in idempotent mode (same user, subject, type and statement while open; per-instrument discriminator where needed) used for the owner, document-level and missing-transaction cases; the owner branch skips accounts with an explicit owner (a sole-member pointer or an active whole-account allocation, which only person-driven routes ever write; nothing assigns Self); certification's `ownerUnresolved` is per account; `tidyOwnerAndDuplicateCases` closes, as the system, open owner questions for accounts that already have an explicit owner (method `auto_resolved_existing_owner`) and exact duplicate open cases keeping the oldest (`auto_closed_duplicate_case`), run when the Review tab opens. The Data tab lists open cases in full and shows decided cases as a collapsed count by cause.

Never guessed: an account with no explicit owner keeps its open case and nothing is written to it (asserted). The count falls: 5 identical open cases become 1, 3 open owner questions become 1 when two accounts already had an owner (asserted). Read-only analysis for the PO: `po_apply_wp_b/02_readonly_owner_unmatched_causes.sql`.

Tests. `iiWpbStaleCasesAndReviewSync` (tidy, idempotent open, explicit owner loader), `iiWpbOwnerCasePipeline` (the REAL `processSourceDocument` on a parsable CAMS fixture: reprocess twice leaves one case; after an owner choice a reprocess opens none and does not re-block; control: unassigned account still asked and no owner written). Mutation check turned the owner test red.

Verdict: CONDITIONAL.

### F13 (investment warnings need a direct CTA and must clear)

Fix. The Dashboard note and the Investments bucket now link to where it is resolved: unpublished holdings carry their source statement; India holdings link to that exact statement (`/investment-intelligence/data?documentId=`, or the list when several), Australian imports to the Investments page; a note with no location data still links to the Investments page, never a dead note. The Investments bucket dates are now day-first (they printed ISO). The note is derived live on every load, so it clears when the position is published (asserted: publish, recompute, bucket empty). Closing a stale case or resolving from Review re-evaluates positions, so the status that decides publishability is current.

Tests. `iiWpbImportedNotInNetWorthCta` (9): link rules, read model, adapter pass-through, markup, clearing.

Verdict: CONDITIONAL. Note for the PO: the screenshot for F13 is the Investments tab; the same warning also appears on the Dashboard and both now link.

### Global stale-evidence audit

Code assuming the raw object still exists, found and handled:
| Place | Before | Now |
|---|---|---|
| `processSourceDocument` download | opened a run, wrote `parse_failed` | typed `source_file_not_stored`, no run, no status change |
| `POST .../process` (password, Reprocess, Process buttons) | dead end | not offered without a stored file; replacement flow |
| `resolve-instrument`, `resolutions/[caseId]/amend` (reprocess the source) | ignored failure | choice kept, `needsReplacementCopy` returned and shown |
| Review "enter the password" guidance | pointed at the dead flow | replaced by replacement copy / governed close |
| Data tab case list (generic Resolve, password text) | misleading | lifecycle-driven actions |
| `ensureIiRealScanAdmissible` | already tolerant | unchanged |
| Discard, owner, classification, cross-source, certify, publish, unpublish routes | file-independent (read) | unchanged |
Not audited (other work packages): FDH bank, retirement and AIE pipelines.

## Files changed

New: `lib/services/investment-intelligence/{caseLifecycle,staleCases,sourceDocumentReplacement}.ts`, `lib/investment-intelligence/importedNotInNetWorthLinks.ts`, `components/investment-intelligence/ReplacementCopyControl.tsx`, routes `source-documents/[id]/{replacement,reevaluate}`, `reconciliation-cases/close-stale`, `reconciliation-cases/[id]/close-stale`, `review/sync`, tests, `docs/reviews/po_apply_wp_b/`.
Changed: `documentProcessing.ts`, `reconciliationCases.ts`, `accountOwnership.ts`, `reviewCentreData.ts`, the Review and Statements clients, the statements list and summary routes, review GET route, resolve-instrument and amend routes, the dashboard engine type, `dashboardCanonicalAdapter.ts`, `read-models/investments.ts`, `DashboardDataStatusNotice.tsx`, `ImportedInvestmentStatements.tsx`, the imported-statements route, and `tests/unit/support/inMemorySupabase.ts` (opt-in composite upsert, `gt`, `or`; default behaviour unchanged). Files other packages may touch: none edited in `HoldingsTable.tsx` (WP-A); the Dashboard engine type and read model edit are additive optional fields.

Also touched (small, additive, owned by the Premium upload programme): the replacement upload is registered as gated surface `ii.source_document.replacement` in `lib/entitlements/financialImportInventory.ts` (counts 29 gated, 14 admission), the generated matrix in `docs/entitlements/PREMIUM_UPLOAD_ENTITLEMENT.md` was regenerated, and `premiumUploadInventoryContract` / `premiumUploadRoutes` gained the new surface. The existing per-surface checks then prove, with the real capability, that a Free user is refused 403 before the body is read with zero writes, and a Premium user is not refused. Two older structural tests were updated to the new contract (`iiOwnerChangeDialogUi`, `iiOwnerSeparationReaders`): the Data tab no longer draws a generic Resolve for a joint holding (it points to Review, now driven by the lifecycle) and certification's owner flag is per account using the explicit-owner set.

Admin Architecture Standard: not applicable (no Admin route, capability or screen touched).

## What the PO must do (DEV first, nothing on production)

1. Run the three read-only packs in `docs/reviews/po_apply_wp_b/` on DEV (and later production, they are read only) to see the classification, the owner-case causes and the regeneration check.
2. On DEV open the Review tab on an account with old cases: confirm the stale banner, try `Upload replacement copy` on a password-protected statement (needs the real file and password), then `Close all stale items` for the ones you no longer have the file for.
3. On DEV confirm the open owner-unmatched count falls after opening Review (explicit-owner accounts only) and that an account you never assigned keeps its question.
4. On DEV re-upload a replacement copy of an already-processed statement and confirm the holdings, transactions and net worth do not change (the no-duplicate property).
5. Click Re-evaluate, Publish to FHIP, Acknowledge and Dismiss on DEV and confirm each shows its result, and that a dismissed item does not return after Refresh observations.
6. Production stays gated: uploads and replacement uploads are Premium-gated and behind the existing malware/readiness switches; nothing here enables anything.

## Verification summary

- `tsc --noEmit`: only the two known pre-existing errors (`aiProductionProofPackPglite.test.ts(174,25)`, `canonicalCertResidueAllSql.test.ts(127,75)`); eslint clean on the changed files.
- New suites: `iiWpbCaseLifecycle` 33, `iiWpbStaleCasesAndReviewSync` 23, `iiWpbReplacementAndMissingFile` 16, `iiWpbRoutes` 14, `iiWpbReevaluateEndToEnd` 5, `iiWpbOwnerCasePipeline` 3, `iiWpbReplacementCopyControl` 7, `iiWpbSqlPacksPglite` 11 (real migration ledger replayed into PGlite), `iiWpbImportedNotInNetWorthCta` 9: all pass. Negative controls shown to break: disabling the stored-file guard, the dismissed-item fix, the idempotent-open flag and the explicit-owner skip each turned named tests red; restoring turned them green.
- Full unit suite (origin/main + this branch): 51 files failed. The same 51 files were re-run on a pristine `origin/main` worktree: 47 fail identically there (environmental / pre-existing; for example `adminAnalyticsPhaseAMeRoute`, `countryGateAccessMatrix` (admin account-deletions route), `dateFormatVisibleTextGuard` (`lib/reports/printDocumentTitle.ts`), `smsfHouseholdIsolation`, `iiNetWorthNavRemarkPublishFlow` (a date-dependent stale flag), `lr1UploadSecurityRawFileLifecycle`, `promoHardening*`, and the resources / benchmark / planning-benchmark import-level files). The other 4 failed only on this branch and were fixed (3: described above) or were load flakes that pass alone (`benchmarkDataAdminRoutes`, 286 passing). After the full run `git checkout -- scripts/` was applied and the generated `test-artifacts/` removed.
- Evidence labels: UNIT-TESTED and PGLITE-VERIFIED only. DEV-verified: NOT PERFORMED. PRODUCTION-VERIFIED: NOT PERFORMED. Browser click-through: NOT PERFORMED.
