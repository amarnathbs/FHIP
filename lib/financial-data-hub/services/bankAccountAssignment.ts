/**
 * Bank statements: settle WHICH ACCOUNT an already-uploaded statement belongs to,
 * when the upload could not tell.
 *
 * THE DEAD END THIS REMOVES. `resolveAccountIdentity` (bank-csv/accountIdentity.ts)
 * answers `ambiguous` whenever the user already has an account for the same
 * institution + currency and no masked identifier was supplied (the Expenses
 * panel never sends an institution, so every account of one currency is lumped
 * together). The upload had ALREADY stored the file and raised a blocking review
 * item, and the panel's only advice was "retype the last digits and upload again"
 * in a red error box -- which, for a user with more than one account (or one that
 * was opened with digits), failed again on every later upload.
 *
 * WHAT HAPPENS NOW (POST /api/financial-data-hub/bank-statements/:id/resolve-account):
 *   0. READ the statement locally and deterministically (no AI, nothing leaves the
 *      server): the bank's name and the LAST 4-6 DIGITS of the account/card number,
 *      using the certified bank-PDF adapters (bank-pdf/detection + metadata) and,
 *      for a CSV, the certified CSV adapter's bank name. Only the trailing digits
 *      are ever kept; a printed full number is never returned, stored or logged.
 *   1. AUTO, only where deterministic -- never a guess between several:
 *        - the statement prints digits and EXACTLY ONE of the user's accounts has
 *          the same last digits  -> that account ("Matched to your <bank> account
 *          ending 1234");
 *        - several match -> the bank name narrows them only if it singles out one,
 *          else ask;
 *        - digits printed but NO account matches -> a PREFILLED confirmation
 *          ("We read this as <bank>, account ending 1234. Add as a new account"),
 *          never "the only one" (a number that matches nothing may be a new account);
 *        - nothing could be read and the user has EXACTLY ONE account for this
 *          currency -> that account;
 *        - otherwise -> ask.
 *   2. ASK: the user's accounts for that currency (friendly name + last digits
 *      only), or "a different / new account" with its last 4-6 digits.
 *   3. ASSIGN the stored statement to the chosen account -- no re-upload.
 *
 * WHY institution_id IS NOT SET HERE. The bank NAME read from the statement is
 * stored as the new account's friendly display name and used to tell accounts of
 * different banks apart, but `institution_id` stays NULL, as it is for every
 * account the Expenses panel creates: (a) an account's identity fingerprint
 * includes institution_id, and the upload step looks accounts up by the
 * institution it was given (none), so an account created WITH one would be
 * invisible to the next upload and a duplicate would be created each time; and
 * (b) FDH-1 deliberately does not seed an institution master, so there is
 * usually no row to point at. Deriving institution_id needs the panel to send it
 * at upload time -- a separate change.
 *
 * SAFETY, each with a test and a negative control:
 *   - tenant isolation: the statement and the account must both belong to the
 *     caller; another user's account is indistinguishable from a missing one;
 *   - same currency and same institution as the statement;
 *   - idempotent: repeating the same choice is a no-op success; a DIFFERENT
 *     account for a statement that already has one is refused (never reassigned);
 *   - the document's owner (chosen before upload) never silently overwrites an
 *     existing account's owner -- the same decision-2 rule as the upload;
 *   - the blocking `*.account_identity_ambiguous` review item is closed, with
 *     how it was settled recorded in its `resolution_code` (resolved_by /
 *     resolved_at are the audit trail; no new document-audit event type is added
 *     because that would widen the shared event_type CHECK);
 *   - a statement that an earlier process attempt parked in `review_required`
 *     because its account was unresolved is moved back to a processable state, so
 *     the user continues without re-uploading.
 *
 * NEVER STORED OR LOGGED: only the trailing 3-6 digits (the account's own masked
 * identifier, the existing FDH discipline: `normaliseMaskedIdentifier` refuses 7+
 * digits) are compared and, for a new account, stored. Nothing here writes the
 * statement text, a printed number, or the digits to a log, an audit payload, a
 * URL or an AI prompt.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { computeAccountFingerprint, normaliseMaskedIdentifier } from '../bank-csv/accountIdentity';
import { assertDocumentTransition } from '../domain/documentLifecycle';
import { BankOwnerConflictError, decideAccountOwnerWrite } from './bankOwnerAttribution';
import { downloadDocumentObject } from './storage';
import { checkFdhDocumentMalwareAdmission } from './malwareScanGate';

type Row = Record<string, unknown>;

/** What the picker shows: a friendly name and the last 4 digits only. */
export interface AccountCandidate {
  id: string;
  displayName: string;
  /** The last 4 digits of the account's stored masked identifier, or null. */
  lastDigits: string | null;
  ownerRole: string | null;
}

export type AccountAssignmentHow = 'user_selected' | 'auto_single_account' | 'auto_printed_identifier' | 'new_account' | 'already_assigned';

/** What was read off the statement. Digits are the trailing 3-6 only. */
export interface StatementIdentity {
  institutionName: string | null;
  lastDigits: string | null;
  /**
   * The canonical institution CODE of the certified adapter that recognised this statement (e.g. 'cba',
   * 'hdfc_bank') -- the same code the FDH institution master (fdh_financial_institutions.institution_code)
   * is keyed by. Present only when a certified adapter named a bank; never derived from free text.
   */
  institutionCode?: string | null;
}

export type AccountResolution =
  | {
      status: 'assigned';
      financialAccountId: string;
      how: AccountAssignmentHow;
      /** For "Matched to your <bank> account ending 1234". */
      account: { displayName: string; lastDigits: string | null };
    }
  | {
      status: 'needs_choice';
      /** new_account_suggested: digits were read and match no account -- show a prefilled "add it".
       * several_accounts: more than one candidate and no way to tell. nothing_read: nothing usable was read. */
      reason: 'new_account_suggested' | 'several_accounts' | 'nothing_read';
      candidates: AccountCandidate[];
      suggestion: { institutionName: string | null; lastDigits: string } | null;
    };

export class BankAccountAssignmentError extends Error {
  constructor(
    readonly code: 'not_found' | 'account_not_found' | 'currency_mismatch' | 'institution_mismatch' | 'already_assigned_to_other' | 'invalid_digits' | 'invalid_state' | 'conflicting_input',
    message: string,
  ) {
    super(message);
    this.name = 'BankAccountAssignmentError';
  }
}

export interface ResolveAccountInput {
  /** The user picked one of their existing accounts. */
  accountId?: string;
  /** The user said "a different / new account" and gave its last 4-6 digits. */
  newAccountDigits?: string;
  /** A friendly name for that new account (the bank read off the statement). Display only. */
  newAccountName?: string;
  /** The user explicitly confirmed changing an existing account's owner. */
  confirmOwnerChange?: boolean;
}

export interface ResolveAccountDeps {
  /** Reads the bank name and last digits the statement prints, or null. Injected in tests. */
  readIdentity?: (document: Row) => Promise<StatementIdentity | null>;
}

/** Titles of the blocking review items an ambiguous upload raises. */
export const ACCOUNT_AMBIGUOUS_TITLE_CODES = ['bank_csv.account_identity_ambiguous', 'bank_pdf.account_identity_ambiguous'] as const;

const NON_ASSIGNABLE_STATUSES = new Set(['approved', 'rejected', 'purge_pending', 'purged']);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** The trailing 3-6 digits of an identifier ("****1234" -> "1234"). */
export function trailingDigits(identifier: string | null | undefined): string | null {
  const m = (identifier ?? '').match(/(\d{3,6})\s*$/);
  return m ? m[1] : null;
}

/** Last 4 digits, or null -- all the picker ever shows. */
export function lastDigitsForDisplay(identifier: string | null | undefined): string | null {
  const t = trailingDigits(identifier);
  return t ? t.slice(-4) : null;
}

/** Candidate ids whose stored identifier has the same last 4 digits as the printed one.
 * Both sides need at least 4 digits: a shorter fragment is not evidence. */
export function matchPrintedIdentifier(printed: string | null, candidates: ReadonlyArray<{ id: string; maskedIdentifier: string | null }>): string[] {
  const p = trailingDigits(printed);
  if (!p || p.length < 4) return [];
  return candidates
    .filter((c) => {
      const t = trailingDigits(c.maskedIdentifier);
      return Boolean(t && t.length >= 4 && t.slice(-4) === p.slice(-4));
    })
    .map((c) => c.id);
}

/** Several accounts share the printed digits: the bank name read off the
 * statement can tell them apart ONLY when it singles out exactly one. */
export function narrowByInstitutionName(
  matchIds: readonly string[],
  candidates: ReadonlyArray<{ id: string; displayName: string }>,
  institutionName: string | null,
): string[] {
  if (matchIds.length <= 1 || !institutionName) return [...matchIds];
  const wanted = institutionName.trim().toLowerCase();
  const byName = matchIds.filter((id) => (candidates.find((c) => c.id === id)?.displayName ?? '').trim().toLowerCase() === wanted);
  return byName.length === 1 ? byName : [...matchIds];
}

/** A friendly account name from the bank name read off the statement: plain
 * text, bounded, display only. Anything else falls back to the generic name. */
export function sanitiseAccountName(raw: string | null | undefined): string {
  const t = (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return /^[A-Za-z0-9 &.,'()/-]+$/.test(t) ? t : 'Imported account';
}

export type AutoDecision =
  | { kind: 'assign'; accountId: string; how: 'auto_single_account' | 'auto_printed_identifier' }
  | { kind: 'ask'; reason: 'new_account_suggested' | 'several_accounts' | 'nothing_read' };

/** PURE. Auto-resolution only where it is deterministic. */
export function decideAutoAssignment(input: {
  candidateIds: readonly string[];
  /** Whether the statement printed an account number we could read. */
  printedPresent: boolean;
  /** Candidate ids matching the printed number (empty when none). */
  printedMatches: readonly string[];
}): AutoDecision {
  if (input.printedPresent) {
    if (input.printedMatches.length === 1) return { kind: 'assign', accountId: input.printedMatches[0], how: 'auto_printed_identifier' };
    if (input.printedMatches.length > 1) return { kind: 'ask', reason: 'several_accounts' };
    // A printed number that matches nothing may be a NEW account: never fall back to "the only one".
    return { kind: 'ask', reason: 'new_account_suggested' };
  }
  if (input.candidateIds.length === 1) return { kind: 'assign', accountId: input.candidateIds[0], how: 'auto_single_account' };
  return { kind: 'ask', reason: input.candidateIds.length > 1 ? 'several_accounts' : 'nothing_read' };
}

/**
 * PO-OBU-06. Resolves the canonical institution id from a certified adapter's institution CODE and the
 * statement's country, against the FDH institution master (fdh_financial_institutions, seeded by FDH-2).
 * Returns null when the code is not in the master -- an id is never invented and never derived from free text.
 */
export async function resolveInstitutionIdByCode(countryCode: string | null | undefined, institutionCode: string | null | undefined): Promise<string | null> {
  if (!countryCode || !institutionCode) return null;
  const admin = createAdminClient();
  const { data } = await admin
    .from('fdh_financial_institutions')
    .select('id')
    .eq('country_code', countryCode)
    .eq('institution_code', institutionCode)
    .eq('active', true)
    .maybeSingle();
  return ((data as { id?: string } | null)?.id as string | undefined) ?? null;
}

/**
 * Whether an account may take a statement. A statement uploaded with an institution is matched exactly. One
 * uploaded WITHOUT (the Expenses panel never sends one) is matched on the institution the certified adapter
 * resolved: an account of that institution, or a LEGACY account with no institution (never rewritten, only
 * offered). An account of a DIFFERENT institution never matches, so two banks with the same currency and the
 * same last digits stay two accounts.
 */
function institutionCompatible(accountInstitution: unknown, docInstitution: unknown, resolvedInstitution: string | null): boolean {
  if (docInstitution) return accountInstitution === docInstitution;
  if (resolvedInstitution) return !accountInstitution || accountInstitution === resolvedInstitution;
  return !accountInstitution;
}

function toCandidate(a: Row): AccountCandidate {
  return {
    id: a.id as string,
    displayName: ((a.display_name as string | null) ?? '').trim() || 'Imported account',
    lastDigits: lastDigitsForDisplay(a.masked_identifier as string | null),
    ownerRole: (a.owner_role as string | null | undefined) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Default identity reader. Local and deterministic: the certified bank adapters,
// no AI, nothing sent anywhere. Dynamic imports, so this module has no hard
// dependency on the PDF library unless a PDF is actually read.
// ---------------------------------------------------------------------------

export async function readStatementIdentityFromStoredFile(document: Row): Promise<StatementIdentity | null> {
  try {
    const key = document.raw_document_storage_reference as string | null | undefined;
    if (!key) return null;
    // Malware-scan boundary: this reader parses the stored bytes, so it is a processing entry point like the
    // bank / payslip / liability services and runs the SAME admission check BEFORE it reads them. A document the
    // scan blocked, timed out on, or (with the real scan on) never scanned is not parsed -- the user is simply asked.
    if (!checkFdhDocumentMalwareAdmission(document as { malware_scan_status?: string | null; error_code?: string | null }).admitted) return null;

    if (document.source_type === 'csv') {
      const download = await downloadDocumentObject(key);
      if (!download.ok) return null;
      const { detectBankCsvFormat } = await import('../bank-csv/detection');
      const detection = detectBankCsvFormat(download.bytes);
      // A generic (country-neutral) adapter names no bank: say nothing rather than "Generic CSV".
      const adapter = detection.status === 'detected' ? detection.adapter : null;
      return adapter && adapter.institutionCode ? { institutionName: adapter.displayName, lastDigits: null, institutionCode: adapter.institutionCode } : null;
    }

    if (document.source_type !== 'pdf_native' || document.error_code === 'password_required') return null;
    const download = await downloadDocumentObject(key);
    if (!download.ok) return null;
    const { extractPdfPages } = await import('../bank-pdf/textExtraction');
    const extracted = await extractPdfPages(download.bytes);
    if (!extracted.ok) return null;
    const fullText = extracted.pages.join('\n');
    const { detectPdfBankAdapter } = await import('../bank-pdf/detection');
    const detection = detectPdfBankAdapter(fullText);
    if (detection.status !== 'detected' || !detection.adapter) return null;
    const { extractPdfStatementMetadata } = await import('../bank-pdf/metadata');
    const masked = extractPdfStatementMetadata(fullText, detection.adapter).maskedAccountIdentifier;
    const code = (detection.adapter as { institutionCode?: string | null }).institutionCode;
    return { institutionName: detection.adapter.displayName, lastDigits: trailingDigits(masked), ...(code ? { institutionCode: code } : {}) };
  } catch {
    return null; // never fail the resolution because the statement could not be read -- the user is simply asked
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export async function resolveStatementAccount(
  userId: string,
  documentId: string,
  input: ResolveAccountInput = {},
  deps: ResolveAccountDeps = {},
): Promise<AccountResolution> {
  if (input.accountId && input.newAccountDigits) {
    throw new BankAccountAssignmentError('conflicting_input', 'Choose an existing account or enter a new one, not both.');
  }
  const admin = createAdminClient();

  const { data: docData } = await admin.from('fdh_statement_uploads').select('*').eq('id', documentId).eq('user_id', userId).maybeSingle();
  const doc = (docData ?? null) as Row | null;
  if (!doc) throw new BankAccountAssignmentError('not_found', 'Statement not found.');
  if (doc.document_type !== 'bank_statement') throw new BankAccountAssignmentError('invalid_state', 'This is not a bank statement.');
  if (NON_ASSIGNABLE_STATUSES.has(doc.processing_status as string)) {
    throw new BankAccountAssignmentError('invalid_state', 'This statement can no longer be assigned to an account.');
  }
  const currency = doc.currency_code as string | null;
  if (!currency) throw new BankAccountAssignmentError('invalid_state', 'This statement has no currency, so its account cannot be chosen.');

  const { data: accountRows } = await admin
    .from('fdh_financial_accounts')
    .select('*')
    .eq('user_id', userId)
    .eq('currency_code', currency)
    .order('created_at', { ascending: true });
  const allCurrencyAccounts = (accountRows ?? []) as Row[];

  // The statement is read at most once, and only when it carries no institution of its own.
  let identityCache: StatementIdentity | null | undefined;
  const readIdentityOnce = async (): Promise<StatementIdentity | null> => {
    if (identityCache === undefined) identityCache = await (deps.readIdentity ?? readStatementIdentityFromStoredFile)(doc);
    return identityCache;
  };
  const docInstitutionId = (doc.institution_id as string | null | undefined) ?? null;
  let resolvedInstitutionId: string | null = null;
  let institutionResolved = false;
  const resolveInstitution = async (): Promise<string | null> => {
    if (docInstitutionId) return docInstitutionId;
    if (!institutionResolved) {
      institutionResolved = true;
      const identity = await readIdentityOnce();
      resolvedInstitutionId = await resolveInstitutionIdByCode(doc.country_code as string | null, identity?.institutionCode ?? null);
    }
    return resolvedInstitutionId;
  };

  // ---- already assigned: idempotent for the same account, never a silent move ----
  const alreadyAssigned = (doc.financial_account_id as string | null) ?? null;
  if (alreadyAssigned) {
    if (input.accountId && input.accountId !== alreadyAssigned) {
      throw new BankAccountAssignmentError('already_assigned_to_other', 'This statement is already assigned to a different account. It was not moved.');
    }
    const current = allCurrencyAccounts.find((a) => a.id === alreadyAssigned) ?? null;
    if (input.newAccountDigits) {
      const digits = normaliseDigits(input.newAccountDigits);
      const fingerprint = computeAccountFingerprint({ userId, institutionId: (doc.institution_id as string | null) ?? null, currencyCode: currency, maskedIdentifierNormalised: digits });
      if (!current || current.account_fingerprint !== fingerprint) {
        throw new BankAccountAssignmentError('already_assigned_to_other', 'This statement is already assigned to a different account. It was not moved.');
      }
    }
    await closeAmbiguityItems(userId, documentId, 'already_assigned');
    return { status: 'assigned', financialAccountId: alreadyAssigned, how: 'already_assigned', account: current ? summary(current) : { displayName: 'Your account', lastDigits: null } };
  }

  // Which institution this statement belongs to: its own, or the one the certified adapter resolved. Only now
  // (not assigned yet) is it needed.
  const institutionId = await resolveInstitution();
  const candidates = allCurrencyAccounts.filter((a) => institutionCompatible(a.institution_id, docInstitutionId, institutionId) && a.status !== 'closed' && a.status !== 'archived');

  // ---- the user picked an existing account ----
  if (input.accountId) {
    const { data: picked } = await admin.from('fdh_financial_accounts').select('*').eq('id', input.accountId).eq('user_id', userId).maybeSingle();
    if (!picked) throw new BankAccountAssignmentError('account_not_found', 'That account was not found.'); // another user's id looks exactly like this
    const account = picked as Row;
    if (account.currency_code !== currency) throw new BankAccountAssignmentError('currency_mismatch', `That account is in ${String(account.currency_code)}, but this statement is in ${currency}.`);
    if (!institutionCompatible(account.institution_id, docInstitutionId, institutionId)) throw new BankAccountAssignmentError('institution_mismatch', 'That account belongs to a different institution than this statement.');
    if (account.status === 'closed' || account.status === 'archived') throw new BankAccountAssignmentError('account_not_found', 'That account is no longer open.');
    return assign(userId, doc, account, 'user_selected', input.confirmOwnerChange === true);
  }

  // ---- the user accepted / typed a new account's last digits ----
  if (input.newAccountDigits) {
    const digits = normaliseDigits(input.newAccountDigits);
    const fingerprint = computeAccountFingerprint({ userId, institutionId, currencyCode: currency, maskedIdentifierNormalised: digits });
    const existing = candidates.find((a) => a.account_fingerprint === fingerprint);
    if (existing) return assign(userId, doc, existing, 'user_selected', input.confirmOwnerChange === true);
    const ownerRole = (doc.owner_role as string | null | undefined) ?? null;
    const { data: created, error } = await admin
      .from('fdh_financial_accounts')
      .insert({
        user_id: userId,
        household_id: null,
        institution_id: institutionId,
        account_type: 'transaction',
        country_code: (doc.country_code as string | null) ?? 'AU',
        currency_code: currency,
        display_name: sanitiseAccountName(input.newAccountName),
        masked_identifier: digits,
        account_fingerprint: fingerprint,
        status: 'active',
        ...(ownerRole ? { owner_role: ownerRole } : {}),
      })
      .select('*')
      .single();
    if (error || !created) throw new BankAccountAssignmentError('invalid_state', 'We could not create that account. Please try again.');
    return assign(userId, doc, created as Row, 'new_account', true);
  }

  // ---- automatic, only where deterministic ----
  const identity = await readIdentityOnce();
  const printedDigits = identity?.lastDigits && identity.lastDigits.length >= 4 ? identity.lastDigits : null;
  const candidateViews = candidates.map((a) => ({ id: a.id as string, displayName: ((a.display_name as string | null) ?? '').trim(), maskedIdentifier: (a.masked_identifier as string | null) ?? null }));
  const rawMatches = matchPrintedIdentifier(printedDigits, candidateViews);
  const matches = narrowByInstitutionName(rawMatches, candidateViews, identity?.institutionName ?? null);
  // When the bank is KNOWN, "the only account" means the only account OF THAT BANK: a legacy account with no
  // institution is still offered in the picker but is never claimed on the strength of being the only one.
  const autoCandidateIds = institutionId ? candidates.filter((a) => a.institution_id === institutionId).map((a) => a.id as string) : candidateViews.map((c) => c.id);
  const decision = decideAutoAssignment({ candidateIds: autoCandidateIds, printedPresent: printedDigits !== null, printedMatches: matches });
  if (decision.kind === 'assign') {
    const account = candidates.find((a) => a.id === decision.accountId)!;
    return assign(userId, doc, account, decision.how, input.confirmOwnerChange === true);
  }
  return {
    status: 'needs_choice',
    reason: decision.reason,
    candidates: candidates.map(toCandidate),
    suggestion: decision.reason === 'new_account_suggested' && printedDigits ? { institutionName: identity?.institutionName ?? null, lastDigits: printedDigits } : null,
  };
}

function summary(account: Row): { displayName: string; lastDigits: string | null } {
  return { displayName: ((account.display_name as string | null) ?? '').trim() || 'Imported account', lastDigits: lastDigitsForDisplay(account.masked_identifier as string | null) };
}

function normaliseDigits(raw: string): string {
  const digits = raw.replace(/[\s-]/g, '');
  if (!/^\d{4,6}$/.test(digits) || !normaliseMaskedIdentifier(digits)) {
    throw new BankAccountAssignmentError('invalid_digits', 'Enter the last 4 to 6 digits of the account or card number.');
  }
  return digits;
}

async function assign(userId: string, doc: Row, account: Row, how: AccountAssignmentHow, confirmOwnerChange: boolean): Promise<AccountResolution> {
  const admin = createAdminClient();
  const documentId = doc.id as string;

  // Decision 2 (as at upload): the owner chosen for THIS statement never silently
  // overwrites a different owner already recorded on the account.
  const docOwner = (doc.owner_role as string | null | undefined) ?? null;
  const existingOwner = (account.owner_role as string | null | undefined) ?? null;
  const ownerVerdict = docOwner ? decideAccountOwnerWrite(existingOwner, docOwner, confirmOwnerChange) : 'noop';
  if (ownerVerdict === 'conflict') throw new BankOwnerConflictError(existingOwner as string, docOwner as string, account.id as string);

  // Claim the statement for this account only while it still has none, so two
  // concurrent choices cannot both win.
  const { data: claimed } = await admin
    .from('fdh_statement_uploads')
    .update({ financial_account_id: account.id, ...(!doc.institution_id && account.institution_id ? { institution_id: account.institution_id } : {}), updated_at: new Date().toISOString() })
    .eq('id', documentId)
    .eq('user_id', userId)
    .is('financial_account_id', null)
    .select('id');
  if (!claimed || (claimed as unknown[]).length === 0) {
    const { data: now } = await admin.from('fdh_statement_uploads').select('financial_account_id').eq('id', documentId).eq('user_id', userId).maybeSingle();
    if ((now as { financial_account_id?: string | null } | null)?.financial_account_id === account.id) {
      await closeAmbiguityItems(userId, documentId, 'already_assigned');
      return { status: 'assigned', financialAccountId: account.id as string, how: 'already_assigned', account: summary(account) };
    }
    throw new BankAccountAssignmentError('already_assigned_to_other', 'This statement is already assigned to a different account. It was not moved.');
  }

  if (ownerVerdict === 'write' && docOwner) {
    await admin.from('fdh_financial_accounts').update({ owner_role: docOwner, updated_at: new Date().toISOString() }).eq('id', account.id as string).eq('user_id', userId);
  }

  // An earlier process attempt may have parked this statement in review_required
  // BECAUSE its account was unresolved (it wrote nothing). Bring it back to a
  // processable state through the two declared transitions.
  if (doc.processing_status === 'review_required') {
    assertDocumentTransition('review_required', 'failed');
    assertDocumentTransition('failed', 'queued');
    await admin
      .from('fdh_statement_uploads')
      .update({ processing_status: 'failed', updated_at: new Date().toISOString() })
      .eq('id', documentId)
      .eq('user_id', userId)
      .eq('processing_status', 'review_required');
    await admin
      .from('fdh_statement_uploads')
      .update({ processing_status: 'queued', review_status: 'not_required', certification_status: null, updated_at: new Date().toISOString() })
      .eq('id', documentId)
      .eq('user_id', userId)
      .eq('processing_status', 'failed');
  }

  await closeAmbiguityItems(userId, documentId, `account_${how}`);
  return { status: 'assigned', financialAccountId: account.id as string, how, account: summary(account) };
}

async function closeAmbiguityItems(userId: string, documentId: string, resolutionCode: string): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from('fdh_review_items')
    .update({ status: 'resolved', resolved_at: new Date().toISOString(), resolved_by: userId, resolution_code: resolutionCode })
    .eq('user_id', userId)
    .eq('statement_upload_id', documentId)
    .in('title_code', [...ACCOUNT_AMBIGUOUS_TITLE_CODES])
    .in('status', ['open', 'in_progress']);
}
