-- Investment Intelligence — widen ii_reconciliation_cases.discrepancy_type
-- for two new exception types the LIVE upload pipeline can now raise:
-- 'owner_mismatch' and 'joint_holding_allocation_required'.
--
-- BACKGROUND (2026-09-28 production walkthrough). The Investment
-- Intelligence "Resolutions" tab was built against PC5
-- (`docs/investment-intelligence/PC5_IMPLEMENTATION_CERTIFICATION_2026-09-15.md`)
-- which reads `aie_unresolved_item`, populated only by the AIE-fronted
-- `lib/aie/adapters/investment-intelligence/dispatch.ts` pipeline. The REAL
-- live upload flow (`/investment-intelligence/data`) exclusively runs
-- `lib/services/investment-intelligence/documentProcessing.ts`
-- (`processSourceDocument`), which never calls dispatch.ts and writes its
-- own, simpler exceptions to `ii_reconciliation_cases`. The Product Owner's
-- decision (recorded in this mission's dispatch): do NOT switch the live
-- pipeline to the AIE one; instead widen `ii_reconciliation_cases` to cover
-- every exception type PC5's own K.1-K.22 spec defined, decided in the
-- existing Review tab, so there remains exactly ONE exception table.
--
-- PC5's OWN PURE LOGIC IS REUSED, NOT REIMPLEMENTED. The owner-mismatch
-- comparison in `documentProcessing.ts` calls
-- `lib/aie/adapters/investment-intelligence/ownerMatching.ts`'s
-- `matchStatementOwner` — the exact same deterministic, no-fuzzy-match
-- function PC5 already certified (K.4/K.7) — it is simply now ALSO called
-- from the live pipeline that never reached it before, and its result is
-- recorded as an `ii_reconciliation_cases` row instead of an
-- `aie_unresolved_item` row. `joint_holding_allocation_required` is the
-- same function's `joint_holding` outcome (K.6); a real allocation UI is
-- NOT built by this migration/pass — see the Review Centre client's own
-- comment for what is and is not resolvable today.
--
-- NUMBERING. `scripts/check-migration-versions.mjs` reports 207 active
-- migrations on this branch and "next version is 0227";
-- `scripts/check-migration-versions-against-branch.mjs` reports no
-- collision against `origin/main`. Independently re-checked against EVERY
-- remote branch (`git ls-tree -r origin/<branch> -- supabase/migrations`
-- for every branch returned by `git branch -r`, ~250 branches): no branch
-- has a file numbered 0227-0229, and `git grep` across every remote ref for
-- `ii_reconciliation_cases_discrepancy_type_check` returns exactly the same
-- four files on every branch (0041, 0082, 0086, 0159) — so 0159 is
-- genuinely the latest version of this constraint everywhere, and this
-- migration's DROP+ADD reproduces its full value list verbatim rather than
-- risking the drop-and-recreate trap a prior session's memory already named
-- (a sibling branch widening the same CHECK with a different migration
-- number would merge with no git conflict, and a hardcoded recreate here
-- could silently revoke it — verified fresh rather than assumed).
--
-- PRODUCTION AUTHORITY: NONE. Not applied to DEV or production by this
-- pass — this sandbox has no DDL-execution mechanism (same standing wall as
-- every other migration in this repo's history). Application is a Product
-- Owner / operator action. Purely additive: every existing value from 0159
-- is reproduced verbatim, so no existing row can violate the new
-- constraint.

alter table ii_reconciliation_cases drop constraint if exists ii_reconciliation_cases_discrepancy_type_check;
alter table ii_reconciliation_cases add constraint ii_reconciliation_cases_discrepancy_type_check check (discrepancy_type in (
  'owner_unmatched', 'account_unmatched', 'instrument_unmatched', 'ambiguous_instrument',
  'transaction_unclassified', 'unit_mismatch', 'value_mismatch', 'duplicate_suspected',
  'missing_opening_history', 'unsupported_document', 'document_corrupt',
  'document_password_required', 'parse_incomplete', 'statement_period_gap', 'other',
  'cross_source_exact_duplicate', 'cross_source_high_confidence_duplicate',
  'cross_source_conflict', 'cross_source_review_required', 'cross_source_holding_conflict',
  'transaction_missing_from_restatement', 'ai_fallback_reconciliation_attempted',
  'owner_mismatch', 'joint_holding_allocation_required'
));

comment on column ii_reconciliation_cases.discrepancy_type is
  'Closed vocabulary, widened across R2/R11/Performance/2026-09-28 owner-exception unification. '
  '''owner_mismatch'' (subject_type=account): the statement prints a holder name that does not '
  'match the DECLARED owner (Pc5OwnerMatchOutcome kind mismatch/ambiguous/exact_match-to-a-different-member '
  '-- see ownerMatching.ts). Distinct from the pre-existing ''owner_unmatched'', which fires when NO '
  'owner was declared at all. '
  '''joint_holding_allocation_required'' (subject_type=account): the statement''s holding-mode/joint-holder '
  'evidence indicates a joint folio (Pc5OwnerMatchOutcome kind joint_holding); resolvable today only by '
  'assigning a single sole owner (which supersedes the joint reading) -- a real percentage-split allocation '
  'UI is not yet built (see ResolutionCentreClient.tsx / ReviewCentreClient.tsx).';
