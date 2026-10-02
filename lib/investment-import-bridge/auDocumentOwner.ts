/**
 * Owner-before-upload (Phase 2) -- AU investment statements: how the owner chosen
 * BEFORE uploading reaches the canonical `ii_accounts` row.
 *
 * Lives in the investment-import bridge (not the Hub): it reads FDH evidence and writes
 * canonical Investment Intelligence accounts, the one-way direction FDH1_INVESTMENT_BOUNDARY
 * allows. It REUSES the existing allocation model -- `ii_ownership_allocation` through
 * `documentOwner.setAccountOwner` (the same writer the India CAS uses) -- and invents no
 * second owner system.
 *
 *   - Self / Spouse (a household member): the statement's account takes that member as its
 *     owner; a request that names a DIFFERENT member (or `owner_self` for a spouse
 *     statement) is refused, and an absent owner takes the document's.
 *   - Joint: the split the user entered before uploading (basis points, exactly 10000) is
 *     written to the account's allocation group; `owner_member_id` stays NULL, as for a CAS.
 *   - An existing account that already has a DIFFERENT owner is never silently overwritten:
 *     the caller gets a conflict and must confirm explicitly (decision 2).
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { loadAccountOwnership } from '@/lib/services/investment-intelligence/accountOwnership';
import { planAccountOwner, setAccountOwner, signatureOfDocumentOwner, signatureOfOwnership, type DocumentOwner } from '@/lib/services/investment-intelligence/documentOwner';
import { createAuInvestmentAccount, type AuAccountOwnerChoice } from './auAccountResolution';

export interface StoredUploadOwner {
  ownerRole: string;
  ownerMemberId: string | null;
  allocations: Array<{ ownerMemberId?: string; ownerBusinessEntityId?: string; basisPoints: number }> | null;
}

export function toDocumentOwner(stored: StoredUploadOwner): DocumentOwner | null {
  if (stored.ownerRole === 'joint') {
    if (!stored.allocations || stored.allocations.length < 2) return null;
    return { kind: 'joint', ownerRole: 'joint', ownerMemberId: null, ownerBusinessEntityId: null, allocations: stored.allocations.map((a) => ({ ...a })) };
  }
  if (stored.ownerMemberId) return { kind: 'member', ownerRole: stored.ownerRole, ownerMemberId: stored.ownerMemberId, ownerBusinessEntityId: null, allocations: null };
  return null;
}

export type OwnerChoiceGate =
  | { ok: true; choice: AuAccountOwnerChoice | null }
  | { ok: false; status: 409; code: 'owner_differs_from_upload'; message: string };

/** PURE. The document's owner is the default and the lock for a member-owned statement. */
export function gateAuOwnerChoice(stored: StoredUploadOwner | null, requested: AuAccountOwnerChoice | null): OwnerChoiceGate {
  if (!stored) return { ok: true, choice: requested };
  const differs = {
    ok: false as const,
    status: 409 as const,
    code: 'owner_differs_from_upload' as const,
    message: 'This statement was uploaded for a different owner. To change who it belongs to, delete it and upload it again with the right owner.',
  };
  if (stored.ownerRole === 'joint') return requested ? differs : { ok: true, choice: null };
  if (!stored.ownerMemberId) return { ok: true, choice: requested };
  if (!requested) return { ok: true, choice: { memberId: stored.ownerMemberId } };
  if ('memberId' in requested) return requested.memberId === stored.ownerMemberId ? { ok: true, choice: requested } : differs;
  return stored.ownerRole === 'self' ? { ok: true, choice: requested } : differs; // owner_self means "me": only the Self statement
}

/** Creates the account for a JOINT statement (no single member owner) and writes its split. */
export async function confirmNewAuJointAccount(
  userId: string,
  statementId: string,
  stored: StoredUploadOwner,
  input: { institutionName: string; maskedAccountIdentifier: string | null; currencyCode: string },
): Promise<{ accountId: string | null; error: string | null }> {
  const owner = toDocumentOwner(stored);
  if (!owner || owner.kind !== 'joint') return { accountId: null, error: 'This statement has no valid joint split.' };
  const admin = createAdminClient();
  const { data: statement } = await admin.from('fdh_investment_statements').select('id').eq('id', statementId).eq('user_id', userId).maybeSingle();
  if (!statement) return { accountId: null, error: 'Statement not found.' };
  const created = await createAuInvestmentAccount(userId, { ...input, ownerMemberId: null });
  if (!created.accountId) return created;
  const set = await setAccountOwner(userId, created.accountId, owner, false, admin);
  if (!set.ok) return { accountId: null, error: set.error };
  const { error } = await admin.from('fdh_investment_statements').update({ canonical_account_id: created.accountId }).eq('id', statementId).eq('user_id', userId);
  return error ? { accountId: null, error: error.message } : created;
}

export type ExistingAccountOwnerOutcome = 'applied' | 'unchanged' | 'conflict';

/**
 * An EXISTING account for a statement with a chosen owner: fill an empty owner, leave an equal
 * one, and report a DIFFERENT one as a conflict (never overwritten without `confirm`).
 */
export async function applyUploadOwnerToExistingAuAccount(userId: string, accountId: string, stored: StoredUploadOwner, confirm: boolean): Promise<ExistingAccountOwnerOutcome> {
  const owner = toDocumentOwner(stored);
  if (!owner) return 'unchanged';
  const admin = createAdminClient();
  const loaded = await loadAccountOwnership(admin, userId, accountId);
  const existing = loaded ? signatureOfOwnership(loaded.ownership) : null;
  const plan = planAccountOwner(existing, signatureOfDocumentOwner(owner));
  if (plan === 'noop') return 'unchanged';
  if (plan === 'conflict' && !confirm) return 'conflict';
  const set = await setAccountOwner(userId, accountId, owner, false, admin);
  return set.ok ? 'applied' : 'conflict';
}
