import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * THE SMSF CONTRIBUTION INTERFACE (DOCUMENT2 (4) review, WP-C, agreed with WP-D Retirement).
 *
 * A contribution is a FLOW, never a balance, and never changes the fund's net (the net is derived from the fund's assets and liabilities).
 * WP-D owns the contribution ledger (retirement_contributions, migration 0304) and the payslip and manual entry that write to it. WP-C owns the
 * SMSF side, which is exactly two small things:
 *
 *   1. DESTINATIONS. `listSmsfContributionDestinations` names the funds a contribution can go to: the fund, its Retirement account row
 *      (the fund's own row, master item key smsf) and the members. WP-D's default provider reads smsf_funds directly and returns the same shape,
 *      so either side can be swapped for the other without a change here.
 *   2. HISTORY. `loadSmsfContributionHistory` READS the ledger rows whose destination kind is smsf and whose status is active, for the SMSF
 *      screens. It never writes, and it never ADDS the fund account's own contribution columns on top: WP-D derives those two columns FROM the
 *      ledger (this is what the existing SMSF contribution reconciliation reads), so adding both would count a contribution twice. The totals
 *      shown by the SMSF reports stay on those derived columns, the list below is evidence of what they are made of.
 *
 * Until WP-D's migration is applied the ledger table does not exist: the history is then `unavailable` and the screens simply show nothing extra.
 */

export interface SmsfContributionDestination {
  fundId: string;
  /** The fund's own row in the Retirement register (master item key smsf), the account a contribution is recorded against. */
  retirementAccountId: string;
  fundName: string;
  currency: string;
  /** retirement_members ids that hold an interest in the fund (smsf_fund_members). */
  memberIds: string[];
}

export async function listSmsfContributionDestinations(userId: string, client: SupabaseClient): Promise<SmsfContributionDestination[]> {
  const { data: funds, error } = await client
    .from('smsf_funds')
    .select('id, fund_name, currency_code, retirement_account_id')
    .eq('user_id', userId)
    .eq('is_active', true);
  if (error || !funds) return [];
  const { data: members } = await client.from('smsf_fund_members').select('smsf_fund_id, retirement_member_id').eq('user_id', userId);
  return funds.map((f) => ({
    fundId: f.id as string,
    retirementAccountId: f.retirement_account_id as string,
    fundName: f.fund_name as string,
    currency: (f.currency_code as string) ?? 'AUD',
    memberIds: (members ?? []).filter((m) => m.smsf_fund_id === f.id).map((m) => m.retirement_member_id as string),
  }));
}

export interface SmsfContributionEntry {
  id: string;
  contributionType: string;
  amount: number;
  currency: string;
  frequency: string | null;
  contributionDate: string | null;
  /** manual or payslip, so the screen can show where it came from. */
  source: string;
  employerName: string | null;
  memberId: string | null;
}

export type SmsfContributionHistory = { status: 'ok'; entries: SmsfContributionEntry[] } | { status: 'unavailable'; reason: string };

/** Active ledger rows for one fund's Retirement account whose destination kind is smsf. Read only, owner only. */
export async function loadSmsfContributionHistory(userId: string, retirementAccountId: string, client: SupabaseClient): Promise<SmsfContributionHistory> {
  const { data, error } = await client
    .from('retirement_contributions')
    .select('id, contribution_type, amount, currency_code, frequency, contribution_date, source_type, employer_name, retirement_member_id')
    .eq('user_id', userId)
    .eq('retirement_account_id', retirementAccountId)
    .eq('destination_kind', 'smsf')
    .eq('status', 'active')
    .order('created_at', { ascending: false });
  if (error) return { status: 'unavailable', reason: error.message };
  return {
    status: 'ok',
    entries: (data ?? []).map((r) => ({
      id: r.id as string,
      contributionType: r.contribution_type as string,
      amount: Number(r.amount),
      currency: r.currency_code as string,
      frequency: (r.frequency as string | null) ?? null,
      contributionDate: (r.contribution_date as string | null) ?? null,
      source: r.source_type as string,
      employerName: (r.employer_name as string | null) ?? null,
      memberId: (r.retirement_member_id as string | null) ?? null,
    })),
  };
}
