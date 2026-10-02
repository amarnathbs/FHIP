/**
 * Owner-before-upload (Phase 1) -- bank statements: how the owner the user
 * chose BEFORE uploading is attributed.
 *
 * TWO PLACES THE OWNER LIVES, AND WHY BOTH
 *   - fdh_statement_uploads.owner_* (migration 0230+): the owner of THIS
 *     DOCUMENT, exactly as chosen. Written for every upload, so "whose
 *     statement was this" never has to be inferred from an account.
 *   - fdh_financial_accounts.owner_role (0207): the owner of the ACCOUNT. The
 *     canonical read models read this one (an SMSF account's lines are the
 *     fund's, never household spending).
 *
 * THE ACCOUNT OWNER IS NEVER SILENTLY OVERWRITTEN (PO decision 2).
 * Before this change every upload wrote the chosen owner onto the matched
 * account unconditionally -- uploading a statement as "Mine" against an account
 * recorded as "My SMSF's" quietly moved the account (and every line already
 * imported for it) between household spending and the fund. Now:
 *   - account has no owner yet           -> set it (nothing to overwrite);
 *   - account owner equals the choice    -> nothing to do;
 *   - account owner DIFFERS              -> the upload is stopped BEFORE
 *     anything is stored (BankOwnerConflictError, HTTP 409
 *     `account_owner_conflict`), naming both owners. The user either keeps the
 *     account's owner (re-sends with that owner) or explicitly confirms the
 *     change (re-sends with confirm_owner_change=1). Default = keep.
 *
 * Writing the owner never fails an upload on a database that predates the
 * migration: the owner columns are written in their own update, tolerant of a
 * missing column, so the account link and period (the existing, load-bearing
 * update) can never be lost to a schema that is one migration behind.
 */

import { financialAccountsRepository, statementUploadsRepository } from '../repositories';
import { loadExistingAccountsForInstitutionCurrency } from '../bank-csv/repository';
import { normaliseMaskedIdentifier, resolveAccountIdentity } from '../bank-csv/accountIdentity';
import { sha256Hex } from '../domain/fileValidation';
import { FDH_ACCOUNT_OWNER_ROLES, type BankCsvUploadMetadataInput, type FdhAccountOwnerRole } from '../validation/bankCsv';
import { createAdminClient } from '@/lib/supabase/admin';
import type { ResolvedOwner } from '@/lib/ownership/validateOwnerSelection';

export type BankOwnerWrite = 'recorded' | 'unchanged' | 'kept_existing' | 'unavailable' | 'failed';

/** The outcome reported when a caller supplied no owner (the AIE bank intake
 * path, a later phase). */
export const NO_OWNER_OUTCOME = { account: 'no_account', document: 'unavailable' } as const;

/** What the bank flow stores: the validated owner, narrowed to what bank can carry. */
export interface BankUploadOwner {
  ownerRole: FdhAccountOwnerRole;
  ownerMemberId: string | null;
  label: string;
}

export interface BankUploadOptions {
  /** The user explicitly confirmed changing an existing account's owner. */
  confirmOwnerChange?: boolean;
}

/** Narrows a validated owner to the bank shape. Throws if validateOwnerSelection
 * let through something bank cannot store -- that would be a policy bug, and it
 * must be loud, not a silent coercion. */
export function toBankUploadOwner(owner: ResolvedOwner): BankUploadOwner {
  if (!(FDH_ACCOUNT_OWNER_ROLES as readonly string[]).includes(owner.ownerRole) || owner.ownerBusinessEntityId) {
    throw new Error(`bank upload cannot carry owner role '${owner.ownerRole}'`);
  }
  return { ownerRole: owner.ownerRole as FdhAccountOwnerRole, ownerMemberId: owner.ownerMemberId, label: owner.label };
}

const ROLE_LABEL: Record<string, string> = { self: 'yours', spouse: 'your partner’s', joint: 'joint', smsf: 'your SMSF’s' };
export function describeAccountOwnerRole(role: string | null | undefined): string {
  return role ? ROLE_LABEL[role] ?? role : 'not set';
}

export class BankOwnerConflictError extends Error {
  readonly code = 'account_owner_conflict' as const;
  constructor(
    readonly existingOwnerRole: string,
    readonly selectedOwnerRole: string,
    readonly accountId: string,
  ) {
    super(
      `This statement matches an account that is recorded as ${describeAccountOwnerRole(existingOwnerRole)}, but you chose ${describeAccountOwnerRole(selectedOwnerRole)}. ` +
        'Nothing has been uploaded. Keep the account as it is, or confirm that you want to change its owner.',
    );
    this.name = 'BankOwnerConflictError';
  }
}

export class BankIdenticalUploadOwnerConflictError extends Error {
  readonly code = 'identical_upload_different_owner' as const;
  constructor(
    readonly existingDocumentId: string,
    readonly existingOwnerRole: string | null,
    readonly selectedOwnerRole: string,
  ) {
    super(
      `This exact file was already uploaded${existingOwnerRole ? `, recorded as ${describeAccountOwnerRole(existingOwnerRole)}` : ''}. ` +
        `You chose ${describeAccountOwnerRole(selectedOwnerRole)} this time. It was not uploaded again. ` +
        'If the first upload had the wrong owner, delete that statement and upload it again; otherwise choose the same owner as before.',
    );
    this.name = 'BankIdenticalUploadOwnerConflictError';
  }
}

/** PURE. What to do with an account's owner given the user's choice. */
export function decideAccountOwnerWrite(
  existingRole: string | null | undefined,
  selectedRole: string,
  confirmOwnerChange: boolean,
): 'write' | 'noop' | 'conflict' {
  if (!existingRole) return 'write';
  if (existingRole === selectedRole) return 'noop';
  return confirmOwnerChange ? 'write' : 'conflict';
}

function isMissingColumn(message: string | null | undefined): boolean {
  return /owner_(role|member_id|business_entity_id|selection_source)/.test(message ?? '') && /(column|schema cache|does not exist)/i.test(message ?? '');
}

/**
 * Runs BEFORE anything is stored. Throws BankOwnerConflictError when the file
 * would be matched to an existing account whose recorded owner differs from the
 * choice and the user has not confirmed the change.
 *
 * It mirrors the account resolution the upload performs afterwards (same
 * pure `resolveAccountIdentity`, same inputs), so what is checked here is what
 * would be matched there.
 */
export async function assertNoSilentAccountOwnerChange(
  userId: string,
  metadata: BankCsvUploadMetadataInput,
  owner: BankUploadOwner,
  options: BankUploadOptions,
): Promise<void> {
  const existingAccounts = await loadExistingAccountsForInstitutionCurrency(userId, metadata.institution_id ?? null, metadata.currency_code);
  const decision = resolveAccountIdentity({
    userId,
    institutionId: metadata.institution_id ?? null,
    currencyCode: metadata.currency_code,
    maskedIdentifierNormalised: normaliseMaskedIdentifier(metadata.declared_masked_identifier ?? null),
    existingAccountsForInstitutionAndCurrency: existingAccounts,
  });
  if (decision.outcome !== 'reuse') return;
  const { data: account } = await financialAccountsRepository.getForUser(userId, decision.accountId);
  const existingRole = (account as { owner_role?: string | null } | null)?.owner_role ?? null;
  if (decideAccountOwnerWrite(existingRole, owner.ownerRole, options.confirmOwnerChange === true) === 'conflict') {
    throw new BankOwnerConflictError(existingRole as string, owner.ownerRole, decision.accountId);
  }
}

/**
 * Decision 6: the same bytes uploaded again under a DIFFERENT owner is refused,
 * naming the owner of the first upload -- never silently ignored (which would
 * discard the user's new answer) and never silently reassigned.
 *
 * "Under which owner": the document's own owner (new columns) when it has one,
 * otherwise the account's owner_role for uploads that predate this change.
 * An upload that never got a result (rejected / failed) is not "already
 * uploaded" -- re-uploading it is how a user retries -- and is skipped.
 */
export async function assertNoIdenticalUploadWithDifferentOwner(userId: string, bytes: Uint8Array, owner: BankUploadOwner): Promise<void> {
  const admin = createAdminClient();
  const hash = sha256Hex(bytes);
  const { data: rows } = await admin
    .from('fdh_statement_uploads')
    .select('*')
    .eq('user_id', userId)
    .eq('document_type', 'bank_statement')
    .eq('file_hash', hash)
    .order('created_at', { ascending: true })
    .limit(20);
  const earlier = ((rows ?? []) as Array<Record<string, unknown>>).filter(
    (r) => r.processing_status !== 'failed' && r.processing_status !== 'rejected',
  );
  if (earlier.length === 0) return;

  for (const row of earlier) {
    let existingRole = (row.owner_role as string | null | undefined) ?? null;
    if (!existingRole && row.financial_account_id) {
      const { data: acc } = await admin.from('fdh_financial_accounts').select('*').eq('id', row.financial_account_id as string).eq('user_id', userId).maybeSingle();
      existingRole = ((acc as { owner_role?: string | null } | null)?.owner_role ?? null) as string | null;
    }
    // An earlier copy with no recorded owner anywhere (legacy / unset) cannot
    // contradict the user's choice; only a recorded, different owner does.
    if (existingRole && existingRole !== owner.ownerRole) {
      throw new BankIdenticalUploadOwnerConflictError(row.id as string, existingRole, owner.ownerRole);
    }
  }
}

/**
 * After the account is resolved: record the owner on the account (honouring
 * decision 2) and on the document. Never throws; never touches the update that
 * links the account to the document.
 */
export async function recordBankOwner(params: {
  userId: string;
  documentId: string;
  accountId: string | null;
  owner: BankUploadOwner;
  options: BankUploadOptions;
}): Promise<{ account: BankOwnerWrite | 'no_account'; document: 'recorded' | 'unavailable' | 'failed' }> {
  const { userId, documentId, accountId, owner, options } = params;

  let account: BankOwnerWrite | 'no_account' = 'no_account';
  if (accountId) {
    const { data: existing } = await financialAccountsRepository.getForUser(userId, accountId);
    const existingRole = (existing as { owner_role?: string | null } | null)?.owner_role ?? null;
    const verdict = decideAccountOwnerWrite(existingRole, owner.ownerRole, options.confirmOwnerChange === true);
    if (verdict === 'noop') account = 'unchanged';
    else if (verdict === 'conflict') account = 'kept_existing'; // a race past the preflight: keep, never overwrite
    else {
      const { data, error } = await financialAccountsRepository.update(userId, accountId, { owner_role: owner.ownerRole } as never);
      account = error ? (isMissingColumn(error.message) ? 'unavailable' : 'failed') : data ? 'recorded' : 'failed';
    }
  }

  const { error: docError } = await statementUploadsRepository.update(userId, documentId, {
    owner_member_id: owner.ownerMemberId,
    owner_business_entity_id: null,
    owner_role: owner.ownerRole,
    owner_selection_source: 'user_selected',
  } as never);
  const document = docError ? (isMissingColumn(docError.message) ? 'unavailable' : 'failed') : 'recorded';
  return { account, document };
}
