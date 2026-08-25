-- =============================================================================
-- FDH-8 closure follow-up (0085): split-transaction approval gate fix.
-- =============================================================================
-- THE BUG (documented in docs/financial-data-hub/FDH8_COMPLETION_REPORT.md,
-- lines 29/111/126, and reproduced live before this migration — see
-- FDH8-C6-01b in scripts/_tmp_fdh8_c6_01b_repro.ts / fdh8_live_dev_certification.ts).
-- `splitTransaction()` (lib/financial-data-hub/services/transactionSplitService.ts)
-- never updates the PARENT transaction row's economic_transaction_type away
-- from 'unknown' after a split — by design, it only ever writes the
-- allocation rows (spec 44-48: "The parent transaction row itself is NEVER
-- duplicated or altered by this"). fdh7_transaction_has_blocking_issue()
-- (migration 0076) blocked approval whenever economic_transaction_type=
-- 'unknown' on the parent, WITHOUT checking whether reconciled allocations
-- already existed. Net effect: a transaction split from an initially-
-- uncategorised parent could never be approved through the split action
-- alone — the only route was a manual 'correction' action on the parent, a
-- real workaround but not a fix.
--
-- WHY THE PARENT'S economic_transaction_type IS SAFE TO IGNORE HERE.
-- lib/financial-data-hub/domain/approvedSummary.ts#computeApprovedFinancialSummary
-- (line ~200, unmodified by this migration) proves the parent's own amount
-- and economic_transaction_type are NEVER summed once a transaction has
-- allocations — "parent's own amount/type is NEVER also summed (spec 153)".
-- Every total is instead computed from the allocations' OWN
-- economic_transaction_type values. The parent's 'unknown' classification is
-- therefore inert data once a valid split exists; it carries no financial
-- meaning and blocking on it alone is a pure gate bug, not a genuine
-- unresolved-classification signal.
--
-- OPTION A vs OPTION B (see task dispatch for the full framing).
-- Option B — having splitTransaction() write some synthetic value (e.g. a
-- new 'split' enum member, or the "dominant" allocation type) onto the
-- parent's economic_transaction_type — was rejected: it would require
-- widening the economic_transaction_type check constraint on BOTH
-- fdh_transactions and fdh_transaction_allocations (a bigger, riskier
-- migration than this one), and worse, it would be actively MISLEADING: any
-- future code path that naively reads the parent's economic_transaction_type
-- directly (bypassing the "check allocations first" rule
-- computeApprovedFinancialSummary already enforces) would see a fabricated
-- classification for a transaction that is, in truth, split across
-- potentially different types per allocation. Option A — narrowing the
-- blocking-issue CHECK to stop treating 'unknown' as blocking ONLY when
-- reconciled allocations already cover the full parent amount — changes
-- zero application code, changes zero enum values, and is exactly the fix
-- the spec's own preferred-option framing describes: "the split children's
-- own economic_transaction_type values are what actually matter for
-- classification, not the parent's."
--
-- SCOPE DISCIPLINE. Every OTHER blocking condition in
-- fdh7_transaction_has_blocking_issue() is completely untouched: an open
-- 'blocking'-severity review item, a still-PENDING transfer/refund/
-- reversal/duplicate link, a still-PENDING duplicate candidate, and —
-- critically — an INCOMPLETE or MIS-RECONCILED split (allocations that do
-- not sum exactly to the parent amount) all still block approval exactly as
-- before. A transaction that is 'unknown' with NO allocations, or with
-- allocations that do not yet reconcile, is still correctly blocked by this
-- same first clause (the "reconciled allocations" check below is false in
-- both cases, so the 'unknown' block is not lifted).
-- =============================================================================

create or replace function fdh7_transaction_has_blocking_issue(p_user_id uuid, p_transaction_id uuid)
returns boolean
language sql
stable
as $$
  select
    exists (
      select 1 from fdh_transactions t
      where t.id = p_transaction_id and t.user_id = p_user_id
        and t.economic_transaction_type = 'unknown'
        -- FDH-8 closure fix (0085): 'unknown' does NOT block approval when
        -- this transaction has already been split into allocations that
        -- reconcile exactly to the parent amount — the allocations' own
        -- economic_transaction_type values are what matter for
        -- classification/totals (computeApprovedFinancialSummary), never
        -- the parent's. No allocations, or allocations that do not exactly
        -- reconcile, leave this NULL/mismatched and the block still applies.
        and (
          select sum(a.amount) from fdh_transaction_allocations a
          where a.transaction_id = t.id and a.user_id = p_user_id
        ) is distinct from t.amount_original
    )
    or exists (
      select 1 from fdh_review_items
      where user_id = p_user_id and transaction_id = p_transaction_id
        and severity = 'blocking' and status in ('open', 'in_progress')
    )
    or exists (
      select 1 from fdh_transaction_links
      where user_id = p_user_id and status = 'pending'
        and (transaction_id_from = p_transaction_id or transaction_id_to = p_transaction_id)
    )
    or exists (
      select 1 from fdh_duplicate_candidates
      where user_id = p_user_id and status = 'pending'
        and (transaction_id_a = p_transaction_id or transaction_id_b = p_transaction_id)
    )
    or exists (
      select t.amount_original from fdh_transactions t
      join fdh_transaction_allocations a on a.transaction_id = t.id
      where t.id = p_transaction_id and t.user_id = p_user_id and a.user_id = p_user_id
      group by t.id, t.amount_original
      having sum(a.amount) <> t.amount_original
    );
$$;

-- fdh7_statement_has_blocking_issue() calls fdh7_transaction_has_blocking_issue()
-- per-transaction and needs no change — CREATE OR REPLACE above is picked up
-- automatically by its existing call site (migration 0076, unmodified).

grant execute on function fdh7_transaction_has_blocking_issue(uuid, uuid) to authenticated;
