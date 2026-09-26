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
 * Who holds the account (canonical-upload WP-12, INV-G10 / FDH-15 / PO D-10).
 * Investment Intelligence records the holder as a `household_members` row;
 * without one a position can never be certified or published
 * (OWNER_UNRESOLVED). `self` resolves to the user's own member row, creating
 * it (named from the profile) when the household has none yet -- a first-time
 * user must be able to finish the journey. A member id is accepted only when
 * it belongs to this same user.
 */
export type AuAccountOwnerChoice = { memberId: string } | { self: true };

export async function resolveAuAccountOwnerMember(userId: string, owner: AuAccountOwnerChoice): Promise<{ memberId: string | null; error: string | null }> {
  const admin = createAdminClient();
  if ('memberId' in owner) {
    const { data } = await admin.from('household_members').select('id, is_active').eq('id', owner.memberId).eq('user_id', userId).maybeSingle();
    if (!data || data.is_active === false) return { memberId: null, error: 'That household member was not found.' };
    return { memberId: data.id as string, error: null };
  }
  const { data: existing } = await admin
    .from('household_members')
    .select('id')
    .eq('user_id', userId)
    .eq('relationship', 'self')
    .eq('is_active', true)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existing) return { memberId: existing.id as string, error: null };
  const { data: profile } = await admin.from('user_profiles').select('full_name').eq('user_id', userId).maybeSingle();
  const fullName = ((profile?.full_name as string | null) ?? '').trim() || 'Me';
  const { data: created, error } = await admin.from('household_members').insert({ user_id: userId, full_name: fullName, relationship: 'self' }).select('id').single();
  if (error || !created) return { memberId: null, error: error?.message ?? 'Could not record you as the account holder.' };
  return { memberId: created.id as string, error: null };
}

/**
 * Confirm ADD NEW for a statement's account (spec section 45) — creates a
 * new `ii_accounts` row and persists it as the statement's
 * `canonical_account_id`, ONLY on this explicit call. WP-12 (INV-G10): the
 * holder is REQUIRED -- the account used to be created with no owner, which
 * blocked certification and publication for good.
 */
export async function confirmNewAuStatementAccount(
  userId: string,
  statementId: string,
  input: { institutionName: string; maskedAccountIdentifier: string | null; currencyCode: string; owner: AuAccountOwnerChoice },
): Promise<{ accountId: string | null; error: string | null }> {
  const admin = createAdminClient();
  const { data: statement, error: stmtErr } = await admin.from('fdh_investment_statements').select('id, user_id').eq('id', statementId).eq('user_id', userId).maybeSingle();
  if (stmtErr || !statement) return { accountId: null, error: stmtErr?.message ?? 'Statement not found.' };

  const owner = await resolveAuAccountOwnerMember(userId, input.owner);
  if (!owner.memberId) return { accountId: null, error: owner.error };

  const created = await createAuInvestmentAccount(userId, { ...input, ownerMemberId: owner.memberId });
  if (created.accountId) {
    const { error } = await admin.from('fdh_investment_statements').update({ canonical_account_id: created.accountId }).eq('id', statementId).eq('user_id', userId);
    if (error) return { accountId: null, error: error.message };
  }
  return created;
}

/**
 * The user picks ONE of the candidates an ambiguous match offered (spec
 * section 46: ambiguity is resolved by the user, never auto-picked). The
 * account must be this user's own active AU account. Optionally records the
 * holder when the account has none yet.
 */
export async function confirmExistingAuStatementAccount(
  userId: string,
  statementId: string,
  accountId: string,
  owner?: AuAccountOwnerChoice,
): Promise<{ accountId: string | null; error: string | null }> {
  const admin = createAdminClient();
  const { data: statement } = await admin.from('fdh_investment_statements').select('id').eq('id', statementId).eq('user_id', userId).maybeSingle();
  if (!statement) return { accountId: null, error: 'Statement not found.' };
  const { data: account } = await admin.from('ii_accounts').select('id, owner_member_id').eq('id', accountId).eq('user_id', userId).eq('country_code', 'AU').eq('status', 'active').maybeSingle();
  if (!account) return { accountId: null, error: 'That investment account was not found.' };
  if (owner && !account.owner_member_id) {
    const set = await setAuAccountOwner(userId, accountId, owner);
    if (set.error) return { accountId: null, error: set.error };
  }
  const { error } = await admin.from('fdh_investment_statements').update({ canonical_account_id: accountId }).eq('id', statementId).eq('user_id', userId);
  if (error) return { accountId: null, error: error.message };
  return { accountId, error: null };
}

export interface AuAccountDescription {
  accountId: string;
  institutionName: string | null;
  maskedAccountIdentifier: string | null;
  ownerRecorded: boolean;
}

/** Display facts for the user's own AU accounts (institution + masked id only). */
export async function describeAuAccounts(userId: string, accountIds: readonly string[]): Promise<AuAccountDescription[]> {
  if (accountIds.length === 0) return [];
  const admin = createAdminClient();
  const { data } = await admin
    .from('ii_accounts')
    .select('id, institution_name, account_number_masked, owner_member_id')
    .eq('user_id', userId)
    .eq('country_code', 'AU')
    .in('id', [...accountIds]);
  return ((data ?? []) as { id: string; institution_name: string | null; account_number_masked: string | null; owner_member_id: string | null }[]).map((a) => ({
    accountId: a.id,
    institutionName: a.institution_name,
    maskedAccountIdentifier: a.account_number_masked,
    ownerRecorded: Boolean(a.owner_member_id),
  }));
}

/** Records the holder of an existing AU account that has none (INV-G10). */
export async function setAuAccountOwner(userId: string, accountId: string, owner: AuAccountOwnerChoice): Promise<{ memberId: string | null; error: string | null }> {
  const admin = createAdminClient();
  const resolved = await resolveAuAccountOwnerMember(userId, owner);
  if (!resolved.memberId) return resolved;
  const { data, error } = await admin.from('ii_accounts').update({ owner_member_id: resolved.memberId }).eq('id', accountId).eq('user_id', userId).eq('country_code', 'AU').select('id');
  if (error) return { memberId: null, error: error.message };
  if (!data || data.length === 0) return { memberId: null, error: 'That investment account was not found.' };
  return resolved;
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
