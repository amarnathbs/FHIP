# Owner-before-upload — Phase 1 report

> **UPDATE 2026-10-02.** This is the Phase 1 record and is kept as written, except where marked. The programme has since been completed: payslip, liability, retirement, AU investment, the generic upload sessions and the AIE intakes now take an owner too; the owner-edit branch is merged and there is ONE ownership model; the stale certification scripts were updated; migration `0236` now has **13** constraints (the AIE intake column and the FDH `owner_allocation` were added) and its PGlite verification is **55** checks. The authoritative current state, the matrix and the PO apply list are in `OWNER_BEFORE_UPLOAD_FINAL_REPORT.md` and `OWNER_BEFORE_UPLOAD_FINAL_MATRIX.md`. Sections 7 (scripts "not edited"), 10 (later phases) and 11 (open decisions) below are **superseded** by those documents.

Branch `feat/owner-before-upload-phase1-20261001` (from `origin/main` `cce323f`). Not pushed, not merged.
Scope this round: the shared foundation, the **India CAS upload**, and the **bank CSV/PDF upload**, plus a **separate item** (section 12): the bank "which account is this statement for?" flow, in its own commit. Payslip, liability, retirement, AU investment, AIE intake routes and PAN capture are untouched.

## 1. Evidence labels (read this first)

| Claim | Label |
|---|---|
| Everything in section 2 (design) and the code | **code-complete** |
| Unit / route / service tests in section 8 | **test-verified** against an in-memory database (`tests/support/fdhFakeSupabase.ts`) and real PGlite (PostgreSQL 18 WASM) for the SQL |
| Migration `0236` | **PGlite-verified** (real constraints, triggers, RLS), **NOT applied to DEV or production** |
| Backfill script | **PGlite-verified**, **NOT applied anywhere**; ships ending in `ROLLBACK` |
| Anything against the live DEV database (`vqycarelcoijzwlpkpcz`) | **NOT DONE.** No DEV credentials were available unattended and none were minted. |
| Anything against production (`twwpnltizhtjxhamyoxt`) | **NOT DONE, by instruction.** |
| The selector UI in a browser | **NOT DONE.** No authenticated session. A server-rendered HTML of the real component is provided (section 9); it shows markup and initial state, not interaction. |

Until the PO applies `0236` to DEV, the new code runs in a documented degraded mode (section 6.4): member-owned CAS and the bank flow keep working; entity/joint CAS owners are refused with a clear 503 rather than half-stored.

## 2. Design

### 2.1 One wire format, one validator, one control

- `lib/ownership/ownerSelection.ts` (client-safe): zod schema `{ kind: member | entity | joint | smsf, memberId | entityId | allocations[{memberId|entityId, basisPoints}] }`, `.strict()` so a hostile body that carries a `country` is refused as invalid. Helpers `ownerSelectionToQuery` / `ownerSelectionToMeta`, `percentToBasisPoints` (refuses `33.345` rather than rounding), `equalShares`.
- `lib/ownership/validateOwnerSelection.ts`: `validateOwnerSelection(userId, input, flow)` = load the user's own context (service role, every query `.eq('user_id')`, home country from `getUserFullExperienceHomeCountry`) then the **pure** `validateOwnerSelectionAgainst(ctx, input, flow)`. Failure codes: `owner_required`, `owner_invalid`, `owner_not_found` (cross-tenant and made-up ids are indistinguishable), `owner_inactive`, `owner_not_allowed_for_country`, `owner_not_allowed_for_flow`, `joint_*`. Joint goes through the existing `lib/pc5/jointAllocation.ts validateAllocation` unchanged.
- `GET /api/ownership/options?flow=bank|ii_cas` (`lib/ownership/ownerOptions.ts`): built by running every candidate through the same validator, so an option can never be offered that the upload would then refuse. Self is created on first use by the existing `ensureSelfHouseholdMember`.
- `components/ownership/OwnerSelector.tsx`: one `<select>` (People / Trusts, HUFs and companies / Joint / SMSF), joint rows with a percent input per owner, equal-split default (3333+3333+3334), percent shown and converted to basis points by `lib/ownership/jointDraft.ts`, inline "add a household member". Emits `null` until the answer is complete, so a form disables Upload on `null`.

### 2.2 Per-flow policy (a table in code, asserted by tests)

| Flow | member | entity | joint | SMSF |
|---|---|---|---|---|
| **bank** | Self, Spouse/Partner only | **refused** (decision 7) | allowed, **no percentages** (decision 3 limitation) | AU only |
| **ii_cas** | any active member | Trust, Company; HUF India only | allowed, **percentages required**, exactly 10000 bp | not offered (AU-only and a CAS is an India document) |

### 2.3 Where the owner is stored

- `fdh_statement_uploads.owner_member_id | owner_business_entity_id | owner_role | owner_selection_source` (new, migration 0236).
- `ii_source_documents.owner_business_entity_id | owner_role | owner_selection_source | owner_allocation (jsonb) | owner_review (jsonb)` (new); `owner_member_id` already existed.
- `fdh_financial_accounts.owner_role` (0207, unchanged) is kept in sync for bank; `ii_accounts.owner_member_id` for a member-owned CAS.
- **Joint / entity allocation store: reused `ii_ownership_allocation` (0153), not a new table.** It is keyed by `ii_account_id`, already enforces one owner kind per row, is amendment-by-supersession, and PC5's Resolutions UI reads it. The document keeps only the JSON of what the user chose (`owner_allocation`, DB-checked to sum to exactly 10000) so the intent survives a later amendment of an account's allocation.
- `buildStatementUploadPurgePatch` does not name any owner column (verified); `PURGE_RETAINED_STATEMENT_UPLOAD_COLUMNS` now lists them and a test asserts the patch never touches them.

### 2.4 India CAS flow

- Step 1 form uses `OwnerSelector flow="ii_cas"`; Upload is disabled until an owner is chosen; owner travels in `meta.owner`.
- Server (`POST /api/investment-intelligence/source-documents`): owner validated **before the file is read**; the old `ownerMemberId` field is gone from the schema, so a client that sends only it is told `owner_required`.
- Processing (`documentProcessing.ts`, and the AI-fallback apply path `aiExtractionReviewApply.ts`): when the document carries a user-selected owner (`readDocumentOwner`), `owner_unmatched` cannot arise, the owner is applied to every folio via `documentOwner.ts`, and a printed-holder-name disagreement (PC5's own `matchStatementOwner`, reused) becomes a **non-blocking warning** in `owner_review`, shown on the statement detail. The legacy branches (`owner_unmatched`, `owner_mismatch`, `joint_holding_allocation_required`) are untouched and still run for documents that predate this change; the Review/Resolutions UI and `PATCH /accounts/:id/owner` are unchanged.
- **Decision 2 (existing account, different owner):** an existing folio with no owner is filled in; with the same owner nothing changes; with a **different** owner it is left exactly as it was and recorded as a conflict on the document. The statement detail shows "already filed under a different owner … left exactly as they were" with a button; only `POST /source-documents/:id/confirm-owner` (explicit user action; can only touch folios recorded as conflicts on that document and owned by the caller) changes it.
- **Decision 6 (identical file, different owner):** `409 identical_upload_different_owner`, naming the first owner; nothing stored, storage untouched, first document never reassigned. Same owner → the usual `deduplicated` answer. A joint upload is "the same owner" only with the same split. An earlier copy with **no** owner recorded gets its own message (existing document has no owner; set it under Resolutions) rather than silently adopting the new choice.
- **"This is not joint"** (PO, 2026-10-01): when the statement prints a joint holding but the user chose a single owner, the holdings are filed under that owner and a non-blocking warning is shown. A button "This is not joint, it is solely owned by <owner>" calls `POST /source-documents/:id/confirm-sole-owner`, which dismisses the warning for those folios only (it changes no account owner; making a folio genuinely joint is the Review/Resolutions owner dialog), records an audit event, and is remembered across reprocessing (`owner_review.acknowledgedSoleOwner`). Refused for another user's document, a folio without that warning, and a joint/entity-owned document.
- **Recertification** (`recertifyPosition`) treats an account with an active `ii_ownership_allocation` as owner-resolved (previously only `owner_member_id`), so an entity/joint-owned folio is not re-flagged `unresolved_owner`. (The owner-edit branch replaces this with its fuller `loadAccountOwnership`; see 2.7.)

### 2.5 Bank flow

- `BankStatementImportPanel` uses `OwnerSelector flow="bank"`; Upload disabled until chosen; owner sent as `owner=<json>` (+ `confirm_owner_change=1` only after an explicit click).
- Both bank routes: owner **required** and validated before the body is read (`bankOwnerRequest.ts`). The loose `owner_role` query/metadata field is removed.
- `bankOwnerAttribution.ts`: owner persisted on the **document** in its own update (tolerant of a database without 0236, so the account link and period can never be lost to a missing column), and on the account under decision 2: unset → set; equal → nothing; different → `409 account_owner_conflict` **before anything is stored**, naming both owners; the panel asks "Yes, change the account's owner and upload / No, go back". A race past the preflight keeps the existing owner (`kept_existing`).
- Decision 6: same bytes + different owner → `409 identical_upload_different_owner` before anything is stored. The earlier copy's owner is its own `owner_role`, or for uploads that predate this change the account's `owner_role`. A rejected/failed earlier copy is a retry, not "already uploaded".
- The AIE bank intake path still calls `uploadBankPdf` with no owner (a later phase) and keeps its previous behaviour (`owner` parameter is `null`-able only for it).

### 2.6 Decision 7 — entity separation: exactly what I did and why

`isHouseholdOwner` (`lib/read-models/core/types.ts`) excludes **only** `owner = 'smsf'` from household totals; `'family_trust'`, `'company'` and `'other'` (what an HUF resolves to) are all treated as household. So a bank statement stamped Trust/HUF/Company would have flowed straight into household spending and income. I did **not** change the read models (that is the unscoped entity-data-separation programme and would risk existing totals). Instead:

- **Bank refuses every entity type** (`owner_not_allowed_for_flow`, with the reason shown in the selector). Only `self / spouse / joint / smsf` are accepted, which is exactly what the read models and `fdh_financial_accounts.owner_role` (0207 CHECK) handle correctly today.
- A test asserts the invariant in both directions: the entity roles are household under today's read models **and** the bank policy allows no entity types; if someone enables entities for bank without first teaching the read models to exclude them, the test fails.
- **CAS allows entities, and they cannot reach personal totals.** An entity-owned CAS position is stored with its owner (entity id on the document, a single 10000 bp row in `ii_ownership_allocation` per folio, `owner_member_id` NULL). PO ruling (2026-10-01): entity-owned data is shown in SEPARATE sections and consolidated only in a macro view, never silently merged into personal totals. This phase honours that by **not publishing** such positions to the personal register (publication needs a single member owner, so they stay blocked) and by refusing entities for bank. The separate display and the macro consolidation are not built here (later phase).
- **Joint between household members** (PO: published once and divided by percentage): the split is stored per folio in `ii_ownership_allocation` (basis points, exactly 10000) with role `joint`. Publishing such a position once, and dividing it by percentage in per-member views, is implemented by the owner-edit branch (2.7), not here; on this branch alone a joint CAS position stays unpublished (the safe direction, wording "owner could not be mapped"). I removed my own duplicate publication changes so the two branches do not both edit `publicationLogic.ts` / `investmentPublicationService.ts`.

### 2.7 Compatibility with `feat/owner-entity-joint-edit-resolutions-20261001` (read-only review)

That branch (finished, 31 files) edits `handleAssignOwner` in `InvestmentIntelligenceClient.tsx`, the owner loops in `documentProcessing.ts`, `publicationLogic.ts`, `investmentPublicationService.ts`, the owner PATCH route and the Review/Resolutions UIs. I read it without modifying it.

- **Same storage model:** entity/joint owners live only in the active `ii_ownership_allocation` group with `ii_accounts.owner_member_id` NULL; a member owner is the pointer. My `documentOwner.setAccountOwner` writes exactly that through the same `recordAllocationGroup`, so its `loadAccountOwnership` / `deriveAccountOwnership` read my data correctly. Both use `user_correction` audit events.
- **Hotspots to resolve at merge (all small):** (1) `documentProcessing.ts` step 3: it inserts `decidedOwnershipAccountIds` immediately above `const ownerUnresolved = !doc.owner_member_id;` and I change that line and the `if (ownerUnresolved)` below it. Resolution: keep both; the composition is correct (`ownerUnresolved = !documentOwner && !doc.owner_member_id`, and its `ownerUnresolved && !decidedOwnershipAccountIds.has(accountId)` at certification). (2) `recertifyPosition`: take THEIRS (superset of my allocation-count check). (3) `InvestmentIntelligenceClient.tsx`: my edits (upload form, Filed-under / owner notes in the detail) are in different regions from `handleAssignOwner` and the case-action buttons; no overlap expected. (4) The two branches each have an owner validator (`lib/ownership/validateOwnerSelection.ts` for upload, `ownerModel.validateOwnerSelection` for account changes); they validate different moments and can be consolidated later.
- I did **not** merge it into this branch, per instruction, and did not touch its files.

## 3. Migration number and collision-scan evidence

**`0236_owner_before_upload_phase1.sql`**.

Scan (2026-10-01, before choosing and again before finishing — see section 3.1 for the re-scan):
- every migration file ever added on **any local or remote ref** (`git log --all --diff-filter=A -- supabase/migrations`, 242 distinct files): highest **0231** (`0231_admin_premium_entitlement_grants.sql`); `0230_module11_7_ai_coach_prompt_and_model_task_type.sql` also present.
- every `supabase/migrations` in **all 149 worktrees** under `D:\FHIP\.claude\worktrees` (222 distinct files): highest **0232** (`0232_market_index_data_upload_and_feed.sql`), plus the `0228`/`0229` already on `origin/main`.
- main checkout `D:\FHIP\supabase\migrations`: highest 0227.
- Coordinator re-scan (2026-10-01, later): 0236 is mine; 0237/0238 are on the premium branch, 0232 on the India branch, 0239 is the highest in flight. No collision.
- Chose 0236, leaving 0233-0235 headroom for the in-flight admin-premium-grant and India-MF-report work. (Gaps are normal here: 0215-0217 are absent.)

Properties: additive only; idempotent (`add column if not exists`, constraints/trigger re-created by name only if absent; applying twice is proven); guarded (refuses to run if the four tables it extends are absent); RLS-safe (no policy touched; the policy inventory is proven identical before/after); **no existing CHECK is widened or dropped** (the trap in `migration_drop_recreate_constraint_trap`): all 13 constraints (11 at Phase 1; +1 on `fdh_statement_uploads.owner_allocation`, +1 on `aie_document_intake.owner_selection`) are new and named `…_0236`; a cross-tenant trigger (`owner_before_upload_assert_owner`, mirroring 0153's) refuses another user's member/entity id on both tables.

## 4. Backfill (reviewable, NOT applied)

`docs/ownership/owner_before_upload_phase1_backfill.sql` — PO decision 5, no invention:
- bank/liability uploads: copy `fdh_financial_accounts.owner_role` of the matched account → `owner_selection_source = 'backfill_from_account'` (`owner_member_id` left NULL: the account never recorded which member);
- II documents: copy the role of the existing `owner_member_id` → `'backfill_from_document'`;
- everything still without an owner → `'legacy_unset'`. Never assigns anyone to Self.
- Shipped ending in **`ROLLBACK`**; prints preview counts first and verification rows last; refuses to run without 0236 and 0207; only touches rows with no `owner_selection_source`, so it never overwrites a user-selected owner and a second run changes nothing.
- Run it on **DEV first**. Both properties (copies correctly, marks the rest `legacy_unset`, never overwrites `user_selected`, idempotent) are proven in `scripts/owner_before_upload_0236_pglite_verification.mjs` section 8.

## 5. PO apply script (DEV) — NOT applied

Order matters: migration first, then deploy code (the code tolerates the reverse for member-owned uploads, but not entity/joint).

1. Apply `supabase/migrations/0236_owner_before_upload_phase1.sql` to DEV (SQL editor, one run; safe to re-run).
2. Verify: `select column_name from information_schema.columns where table_name in ('fdh_statement_uploads','ii_source_documents') and column_name like 'owner_%' order by 1;` — expect the 4 + 5 new columns plus the existing `ii_source_documents.owner_member_id`.
3. Review then run `docs/ownership/owner_before_upload_phase1_backfill.sql` (ends in `ROLLBACK`; read the preview and verification output; change the last line to `COMMIT` to keep it).
4. Smoke (needs a real session): upload a CAS as Self → statement detail shows "Filed under"; upload the same file as Spouse → 409 naming Self; upload a bank CSV as Joint; re-upload to a Self account as SMSF → conflict prompt.

## 6. What was and was not verified

### 6.1 Ran and passed (see section 8 for the list with counts)
Validation, wire format, bank routes/services, CAS route/services, migration + backfill in PGlite, mutation controls, and the existing suites listed in section 8.

### 6.2 Not verified
DEV, production, a real browser, a real CAS PDF through `processSourceDocument` end to end (the new branch is covered by service-level tests and a structural test; the full parse path needs `pdf-parse`, which is missing from this workspace's `node_modules` — 10 pre-existing bank-PDF tests fail on that alone), the AIE bank intake path (deliberately untouched).

### 6.3 Environment notes (not caused by this change)
- This machine is slow: a number of long-standing tests (`m12aFdhBank*`, `iiAiExtractionReviewApply`, `fdh1Isolation`'s repo walk) exceed their 5 s / 20 s default timeouts under load and pass with `--testTimeout=90000`. The final run below used that flag.
- `D:\FHIP\node_modules` was deleted and reinstalled by another session part-way through (about two hours lost waiting); after it was restored `pdf-parse`/`xlsx` are present, so the ~66 baseline `tsc` errors disappeared. The one remaining `tsc` error is `tests/unit/canonicalCertResidueAllSql.test.ts(127)`, pre-existing and in a file I did not touch.

### 6.4 Degraded mode on a database without 0236
Bank: the account link/period still persist; the document owner is reported `unavailable`; the account owner is still written. CAS member-owned: works (uses the long-standing `owner_member_id`). CAS entity/joint: `503 owner_storage_unavailable`, **before** the file is written to storage. Summary/dedup reads use `select('*')`, so a missing column is just an absent field.

## 7. Behaviour changes a reviewer should know about

- Both upload APIs now **require** an owner. Anything that called them without one (live-test scripts under `scripts/canonical_cert/**`, `scripts/aie1_*`) will now get `owner_required`. They were not edited (out of scope); they need `owner=<json>` / `meta.owner` added when next used.
- The bank response field `owner_role_recorded` is replaced by `owner_role` and `owner_recorded: { account, document }`.
- A bank user with **no spouse/partner member** can no longer pick "My partner's" (it was a bare role before). The selector offers "Add a household member (e.g. your spouse)" inline; this is a deliberate consequence of selecting a person rather than a role (open decision 3).

## 8. Tests (negative controls named)

**Final run (22:12, `--testTimeout=90000`): 230 files passed, 1 skipped, 3940 tests passed, 0 failed** over: the five new files, `tests/unit/{pc5,ii,lr11b,appCapability,appNavCapability,migrationVersions,canonical0207,m12aFdhBank,aieFdhBank,gpStatement,lr3,bankImport,requireModuleCapability,aiePc5,fdhBankApprovalIntegrity,fdh1,r7,readModels,fdh5,fdh3,statementResume}*` (bank upload, II document processing, PC5, ownership, `appCapabilityManifest`/`appNavCapability`, the schema-contract and FDH isolation suites, read models). `scripts/` artifacts those suites rewrite were reverted with `git checkout -- scripts/...`. **`tsc --noEmit`: 0 errors in files I touched** (one pre-existing error elsewhere). **`eslint` on all 41 touched files: clean.** PGlite: `scripts/owner_before_upload_0236_pglite_verification.mjs` **47 passed, 0 failed**; the full migration chain replays with 0236 in it (`scripts/db-rebuild-check/replay.mjs`).

Existing tests I had to change because the contract changed (owner now required, `owner_role` param gone): `fdhBankApprovalIntegrity` (EXP-G13 block), `gpStatementPeriodCoverage`, `iiSourceDocumentUploadAdmissionRoute` (now carries an owner and a fixed validator context so the structural-admission denials are still what is tested), `appCapabilityManifest` (`ownership` added to the infra allow-list), `fdh1Isolation` (two FDH services added to the documented service-role list).

| New file | Tests | Covers |
|---|---|---|
| `ownerBeforeUploadValidation.test.ts` | 31 | owner required; cross-tenant id; inactive member/entity; HUF India-only; SMSF AU-only; Company only if created; joint 9999/10001/duplicate/zero/fractional/one-owner; owner never from a body country; bank refuses entities and the decision-7 invariant; options = validator |
| `ownerBeforeUploadSelection.test.ts` | 11 | percent <-> basis points, equal shares sum 10000, joint draft, wire format, bank query |
| `ownerBeforeUploadBank.test.ts` | 22 | both bank routes: owner required, stored on document + account, no silent account-owner overwrite (409 then confirm), identical file under another owner rejected (and its controls), entities refused, country from profile, owner write never costs the account link, purge keeps owner |
| `ownerBeforeUploadIi.test.ts` | 40 | CAS route: owner required, stored, joint split validated, HUF AU refused with body `countryCode: IN`, identical file different owner, DB-behind degraded mode; owner applied to accounts (entity, joint, fill, keep); explicit confirm only for that document's conflicts; non-blocking warnings; legacy cases untouched; "this is not joint"; purge; form wiring |
| `bankAccountAssignment.test.ts` | 45 | section 12 |

**Mutation controls** (a refusal is only evidence if breaking the rule makes a named test fail). Owner rules, each run once with the rule broken, all KILLED: HUF country gate removed -> 5 failures (`HUF is refused for a non-India user…`, `the request carries no country…`, `an HUF inside a joint split…`, the CAS route `HUF: accepted for an India user; refused for an AU user EVEN THOUGH the body says countryCode IN`, options); inactive check removed -> `an inactive member is refused…`; `validateAllocation` skipped -> 7 failures (9999/10001/duplicate/zero/fractional + CAS route); bank allowed entities -> 6 (`DECISION 7 INVARIANT…`, `a Trust the user really owns is REFUSED…`); account owner silently overwritten -> `DECISION 2…` x4; identical-file check removed (bank 2, CAS 3); CAS overwrite -> 4; owner not required -> 7; new-upload branch opens a blocking case again -> `…takes the new branch and that branch opens NO reconciliation case`; purge patch nulls `owner_role` -> `purge keeps the owner columns`; cross-tenant lookup unscoped -> 4; SMSF allowed for non-AU -> 3. SQL controls inside the PGlite script: dropping the cross-tenant trigger / the joint CHECK makes the forged id / 9999 split succeed, re-applying 0236 restores both.


## 9. UX

`docs/ownership/owner_selector_preview.html` — the real `OwnerSelector` server-rendered in four states (India CAS nothing chosen; joint valid 60/40; joint 60/30 with the amber "adds up to 90.00%" message; bank/AU with no percentages, SMSF offered and the entity-refusal reason). Regenerate with `node scripts/owner_selector_preview.mjs`. Markup/initial state only.

The CAS statement detail adds: "Filed under: <owner>", amber non-blocking owner warnings, and the folio-conflict panel with "Change these folios to <owner>". The bank panel adds the conflict prompt ("… Nothing has been uploaded. Keep the account as it is, or confirm …" with "Yes, change the account's owner and upload" / "No, go back").

## 10. Deliberately left for later phases

Payslip, liability, retirement, AU investment (the `fdh_financial_accounts` owner column already exists for liability; its upload still captures owner after upload), AIE intake routes (incl. the AIE bank intake which still passes no owner), PAN capture / PAN phase 2b, entity- and joint-aware editing on the Resolutions tab, per-folio splitting (decision 1), publishing entity/joint-owned positions into any consolidated view (decision 7 programme), updating the historical live-test scripts to send an owner, and the audit-event vocabulary (no new `fdh_document_audit_events` type was added to avoid widening the shared CHECK; the owner is in the existing `bank_csv_uploaded` event's metadata, and `user_correction` is reused for II owner changes).

## 11. Open PO decisions

1. **Apply 0236 + the backfill to DEV** (and when to production). Nothing here is live until then.
2. **Bank for Trust/HUF/Company.** Refused today (decision 7). Enabling it needs the read models taught to exclude entity-owned `owner_role` values from household totals first. Do you want that programme scoped next, or is "bank = personal + joint + SMSF" the permanent rule?
3. **Spouse for bank users with no spouse member.** Currently they add one inline. Alternative: allow a role-only "Spouse" for bank (the previous behaviour) at the cost of `owner_member_id` being NULL on those documents.
4. **Merge order with the owner-edit branch.** Joint (members) publication once-and-by-percentage and the entity "separate section" display come from `feat/owner-entity-joint-edit-resolutions-20261001`; this branch deliberately does not duplicate them. Merge that branch first or resolve the three hotspots in 2.7.
5. **Confirm-owner on CAS is per document.** It lists exactly the conflicted folios; if you would rather confirm per folio individually, that is a small UI change.

## 12. SEPARATE ITEM: bank "which account is this statement for?" (own commit)

**The problem (confirmed on production by the PO):** the upload could not tell which account a statement belonged to whenever the user already had an account in that currency and typed no digits (the panel never sends an institution, so every account of a currency is lumped together). The file had already been stored and a blocking `bank_*.account_identity_ambiguous` review item raised, and the panel showed a red error telling the user to retype digits and upload again, which fails again for anyone with more than one account.

**What replaces it** (`lib/financial-data-hub/services/bankAccountAssignment.ts`, `POST /api/financial-data-hub/bank-statements/:id/resolve-account`, `BankStatementImportPanel.tsx`):
1. **Read the statement locally and deterministically** (no AI, nothing leaves the server): the bank name and the **last 4-6 digits** of the account/card number, reusing the certified bank-PDF adapters (`bank-pdf/detection` + `extractPdfStatementMetadata`) and, for a CSV, the certified CSV adapter's bank name (a generic adapter names no bank, so nothing is claimed). Password-protected or unreadable files are simply not read.
2. **Auto only where deterministic:** printed digits match exactly one of the user's accounts -> assigned silently, panel says "Matched to your <bank> account ending 1234"; several match -> the bank name breaks the tie only if it singles out one, otherwise ask; digits match **none** -> a **prefilled confirmation** "We read this statement as <bank>, account ending 1234" with **[Add as a new account]** primary and "This is one of my existing accounts" (a lone existing account is deliberately NOT used here: a number that matches nothing may be a new account); nothing readable and exactly one account for the currency -> that account; otherwise the picker.
3. **Picker:** the user's accounts for that currency, friendly name + last 4 digits only, plus "A different / new account" with a 4-6 digit field (7+ digits refused, same rule as `normaliseMaskedIdentifier`).
4. **Assign the already-uploaded statement** (no re-upload) and continue straight into the existing password / scan / processing steps.
5. **Styling/phase:** its own phase `choose_account`, blue info styling, heading "One quick check so your statement goes to the right account"; the red "couldn't automatically match" text is gone. Only a real failure of the call uses the `error` phase.

**Route guarantees (each tested with a negative control, mutation-proved):** tenant isolation (another user's statement or account looks exactly like a missing one: 404); same currency (422); same institution; closed accounts refused; **idempotent** (same choice again = no-op success; a different account for an already-assigned statement = 409, never moved; a race is guarded by `.is('financial_account_id', null)`); the statement's owner never silently overwrites the account's owner (same 409 `account_owner_conflict` / confirm flow as the upload); the blocking review item is closed with how it was settled in `resolution_code` (resolved_by/resolved_at are the audit trail; no new `fdh_document_audit_events` type was added because that would widen the shared CHECK); a statement an earlier process attempt parked in `review_required` because its account was unresolved is returned to `queued` through the two declared transitions so it can be processed without re-upload; `new_account_name` is display-only and sanitised.

**Privacy:** only the trailing 3-6 digits ever leave the reader and only the user's own masked identifier (last 4-6 digits) is stored, on the account. Test: after suggestion + auto-match + new-account paths the digits appear in no console output, review item, audit row, AI-call table or statement row (control: they ARE on the new account, so the check is not vacuous); the reader returns the trailing 6 of a printed 16-digit number and never the number; the module has no AI client, no `fetch`, no `console`. A printed full number is never returned, stored, logged, put in a URL or an AI prompt. The digits travel in the POST **body**, not the URL.

**What I did not do, and why:** `institution_id` is **not** derived or set. An account's fingerprint includes `institution_id` and the upload step looks accounts up by the institution it was given (the panel sends none), so an account created *with* one would be invisible to the next upload and a duplicate would be created every time; FDH-1 also deliberately does not seed an institution master, so usually there is no row. Instead the bank name is the account's friendly display name and is used to tell accounts apart in the picker and to break digit ties. Setting `institution_id` properly needs the panel to send it at upload time (a separate change). CSV statements rarely print an account number, so for a CSV only the bank name is read and the digits path is the picker / "new account". Not exercised against a real statement PDF end to end (the adapter functions are the certified ones; the tests inject identity and mock the PDF library). Not run against DEV.
6. **Institution on bank accounts.** Make the Expenses panel send `institution_id` at upload (and seed/choose an institution master) so accounts are separated by bank in the database, not only by friendly name? Until then see section 12.
