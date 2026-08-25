# R11-P0 — Scope & Architecture Reconciliation

Investment Intelligence R11 — Multi-source & Professional Expansion.
Base SHA: `81712a307e28ccdeba90daf9a24e6c465e62bddd` (= confirmed `origin/main`
at dispatch, R10 merge commit as HEAD ancestor). Branch:
`feature/investment-intelligence-r11-multisource-professional`. Migration
baseline: `0077_retirement_member_target_age.sql` (highest at branch time).
`.env.local`: **absent in this worktree** — live DEV/production
certification is not attainable here; this is disclosed up front so it
governs every later section rather than being discovered late.

This document is the mandatory GO/REVISE/BLOCKED gate (spec sections 11-19).
Nothing past this file was built before it was written. All findings below
were obtained by reading actual repository code and actual migration SQL —
none are assumed from the roadmap or from memory of prior releases.

---

## 1. Multi-source inventory (actual repository state)

`ii_sources` (migration `0031_ii_reference_foundation.sql`, seeded in
`0038_ii_india_adapter_seed.sql`) is the existing source-type catalogue.
`parser_available` was seeded `false` for every row in R1; migration
`0039_ii_r2_audit_and_document_lifecycle.sql` line 123 flips it to `true`
for `cams` and `kfintech` only. No later migration touches it. That single
column is a reliable, already-authoritative record of what's real:

| source_key | category | parser_available | Classification |
|---|---|---|---|
| `cams` | statement_provider (IN) | true | **CERTIFIED** — `lib/services/investment-intelligence/parsers/camsParser.ts`, in `PARSER_REGISTRY`, R2 full pass (364/364 tests per R2 closure docs), 20+ golden fixtures under `lib/fixtures/investment-intelligence/r2-cas/cams/` |
| `kfintech` | statement_provider (IN) | true | **CERTIFIED** — `kfintechParser.ts`, in `PARSER_REGISTRY`, same R2 pass, fixtures under `r2-cas/kfintech/` |
| `manual` | manual | **false** | **PARTIAL** — `lib/services/investment-intelligence/manualImporter.ts` exists and is fully wired into the same canonical pipeline (`ii_source_documents` → `ii_accounts` → `ii_instruments` → `ii_transactions` → `ii_holding_snapshots`) with checksum idempotency, but its own header comment states it is "the controlled, deterministic manual/test importer... NOT the production CAS parser" — i.e. it is a fixture-JSON importer proven in tests, not a shipped user-facing manual-entry form. `parser_available` was never flipped for it. |
| `mfcentral` | statement_provider (IN) | false | **SHELL_ONLY** — reference row only, zero parser code, zero fixtures |
| `nsdl` | statement_provider (IN) | false | **SHELL_ONLY** — reference row only (`document_type` enum on `ii_source_documents` does include `demat_statement`, so the schema anticipated it, but no parser exists) |
| `cdsl` | statement_provider (IN) | false | **SHELL_ONLY** — same as nsdl |
| `broker` | broker | false | **SHELL_ONLY** — `document_type` enum includes `contract_note`, but zero parser code |
| `admin_correction` | admin | false | **OUT_OF_SCOPE for R11** — this is a platform-admin correction channel, not a user evidence source; touching it would blur the "no standing admin access to raw documents" line R11 must not cross |

Australia: no II source parser of any kind exists for AU (confirmed by
`PARSER_REGISTRY` containing only the two India RTA parsers, and no
`au`/`asx`/`chess` hits anywhere under `lib/services/investment-intelligence`
or `lib/fixtures/investment-intelligence`). India remains the only
developed II source domain, exactly as the spec anticipates it might.
Architecture below stays country-neutral (it operates on already
country-neutral canonical tables), but no AU capability is fabricated.

**Root architectural finding — this is the actual gap R11 must close, not
a hypothetical one:**

1. `lib/services/investment-intelligence/accountResolution.ts` resolves
   `ii_accounts` by `(user_id, institution_name, normalised folio_number)`
   — **source-agnostic already**. A CAMS parse and a KFintech parse (or a
   manual import) of the same real folio at the same AMC already resolve
   to the *same* `ii_accounts` row today. Account-level cross-source
   identity is already correct; R11 does not need to rebuild it.
2. `lib/services/investment-intelligence/fingerprint.ts`
   (`computeTransactionFingerprint`) embeds `sourceKey` as the *first*
   field of the fingerprint, by explicit design (comment: "source... e.g.
   'cams'/'kfintech'"). The DB-level idempotency guard in migration
   `0033_ii_transactions_holdings.sql`
   (`uidx_ii_transactions_dedup on (account_id, source_document_id,
   source_reference)`) is scoped **per source document**. Both mechanisms
   correctly prevent re-importing the *same* document from creating
   duplicates (R2's actual job), but neither mechanism — nor anything
   else in the codebase — recognises that a CAMS statement and a broker
   contract note (or a second RTA) describing the *same real-world
   transaction* are the same economic fact. Today, importing overlapping
   evidence from two different sources for the same account+instrument
   produces two independent `ii_transactions` rows, both counted by every
   downstream reader.
3. `analyticsRepository.ts` (R4), `r5Repository.ts` (R5), `taxRepository.ts`
   (R6) all read `ii_transactions` directly by `user_id`, with R5/R6 already
   applying a `status !== 'reversed'` "usable" filter — i.e. there is
   already a precedent in this codebase for "a canonical input row can be
   marked as excluded from analytical aggregation without being deleted or
   rewritten." R11 reuses that exact precedent rather than inventing a new
   one (see section 6, "Architecture Exceptions" in the acceptance report).

This is precisely the failure mode named in spec section 5 ("CAMS + NSDL +
broker statement of the same mutual fund holding must NOT create 3
copies") — except, evidenced against the real repo, the immediately
exploitable version of it is CAMS + KFintech + manual (the three sources
that actually produce canonical rows today), not a hypothetical NSDL/CDSL
scenario.

## 2. Source-coverage decision

**R11 will implement deep cross-source reconciliation across the three
sources that already produce canonical evidence: CAMS, KFintech, manual
import.** These are the only sources where "multiple sources describing
one truth" is an actual, reachable condition in this codebase today.

**Deferred, not implemented in R11:** NSDL, CDSL, broker contract notes,
MFCentral. Building four new production-grade parsers (each requiring the
same depth of fixture/regression work R2 needed for CAMS/KFintech — R2
alone produced 20+ golden fixtures per parser and a dedicated certification
pass) inside one release, on top of a brand-new professional-access
security model, is exactly the "many shallow adapters instead of a few
deep ones" anti-pattern spec section 11 warns against. The architecture
built below (source-agnostic account resolution + a new cross-source
identity/reconciliation layer keyed off deterministic instrument/account
identity, not source-specific parser output) is designed so that adding
NSDL/CDSL/broker parsers later is additive — a new parser registered in
`PARSER_REGISTRY` automatically participates in cross-source reconciliation
without any change to the reconciliation engine itself. This is recorded
as the explicit reason it's safe to defer them rather than a shortcut.

## 3. Professional model inventory (actual repository state)

Searched for: households, member roles, admin roles, author/reviewer
roles, professional users, shared-account concepts, delegated permissions,
invitation flows, consent records.

- `households` / `household_members` (migrations `0001`, `0009`): each
  `household_members` row is a **profile record** (name, relationship,
  DOB) owned by, and RLS-scoped to, the *primary* `auth.uid()`. It is not
  a separate authenticated identity — there is no such thing today as a
  spouse logging in as themselves and having their own private data inside
  a shared household. This resolves the spec's "household consent" open
  question directly from evidence: **the primary account holder (the
  single `auth.uid()` who owns every `user_id`-scoped row) is the sole
  consent-granting authority for R11 professional access.** There is no
  second real principal whose independent consent could be bypassed,
  because there is no second real principal at all in the current data
  model. This is recorded as a frozen finding, not an assumption.
- `lib/resources/admin/userRoles.ts` — `RESOURCE_ROLES` (`resource_admin,
  author, editor, compliance_reviewer, publisher, analyst`) is the
  Resources CMS's internal editorial RBAC. It has nothing to do with an
  end user's own financial data and is not reused, per spec's explicit
  instruction not to borrow unrelated admin/CMS roles.
- `lib/services/adminAuth.ts` (`requireAdmin`) — platform-admin gate used
  for reference-data writes (e.g. `ii_sources`, Resources content). This
  is the platform-admin plane R11 must stay separate from (spec section 7,
  "no standing human-admin access to raw financial documents").
- Migration `0076_fdh7_review_approval_workflow.sql` (FDH-7) has the
  closest *pattern* precedent — a bounded reviewer/approval workflow with
  its own status machine — but it operates on FDH bank-transaction review,
  not on a second human party accessing another user's data, so it is
  useful only as a style precedent (status-machine + audit trail), not as
  reusable code.
- No `invitation`, `invite_token`, `invited_by`, `shared_with`, or
  `delegated` construct exists anywhere in `supabase/migrations/` or
  `lib/`/`components/`/`app/`. **Professional access is a genuinely new
  capability — nothing to reuse, nothing to accidentally collide with.**

**Freeze:** Platform Admin (`adminAuth.ts`/`requireAdmin`) ≠ Professional
(new `professional_*` tables, ordinary `auth.users` row, a distinct
`account_kind`/role flag, never service-role) ≠ Household Member (existing
profile-only `household_members`) ≠ End User (the primary `auth.uid()`).

## 4. Regulatory/product boundary

R11 professional functionality is **data collaboration / financial
information review**, scoped to: viewing already-computed, already-user-
owned structured data (holdings, transactions read-only, R4 performance
figures, R6 tax summaries, R9 goals/forecasts, R10 report snapshots) within
an explicitly granted scope, plus non-canonical professional notes. It is
**not** personalised advice, not product recommendation, not portfolio
management, not trade execution — none of the write-side hard exclusions
in spec section 55 are implemented. `lib/advice-boundary/` already exists
in this repo as a guard for a related but distinct concern (Financial DNA/
recommendation copy staying inside a non-advice boundary); R11's
professional scope is a second, independent instance of the same product
principle, not a reuse of that specific module (it guards recommendation
copy generation, not access control).

## 5. Required freeze (spec section 19)

- **Sources included in R11:** CAMS, KFintech, manual import (cross-source
  reconciliation across these three).
- **Sources deferred:** NSDL, CDSL, broker contract note, MFCentral —
  architecture left additive-ready, no parser code written.
- **Professional personas included:** a single generic `professional` role
  with `professional_type` in `('financial_adviser', 'accountant',
  'tax_professional', 'other')` — descriptive metadata only, not a
  permission dimension (spec section 71: factual, not verified/licensed).
- **Professional permissions (scopes):** `VIEW_FINANCIAL_SUMMARY`,
  `VIEW_INVESTMENTS`, `VIEW_GOALS`, `VIEW_FORECASTS`, `VIEW_REPORTS`,
  `VIEW_TAX_SUMMARY`, `VIEW_SOURCE_PROVENANCE`, `COMMENT_OR_NOTE`. No
  `VIEW_RAW_DOCUMENTS` scope is implemented at all in R11 (not "granted
  false" — the scope literally does not exist as an option yet), per
  section 7's raw-document hard rule and section 51's "prefer processed
  structured data."
- **Professional actions prohibited:** any write to canonical holdings,
  transactions, tax lots, performance, forecast results, Financial Health
  Score, review severity; any trade/execution action; any self-grant or
  self-modification of scope/expiry; any raw document access.
- **Canonical source-precedence model:** versioned policy, frozen in
  `R11_SOURCE_PRECEDENCE_POLICY.md` — CAMS and KFintech (both RTA-issued,
  both certified, both cover the same AMFI-regulated universe) are
  precedence-equal and resolved by **most-recent statement `as_of` date**
  on conflict; manual import is lowest precedence (never overrides RTA
  evidence, only fills gaps RTA evidence doesn't cover). Precedence never
  deletes the losing evidence row.
- **Cross-source reconciliation approach:** deterministic identity states
  (`EXACT`, `HIGH_CONFIDENCE`, `AMBIGUOUS`, `REVIEW_REQUIRED`) computed
  from account_id + instrument_id + date + type + units + amount +
  source_reference — detailed in `R11_CROSS_SOURCE_RECONCILIATION.md`.
- **Document visibility model:** raw `ii_source_documents`/storage objects
  remain owner-only (existing RLS, untouched); professional access never
  reaches storage, only structured tables, and only within granted scope.
- **Migration plan:** new tables only (no ALTER of R1/R2 tables' RLS or
  constraints), plus one additive column pair on `ii_transactions`
  (`counted_in_canonical_truth`, `superseded_by_transaction_id`) used
  exclusively by the new reconciliation engine — detailed with exact
  migration numbers in the acceptance report once the collision guard is
  re-run immediately before writing.

## 6. Verdict

**GO — R11 SCOPE RECONCILED**, bounded to the scope frozen in section 5
above. The scope is deliberately narrower than the spec's full source list
because the evidence (not assumption) shows that is where real duplication
risk and real reconciliation value both actually live today; deferred
sources are named and the architecture is built so they can be added
later without rework. Proceeding to R11-P1.
