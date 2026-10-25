# DOCUMENT2 (4) WP-H3 report: duplicate transactions after a replacement reprocess (null source reference)

Branch `feat/doc2-4-wp-h3-null-reference-dedup-20261025`, based on `origin/main` dd8588b. No migration. No production access. Nothing pushed.

Evidence labels: UNIT-TESTED, PGLITE-VERIFIED (real migration chain in in-memory Postgres, real PDFs, real CAMS parser), DEV-verified, PRODUCTION-VERIFIED. **DEV-verified and PRODUCTION-VERIFIED: NOT PERFORMED.** The production figures below are the PO's observations as relayed; I did not see the rows.

## 1. What happened and why my WP-H oracle missed it

Production observation: replacing the 01-01-1990 to 06-09-2026 statement and reprocessing it added 6 `ii_transactions` rows (952 to 958) and 6 source links; five of them have an older twin (same user, account, statement, fund, date, type, amount; both with a NULL `source_reference`; older rows created 07-09-2026), the sixth (2009 reversal 1,000.00) has none.

Root cause, from the code:
1. A re-read line counts as "already recorded" only if its **fingerprint** is already stored for that account (`documentProcessing.ts`, `existingFingerprints`). The fingerprint is a hash over source, account, fund, date, type, amount, **units, NAV** and source reference.
2. Real CAS lines carry no provider reference. The unique index that stops a re-read inserting the same line twice (`uidx_ii_transactions_dedup`, migration 0033) covers only rows with a non-null `source_reference`, so for these rows the fingerprint is the only guard.
3. The same-day parser fixes of 07-09-2026 (alt-layout under-capture, the glued Price/negative-Units fix, the purchase/rejection-pair reclassification, and others) legitimately change **units, NAV and type** of lines. A statement processed before those fixes and re-read today therefore yields a different fingerprint for the same real line. Nothing matched, so the line was inserted again, with its own originating source link (that is why links rose 952 to 958 in step with transactions).
4. The cross-source matcher does not help: it deliberately compares only against rows of other documents.
5. Why my WP-H oracle did not catch it: the WP-H fixtures printed a `[Ref: ...]` on every line, and the "earlier parse" was always byte-identical to the re-read, so the fingerprint always matched. Neither the null-reference shape nor a changed re-read was exercised. WP-J's large-CAS fixture has the same blind spot (every line carries a `[Ref: ...]`).

## 2. The fix (code)

`reparseMatching.ts` (pure) wired into `processSourceDocument`. Within the document being re-read, a line that matches no fingerprint is looked up by natural key (account, fund, date, signed amount to the paisa). Each stored row can be claimed by at most one line (multiset match; rows already matched exactly by fingerprint are excluded first, so two genuine same-day lines stay two).
- Same type, units and NAV: it is the same row. Linked (the link upsert is a no-op for an existing link), nothing inserted.
- A row a person corrected (audit `user_correction`), or that is not plainly `parsed`: the person's decision stands. Linked, nothing inserted.
- A system-read row whose details the corrected parse now reads differently: a **correction row** (`status = 'corrected'`, `corrects_transaction_id` = the old row) is inserted and the old row becomes `reversed` after the correction is safely written (the existing soft, audited, reversible exclusion). A run that stops between the two writes is finished by the next re-read (self-healing). One `document_superseded` audit event per run carries counts and an id sample.
- No stored twin: genuinely new, inserted as before.
Second pass: the corrected row's fingerprint now matches, so a repeat adds 0 (asserted).
Also: the unit reconciliation, the derived zero-unit closure, cost value / benchmark window and the AIE roll-forward now ignore `reversed` rows (the first two read them without a filter, so a reversed row would still have counted).

Behaviour change to be aware of: reprocessing a statement after a parser fix now **replaces changed system-read lines** instead of adding a second copy.

## 3. Failing-first proof (PGLITE-VERIFIED)

`iiWph3NullReferenceDedupPglite` (10 tests): real PDFs with NULL references, rows aged to look like an earlier parse (other units/NAV, one other type, stored fingerprint over the old values), then the real replacement + reprocess. **On the unfixed code 5 tests fail with the production symptom** (10 counted rows where 5 are expected). With the fix all pass: 5 counted rows, 5 reversed, 5 corrected pointing at the reversed ones, units equal the corrected parse, links up by exactly the replaced lines, second pass adds nothing, an unchanged earlier parse inserts nothing, a line with no twin is the only legitimate insert, the multiset cases, the person-correction case, other documents untouched, no `unit_mismatch` raised by replaced rows. Mutation checks (each turned named tests red, then restored): natural lookup removed (5 red), person decision ignored (2 red), the fingerprint-claimed exclusion removed (pure test red). Pure rules: `iiWph3ReparseMatching` (9).

Limit found on the way (pre-existing, not changed): two **byte-identical** lines in one statement share one fingerprint, so the second never inserts. Two same-day same-amount lines with different units are fine.

## 4. The 2009 reversal of 1,000.00 (no look-alike)

Cannot be settled without the rows. Most plausible: an earlier parse stored the same line with a **different type** (the purchase/rejection-pair reclassification landed the same day, 07-09-2026) and your look-alike query required the same type; or the earlier parse never captured the line (the alt-layout under-capture fixes landed the same day). The new natural key ignores type, so the fixed code treats a same-date same-amount twin of any type as the same line. Pack 02 answers it for the row: it lists older rows of the same statement and fund on that date and names the relation (same amount different type, opposite sign, different amount). If it shows none, the row is genuinely new, not a duplicate, and must not be retired.

## 5. Cleanup design for the existing duplicates (PO pack `docs/reviews/po_apply_wp_h3/`)

Mechanism: `ii_transactions` is append-only by design; the legitimate exclusion is `status = 'reversed'` (already honoured by XIRR, tax lots, ledger, valuation, missing-transaction detection and now the unit check) plus an audit row. No row is deleted, links stay, rollback restores the exact statuses.
Packs (all PGLITE-VERIFIED against the real schema, editor-safe): 01 detector (every group of repeated lines written by more than one run, per account, with side-by-side rows and a `consistent_units` plausibility column), 02 look-alikes for new rows, 03 backup of the exact rows and links into dated tables (fails if they exist), 04 preview (pairs, units/amount per position before and after, guards), 05 apply (one transaction, guards: something chosen, at most `max_rows`, backup holds every row, rows still counted; sets `reversed`; one `admin_correction` audit row each), 06 verify, 07 rollback (idempotent).
The rows are chosen **by rule** (email, time window, pairs of rows of one statement/account/fund/date/amount from different runs, each older row used once), never hand-typed ids.
**Decision for the PO, not assumed:** the instruction was to retire the newer rows. That is only right if the newer rows are the wrongly read ones, and the evidence points the other way: the newer rows carry the current parser's figures (for example 766.284 units at 13.05 is consistent with 10,000.00) and the earlier parse predates the same-day parser fixes. Pack 04 shows `retire_consistent_units` and `keep_consistent_units` for every pair; if the newer rows are the consistent ones, set `retire_which` to `older`, which leaves the system in exactly the state the fixed code would have produced. Deploy the code release before applying (so the unit check ignores reversed rows).

## 6. Effect on figures while the duplicates exist (assessment)

For each of the six rows, until retired: units of the position are counted twice (sum of signed units), contributions / cost value (purchase amounts) and XIRR cash flows carry an extra flow (the five twins total 14,000.00 of amount; the six together 15,000.00), tax lots (FIFO) get extra lots, and the statement-wise unit reconciliation compares a wrong derived balance with the printed closing balance. Holding snapshots, publications and the Net Worth value are **not** affected (they come from snapshots and published values), which matches "holding snapshots unchanged".
"Positions needing attention 15 to 6" is **not evidence of improvement and may be an artefact**: the unit check adds signed units of all counted rows; extra rows can make a previously mismatching position coincidentally equal the printed balance (if the earlier rows under-counted), or the reverse. Which positions were really right is only knowable after cleanup plus Re-evaluate all positions. Expect some of the 6 improved positions to need attention again if the older rows were the under-counted ones; that is then a parser question, not a duplicate.

## 7. Review of WP-J and WP-G

- **WP-J** (`feat/doc2-4-wp-j-statement-reprocess-job-20261022`, still in progress): the committed state changes no ingest logic, only a large-CAS fixture builder, a DEV profile harness and migration 0312 (parse-run counters). Risks to carry into its review: (a) its fixture prints `[Ref: ...]` on every line, so it cannot exercise this class: add a null-reference variant and a changed re-read; (b) a chunked or resumable reprocess must keep the natural-key claim state **across chunks** (a pool built per chunk would let a later chunk claim a row an earlier chunk already matched, or miss the twin) and must run the supersession/reversal step once per document, not per chunk; (c) it should build on this branch's `processSourceDocument` rather than copy the ingest loop; (d) migration 0312 duplicates the 0159 counters this repo already has: it is idempotent (`add column if not exists`), so harmless, but note the 0159/0312 overlap.
- **WP-G** (bank import job): different class. Its exactly-once key is `(statement_upload_id, source_row)` (unique index 0311 plus a check before insert), a positional key within one upload. It is stable for one file and one parse; it would mis-pair only if a retry re-extracts the same upload with a different line order or count (an AI fallback is non-deterministic), because row N could then be a different transaction. Not the null-reference problem; worth one test where a retry returns the lines in a different order.

## 8. Tests and checks

New: `iiWph3NullReferenceDedupPglite` 10, `iiWph3ReparseMatching` 9, `iiWph3SqlPackPglite` 17. Wider run (`ii*`, `aie*`, `premiumUpload*`, `fdh11*`, `ownerBeforeUpload*`): 282 files pass; the 3 failures are `iiWph2ScanAdmission` and `iiWph2ScanPrepare` (this worktree has no `@cantoo/pdf-lib` installed: an environment gap, they pass where it is installed) and the date-dependent `iiNetWorthNavRemarkPublishFlow` (fails identically on main). `tsc`: the two known errors plus the same `@cantoo/pdf-lib` environment gap. eslint clean on touched files.

## 9. What the PO must do

1. Deploy the release, then on DEV (or production, read only) run pack 01 and pack 02; the production `consistent_units` column and pack 04 decide `retire_which`.
2. Take the backup (pack 03), preview (04), apply (05), press Re-evaluate all positions, verify (06). Rollback is pack 07.
3. Treat 15 to 6 as unproven until after step 2.
4. Optional DEV rehearsal of a replacement + reprocess of a statement whose lines carry no reference: NOT PERFORMED here.

## 10. Honest limits

- The earlier-parse rows are reproduced by ageing rows (other units/NAV/type and a stored fingerprint over them), not by running the actual 07-09 parser; the production rows' actual differences (which of units, NAV, type) are unknown to me.
- The natural key is scoped to one document. A second **document** carrying the same history is still handled by cross-source identity, unchanged.
- Whether to retire newer or older rows is a data question I could not answer.
