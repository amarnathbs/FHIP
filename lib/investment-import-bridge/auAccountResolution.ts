/**
 * FDH-11 bridge — AU investment account resolution against canonical
 * `ii_accounts` (spec sections 43-46, 90).
 *
 * Deliberately does NOT reuse
 * `lib/services/investment-intelligence/accountResolution.ts`'s
 * `resolveOrCreateAccount` — that function auto-CREATES a new account
 * whenever no folio match is found, with no ambiguity detection at all
 * (correct for its own R2 CAS-statement context, where a registrar-issued
 * folio number is close to a stable identifier). Spec section 46 requires
 * AMBIGUOUS -> REVIEW_REQUIRED for investment ACCOUNTS specifically, and
 * section 45 requires an explicit user confirmation before a new brokerage
 * account is created — silently auto-creating would violate both. This
 * file fetches candidates and delegates the match DECISION to the Hub's own
 * pure `matchAuInvestmentAccount`, then only ever creates a new `ii_accounts`
 * row when the caller has already confirmed ADD NEW.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import {
  matchAuInvestmentAccount,
  type AccountMatchQuery,
  type AccountMatchResult,
  type ExistingAuInvestmentAccountCandidate,
} from '@/lib/financial-data-hub/investment/accountMatching';

export async function fetchAuAccountCandidates(userId: string): Promise<{ candidates: ExistingAuInvestmentAccountCandidate[]; error: string | null }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('ii_accounts')
    .select('id, institution_name, account_number_masked, account_type, currency_code, country_code')
    .eq('user_id', userId)
    .eq('country_code', 'AU')
    .eq('status', 'active');
  if (error) return { candidates: [], error: error.message };
  const candidates: ExistingAuInvestmentAccountCandidate[] = (data ?? []).map((a) => ({
    accountId: a.id as string,
    institutionName: (a.institution_name as string) ?? null,
    maskedAccountIdentifier: (a.account_number_masked as string) ?? null,
    accountType: a.account_type as string,
    currencyCode: a.currency_code as string,
    countryCode: a.country_code as string,
  }));
  return { candidates, error: null };
}

export async function resolveAuInvestmentAccount(userId: string, query: AccountMatchQuery): Promise<AccountMatchResult & { error: string | null }> {
  const { candidates, error } = await fetchAuAccountCandidates(userId);
  if (error) return { outcome: 'no_match', matchedAccountId: null, candidateIds: [], error };
  return { ...matchAuInvestmentAccount(query, candidates), error: null };
}

/**
 * Resolve AND persist the outcome onto `fdh_investment_statements.
 * canonical_account_id` (spec sections 43-46). A `single_match` writes the
 * matched account id; `ambiguous`/`no_match` write nothing and leave the
 * statement's account resolution pending, surfaced to the review UX via the
 * returned outcome — never auto-created, never auto-picked.
 */
export async function resolveAndPersistAuStatementAccount(userId: string, statementId: string, query: AccountMatchQuery): Promise<AccountMatchResult & { error: string | null }> {
  const admin = createAdminClient();
  const { data: statement, error: stmtErr } = await admin.from('fdh_investment_statements').select('id, user_id').eq('id', statementId).eq('user_id', userId).maybeSingle();
  if (stmtErr || !statement) return { outcome: 'no_match', matchedAccountId: null, candidateIds: [], error: stmtErr?.message ?? 'Statement not found.' };

  const result = await resolveAuInvestmentAccount(userId, query);
  if (result.outcome === 'single_match' && result.matchedAccountId) {
    await admin.from('fdh_investment_statements').update({ canonical_account_id: result.matchedAccountId }).eq('id', statementId);
  }
  return result;
}

/**
 * Confirm ADD NEW for a statement's account (spec section 45) — creates a
 * new `ii_accounts` row and persists it as the statement's
 * `canonical_account_id`, ONLY on this explicit call.
 */
export async function confirmNewAuStatementAccount(userId: string, statementId: string, input: { institutionName: string; maskedAccountIdentifier: string | null; currencyCode: string }): Promise<{ accountId: string | null; error: string | null }> {
  const admin = createAdminClient();
  const { data: statement, error: stmtErr } = await admin.from('fdh_investment_statements').select('id, user_id').eq('id', statementId).eq('user_id', userId).maybeSingle();
  if (stmtErr || !statement) return { accountId: null, error: stmtErr?.message ?? 'Statement not found.' };

  const created = await createAuInvestmentAccount(userId, input);
  if (created.accountId) {
    await admin.from('fdh_investment_statements').update({ canonical_account_id: created.accountId }).eq('id', statementId);
  }
  return created;
}

/**
 * Create a new `ii_accounts` row for AU, ONLY called after an explicit
 * ADD NEW confirmation (spec section 45) — never as a fallback from
 * `resolveAuInvestmentAccount` itself.
 */
export async function createAuInvestmentAccount(userId: string, input: {
  institutionName: string;
  maskedAccountIdentifier: string | null;
  currencyCode: string;
  ownerMemberId?: string | null;
}): Promise<{ accountId: string | null; error: string | null }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('ii_accounts')
    .insert({
      user_id: userId,
      account_type: 'broker',
      institution_name: input.institutionName,
      country_code: 'AU',
      currency_code: input.currencyCode,
      account_number_masked: input.maskedAccountIdentifier,
      owner_member_id: input.ownerMemberId ?? null,
      status: 'active',
    })
    .select('id')
    .single();
  if (error || !data) return { accountId: null, error: error?.message ?? 'Account creation failed' };
  return { accountId: data.id as string, error: null };
}
