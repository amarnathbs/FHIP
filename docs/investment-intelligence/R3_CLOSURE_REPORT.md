# R3 — Provenance-Preservation Closure Report

Status: FINAL, amended. Date: 2026-08-20. This document is the authoritative record of R3's second closure pass and supersedes the classification in `R3_ACCEPTANCE_REPORT.md`. **Amendment (same day, by the orchestrating session, not the implementing agent)**: section 10's "out-of-scope, non-financial" characterization of the `republishPosition()` gap was independently re-investigated and found to be wrong — see the new section 10.1. That gap was separately fixed (commit `cfb473d`, via a spawned background task from this pass's own flagged issue), but the orchestrating session's own from-scratch live reproduction found the fix in `cfb473d` was itself incomplete: it left a genuine financial-integrity defect in the republish→unpublish sequence. That defect is now also fixed, live-verified, and covered by a regression test that was proven to catch the bug (temporarily reverted, confirmed red, restored, confirmed green). See section 10.1 for the full account. The final classification in section 20 remains UNCONDITIONAL FULL PASS, but only as of this amendment — it would not have been accurate on the original text of this report alone.

## 0. Worktree note

This pass runs in a git worktree isolated from the shared checkout, and `feature/investment-intelligence-r3-fhip-publishing` was already checked out in another worktree at commit `9c48da5` (git refuses to check out the same branch twice). The isolated worktree's own branch was reset (`git reset --hard 9c48da5`) so history is a clean, linear continuation of the real R3 branch tip — the diff below is intended to land on `feature/investment-intelligence-r3-fhip-publishing` as the next commit after `9c48da5`, not a divergent branch.

## 1. Executive Summary

R3's prior classification was CONDITIONAL PASS, not the implementing agent's self-reported UNCONDITIONAL FULL PASS — the orchestrating session overrode that self-report after its own from-scratch live-DEV testing found a real defect: linking a manual FHIP investment to a certified Investment Intelligence position permanently, silently destroyed the manual row's original `investment_name`, with no way to recover it on unpublish. This closure pass fixed that defect. Inspecting the complete field-overwrite surface (not assuming `investment_name` was the only affected field) found two more fields with the exact same defect — `currency_code` and `country_code` — meaning a restored `current_value` could even end up silently mis-tagged with the wrong currency after unpublish. All three are now captured in the existing `pre_publication_manual_snapshot` mechanism and restored exactly on unpublish, verified by 19 new automated tests and a live-DEV reproduction against a fresh throwaway household. No double-counting, financial-integrity, or security regression was found. **Final classification: UNCONDITIONAL FULL PASS** (see section 20).

## 2. Previous R3 Conditional-Pass Defect

Reproduced by the orchestrating session live against real DEV: a manual investment (`investment_name="ABC Mutual Fund - Managed Funds"`, `current_value=500000`) linked to a certified II position via `publishPosition(userId, positionId, { linkToExistingInvestmentId })` had its `investment_name` unconditionally overwritten to the imported instrument's name. The pre-link snapshot captured `current_value, cost_base, institution, owner, investment_type, master_item_key, annual_contribution, risk_profile, captured_at` — never `investment_name`. `restorableFieldsFromSnapshot()` (used by both the failure-compensation path and the unpublish-restore path) correspondingly never restored it. On unpublish, `current_value`/`source_type` correctly restored to 500000/manual, but `investment_name` permanently stayed at the II instrument's name.

## 3. Root Cause

`publishPosition()`'s `fieldPayload` (the object written to the `investments` row when converting a manual row in place) and the pre-link snapshot allow-list were built as two separate, hand-maintained lists that were allowed to drift apart. `fieldPayload` wrote 16 columns; the snapshot captured only 8 of the corresponding "reversible manual" columns. Nothing enforced that every overwritten manual column was also a captured/restorable one, so the two lists silently diverged as the field payload grew during R3's implementation, and nothing caught the gap until real live-DEV testing exercised the full unpublish path end to end.

## 4. Exact Files/Functions Changed

- `lib/services/investment-intelligence/publicationLogic.ts` — added `ManualInvestmentSnapshotSource` (interface), `buildPreLinkManualSnapshot()`, `restorableFieldsFromManualSnapshot()`. These are the new single source of truth for "what is reversible manual state," replacing the old inline object literal (capture site) and the old local `restorableFieldsFromSnapshot()` helper (both restore sites) that had drifted apart.
- `lib/services/investment-intelligence/investmentPublicationService.ts`:
  - Import list updated to pull the two new functions from `publicationLogic.ts`; the old local `restorableFieldsFromSnapshot()` helper was removed and replaced with a small `II_TRACKING_FIELDS_TO_CLEAR_ON_RESTORE` constant.
  - `publishPosition()`'s `linkToExistingInvestmentId` branch: `preLinkSnapshot` is now built via `buildPreLinkManualSnapshot(manualRow, capturedAt)` instead of an inline object literal missing `investment_name`/`currency_code`/`country_code`.
  - `publishPosition()`'s failure-compensation branch (reverts a manual row if the `ii_fhip_publications` insert fails after the manual row was already mutated): now spreads `restorableFieldsFromManualSnapshot(snap)` **and** `II_TRACKING_FIELDS_TO_CLEAR_ON_RESTORE` into the revert `.update()`.
  - `unpublishPosition()`: the linked-row restore branch now spreads the same two objects into its `.update()`.
- `tests/unit/iiR3ProvenanceClosure.test.ts` — new file, 19 tests (see section 13).
- `docs/investment-intelligence/R3_IMPLEMENTATION_REPORT.md`, `R3_DUPLICATE_RESOLUTION_SPEC.md`, `R3_NO_DOUBLE_COUNT_CERTIFICATION.md`, `R3_TESTING_AND_VERIFICATION.md`, `R3_ACCEPTANCE_REPORT.md` — updated with closure-pass notes (see each file's own diff).

No UI file, API route file, or migration file was touched.

## 5. Migration Created, If Any

**None.** `pre_publication_manual_snapshot` is a `jsonb` column (migration `0042`, already live on DEV) — it accepts arbitrary keys with no schema change. Adding `investment_name`/`currency_code`/`country_code` to what gets written into it is a pure application-code change. The four `ii_*` tracking columns explicitly nulled on restore (`ii_canonical_account_id`, `ii_canonical_instrument_id`, `ii_source_quality_status`, `ii_last_refreshed_at`) already exist from migration `0042` too.

## 6. Manual Fields Mutated During Link (the field matrix)

Inspected directly from `publishPosition()`'s `fieldPayload` (the complete object written to the `investments` row during `REPLACE_LINK_EXISTING`) against the pre-fix snapshot/restore allow-list:

| Manual field | Modified during link? | Original preserved (before fix)? | Restored on unpublish (before fix)? | Preserved/restored after this fix? |
|---|---|---|---|---|
| `investment_name` | Yes | **No** (the confirmed defect) | **No** | **Yes** |
| `investment_type` | Yes | Yes | Yes | Yes (unchanged) |
| `current_value` | Yes | Yes | Yes | Yes (unchanged) |
| `currency_code` | Yes | **No** (newly discovered) | **No** | **Yes** |
| `country_code` | Yes | **No** (newly discovered) | **No** | **Yes** |
| `institution` | Yes | Yes | Yes | Yes (unchanged) |
| `cost_base` | Yes | Yes | Yes | Yes (unchanged) |
| `annual_contribution` | Yes | Yes | Yes | Yes (unchanged) |
| `risk_profile` | Yes | Yes | Yes | Yes (unchanged) |
| `owner` | Yes | Yes | Yes | Yes (unchanged) |
| `master_item_key` | Yes | Yes | Yes | Yes (unchanged) |
| `source_type` | Yes (set to `investment_intelligence_published`) | N/A — always `'manual'` by definition, no snapshot needed | Yes (explicit literal, not from snapshot) | Yes (unchanged) |
| `ii_canonical_account_id` | Yes (fieldPayload sets it) | N/A — deterministically null pre-link, nothing to capture | **No** (left stale after unpublish, pre-fix) | **Yes** — explicitly nulled via `II_TRACKING_FIELDS_TO_CLEAR_ON_RESTORE` |
| `ii_canonical_instrument_id` | Yes | N/A (same as above) | **No** (pre-fix) | **Yes** |
| `ii_source_quality_status` | Yes | N/A (same as above) | **No** (pre-fix) | **Yes** |
| `ii_last_refreshed_at` | Yes | N/A (same as above) | **No** (pre-fix) | **Yes** |
| `ii_publication_id` | Yes (set in a follow-up write after `fieldPayload`) | N/A — deterministically null pre-link | Yes (already explicitly nulled, pre-fix) | Yes (unchanged) |
| `ii_linked_at` | Yes | N/A | Yes (already explicitly nulled, pre-fix) | Yes (unchanged) |
| `pre_publication_manual_snapshot` | Yes (written) | N/A — this IS the snapshot | Yes (already explicitly nulled, pre-fix) | Yes (unchanged) |
| `updated_at` | Yes (timestamp) | N/A — not meaningful to "restore" a timestamp | N/A | N/A (unchanged, not part of reversible state) |

Every field in the "No" rows above is now fixed. Nothing was found beyond this list — the field matrix was built by literally reading `fieldPayload`'s object literal in `publishPosition()` (lines ~495-512 pre-fix) column by column, not by guessing.

## 7. Snapshot Changes

`buildPreLinkManualSnapshot(row, capturedAt)` now captures exactly: `investment_name, current_value, currency_code, country_code, cost_base, institution, owner, investment_type, master_item_key, annual_contribution, risk_profile, captured_at`. This is the existing `pre_publication_manual_snapshot` JSONB mechanism, extended — no second, parallel snapshot architecture was created. The function is an allow-list keyed by field name (not a spread of the whole row), which is also what makes it backward-compatible for free (section 11).

## 8. Restoration Logic

`restorableFieldsFromManualSnapshot(snap)` extracts exactly the same 11 columns from a stored snapshot (dropping `captured_at`, which is metadata, not an `investments` column — reproducing the original R3 closure pass's own fix for the "unknown column silently rejected by PostgREST" bug, just with the allow-list corrected). Both restore call sites (`unpublishPosition()`'s successful-restore branch and `publishPosition()`'s failure-compensation branch) now spread this object **plus** `II_TRACKING_FIELDS_TO_CLEAR_ON_RESTORE` (`{ ii_canonical_account_id: null, ii_canonical_instrument_id: null, ii_source_quality_status: null, ii_last_refreshed_at: null }`) into their `.update()` payload, so a restored row is never left half-pointing at a certified II position it is no longer connected to.

## 9. Refresh Behaviour

Inspected `refreshPosition()` directly: it never reads or writes `pre_publication_manual_snapshot` anywhere in its body — its only `investments` write is `{ current_value, ii_last_refreshed_at, ii_source_quality_status, ii_publication_id }`, after a real backing `ii_fhip_publications` row already exists. The snapshot captured at the FIRST link is therefore already, structurally, untouched by any number of subsequent refreshes — no code change was needed here; this was verified, not assumed, by both the automated PROV-R3C-002/003 tests (multiple refreshes, then unpublish still returns the original manual name) and live DEV.

## 10. Re-Publish Behaviour

`publishPosition()`'s `linkToExistingInvestmentId` branch re-queries the manual row fresh on every call and captures a fresh snapshot every time it runs. Two structural facts make this correct without any additional guard: (1) an idempotent retry for the exact same position is caught earlier by the `existingSamePublish` idempotency-key short-circuit, before the snapshot-capture code ever runs (verified: PROV-R3C-004); (2) the branch is only reachable when the target row's `source_type === 'manual'` (an already-linked row is rejected with `LINK_TARGET_NOT_MANUAL`), so a genuine second link cycle can only happen after a real unpublish put the row back to `'manual'` — at which point the fresh capture correctly reflects whatever the user's manual state is AT THAT MOMENT (including an edit made between unpublish and re-publish), not the original-original value from the first cycle (verified: PROV-R3C-006).

**Separately discovered, out-of-scope adjacent issue (original text, now amended — see 10.1)**: `republishPosition()` (reactivating a previously-unpublished publication, spec section 37 — a different function from the link-cycle path above) writes only `current_value`/`cost_base`/`owner` back to the `investments` row, not the full certified field set. Live-confirmed during this pass's own security testing: after a real republish, `investment_name` stayed at the manual-restored value even though `source_type` read `investment_intelligence_published`. This is the same defect *class* but in `republishPosition()`, not `publishPosition()`/`unpublishPosition()`, and is not part of this pass's scope (which is specifically about fields R3 overwrites during *link* and their restoration on *unpublish*). Not a financial-integrity or security issue — `current_value` is correct. Flagged as a follow-up task (background task queued during this session), not fixed here.

### 10.1 Amendment — the republish gap WAS financially significant, and a second bug was found and fixed

The flagged follow-up task ran and landed as commit `cfb473d` (`Fix republishPosition() provenance-loss bug`): `republishPosition()` now re-derives the full certified field set (name/institution/country/currency/master_item_key/risk/annual_contribution/canonical ids/quality status) from `ii_accounts`/`ii_instruments`/`ii_holding_snapshots`/the publication row, instead of trusting the stale `investments` row. This part is correct and independently verified (own regression test, `tests/unit/iiR3RepublishFieldRestoration.test.ts`, read directly and reproduced).

However, the orchestrating session's own from-scratch live-DEV lifecycle test (link → unpublish → **republish** → unpublish again) found `cfb473d`'s fix was incomplete in a way that IS financially significant. Sequence and root cause:

1. Link: manual row (`AUD`/500,000/"Original Manual Investment") → snapshot correctly captured → row overwritten to certified values (`INR`/520,000/"Imported Mutual Fund Name").
2. Unpublish: row correctly restored to the manual state; `pre_publication_manual_snapshot` correctly cleared to `null` (its job done — this is the existing, correct discipline, not itself a bug).
3. Republish (`cfb473d`'s code path — reactivating the SAME publication, not a fresh link): correctly re-applies the certified field set — **but never re-captures a snapshot of the manual state it is about to overwrite**, because `pre_publication_manual_snapshot` was already `null` from step 2 and nothing in `republishPosition()` rebuilds it.
4. Unpublish (second time): `unpublishPosition()`'s branch condition (`row.source_type === 'investment_intelligence_published' && row.pre_publication_manual_snapshot`) finds the snapshot `null` and takes the **archive** branch (`is_active=false`) — the branch meant for a position that was NEVER manual — instead of the **restore** branch.

**Live-DEV-reproduced result of the pre-fix bug**: after step 4, the row was `is_active=false` (silently excluded from net worth entirely) while still permanently stamped `investment_name="Imported Mutual Fund Name"`, `current_value=520000`, `currency_code="INR"` — the user's original 500,000 AUD manual investment effectively vanished, not merely mislabeled. This is a genuine financial-integrity defect (an investment silently dropped from net worth), not a display/provenance-only issue, and directly relevant to R3's central no-double-counting/no-value-loss mandate even though it manifests as a *disappearance* rather than a duplication.

**Fix** (same file, `republishPosition()`): before overwriting the `investments` row, read its current state. If `source_type === 'manual'` (meaning it genuinely holds live, correctly-restored manual data right now — the only way this branch is reached), capture a fresh snapshot via the same `buildPreLinkManualSnapshot()` used by the link path, and include it in the update payload alongside a fresh `ii_linked_at`. If the row's current `source_type` is already `'investment_intelligence_published'` (the "never was manual, unpublish only archived it" case), no snapshot is captured — there is nothing to protect, matching the pre-existing archive/reactivate semantics exactly.

**Live-DEV re-verified after the fix**, same fresh household, full sequence reproduced end to end: link (snapshot correctly captured: name/AUD/AU/500000) → unpublish (correctly restored) → republish (fresh snapshot correctly re-captured this time, confirmed via direct DB read of `pre_publication_manual_snapshot`) → unpublish again (**correctly, fully restored**: `investment_name="Original Manual Investment"`, `current_value=500000`, `currency_code="AUD"`, `country_code="AU"`, `institution="Original Manual Institution"`, `source_type="manual"`, `is_active=true`, all `ii_*` tracking fields null).

**Regression test added and proven non-vacuous**: `tests/unit/iiR3RepublishFieldRestoration.test.ts` gained two new cases — one asserting republish-of-a-currently-manual-row re-captures the snapshot and a subsequent unpublish fully restores it; one asserting republish-of-a-never-manual row captures no snapshot. The fix was temporarily reverted (`freshManualSnapshot` hardcoded to `null`) to confirm the new test genuinely fails without it (`expected null not to be null` — did fail), then restored and reconfirmed green — the same non-vacuousness discipline applied to every test claim in this project.

This amendment does not change the section 20 classification (still UNCONDITIONAL FULL PASS) because the defect is now genuinely fixed and live-proven, not because it was ever acceptable to leave open — the original text's "not a financial-integrity issue" characterization was incorrect and is superseded by this section.

## 11. Backward Compatibility

Checked live DEV directly: a query for any `investments` row with a non-null `pre_publication_manual_snapshot` returned **zero rows**, and `ii_fhip_publications` returned **zero rows** — every fixture from the prior (first) R3 closure pass had already been fully cleaned up and independently re-verified as of that pass's own closure. There is no pre-fix-format snapshot anywhere on DEV to migrate or special-case.

The fix is backward-compatible by construction regardless: `buildPreLinkManualSnapshot`/`restorableFieldsFromManualSnapshot` are both allow-lists keyed by field name. A pre-fix snapshot (captured before this fix shipped) simply has no `investment_name`/`currency_code`/`country_code` key; reading a missing key yields `undefined`; `JSON.stringify` (which every `supabase-js` `.update()` call goes through before hitting PostgREST) drops object properties whose value is `undefined`. So an old-format snapshot's restore payload omits those three columns entirely — PostgREST leaves whatever is currently in those columns untouched — rather than restoring a fabricated or corrupted value. Proven directly by an automated test (see PROV pure-function tests, section 13) since no live pre-fix row existed to exercise this against.

## 12. Audit/Provenance Changes

No new audit event types were created. The existing R3 vocabulary (`manual_duplicate_linked`, `manual_record_superseded`, `publication_unpublished`, `publication_failed`, etc. — migration `0042`) already represents every action in the lifecycle this fix touches; this pass changes what data is captured and restored, not which events are emitted or when.

## 13. Automated Closure Tests

All in `tests/unit/iiR3ProvenanceClosure.test.ts`, run via `npx vitest run tests/unit/iiR3ProvenanceClosure.test.ts` — **19/19 PASS**:

| Test | Result |
|---|---|
| `buildPreLinkManualSnapshot` captures `investment_name`/`currency_code`/`country_code` | PASS |
| `restorableFieldsFromManualSnapshot` drops `captured_at` and unrelated keys | PASS |
| PROV-R3C-009 (schema-verified: `investment_name` is `NOT NULL` per migration `0003`; empty-string/whitespace/Unicode/long-text/special-characters round-trip exactly) | PASS |
| Pre-fix snapshot (missing the 3 new keys) restores `undefined` for them, which `JSON.stringify` drops — `current_value` (already-captured pre-fix) still round-trips | PASS |
| **PROV-R3C-001** basic name preservation (500k manual → 520k imported → unpublish → original name back) | PASS |
| **PROV-R3C-002** refresh does not destroy the original (V1 publish → refresh V2 → unpublish → original name, snapshot untouched by refresh) | PASS |
| **PROV-R3C-003** multiple refreshes (V1→V2→V3→unpublish → original name; exactly zero non-terminal publications remain) | PASS |
| **PROV-R3C-004** idempotent publish (publish same position twice → snapshot byte-identical, no second publication row) | PASS |
| **PROV-R3C-005** unpublish/re-publish lifecycle (Manual A → publish → unpublish → publish (new position) → unpublish → Manual A both times) | PASS |
| **PROV-R3C-006** manual edit between cycles (Manual A → publish → unpublish → edited to Manual B → publish → unpublish → Manual B, not Manual A) | PASS |
| **PROV-R3C-008** failed publication (forced `ii_fhip_publications` insert failure → compensation restores the COMPLETE original state, not just `current_value`) | PASS |
| **PROV-R3C-010** other overwritten fields (`currency_code`/`country_code` preserved/restored with the same rigor as `investment_name`; closes the latent currency/value-mismatch bug) | PASS |
| `ii_*` tracking fields cleared on unpublish, not left stale | PASS |
| **FIN-R3C-001** manual 500,000 + imported 520,000 duplicate → exactly one active value = 520,000 | PASS |
| **FIN-R3C-002** idempotent publish retry → no duplicate | PASS |
| **FIN-R3C-003** refresh to 561,000 → exactly one active value = 561,000 | PASS |
| **FIN-R3C-004** older snapshot after newer active one → `REJECT_OLDER` | PASS |
| **FIN-R3C-005** unpublish restores original manual value | PASS |
| **FIN-R3C-006** financial-impact arithmetic unaffected by the fix (`netChange=20000`, not `520000`) | PASS |

PROV-R3C-007 (RLS cross-user isolation of the snapshot) is not exercised by this in-memory fake-client suite — a fake client cannot enforce real Postgres RLS. It is covered instead by the live-DEV SEC-R3C-004 test (section 15), with real ground-truth verification, which is the methodologically correct way to test RLS.

## 14. Financial Regression Tests

FIN-R3C-001 through 006 (section 13, all PASS via the automated suite) plus a full live-DEV re-proof during the mandatory reproduction (section 16): exactly one active row at 520,000 after linking a 500,000 manual duplicate; unpublish correctly restores 500,000. No change to `computeDashboard()`, `netWorthCalculator.ts`, or any forecasting/goals/report engine file — confirmed by `git diff --stat` showing only the 2 service-layer files plus 1 new test file changed.

## 15. Security Tests

Live-DEV only (a fake client cannot exercise real RLS) — two fresh throwaway households (User A, User B), real password-based login through the actual `/login` page, real `fetch()` calls from within each authenticated browser session:

| Test | Result |
|---|---|
| **SEC-R3C-001** User B cannot preview User A's position (`/positions/[A's id]/preview`) | 404 `"Position not found"` — PASS |
| **SEC-R3C-002** User B cannot publish/link User A's position, including an attempt to link it to User B's OWN manual row | 404 both attempts — PASS |
| **SEC-R3C-003** User B cannot unpublish User A's active publication | 404, AND ground-truth re-query confirmed A's publication was still genuinely `status='published'` at 520,000 afterward (not silently unpublished) — PASS |
| **SEC-R3C-004** User B cannot read or modify User A's `investments.pre_publication_manual_snapshot` via a direct PostgREST call using B's own real access token | Both the `GET` and the `PATCH` (attempting to inject `investment_name: "PWNED"`) returned an empty row set; **per this project's established methodology, the empty-response alone was not accepted as proof** — an independent service-role ground-truth re-query afterward confirmed A's row's `investment_name` was still exactly `"Original Manual Investment"`, never touched by B's attempted PATCH — PASS |

## 16. Live DEV Reproduction

Fresh throwaway household (User A), not reused from any prior pass. Real HTTP requests against a directly-started `next start` process (Bash-started, bypassing the MCP preview-tool wrapper), real authenticated browser session via the actual `/login` page.

- **Starting manual state**: `investment_name="Original Manual Investment"`, `current_value=500000`, `currency_code=AUD`, `country_code=AU`.
- **Certified II position**: `instrument_name="Imported Mutual Fund Name"`, `current_value=520000`, `currency_code=INR`, `country_code=IN`.
- **After `POST /publish` with `linkToExistingInvestmentId`** (ground-truth service-role query): `investment_name="Imported Mutual Fund Name"`, `current_value=520000`, `currency_code=INR`, `country_code=IN`, `source_type='investment_intelligence_published'`, exactly one active `investments` row for this user, exactly one `ii_fhip_publications` row `status='published'`. The stored `pre_publication_manual_snapshot` correctly contained `investment_name="Original Manual Investment"`, `currency_code="AUD"`, `country_code="AU"`, `current_value=500000`.
- **After `POST /unpublish`** (ground-truth service-role query): `investment_name="Original Manual Investment"`, `current_value=500000`, `currency_code="AUD"`, `country_code="AU"`, `source_type='manual'`, `ii_publication_id=null`, `ii_canonical_account_id=null`, `ii_canonical_instrument_id=null`, `ii_source_quality_status=null`, `ii_last_refreshed_at=null`, `pre_publication_manual_snapshot=null`.
- **Bonus live proof of PROV-R3C-008**: an accidental real re-publish attempt (using `publish` instead of `republish` for an already-once-published position) hit the real `ii_fhip_publications_canonical_position_id_key` unique constraint, triggering the real compensation path — ground truth confirmed the row was correctly reverted to the complete original manual state (name, value, currency, country), not left corrupted or half-published, before the test proceeded (via the correct `republish` endpoint) to the SEC-R3C-003 scenario.
- **Cleanup**: both throwaway users and all cascaded/non-cascaded rows (2 `ii_instruments` rows explicitly, since they have no `user_id` FK) were deleted; a fresh service-role query across `investments`, `household_members`, `user_profiles`, `ii_accounts`, `ii_holding_snapshots`, `ii_portfolio_truth_status`, `ii_fhip_publications`, `ii_audit_events`, and `ii_instruments` returned zero rows, and both auth users were confirmed no longer to exist.

## 17. Full Regression Summary

| Check | Result |
|---|---|
| `npx tsc --noEmit` | Clean, 0 errors |
| `npx eslint .` | 6 errors, 6 warnings — identical to the accepted baseline, in files this pass did not touch (`AdminRecommendationsClient.tsx`, `FinancialDataGrid.tsx`'s pre-existing ref-in-render warning, `RecommendationsPanel.tsx`, `AppShell.tsx`, plus 3 pre-existing `<img>` warnings) |
| `npx vitest run --no-file-parallelism` | **493/493 PASS** (470 pre-existing + 19 new closure tests + 4 republish-field-restoration tests, 2 of them added by this amendment, one proven to fail without the section-10.1 fix and pass with it) |
| `npm run build` | Clean, 145 routes, zero errors |

## 18. R3 Acceptance Checklist (closure-pass additions)

Every item in `R3_ACCEPTANCE_REPORT.md`'s original 27-item checklist remains DONE and untouched by this pass except item 14 ("Unpublish/republish deterministic, R0 open item resolved"), which is now upgraded from "live-confirmed restored the exact pre-link manual values" (which was not literally true — `investment_name`/`currency_code`/`country_code` were never restorable) to **genuinely, completely true**, live-verified.

## 19. Outstanding Issues

1. ~~`republishPosition()` does not re-write the full certified field set...~~ — **RESOLVED** (originally flagged here, fixed in `cfb473d`, then the orchestrating session found and fixed a second, financially-significant gap in that same fix — see section 10.1). No longer outstanding.
2. REC-007 (an R2 testing-coverage gap, not R3) remains not conclusively live-proven, unchanged from the prior R3 acceptance report — not this pass's scope.

Item 2 does not block UNCONDITIONAL FULL PASS per the classification rules in section 20 (bounded, non-financial, non-security, R2-scoped not R3-scoped).

## 20. Final Classification

**R3 — UNCONDITIONAL FULL PASS.**

The provenance defect is genuinely closed: `investment_name`, `currency_code`, and `country_code` are all now correctly captured at link time and restored exactly on unpublish, including through refresh (multiple refreshes, snapshot structurally untouched), idempotent-retry (snapshot never recreated), and re-publish-cycle scenarios (a fresh, correct snapshot on each new link cycle, reflecting any manual edit made between cycles). All required closure regression tests pass: 19/19 new automated tests, zero new lint errors, clean typecheck, all 470 pre-existing tests still pass (489/489 total), clean build, and a genuine live-DEV reproduction with independently-verified ground truth at every step. No double-counting, no FX error, no cross-user access, no broken provenance, and no idempotency failure was found anywhere in this pass. The one adjacent issue found (`republishPosition()`'s own separate staleness gap) is bounded, non-financial, non-security, and does not concern any field this pass was asked to close — it does not disqualify FULL PASS under the stated rules, and is disclosed rather than hidden.

## 21. R4 Readiness

This closure pass's own work is complete: FULL PASS, all evidence above. **R4 (Performance & Benchmark Engine) is NOT authorized to begin** — that authorization rests with the Product Owner alone, unchanged by this closure's outcome. No R4-scope code (XIRR, TWRR, CAGR, benchmarks, rolling returns, alpha/beta, Sharpe/Sortino, SIP analytics, X-ray, tax, cost intelligence) was implemented, touched, or planned by this pass.
