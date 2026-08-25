import type { SupabaseClient } from '@supabase/supabase-js';
import type { SmsfFundCreateInput, SmsfFundUpdateInput, SmsfHoldingInput, SmsfMemberInput } from '@/lib/validation/smsf';

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
    p_summary_balance: input.summary_balance,
    p_summary_balance_date: input.summary_balance_date ?? null,
    p_owner: input.owner,
    p_currency_code: input.currency_code,
    p_country_code: input.country_code,
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
 * The hard SMSF-6 mode-switch gate, via the smsf_switch_to_detailed() RPC.
 * Raises (and this rejects) if the computed Detailed net value doesn't
 * match the Summary balance to the cent -- callers must resolve any
 * variance in Detailed Holdings first, exactly per spec s.24 steps 5-7.
 */
export async function switchSmsfFundToDetailed(fundId: string, supabase: SupabaseClient) {
  return supabase.rpc('smsf_switch_to_detailed', { p_fund_id: fundId });
}

/**
 * Detailed -> Summary switch-back (spec s.32-33, migration 0089). Detailed
 * holdings are never touched by this call -- they remain in the database,
 * simply no longer the fund's active valuation source (see the RPC's own
 * SQL comment). Requires a new Summary value + valuation date, matching the
 * spec's explicit "require/confirm" language.
 */
export async function switchSmsfFundToSummary(
  fundId: string,
  newBalance: number,
  newDate: string,
  supabase: SupabaseClient
) {
  return supabase.rpc('smsf_switch_to_summary', {
    p_fund_id: fundId,
    p_new_summary_balance: newBalance,
    p_new_summary_balance_date: newDate,
  });
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
