# R3 — Duplicate Resolution Spec

Status: FINAL (R3)
The highest-stakes logic in R3 (spec sections 26-28, 31-32). Implemented in `lib/services/investment-intelligence/publicationLogic.ts`'s `detectDuplicateCandidates()`, orchestrated by `investmentPublicationService.ts`'s `publishPosition()`/`unpublishPosition()`.

## 1. Classification

Every `investments` row now carries `source_type` (migration `0042`): `'manual'` (default — every pre-existing row) or `'investment_intelligence_published'`. Nothing is inferred from other columns; this is an explicit, first-class marker.

## 2. Duplicate-candidate detection — deterministic, never auto-merged

`detectDuplicateCandidates(newPosition, existingManualRows)` compares the position about to publish against every **active, manual** `investments` row (rows already `investment_intelligence_published` are never proposed as candidates — `sourceType !== 'manual'` is filtered first). Signals, each independently scored:

| Signal | Weight |
|---|---|
| `owner` matches | 0.25 |
| `master_item_key` (category) matches | 0.20 |
| `institution` matches (normalised — case/whitespace/"Mutual Fund"/"Ltd" suffix insensitive) | 0.20 |
| `country_code` matches | 0.10 |
| `currency_code` matches | 0.10 |
| value within 15% (`approximate_value`) | 0.15 |

**Structural gate** (required before a candidate is surfaced at all, regardless of total score): `owner` AND `category` must always match. When **both sides carry a known institution**, `institution` must additionally match. When either side's institution is unknown, `approximate_value` substitutes as the third required signal instead.

**This exact rule was arrived at by a real test failure, not by design alone**: a first version of this function required only owner+category, and `tests/unit/iiR3PublicationLogic.test.ts`'s "genuine separate investment" case (spec section 32's own numbers — Institution A at 500,000 vs Institution B at 520,000, the same owner/category) incorrectly matched as a duplicate, because owner+category+country+currency+approximate-value alone cleared the 0.5 score threshold without ever checking institution. Institution was promoted to a required structural signal specifically because it is the one property that distinguishes spec section 31 (same fund, same institution, close value → genuine duplicate) from section 32 (different institution, similarly close value → genuinely separate investments) — value proximity alone is deliberately never sufficient. This is a concrete instance of the task's own instruction to "prove a test would catch real breakage" being exercised for real during implementation, not merely described afterward.

Never auto-merged: `detectDuplicateCandidates()` only ever returns a list; `classifyRegisterAction()` marks the outcome `REQUIRES_REVIEW` whenever candidates exist and none is user-confirmed, and `publishPosition()` refuses to write anything in that state unless the caller passes `linkToExistingInvestmentId` (link) or `acknowledgedNoDuplicate: true` (explicit "these are not duplicates" confirmation).

## 3. Manual-to-canonical linking — convert in place, never delete, never orphan goals

When the user confirms a manual row IS the same economic investment as a certified position (`linkToExistingInvestmentId`):

1. The manual row's current values are captured into a new `pre_publication_manual_snapshot jsonb` column via `buildPreLinkManualSnapshot()` (`lib/services/investment-intelligence/publicationLogic.ts`) — the audit-traceable "what it was before" record. **Updated by the R3 provenance-preservation closure pass (2026-08-20, see `R3_CLOSURE_REPORT.md`)**: the captured field list is `investment_name, current_value, currency_code, country_code, cost_base, institution, owner, investment_type, master_item_key, annual_contribution, risk_profile, captured_at`. The original R3 implementation omitted `investment_name`, `currency_code`, and `country_code` from this list even though `publishPosition()`'s `fieldPayload` overwrites all three — meaning the manual row's original name (and, more subtly, the CURRENCY its restored `current_value` would be denominated in) could never be recovered on unpublish. This is now fixed; see `R3_CLOSURE_REPORT.md` for the full defect/fix writeup.
2. The **same row** (`investments.id` unchanged) is UPDATEd with the certified fields and `source_type='investment_intelligence_published'` — never a second INSERT, never a delete.
3. Because the row's `id` never changes, `goal_funding_sources.linked_investment_id` (if any goal was already funded from this manual row) continues to point at a valid, still-existing row with zero relinking required — the exact continuity `R0_GOAL_INTEGRATION_CONTRACT.md` needs.
4. Two audit events are emitted: `manual_duplicate_linked` and `manual_record_superseded`, each carrying safe before/after numeric values (never raw statement content).

## 4. Unpublish — the R3 resolution of R0's flagged open item

`R0_NET_WORTH_DEDUP_CONTRACT.md` scenario 12 flagged "last-write-wins-with-warning vs. merge-prompt" as an open UX decision for a future release. R3 makes and documents the explicit product decision:

**On unpublish, a previously-linked manual row is fully restored to its pre-link manual state** — `source_type` reverts to `'manual'`, every captured field (`investment_name`, `current_value`, `currency_code`, `country_code`, `cost_base`, `institution`, `owner`, `investment_type`, `master_item_key`, `annual_contribution`, `risk_profile`) is written back from `pre_publication_manual_snapshot` via `restorableFieldsFromManualSnapshot()`, the four `ii_*` tracking columns (`ii_canonical_account_id`, `ii_canonical_instrument_id`, `ii_source_quality_status`, `ii_last_refreshed_at`) are explicitly cleared, and the snapshot column itself is cleared. This is the "undo the link" behaviour, not "keep II's last certified value as a frozen manual value" — chosen because it matches the user's mental model (unlink = go back to what I had) and because keeping a stale certified figure as if it were still authoritative after explicitly disconnecting from Investment Intelligence would itself be a subtle provenance-integrity problem. A brand-new `investment_intelligence_published` row (no prior manual link) is instead archived (`is_active=false`) on unpublish, matching the existing, already-tested `registry.archive()` semantics exactly (`R0_NET_WORTH_DEDUP_CONTRACT.md` scenario 10).

**Closure-pass correction (2026-08-20)**: "fully restored" was not literally true until the closure pass — `investment_name`, `currency_code`, and `country_code` were captured nowhere and therefore could never be restored; a restored `current_value` could even end up silently mis-tagged with the WRONG currency (the certified position's currency, not the original manual currency). Both are now fixed; live-verified against real DEV (`R3_CLOSURE_REPORT.md`). Note also: `republishPosition()` (spec section 37, reactivating a previously-unpublished publication) still only re-writes `current_value`/`cost_base`/`owner`, not the full certified field set — a live-DEV-discovered adjacent gap (name/institution/`ii_canonical_*` stay at the manual-restored values after a republish) that is OUT OF SCOPE for this closure pass and is tracked as a separate follow-up, not a regression this pass introduced.

This is tested explicitly in `investmentPublicationService.ts`'s `unpublishPosition()`, `tests/unit/iiR3ProvenanceClosure.test.ts` (PROV-R3C-001 through 010), and its logic is exercised via the DD-scenario matrix and net-worth certification test packs.

## 5. Never both counted

At every step above, the mechanism guaranteeing "exactly once" is `uidx_ii_fhip_publications_one_active_position` (migration `0042`) plus the convert-in-place design: a linked position never has two live `investments` rows (the manual row's identity IS the published row's identity), and an unlinked/archived position is excluded from `computeDashboard()`'s query before the calculation even runs (`is_active=true` filter, unchanged). See `R3_NO_DOUBLE_COUNT_CERTIFICATION.md` for the full proof.
