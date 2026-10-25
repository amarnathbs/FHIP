# DOCUMENT2 (4) WP-B2 report: published state in the Portfolio Truth list, and a visible Re-evaluate result

Branch `feat/doc2-4-wp-b2-published-state-reevaluate-20261025`, from `origin/main` 6ea9b5f. No migration (range 0317-0318 unused). No production access, nothing pushed.

Evidence labels: UNIT-TESTED and PGLITE-VERIFIED (the real services, the real summary / certify routes and the real row component run against the real migration ledger replayed into PGlite). DEV-verified: NOT PERFORMED. PRODUCTION-VERIFIED: NOT PERFORMED. Browser click-through: NOT PERFORMED (no credentials, no DOM test tooling). Findings below that describe production behaviour are inferred from the code and from the PO's screenshots, and are labelled so.

## (1) Already-published positions

PO report: published positions still showed `Publish to FHIP`; the panel said `New position adds ₹74,977 to net worth` and `Confirm & Publish` was disabled.

Reproduced from the code, three separate defects:
1. **The list never knew about publications.** `canPublish` was only "status is certified", so every certified position showed the blue button whether or not it was published. The summary route returned no publication data and the row took the FIRST snapshot of this one statement as the publish target (not the latest certified one).
2. **The impact text was wrong at two levels.** `buildPreview` set the "currently included" value of an already-published position to the NEW value, and `calculateFinancialImpact` ignores that field when computing the net change, so the net change was the whole value. The client then printed `New position adds X` unconditionally.
3. **No Refresh and no state.** The panel told the person to "use Refresh" and offered none; nothing said whether the published value was stale against a newer certified statement.

Fix.
- `lib/investment-intelligence/publicationState.ts` (pure): `derivePublicationState` gives `not_published`, `published_current` or `published_refresh_available`, using exactly the rule `refreshPosition` applies (`decideRefreshSupersession`), so a refresh is only offered when it would be accepted. `describePanelImpact` states what is true and decides which confirm button is valid: publish (not published), refresh (newer certified statement), or none (same statement, or an older one).
- The summary route returns, per position: the latest certified snapshot across ALL statements, the active publication, what net worth counts today (the published investments row), the earliest transaction date, and the publication state.
- `buildPreview` now loads what the active publication really counts and how the previewed snapshot relates to it (`same_snapshot` / `newer_snapshot` / `older_snapshot`); the net change is the real change (0 for the same statement; new minus counted for a newer one).
- New row component `PortfolioTruthPositionRow`: `Published` pill, `Counted in net worth: ₹X · from the statement dated dd-mm-yyyy`, `Unpublish` always, `Refresh` only when a newer certified statement exists (with the stale note and its date and value), and `Publish to FHIP` ONLY for an unpublished, ready position. Unpublish works from the list with a confirmation and a busy state.
- Panel (shape; the figures depend on the data): `Already counted in net worth: ₹7,800 (statement dated 31-03-2025). Refresh will update it to ₹X (change +₹Y).` The confirm button exists only when an action is valid (`Confirm & Publish` or `Confirm refresh`); for the same statement there is no confirm, only Unpublish.

Design note for the PO: I did not draw a Refresh button on a position that is already up to date, because it would do nothing (`refreshPosition` answers `ALREADY_ACTIVE`). It says `Up to date: no newer certified statement.` instead. Say so if you want an always-present Refresh.

Tests (`iiWpbTwoPublishedStateAndReevaluatePglite`): publish, then summary route, then the row markup: only `Re-evaluate` and `Unpublish` and no `Publish to FHIP`; unpublish it and `Publish to FHIP` is offered again (negative control); the panel for the same statement has no confirm, net change 0 and never says "New position"; with a newer statement (processed through the real replacement flow) the row shows `Refresh`, the stale note and the day-first date, the panel offers `Confirm refresh` with the correct change, refreshing makes the position current and net worth counts the new value once; the older statement previewed afterwards is `older_snapshot` with no confirm. Mutation check: forcing `not_published` and restoring the old impact formula turned four named tests red; restoring turned them green.

Verdict: CONDITIONAL (PGLITE-VERIFIED; DEV and browser not performed).

## (2) Re-evaluate "shows nothing" on a Needs review position

What I found, and what I could not determine. The Re-evaluate chain works end to end: the real certify route recomputes the position and returns its figures (tested: 40 units rebuilt against 150 on the statement, variance -110). WP-B did render an inline outcome, so this was NOT a missing handler. What the PO saw is, from the code, a presentation failure: the result was one small grey line directly above the amber blocker box that said the same words, with no time, no figures and no button, so a repeated click looked identical. I cannot see production, so this cause is inferred; I found no error-swallowing path (a failed request already showed an error).

Fix. After a click the row shows, in its own status card (green or amber, announced to screen readers, scrolled into view): the time checked (`Checked just now (25-10-2026 14:05)`), the outcome with the figures, whether anything changed, what fixes it, and a real button. For this exact case:

`Still needs review: the units rebuilt from the transactions (40) do not match the statement closing balance (150); 110 units are missing.`
`The earliest transaction held for this position is dated 10-01-2025, so the missing history is from before 10-01-2025: purchases made earlier are not in the statements uploaded so far.`
`What will fix it: upload a CAMS or KFintech consolidated statement that covers the whole history, from the first investment in this fund to today.` [Upload statement] (scrolls to Step 1 and focuses the file picker).
`Re-evaluating only re-runs the check on the data already held; it cannot add missing history.`
`There is no way to accept this gap: a unit mismatch is never downgraded to a warning, so this position cannot be published until the history is complete.`

Governed alternative: the PO asked for "accept with known gap / enter opening balance" if one exists. None exists in the current rules: `certification.ts` makes a unit mismatch a hard blocker that is never downgraded, and the opening-balance mechanism only applies when a statement itself prints an "Opening Balance" line. I did not invent one; the card says so instead of leaving the person looking for it. If you want a governed "accept with a known gap" path, that is a policy decision for you (it would change the certification rules).

Also: the standing explanation (before any click) now carries the same figures and the Upload statement button; a failed request shows `Re-evaluate did not complete: ... Nothing was changed.`; the unchanged-result wording is explicit (`Nothing has changed since the last check: the same reason still applies.`); and a position that becomes ready says so.

Tests: the real certify route and summary route on a folio with a 40-unit purchase against a 150-unit statement; the card text above is asserted verbatim; the markup contains the card, the figures, the time and the Upload statement button and does not repeat the standing blocker box; running, failed and became-ready states are asserted. Mutation check: the unchanged-result sentence turned a named test red.

Verdict: CONDITIONAL (PGLITE-VERIFIED; the production cause is inferred).

## Checks

- `tsc --noEmit`: the two known pre-existing errors, plus `Cannot find module '@cantoo/pdf-lib'` in `scanPrepare.ts` and `tests/support/buildEncryptedPdf.ts`. The last two are environmental: the dependency was added by WP-H2 (5307f5b) and this worktree shares the main checkout's `node_modules`, which does not have it. Run `npm install` in a normal checkout. Not caused by this change.
- eslint clean on the changed files. Existing suites touching these files (32 files, 595 tests): all pass except `iiNetWorthNavRemarkPublishFlow` (a date-dependent "stale" flag; it fails the same way on origin/main).

## What the PO must do (DEV first)

1. On DEV open Statements & data for a statement with published positions: confirm each shows `Published`, its counted value and `Unpublish`, and none shows `Publish to FHIP`. Upload a newer statement and confirm `Refresh` and the stale note appear, then open Refresh and confirm the panel text and the figure.
2. Click Re-evaluate on a Needs review position with missing history and confirm the card, the figures and the Upload statement button.
3. Decide whether you want an "accept with known gap" governed path (policy decision; none exists today).
