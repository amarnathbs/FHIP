/**
 * FDH-12 — resolving a retirement statement to a CANONICAL retirement account
 * and household member (spec sections 14-19, 112, 132).
 *
 * ============================================================================
 * WHY THIS FILE LIVES OUTSIDE `lib/financial-data-hub/`
 * ============================================================================
 *
 * FDH-1's isolation contract, enforced mechanically by
 * `tests/unit/fdh1Isolation.test.ts`, forbids ANY file under
 * `lib/financial-data-hub/` from naming or querying a protected Input Data
 * register — and `retirement_accounts` is one of the seven
 * (`FHIP_PROTECTED_INPUT_TABLES` in `lib/financial-data-hub/constants/
 * tables.ts`). Account matching necessarily READS canonical Retirement, so it
 * cannot live in the Hub.
 *
 * This is not a workaround; it is the established shape. FDH-9 put its
 * canonical-touching code in `lib/import-bridge/`, and FDH-11 put its in
 * `lib/investment-import-bridge/` for exactly this reason (see that module's
 * own header and `docs/financial-data-hub/FDH11_INVESTMENT_INTELLIGENCE_
 * BRIDGE.md`). FDH-12 follows the same split:
 *
 *   lib/financial-data-hub/retirement/   PURE evidence logic. Parsing,
 *                                        classification, reconciliation,
 *                                        dedup, payslip/bank/rollover
 *                                        matching. Touches `fdh_*` only.
 *   lib/retirement-import-bridge/        THIS layer. Reads canonical
 *                                        Retirement to resolve a match.
 *   lib/import-bridge/                   The generic proposal/apply bridge.
 *                                        The only thing that WRITES canonical
 *                                        Retirement, and only via
 *                                        `fdh12_apply_retirement_proposal()`.
 *
 * ============================================================================
 * MATCHING IS NOT APPLYING (spec section 56)
 * ============================================================================
 *
 * This file READS `retirement_accounts` and `retirement_members`, and WRITES
 * only the FDH-12 statement row's own match state. It performs no canonical
 * mutation of any kind — no insert, no update, no upsert on either table.
 * `tests/unit/fdh12Isolation.test.ts` asserts that mechanically.
 */

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchAllRows } from '@/lib/financial-data-hub/bank-csv/pagination';
import { recordDocumentAuditEvent } from '@/lib/financial-data-hub/services/auditLog';
import { refreshActivityFingerprints } from '@/lib/financial-data-hub/services/retirementStatementProcessingService';
import {
  matchRetirementAccount,
  resolveRetirementMember,
  type ExistingRetirementAccountRow,
  type PriorStatementIdentifiers,
  type RetirementMemberRow,
} from '@/lib/financial-data-hub/retirement/accountMatching';
import type { RetirementJurisdiction } from '@/lib/financial-data-hub/retirement/types';

export interface RetirementAccountResolutionResult {
  status: string;
  accountId: string | null;
  memberId: string | null;
  error: string | null;
}

export interface RetirementAccountResolutionOptions {
  userConfirmedAccountId?: string | null;
  userConfirmedMemberId?: string | null;
  confirmNewAccount?: boolean;
}

export async function resolveRetirementStatementAccount(
  userId: string,
  statementId: string,
  opts: RetirementAccountResolutionOptions = {},
): Promise<RetirementAccountResolutionResult> {
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: stmt } = await supabase
    .from('fdh_retirement_statements')
    .select('id, currency_code, retirement_jurisdiction, fund_name, masked_account_identifier, account_type, smsf_classification')
    .eq('id', statementId).eq('user_id', userId).maybeSingle();
  if (!stmt) return { status: 'not_attempted', accountId: null, memberId: null, error: 'statement not found' };

  // An SMSF statement is never matched to an ordinary super account
  // (spec sections 10-11). Terminal for FDH-12.
  if (stmt.smsf_classification !== 'not_smsf') {
    return { status: 'not_attempted', accountId: null, memberId: null, error: 'routed_to_smsf' };
  }

  // --- Member resolution first: it narrows the account pool (spec 15, 17) ---
  const { data: memberRows } = await supabase
    .from('retirement_members')
    .select('id, member_type')
    .eq('user_id', userId)
    .eq('is_active', true);
  const members: RetirementMemberRow[] = (memberRows ?? []).map((m) => ({
    id: m.id as string,
    member_type: m.member_type as 'self' | 'spouse',
  }));
  const memberResolution = resolveRetirementMember(members, {
    userConfirmedMemberId: opts.userConfirmedMemberId ?? null,
  });

  // ADD NEW (spec section 19). No canonical row is created HERE — that happens
  // only at Apply, through `fdh12_apply_retirement_proposal()`, never by a
  // direct client insert (spec section 103).
  if (opts.confirmNewAccount) {
    await admin.from('fdh_retirement_statements')
      .update({
        account_match_status: 'new_account_confirmed',
        canonical_account_id: null,
        retirement_member_id: memberResolution.memberId,
        account_match_candidates: null,
      })
      .eq('id', statementId).eq('user_id', userId);
    await recordDocumentAuditEvent({
      userId, documentId: statementId,
      eventType: 'retirement_statement_account_matched', actorType: 'user',
      metadata: { outcome: 'new_account_confirmed' },
    });
    return { status: 'new_account_confirmed', accountId: null, memberId: memberResolution.memberId, error: null };
  }

  // PAGINATION (spec sections 139-140): a household with more than 1000
  // retirement accounts would otherwise be silently truncated, producing a
  // wrong "no match" rather than an error.
  const accounts = await fetchAllRows(() =>
    supabase
      .from('retirement_accounts')
      .select('id, account_name, account_type, currency_code, country_code, owner, master_item_key, retirement_member_id, updated_at')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('id', { ascending: true }));

  if (opts.userConfirmedAccountId) {
    // UI CONFIRMATION IS NOT AUTHORISATION. Ownership and the SMSF exclusion
    // are re-verified here even though the user asked for this account
    // explicitly, and the `accounts` read was already scoped to the user, so a
    // forged id from another tenant is simply not present.
    const chosen = (accounts ?? []).find((a) => a.id === opts.userConfirmedAccountId);
    if (!chosen) {
      return { status: 'no_match', accountId: null, memberId: memberResolution.memberId, error: 'account not found' };
    }
    if (chosen.master_item_key === 'smsf') {
      return { status: 'no_match', accountId: null, memberId: memberResolution.memberId, error: 'smsf_account_not_importable' };
    }
    await admin.from('fdh_retirement_statements')
      .update({
        account_match_status: 'matched',
        canonical_account_id: chosen.id,
        retirement_member_id: memberResolution.memberId,
        account_match_candidates: null,
      })
      .eq('id', statementId).eq('user_id', userId);
    await recordDocumentAuditEvent({
      userId, documentId: statementId,
      eventType: 'retirement_statement_account_matched', actorType: 'user',
      metadata: { outcome: 'user_selected', accountId: chosen.id },
    });
    await refreshActivityFingerprints(userId, statementId, chosen.id as string);
    return { status: 'matched', accountId: chosen.id as string, memberId: memberResolution.memberId, error: null };
  }

  // Masked identifiers previously seen against each account, assembled from
  // prior statements — canonical Retirement has no masked-identifier column of
  // its own (a documented gap; see FDH12_REUSE_AND_GAP_AUDIT.md).
  const priorStatements = await fetchAllRows(() =>
    supabase
      .from('fdh_retirement_statements')
      .select('canonical_account_id, masked_account_identifier')
      .eq('user_id', userId)
      .not('canonical_account_id', 'is', null)
      .not('masked_account_identifier', 'is', null)
      .order('canonical_account_id', { ascending: true }));
  const priorIdentifiers: PriorStatementIdentifiers = (priorStatements ?? []).reduce(
    (map: Map<string, Set<string>>, row) => {
      const key = row.canonical_account_id as string;
      const set = map.get(key) ?? new Set<string>();
      set.add(row.masked_account_identifier as string);
      map.set(key, set);
      return map;
    },
    new Map<string, Set<string>>(),
  );

  const result = matchRetirementAccount(
    {
      jurisdiction: stmt.retirement_jurisdiction as RetirementJurisdiction,
      currencyCode: stmt.currency_code as string,
      fundName: (stmt.fund_name as string | null) ?? null,
      maskedAccountIdentifier: (stmt.masked_account_identifier as string | null) ?? null,
      accountType: stmt.account_type as never,
      retirementMemberId: memberResolution.memberId,
    },
    (accounts ?? []) as unknown as ExistingRetirementAccountRow[],
    priorIdentifiers,
  );

  await admin.from('fdh_retirement_statements')
    .update({
      account_match_status: result.status,
      canonical_account_id: result.accountId,
      retirement_member_id: memberResolution.memberId,
      account_match_candidates: result.candidates.length > 0
        ? { reason: result.reason, candidates: result.candidates } : null,
      review_status: result.status === 'matched' ? 'not_required' : 'pending',
    })
    .eq('id', statementId).eq('user_id', userId);

  await recordDocumentAuditEvent({
    userId, documentId: statementId,
    eventType: 'retirement_statement_account_matched', actorType: 'system',
    metadata: { outcome: result.status, reason: result.reason, candidateCount: result.candidates.length },
  });

  if (result.accountId) await refreshActivityFingerprints(userId, statementId, result.accountId);

  return { status: result.status, accountId: result.accountId, memberId: memberResolution.memberId, error: null };
}
