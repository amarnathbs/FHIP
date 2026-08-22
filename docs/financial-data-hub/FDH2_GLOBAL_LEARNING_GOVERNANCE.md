# FDH2_GLOBAL_LEARNING_GOVERNANCE

## 1. Scope — domain contract only, no admin UI, no wired promotion path

FDH-2 implements the DATA MODEL and DOMAIN-LAYER decision logic for the
global-learning workflow described in the specification. It does NOT build
the admin review screen (FDH-13's job) and does NOT wire any HTTP
route/server action that actually writes a candidate or promotes one to
global master data. This is a deliberate scope decision, matching the
specification's own permitted alternative ("if this would add unnecessary
complexity now, just document the domain contract and defer").

## 2. The workflow

```
user correction (fdh_user_classification_rules, user-owned, RLS-isolated)
  -> potential global-learning candidate
  -> PII / personal-payee screening (personalPayeeGuard.ts)
  -> evidence aggregation (globalLearningGovernance.ts: buildCandidateEvidence)
  -> admin_review
  -> approve / reject / merge   (decideGovernanceTransition — pure decision logic)
  -> (only on approve/merge, via a SEPARATE, human-operated admin action
      that does not exist in FDH-2) a verified fdh_merchants /
      fdh_classification_rules row is written
```

## 3. `fdh_global_learning_candidates` (new table, migration `0052`)

Aggregate-only evidence: `candidate_type`, `country_code`, `merchant_id`,
`current_category_id`/`proposed_category_id`/`proposed_subcategory_id`,
`number_of_independent_users`, `number_of_corrections`,
`number_of_matching_aliases`, `confidence`, `pii_screening_status`,
`status`, `reviewed_by`/`reviewed_at`. There is no column anywhere on this
table for a raw per-user transaction narrative, a user identifier beyond
the anonymous aggregate counts, an account number, an email or a phone
number — the schema makes it structurally impossible to store that, not
merely a convention not to.

**Access is MORE restricted than ordinary master data.** RLS is enabled
with ZERO policies of any kind for `anon`/`authenticated` — stricter than
`fdh_categories`/`fdh_merchants`/etc, which are at least publicly readable.
A pending governance candidate is not settled reference data; even in
aggregate form ("14 independent users correct COSTCO to Household") it
could hint at cross-household behaviour, so only the service role can read
or write it. Live-proved in `scripts/fdh2_rls_certification.mjs`: an
ordinary authenticated user sees **zero** rows and cannot insert, while the
service role sees the row that's actually there (proving the zero-row
result is a real RLS effect, not missing data).

## 4. No automatic promotion, ever

Two independent enforcement layers:

1. **Database constraint** `chk_fdh_glc_pii_gate` — a candidate cannot be
   `approved` (or `merged`) unless `pii_screening_status = 'passed'`.
2. **Domain-layer state machine** (`decideGovernanceTransition`,
   `lib/financial-data-hub/domain/globalLearningGovernance.ts`) — `open` can
   ONLY move to `admin_review` (never straight to approved/rejected/merged);
   `admin_review -> approved`/`merged` additionally requires
   `piiScreeningStatus === 'passed'`; `approved`/`rejected`/`merged` are
   terminal (no further transition); a no-op same-status "transition" is
   rejected. 8 unit tests in `tests/unit/fdh2Domain.test.ts` exercise every
   rule, including all 12 disallowed terminal-state transitions.

Neither layer contains, and no code path anywhere in FDH-2 contains, a
function that writes `fdh_merchants` or `fdh_classification_rules` from
candidate data. `tests/unit/fdh2Domain.test.ts` asserts the module exports
no function whose name implies automatic promotion (`autoPromote`,
`autoApprove`, `promoteToGlobal`, `autoMerge`).

## 5. PII / personal-payee screening

`lib/financial-data-hub/domain/personalPayeeGuard.ts` — see
`FDH2_MERCHANT_MASTER.md` section 4 for the heuristic detail. A "simple,
explainable heuristic," per the specification, deliberately NOT complex
AI-based detection.

## 6. Global merchant vs private counterparty — documented boundary

`GLOBAL_MERCHANT_VS_PRIVATE_COUNTERPARTY_BOUNDARY` (exported constant,
`globalLearningGovernance.ts`) records the distinction the specification
asks for: a global merchant (`fdh_merchants`) is shared and admin-approved;
a private counterparty (e.g. "my landlord") is NOT implemented in any FDH
phase through FDH-2, and if a future phase builds one, it must be
user/household-scoped with owner-only RLS — never promoted into
`fdh_merchants` automatically. This is a real, importable, testable
constant, not prose alone.

## 7. Audit trail

Global master-data changes remain governed by FDH-1's existing audit
architecture — no second audit system was built. FDH-2 introduces no new
audit table.
