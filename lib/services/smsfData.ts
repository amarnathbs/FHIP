import type { SupabaseClient } from '@supabase/supabase-js';
import type { SmsfFundCreateInput, SmsfFundUpdateInput, SmsfHoldingInput, SmsfLiabilityInput, SmsfMemberInput, SmsfSwitchModeInput } from '@/lib/validation/smsf';

// Thin, self-contained data-access layer for the SMSF Fund/Members/Holdings
// model (migration 0084). Deliberately does NOT import the sibling
// property-liability branch's lib/engines/propertyLiabilityLinks.ts or
// lib/services/propertyLiabilityLinksData.ts (that branch is not merged
// into this one) -- it talks to the property_liability_links TABLE directly
// via plain Supabase queries, matching that table's certified shape exactly
// (migration 0078, copied verbatim into this branch), so this file merges
// independently of when/whether that branch reconciles with this one.

export async function listSmsfFunds(userId: string, supabase: SupabaseClient) {
  return supabase
    .from('smsf_funds')
    .select('*, retirement_accounts!inner(id, account_name, current_balance, currency_code, is_active)')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: false });
}

export async function getSmsfFund(fundId: string, supabase: SupabaseClient) {
  return supabase.from('smsf_funds').select('*').eq('id', fundId).single();
}

/**
 * Atomic creation via the smsf_create_fund() RPC (migration 0084) -- one
 * round trip, one transaction, so there is never a window with a
 * retirement_accounts row but no smsf_funds row or vice versa. The RPC
 * itself is still subject to the GEO-2 AU-only gate and ownership RLS
 * exactly as a direct insert would be (see the function's own SQL comment)
 * -- this call is convenience, not a second/weaker gate.
 */
export async function createSmsfFund(input: SmsfFundCreateInput, supabase: SupabaseClient) {
  return supabase.rpc('smsf_create_fund', {
    p_account_name: input.account_name,
    p_fund_name: input.fund_name,
    p_summary_balance: input.mode === 'summary' ? (input.summary_balance ?? null) : null,
    p_summary_balance_date: input.mode === 'summary' ? (input.summary_balance_date ?? null) : null,
    p_owner: input.owner,
    p_currency_code: input.currency_code,
    p_country_code: input.country_code,
    p_mode: input.mode,
  });
}

export async function updateSmsfFundSummary(fundId: string, userId: string, patch: SmsfFundUpdateInput, supabase: SupabaseClient) {
  // The trg_smsf_funds_sync_summary trigger (migration 0084) propagates
  // summary_balance changes into retirement_accounts.current_balance
  // automatically -- this call only ever needs to touch smsf_funds itself.
  return supabase
    .from('smsf_funds')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', fundId)
    .eq('user_id', userId)
    .select()
    .single();
}

/**
 * Entity-level recording mode (migration 0290): itemised (assets and liabilities, net derived) OR net value only (one typed net).
 * ONE atomic, PREVIEW-FIRST call. With confirm false nothing changes and the result says what would (net before, net after, variance);
 * with confirm true the new representation is applied and the old one retired (archived, never deleted) in one transaction, with a
 * history row. Replaces the earlier two-step switch functions, which staged lines in a net-value fund.
 */
export async function switchSmsfRecordingMode(fundId: string, input: SmsfSwitchModeInput, supabase: SupabaseClient) {
  return supabase.rpc('smsf_entity_switch_mode', {
    p_fund_id: fundId,
    p_to_mode: input.to_mode,
    p_assets: input.to_mode === 'detailed' ? input.assets : [],
    p_liabilities: input.to_mode === 'detailed' ? input.liabilities : [],
    p_net: input.to_mode === 'summary' ? input.net : null,
    p_net_date: input.to_mode === 'summary' ? (input.net_date ?? null) : null,
    p_confirm: input.confirm,
  });
}

export async function undoSmsfLastSwitch(fundId: string, confirm: boolean, supabase: SupabaseClient) {
  return supabase.rpc('smsf_entity_undo_last_switch', { p_fund_id: fundId, p_confirm: confirm });
}

export async function retireSmsfTypedNet(fundId: string, confirm: boolean, supabase: SupabaseClient) {
  return supabase.rpc('smsf_entity_retire_typed_net', { p_fund_id: fundId, p_confirm: confirm });
}

export async function moveSmsfLinkedLoan(fundId: string, liabilityId: string, confirm: boolean, supabase: SupabaseClient) {
  return supabase.rpc('smsf_entity_move_linked_loan', { p_fund_id: fundId, p_liability_id: liabilityId, p_confirm: confirm });
}

export async function adoptSmsfRegisterRows(fundId: string, retirementRowIds: string[], confirm: boolean, supabase: SupabaseClient) {
  return supabase.rpc('smsf_entity_adopt_register_rows', { p_fund_id: fundId, p_retirement_row_ids: retirementRowIds, p_confirm: confirm });
}

/** The fund's own debts (migration 0289): entity-level liabilities, never personal. */
export async function listSmsfLiabilities(fundId: string, userId: string, supabase: SupabaseClient) {
  return supabase
    .from('smsf_liabilities')
    .select('*')
    .eq('smsf_fund_id', fundId)
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: false });
}

export async function createSmsfLiability(fundId: string, userId: string, input: SmsfLiabilityInput, supabase: SupabaseClient) {
  // trg_smsf_liabilities_recompute (migration 0289) re-derives the fund net after this insert.
  return supabase
    .from('smsf_liabilities')
    .insert({ ...input, smsf_fund_id: fundId, user_id: userId })
    .select()
    .single();
}

export async function updateSmsfLiability(liabilityId: string, userId: string, patch: Partial<SmsfLiabilityInput>, supabase: SupabaseClient) {
  return supabase
    .from('smsf_liabilities')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', liabilityId)
    .eq('user_id', userId)
    .select()
    .single();
}

export async function archiveSmsfLiability(liabilityId: string, userId: string, supabase: SupabaseClient) {
  return supabase.from('smsf_liabilities').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', liabilityId).eq('user_id', userId).select().single();
}

/** Funds that hold BOTH an itemised set and a typed net (data-quality check; see smsf_mode_rule_violations()). */
export async function listSmsfModeRuleViolations(supabase: SupabaseClient) {
  return supabase.rpc('smsf_mode_rule_violations');
}

export async function listSmsfHoldings(fundId: string, userId: string, supabase: SupabaseClient) {
  return supabase
    .from('smsf_holdings')
    .select('*')
    .eq('smsf_fund_id', fundId)
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: false });
}

export async function createSmsfHolding(fundId: string, userId: string, input: SmsfHoldingInput, supabase: SupabaseClient) {
  // trg_smsf_holdings_recompute (migration 0084) recomputes the fund's
  // detailed value automatically after this insert; it only writes into
  // retirement_accounts.current_balance while the fund is already in
  // detailed mode -- while summary, this only updates the live preview.
  return supabase
    .from('smsf_holdings')
    .insert({ ...input, smsf_fund_id: fundId, user_id: userId })
    .select()
    .single();
}

export async function updateSmsfHolding(holdingId: string, userId: string, patch: Partial<SmsfHoldingInput>, supabase: SupabaseClient) {
  return supabase
    .from('smsf_holdings')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', holdingId)
    .eq('user_id', userId)
    .select()
    .single();
}

export async function archiveSmsfHolding(holdingId: string, userId: string, supabase: SupabaseClient) {
  return supabase.from('smsf_holdings').update({ is_active: false }).eq('id', holdingId).eq('user_id', userId).select().single();
}

export async function listSmsfMembers(fundId: string, userId: string, supabase: SupabaseClient) {
  return supabase
    .from('smsf_fund_members')
    .select('*, retirement_members(id, member_type)')
    .eq('smsf_fund_id', fundId)
    .eq('user_id', userId);
}

export async function upsertSmsfMember(fundId: string, userId: string, input: SmsfMemberInput, supabase: SupabaseClient) {
  return supabase
    .from('smsf_fund_members')
    .upsert(
      { smsf_fund_id: fundId, user_id: userId, ...input, updated_at: new Date().toISOString() },
      { onConflict: 'smsf_fund_id,retirement_member_id' }
    )
    .select()
    .single();
}

/**
 * SMSF-5: link a liability as this fund's property loan, reusing the
 * certified property_liability_links table (migration 0078) exactly as
 * designed — link_type='smsf_property_loan' and linked_retirement_id were
 * both already reserved in that migration for this purpose. Fund-level
 * granularity (not per-holding): the link attaches to the fund's own
 * retirement_accounts row, matching how the spec's own worked example
 * aggregates Detailed Holdings at the fund level. A fund with more than one
 * mortgaged property cannot be distinguished at the individual-holding
 * level through this mechanism alone in this release — a disclosed,
 * honest limitation (see final report), not a silent gap.
 */
export async function linkSmsfPropertyLoan(
  fundId: string,
  userId: string,
  liabilityId: string,
  supabase: SupabaseClient
) {
  const { data: fund, error: fundErr } = await getSmsfFund(fundId, supabase);
  if (fundErr || !fund) return { data: null, error: fundErr ?? new Error('fund not found') };

  return supabase
    .from('property_liability_links')
    .insert({
      user_id: userId,
      linked_retirement_id: fund.retirement_account_id,
      liability_id: liabilityId,
      link_type: 'smsf_property_loan',
    })
    .select()
    .single();
}

export async function unlinkSmsfPropertyLoan(linkId: string, userId: string, supabase: SupabaseClient) {
  return supabase.from('property_liability_links').update({ is_active: false }).eq('id', linkId).eq('user_id', userId).select().single();
}

/**
 * List this fund's active SMSF-property-loan links, joined with the
 * canonical liability row (name/balance/currency) for display — the UI
 * reads the liability's own balance/currency straight through here, it is
 * never re-stored on the link itself (spec s.22-24, migration 0078).
 */
export async function listSmsfPropertyLoanLinks(fundId: string, userId: string, supabase: SupabaseClient) {
  const { data: fund, error: fundErr } = await getSmsfFund(fundId, supabase);
  if (fundErr || !fund) return { data: null, error: fundErr ?? new Error('fund not found') };

  return supabase
    .from('property_liability_links')
    .select('id, liability_id, allocation_percent, is_active, liabilities(id, liability_name, balance, currency_code)')
    .eq('user_id', userId)
    .eq('linked_retirement_id', fund.retirement_account_id)
    .eq('link_type', 'smsf_property_loan')
    .eq('is_active', true);
}

// ---------------------------------------------------------------------------
// LR-6 — P&L / cash flow / contribution reconciliation read paths.
//
// These are pure additional READS over data this file (and LR-5) already
// established as canonical: owner='smsf' income_sources/expense_items rows,
// the fund's linked property-loan liability (full economic fields this
// time, not just the display subset listSmsfPropertyLoanLinks needed), and
// the fund's own linked retirement_accounts row's contribution columns. No
// new table, no new write path.
// ---------------------------------------------------------------------------

/** owner='smsf' income_sources rows for this household — same discriminator LR-FI-1 established. */
export async function listSmsfOwnedIncome(userId: string, supabase: SupabaseClient) {
  return supabase
    .from('income_sources')
    .select('source_name, amount, net_amount, frequency, master_item_key, employer_name, owner')
    .eq('user_id', userId)
    .eq('is_active', true)
    .eq('owner', 'smsf');
}

/** owner='smsf' expense_items rows for this household — same discriminator LR-FI-1 established. */
export async function listSmsfOwnedExpenses(userId: string, supabase: SupabaseClient) {
  return supabase
    .from('expense_items')
    .select('expense_name, amount, frequency, is_essential, master_item_key, expense_category, owner')
    .eq('user_id', userId)
    .eq('is_active', true)
    .eq('owner', 'smsf');
}

/**
 * This fund's linked property-loan liability, with the full economic fields
 * the P&L/cash-flow engines need (balance, interest_rate, monthly_repayment,
 * debt_type, master_item_key) — a fund-scoped query, never household-wide,
 * so a household's OTHER (non-SMSF) liabilities can never leak into an SMSF
 * P&L by construction.
 */
export async function listSmsfPropertyLoanLiabilitiesForPnl(fundId: string, userId: string, supabase: SupabaseClient) {
  const { data: fund, error: fundErr } = await getSmsfFund(fundId, supabase);
  if (fundErr || !fund) return { data: null, error: fundErr ?? new Error('fund not found') };

  return supabase
    .from('property_liability_links')
    .select(
      'id, liability_id, is_active, liabilities(id, liability_name, balance, interest_rate, monthly_repayment, debt_type, master_item_key, currency_code)'
    )
    .eq('user_id', userId)
    .eq('linked_retirement_id', fund.retirement_account_id)
    .eq('link_type', 'smsf_property_loan')
    .eq('is_active', true);
}

/** The fund's own linked retirement_accounts row's contribution columns (see smsfContributions.ts). */
export async function getSmsfFundContributionSource(fundId: string, userId: string, supabase: SupabaseClient) {
  const { data: fund, error: fundErr } = await getSmsfFund(fundId, supabase);
  if (fundErr || !fund) return { data: null, error: fundErr ?? new Error('fund not found') };
  if (fund.user_id !== userId) return { data: null, error: new Error('not found') };

  return supabase
    .from('retirement_accounts')
    .select('employer_contribution, personal_contribution, contribution_frequency')
    .eq('id', fund.retirement_account_id)
    .single();
}
