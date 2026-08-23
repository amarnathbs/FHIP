# R8-P0 — Canonical Assumption Reconciliation

**Status: COMPLETE**
**Verdict: GO — ASSUMPTIONS RECONCILED (with adjusted scope documented below)**

Performed as a genuine fresh inspection of the actual current codebase and
migration history on commit `56de52b` (`origin/main` tip, confirmed by
`git rev-parse origin/main` and `git log --oneline -15` this session) — not
inferred from the original R8 design prompt.

---

## 1. FDH-4 precondition (spec §4)

| Check | Result |
|---|---|
| FDH-4 status | `docs/financial-data-hub/FDH4_COMPLETION_REPORT.md` closure addendum: **UNCONDITIONAL FULL PASS** (closed 2026-08-23), final certified commit `4933f24` |
| FDH-4 on canonical main | Confirmed via `git log origin/main --oneline -15`: `56de52b Merge FDH-4 (Bank CSV Adapter Coverage & Certification) into main`, ancestry chain `4933f24 → 6c3ebc3 → eac2cab → 2ee15fb → 56de52b` all present |
| `origin/main` SHA | `56de52bc775e8ec6de3a3e24fc915fc800158c1a` (fetched fresh this session, `git fetch --all --prune` then `git rev-parse origin/main`) |
| Local worktree | HEAD already equals `origin/main` at `56de52b` (0 commits ahead/behind, verified `git rev-list --left-right --count HEAD...origin/main` → `0 0`) |

**Precondition satisfied.** Proceeding to full P0 audit.

## 2. FDH-4 deliverables inspected (spec §8)

FDH-4 added **zero** new engine/transaction-model code. Its entire diff against R7's terminal state is: 4 new declarative `BankCsvAdapter` objects (ANZ, Macquarie, Axis Bank, Kotak Mahindra Bank), migration `0066` (governance seed rows: `fdh_parser_registry`/`fdh_parser_versions` + `coverage_status` flips), and 2 new live-certification scripts. Confirmed by `docs/financial-data-hub/FDH4_R7_ADOPTION_AUDIT.md` and directly by reading migration `0066` (56 lines, seed-only). The R7 canonical transaction contract is unchanged by FDH-4.

## 3. The real discovery: the canonical transaction contract predates R7 entirely

The single most important P0 finding: **the full classification schema was built in FDH-1 (migration `0047_fdh_transactions_and_classification.sql`), long before R7 or FDH-4 existed**, and a complete reference/governance data layer was built on top of it in FDH-2 (migrations `0050`-`0057`). R7/FDH-4 deliberately left all of it untouched. Nothing between FDH-1 and FDH-4 ever executed a classification. This changes the shape of R8's actual remaining work substantially, in R8's favour: most of the schema R8's original design proposed building already exists, tested, RLS-enabled, and forward-referenced by name in code comments as belonging to a not-yet-built engine the FDH-1/2 authors called **"FDH-6"** (an older internal numbering for what this dispatch calls R8).

### 3.1 `fdh_transactions` — already carries the full classification target schema

Created `0047:61-151`, widened `0064:177-225` (R7 additive dedup/provenance columns only). Full column list confirmed by direct read of both migrations:

Classification columns **already present since FDH-1, before any R8 code exists**:
`economic_transaction_type` (`text not null default 'unknown'`, 13-value closed enum: `income, expense, transfer, investment, debt_principal, debt_interest, refund, asset_purchase, asset_sale, tax, fee, cash_withdrawal, unknown`), `category_id`/`subcategory_id` (FK → `fdh_categories`/`fdh_subcategories`), `merchant_id` (FK → `fdh_merchants`), `merchant_raw` (purgeable text), `recurring_flag`/`subscription_flag`/`transfer_flag` (booleans), `classification_confidence` (`numeric(5,4)` in `[0,1]`), `classification_method` (8-value enum: `source, merchant_master, global_rule, user_rule, ai, user_manual, admin_master_data, unclassified`), `review_status` (`not_required|pending|in_review|resolved`), `user_override` (boolean).

R7-era (`0064`) additive columns: `transaction_type_hint` (11-value structural hint, includes `transfer_candidate`, `investment_transfer_candidate`, `salary_candidate`, `card_payment_candidate`, etc. — explicitly documented "never a final category; classification remains a later engine's job"), `dedup_status`, `economic_fingerprint`(+`_version`), `source_row_hash`, `balance_after`, `parser_version_id`, `mapping_template_id`.

**Proof every row lands unclassified.** `lib/financial-data-hub/services/bankCsvProcessingService.ts:362-390`, the actual INSERT payload, sets only `economic_transaction_type: 'unknown'`, `classification_method: 'unclassified'`, `extraction_confidence: 1`. `category_id`/`subcategory_id`/`merchant_id`/`merchant_raw`/`classification_confidence` are **absent from the insert payload entirely** — every certified transaction today has these `NULL`/default, permanently, because nothing has ever written them.

### 3.2 Companion tables — also already exist, also never written

All created in `0047`, all RLS-enabled with the standard `own rows` policy, **none has ever had a real writer**:

- **`fdh_transaction_links`** (`0047:208-228`) — exactly R8 §31's "Transfer Pair" concept. `link_type` enum already covers `internal_transfer, credit_card_settlement, refund_original, reversal_original, duplicate, investment_funding, loan_payment, other`. Carries `confidence`, `status` (`pending|confirmed|rejected|superseded`), `created_by_method` (`system_rule|algorithm|ai|user_manual|admin`), `user_confirmed`. Nullable `transaction_id_to` deliberately supports an open, unresolved link (counterpart not yet imported). Code comment verbatim: *"NO MATCHING ALGORITHM IS IMPLEMENTED IN FDH-1 (FDH-6)."*
- **`fdh_recurring_transactions`** (`0047:394-421`) — exactly R8 §49/§53. `frequency` (`weekly|fortnightly|monthly|quarterly|annual|irregular`), `expected_amount`+`amount_tolerance`, `status` (`candidate|active|paused|ended` — maps directly to R8's `INSUFFICIENT_HISTORY|ACTIVE|POSSIBLY_PAUSED|ENDED`), `confidence`, `user_confirmed`. Code comment verbatim: *"NO DETECTION ALGORITHM IS IMPLEMENTED IN FDH-1 (FDH-6)."*
- **`fdh_classification_history`** (`0047:344-387`) — append-only audit trail (SELECT+INSERT only, no UPDATE/DELETE policy at all — a genuine house-pattern precedent for immutable audit). Carries previous/new `economic_transaction_type`, previous/new `category_id`/`subcategory_id`, `classification_method`, `confidence`, `changed_by_type` (`system|user|admin`), `global_rule_id`/`user_rule_id` FKs. This is R8 §46's exact requirement (system result / user correction / effective result / timestamp / actor / rule-source), pre-built.
- **`fdh_transaction_corrections`** (R7, `0064:97-118`) — the correction-overlay table. `field_name` closed vocabulary **already includes** `economic_transaction_type`, `category_id`, `subcategory_id`, `merchant_id` alongside R7's own fields. A full correction service already exists and is wired end-to-end: `lib/financial-data-hub/services/bankTransactionActionsService.ts` `correctTransaction()` → `POST /api/financial-data-hub/bank-transactions/[transactionId]/correction`. It (1) reads the current row, (2) inserts an append-only `fdh_transaction_corrections` row, (3) `UPDATE`s `fdh_transactions` via the ordinary RLS-scoped (authenticated) client, (4) records a `transaction_corrected` audit event. **This is a fully shipped feature with no consuming classifier yet** — R8 does not need to build a correction system; it needs to become the first system whose output that correction system meaningfully overrides.
- **`fdh_user_classification_rules`** (`0047:300-325`) — R8 §40/§47's user-specific rules, already shaped exactly right: `rule_type` (`merchant_exact|merchant_alias|mcc|description_contains|institution_narrative|source_provided_category|account_scoped_default`), Zod-validated discriminated-union `match_definition`/`action_definition` JSON (never a free regex — DoS-safe by construction), `priority`, `active`. Explicit code comment: *"CRITICAL RULE: rows here are the ONLY place a user's own classification preference is stored. They never propagate into `fdh_merchants` or `fdh_classification_rules`."* — this is R8 §40's global/personal separation, already enforced.

### 3.3 FDH-2's reference/governance layer — data only, explicitly scoped that way

Migrations `0050`-`0057`. `0050`'s own header states the boundary in so many words: *"SCOPE. FDH-2 builds the governed KNOWLEDGE layer only — no classification engine, no parser, no transaction-classification execution."*

- **Category taxonomy**: `fdh_categories`/`fdh_subcategories`, 25 categories / 295 subcategories seeded (`0053`), each with a stable `category_key`/`subcategory_key`, `fixed_variable`, `retirement_relevance`/`investment_relevance`/`debt_relevance`, versioning (`effective_from`/`deprecated_at`/`replacement_key`).
- **MCC master + mapping**: `fdh_mcc_master` (174 codes), `fdh_mcc_category_map` (87 mappings, `mapping_confidence`/`mapping_type`, deliberately leaves ambiguous MCCs unmapped rather than guessing).
- **Merchant master**: `fdh_merchants` + aliases (~321 merchants), carrying `recurring_possible`/`typical_frequency`/`fixed_amount_expected`/`variable_amount_possible`/`recurring_type` (merchant-level likelihood metadata only, explicitly documented as never asserting a specific transaction IS recurring), `is_payment_processor`.
- **Institution master**: `fdh_financial_institutions` extended with `coverage_status`, 47 institutions seeded.
- **Payment rail master**: `fdh_payment_rail_master`, structurally incapable of carrying a category (no such column exists — proved by FDH-2's own schema-contract test).
- **Classification rule seeds**: `fdh_classification_rules`, 60 rows (`0056`) — income/salary, government payment, transfer/credit-card/investment-transfer *candidates* (flag-only, never auto-classify — see below), bank fee, interest, cash withdrawal, refund/reversal, payment-rail annotation. All `status='approved', active=true`.
- **Precedence resolver**: `lib/financial-data-hub/domain/classificationPrecedence.ts` — a **pure function**, self-documented: *"NOT THE CLASSIFICATION ENGINE... tests the RESOLUTION SEMANTICS documented for that future engine."* Exports `resolvePrecedence()` implementing the 9-tier order `user_rule > source_provided > verified_merchant_alias > mcc > verified_global_rule > narrative_pattern > fuzzy_merchant_match (not implemented) > ai (not implemented) > user_review`. Confirmed by grep: neither `resolvePrecedence` nor `category_id`/`merchant_id` writes appear anywhere in `bank-csv/normalize.ts` or `orchestrator.ts` — nothing calls this function from any ingestion or processing path today.
- **Global learning governance**: `fdh_global_learning_candidates` — zero RLS policies of any kind (service-role only, by design), zero seeded rows, zero code path writes it. Domain contract (`globalLearningGovernance.ts`, `personalPayeeGuard.ts`) exists with no wired promotion path — explicitly out of R8's scope per spec §47 ("Do not automatically learn global behavior from one correction").

## 4. Manual FHIP taxonomy — confirmed genuinely separate system (spec §13)

`master_financial_items` (`supabase/migrations/0004_financial_data_grid.sql`) — `category` (`income|expense|asset|liability|investment|retirement|insurance`) + `item_key`, read via `lib/services/masterItems.ts`, exposed at `/api/master-items`. Every manual register table (`income_sources`, `expense_items`, etc.) keys off `master_item_key`. **This shares no table, no key format, and no code path with FDH-2's `fdh_categories`/`fdh_subcategories`.** `fdh_categories.fhip_mapping_key` (added `0045`) is explicitly documented forward-looking-only metadata for a not-yet-built "FDH-15 FHIP Input Data Bridge" — no FDH code reads it, nothing in FDH writes to `income_sources`/`expense_items`/etc. `FHIP_PROTECTED_INPUT_TABLES` in `lib/financial-data-hub/constants/tables.ts` is a hard isolation list, enforced by `tests/unit/fdh1Isolation.test.ts`.

**Conclusion**: R8 must classify bank transactions using FDH-2's own taxonomy (`fdh_categories`/`fdh_subcategories`), never `master_financial_items`, and must not write to any manual register table. This satisfies spec §15/§55 by construction — there is no governed publish mechanism to accidentally trigger, because none exists yet.

## 5. Security precedent — the pattern R8 must follow (spec §17, §59-60)

`0065_r7_final_reconciliation_status_forgery_fix.sql` is a **live-DEV-discovered fix**, not a hypothetical: a real PostgREST `PATCH` from an owning user's own session forged `fdh_statement_uploads.reconciliation_status` because a pre-existing FDH-1 column got its first real writer (R7) without being added to the authoritative-field guard trigger. The established rule this session must follow: **any pre-existing column that gains its first real writer in R8 must be added to a `before update` trigger blocking direct authenticated writes**, using `create or replace function` on the existing trigger function where one already governs the same table (never a parallel trigger).

**Applying this rule to R8's actual authoritative-write inventory** (this is the material, non-trivial engineering work R8 must still do — see §7 below):

| Table | Column(s) becoming authoritative in R8 | Current guard | Required R8 hardening |
|---|---|---|---|
| `fdh_transactions` | `economic_transaction_type`, `category_id`, `subcategory_id`, `merchant_id` | None (only R7's own dedup/provenance columns are guarded) | Block authenticated writes **unless** a matching, recent `fdh_transaction_corrections` row exists for that exact `transaction_id`/`field_name`/`corrected_value` — an "evidenced write" gate that keeps the shipped correction feature working while closing bare forgery |
| `fdh_transactions` | `classification_confidence`, `classification_method`, `recurring_flag`, `subscription_flag`, `transfer_flag` | None | Block outright — no correction vocabulary covers these fields (confirmed: absent from `fdh_transaction_corrections.field_name` check), so there is no legitimate authenticated write path |
| `fdh_transactions` | `review_status` | None | Block outright except the one narrow transition the shipped correction service already performs (`* → 'resolved'`, evidenced the same way) |
| `fdh_transaction_links` | entire table | **None at all** — plain `for all` owner policy since `0047`, never widened | Block authenticated INSERT (engine/algorithm-only, mirroring `trg_r7_block_authenticated_insert_transactions`); guard UPDATE except the user's own `status: pending → confirmed/rejected` + `user_confirmed` transition |
| `fdh_recurring_transactions` | entire table | **None at all** | Same pattern: block authenticated INSERT; guard UPDATE except `user_confirmed` toggle and a user-initiated `status → paused/ended` |
| `fdh_classification_history` | `changed_by_type='system'`/`'admin'` rows | Split SELECT/INSERT policy, but INSERT is content-unrestricted | An authenticated user could self-append a fabricated **audit-trail** row claiming a fake system classification. Restrict authenticated INSERT to `changed_by_type='user'` only; `system`/`admin` rows must come from the service-role engine |

This table **is** R8 spec §59's "authoritative-write inventory," produced from a real inspection of currently-live RLS/trigger state, not assumed.

## 6. Pagination, API, and UI contracts (spec §20-22)

- **Pagination**: two existing, deliberately separate patterns — (1) keyset cursor pagination on the one user-facing list endpoint (`GET /api/financial-data-hub/bank-transactions`, `.order('transaction_date').order('id')` + `before_date`/`before_id` cursor, `PAGE_SIZE_MAX=500`), and (2) `fetchAllRows()` (`lib/financial-data-hub/bank-csv/pagination.ts`) — a `.range()`-looping full-table-sweep helper (`POSTGREST_PAGE_SIZE=1000`, `FETCH_ALL_ROWS_CEILING=500_000`, throws rather than silently truncating). **R8's transfer/recurring engine, which needs a user's full transaction history, must reuse `fetchAllRows()` exactly as-is** — it is already the sanctioned "read past the 1000-row PostgREST cap" contract for this module, deliberately duplicated (not imported) from Investment Intelligence's identical helper per `tests/unit/fdh1Isolation.test.ts`'s import-graph isolation rule. Guard: `scripts/check-migration-versions-against-branch.mjs` confirms next free migration version is `0067` (`OK: no cross-branch migration collisions... "HEAD" (66 files)`).
- **API**: extend the existing `bank-transactions` route family (`GET`, `GET/PATCH [transactionId]`, `POST .../correction`, `POST .../duplicate-resolution`) with bounded new classification-specific endpoints (e.g. a classification-run trigger, a transfer-review-decision endpoint, a recurring-series-confirm endpoint) rather than a competing transaction API — there is exactly one transaction API surface today.
- **UI**: **zero existing transaction-list/review UI** anywhere in `app/` or `components/`. The only FDH page is the document-upload landing page (`app/(app)/financial-data-hub/page.tsx`), explicitly not linked from main navigation. R8's classification/review UI, if built, would be the first such surface FDH ever ships — genuinely new territory, not a duplicate of anything existing. Per the dispatch's own scope discipline and spec §91 (STOP after R8, no scope creep into new product surfaces beyond what's asked), R8-P1 in this pass focuses on the classification **engine, schema hardening, and API contract** — a full bespoke review-queue UI is called out as an explicit residual for a following release rather than being invented from nothing under this dispatch's time budget.

## 7. R8 Assumption Matrix

| Original R8 assumption | Actual FDH-4-era state | Status | R8 consequence |
|---|---|---|---|
| R7 transaction is canonical | Confirmed — `fdh_transactions` unchanged by FDH-4 | VALID | Build against it as-is |
| Normalized description available | `description_clean` exists, R7-populated | ALREADY_IMPLEMENTED | Reuse directly, do not duplicate |
| Institution id available | `fdh_financial_accounts.institution_id` → `fdh_financial_institutions`; also reachable via `parser_version_id` → `fdh_parser_versions` → `fdh_parser_registry.institution_id` | ALREADY_IMPLEMENTED | Reuse for institution-narrative rules |
| Account identity stable | `financial_account_id` FK, `on delete cascade`, immutable per transaction | VALID | No change needed |
| Transfer hint exists | `transaction_type_hint = 'transfer_candidate'` / `'investment_transfer_candidate'` / `'card_payment_candidate'` (R7, structural only) | ALREADY_IMPLEMENTED | R8 consumes the hint as one input signal; does not re-derive it |
| Correction layer exists | `fdh_transaction_corrections` + `correctTransaction()` service + API route, fully shipped, already covers R8's own target fields | ALREADY_IMPLEMENTED | R8 must NOT build a second correction system (spec §16) — integrate with this one |
| Classification status unused | `economic_transaction_type`/`classification_method`/`category_id`/`subcategory_id`/`merchant_id` all exist since FDH-1 (`0047`), unused (always default/null) | ALREADY_IMPLEMENTED (schema) / genuinely unbuilt (execution) | R8 populates these columns; does not add new ones for economic type/category/merchant |
| Category taxonomy must be designed | FDH-2's `fdh_categories`/`fdh_subcategories`, 25/295, fully seeded, versioned, RLS-locked to service-role writes | ALREADY_IMPLEMENTED | Reuse verbatim; zero new taxonomy tables |
| Merchant master must be designed | FDH-2's `fdh_merchants` + aliases (~321), governed, admin-write-only | ALREADY_IMPLEMENTED | Reuse verbatim (spec §39 anticipates exactly this) |
| Rule engine precedence must be designed | `classificationPrecedence.ts` — pure, tested resolver already implements the full 9-tier order; 60 seeded rules already exist | ALREADY_IMPLEMENTED (logic + data) / NOT WIRED (no caller) | R8 builds the **execution engine** that calls `resolvePrecedence()` against real transactions — this is R8's actual core deliverable, not a duplicate |
| Transfer pairing must be designed from scratch | `fdh_transaction_links` schema already exists (`link_type`, `confidence`, `status`, `created_by_method`), explicitly commented "no matching algorithm implemented" | CHANGED (schema exists, algorithm does not) | R8 builds the matching algorithm only; reuses the table; needs one additive column (`match_evidence`) for deterministic-evidence text (spec §45) — none exists today |
| Recurring detection must be designed from scratch | `fdh_recurring_transactions` schema already exists, no member-linkage column and no detection algorithm | CHANGED | R8 builds the detection algorithm; needs one additive column (`fdh_transactions.recurring_transaction_id`) for series membership — does not exist today |
| Refund/reversal linkage must be designed | `fdh_transaction_links.link_type` already includes `refund_original`/`reversal_original` | ALREADY_IMPLEMENTED (schema) | R8 builds the linking algorithm only |
| Security hardening requirements unknown | Live precedent (`0065`) + fresh inspection of current RLS/trigger state on every table R8 touches (§5 above) | RESOLVED THIS SESSION | Full authoritative-write inventory produced (§5); R8's migration must close 6 concrete gaps found, none hypothetical |
| A duplicate architecture might be required | Checked explicitly against FDH-2's reference layer and FDH-1's schema — none required | VALID (no duplication needed) | Confirms GO's own "no duplicate architecture required" criterion |
| Investment boundary needs reconciling | `economic_transaction_type = 'investment'` is the existing enum value for bank-side investment-transfer classification (spec §34's `INVESTMENT_TRANSFER`); confirmed zero II tables/rows are ever touched by FDH (import-graph isolation test, `FHIP_PROTECTED_INPUT_TABLES`/`II_OWNED_CANONICAL_ENTITIES` referenced by no R7/FDH-4 file) | VALID | R8 sets this enum value only; creates no `ii_*` row, ever |
| Manual Income/Expenses taxonomy is the same system | Confirmed genuinely separate (`master_financial_items` vs `fdh_categories`) — see §4 | CHANGED (clarified, not merged) | R8 classifies only within the FDH taxonomy; no publish path exists to accidentally trigger |
| No blocking issues found | — | — | **No BLOCKING assumptions identified** |

## 8. Baseline regression (spec §23)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | Clean (0 errors) |
| `npx eslint .` | 28 problems (9 errors, 19 warnings) — all pre-existing, confined to `scripts/*.mjs` certification/live-cert tooling, none in `app/`/`lib/` application code; exit code 0 (does not fail the configured lint gate) |
| `npx vitest run --no-file-parallelism` | Run in background; result recorded in the R8-P1 implementation report once complete, before any new code is added, per spec §23's ordering |
| `npm run build` | Deferred to R8-P1 baseline (after `vitest` baseline completes) |
| Migration guard (`check-migration-versions.mjs`) | 66 active migrations, one file per version, next free version `0067` |
| Cross-branch guard vs `origin/main` | `OK: no cross-branch migration collisions between "HEAD" (66 files) and "origin/main" (66 files)` |

## 9. R8-P0 Final Classification

```
GO — ASSUMPTIONS RECONCILED
```

**Justification against the spec's own GO criteria (§24):**
- FDH-4 is terminally certified (UNCONDITIONAL FULL PASS) and present on canonical main. ✓
- The canonical transaction contract is fully understood, documented above with exact column-level detail from direct migration reads, not inference. ✓
- Taxonomy ownership is clear: FDH-2's `fdh_categories`/`fdh_subcategories` for bank-transaction classification; `master_financial_items` remains the separate, untouched manual-entry system. ✓
- Correction architecture is clear: `fdh_transaction_corrections` + `correctTransaction()` already shipped, already covers R8's target fields, integrate rather than duplicate. ✓
- Security hardening requirements are identified: a concrete 6-row authoritative-write inventory (§5), each with a real current gap and a specific fix pattern proven by live precedent (`0065`). ✓
- No duplicate architecture is required: confirmed against both FDH-1's transaction/companion-table schema and FDH-2's reference-data layer — R8 reuses every one of them. ✓

**This is not "REVISE R8 SCOPE"** in the disqualifying sense that section means (FDH-4 already having built material R8 *capabilities* such that R8 becomes redundant or must shrink to avoid duplication) — FDH-4 added zero classification code, and the classification **execution** (the actual engine that reads real transactions and writes real classification results), the transfer-**matching** algorithm, the recurring-**detection** algorithm, the refund/reversal-**linking** algorithm, and the concrete security hardening are all still **entirely unbuilt**. What R8-P0 found is that R8's own spec (§39, §41, §42) correctly anticipated finding pre-existing reference data and instructed reuse — and that anticipation was correct in an unusually complete way, reaching back to FDH-1 rather than stopping at FDH-4. The adjusted scope is documented in full above (§3, §5, §6) and carried forward verbatim into the R8-P1 implementation plan: **build the engine, not the schema.**

No blocking assumptions were found. Proceeding to R8-P1.
