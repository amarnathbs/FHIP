# FDH-12 — Reuse & Gap Audit

**Mandatory pre-implementation artefact (spec sections 4, 5, 6).** Nothing in
FDH-12 was implemented before this audit was complete.

Repository: `D:/fhip-fdh12`, branch `feature/fdh12-retirement-statement-intelligence`,
cut from `origin/main` @ `9e3cdec` (the FDH-11 merge commit).

---

## 0. Headline finding — the single fact that shapes the whole module

**Canonical Retirement in FHIP is a SUMMARY-BALANCE register. It has no event
ledger, no transaction substrate, and no contribution history of any kind.**

A repository-wide search of `supabase/migrations/` returns **zero** hits for
`rollover`. `withdrawal` appears only as a *forecast output* column
(`forecast_results.withdrawals`, migration 0013), a *forecast assumption*
(`withdrawal_rate`, 0014) and a *goal* contribution type (0009) — never as a
recorded retirement event. There is no `retirement_transactions`,
`retirement_contributions`, `retirement_events` or equivalent table anywhere.

Canonical Retirement is, in its entirety:

| Table | What it holds |
| --- | --- |
| `retirement_accounts` | one row per account; `current_balance numeric(18,2)` **stored directly**, plus two annualised contribution *rate* columns (`employer_contribution`, `personal_contribution`) and `contribution_frequency` |
| `retirement_members` | one row per Self/Spouse; `target_retirement_age`, `age_source` |
| `smsf_funds` / `smsf_fund_members` / `smsf_holdings` | the AU-only SMSF extension, 1:1 with a `retirement_accounts` row keyed `master_item_key='smsf'` |

This is decisive for **spec sections 58, 59 and 60**:

- Spec 58 asks whether balance is a direct canonical field or derives from
  transactions. **It is a direct canonical field.** Safe update is therefore
  permitted, and is in fact the *only* possible canonical application method.
- Spec 59's event-ledger prohibition does not bind, because there is no event
  ledger to import into. FDH-12 imports **no** activities into canonical
  Retirement.
- Spec 60's double-apply hazard ("import +$10,000 contribution AND increase
  balance separately by +$10,000 → $120,000") is therefore closed
  **structurally, not by convention**: there is exactly one canonical write
  path (a field patch on `retirement_accounts`), and statement activities have
  no canonical destination at all. The harness still tests for it (spec 60
  requires the harness detect it), but the schema makes it unreachable.

The corollary, which FDH-12 states plainly in its UI and docs: statement
activities (contributions, fees, insurance premiums, tax, rollovers,
withdrawals, earnings) are **evidence**. They are reconciled, displayed and
retained; they are never posted anywhere.

---

## 1. Classification table

Vocabulary as required by spec section 5.

### 1.1 Retirement capabilities

| Capability | Classification | Detail |
| --- | --- | --- |
| Canonical retirement account register (`retirement_accounts`) | **REUSE AS-IS** | FDH-12 never creates a parallel account table. |
| `retirement_accounts.current_balance` | **REUSE AS-IS** (write target) | The one canonical value FDH-12 may propose. Written only via `fdh12_apply_retirement_proposal()`. |
| `retirement_accounts.employer_contribution` / `personal_contribution` / `contribution_frequency` | **REUSE AS-IS** (write target, confirmation-gated) | Existing columns, currently written by nothing in FDH. Proposed with `requires_confirmation = true` because they feed the forecast. |
| `retirement_members` (Self/Spouse) | **REUSE AS-IS** | FDH-12 attaches statements to an existing member row; it never creates a member and never invents a member concept. |
| `retirement_members.target_retirement_age` | **REUSE AS-IS, READ-ONLY** | Spec 61/113. Not in the apply allow-list. Not in the RPC's `v_allowed`. Two independent refusals. |
| `retirement_accounts.target_retirement_age` (legacy per-account) | **REUSE AS-IS, READ-ONLY** | Same treatment. Excluded from the allow-list by name. |
| Retirement projections / forecasting (`lib/engines/forecast/retirementCalculator.ts`) | **REUSE AS-IS** | Regression-tested only. FDH-12 changes no formula, no assumption, no methodology (spec 62, 63). |
| Net-worth aggregation (`lib/engines/dashboard.ts:582`) | **REUSE AS-IS** | Untouched. Retirement continues to enter net worth exactly once, as `sum(current_balance)`. |
| Retirement goal relationships (`goal_funding_sources.linked_retirement_id`) | **REUSE AS-IS** | Untouched (spec 160). |
| Retirement UI page (`app/(app)/retirement/page.tsx`) | **EXTEND** | Two CTAs added above the existing grid: Add/Update Manually (existing behaviour) and Import Retirement Statement (spec 146). No existing affordance removed. |
| `retirement_accounts.source_type` | **EXTEND** | CHECK widened from `('manual','investment_intelligence_published')` to include `'retirement_statement_import'`. Additive. |
| `retirement_accounts.last_import_application_id` / `last_imported_at` | **NEW (provenance columns)** | Exactly mirrors `income_sources` (0091 Part C) and `liabilities` (0096). |

### 1.2 SMSF

| Capability | Classification | Detail |
| --- | --- | --- |
| SMSF fund register, holdings, members, mode switching | **SMSF-OWNED** | FDH-12 writes nothing here and creates no SMSF row. |
| SMSF net-worth contribution | **SMSF-OWNED** | Untouched. |
| SMSF *detection from statement text* | **NEW FDH-12 EVIDENCE CAPABILITY** | No SMSF detection existed anywhere in the repo (verified: `self.managed` / `trustee` return only UI copy and unrelated comments). FDH-12 adds a detector that classifies a statement as SMSF and **routes it away**, never into ordinary super. |
| Preventing an FDH-12 import from touching an SMSF row | **REUSE AS-IS (already enforced by the DB)** | Migration 0090's `retirement_accounts_smsf_balance_guard()` raises `42501` on any `current_balance` write to an SMSF-linked row outside the `fhip.smsf_balance_write='certified'` window. FDH-12 adds its own explicit, friendly refusal *on top of* that, so the user gets a routing message rather than a raw Postgres error. |

### 1.3 Investment Intelligence

| Capability | Classification | Detail |
| --- | --- | --- |
| Ordinary personal investments (`investments`, `ii_*`) | **INVESTMENT-INTELLIGENCE-OWNED** | FDH-12 writes nothing. |
| Investment holdings shown *inside* a super statement | **NEW FDH-12 EVIDENCE CAPABILITY (terminal)** | Stored in `fdh_retirement_statement_positions`. **There is no apply path for a position row at all** — no RPC, no service, no allow-list entry, no canonical destination column. Spec 12, 13, 40, 71 are satisfied structurally. |

### 1.4 Financial Data Hub infrastructure

| Capability | Classification | Detail |
| --- | --- | --- |
| FDH-3 document lifecycle (`fdh_statement_uploads`, `fdh-source-documents` bucket, `uploadLifecycle.ts`, `storage.ts`, `purge.ts`) | **REUSE AS-IS** | Spec 91. No new document store. `document_type` already permits `'super_statement'`, `'epf_statement'`, `'nps_statement'` (0046) — no widening needed. |
| Byte-hash duplicate detection (`fdh_statement_uploads.file_hash`, `duplicate_of_document_id`) | **REUSE AS-IS** | Spec 51. |
| Transient PDF password handling (`bank-pdf/password.ts`) | **REUSE AS-IS** | Spec 92. Never stored, never logged. |
| PostgREST pagination (`fetchAllRows`, `lib/financial-data-hub/bank-csv/pagination.ts`) | **REUSE AS-IS** | Spec 139. |
| CSV intake / delimiter / header detection / adapter scoring (`bank-csv/`) | **REUSE AS-IS** | Spec 84. |
| PDF native-text extraction (FDH-5, `bank-pdf/`) | **REUSE AS-IS** | |
| `fdh_document_audit_events` | **EXTEND** | 9 new FDH-12 event types added to the CHECK and to the TS enum, following the `_R7_ADDED` / `_FDH9_ADDED` / `_FDH11_ADDED` precedent exactly. |
| FDH-6 economic classification | **OUT OF SCOPE** | No FDH-12 evidence row is ever classified as a household expense or income (see §3). |
| FDH-7 review/approval workflow vocabulary | **REUSE AS-IS** | `review_status` / `approval_status` values reused verbatim. |
| FDH-8 Expense Tracker | **OUT OF SCOPE (regression only)** | FDH-12 writes nothing to expenses. Spec 75 is certified by proving zero write paths exist. |
| FDH-9 payslip employer-super evidence (`fdh_payroll_events.employer_retirement_contribution`) | **REUSE AS-IS (read-only)** | FDH-12 reads it to reconcile. It writes nothing back. |
| FDH-10 liability statement pipeline | **REUSE (pattern only)** | Its `fdh10_apply_liability_proposal()` RPC is the template for `fdh12_apply_retirement_proposal()`. |
| FDH-11 investment statement pipeline | **REUSE (pattern only)** | Its 3-table evidence schema, ownership-guard triggers and authoritative-write triggers are the template for FDH-12's. |
| Generic import bridge (`fhip_import_proposals` / `_fields` / `_applications`, `lib/import-bridge/`) | **EXTEND** | See §2 — this is the spec-104 decision. |

### 1.5 Genuine gaps found

| Gap | Classification | Where it belongs |
| --- | --- | --- |
| `uq_retirement_accounts_user_master unique (user_id, master_item_key)` structurally prevents Self **and** Spouse each holding their own catalogue-keyed account (e.g. two `industry_super` rows) | **RETIREMENT MODULE GAP** | Recorded in §4. FDH-12 works within it (see §4 for the mechanism) and does not alter the constraint. |
| Canonical Retirement has no home for fees, taxes, insurance premiums, rollovers, withdrawals or contribution history | **RETIREMENT MODULE GAP** (deliberate design, not a defect) | Recorded in §4. FDH-12 retains all of it as evidence and reports the gap rather than inventing tables in the Retirement module's name. |
| `retirement_accounts.account_type` has **no DB CHECK** and holds two incompatible vocabularies (the Zod enum `super/EPF/PPF/NPS/other` vs lowercase catalogue keys written by migrations 0073/0084) | **RETIREMENT MODULE GAP** | Recorded in §4. FDH-12 keys off `master_item_key` and its own `account_type` evidence field, never off this column, and writes it only on ADD NEW using the Zod vocabulary. |
| India NPS Tier I/II and its contribution structure not modelled | **RETIREMENT MODULE GAP** | Already disclosed by migration 0100's own header. Carried into `FDH12_INDIA_RETIREMENT_GAP_REGISTER.md`. |

---

## 2. Spec section 104 — the generic-bridge decision

**Audited.** `lib/import-bridge/` implements a domain-agnostic
Preview → Compare → User Approval → Apply contract over three tables created by
migration 0091: `fhip_import_proposals`, `fhip_import_proposal_fields`,
`fhip_import_applications`.

**Finding.** `IMPORT_TARGET_DOMAINS` already contains `'retirement'` and
`IMPORT_SOURCE_KINDS` already contains `'retirement_statement'`
(`lib/import-bridge/types.ts:29-41`), and both values are already permitted by
the DB CHECK constraints on `fhip_import_proposals.target_domain` /
`.source_kind` and `fhip_import_applications.target_domain`. The reservation
was made deliberately in 0091 and has been sitting unused since. What is
missing is only: an entry in `supabaseStore.ts`'s `DOMAIN_TABLES`, a
`source_retirement_statement_id` provenance column, a typed adapter, and an
apply RPC.

**Decision: EXTEND the generic bridge.** Reasons, in order of weight:

1. **The shape fits exactly.** Canonical Retirement apply is a *single-row
   field patch* (§0) — precisely what the generic bridge was built for, and
   precisely what FDH-11 could *not* use (its apply is a ledger append, which
   is why FDH-11 built a bespoke typed service instead and documented that
   departure). FDH-12 is the FDH-9/FDH-10 shape, not the FDH-11 shape.
2. **It supplies four spec requirements for free**, already certified:
   `existing_value` staleness oracle (spec 108), `unique (proposal_id)` on
   `fhip_import_applications` (spec 106), compare-and-swap proposal claim
   (spec 107), and per-field selection (spec 109).
3. **Never unrestricted dynamic table writes** (spec 104's prohibition). The
   allow-list is asserted in three independent places: the adapter's
   `applicableFields`, the RPC's `v_allowed` constant array, and the RPC's
   hard-coded `case` mapping for staleness reads. A field absent from any of
   them cannot be written.

**Rejected alternative:** a retirement-specific bespoke service in the FDH-11
style. Rejected because it would re-implement staleness, idempotency and
concurrency control that already exist and are already certified, for a domain
whose canonical model is a plain row.

**Guard mechanism (the FDH-11 audit's "pick deliberately" point).** Because
FDH-12's apply is a `SECURITY DEFINER` RPC, FDH-12 uses the **FDH-9/FDH-10 GUC
guard** (`current_setting('fhip.import_bridge_internal_write')`), not FDH-11's
`auth.role()` guard — the GUC guard is the one that works when the write is
made by a definer function rather than by a service-role client. FDH-12's own
three evidence tables, whose writes come from a service-role processing
service, use the FDH-11 `auth.role()` guard. Both mechanisms are present, each
where it is correct.

---

## 3. Spec section 6 — the eighteen critical discovery questions, answered

**1. What is the canonical retirement account table?**
`retirement_accounts` (created `supabase/migrations/0003_module2.sql:71`,
extended by 0004, 0042, 0072, 0097). `retirement_members`
(`0072_air_consolidation_schema_foundation.sql:125`) is the canonical
per-member table. `smsf_funds` / `smsf_fund_members` / `smsf_holdings`
(`0084_geo_jurisdiction_smsf.sql`) are the SMSF extension.

**2. Is retirement balance stored directly or derived?**
**Stored directly** — `retirement_accounts.current_balance numeric(18,2)`.
`lib/engines/dashboard.ts:582` sums that column and nothing else. The single
exception is an SMSF row, where `current_balance` is derived from
`smsf_funds` and is DB-guarded by migration 0090.

**3. How are Self and Spouse represented?**
Three layers. Canonically: `retirement_members.member_type` ∈ `('self','spouse')`
with `unique (user_id, member_type)`. Legacy per-account:
`retirement_accounts.owner` ∈ `('self','spouse','joint','child','family_trust','company','smsf','other')`.
Link: `retirement_accounts.retirement_member_id` (nullable FK, N:1). Whether
Spouse exists at all is derived from `households.household_type` via
`normalizeHouseholdType()` and enforced server-side at
`app/api/retirement/members/route.ts:41-46`.

**4. How are multiple retirement accounts represented?**
1:N per user; N:1 per member. **Subject to a real constraint**:
`uq_retirement_accounts_user_master unique (user_id, master_item_key)` allows
at most one row per catalogue key per *user* — so Self and Spouse cannot both
hold an `industry_super` row. Custom rows (`master_item_key IS NULL`) are
unconstrained, because Postgres never matches NULL to NULL. See §4.

**5. How are employer contributions represented?**
`retirement_accounts.employer_contribution numeric(18,2)` — an annualised
**rate**, not a balance, read together with `contribution_frequency`
(`lib/services/forecastData.ts:512-524`). Separately, FDH-9 holds per-payslip
employer super as evidence in
`fdh_payroll_events.employer_retirement_contribution`, which writes to nothing.

**6. How are personal contributions represented?**
`retirement_accounts.personal_contribution`, same rate semantics.

**7. How are rollovers represented?** **They are not.** Zero occurrences in the
schema. FDH-12 retains rollover evidence and proposes the resulting *balances*;
it never posts a rollover anywhere.

**8. How are retirement withdrawals represented?** **They are not**, other than
as forecast *projections*. Same treatment as rollovers.

**9. How does Retirement feed net worth?**
`lib/engines/dashboard.ts:582-584` —
`totalRetirement = Σ reportingValue(currency, current_balance)`, then
`netWorth = totalAssets + totalInvestments + totalRetirement - totalLiabilities`.
`totalAssets` is deliberately exclusive of retirement.
`lib/services/dashboardData.ts:79-83` supplies the rows, filtered only on
`is_active = true`.

**10. Does Retirement already store fees/taxes?** **No.** No fee, tax, premium
or insurance column exists on any retirement or SMSF table. `forecast_results.fees`
is a forecast output, and the retirement calculator never populates it.

**11. Does Retirement already support AU + India account types?** Yes, at the
catalogue layer. `master_financial_items` category `retirement` carries 17 AU
items (`industry_super`, `retail_super`, `smsf`, `defined_benefit`,
`account_based_pension`, `allocated_pension`, `transition_to_retirement`,
`annuity`, `overseas_pension`, …) plus 3 India items added by
`0100_app_review_tier2_india_retirement_catalogue.sql`: `epf`, `ppf`, `nps`.
Zod additionally accepts `account_type ∈ ('super','EPF','PPF','NPS','other')`.

**12. Does Retirement already distinguish super / pension / EPF / NPS?** At the
catalogue level yes; at the *behaviour* level **no** — every one of them is
just a `current_balance` that gets summed. There is no pension-phase logic, no
EPF interest model, no NPS tier model.

**13. How is SMSF segregated?** By `master_item_key = 'smsf'` on the
`retirement_accounts` row, with a 1:1 `smsf_funds` row enforced by
`unique (retirement_account_id)` and by
`smsf_funds_validate_retirement_link()`. Three independent AU gates:
`country_applicability = ['AU']` on the catalogue item, an app-layer check in
`lib/services/jurisdiction.ts`, and the DB trigger
`retirement_accounts_smsf_au_gate()`.

**14. Are SMSF balances already included in retirement totals?** **Yes** —
exactly once, through the same `retirement_accounts.current_balance` column as
every other retirement row. `smsf_funds` / `smsf_holdings` are never read by
the dashboard engine.

**15. How are investments held inside retirement accounts represented?**
**Only for SMSF**, via `smsf_holdings`, and only when the fund is in Detailed
mode. For an *ordinary* super fund there is **no representation at all** —
which is exactly why spec 12/13's prohibition is satisfiable: there is nowhere
for FDH-12 to put them even if it wanted to.

**16. Does canonical Retirement expose a safe import/apply API?** **Not before
FDH-12.** Writes went through the generic `makeRegistry('retirement_accounts')`
(`lib/services/registry.ts`) driven by the grid's per-field PATCH. The only
typed, transactional retirement RPCs that existed are the three SMSF ones
(`smsf_create_fund`, `smsf_switch_to_detailed`, `smsf_switch_to_summary`).
FDH-12 adds `fdh12_apply_retirement_proposal()` as the safe import/apply API.

**17. Which fields are safe to update from statement evidence?**
`current_balance`, `employer_contribution`, `personal_contribution`,
`contribution_frequency`, and — on ADD NEW only — `account_name`,
`account_type`, `currency_code`, `country_code`, `owner`. That is the complete
allow-list.

**18. Which values must remain calculated rather than statement-overwritten?**
`retirement_members.target_retirement_age` and
`retirement_accounts.target_retirement_age` (spec 61); everything computed by
`retirementCalculator.ts` (readiness, required corpus, projected balance,
decumulation trajectory, status band); `netWorth` and `totalRetirement`;
every SMSF-derived value; and `is_active` / `master_item_key` / `user_id` /
`retirement_member_id` / `source_type` / `ii_publication_id`, which are
structural rather than financial.

---

## 4. Disclosed Retirement-module gaps (not fixed here)

These are recorded, not patched. Patching them would mean FDH-12 rewriting the
Retirement module, which spec sections 2 and 172 forbid.

**GAP-R1 — one catalogue-keyed account per household, not per member.**
`uq_retirement_accounts_user_master unique (user_id, master_item_key)` means
Self and Spouse cannot each hold an `industry_super` row. Spec section 14
explicitly requires "Self: Fund A, Fund B; Spouse: Fund C".
*FDH-12's response:* every account FDH-12 creates is a **custom row with
`master_item_key = NULL`**, which the constraint does not restrict. This is
sufficient for spec 14 and spec 17, is not a workaround around a safety
control (the constraint exists to stop grid duplicates, not to cap accounts),
and leaves the constraint itself untouched. Recorded so the Retirement module
can decide whether to re-key the constraint on
`(user_id, retirement_member_id, master_item_key)` in a future phase.

**GAP-R2 — no home for retirement activity.** Contributions-as-events, fees,
insurance premiums, taxes, rollovers, withdrawals, earnings and pension
payments have no canonical table. FDH-12 keeps all of it as statement
evidence. If the Retirement module later grows a ledger, FDH-12's evidence
rows are already shaped to feed it.

**GAP-R3 — `account_type` is unvalidated and holds two vocabularies.**
No DB CHECK; Zod says `super|EPF|PPF|NPS|other` while migrations 0073/0084
write lowercase catalogue keys into the same column. FDH-12 never reads it for
matching.

**GAP-R4 — India retirement is catalogue-only.** See
`FDH12_INDIA_RETIREMENT_GAP_REGISTER.md`.

---

## 5. Zero-duplicate-engine confirmation

FDH-12 creates:

- **no** retirement account table, **no** member table, **no** balance store
- **no** projection, forecast, readiness or adequacy calculation
- **no** target-retirement-age concept
- **no** SMSF table, **no** SMSF balance, **no** SMSF holding
- **no** ordinary-investment row from any retirement holding
- **no** income row, **no** expense row, **no** bank transaction

It creates exactly three evidence tables, one adapter, one RPC, and the
provenance columns that record what an apply did.

Mechanically enforced by `tests/unit/fdh12Isolation.test.ts`, which walks the
real source tree and fails the build if any of the above is violated.
