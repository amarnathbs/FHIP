# Owner change to Trust / HUF / Company, and joint percentage splits (Investment Intelligence)

Branch `feat/owner-entity-joint-edit-resolutions-20261001`, based on `origin/main` `cce323f`.
Date: 2026-10-01. Author: Claude Code (unattended session for the Product Owner).

## 0. Evidence labels (read this first)

| Claim | Label |
|---|---|
| Server rules (validation, confirm, idempotency, audit, immutability, entity separation) | **code-complete**, unit-tested against an in-memory Supabase fake. **Not DEV-verified. Not production-verified.** |
| Dialog, Review and Resolutions wiring | **code-complete**. Markup rendered server-side (react-dom/server) and structurally asserted. **No browser interaction was run** (no jsdom in the repo; no DEV session credentials were available unattended). |
| Database backstops (cross-tenant trigger on `ii_ownership_allocation`, HUF trigger on `business_entities`, `ii_reconciliation_cases` write guard) | **Pre-existing migrations (0153, 0154, 0087); not exercised by this work.** |
| `ii_ownership_allocation` (migration 0153) on production | **Unknown from the repo; the NAV1 certifications of 2026-09-25/27 record it as "DEV only".** Entity / joint owners cannot be saved in any environment without 0153 (and HUF without 0154). The code fails closed with a plain 503 message and reads degrade safely. See section 8. |
| Nothing was written to production or DEV. No migration was added or applied. Nothing was pushed or merged. |  |

## 1. What was built

On the live Investment Intelligence pipeline, after upload, a user can now:

1. change an account's owner to a **household member** (already worked), a **business entity** (Family Trust, Company, and HUF for India-confirmed users only), or
2. assign a **joint split** across two or more owners (members and/or entities) with percentages that must total exactly 100%,

and use either to resolve an open `owner_unmatched`, `owner_mismatch` or `joint_holding_allocation_required` case on the **Review** tab, or amend an already-decided case on the **Resolutions** tab.

Every owner change goes through one dialog (`OwnerChangeDialog`) with two steps: choose the owner, then an explicit confirmation showing *current owner -> new owner* and the consequences in plain words. The request must carry `confirm: true`; the server refuses it otherwise.

## 2. Design

### 2.1 Where an entity / joint owner is stored

`ii_accounts.owner_member_id` is a single nullable FK to `household_members`. It **cannot** carry an entity or a split. Decision:

* `ii_accounts.owner_member_id` keeps meaning exactly what it always meant: *the sole household-member owner*. It is **NULL** for an entity-owned or jointly-owned account.
* The entity / joint owner lives **only** in `ii_ownership_allocation` (migration 0153, PC5 K.6): one **active allocation group** per account; a 100% allocation to one entity is how "owned by a Trust" is recorded.
* The **effective owner** is derived by `deriveAccountOwnership(pointer, activeRows)`: an active account-grain allocation group is authoritative; with none, the pointer decides; with neither, the account is `unassigned`.
* A member choice only writes an allocation group when one already exists (so an old split/entity decision is superseded and kept as history instead of lingering as the active truth). A plain first-time member assignment writes exactly what it always did: the pointer.

Why not add `owner_business_entity_id` to `ii_accounts`: it would be a second source of truth beside `ii_ownership_allocation`, would need a migration with a number above everything in flight, and still could not express a split. The allocation table already has the tenant-isolation trigger, the HUF-friendly entity FK, the basis-point CHECKs, history (`superseded`) and an audit vocabulary.

### 2.2 Request contract (small, and compatible with the Phase 1 branch)

```
owner: { kind: 'member', member_id }
     | { kind: 'entity', business_entity_id }
     | { kind: 'joint', allocations: [{ member_id | business_entity_id, basis_points }] }   // 2..10 owners, total exactly 10000
confirm: true                    // required
case_id?: uuid                   // optional: the case being resolved (enforces the joint-case rule)
```

* `PATCH /api/investment-intelligence/accounts/[id]/owner` (Review) and `POST /api/investment-intelligence/resolutions/[caseId]/amend` (Resolutions) take this body. The legacy `{ ownerMemberId }` body is still understood (mapped to `kind: 'member'`) but needs `confirm: true` like everything else.
* `GET /api/investment-intelligence/accounts/[id]/owner` returns what the dialog needs: the current owner with readable labels, the owners this user may pick (country-gated), whether joint is possible, and whether the account is already published.
* Errors are `{ error: CODE, message }`; the UI shows `message`.

### 2.3 Server-side validation (one function, used by both routes)

`validateOwnerSelection(selection, ctx)` in `lib/services/investment-intelligence/ownerModel.ts` (pure). `ctx` is loaded **server-side, filtered by `user_id`** (`loadOwnerChoiceContext`): the user's own members, entities, and the AUTHORITATIVE home country (`getUserFullExperienceHomeCountry`, never the request).

* every member / entity id must be in the caller's own rows (another tenant's id is `404 not found`, no existence leak);
* members and entities must be active (`422`);
* an entity type with a required country (HUF -> IN, from the existing `BUSINESS_ENTITY_TYPE_REQUIRED_COUNTRY`) is refused unless the caller is confirmed in that country (`403`); an unresolved or generic-experience country is refused, never defaulted; the check also applies inside a joint split;
* "Company only if the user has one" falls out of the first rule: the company must be one of the caller's entities;
* a joint split passes the existing `validateAllocation` (basis points, integer, each > 0, no duplicate owner, total exactly 10000), needs >= 2 owners, and every line names exactly one of member / entity.

### 2.4 What an owner change does (`applyAccountOwnerChange`)

1. refuses `409 ACCOUNT_PUBLISHED_UNPUBLISH_FIRST` when the new owner includes an entity share and the account already has a published position (it would keep counting in personal Net Worth);
2. records a **new** allocation group via the existing `recordAllocationGroup` (supersede then insert; nothing is edited in place or deleted) when the result is entity / joint, or when a group already existed;
3. keeps `owner_member_id` consistent with the result (and heals a stale pointer left by an interrupted attempt);
4. resolves the open owner cases the choice may resolve, **merging** `resolvedOwner` / `previousOwner` (ids and basis points only) into `discrepancy_details` without overwriting the detection evidence. `owner_unmatched` / `owner_mismatch`: any owner. `joint_holding_allocation_required`: **only a joint split** (a statement that prints a joint holding cannot be satisfied by asserting a sole owner), enforced both with `case_id` (422) and without it (the case is simply not resolved by a sole-owner choice);
5. writes **one** `user_correction` audit event: `field: 'ownership'`, `before` / `after` (kind + ids + basis points), `changed`, `origin`, `resolvedCaseCount`, `allocationGroupId`, `caseId`. It also writes `reconciliation_case_resolved` per case, and `recordAllocationGroup` writes its existing `pc5_ownership_allocation_recorded` / `_superseded` events. No names, no PAN, no folio, no masked holder text. **No new audit event type, so no migration.**

It never moves, deletes or recomputes holdings, transactions, snapshots, tax lots or publications.

**Idempotent:** the requested ownership is compared with the effective current one (order-independent key); equal means no new allocation group, no new audit row. A retry after a half-finished attempt still heals the pointer and resolves any still-open case. **Not covered:** two truly concurrent submissions of the same change are not serialised by the database (no partial unique index on the active group); the dialog disables its button while saving. See section 9.

### 2.5 Amend (Resolutions tab)

Unchanged property: the amended case row is never touched; a **new**, already-resolved case is inserted with `amendsCaseId`, `previousOwner`, `resolvedOwner` (and the legacy `previousOwnerMemberId` / `resolvedOwnerMemberId` for a sole member). New in this work: the ownership change is applied **before** the amendment row is inserted, so a refusal (for example the published-account rule) leaves no amendment row claiming a decision that did not happen. Replaying the same amend is `409 already_amended`, so it can never create a second allocation set. A decided `joint_holding_allocation_required` case is now amendable, to another joint split only. `GET /resolutions` now returns `resolvedOwner` / `previousOwner` views and a ready-to-show summary (`"Asha Rao 60.00% / Rao Family Trust 40.00%"`) resolved per request from the caller's own rows.

## 3. Consumer inventory of `ii_accounts.owner_member_id`

| # | Consumer | Role | What it did with "null" | Change |
|---|---|---|---|---|
| 1 | `app/api/investment-intelligence/accounts/[id]/owner/route.ts` | writer (Review) | n/a | rewritten on `applyAccountOwnerChange`; adds GET |
| 2 | `resolutions/[caseId]/amend/route.ts` | writer (Resolutions) | n/a | rewritten on `applyAccountOwnerChange` |
| 3 | `accountResolution.ts:130`, `accounts.ts:39,75` | writers on account CREATE only (never overwrite an existing account) | n/a | none |
| 4 | `documentProcessing.ts` upload pipeline (`ownerUnresolved`, owner_unmatched / joint / owner_mismatch loops, per-position certification call) | reader | null owner = open `owner_unmatched` on **every re-upload**; certification `unresolved_owner` | **guarded**: an account with an active entity / joint allocation is skipped by all three loops and not counted unresolved |
| 5 | `documentProcessing.ts` `recertifyPosition` | reader | `!owner_member_id` = unresolved | reads effective ownership |
| 6 | `lib/investment-import-bridge/certifyAuPosition.ts` | reader | `!owner_member_id` = unresolved | reads effective ownership |
| 7 | `lib/investment-import-bridge/auAccountResolution.ts` (`describeAuAccounts`, `confirmExistingAuStatementAccount`, `setAuAccountOwner`) | reader / writer | `ownerRecorded=false`; "fill in" a sole member when none | entity / joint counts as recorded; never fills a sole member over an entity decision |
| 8 | `investmentPublicationService.ts` (`loadPositionContext`, preview, publish) and `publicationLogic.evaluateEligibility` | reader | null = `OWNER_UNRESOLVED`; owner role from the member | effective ownership; **entity (or joint with an entity share) -> `OWNER_IS_BUSINESS_ENTITY`, not publishable**; joint between members only -> publishable once with owner role `joint` |
| 9 | `investmentPublicationService.ts:892` (republish) | reader of the **publication's** `owner_member_id` | n/a | none (an entity-owned position can never have been published) |
| 10 | `lib/read-models/investments.ts` (`computeInvestments` / `loadInvestmentInputs`) | does **not** read the pointer; reads snapshots + publications | an entity-owned account's snapshots would appear in "Imported, not yet in Net Worth" | excluded; counted in `entityHeldExcludedCount`; never in a total |
| 11 | `app/api/investment-intelligence/accounts` GET (`listIiAccounts`, `select('*')`) | passes the raw column through | shows null | none; no client reads it |
| 12 | `lib/aie/adapters/.../write.ts:111`, `aiExtractionReviewApply.ts:91,200` | `ii_source_documents.owner_member_id` (a different table) | n/a | none (upload flows, owned by the Phase 1 branch) |
| 13 | `lib/services/goalsData.ts`, `lib/validation/goal.ts`, `GoalEditPanel` | `goals.owner_member_id` (different table) | n/a | none |
| 14 | SQL (RLS, views, RPCs, triggers) | none reference `ii_accounts.owner_member_id` (only 0032 DDL and 0153 comment) | n/a | none |
| 15 | `InvestmentIntelligenceClient.tsx` (Statements & data, statement detail: inline "Assign owner") | caller of the PATCH | n/a | now confirms (`window.confirm`) and sends `confirm: true`; still member-only (trust / HUF / joint are on Review / Resolutions) |

## 4. Entity separation (PO ruling 2026-09-21): exactly what was done

What flows into **personal** totals today is `investments` rows (published) via `selectInvestments`. Therefore:

* **Publication.** An account owned (wholly or partly) by a Trust / HUF / Company is `NOT_ELIGIBLE` (`OWNER_IS_BUSINESS_ENTITY`) in `evaluateEligibility`, which `checkEligibility`, `buildPreview` and `publishPosition` all call. It can never become an `investments` row.
* **Already published.** Moving such an account under an entity is refused until the user unpublishes (409). Holdings are never silently re-owned out from under a published row.
* **"Imported, not yet in Net Worth" bucket.** `computeInvestments` excludes entity-owned accounts' snapshots (they will never be published, so offering them to personal Net Worth would be wrong) and reports only `entityHeldExcludedCount`. `publishedTotal` / `householdPublishedTotal` are unaffected.
* This read is deliberately **not fail-closed** (try/catch to "no entity-owned accounts"): it feeds only the informational bucket, and an entity owner can only exist if the table does. Failing closed would have taken the whole Investments read model, and every Net Worth figure built on it, offline in any environment where 0153 is not applied. Every other read there remains fail-closed (asserted).

**What was NOT done (pre-existing, disclosed):** the Investment Intelligence workspace analytics (Overview, Performance, Tax, SIP, X-Ray) and the personal report sections built from `ii_holding_snapshots` aggregate **every** uploaded account regardless of owner, exactly as they did for a spouse's or child's account before this work. Excluding entity-owned accounts from those would need a filter in each loader (`r5Repository`, `taxRepository`, `analyticsRepository`, `overviewSummary`, `investmentIntelligenceReportData`) and a PO decision on whether they should instead appear in a separate entity view. Not changed. See open decisions.

## 5. UI

`components/investment-intelligence/OwnerChangeDialog.tsx` (+ pure view-model `ownerChange.ts`), used by both tabs; follows `ConfirmDialog` / `TransactionDetailModal` conventions (`role="dialog"`, `aria-modal`, focus trap, Escape, focus returns to opener, 44px targets, existing Tailwind tokens).

* **Choose:** current owner; people in the household; trusts, HUFs and companies (the server has already removed an HUF for a non-India user, and inactive members); "Jointly owned" when >= 2 owners exist. No entity set up -> a link to `/companies`.
* **Joint editor:** one row per owner (owner select + percent input), Add / Remove, "Split equally" (K.6 default; remainder to the last owner, so three owners are 33.33 / 33.33 / 33.34), running total with "still to assign / over", plain-words problems. Percent text is converted to basis points (at most two decimals, otherwise rejected).
* **Joint-holding case (Review):** only the joint editor is offered; the statement's named holders (`matchedMemberIds` from the case evidence) are pre-filled as an equal split the user can edit; the masked holder text is shown as a hint.
* **Confirm:** *Current owner -> New owner* (percentages and a 100% total for joint), "What this means" (holdings are not changed or recalculated; entity -> kept separate from personal Net Worth, not published; joint -> still counted once; already-published warnings; amend -> earlier decision kept in history), Back, **Confirm owner change**. For a published account moving under an entity the confirm button is disabled and the reason shown.
* **Review tab:** "Choose the owner..." (owner_unmatched), "Correct the owner..." (owner_mismatch), "Split ownership..." (joint holding). The stale text *"percentage-split decision, which this screen does not yet support"* is gone. **Resolutions tab:** "Amend this decision" opens the same dialog in amend mode; history rows show `Assigned to` / `Split as` / `Amended to` with labels and shares.

UX evidence (rendered with the real component code via react-dom/server, then Tailwind-compiled and screenshotted with headless Chromium; **not** a live-app session): `docs/ownership/owner_change_dialog_preview.html` (standalone, six states), `owner_change_dialog_preview.png` (desktop 900px) and `owner_change_dialog_preview_mobile.png` (390px, measured horizontal overflow 0px). States: choose owner; joint editor at 90% (continue disabled); joint-holding case with pre-filled holders; confirmation for a joint split with a trust; confirmation blocked because the account is already published; amend mode.

Stale notes updated: the Review tab comment and message; the `DOCUMENT2_FINAL_CLOSURE_MATRIX.md` and `DOCUMENT2_NON_BENCHMARK_FINAL_CLOSURE_REPORT.md` rows now carry a visible "Superseded 2026-10-01" note. **Migration 0227 was deliberately not edited** (an applied migration's file must not drift); its header and the `COMMENT ON COLUMN ii_reconciliation_cases.discrepancy_type` still say the %-split UI is not built. That DB comment is metadata only; refreshing it would need a new migration, not added because none is otherwise necessary.

## 6. Convergence with the Phase 1 branch (`feat/owner-before-upload-phase1-20261001`)

At the time of writing that branch had **no commit ahead of `origin/main`** and its worktree held no shared schema / `validateOwnerSelection` / `GET /api/ownership/options` / `OwnerSelector` yet (verified: no such files; the only new migration number seen there is an uncommitted 0236). So nothing could be reused from it, and its upload flows were **not touched**.

Built on the existing PC5 pieces and aligned so the two can converge:

| Reused (existing) | Duplicated / new (to be unified later) |
|---|---|
| `validateAllocation`, `defaultEqualAllocation`, `PC5_TOTAL_BASIS_POINTS` (lib/pc5/jointAllocation) | `ownerSelectionSchema` + `validateOwnerSelection` in `lib/services/investment-intelligence/ownerModel.ts` (same names and field names as the Phase 1 brief: `kind`, `member_id`, `business_entity_id`, `allocations[].basis_points`) |
| `recordAllocationGroup` (lib/pc5/allocationStore): supersede + insert + its audit events | `GET /api/investment-intelligence/accounts/[id]/owner` options payload (account-scoped; Phase 1's `/api/ownership/options` would be user-scoped) |
| `BUSINESS_ENTITY_TYPE_REQUIRED_COUNTRY`, `getUserFullExperienceHomeCountry` (HUF gate) | `buildOwnerOptions` (country-gated list) |
| `businessEntityOwnerRole`, `mapRelationshipToOwner` (owner role) | `OwnerChangeDialog` (an account-owner dialog; Phase 1's `OwnerSelector` is the upload-form control) |

Integration plan: when Phase 1 lands, move `ownerSelectionSchema` / `validateOwnerSelection` into its shared module (or make it re-export mine), point `buildOwnerOptions` at its options endpoint, and reuse its `OwnerSelector` inside the dialog's "choose" step. Same bp convention (10000 = 100%).

Merge-conflict surface to expect: `InvestmentIntelligenceClient.tsx` (a small edit to `handleAssignOwner` only) and `documentProcessing.ts` (the owner-exception loops, if Phase 1 touches them).

## 7. Tests, with negative controls

New files (all under `tests/unit/`): `iiOwnerModel.test.ts` (37), `iiOwnerChangeRoutes.test.ts` (37), `iiOwnerSeparationReaders.test.ts` (13), `iiOwnerChangeDialogUi.test.ts` (48) = **135 tests**. Updated: `iiResolutionGuidanceLinksUiContract.test.ts` (it asserted the removed one-click `assignOwner` button), `support/inMemorySupabase.ts` (added `.is` and `.contains`, additive).

Requested negative controls and where they live:

| Required control | Test (file > name fragment) |
|---|---|
| cross-tenant owner id rejected | Model: "cross-tenant member / entity / inside a joint". Routes: "cross-tenant owner ids ... rejected, nothing written, no audit" |
| inactive member rejected | Model + Routes: "inactive member" |
| HUF rejected non-India, accepted India | Model: "HUF is India-only" (AU, null, GB refused; IN accepted, role `other`). Routes: "HUF India-only: refused for an AU user (403) and ACCEPTED for an India user" |
| Company rejected when none | Model + Routes: "company only if the user has one" |
| joint total != 10000 / duplicate / zero | Model + Routes + UI view-model |
| owner change requires confirm | Routes: "explicit confirm" (PATCH) and "amend needs confirm", plus the legacy body |
| replay yields one allocation set | Routes: "replay idempotency" (joint, entity), and amend replay -> 409 with no second set |
| resolved case immutable, amend adds a row | Routes: "immutability: amending inserts a NEW resolved row; the original row is byte-for-byte unchanged" |
| joint case resolves and clears blocking state | Routes: "JOINT CASE: a 60/40 split resolves ... and clears the blocking state" (no open blocking case remains) |
| audit row for accepted, none for rejected | Routes: "audit" (accepted has before/after; rejected writes zero `ii_audit_events`), plus "no PII in audit" |
| entity-owned account not in personal totals | Readers: read model excludes it, `publishedTotal` unchanged; Model: `OWNER_IS_BUSINESS_ENTITY` |
| cross-user isolation | Routes: GET and PATCH/amend for another user's account / case are 404 and write nothing; B sees only B's options |

### 7.1 Mutation proof (each control seen red)

Each row: one deliberate rule-breaking edit to a source file, the four owner suites re-run, the failing assertions recorded, file restored from git. Script: `scripts/ownership/mutation_proof_owner_change.py`; raw results: `docs/ownership/owner_change_mutation_results.json`. The first pass of M09 (immutability) was a false control (the update had its own `status='open'` guard, so the mutation changed nothing); it was redesigned to remove both guards and then failed the immutability assertion. Reported here because a control that cannot fail is worthless.

| # | Rule deliberately broken | File mutated | Failing assertions (count) | Named failing assertion(s) |
|---|---|---|---|---|
| M01 | cross-tenant member accepted | `ownerModel.ts` | 4 | `NEGATIVE CONTROL [cross-tenant owner ids]`; `NEGATIVE CONTROL [amend validation is the same function]`; +2 more |
| M02 | inactive member accepted | `ownerModel.ts` | 4 | `NEGATIVE CONTROL [inactive member]`; `NEGATIVE CONTROL [audit]`; +2 more |
| M03 | HUF country gate removed | `ownerModel.ts` | 4 | `NEGATIVE CONTROL [HUF India-only]`; `NEGATIVE CONTROL [amend validation is the same function]`; +2 more |
| M04 | foreign / absent entity accepted (company-only-if-owned, cross-tenant entity) | `ownerModel.ts` | 4 | `NEGATIVE CONTROL [cross-tenant owner ids]`; `NEGATIVE CONTROL [company only if the user has one]`; +2 more |
| M05 | joint allocation maths skipped (total / duplicate / zero) | `ownerModel.ts` | 4 | `NEGATIVE CONTROL [total must be exactly 10000]`; `NEGATIVE CONTROL [no duplicate owner]`; +2 more |
| M06 | PATCH does not require confirm | `route.ts` | 2 | `NEGATIVE CONTROL [explicit confirm]`; `tenant isolation the legacy { ownerMemberId } body still works, but only with confirm:true` |
| M07 | amend does not require confirm | `route.ts` | 1 | `NEGATIVE CONTROL [amend needs confirm]` |
| M08 | replay not idempotent (always writes a new allocation group) | `accountOwnership.ts` | 2 | `NEGATIVE CONTROL [replay idempotency]`; ` accounts/[id]/owner -- idempotency and audit replaying an entity change is idempotent too` |
| M09 | apply rewrites already-resolved cases (immutability broken) | `accountOwnership.ts` | 3 | `NEGATIVE CONTROL [replay idempotency]`; `NEGATIVE CONTROL [immutability]`; +1 more |
| M10 | PATCH lets a sole owner resolve a joint-holding case | `route.ts` | 1 | `NEGATIVE CONTROL [joint case needs a joint owner]` |
| M11 | amend lets a joint case be amended to a sole owner | `route.ts` | 1 | `story a resolved JOINT case can be amended to another joint split, but not to a sole owner` |
| M12 | accepted change writes NO audit row | `accountOwnership.ts` | 3 | `e 100% allocation row, owner_member_id stays null, open owner case resolved, one audit row`; `NEGATIVE CONTROL [replay idempotency]`; +1 more |
| M13 | audit written even for a no-op replay | `accountOwnership.ts` | 1 | `NEGATIVE CONTROL [replay idempotency]` |
| M14 | audit metadata leaks a name | `ownerModel.ts` | 2 | `NEGATIVE CONTROL [no PII in audit]`; `dempotency key audit shape carries ids and basis points ONLY -- no names, no folio, no PAN` |
| M15 | account tenant scope removed from loadAccountOwnership | `accountOwnership.ts` | 3 | `NEGATIVE CONTROL [account tenant isolation]`; `NEGATIVE CONTROL [cross-user isolation]`; +1 more |
| M16 | published-account entity guard removed | `accountOwnership.ts` | 2 | `NEGATIVE CONTROL [entity separation]`; ` and history an amend refused by the published-account rule leaves NO amendment row behind` |
| M17 | entity-owned holdings offered to personal Net Worth (read model) | `investments.ts` | 2 | ` NOT offered to personal Net Worth; a personal account's still are; no total includes them`; `tity share is excluded too; a members-only joint split and a SUPERSEDED entity row are not` |
| M18 | entity-owned account publishable (eligibility) | `publicationLogic.ts` | 2 | `NEGATIVE CONTROL [entity-owned never publishes]`; `ibility (PO ruling 2026-09-21) a joint split that includes an entity share is also blocked` |
| M19 | AU ownerRecorded reads only the pointer | `auAccountResolution.ts` | 1 | `ned account reports ownerRecorded=true; NEGATIVE CONTROL: an untouched account stays false` |
| M20 | HUF offered to a non-India user in the picker | `ownerModel.ts` | 2 | `returns the caller's own current owner and options only; an AU user is not offered the HUF`; `n members, then entities; HUF is NOT offered to a non-India user; inactive are not offered` |
| M21 | UI: >2 decimals accepted as a percentage | `ownerChange.ts` | 2 | `parsePercentToBasisPoints ".5" -> 50`; `parsePercentToBasisPoints NEGATIVE CONTROL: "33.333" is rejected (null)` |
| M22 | UI: joint total not checked | `ownerChange.ts` | 4 | `NEGATIVE CONTROL [total]`; `NEGATIVE CONTROL [over 100%]`; +2 more |
| M23 | UI: confirm enabled for a published -> entity move | `OwnerChangeDialog.tsx` | 1 | `hed account moving under an entity: the confirm button is DISABLED and the reason is shown` |
| M24 | effective ownership ignores the allocation (pointer only) | `ownerModel.ts` | 9 | `NEGATIVE CONTROL [replay idempotency]`; ` accounts/[id]/owner -- idempotency and audit replaying an entity change is idempotent too`; +7 more |
| M25 | member choice leaves the pointer unset | `accountOwnership.ts` | 3 | `tenant isolation the legacy { ownerMemberId } body still works, but only with confirm:true`; ` member supersedes the entity allocation (kept as history) and restores the member pointer`; +1 more |
| M26 | upload pipeline re-opens owner cases on decided accounts | `documentProcessing.ts` | 1 | `e owner is already decided as entity / joint, and does not count it as an unresolved owner` |
| M27 | generic Resolve closes a joint-holding case with no owner decision | `route.ts` | 1 | `NEGATIVE CONTROL [no bypass]` |

All 27 mutations were caught (0 survivors). Unmutated baseline: all four suites green (150 tests at the time of the run). M26 (upload-pipeline guard) is caught only by a **structural** source assertion, not a behavioural one; see 7.3.

### 7.2 Existing suites run

* After the shared `node_modules` was restored (an `npm ci` ran under this session; the earlier runs were against a checkout missing `pdf-parse`, which made 12 files unloadable and is why the first run looked worse), the targeted run was repeated on the final tree: `tests/unit/ii*`, `pc5*`, `aieIi*`, `aiePc5*`, `fdh11*`, `readModels/*`, `dashboardCanonical*`, `businessEntity*`, `lr11b*`, `reportSnapshot*`, `reportCanonical*`, `countryGate*`, `ensureSelf*` -> **173 files, 2,684 tests passed, 5 skipped, 2 failed**:
  * `fdh11Isolation.test.ts > no engine, report or dashboard queries fdh_investment_statement_* directly`: **5s timeout under parallel load** (the known repo-walking-test hazard); **passes in isolation**.
  * `countryGateAccessMatrix.test.ts > MC-15 ... no account/user-deletion API route exists`: **fails in isolation too and is pre-existing**: it finds `app/api/admin/account-deletions/[id]/execute/route.ts`, a file on `origin/main` that this branch does not touch.
* The four owner suites alone (final tree): 150 tests, all green. `iiDocumentProcessingAiFallbackWiring` (drives `processSourceDocument`, so it exercises the new `loadDecidedOwnershipAccountIds` call) passes.
* `tsc --noEmit -p .`: baseline captured before any edit (66 errors, all missing-package typings); after the changes and with a complete `node_modules` the run shows **1** error, `tests/unit/canonicalCertResidueAllSql.test.ts(127,75)`, which was also in the baseline list and is in an untouched file: **zero errors in touched files** (the intermediate run on the incomplete checkout was identical to the baseline).
* `eslint` on every touched file: clean. (Pre-existing errors remain in untouched `AiExtractionReviewPanel.tsx` and `TransactionDetailModal.tsx`; one pre-existing `set-state-in-effect` error in `ResolutionHistoryClient.tsx` was fixed because the file was being edited.)
* Full-suite runs rewrite `scripts/` artifacts; `git checkout -- scripts/` was run after targeted runs.

### 7.3 What the tests cannot show

No jsdom: typing, focus trap, Escape, the radio/select interaction and the real fetch round trip were **not executed**. The in-memory Supabase fake does not enforce database triggers, unique indexes or RLS. The upload pipeline's new guards (section 3, row 4) are covered structurally plus by the wiring suite above; a real statement through `processSourceDocument` against an entity-owned account was **not** run.

## 8. Migration and prerequisites

**No migration was added.** Nothing here needed one: no new column (the allocation table already exists), no new audit event type (`user_correction`, `reconciliation_case_resolved`, `pc5_ownership_allocation_*` exist), `resolution_method` is free text, and `discrepancy_type` is unchanged.

Collision scan (791 refs: all local and remote branches, plus every worktree under `D:\FHIP\.claude\worktrees` and the temp worktrees): migration numbers present above `0227`: `0228`, `0229` (on `origin/main`), `0230` (`m11-7-*`), `0231` (`admin-premium-grant`), `0232` (`india-mf-investment-report`), `0236` (uncommitted, `owner-before-upload` worktree), `0237` and `0238` (uncommitted, `admin-premium-grant` worktree), `0239` (`bench1-phase2` worktree, found at the finish re-scan). **Had one been needed it would have to be 0240 or higher.** Re-scanned worktrees before finishing; see section 10.

**Prerequisites for this feature to work in an environment (NOT applied by this work):**

* `0153_pc5_governed_resolution.sql` (creates `ii_ownership_allocation`, its tenant trigger and the allocation audit event types). Per the NAV1 certifications (2026-09-25, 2026-09-27) it was **DEV only**. Without it: entity / joint writes return `503 OWNERSHIP_FEATURE_NOT_AVAILABLE` ("not available in this environment yet, nothing was changed"); plain member assignment keeps working; the readers degrade to the old behaviour.
* `0154` (HUF as an India-only entity type and `trg_business_entities_huf_india_gate`) for HUF.
* Before 0153 reaches production, the NAV1 note stands: `ii_ownership_allocation` is not in the "held definition" (`pc6_user_held_instrument_ids`) and should be extended.

## 9. Known limits

* Concurrent identical submissions are not serialised by the database; the sequential replay is idempotent. Hardening, if wanted: a partial unique index on `(ii_account_id, coalesce(owner_member_id, owner_business_entity_id)) where status = 'active' and ii_instrument_id is null` (needs a migration ≥ 0240 and its own review).
* `recordAllocationGroup` is supersede-then-insert, not one transaction (existing, documented design). A crash between the two leaves the account with no active allocation; the pointer still holds the old member, a retry completes it.
* After an owner change the existing positions are not re-certified automatically; the existing "Re-evaluate" action on the position does it (same as before this work). A published member-owned account that changes to another member / joint keeps its old owner label in Net Worth until re-published (the dialog says so).
* The `ii_reconciliation_cases` COMMENT in migration 0227 is stale (section 5).

## 10. Verification not performed

DEV: not reachable unattended without minting credentials; nothing applied. Production: untouched. No browser walk-through. Migration-number re-scan at finish (worktrees under `D:\FHIP\.claude\worktrees`, 2026-10-01 ~19:00): highest number in flight is **0239**; this branch adds **no migration**, so there is nothing to renumber. Any future migration from this work must be **0240 or higher** and re-scanned again.

## 11. Open PO decisions

1. **Entity-owned accounts in the Investment Intelligence workspace analytics and personal report sections** (section 4): leave aggregated (today's behaviour), exclude from the personal report only, or build the separate entity view the 2026-09-21 ruling describes?
2. **Joint split between household members only is published to Net Worth once, under owner role `joint`.** Confirm this is wanted (alternative: block it like an entity until the joint register semantics are decided).
3. **A statement that prints a joint holding can only be resolved or amended with a joint split.** If a user decides the statement is actually sole-owned, today they Dismiss / Acknowledge the issue (which does not resolve it). Allow a sole owner with an explicit "this is not joint" confirmation?
4. **Mixed joint (member + entity) keeps the whole account out of personal Net Worth** (the entity share cannot be carved out of a whole-position publication). Acceptable, or should the personal share be publishable?
5. **Apply 0153 (and 0154) to production** before this is merged; confirm status first.
6. **Concurrency hardening** (section 9) and refreshing the 0227 column comment: both need a migration (≥ 0240).
7. HUF/Trust/Company **creation** still lives on `/companies`; the dialog only links to it.
