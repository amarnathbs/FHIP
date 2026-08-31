# FDH-15 — Compare / Decision / Apply Certification

## Evidence cannot directly become canonical truth (spec §16)

Traced for Income and Retirement (the two domains where this round built fresh live-DEV proof):
upload → parse → reconcile → review → approve evidence → generate proposal → compare are ALL
read-only with respect to the canonical tables (`income_sources`, `retirement_accounts`,
`liabilities`). Live-confirmed this round: creating a proposal and reading its compare view
produced **zero** canonical writes in every test case (`FDH15_LIVE_DEV_CERTIFICATION.md`). Only the
Apply RPC mutates canonical data, and only after its own compare-and-swap claim succeeds.

## Compare is not Apply (spec §32)

Confirmed by source inspection: `getIncomeProposalForReview()`/the liability/retirement equivalents
are pure SELECTs. No proposal-review API route contains an INSERT/UPDATE against a canonical table.

## Add New vs Update Existing (spec §36)

Both decisions are real, distinct branches inside each Apply RPC:
- `add_new` requires a minimum field set (Income: `source_name`+`amount`+`frequency`; Retirement:
  `account_name`+`current_balance`+`currency_code`; Liability: analogous) or returns
  `DOMAIN_VALIDATION_FAILED` — live-confirmed no blank canonical record can be created.
- `update_existing` requires `target_entity_id` to be non-null and to resolve to a row owned by
  the caller (live-confirmed: `TARGET_NOT_FOUND` for a foreign/missing target).

## No-fields-selected control (spec §37)

Live-confirmed (Income, INC-5): `apply_selected_fields` with an empty field array returns
`NO_FIELDS_SELECTED` and mutates nothing — the previously-fixed FDH-10 behaviour is preserved and
the same code shape exists in Income and Retirement's RPCs (checked before this round; unchanged).

## Field-level decisions (spec §38)

`p_selected_fields` is honoured exactly: only the named fields are read from
`fhip_import_proposal_fields`, allow-listed, and written. Unselected fields are left untouched.
This is structural (the `SET` clause is built only from the selected-field loop), not merely
UI-enforced.

## Confidence/reconciliation do not authorize Apply (spec §40–41)

No Apply RPC reads a `confidence` or `reconciliation_status` column from the evidence table as an
authorization input — each RPC's only gates are: proposal ownership (`auth.uid()`), proposal
status (`'ready'`), evidence approval (`approval_status='approved'`, checked explicitly for
Retirement), field allow-list, and (new this round) member/owner consistency. A 100%-confidence or
exactly-reconciled statement still requires the same explicit user Apply call as any other.

## Rejected / Cancelled / Abandoned proposals (spec §95–97)

- **Rejected** (`keep_existing` decision): the RPC's own branch performs zero canonical writes,
  only flips the proposal to `dismissed` — live-confirmed pattern (code-identical across Income/
  Liability/Retirement RPCs; re-verified by direct reading this round, not re-run live this round
  since it was already live-certified by FDH-9/10/12's own prior rounds and the RPC body is
  unchanged for this branch except for the two `MEMBER_MISMATCH` additions in migrations 0119/0120,
  neither of which touches the `keep_existing` branch).
- **Abandoned** (user never calls Apply): the proposal stays `'ready'` indefinitely; no background
  job mutates canonical data from an unapplied proposal — confirmed by grep (no cron/trigger
  references `fhip_import_proposals` for canonical writes).
- **Deleted/superseded**: no DELETE RLS policy exists on `fhip_import_proposals` for the
  authenticated role, so a proposal cannot be deleted by its owner at all (only dismissed/expired/
  superseded via the RPC's own controlled transitions) — this closes spec §97's concern
  structurally rather than by convention.
