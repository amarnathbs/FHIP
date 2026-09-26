/**
 * WP-08 (EXP-G13 capture, PO D-10): whose account an imported statement
 * belongs to -- you, your partner, joint, or your SMSF -- captured at upload
 * and stored on `fdh_financial_accounts.owner_role` (migration 0207). The
 * canonical read models use it: an SMSF account's lines are the fund's, never
 * household spending; a joint account counts 100% to the household.
 *
 * The choice is the user's explicit answer on the upload form, so it is
 * written whether the account was just created or matched to an existing
 * one (an account's owner is a property of the account, not of one
 * statement). Writing it never fails an upload: on a database without 0207
 * the column does not exist yet and the result says `unavailable`.
 */

import { financialAccountsRepository } from '../repositories';
import type { FdhAccountOwnerRole } from '../validation/bankCsv';

export type AccountOwnerWrite = 'recorded' | 'not_provided' | 'unavailable' | 'failed';

export function isMissingOwnerColumnError(message: string | null | undefined): boolean {
  return /owner_role/.test(message ?? '') && /(column|schema cache|does not exist)/i.test(message ?? '');
}

export async function recordAccountOwner(
  userId: string,
  accountId: string | null,
  ownerRole: FdhAccountOwnerRole | null | undefined,
): Promise<AccountOwnerWrite> {
  if (!ownerRole) return 'not_provided';
  if (!accountId) return 'failed';
  const { data, error } = await financialAccountsRepository.update(userId, accountId, { owner_role: ownerRole } as never);
  if (error) return isMissingOwnerColumnError(error.message) ? 'unavailable' : 'failed';
  return data ? 'recorded' : 'failed';
}
