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

> **Update 2026-10-01 (second pass): the PO answered the four open decisions and they are implemented as separate commits. They are described in section 12 and supersede the matching statements below** (section 4 "what was NOT done", the joint-case rule in 2.4 and 5, and open decisions 1-4 in section 11).

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
4. resolves the open owner cases the choice may resolve, **merging** `resolvedOwner` / `previousOwner` (ids and basis points only) into `discrepancy_details` without overwriting the detection evidence. `owner_unmatched` / `owner_mismatch`: any owner. `joint_holding_allocation_required`: a joint split, **or (PO decision 2026-10-01, section 12.3) a sole owner only with an explicit second confirmation `confirm_not_joint: true`**; without it a sole-owner choice is refused with `case_id` (422) and, without `case_id`, simply does not resolve the case;
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

**Superseded 2026-10-01 (PO decision, section 12.1):** the workspace analytics and the personal report chapters are no longer left aggregating entity-owned accounts: every owner class now has its own breakup, and the personal report chapters exclude entity data. The first-pass disclosure that they "aggregate every uploaded account regardless of owner" was accurate for the first pass only.

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

New files (all under `tests/unit/`), first pass: `iiOwnerModel.test.ts`, `iiOwnerChangeRoutes.test.ts`, `iiOwnerSeparationReaders.test.ts`, `iiOwnerChangeDialogUi.test.ts`. Second pass (section 12): `iiJointValueAttribution.test.ts`, `iiOwnerClassBreakup.test.ts`, `iiOwnerClassUi.test.ts`, `iiOwnerClassRoutes.test.ts`, `iiOwnerClassReport.test.ts`, and additions to the first-pass files. All nine owner suites are green. Updated: `iiResolutionGuidanceLinksUiContract.test.ts` (it asserted the removed one-click `assignOwner` button), `support/inMemorySupabase.ts` (added `.is` and `.contains`, additive).

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

All 27 first-pass mutations were caught (0 survivors). M10 and M11 were re-targeted at the shared `jointCaseOwnerFailure` call after the not-joint change and re-run (2 failing each). Second-pass mutations M28-M41 are in section 12.5. Unmutated baseline: all four suites green (150 tests at the time of the run). M26 (upload-pipeline guard) is caught only by a **structural** source assertion, not a behavioural one; see 7.3.

### 7.2 Existing suites run

* After the shared `node_modules` was restored (an `npm ci` ran under this session; the earlier runs were against a checkout missing `pdf-parse`, which made 12 files unloadable and is why the first run looked worse), the targeted run was repeated on the final tree: `tests/unit/ii*`, `pc5*`, `aieIi*`, `aiePc5*`, `fdh11*`, `readModels/*`, `dashboardCanonical*`, `businessEntity*`, `lr11b*`, `reportSnapshot*`, `reportCanonical*`, `countryGate*`, `ensureSelf*` -> **173 files, 2,684 tests passed, 5 skipped, 2 failed**:
  * `fdh11Isolation.test.ts > no engine, report or dashboard queries fdh_investment_statement_* directly`: **5s timeout under parallel load** (the known repo-walking-test hazard); **passes in isolation**.
  * `countryGateAccessMatrix.test.ts > MC-15 ... no account/user-deletion API route exists`: **fails in isolation too and is pre-existing**: it finds `app/api/admin/account-deletions/[id]/execute/route.ts`, a file on `origin/main` that this branch does not touch.
* The four owner suites alone (final tree): 150 tests, all green. `iiDocumentProcessingAiFallbackWiring` (drives `processSourceDocument`, so it exercises the new `loadDecidedOwnershipAccountIds` call) passes.
* `tsc --noEmit -p .`: baseline captured before any edit (66 errors, all missing-package typings); after the changes and with a complete `node_modules` the run shows **1** error, `tests/unit/canonicalCertResidueAllSql.test.ts(127,75)`, which was also in the baseline list and is in an untouched file: **zero errors in touched files** (the intermediate run on the incomplete checkout was identical to the baseline).
* `eslint` on every touched file: clean. (Pre-existing errors remain in untouched `AiExtractionReviewPanel.tsx` and `TransactionDetailModal.tsx`; one pre-existing `set-state-in-effect` error in `ResolutionHistoryClient.tsx` was fixed because the file was being edited.)
* Full-suite runs rewrite `scripts/` artifacts; `git checkout -- scripts/` was run after targeted runs.

* **Second pass (final tree):** `tsc --noEmit -p .` = the same single baseline error (`canonicalCertResidueAllSql.test.ts`); `eslint` clean on every changed `.ts` / `.tsx` file; `git diff --stat origin/main -- lib/engines/investment-intelligence` is **empty** (the certified R4/R5/R6 engines are byte-for-byte untouched). Targeted run (`ii*`, `pc5*`, `aieIi*`, `aiePc5*`, `fdh11*`, `readModels/*`, `dashboardCanonical*`, `businessEntity*`, `lr11b*`, `report*`, `countryGate*`, `ensureSelf*`, `g1*`, `premium*`) = **184 files, 2,808 tests passed, 5 skipped, 5 failed in 4 files**: `iiAiReviewBeforeWrite`, `iiDocumentProcessingAiFallbackWiring` and `fdh11InvestmentIntegrityPglite` **pass in isolation** (5s timeouts under parallel load, the known hazard); `countryGateAccessMatrix` is the pre-existing failure described above.

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

Decisions 1-4 of the first pass were **answered by the PO on 2026-10-01 and implemented (section 12)**. What is still open is listed in section 12.6, together with items 5-7 of the first pass, which are unchanged:

5. **Apply 0153 (and 0154) to production** before this is merged; confirm status first.
6. **Concurrency hardening** (section 9) and refreshing the 0227 column comment: both need a migration (>= 0240).
7. HUF/Trust/Company **creation** still lives on `/companies`; the dialog only links to it.

## 12. PO decisions of 2026-10-01 (second pass)

Four decisions, four separate commits on this branch (`5d07131`, `5fd3499`, `a6f7253` + `94ff4a4`, `20065fe`, then docs). Still **code-complete only**: not DEV-verified, not production-verified, nothing pushed or merged, no migration added.

### 12.1 Decision 1: show everything, in a separate breakup per owner class; a consolidated view only as a macro summary

**Owner classes** (`lib/services/investment-intelligence/ownerClass.ts`). An account belongs to exactly one class, from its effective ownership: `member:<id>` (personal, one per household member), `joint` (members-only split), `entity:<id>` (a sole trust / HUF / company, one per entity), `entity_shared` (a split that includes an entity: **decision 4**), `unallocated`. The classes **partition** the accounts, so the macro line is exactly their sum with every position counted once (asserted, including a hand-computed oracle: 100,000 + 200,000 + 1,000,000 + 500,000 + 200,000 + 50,000 = 2,050,000, never 3,050,000).

**How workspace analytics aggregate by owner today (checked in code):** none of them looked at the owner. `overviewSummary`, `analyticsRepository` (Performance), `r5Repository` (SIP, X-Ray), `taxRepository` (Tax) and `holdingsRepository` read `ii_transactions` / `ii_holding_snapshots` / `ii_portfolio_truth_status` for **every** account of the user and the engines then group by **instrument**, across accounts. The personal report chapters called the same loaders.

**What was added, without altering any formula:**

* **Scoped read-only client** (`scopeClientToAccounts`): the account-scoped tables (`ii_transactions`, `ii_holding_snapshots`, `ii_portfolio_truth_status`, `ii_fhip_publications`, `ii_tax_lots`, `ii_accounts`) are narrowed to a class's accounts; every other table passes through; **writes throw**. The certified loaders and engines run on it **unchanged** and simply receive that class's rows. `git diff origin/main -- lib/engines/investment-intelligence` is empty. A test proves the per-class inputs sum to the consolidated input (contributions 1,000 + 5,000 = 6,000) and that each class sees only its own.
* **API:** `GET /api/investment-intelligence/owner-classes` (the caller's own classes + the explicit macro option). `?ownerClass=<key>` on `analytics`, `sip`, `xray` (+ `overlap`, `data-quality`), `tax/summary`, `tax/lots`, `holdings` and `overview`. Absent / `all` = the existing consolidated behaviour. The key is validated against the caller's **own** classes (another user's key or an unknown key is `404 OWNER_CLASS_NOT_FOUND`, no leak). A scoped run **never persists** (SIP, X-Ray, tax summary skip their persistence steps; asserted by a spy on the SIP route), so a per-class result can never overwrite the consolidated derived rows. Responses carry `ownerClass: { key, label, kind }`.
* **UI:** an owner-class selector (`OwnerClassBar`) on Performance (and its Holdings table), Recurring investments, X-Ray and Tax. **The default is the explicit "Consolidated (macro view only)" chip**, with text saying entity holdings are not part of a personal total. A class re-mounts the tab and fetches that class's analysis. The Overview does not need a selector: it shows **one table per owner kind** (personal / joint with each owner's divided part / trust-HUF-company / shared with an entity / unallocated) and then a separate dashed **"Consolidated (macro view only)"** line (`OwnerBreakupTable`, `ownerBreakup` in the overview response). Evidence: `owner_class_breakup_preview.html` / `.png` / `_mobile.png` (static render of the real component, invented fixture, headless Chromium; not a live-app session; 0px horizontal overflow at 390px).
* **Personal report** (`ownerClassReportScope.ts`, `reportOwnerBreakup.ts`, `reportSnapshotResolver.ts`, `reportSectionsPremium.ts`): a household with **no** entity accounts gets the unscoped client, so its report is **unchanged** (asserted). With entity accounts, the performance, SIP, X-Ray and tax chapters run on the **non-entity** accounts only (unallocated stays in, never hidden), and the Investment performance chapter lists **every owner class as its own item followed by the explicit macro line** (in its limitation text and as `sectionData.ownerBreakup`); the other three chapters say entity holdings are not included. No new report section code was added (that could need a DB CHECK change), so the breakup travels in the existing chapter.

**Agreement with the India MF report** (`feat/india-mf-investment-report-20261001`, read-only): its owner keys are `member:<id>` / `entity:<id>` / `unallocated`; I use the same keys and the same rules (an allocation group that does not total 10000, and an owner id with no matching member / entity row, are **Unallocated**, never silently personal; `deriveAccountOwnership` now enforces the 10000 rule). It shows a joint folio inside **each** owner's section at that owner's share; my joint class lists each owner's part at the same shares inside one joint table (largest-remainder division, so the parts add back exactly). Both read the same `ii_ownership_allocation` rows. **Merge-conflict surface:** that branch also edits `lib/engines/reportSectionsPremium.ts` and `lib/services/reportSnapshotResolver.ts`; expect a textual conflict in those two files at integration (additive on both sides).

**Not scoped (disclosed):** the two POST simulations (`sip/simulation`, `tax/redemption-simulation`) and the open-case counts inside the scoped Overview summary (`ii_reconciliation_cases` has no account column) stay consolidated; the report's other chapters (Net Worth, Investment analysis) are unchanged by design (Net Worth already excludes entity holdings: section 4).

### 12.2 Decision 2: a joint split between household members is published ONCE and divided by the percentage split

It was already published once (one `investments` row at the full value, owner role `joint`); what was missing was the **division**. `lib/services/investment-intelligence/ownerAttribution.ts` divides a value by basis points with the largest-remainder method (shares always add back **exactly**; a split that is not exactly 10000, or has a zero / fractional share, returns `null` and never fabricates a value). The Investments read model attaches `ownerShares` to a published line whose account has an active members-only split: **1,000,000 at 60/40 -> 600,000 / 400,000; `publishedTotal` and `householdPublishedTotal` stay 1,000,000, never 2,000,000.** The division follows the **live** allocation, so amending 60/40 to 70/30 re-divides the same single value with no republish (asserted: 700,000 / 300,000). Malformed, entity-shared, superseded and instrument-grain groups never divide a value. **Financial oracle:** `tests/unit/iiJointValueAttribution.test.ts` (hand-computed expectations; includes 3333/3333/3334 of 100.00 -> 33.33 / 33.33 / 33.34, and a structural check that publication still writes one register row at the full `snapshot.value`). The publication write path itself needs a database and was not run.

### 12.3 Decision 3: a sole-owner resolution of a joint holding, with an explicit "this is not joint" confirmation

`confirm_not_joint: true` (in addition to `confirm: true`) on `PATCH .../accounts/[id]/owner` and `POST .../amend`. Without it the previous refusal stands (422 `JOINT_CASE_REQUIRES_JOINT_OWNER`, nothing written). With it: the case resolves with `resolution_method = user_confirmed_not_joint`, `notJointConfirmed: true` in the case details and in the audit event (ids only), the detection evidence is preserved, validation is the same function (cross-tenant ids refused), and **no allocation row is written for a sole member, so value is never duplicated** (the account reads as a sole member through the `owner_member_id` pointer only). It is **amendable** (back to a joint split, or to another owner, with the flag again if a sole owner) and the original row stays untouched; replay is idempotent (no second audit row). The existing **Re-evaluate** action on the position is the way to re-certify afterwards, as before. The dialog's joint-only mode gets a "This is not a joint holding" link that lists single owners behind a checkbox confirmation; the confirm text says "not jointly held". The flag does not relabel an ordinary `owner_unmatched` resolution.

### 12.4 Decision 4: a joint split that includes an entity goes in the separate entity tables and consolidates only in the macro view

Class `entity_shared` ("Shared with a trust, HUF or company"), listed under the entity tables on the Overview with each owner's divided part, excluded from the personal report chapters, from the Net Worth publication (`OWNER_IS_BUSINESS_ENTITY`, first pass), and from the personal "not yet in Net Worth" bucket. It reaches a consolidated number **only** in the explicit macro line. `hasEntity` is the discriminator everywhere; a test proves no personal table contains it (personal total 300,000, not 500,000 or 800,000).

### 12.5 Negative controls added in the second pass (each seen red)

| # | Rule deliberately broken | File mutated | Failing assertions | Named failing assertion(s) |
|---|---|---|---|---|
| M28 | not-joint override needs no second confirmation | `ownerModel.ts` | 5 | `NEGATIVE CONTROL [joint case needs a joint owner]`; `NEGATIVE CONTROL [needs the second confirmation]`; +3 more |
| M29 | a sole owner resolves a joint case without the flag (apply) | `ownerModel.ts` | 4 | ` -- joint splits without case_id, a sole-owner choice never resolves an open joint-holding case`; `1) without case_id the flag alone resolves the account joint case; without the flag it does not`; +2 more |
| M30 | attribution accepts a split that is not 10000 | `ownerAttribution.ts` | 1 | `NEGATIVE CONTROL [never fabricates]` |
| M31 | attribution drops the rounding remainder (shares do not add back) | `ownerAttribution.ts` | 1 | `ever drifts: 0.0001 across two owners gives 0.0001 + 0 (largest remainder, earlier owner first)` |
| M32 | read model divides an incomplete (not 10000) joint group | `investments.ts` | 0 | **none: equivalent mutant (see text)** |
| M33 | owner-class scope forgets ii_transactions | `ownerClass.ts` | 5 | `puts equals the consolidated input (no row lost, none duplicated); each class sees only its own`; `NEGATIVE CONTROL [scope is what narrows]`; +3 more |
| M34 | scoped client allows writes (a per-class run could persist) | `ownerClass.ts` | 1 | `NEGATIVE CONTROL [read-only]` |
| M35 | entity-shared account classified as plain joint (personal-looking) | `ownerClass.ts` | 4 | `y:<id>; members-only split -> joint; split with an entity -> entity_shared; none -> unallocated`; `er class, in a stable order: personal members, joint, entities, shared-with-entity, unallocated`; +2 more |
| M36 | macro line double-counts | `ownerClass.ts` | 5 | `o line is explicit, labelled, and EXACTLY the sum of the classes (each position once, never 2x)`; `EST snapshot per position, never another tenant's, and its macro line equals the sum of classes`; +3 more |
| M37 | report chapters run on the unscoped client | `reportSnapshotResolver.ts` | 1 | `ural) the report resolver runs the four II chapters on the scoped client and stores the breakup` |
| M38 | a per-class SIP run persists over the consolidated rows | `route.ts` | 2 | `persists consolidated run persists (control); a scoped run does not, and says which class it is`; `NEGATIVE CONTROL [no persistence from a scoped run]` |
| M39 | incomplete allocation group trusted as an owner | `ownerModel.ts` | 1 | `omplete split (not 10000) and an unknown owner id are both Unallocated, never silently personal` |
| M40 | a foreign / unknown owner class is accepted | `ownerClassScope.ts` | 2 | `NEGATIVE CONTROL [tenant isolation]`; `NEGATIVE CONTROL [unknown class]` |
| M41 | report does not exclude entity data | `ownerClassReportScope.ts` | 1 | `t -> a read-only client narrowed to the non-entity accounts, and the breakup lists both classes` |

**M32 survives, and why:** it removes the read model's own "group must total 10000" skip; the value is still not divided because `attributeByBasisPoints` independently returns `null` for a non-10000 split (M30 shows that guard is itself tested). Two independent guards for one property, so removing either alone is an equivalent mutant; both are asserted by the malformed-split test.

### 12.6 What the PO must still decide

1. **Per-class views exist on Performance / SIP / X-Ray / Tax and as tables on the Overview, but the personal report only lists the classes in the Investment performance chapter's text.** Should the report get a **separate chapter per entity** (full Performance / SIP / Tax for each trust, HUF, company)? That would need new section codes (possibly a DB CHECK change).
2. **The India MF report branch shows a joint folio inside every owner's section**, while this branch also gives joint its own class. They agree on keys and rules, but the PO may want one presentation.
3. **Simulations** (SIP what-if, tax redemption simulator) run on the consolidated data; should they take the owner class?
4. **The Investments register / Net Worth screens** do not display the new `ownerShares` yet (the read model carries them; the Investment Intelligence Overview shows the divided parts). Wanted on the register grid?
5. **A sole-owner "not joint" decision on a statement that is genuinely joint is audited and amendable but is the user's word**: no further evidence gate. Acceptable?
