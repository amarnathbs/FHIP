# Owner-before-upload -- FINAL COMPLETION report

Branch `feat/owner-before-upload-phase1-20261001`, HEAD merged with `origin/main` `bf5068c` (owner-edit branch `a669ba1`, premium grants, Net Worth NAV `0240`). Written 2026-10-02. Not pushed; nothing merged to `main`; nothing written to production; DEV was **not reachable unattended**, so **nothing was applied to DEV** -- every DEV / browser step below is a PO step.

## 1. The answer

**Did every applicable financial-document upload flow now obtain and preserve the correct economic owner before canonical processing?**

**YES -- in code, with unit / route / service / PGlite evidence.** Every flow that can create a canonical financial record now demands the owner *before the file is read*, validates it server-side against the caller's own household with one policy, stores it on the document (and, for AIE, on the intake), and carries it to the canonical record through the one canonical writer; a flow whose canonical model cannot yet keep an owner kind separate **refuses** that kind rather than guessing (entity-owned bank / payslip / liability / retirement / AU-investment documents). Nothing is claimed beyond that:

| Level | Status |
|---|---|
| **CODE COMPLETE** | **YES** -- all 13 matrix rows (see `OWNER_BEFORE_UPLOAD_FINAL_MATRIX.md`). |
| **DEV CERTIFIED** | **NO** -- migration `0236`, the backfill and the browser protocol (section 7) have **not** been run on DEV. Migration + backfill are PGlite-verified (real PostgreSQL engine); the routes are test-verified against an in-memory database. |
| **PRODUCTION SCHEMA READY** | **NO** -- `0236` is not applied anywhere. Production already has `0153` / `0154` (entity / joint allocation), which `0236` builds on. |
| **PRODUCTION CODE DEPLOYED** | **NO** -- the branch is unmerged and unpushed. |
| **PRODUCTION UPLOAD ENABLED** | **NO** -- `isFdhDocumentUploadEnabled()` is untouched (`git diff origin/main -- lib/financial-data-hub/constants/featureFlags.ts` is empty) and still fails closed. No flag was set or documented as set. |

## 2. What was delivered in this completion pass (commits, newest first; none pushed)

| Commit | Content |
|---|---|
| `71b0942` | merge of `origin/main` `bf5068c` (clean, no conflicts) |
| `5512b74` | PO-OBU-06 institution derived from the certified adapter code; malware-scan boundary on the bank identity reader |
| `286c618` | privacy tests, financial oracles; `owner_allocation` added to the purge-retained columns |
| `5bde2b4` | every stale certification / live script updated; owner-required negative controls; repository-wide guard test |
| `9d23ff6` | AIE intakes (fdh_bank, Investment Intelligence): owner required and re-validated; accept hands it to the canonical write |
| `06635e0` | merge of the owner-edit branch; ONE ownership model (one validator core, one allocation writer) |
| `a139939` | Phase 2: payslip, liability, retirement, AU investment, generic upload sessions |
| `ff8d43a`, `edba160` | bank-assignment security tests; cross-tenant matrix for every owner-capable route |
| `e713884` | per-folio CAS owner-conflict decisions (PO-OBU-05) |
| `dcdf70e` | read-only options + `POST /api/ownership/self` + inline "Add household member" (PO-OBU-03) |
| `7539931` | P1: identical-file lookups are user-scoped |
| earlier | Phase 1 foundation, India CAS, bank flows, "which account is this statement for?" (see `OWNER_BEFORE_UPLOAD_PHASE1_REPORT.md`) |

## 3. The six locked decisions

| # | Decision | Result |
|---|---|---|
| PO-OBU-01 | migration / backfill to DEV by the PO; re-scan numbers; backfill preview first, preserve `user_selected`, never invent Self, re-run = zero mutations | **0236 is mine and unmerged**; re-scan at finish (2026-10-02, all branches + worktrees): `0230` m11-7 branches, `0231` premium (merged), `0232` India MF + BENCH-1 branches, `0237`/`0238` premium branch, `0240` Net Worth NAV (**merged**), `0241` BENCH-1; `0233`-`0235` unused. **No merged migration uses 0236, so no rename.** Backfill proven in PGlite: ends in `ROLLBACK`, previews first, `user_selected` untouched, unknown owners marked `legacy_unset` never Self, **second run changes nothing** (PGlite section 8). 0236 now also adds `aie_document_intake.owner_selection` + `chk_aie_intake_owner_selection_object_0236` and `fdh_statement_uploads.owner_allocation`; 13 new `_0236` constraints; **55 PGlite checks, 0 failed** (incl. 6 named controls). **Not applied.** |
| PO-OBU-02 | Trust / HUF / Company bank statements refused; allowed = Self, Spouse / Partner, Joint household, SMSF (AU) | **Done and tested at four levels**: validator, both bank routes (no document row, no account row written), AIE intake, AIE accept (an entity stored on a bank intake is refused). Oracle O3. Deferred item recorded in section 8. |
| PO-OBU-03 | never restore a role-only "Spouse"; "Add household member" inline | **Done.** Bank / liability / retirement / payslip offer only real members; with no spouse the selector shows the add-member form, then selects the new member. `GET /api/ownership/options` is read-only (`force-dynamic`, `no-store`, no writes -- asserted); the Self member is created only by the explicit idempotent `POST /api/ownership/self`. |
| PO-OBU-04 | ONE ownership model, no duplicate validators / allocation writers | **Done.** Admission (`lib/ownership/validateOwnerSelection.ts`) keeps only the per-flow policy, SMSF, wire format and required-owner; who-may-be-owner (own rows, active, HUF India-only, joint exactly 10000 bp, no duplicate / zero / fractional share) is delegated to `ownerModel.validateOwnerSelection`. Every account owner write goes through `applyAccountOwnerChange` (`setAccountOwner` delegates; `loadAccountOwnership` is the only reader). Hotspots resolved in the merge: `documentProcessing.ts` (both rules compose), `recertifyPosition` / publication (main's `ownershipBlocksPersonalPublication`), `handleAssignOwner`, owner PATCH route, `publicationLogic`. A second merge of `bf5068c` was clean. |
| PO-OBU-05 | per-folio CAS owner-conflict UI | **Done** (`OwnerConflictPanel`): a checkbox per folio, optional Select all, explicit target owner, confirmation; unselected folios unchanged; audited. Tested: only the ticked accounts change, the target signature is re-checked, a stale target is refused. |
| PO-OBU-06 | proper `institution_id` design before general bank ingestion | **Design written and the narrow slice built**: `docs/ownership/INSTITUTION_ID_DESIGN.md`. The institution master already exists (`fdh_financial_institutions`, FDH-2, production-certified); the adapter `institutionCode` **is** its `institution_code`. The server now derives the institution from the certified adapter code (never free text, never invented); two banks / same currency / same last 4 stay two accounts; repeat uploads find their account; legacy institution-less accounts stay candidates and are never rewritten. The panel still sends no id (it cannot know one); the name + trailing-digits path remains the approved fallback. Found and fixed a real defect on the way: with `institution_id = NULL` for both banks, "add as a new account" silently reused the other bank's account by fingerprint. |

## 4. The P1 security check (done first)

Identical-file lookups were already user-scoped on the Phase 1 paths; the cross-user probes in `ownerBeforeUploadBank.test.ts` and `ownerBeforeUploadIi.test.ts` (commit `7539931`) prove that another user's bytes tell this user nothing (same outcome as "no such file"). The admin-client lookups in `bankOwnerAttribution` / `documentOwnerRequest` carry `.eq('user_id', userId)`, and removing it fails a named test.

## 5. Programme items (a)-(j)

| Item | Result | Evidence |
|---|---|---|
| (a) per-folio CAS conflict | done | `iiOwnerChangeRoutes` / `ownerBeforeUploadIi` per-folio group |
| (b) GET options read-only | done | `ownerBeforeUploadSelfAndOptions` (12) + privacy test (no write verb, no-store) |
| (c) Add household member flow | done | selector tests; `OwnerSelector` `data-testid="no-spouse-hint"` |
| (d) cross-tenant tests, EVERY owner-capable route | done | `ownerBeforeUploadCrossTenant` (9): non-enumerating, identical to a missing id; plus DB trigger in PGlite; AIE intake validated against the caller's own household |
| (e) bank account assignment security | done | `bankAccountAssignment.test.ts` **57 tests**: tenant scope, currency, no auto-guess, no silent move, one concurrent winner, owner never silently overwritten, 11 + 6 named mutation controls |
| (f) Phase 2 routes | done | see 5.1 |
| (g) stale certification scripts | done | see 5.2 |
| (h) privacy | done | see 5.3 |
| (i) parsing before a malware-scan boundary | **found one, fixed it** | see 5.4 |
| (j) financial oracles + LR-FI-1/2/3 | done | see 5.5 |

### 5.1 Phase 2 and the AIE routes (traced route by route)

- **Payslip** (`upload-sessions` -> `complete` -> `payslip/.../approve`): owner required to open the session; stored on the document; approve defaults to and is locked to the document's owner (a different one -> 409 `owner_differs_from_upload`).
- **Liability** (`liability-statement/upload`, `liability-proposals/.../apply`): owner required; the apply RPC takes the document's owner; a conflicting one is refused.
- **Retirement** (`retirement-statement/upload`, `.../account-match`): owner required; the matched `retirement_members` row must be the document's owner.
- **AU investment** (`investment-statement/upload`, `.../account-match`): owner required; joint needs percentages; the account takes it through the one canonical writer; an existing account with a *different* owner is a conflict, never overwritten.
- **Generic `upload-sessions`**: a document type that can have a financial effect needs an owner; `tax_document` / `other` do not (asserted).
- **AIE `fdh-bank/intake`**: owner required *before the body is read*, validated for the `bank` flow, stored on the intake; **accept** re-loads and re-validates it against the user's *current* household and passes it to `uploadBankPdf` (the same silent-re-own and identical-file-different-owner guards as the interactive upload); a conflict stops the commit as `owner_conflict`. Legacy intakes with no owner are refused at accept.
- **AIE `investment-intelligence/intake`**: owner required (a bare `owner_member_id` no longer counts); stored; at accept the stored owner is the only owner a canonical write may use (a caller-supplied member id may only *agree* with it); it is written to `ii_source_documents` as `user_selected` (entity / joint is **never** downgraded on a database without 0236 -- it fails closed). The unlock (`.../process`) step uses the stored owner, and `dispatch` no longer raises a blocking `owner_unresolved` for a *declared* Trust / Joint owner.
- **`/api/aie/intake` generic**: cannot write canonically (no adapter registered; accept refuses `unsupported_adapter`) -- unchanged and documented.
- No route bypasses ownership because AI is involved: the AI-fallback review for a CAS applies to an *existing* owner-bearing source document and no AI prompt / provider module imports ownership code (asserted).

### 5.2 Certification / live scripts

Grep inventory of every script that calls an owner-required route: **~35 call sites in ~30 files**. New shared helper `scripts/lib/syntheticOwner.mjs` (+ `.d.mts`) gives a fixture user a *valid synthetic owner* (Self / Spouse / Joint / SMSF) using only the app's own authenticated routes. `scripts/canonical_cert/lib/session.mjs` `api()` -- the single chokepoint of every `canonical_cert/**` script -- now injects it (Self by default; `owner: 'spouse' | 'joint' | 'smsf'`; the retired `owner_role=` query value is translated; `owner: null` sends none). Patched explicitly: `fdh4` (3 scripts), `fdh5`, `fdh6`, `fdh8`, `fdh11`, `fdh12`, `g5`, `lr1` (2), `r7final` (2), `aie1_final_live_dev_journeys`, `aie1_closure_production_ai_fallback_journey`, `aie1_p4_section15_...`, `nav1_r2_ui_journey_http`. New `scripts/canonical_cert/final/owner_required_negative_controls.mjs`: per route -- no owner, garbled owner, foreign member id, entity bank, **and the control** (same bank upload with a valid owner is accepted). A repository-wide guard test (`ownerBeforeUploadScripts.test.ts`, with its own negative control) fails if any script posts to an owner-required route without naming an owner. **Re-run status: none of these scripts could be run here** (they need a DEV session); they were syntax-checked (`node --check`) and type-checked (`tsc`), and the helper + injection logic are unit-tested. `eslint` on the touched scripts shows only the 40 pre-existing `no-explicit-any` errors in the two `aie1_*` journey files (identical count on the base version).

### 5.3 Privacy

- **Owner metadata survives the raw-file purge** for every flow: no purge patch (FDH `buildStatementUploadPurgePatch`, the FDH purge services, the II source-document purge, the AIE purge) names an owner column; `owner_allocation` was added to the FDH retained list; the only writer of `aie_document_intake.owner_selection` is the intake-time recorder.
- **No full account / PAN / card number** anywhere new: the wire format is strict (an extra `pan` / `accountNumber` key is refused, so it can never be stored); owner-conflict messages contain no long digit run; no owner module writes to a console; the identity reader returns at most the trailing 3-6 digits and the picker shows 4; stored digits are validated 4-6.
- **No owner data reaches an AI input** (no AI prompt / provider module imports ownership code).
- `ownerBeforeUploadPrivacy.test.ts` (13 tests): two in-file scanner negative controls (a seeded purge of an owner column; a seeded `console.log`) and three mutation controls (a purge patch nulling `owner_role`, the wire schema switched to `.passthrough()`, a `console.log` added to an owner module) -- each fails a named test.

### 5.4 Parsing before a malware-scan boundary (item i)

New code that reads stored bytes: **`readStatementIdentityFromStoredFile`** (bank "which account?" reader). It ran **without** the malware-admission check that every other FDH processing entry point runs. **Fixed**: it now calls `checkFdhDocumentMalwareAdmission` first (a blocked, timed-out, never-scanned, or `malware_*`-coded document is not downloaded or parsed). Test: four refused states fetch **zero** bytes; the clean one reaches storage (control); breaking the check fails the named test. The other new code paths read *rows*, not files (owner dialogs, account-match routes) or re-fetch AIE quarantine bytes after the existing AIE gate (accept). Uploads remain disabled in production; the real malware scan wiring is a separate programme.

### 5.5 Financial oracles (`ownerBeforeUploadOracles.test.ts`, 17 tests)

Each starts from the owner a user chose *before uploading* (the real validator), carries it through document columns -> document owner -> account ownership -> the owner-class report. Hand-written figures:
- **Joint 1,000,000 at 60 / 40** -> 600,000 / 400,000; household total 1,000,000, **never 2,000,000**; no personal row carries any of it.
- **Company-held 1,000,000 at 50%** -> the macro (Net Worth) entity line carries **500,000**; the personal investments register adds **nothing** for it; the 1,000,000 appears only inside the company's own class; no row is a 1,500,000 sum.
- **Company / Trust / HUF bank owner** refused (control: all three accepted for a CAS).
- **SMSF expense 1,000**: changes SMSF cash flow by exactly 1,000 a month **and** leaves personal Expenses at 0 (counted as excluded); control: the same 1,000 on a Self statement is a personal expense. **Honest limit:** today SMSF cash flow is computed from the SMSF's *planned* income / expense rows; a *bank statement* owned by the SMSF is correctly excluded from personal Expenses but does **not yet feed the SMSF cash-flow view** (deferred, section 8).
- **LR-FI-1 / 2 / 3** (`smsfHouseholdIsolation`, `lrFi2DebtServiceExactlyOnce`, `lrFi2HouseholdDebtRatios`, `lrFi3NetWorthContributionExactlyOnce`, `lr12rSmsfPropertyLoanLinkOverride`, `businessEntityValuation`): **re-run, all pass** on the merged tree.
- **Mutation proof**: 9 of 10 single-site mutations each failed a named assertion (attribution double count, macro double count, publication block removed, ownership % ignored, SMSF treated as household, purge nulling an owner, `.passthrough()`, a logging call, the harness no longer injecting an owner). The 10th (admit entities on the bank flow by breaking only one of its two guards) was correctly *not* caught, because the bank flow is guarded twice (`allowedKinds` and `allowedEntityTypes`); breaking **both** fails 5 named tests.

## 6. Evidence

- **Targeted run on the merged tree** (`--testTimeout=90000`; FDH bank / approval / isolation, AIE, M12A, payslip, liability, retirement, AU investment, read models, LR-FI / LR-12R / SMSF, migration versions, schema contracts, PC5 / II processing / publication / Net Worth, capability manifests, canonical 0207, business entity, G3, audit-event suites): **369 files passed, 2 failed; 6,631 tests passed, 4 failed.** After the final accept / atomic-import fix, `fdh1Isolation`, `aieReviewAccept`, `aieOwnerBeforeUpload*` re-ran green (104 tests).
- **The 2 failing files are not caused by this branch:**
  1. `aie1MalwareScanSweepSchedulerPglite.test.ts` (3 tests): `origin/main`'s own migration `0229_dev_cron_sweep_jobs_explicitly_disabled.sql` unschedules the cron jobs the test expects. **Proven:** with only `0229` moved aside the test passes (4/4); it also passes on a checkout without 0228 / 0229. Needs a main-side fix (test or migration).
  2. `fdh1Isolation` "imported by nothing outside itself" -- failed once because I had imported an FDH service from `lib/aie/review/accept.ts`; fixed (the owner conversion moved into the already-approved `atomicImport`) and now passes (it is also timing-sensitive under load: 20 s budget).
- **tsc**: clean on every file touched; the only error in the workspace is the pre-existing `tests/unit/canonicalCertResidueAllSql.test.ts(127,75)` (a file I did not touch).
- **eslint**: clean on all `lib/`, `app/`, `components/` and `tests/` files touched; see 5.2 for the two legacy journey scripts.
- **New / changed tests this pass:** `aieOwnerBeforeUpload` (30) + `aieOwnerBeforeUploadRoutes` (6) + `ownerBeforeUploadPrivacy` (13) + `ownerBeforeUploadOracles` (17) + `ownerBeforeUploadScripts` (11) + 8 institution + 1 malware-boundary in `bankAccountAssignment`; the 13 owner / bank / AIE files total **305 tests**. PGlite: **55 checks**.
- Test runs rewrite checked-in artifacts under `scripts/`; they were reverted with `git checkout -- scripts/ii-r5-certification scripts/ii-r6p1-certification scripts/m12a-fdh-bank-certification` before each commit.

## 7. PO action list (DEV only), in order -- NOTHING below has been done

**A. Apply the schema (DEV, vqycarelcoijzwlpkpcz)**
1. Confirm DEV already has `0153` (allocation), `0207` (`fdh_financial_accounts.owner_role`) and the AIE migrations (`aie_document_intake`). `0236` guards on the tables it extends and refuses otherwise.
2. Re-scan migration numbers one last time (`git log --all -- supabase/migrations` + all worktrees). `0236` is renamed **only** if a *merged* migration took it -- and only **before** the first DEV application.
3. SQL editor: run `supabase/migrations/0236_owner_before_upload_phase1.sql` once.
4. **Idempotency check:** run it a **second** time -- it must raise no error and change nothing. Then verify: `select conrelid::regclass, conname from pg_constraint where conname like '%\_0236' order by 1,2;` -> **13 rows** (6 on `fdh_statement_uploads`, 6 on `ii_source_documents`, 1 on `aie_document_intake`); `select column_name from information_schema.columns where table_name = 'aie_document_intake' and column_name = 'owner_selection';` -> 1 row; the two `trg_*_owner_0236` triggers exist.
5. **Backfill preview:** run `docs/ownership/owner_before_upload_phase1_backfill.sql` **as shipped** (ends in `ROLLBACK`). Read the preview counts and the verification rows. Check: no row says it will become Self; unknown owners are `legacy_unset`; nothing `user_selected` is touched.
6. **Backfill execute:** change the last line to `COMMIT`, run again, keep the output.
7. **Re-run = zero mutations:** run it a third time as shipped (`ROLLBACK`); every "will copy / will be marked" preview count must now be **0**.
8. Deploy the branch to the DEV app only (the existing DEV upload flag and allowed-project setting; **do not enable production**). AIE flows additionally need the AIE adapter / intake / canonical-acceptance flags for DEV.
9. Run `node scripts/canonical_cert/final/owner_required_negative_controls.mjs --email <fixture user> --port <localhost port>` (after `signin.mjs`); it must print all PASS and write `.canonical-cert/owner_required_negative_controls.json`. Then re-run the updated certification scripts you care about (they now send a synthetic Self owner).
10. Clean up with the harness's `residue.mjs`.

**B. Live-DEV browser certification protocol** (signed-in fixture user, DEV; capture a screenshot and the row ids per step; PASS only if both the screen and the database agree)

| # | Step | Expected |
|---|---|---|
| 1 | India user, Investments upload: choose **Self**, upload the CAS fixture (`lib/fixtures/investment-intelligence/pc3-cams/pc3-q01-...pdf`) | upload blocked until an owner is chosen; after: "Filed under: Self"; folios' accounts owned by Self; `ii_source_documents.owner_selection_source = 'user_selected'` |
| 2 | Same file, owner **Spouse** | 409 naming Self; nothing new stored |
| 3 | New file, **Joint 60 / 40** (Self / Spouse) | split must total 100%; accounts get an active allocation group 6000 / 4000; owner-class report: one joint class, attribution 60 / 40, macro line counts once |
| 4 | **Company**, then **Family trust** | entity class; position **absent** from personal Investments / Net Worth; macro line shows ownership-% share |
| 5 | **HUF** as an India user; then as an AU user | allowed for India; refused for AU (403 `owner_not_allowed_for_country`) |
| 6 | Owner conflict: upload a CAS under Self for a folio already filed under Spouse | non-blocking conflict panel; **per-folio** checkboxes + Select all; tick one folio -> only that folio changes; untick the rest unchanged; confirmation; audit row |
| 7 | Bank CSV (`tests/fixtures/r7-bank-csv/au_cba_debit_credit.csv`), owner **Self**; repeat as **Spouse** (add a spouse member inline if none), **Joint**, **SMSF** (AU user) | each accepted; document + account owner as chosen; **Trust / Company / HUF not offered**; Joint shows no percentage box |
| 8 | Account picker: two accounts same bank / same last digits; upload a statement | no `error` phase; prefilled "add as a new account" or the picker; never silently guessed; a second bank with the same last 4 becomes a **separate** account |
| 9 | Existing account owned by Self, upload as SMSF | conflict prompt ("Nothing has been uploaded..."); "No, go back" stores nothing; "Yes, change" changes the owner |
| 10 | Same bank file twice under different owners | second is rejected, naming the first owner; same owner = flagged duplicate |
| 11 | Amendment: change an account's owner from the owner dialog (entity / joint) | writes a new allocation group (old one superseded), audit event, report updates |
| 12 | Reload / reprocess a statement | owner unchanged; no new conflict; no duplicate allocation |
| 13 | Raw-file purge (DEV scheduler or manual) | file gone, **owner columns intact** |
| 14 | Phase 2: payslip (Self / Spouse), liability (card + loan; Joint, SMSF), retirement (Self / Spouse), AU investment (Self / Joint 50 / 50) | owner required first; wrong owner at approve / apply -> 409; retirement statement lands on the right member |
| 15 | AIE (flags on): bank PDF and CAS intake with an owner; then accept | intake without an owner -> 422; accept uses the stored owner; a pre-change intake is refused with the re-upload message |
| 16 | Cross-tenant: a second fixture user posts the first user's member / entity id | `owner_not_found`, identical to a missing id |

**C. Decisions only the PO can take** -- see section 9.

## 8. Deferred items (recorded, not built)

1. **ENTITY BANK CASH-FLOW SEPARATION** -- Trust / HUF / Company-owned **bank statements stay refused** (PO-OBU-02). To allow them, the read models (Expenses, Income, Monthly cash flow, the dashboard, Net Worth bank balances) must first learn that `fdh_financial_accounts.owner_role` values `family_trust` / `company` / `other` are **not** household (today `isHouseholdOwner` excludes only `smsf`), `fdh_financial_accounts.owner_role`'s check (0207) must admit them, and the entity needs its own cash-flow view. Until then the refusal must not be weakened to make a test pass.
2. **SMSF bank-ledger cash flow** -- an SMSF-owned bank statement is excluded from personal Expenses (tested) but does not yet feed the SMSF cash-flow view, which is built from planned rows.
3. **A bank "Which bank?" picker** over the institution master (sending a canonical `institution_id` from the client) and a **user-confirmed legacy reconciliation** ("this account is HDFC Bank") that recomputes the fingerprint -- design in `INSTITUTION_ID_DESIGN.md`.
4. **Bank joint percentages** (counts 100% to the household today) and **per-folio splitting inside one folio**.
5. **AIE bank account picker** (an AIE bank commit with several candidate accounts still ends `account_ambiguous`; the interactive upload has the picker).
6. **Document owner amendment for bank / payslip** (delete and re-upload today).
7. Insurance AIE keeps its own `ownerHouseholdRole`; unifying it with this model was out of scope.

## 9. What the PO must do and decide

**Do:** run section 7 on DEV in order; then decide when (and whether) to merge and when to apply `0236` + backfill to production.
**Decide:**
1. Merge order / timing -- `0236` sits **below** the already-merged `0240` (they are independent; apply in numeric order).
2. Is "bank = Self / Spouse / Joint / SMSF" the permanent rule, or do you want the **ENTITY BANK CASH-FLOW SEPARATION** programme scoped next?
3. Accept the **legacy-AIE-intake refusal** (re-upload with an owner) or want a one-off backfill for any in-flight pilot intakes.
4. Whether to add the institution picker (item 3 above) before general bank ingestion is switched on.
5. Fix the main-side `aie1MalwareScanSweepSchedulerPglite` test vs `0229` (not part of this work).
