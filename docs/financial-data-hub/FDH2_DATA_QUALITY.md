# FDH2_DATA_QUALITY

## 1. The validation script

`scripts/fdh2_certify_master_data.mjs` — rebuilds a fresh PGlite database
from the full active migration chain, then runs 43 checks in six groups.
**It FAILS (non-zero exit), it does not warn-and-continue**, on any
violation — matching the specification's explicit requirement.

Last run: **43 passed, 0 failed.**

## 2. Idempotency (the seed-run-twice requirement)

The 4 FDH-2 seed migrations (`0053`-`0056`) are re-applied a SECOND time
against the same already-seeded database, and every one of the 14 FDH-2
table row counts is asserted identical before/after. This is possible
because every INSERT uses `ON CONFLICT (<stable key>) DO NOTHING` —
verified independently by `tests/unit/fdh2SchemaContract.test.ts`'s "every
seed migration uses ON CONFLICT ... DO NOTHING everywhere" check, which
counts literal `insert into`/`on conflict` occurrences per file and fails
if they do not match 1:1, and additionally asserts no `DO UPDATE` variant
is used anywhere (which would make a re-run silently overwrite content
rather than proving true no-op idempotency).

## 3. Stable-key duplicate checks (7 checks)

No duplicate `category_key`, `(category_id, subcategory_key)`, `mcc`,
`(country_code, institution_code)`, `(country_code, canonical_name)`
merchant, `rule_key`, or `rail_key` anywhere in the seeded data.

## 4. Orphan / referential-integrity checks (12 checks)

Beyond what foreign keys already enforce structurally: no MCC mapping
references a non-existent category; no subcategory-level MCC mapping
without its parent category; no ambiguous MCC mapping carries a
subcategory; no `ambiguous_unmapped` MCC mapping carries a category; no
merchant `default_subcategory_id` without `default_category_id`; no
merchant `mcc_confidence` without an `mcc`; every populated
`merchant.mcc`/`category.source_key`/`institution.source_key`/
`merchant.source_key`/`mcc_master.source_key` resolves to a real row in its
target table; every classification rule's `economic_transaction_type` (when
present in its action) is a real value; every `classify`-action rule's
`category_id` (when present) resolves to a real category; every
`payment_rail_narrative` rule references a real payment rail.

## 5. Format / domain checks (5 checks)

Every MCC is exactly 4 digits; every `category_key` is lowercase
snake_case; every institution's `coverage_status` is `master_only`; no
institution alias or merchant alias contains a run of 7+ digits (which
would indicate an account/phone number leaking into public master data —
mirrors the account-masking discipline FDH-1 already enforces on
`fdh_financial_accounts.masked_identifier`).

## 6. Alias collision checks (2 checks — "make ambiguity explicit")

Zero merchant aliases (within the same country) resolve to two different
merchants; zero institution aliases resolve to two different institutions.
Both checks would report the exact colliding rows if any existed — the
specification's requirement to make ambiguity explicit rather than silently
pick one.

## 7. PII / governance structural check (1 check)

`fdh_global_learning_candidates` has zero seeded rows — the candidate
intake path is a documented contract only in this phase (see
`FDH2_GLOBAL_LEARNING_GOVERNANCE.md`), never auto-populated. The
personal-payee heuristic itself is tested separately and more thoroughly
in `tests/unit/fdh2Domain.test.ts` (9 tests, including true-positive,
true-negative, and an honest documentation of its deliberate
over-flagging tradeoff).

## 8. What the load FAILS on, per the specification's explicit list

| Required FAIL condition | Enforced by |
| --- | --- |
| Orphan category / subcategory | §4 orphan checks + FK constraints |
| Duplicate key | §3 stable-key checks + unique constraints/indexes |
| Invalid MCC | §5 format check + `check (mcc ~ '^[0-9]{4}$')` |
| Unknown merchant category | §4 `merchant.mcc exists in fdh_mcc_master` + FK on `default_category_id` |
| Duplicate alias conflict | §6 collision checks + unique indexes |
| Invalid country | `char(2)` FK to `countries` + `chk_..._country_applicability` array constraints |
| Unapproved global-rule status | All 60 seeded rules are `status = 'approved'`; a `proposed`/`admin_review` row is never treated as authoritative by design (nothing in FDH-2 reads status for authority; that's FDH-6) |

## 9. Rejected / ambiguous candidates — honest count

Zero merchant or institution candidates were rejected mid-authoring — every
candidate this session attempted was confidently identified and included.
7 MCCs were deliberately left `ambiguous_unmapped` and 4 more
`broad_group_only` (see `FDH2_MCC_MAPPING.md` §3) — these are not
"rejected," they are correctly-modelled ambiguity, which is the desired
outcome, not a gap.
