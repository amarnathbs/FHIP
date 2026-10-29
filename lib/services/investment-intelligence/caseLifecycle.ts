// Investment Intelligence -- reconciliation-case lifecycle (Document2 (4) WP-B, 20-10-2026).
//
// PURE and DB-free. One place decides, for an open reconciliation case and the
// source document it was raised against, what the case REALLY needs, whether the
// raw file is needed, and therefore which actions the user may be offered.
//
// WHY. Raw statement files are temporary by design: `purgeSourceDocumentStorage`
// deletes the file right after a successful parse and
// `enforceIiSourceDocumentRetentionBackstop` deletes every other file after 24
// hours. A deleted file is NOT a bug. But the Statements & data and Review
// screens kept offering file-dependent actions (enter the password and reprocess,
// re-run an instrument choice) whose only possible outcome was "Could not
// retrieve the stored document". This module is the single source of truth the
// routes and both screens share, so a dead call to action cannot be drawn.
//
// It never restores raw retention: the answer for a case that needs the file is
// a controlled replacement upload linked to the same logical document, or, when
// the information genuinely no longer exists, a governed close with an audit
// trail (history is kept, nothing is deleted).

/** Returned instead of a parse failure when the raw statement file no longer exists (it is deleted on purpose). */
export const SOURCE_FILE_NOT_STORED_STATUS = 'source_file_not_stored';
export const SOURCE_FILE_NOT_STORED_MESSAGE =
  'The original statement file is no longer stored (statement files are deleted shortly after processing, by design), so it cannot be re-read. Your imported data is unchanged. To process it again, upload a replacement copy of the statement.';

export interface LifecycleDocumentState {
  status: string | null;
  storagePath: string | null;
  storagePurgedAt: string | null;
  /** Holdings or transactions were written for this document and are still retained. */
  hasRetainedData?: boolean;
}

/** True only when the raw object can still be downloaded. */
export function hasStoredFile(doc: Pick<LifecycleDocumentState, 'storagePath' | 'storagePurgedAt'> & Partial<LifecycleDocumentState> | null | undefined): boolean {
  return !!doc && !!doc.storagePath && !doc.storagePurgedAt;
}

export type CaseNeed =
  | 'owner_selection'
  | 'instrument_resolution'
  | 'transaction_classification'
  | 'source_conflict'
  | 'password_and_reprocess'
  | 'corrected_file'
  | 'informational'
  | 'structured_evidence'
  | 'information_no_longer_exists';

export type CaseAction =
  | 'choose_owner'
  | 'choose_instrument'
  | 'classify_transaction'
  | 'choose_conflict'
  | 'enter_password'
  | 'upload_replacement'
  | 'discard_document'
  | 'acknowledge_only'
  | 'close_stale'
  | 'mark_resolved';

export interface CaseLifecycle {
  need: CaseNeed;
  /** The case cannot be resolved without re-reading the raw file. */
  fileRequired: boolean;
  /** Applying an already-recorded choice (not recording it) needs the raw file. */
  applyNeedsFile: boolean;
  fileStored: boolean;
  documentArchived: boolean;
  primary: CaseAction;
  secondary: CaseAction[];
  /** The governed "Close stale case" is legitimate for this case right now. */
  staleClosable: boolean;
  /** One plain-language sentence: what happened and what to do (never a bare id or code). */
  explanation: string;
}

const OWNER_TYPES = new Set(['owner_unmatched', 'owner_mismatch', 'joint_holding_allocation_required']);
const DISCARD_TYPES = new Set(['unsupported_document', 'document_corrupt', 'parse_incomplete']);
const INFORMATIONAL_TYPES = new Set(['transaction_missing_from_restatement', 'other', 'ai_fallback_reconciliation_attempted', 'cross_source_exact_duplicate', 'cross_source_high_confidence_duplicate']);

export function classifyCase(discrepancyType: string, doc: LifecycleDocumentState | null): CaseLifecycle {
  const fileStored = hasStoredFile(doc);
  const documentArchived = !!doc && (doc.status === 'archived' || doc.status === 'superseded');
  const base = { fileStored, documentArchived };

  let lifecycle: CaseLifecycle;
  if (OWNER_TYPES.has(discrepancyType)) {
    lifecycle = {
      ...base,
      need: 'owner_selection',
      fileRequired: false,
      applyNeedsFile: false,
      primary: 'choose_owner',
      secondary: [],
      staleClosable: false,
      explanation: 'Choose who owns this account. This does not need the original file.',
    };
  } else if (discrepancyType === 'ambiguous_instrument') {
    lifecycle = {
      ...base,
      need: 'instrument_resolution',
      fileRequired: false,
      applyNeedsFile: true,
      primary: 'choose_instrument',
      secondary: fileStored ? [] : ['upload_replacement'],
      staleClosable: false,
      explanation: fileStored
        ? 'Choose the correct instrument. The statement is re-checked as soon as you save.'
        : 'Choose the correct instrument and it is saved. The original file was deleted after processing, so the choice is applied the next time a replacement copy of this statement is uploaded.',
    };
  } else if (discrepancyType === 'transaction_unclassified') {
    lifecycle = {
      ...base,
      need: 'transaction_classification',
      fileRequired: false,
      applyNeedsFile: false,
      primary: 'classify_transaction',
      secondary: [],
      staleClosable: false,
      explanation: 'Choose the correct transaction type. This does not need the original file.',
    };
  } else if (discrepancyType === 'cross_source_conflict' || discrepancyType === 'cross_source_review_required' || discrepancyType === 'cross_source_holding_conflict') {
    lifecycle = {
      ...base,
      need: 'source_conflict',
      fileRequired: false,
      applyNeedsFile: false,
      primary: 'choose_conflict',
      secondary: [],
      staleClosable: false,
      explanation: 'Choose which record to keep. This does not need the original file.',
    };
  } else if (discrepancyType === 'document_password_required') {
    lifecycle = fileStored
      ? { ...base, need: 'password_and_reprocess', fileRequired: true, applyNeedsFile: true, primary: 'enter_password', secondary: [], staleClosable: false, explanation: 'This statement is password-protected. Enter the password and process it.' }
      : {
          ...base,
          need: 'information_no_longer_exists',
          fileRequired: true,
          applyNeedsFile: true,
          primary: 'upload_replacement',
          secondary: ['close_stale'],
          staleClosable: true,
          explanation:
            'This statement needed a password and its file has since been deleted (statement files are kept only briefly). Upload a replacement copy and enter the password, or close this item if you no longer have the file.',
        };
  } else if (DISCARD_TYPES.has(discrepancyType)) {
    lifecycle = {
      ...base,
      need: 'corrected_file',
      fileRequired: true,
      applyNeedsFile: true,
      primary: fileStored ? 'discard_document' : 'upload_replacement',
      secondary: fileStored ? ['upload_replacement'] : ['close_stale'],
      staleClosable: !fileStored,
      explanation: fileStored
        ? 'This file could not be processed as uploaded. Discard it, or upload a corrected copy.'
        : 'This file could not be processed and has since been deleted. Upload a corrected copy, or close this item.',
    };
  } else if (INFORMATIONAL_TYPES.has(discrepancyType)) {
    lifecycle = {
      ...base,
      need: 'informational',
      fileRequired: false,
      applyNeedsFile: false,
      primary: 'acknowledge_only',
      secondary: [],
      staleClosable: false,
      explanation: 'Information only. Nothing was changed or removed and nothing is blocked.',
    };
  } else {
    // value_mismatch, unit_mismatch, duplicate_suspected, missing_opening_history, statement_period_gap, account/instrument_unmatched ...
    // They are judged against retained structured data; the file is only needed to re-read the statement.
    const gone = !fileStored;
    lifecycle = {
      ...base,
      need: gone ? 'information_no_longer_exists' : 'structured_evidence',
      fileRequired: false,
      applyNeedsFile: false,
      primary: 'mark_resolved',
      secondary: gone ? ['upload_replacement', 'close_stale'] : [],
      staleClosable: gone,
      explanation: gone
        ? 'This item was raised from a statement whose file has been deleted. Confirm it is resolved from the retained data, upload a replacement copy to re-check it, or close it.'
        : 'Check the retained figures and mark this resolved.',
    };
  }

  // A discarded or superseded statement can no longer be acted on at all: any case still open on it is stale.
  if (documentArchived && !lifecycle.staleClosable && lifecycle.need !== 'owner_selection') {
    lifecycle = {
      ...lifecycle,
      staleClosable: true,
      secondary: lifecycle.secondary.includes('close_stale') ? lifecycle.secondary : [...lifecycle.secondary, 'close_stale'],
    };
  }
  return lifecycle;
}

/** The statuses of a document on which a replacement copy makes sense (nothing parsed from it is being undone). */
export function replacementAllowed(doc: LifecycleDocumentState | null): { ok: true } | { ok: false; reason: string } {
  if (!doc) return { ok: false, reason: 'Statement not found.' };
  if (doc.status === 'parsing') return { ok: false, reason: 'This statement is being processed right now. Try again in a minute.' };
  if (doc.status === 'superseded') return { ok: false, reason: 'This statement was superseded by a newer one. Upload the newer statement as a new statement instead.' };
  if (hasStoredFile(doc)) return { ok: false, reason: 'The original file is still stored, so no replacement is needed. Process it instead.' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Portfolio Truth blocker guidance (F7): what happened, why, how to fix, and a CTA.
// ---------------------------------------------------------------------------

export type TruthBlockerCta =
  | { kind: 'link'; label: string; href: string }
  | { kind: 'anchor'; label: string; targetId: string }
  | { kind: 'none' };

export interface TruthBlockerGuidance {
  what: string;
  why: string;
  how: string;
  cta: TruthBlockerCta;
}

export const REVIEW_PATH = '/investment-intelligence/review';
export const DATA_PATH = '/investment-intelligence/data';
export const RECONCILIATION_ANCHOR_ID = 'ii-reconciliation-issues';

export function describeTruthBlocker(code: string, fallbackMessage?: string): TruthBlockerGuidance {
  switch (code) {
    case 'unresolved_owner':
      return {
        what: 'The owner of this account has not been chosen.',
        why: 'A position cannot be counted in your net worth until someone owns it.',
        how: 'Choose the owner (a person, trust, HUF, company or a joint split) on the Review tab, then Re-evaluate.',
        cta: { kind: 'link', label: 'Choose the owner', href: REVIEW_PATH },
      };
    case 'unresolved_instrument':
      return {
        what: 'A scheme on this statement could not be matched to a single fund.',
        why: 'Holdings cannot be valued or published against an unknown fund.',
        how: 'Choose the correct fund on the Review tab. If the statement file has been deleted the choice is saved and applied when you upload a replacement copy.',
        cta: { kind: 'link', label: 'Choose the fund', href: REVIEW_PATH },
      };
    case 'material_unclassified_transaction':
      return {
        what: 'A transaction with a material amount could not be classified.',
        why: 'Unit balances cannot be rebuilt reliably while a material transaction type is unknown.',
        how: 'Choose the transaction type on the Review tab, then Re-evaluate.',
        cta: { kind: 'link', label: 'Classify the transaction', href: REVIEW_PATH },
      };
    case 'open_blocking_reconciliation_case':
      return {
        what: 'An unresolved issue on this statement is blocking this position.',
        why: 'A blocking issue is never downgraded to a warning.',
        how: 'Resolve the issue listed under Reconciliation issues on this statement, then Re-evaluate.',
        cta: { kind: 'anchor', label: 'Go to the issues', targetId: RECONCILIATION_ANCHOR_ID },
      };
    case 'unit_variance_exceeds_tolerance':
      return {
        what: 'The units rebuilt from the transactions do not match the statement closing balance.',
        why: 'Part of the transaction history is missing, usually because the statement covers only a short period.',
        how: 'Upload a CAMS or KFintech consolidated statement for the full history (since the first investment). Re-evaluating does not change this on its own.',
        cta: { kind: 'none' },
      };
    case 'source_undetected':
    case 'parser_fatal_error':
    case 'document_corrupt':
      return {
        what: 'This statement could not be read reliably.',
        why: 'Figures from an unreadable statement are never guessed.',
        how: 'Upload a corrected or fresh copy of the statement.',
        cta: { kind: 'none' },
      };
    case 'cross_household_conflict':
      return {
        what: 'This position maps to more than one household.',
        why: 'It cannot be counted until it belongs to exactly one.',
        how: 'Check the owner on the Review tab.',
        cta: { kind: 'link', label: 'Open Review', href: REVIEW_PATH },
      };
    default:
      return {
        what: fallbackMessage ?? 'This position needs review.',
        why: 'A check that protects your net worth did not pass.',
        how: 'Open the statement to see the details, then Re-evaluate once you have fixed it.',
        cta: { kind: 'none' },
      };
  }
}

/** Human outcome line after a Re-evaluate click. Pure so it can be tested without a UI. */
export function describeReevaluationOutcome(before: string | null, after: string, blockingMessages: string[], alreadyPublished = false): string {
  const certified = after === 'certified' || after === 'certified_with_warnings';
  if (certified) {
    // 29-10-2026: a position that is already published is not "ready to publish"; it is published.
    if (alreadyPublished) return before === after ? 'Re-evaluated. Nothing changed: the published position is still published and up to date.' : 'Re-evaluated. This position is certified; the published position is unchanged.';
    return before === after
      ? 'Re-evaluated. Nothing changed: this position is still ready to publish.'
      : 'Re-evaluated. This position is now ready to publish to FHIP.';
  }
  if (blockingMessages.length > 0) {
    return `Re-evaluated. It still needs review: ${blockingMessages[0]}${blockingMessages.length > 1 ? ` (and ${blockingMessages.length - 1} more)` : ''}`;
  }
  return 'Re-evaluated. It still needs review.';
}
