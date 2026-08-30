# FDH-12 — The Canonical Retirement Bridge

The spec-section-104 architecture decision, and its consequences.

## Audited

`lib/import-bridge/` implements a domain-agnostic
Preview → Compare → User Approval → Apply contract over three tables from
migration 0091: `fhip_import_proposals`, `fhip_import_proposal_fields`,
`fhip_import_applications`.

## Finding

`IMPORT_TARGET_DOMAINS` already contained `retirement` and
`IMPORT_SOURCE_KINDS` already contained `retirement_statement`, and both were
already permitted by the DB CHECK constraints — reserved deliberately in 0091
and unused since. Missing were: a `DOMAIN_TABLES` entry, a
`source_retirement_statement_id` provenance column, a typed adapter, and an
apply RPC.

## Decision — EXTEND the generic bridge

1. **The shape fits exactly.** Canonical Retirement apply is a *single-row
   field patch*, which is what the generic bridge was built for, and which is
   precisely what FDH-11 could NOT use (its apply is a ledger append, so it
   built a bespoke typed service and documented that departure). FDH-12 is the
   FDH-9/FDH-10 shape, not the FDH-11 shape.
2. **Four spec requirements come for free**, already certified: the
   `existing_value` staleness oracle (108), `unique (proposal_id)` idempotency
   (106), the compare-and-swap claim (107), per-field selection (109).
3. **Never unrestricted dynamic table writes** (104's prohibition). The
   allow-list is asserted in three independent places: the adapter's
   `applicableFields`, the RPC's `v_allowed` constant array, and the RPC's
   hard-coded per-column `case` for staleness reads. A field absent from any of
   them cannot be written. A test asserts the TypeScript and SQL lists are
   identical.

**Rejected:** a retirement-specific bespoke service in the FDH-11 style. It
would re-implement staleness, idempotency and concurrency control that already
exist and are already certified, for a domain whose canonical model is a plain
row.

## Guard mechanism — chosen deliberately

FDH-12 uses the **FDH-9/FDH-10 GUC guard**
(`current_setting('fhip.import_bridge_internal_write')`) inside the apply RPC,
because the legitimate writer there is a `SECURITY DEFINER` function that can
set the GUC. Its three evidence tables use the **FDH-11 `auth.role()` guard**,
because their legitimate writer is a service-role client. The two are not
interchangeable, and both are present, each where it is correct.

## The allow-list — nine columns

```
account_name, account_type, current_balance, currency_code, country_code,
owner, employer_contribution, personal_contribution, contribution_frequency
```

Absent, deliberately: `target_retirement_age` (both its canonical per-member
home and its legacy per-account one — spec 61, 113), `master_item_key`,
`is_active`, `user_id`, `retirement_member_id`, `source_type`,
`ii_publication_id`, `notes`. And **every statement activity**, because
canonical Retirement has nowhere to put one — which is spec section 60's
double-apply control.

## ADD NEW creates a CUSTOM row

`master_item_key` is forced NULL. Two consequences, both intended:

* the row sits outside `uq_retirement_accounts_user_master
  unique (user_id, master_item_key)`, so Self and Spouse can each hold their
  own funds (spec 14; see GAP-R1 in the Reuse & Gap Audit);
* an import structurally **cannot** create an SMSF row, since SMSF is
  identified solely by `master_item_key = 'smsf'`.

`owner` is NOT defaulted (unlike income and liability, whose evidence carries
no member signal) — it is a proposed field the user confirms.

## A real defect found during certification

`fdh9_assert_proposal_owner()` and `fdh9_assert_application_owner()` FAIL
CLOSED on an unrecognised `target_domain`, by design — 0091's own comment says
a future adapter cannot ship a target without also extending this guard.
FDH-12 is that future adapter, and had not extended it, so every retirement
proposal carrying a target was rejected outright. Caught by
`scripts/fdh12_certification.mjs` section 6, not by inspection. Migration 0111
now re-creates both functions whole, retaining the income and liability
branches byte-for-byte and adding a `retirement` branch — the same shape 0096
used when it added `liability`. The retirement branch is itself a
spec-section-98 control: a proposal targeting another tenant's retirement
account is refused at the bridge as well as on the statement row.

## Apply outcomes

| Code | Meaning |
| --- | --- |
| `applied` | Canonical Retirement updated. |
| `kept_existing` | Spec 110 — dismissed, nothing written. |
| `ALREADY_APPLIED` | Spec 106 — second call, or lost race. |
| `STALE_PROPOSAL` | Spec 108 — the live row changed; the newer value is preserved. |
| `FORBIDDEN_FIELD` | Outside the allow-list, or not part of the proposal. |
| `NO_FIELDS_SELECTED` / `DOMAIN_VALIDATION_FAILED` | Selection rules. |
| `EVIDENCE_NOT_APPROVED` | Spec 56 — approving evidence and applying it are different acts. |
| `SMSF_ACCOUNT_NOT_IMPORTABLE` | Spec 10, 72 — routed to the SMSF module. |
| `PROPOSAL_NOT_FOUND` | Also the answer for another tenant's proposal — a cross-tenant probe learns nothing. |

## Atomicity (spec 105)

`fdh12_apply_retirement_proposal()` is a FUNCTION, not a PROCEDURE. It has no
`COMMIT` of its own, so an exception at any point aborts the whole enclosing
transaction and undoes every write it made, including the proposal claim.
Certified live: a deliberately malformed proposal leaves no application row,
leaves the proposal `ready` rather than stranded as `applied`, and leaves the
canonical balance untouched.
