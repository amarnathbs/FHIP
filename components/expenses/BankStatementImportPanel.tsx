'use client';

import { formatDateShort } from '@/lib/engines/date';
import { DateInput } from '@/components/ui/DateInput';
/**
 * LR-3 — Expenses Bank Statement Workflow: the Expenses-tab bank-statement
 * import journey.
 *
 * Upload -> detect (CSV only) -> process -> a link to the existing FDH
 * review/approval workspace, where the extracted transactions are corrected
 * and approved. This panel deliberately does NOT re-implement that review UI
 * inline (unlike components/income/PayslipImportPanel.tsx's fully-inlined
 * proposal-compare flow) — a bank statement can extract dozens or hundreds
 * of individual transactions, which already has its own dedicated, more
 * capable review surface at /financial-data-hub/review; duplicating it here
 * would be a second, divergent copy of the same UI. Once a transaction is
 * approved there, it already counts toward Monthly Surplus on its own (see
 * lib/engines/dashboard.ts's LR-3 section) — there is no separate "Apply"
 * step for Expenses the way Income has one (see FDH15_BRIDGE_ARCHITECTURE_
 * INVENTORY.md's documented rationale: approval is the terminal state for
 * this domain, by design).
 *
 * 2026-09-21 fix (P1-7, LR audit): this panel used to call the GENERIC FDH-3
 * upload-session endpoints (create-session, then complete) and then stop —
 * those primitives only ever store the file and mark the document
 * `processing_status = 'queued'` (see uploadLifecycle.ts's own header
 * comment: "No worker is implemented in FDH-3; this only creates the job
 * record"). Nothing ever advanced the document past `queued`, so the
 * "Uploaded. Your transactions are being extracted for review." message was
 * false — no worker exists to do that extraction, and the panel never asked
 * for it. The bank-CSV/bank-PDF engines this app already has (10 certified
 * adapters, live-DEV E2E proven in LR3_BANK_IMPORT_ORACLE_LIVE_DEV_E2E.md)
 * are reached through their OWN dedicated routes instead
 * (`bank-csv/upload` + `bank-csv/{id}/detect` + `bank-csv/{id}/process`, or
 * `bank-pdf/upload` + `bank-pdf/{id}/process`) — the same routes that oracle
 * drove directly over HTTP, and the same account-identity resolution
 * (`uploadBankCsv`/`uploadBankPdf`) those routes perform that the generic
 * session endpoints never did. This panel now calls those real routes
 * itself, so the button it sits behind can actually do what its own copy
 * always claimed. The former "Credit card statement" / "Loan statement"
 * options are removed here — neither ever had a working backend behind this
 * panel (they would need `liability-statement/upload`, which already has its
 * own real, working entry point at `components/liabilities/
 * LiabilityImportPanel.tsx` under the Liabilities tab) — offering them here
 * was always a second, non-functional path to the same place.
 *
 * WHY THIS FILE, NOT A DIRECT IMPORT OF FdhDocumentUploadClient. Same
 * precedent as PayslipImportPanel.tsx/LiabilityImportPanel.tsx/
 * AuInvestmentStatementImportPanel.tsx/RetirementStatementImportPanel.tsx:
 * this module lives behind its own tab (Expenses), not as a new top-level
 * destination, and talks to the FDH-backed API surface purely over
 * `fetch()` — the same relationship any other HTTP client has to a public
 * route, not a `lib/financial-data-hub` import. `tests/unit/
 * fdh1Isolation.test.ts`'s "is imported by nothing outside itself" check is
 * a naive path-substring search, so this file (and its one call site,
 * app/(app)/expenses/page.tsx) is named in that test's own documented
 * FDH_APPROVED_CONSUMER_FILES allowlist, for the identical reason the four
 * files above already are.
 */

import { useEffect, useRef, useState } from 'react';
import { bankUploadParams, statementPeriodError } from './bankUploadParams';
import { OwnerSelector } from '@/components/ownership/OwnerSelector';
import type { OwnerSelection } from '@/lib/ownership/ownerSelection';
import {
  waitForDocumentToLeaveValidating,
  SCANNING_MESSAGE,
  SCAN_TIMEOUT_MESSAGE,
} from '@/components/financial-data-hub/scanStatusPolling';
import {
  useWaitingImports,
  WaitingImportsList,
  discardAiDraft,
  DUPLICATE_UPLOAD_MESSAGE,
  type WaitingImport,
} from '@/components/financial-data-hub/WaitingImports';
import { StatementDetailsDrawer } from '@/components/financial-data-hub/StatementDetailsDrawer';

type Phase =
  | 'form'
  | 'uploading'
  | 'scanning'
  | 'processing'
  | 'awaiting_password'
  // The upload could not tell which of the user's accounts the statement is for
  // and no single account was deterministic: the user picks one (or adds one).
  | 'choose_account'
  // AIE bank-statement AI-fallback (2026-09-23). The native parse failed on a
  // readable-but-unrecognised layout and an AI read a DRAFT off it; nothing
  // is saved until the user confirms from this phase.
  | 'ai_fallback_review'
  | 'scan_timeout'
  | 'done'
  | 'error';

/** One AI-read transaction line, exactly as the confirm route accepts it. */
interface AiDraftRow {
  transactionDate: string;
  descriptionRaw: string;
  amountOriginal: number;
  creditDebit: 'credit' | 'debit';
  balanceAfter: number | null;
}

interface AiFallbackDraft {
  rows: AiDraftRow[];
  institutionName: string | null;
  maskedAccountIdentifier: string | null;
  statementPeriodStart: string | null;
  statementPeriodEnd: string | null;
  declaredOpeningBalance: number | null;
  declaredClosingBalance: number | null;
  allTransactionsListed: boolean;
  warnings: string[];
}

const FAILURE_MESSAGES: Record<string, string> = {
  unsupported_file_type: 'Unsupported file type. Only PDF and CSV files are accepted.',
  mime_mismatch: 'This file does not actually look like the type it claims to be.',
  file_corrupt: 'This file appears to be corrupted or unreadable.',
  file_too_large: 'This file is too large.',
  password_required: 'This PDF is password-protected. Enter its password to continue.',
  password_invalid: 'The password provided could not open this document.',
  // 2026-09-21 — deliberately does NOT say "malware" or "virus": this check
  // (`lib/shared/pdfStructuralScan.ts`) is a structural/heuristic scan for a
  // specific known bypass technique, not a real malware scanner, and the
  // user-facing message must not overclaim what actually happened.
  structural_scan_rejected: 'This PDF could not be accepted because it failed a security check on its internal structure. Please try re-exporting or re-saving the document and upload it again.',
  ocr_required: 'This PDF appears to be a scanned image rather than a text statement, so it cannot be read automatically.',
  page_limit_exceeded: 'This statement has too many pages to process automatically.',
  layout_unsupported: 'This statement’s layout is not one FHIP currently recognises.',
  format_ambiguous: 'FHIP could not confidently tell which columns hold your transactions.',
  extraction_low_confidence: 'FHIP could not read this statement with enough confidence to certify it.',
  data_validation_failed: 'The extracted data on this statement did not pass basic checks.',
  internal_error: 'Something went wrong while processing this upload.',
  // 2026-09-21 (real-malware-gate async fix) — deliberately does NOT say
  // "malware" or "virus", same discipline as structural_scan_rejected above:
  // a real scan verdict, but the user-facing copy stays calm and generic.
  malware_detected: 'This file could not be accepted because it failed a security check. Please try a different file.',
  malware_scan_suspicious: 'This file could not be accepted because it failed a security check. Please try a different file.',
  malware_scan_failed: 'We could not finish checking this file for safety. Please try again.',
  malware_scan_timeout: 'We could not finish checking this file for safety in time. Please try again.',
  malware_scan_unknown: 'We could not finish checking this file for safety. Please try again.',
  // WP-08 (UPL-01): the PDF read ran out of its time budget.
  extraction_timeout: 'Reading this file took too long, so we stopped. It may not be a normal statement PDF. Please try again, or download the statement from your bank again and upload that copy.',
};

/** Owner-before-upload (Phase 1): an existing account is recorded under a
 * different owner than the one chosen. The server stopped BEFORE storing
 * anything and the user must confirm, explicitly, before the account's owner
 * changes. */
interface OwnerConflict {
  message: string;
}

/** An account the user may assign a statement to: a friendly name and the last
 * digits only (never a full number). */
interface AccountChoiceCandidate {
  id: string;
  display_name: string;
  last_digits: string | null;
}

/** The "which account is this statement for?" step. Held only for that phase. */
interface AccountChoice {
  documentId: string;
  csv: boolean;
  /** The upload's own answer, kept so processing continues exactly as it would have. */
  uploadData: Record<string, unknown>;
  /** new_account_suggested: the statement's account number matched none of the user's accounts;
   * several_accounts / nothing_read: the user picks. */
  reason: 'new_account_suggested' | 'several_accounts' | 'nothing_read';
  candidates: AccountChoiceCandidate[];
  /** What was read off the statement (last digits only), for a prefilled "add it". */
  suggestion: { institution_name: string | null; last_digits: string } | null;
}

interface UnreadLines {
  count: number;
  reasons: Array<{ reason: string; count: number; text: string }>;
}

function unreadLinesText(u: UnreadLines | null | undefined): string | null {
  if (!u || u.count === 0) return null;
  const parts = u.reasons.map((r) => `${r.count} had ${r.text}`);
  return `${u.count} line${u.count === 1 ? '' : 's'} could not be read${parts.length ? `: ${parts.join('; ')}` : ''}. They are not included. Add them by hand if they are real transactions.`;
}

interface ProcessSummary {
  transactionsCreated: number;
  duplicatesSkipped: number;
  reconciliationStatus: string | null;
  /** 2026-09-25: this upload was a byte-identical copy of a statement already
   * imported; nothing was read again and nothing new was created. */
  alreadyImported?: boolean;
  /** 2026-09-26: the statement whose category review the "done" link opens
   * (null when there is no single statement to point at). */
  statementId?: string | null;
  /** WP-08 (EXP-G14): lines that could not be read, with reasons. */
  unreadLines?: UnreadLines | null;
  /** WP-08 (EXP-G15): an AI reading that may be missing lines. */
  incompleteExtraction?: boolean;
}

async function readJson(res: Response) {
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

export function BankStatementImportPanel({ onClose }: { onClose: () => void }) {
  const [country, setCountry] = useState<'AU' | 'IN'>('AU');
  const [currency, setCurrency] = useState<'AUD' | 'INR'>('AUD');
  const [maskedIdentifier, setMaskedIdentifier] = useState('');
  // Owner-before-upload (Phase 1; WP-08 D-10 before it): no default -- the user
  // says who the statement belongs to, with the shared OwnerSelector.
  const [owner, setOwner] = useState<OwnerSelection | null>(null);
  const [ownerConflict, setOwnerConflict] = useState<OwnerConflict | null>(null);
  const [accountChoice, setAccountChoice] = useState<AccountChoice | null>(null);
  // '' = nothing chosen yet; an account id; or 'new' = a different / new account.
  const [accountPick, setAccountPick] = useState('');
  const [newAccountDigits, setNewAccountDigits] = useState('');
  const [accountOwnerConflict, setAccountOwnerConflict] = useState<string | null>(null);
  // Neutral, informational line (e.g. "Matched to your ... account ending 1234"). NOT an error.
  const [info, setInfo] = useState<string | null>(null);
  // In the prefilled-suggestion step: the user said "this is one of my existing accounts".
  const [showExistingAccounts, setShowExistingAccounts] = useState(false);
  // GP-D3: the statement period printed on the statement (a CSV does not carry it).
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('form');
  const [message, setMessage] = useState<string | null>(null);
  const [summary, setSummary] = useState<ProcessSummary | null>(null);
  const [busy, setBusy] = useState(false);
  // App Review 2026-09-14, item 2: this panel used to always render as a
  // fully working upload form and only discover the FDH-3 production hard
  // gate (see lib/financial-data-hub/constants/featureFlags.ts) when the
  // upload itself failed — a dead-end that read as a broken button rather
  // than a known, temporary limitation. `null` = not checked yet (render
  // nothing that could flash and disappear); `true`/`false` once known.
  const [uploadEnabled, setUploadEnabled] = useState<boolean | null>(null);
  // AIE bank-statement AI-fallback (2026-09-23). Held only for the lifetime of
  // the `ai_fallback_review` phase; cleared by `reset()` and on confirm.
  const [aiDraft, setAiDraft] = useState<AiFallbackDraft | null>(null);
  // Real-malware-gate async fix (2026-09-21): cancels an in-flight status
  // poll if the panel unmounts mid-scan.
  const scanPollCancelRef = useRef({ cancelled: false });
  useEffect(() => () => {
    scanPollCancelRef.current.cancelled = true;
  }, []);
  // 2026-09-25: AI readings this user left unchecked. Before, closing the
  // panel or reloading the page stranded a reading that had been paid for --
  // and re-uploading the file paid for another one.
  const { items: waiting, reload: reloadWaiting } = useWaitingImports('bank');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/financial-data-hub/upload-status')
      .then((res) => (res.ok ? res.json() : { data: { enabled: false } }))
      .then((json) => {
        if (!cancelled) setUploadEnabled(Boolean(json.data?.enabled));
      })
      .catch(() => {
        if (!cancelled) setUploadEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function reset() {
    setAccountChoice(null);
    setAccountOwnerConflict(null);
    setInfo(null);
    setShowExistingAccounts(false);
    setPhase('form');
    setFile(null);
    setPassword('');
    setDocumentId(null);
    setMessage(null);
    setSummary(null);
    setAiDraft(null);
  }

  function failWith(errorCode: string | null | undefined, fallback: string) {
    setMessage((errorCode && FAILURE_MESSAGES[errorCode]) ?? fallback);
    setPhase('error');
  }

  /** Removes one AI-read line the user judges wrong. Deletion is the only
   * per-row edit offered here, deliberately: a statement can carry dozens of
   * lines, and an inline editable grid for all of them would duplicate the
   * review workspace at /financial-data-hub/review that already exists for
   * exactly that job — and which the user reaches straight after saving.
   * Removing a line the model hallucinated or double-counted is the one
   * correction that must happen BEFORE the write, because it is the one the
   * balance check will otherwise trip on. */
  function removeAiDraftRow(index: number) {
    setAiDraft((d) => (d ? { ...d, rows: d.rows.filter((_, i) => i !== index) } : d));
  }

  async function handleConfirmAiDraft() {
    if (!aiDraft || !documentId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/financial-data-hub/bank-pdf/${documentId}/ai-fallback/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: aiDraft.rows,
          statementPeriodStart: aiDraft.statementPeriodStart,
          statementPeriodEnd: aiDraft.statementPeriodEnd,
          declaredOpeningBalance: aiDraft.declaredOpeningBalance,
          declaredClosingBalance: aiDraft.declaredClosingBalance,
          maskedAccountIdentifier: aiDraft.maskedAccountIdentifier,
        }),
      });
      const { ok: confirmOk, json } = await readJson(res);
      if (!confirmOk) {
        setMessage(json.error ?? 'We could not save this statement.');
        setPhase('error');
        return;
      }
      const data = json.data ?? {};
      // Best-effort auto-classification, exactly as the native success path
      // does it — an AI-fallback import must land in the same state a native
      // one does, including this.
      try {
        await fetch('/api/financial-data-hub/bank-transactions/categorise', { method: 'POST' });
      } catch {
        // Best-effort only; transactions are still correctable by hand.
      }
      setAiDraft(null);
      reloadWaiting();
      setSummary({
        transactionsCreated: data.transactions_created ?? 0,
        duplicatesSkipped: data.duplicates_skipped ?? 0,
        reconciliationStatus: data.reconciliation_status ?? null,
        statementId: documentId,
        unreadLines: (data.unread_lines as UnreadLines | null | undefined) ?? null,
        incompleteExtraction: Boolean(data.incomplete_extraction),
      });
      setPhase('done');
    } finally {
      setBusy(false);
    }
  }

  // Runs the real parse for an already-uploaded document: `detect` (CSV
  // only — bank-PDF's own pipeline detects layout internally) then
  // `process`, mirroring exactly what LR3_BANK_IMPORT_ORACLE_LIVE_DEV_E2E.md
  // proved works end-to-end (upload -> detect -> process -> categorise ->
  // approve). `password` is only ever sent on the bank-PDF path, and only
  // once the upload step has already told us this document needs one.
  async function runProcessing(docId: string, csv: boolean, pdfPassword?: string, knownCopy = false) {
    setPhase('processing');
    setMessage(null);

    // A byte-identical copy of a statement already imported is never read
    // again (2026-09-25): processing answers straight away with the original,
    // so format detection is skipped too.
    if (csv && !knownCopy) {
      const detectRes = await fetch(`/api/financial-data-hub/bank-csv/${docId}/detect`, { method: 'POST' });
      const { ok: detectOk, json: detectJson } = await readJson(detectRes);
      if (!detectOk) {
        setMessage(detectJson.error ?? 'We could not determine the format of this file.');
        setPhase('error');
        return;
      }
    }

    const processRes = csv
      ? await fetch(`/api/financial-data-hub/bank-csv/${docId}/process`, { method: 'POST' })
      : await fetch(`/api/financial-data-hub/bank-pdf/${docId}/process`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(pdfPassword ? { password: pdfPassword } : {}),
        });
    const { ok: processOk, json: processJson } = await readJson(processRes);
    if (!processOk) {
      setMessage(processJson.error ?? 'We could not process this bank statement.');
      setPhase('error');
      return;
    }

    const data = processJson.data ?? {};
    // 2026-09-25: a re-upload of a statement already imported. Nothing was
    // read and nothing new was created; say so and point at the review page.
    if (data.duplicate && data.pipeline_status !== 'ai_fallback_available') {
      setMessage(DUPLICATE_UPLOAD_MESSAGE);
      setSummary({
        transactionsCreated: 0,
        duplicatesSkipped: data.duplicates_skipped ?? 0,
        reconciliationStatus: data.reconciliation_status ?? null,
        alreadyImported: true,
        statementId: (data.duplicate_of_document_id as string | undefined) ?? null,
      });
      setPhase('done');
      return;
    }
    // AIE bank-statement AI-fallback. Checked BEFORE the password branch
    // (2026-09-25): a draft means the file was already read, so a password
    // code still on the document must not send the user back to the password
    // prompt -- that is how a resumed draft would otherwise dead-end. For a
    // re-upload, `document_id` is the ORIGINAL upload whose reading awaits a
    // check, and the confirm goes there.
    if (data.pipeline_status === 'ai_fallback_available' && data.ai_fallback_draft) {
      setDocumentId((data.document_id as string | undefined) ?? docId);
      setMessage(data.duplicate_of_document_id ? DUPLICATE_UPLOAD_MESSAGE : null);
      setAiDraft(data.ai_fallback_draft as AiFallbackDraft);
      setPhase('ai_fallback_review');
      return;
    }
    if (data.error_code === 'password_required' || data.error_code === 'password_invalid') {
      if (data.error_code === 'password_invalid') setPassword('');
      setMessage(data.error_code === 'password_invalid' ? FAILURE_MESSAGES.password_invalid : null);
      setPhase('awaiting_password');
      return;
    }
    // (The AI-fallback draft branch, 2026-09-23, now sits above the password
    // branch -- see there. It must stay before the generic `error_code`
    // branch below, or a perfectly good draft would be read as a failure.)

    if (data.error_code) {
      failWith(data.error_code, 'This file could not be processed.');
      return;
    }

    // R8/FDH-6's own real, already-certified auto-classification pass
    // (`classifyUserTransactions`, exposed at this route) is not invoked by
    // ANY surface in the app today, including the pre-existing direct
    // `/financial-data-hub` DEV upload page — every newly-processed
    // transaction is persisted `economic_transaction_type = 'unknown'` and
    // stays that way until either this runs or a human corrects each row.
    // That is a separate, pre-existing, app-wide gap this fix does not
    // otherwise attempt to close — but calling this already-built, safe,
    // idempotent endpoint here (best-effort; never blocks the "done" state
    // on failure) means transactions imported through Expenses at least
    // arrive already classified wherever an existing rule matches, instead
    // of 100% "Uncategorised" for a reviewer to fix by hand.
    try {
      await fetch('/api/financial-data-hub/bank-transactions/categorise', { method: 'POST' });
    } catch {
      // Best-effort only — the transactions still exist and are correctable
      // by hand at /financial-data-hub/review if this call fails.
    }

    setSummary({
      transactionsCreated: data.transactions_created ?? 0,
      duplicatesSkipped: data.duplicates_skipped ?? 0,
      reconciliationStatus: data.reconciliation_status ?? null,
      statementId: docId,
      unreadLines: (data.unread_lines as UnreadLines | null | undefined) ?? null,
      incompleteExtraction: Boolean(data.incomplete_extraction),
    });
    setPhase('done');
  }

  async function handleUpload(confirmOwnerChange = false) {
    if (!file || !owner) return;
    const periodProblem = statementPeriodError(periodStart, periodEnd);
    if (periodProblem) {
      setMessage(periodProblem);
      return;
    }
    const csv = file.type === 'text/csv' || file.name.toLowerCase().endsWith('.csv');
    setBusy(true);
    setPhase('uploading');
    setMessage(null);
    setOwnerConflict(null);
    setInfo(null);
    try {
      // GP-D3: the statement period is sent when the user gives it, so a full month counts as covered.
      const params = bankUploadParams({ country, currency, maskedIdentifier, owner, confirmOwnerChange, filename: file.name, periodStart, periodEnd });

      const uploadRes = await fetch(
        `/api/financial-data-hub/${csv ? 'bank-csv' : 'bank-pdf'}/upload?${params.toString()}`,
        { method: 'POST', headers: { 'Content-Type': csv ? 'text/csv' : 'application/pdf' }, body: file },
      );
      const { ok: uploadOk, json: uploadJson } = await readJson(uploadRes);
      if (!uploadOk) {
        // Owner-before-upload: the server refuses BEFORE storing anything when the
        // chosen owner would silently change an existing account's owner. Ask,
        // do not guess -- the user confirms the change or goes back.
        if (uploadRes.status === 409 && uploadJson.error === 'account_owner_conflict') {
          setOwnerConflict({ message: uploadJson.message as string });
          setPhase('form');
          return;
        }
        setMessage(uploadJson.message ?? uploadJson.error ?? 'Could not upload this statement.');
        setPhase(uploadRes.status === 409 ? 'form' : 'error');
        return;
      }
      const data = uploadJson.data ?? {};
      const docId = data.document_id as string;
      setDocumentId(docId);

      // 2026-09-25: a byte-identical re-upload of a statement already imported
      // (or whose AI reading awaits a check). Go straight to the original --
      // no account question, no password prompt, no second read.
      if (data.duplicate_of_document_id) {
        await runProcessing(docId, csv, undefined, true);
        return;
      }

      // A file the upload step REJECTED (e.g. file_corrupt) has no account question: it is reported as
      // rejected below (canonical-cert, DEV 2026-09-27: a corrupt file also comes back 'ambiguous' and was
      // told to add account digits). A password-protected PDF keeps the previous order.
      if (data.account_resolution === 'ambiguous' && (!data.error_code || data.error_code === 'password_required')) {
        // Account resolution: the upload could not tell which account this is. Do NOT
        // send the user back to retype digits and re-upload -- the file is already
        // stored. Resolve automatically where that is deterministic, otherwise ask
        // "which account is this statement for?" (see bankAccountAssignment.ts).
        const settled = await settleAmbiguousAccount(docId, csv, data);
        if (!settled) return;
      }

      await continueAfterAccount(docId, csv, data);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Upload failed');
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }

  /** Everything that follows once the statement is attached to an account: the
   * password prompt, the scan wait, then processing. Unchanged behaviour. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- `data` is the upload route's JSON payload
  async function continueAfterAccount(docId: string, csv: boolean, data: Record<string, any>) {
    // Bank PDFs may come back declaring `password_required` at the UPLOAD
    // step (structure-only detection, before any parsing is attempted) —
    // that is not a failure, just a signal to collect a password before
    // calling `process`.
    if (!csv && data.password_required) {
      setPhase('awaiting_password');
      return;
    }
    if (data.error_code) {
      failWith(data.error_code, 'This file could not be uploaded.');
      return;
    }

    // Real-malware-gate async fix (2026-09-21): the upload step may have
    // left this document genuinely, legally waiting in `validating` — the
    // real S3+GuardDuty scan has not resolved yet. Calling detect/process
    // immediately in that case used to surface a raw `invalid_state`
    // error even though nothing had gone wrong. Wait for the document to
    // leave `validating` first, showing an honest "scanning" state.
    if (data.processing_status === 'validating') {
      setPhase('scanning');
      setMessage(SCANNING_MESSAGE);
      const waited = await waitForDocumentToLeaveValidating(docId, { signal: scanPollCancelRef.current });
      if (waited.outcome === 'timeout') {
        setMessage(SCAN_TIMEOUT_MESSAGE);
        setPhase('scan_timeout');
        return;
      }
      if (waited.processingStatus === 'failed' || waited.processingStatus === 'rejected') {
        failWith(waited.errorCode, 'This file could not be accepted.');
        return;
      }
      setMessage(null);
    }

    await runProcessing(docId, csv);
  }

  /** Asks the server to settle the account. true = assigned (carry on);
   * false = the picker is showing, or an error is. */
  async function settleAmbiguousAccount(docId: string, csv: boolean, data: Record<string, unknown>, body: Record<string, unknown> = {}): Promise<boolean> {
    const res = await fetch(`/api/financial-data-hub/bank-statements/${docId}/resolve-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const { ok: resolveOk, status, json } = await readJson(res);
    if (!resolveOk) {
      // The chosen account would change the owner it is recorded under: ask first.
      if (status === 409 && json.error === 'account_owner_conflict') {
        setAccountOwnerConflict(json.message as string);
        return false;
      }
      setMessage(json.message ?? json.error ?? 'We could not match this statement to an account.');
      if (!accountChoice) setPhase('error');
      return false;
    }
    if (json.data?.status === 'assigned') {
      setAccountChoice(null);
      setAccountOwnerConflict(null);
      // Matched without asking: say so, plainly, so the user can see where it went.
      if (json.data.how === 'auto_printed_identifier' || json.data.how === 'auto_single_account') {
        const a = json.data.account as { display_name: string; last_digits: string | null } | undefined;
        if (a) setInfo(`Matched to your ${a.display_name} account${a.last_digits ? ` ending ${a.last_digits}` : ''}.`);
      }
      return true;
    }
    setAccountChoice({
      documentId: docId,
      csv,
      uploadData: data,
      reason: json.data.reason,
      candidates: json.data.candidates ?? [],
      suggestion: json.data.suggestion ?? null,
    });
    setAccountPick('');
    setNewAccountDigits('');
    setShowExistingAccounts(false);
    setMessage(null);
    setPhase('choose_account');
    return false;
  }

  async function handleChooseAccount(confirmOwnerChange = false, acceptSuggestion = false) {
    if (!accountChoice) return;
    if (!acceptSuggestion && !accountPick) return;
    const suggestion = accountChoice.suggestion;
    const body: Record<string, unknown> = acceptSuggestion && suggestion
      ? { new_account_digits: suggestion.last_digits, ...(suggestion.institution_name ? { new_account_name: suggestion.institution_name } : {}) }
      : accountPick === 'new'
        ? { new_account_digits: newAccountDigits.trim() }
        : { account_id: accountPick };
    if (confirmOwnerChange) body.confirm_owner_change = true;
    setBusy(true);
    setAccountOwnerConflict(null);
    try {
      const settled = await settleAmbiguousAccount(accountChoice.documentId, accountChoice.csv, accountChoice.uploadData, body);
      if (!settled) return;
      setPhase('uploading');
      await continueAfterAccount(accountChoice.documentId, accountChoice.csv, accountChoice.uploadData);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Something went wrong');
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }

  /** Continue an AI reading left unchecked (2026-09-25). */
  function resumeWaiting(item: WaitingImport) {
    if (item.stage !== 'ai_draft' || !item.ai_fallback_draft) return;
    setDocumentId(item.document_id);
    setMessage(null);
    setAiDraft(item.ai_fallback_draft as AiFallbackDraft);
    setPhase('ai_fallback_review');
  }

  async function handleSubmitPassword() {
    if (!documentId || !password) return;
    setBusy(true);
    try {
      await runProcessing(documentId, false, password);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="region" aria-label="Import bank statement" className="rounded border border-gray-200 p-5" aria-live="polite">
      <div className="flex items-start justify-between gap-4">
        <h2 className="text-lg font-semibold text-trust">Import bank statement</h2>
        <button type="button" onClick={onClose} className="text-sm text-muted underline" aria-label="Close bank statement import">
          Close
        </button>
      </div>

      {uploadEnabled === false && phase === 'form' && (
        <div className="mt-4 space-y-2">
          <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Statement import isn&apos;t turned on in this environment yet. You can still add these transactions
            yourself using the Expenses list below.
          </p>
        </div>
      )}

      {phase === 'form' && <WaitingImportsList items={waiting} busy={busy} onContinue={resumeWaiting} />}

      {uploadEnabled !== false && phase === 'form' && (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-muted">
            Upload a bank statement (PDF or CSV) and FHIP will extract your transactions for you to review and
            approve. Approved transactions become your actual income and spending for the months they are dated in —
            nothing here changes your totals until you approve it.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Country this statement is from</span>
              <select
                className="w-full rounded border border-gray-300 px-3 py-2"
                value={country}
                onChange={(e) => {
                  const c = e.target.value as 'AU' | 'IN';
                  setCountry(c);
                  setCurrency(c === 'AU' ? 'AUD' : 'INR');
                }}
              >
                <option value="AU">Australia</option>
                <option value="IN">India</option>
              </select>
            </label>
            <OwnerSelector flow="bank" idPrefix="bank-owner" value={owner} onChange={(next) => { setOwner(next); setOwnerConflict(null); }} disabled={busy} />
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Account / card number (last few digits, optional)</span>
              <input
                className="w-full rounded border border-gray-300 px-3 py-2"
                placeholder="e.g. 1234"
                value={maskedIdentifier}
                onChange={(e) => setMaskedIdentifier(e.target.value)}
              />
            </label>
          </div>
          <fieldset className="grid gap-4 sm:grid-cols-2" aria-describedby="statement-period-help">
            <legend className="mb-1 text-sm text-muted">Statement period (as printed on the statement, recommended)</legend>
            <label className="block text-sm">
              <span className="mb-1 block text-muted">From</span>
              <DateInput
                
                className="w-full rounded border border-gray-300 px-3 py-2"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted">To</span>
              <DateInput
                
                className="w-full rounded border border-gray-300 px-3 py-2"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
              />
            </label>
            <span id="statement-period-help" className="block text-xs text-muted sm:col-span-2">
              A month counts in your averages only when a statement covers the whole month. Without the period,
              FHIP can only use the dates of the first and last transactions.
            </span>
          </fieldset>
          <label className="block text-sm">
            <span className="mb-1 block text-muted">Statement file (PDF or CSV, up to 20MB)</span>
            <input
              type="file"
              accept="application/pdf,text/csv"
              className="block w-full text-sm"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          {message && <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">{message}</p>}
          {ownerConflict && (
            <div className="rounded border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-900" role="alert" data-testid="owner-conflict">
              <p>{ownerConflict.message}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className="rounded bg-trust px-3 py-1.5 text-white" onClick={() => handleUpload(true)}>
                  Yes, change the account&apos;s owner and upload
                </button>
                <button type="button" className="rounded border border-amber-400 px-3 py-1.5" onClick={() => setOwnerConflict(null)}>
                  No, go back
                </button>
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={() => handleUpload()}
            disabled={!file || !owner || busy || uploadEnabled !== true}
            className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            Upload statement
          </button>
        </div>
      )}

      {(phase === 'uploading' || phase === 'processing' || phase === 'scanning') && (
        <p className="mt-4 text-sm text-muted" role="status">
          {phase === 'uploading' && 'Uploading your statement…'}
          {phase === 'scanning' && (message ?? SCANNING_MESSAGE)}
          {phase === 'processing' && 'Processing your statement — extracting transactions…'}
        </p>
      )}

      {phase === 'ai_fallback_review' && aiDraft && (
        <div className="mt-4 space-y-4">
          {message && <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">{message}</p>}
          <p className="rounded bg-blue-50 px-3 py-2 text-sm text-blue-900">
            We could not recognise this statement&apos;s layout automatically, so we used AI to read it instead. Please
            check these transactions before saving — <strong>nothing has been saved yet</strong>.
          </p>

          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-muted">Institution</dt>
              <dd>{aiDraft.institutionName ?? 'Not shown'}</dd>
            </div>
            <div>
              <dt className="text-muted">Period</dt>
              <dd>
                {aiDraft.statementPeriodStart ?? '?'} to {aiDraft.statementPeriodEnd ?? '?'}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Opening balance</dt>
              <dd>{aiDraft.declaredOpeningBalance ?? 'Not shown'}</dd>
            </div>
            <div>
              <dt className="text-muted">Closing balance</dt>
              <dd>{aiDraft.declaredClosingBalance ?? 'Not shown'}</dd>
            </div>
          </dl>

          {!aiDraft.allTransactionsListed && (
            <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
              The AI reported that it could <strong>not</strong> list every transaction on this statement. If you save
              this, the import will be incomplete — we recommend adding the missing transactions by hand afterwards, or
              trying a different file.
            </p>
          )}

          <div>
            <p className="mb-2 text-sm text-muted">
              {aiDraft.rows.length} transaction{aiDraft.rows.length === 1 ? '' : 's'} read. Remove any line that is
              wrong or is not really a transaction.
            </p>
            <div className="max-h-80 overflow-y-auto rounded border border-gray-200">
              <table className="w-full text-sm">
                <caption className="sr-only">Transactions read from this statement by AI, awaiting your confirmation</caption>
                <thead className="sticky top-0 bg-gray-50 text-left">
                  <tr>
                    <th scope="col" className="px-3 py-2">Date</th>
                    <th scope="col" className="px-3 py-2">Description</th>
                    <th scope="col" className="px-3 py-2 text-right">Amount</th>
                    <th scope="col" className="px-3 py-2">In/Out</th>
                    <th scope="col" className="px-3 py-2">
                      <span className="sr-only">Remove</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {aiDraft.rows.map((row, i) => (
                    <tr key={`${row.transactionDate}-${i}`} className="border-t border-gray-100">
                      <td className="px-3 py-2 whitespace-nowrap">{formatDateShort(row.transactionDate, currency)}</td>
                      <td className="px-3 py-2">{row.descriptionRaw}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{row.amountOriginal.toFixed(2)}</td>
                      <td className="px-3 py-2">{row.creditDebit === 'credit' ? 'In' : 'Out'}</td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => removeAiDraftRow(i)}
                          className="rounded border border-gray-300 px-2 py-1 text-xs"
                        >
                          Remove<span className="sr-only"> the {row.descriptionRaw} transaction on {formatDateShort(row.transactionDate, currency)}</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <p className="text-xs text-muted">
            AI-read values are shown for your confirmation only. When you save, we check these transactions against the
            statement&apos;s own opening and closing balances — exactly as we do for a statement we read automatically —
            and flag the import for review if they do not add up.
          </p>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => {
                // 2026-09-25: recorded on the server too, so the reading is not
                // offered again as something to continue.
                if (documentId) void discardAiDraft(documentId).then(reloadWaiting);
                setAiDraft(null);
                setMessage(FAILURE_MESSAGES.layout_unsupported);
                setPhase('error');
              }}
              className="rounded border border-gray-300 px-3 py-1 text-sm"
            >
              This doesn&apos;t look right
            </button>
            <button
              type="button"
              onClick={handleConfirmAiDraft}
              disabled={busy || aiDraft.rows.length === 0}
              className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              Save these transactions
            </button>
          </div>
        </div>
      )}

      {phase === 'scan_timeout' && (
        <div className="mt-4 space-y-3">
          <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">{message ?? SCAN_TIMEOUT_MESSAGE}</p>
          <button type="button" onClick={reset} className="rounded border border-gray-300 px-3 py-1 text-sm">
            Try again
          </button>
        </div>
      )}

      {info && phase !== 'form' && (
        <p className="mt-3 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900" role="status" data-testid="account-info">
          {info}
        </p>
      )}

      {phase === 'choose_account' && accountChoice && (
        <div className="mt-4 space-y-3 rounded border border-blue-200 bg-blue-50 px-4 py-4 text-blue-900" data-testid="choose-account" role="group" aria-labelledby="choose-account-title">
          <h3 id="choose-account-title" className="text-sm font-semibold">One quick check so your statement goes to the right account</h3>

          {accountChoice.reason === 'new_account_suggested' && accountChoice.suggestion && !showExistingAccounts && (
            <>
              <p className="text-sm">
                We read this statement as{' '}
                <strong>{accountChoice.suggestion.institution_name ?? 'a new account'}</strong>, account ending{' '}
                <strong>{accountChoice.suggestion.last_digits}</strong>. It is not one of the accounts you have imported before.
                Your file is already uploaded — you do not need to upload it again.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => handleChooseAccount(false, true)}
                  disabled={busy}
                  className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50"
                >
                  Add as a new account
                </button>
                {accountChoice.candidates.length > 0 && (
                  <button type="button" onClick={() => setShowExistingAccounts(true)} disabled={busy} className="rounded border border-blue-300 bg-white px-4 py-2 text-sm text-blue-900">
                    This is one of my existing accounts
                  </button>
                )}
                <button type="button" onClick={reset} className="text-sm underline">
                  Cancel
                </button>
              </div>
            </>
          )}

          {(accountChoice.reason !== 'new_account_suggested' || !accountChoice.suggestion || showExistingAccounts) && (
            <>
              <p className="text-sm">
                {accountChoice.reason === 'several_accounts'
                  ? 'You have more than one account, so we need to know which one this statement is for.'
                  : 'We could not read an account number from this statement, so please tell us which account it is for.'}{' '}
                Your file is already uploaded — you do not need to upload it again.
              </p>
              <fieldset className="space-y-2">
                <legend className="sr-only">Choose the account</legend>
                {accountChoice.candidates.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 rounded border border-blue-200 bg-white px-3 py-2 text-sm text-gray-900">
                    <input type="radio" name="statement-account" value={c.id} checked={accountPick === c.id} onChange={() => setAccountPick(c.id)} />
                    <span>
                      {c.display_name}
                      {c.last_digits ? <span className="text-muted"> — ending {c.last_digits}</span> : null}
                    </span>
                  </label>
                ))}
                <label className="flex items-center gap-2 rounded border border-blue-200 bg-white px-3 py-2 text-sm text-gray-900">
                  <input type="radio" name="statement-account" value="new" checked={accountPick === 'new'} onChange={() => setAccountPick('new')} />
                  <span>A different / new account</span>
                </label>
              </fieldset>
              {accountPick === 'new' && (
                <label className="block text-sm">
                  <span className="mb-1 block">Last 4 to 6 digits of the account or card number</span>
                  <input
                    className="w-48 rounded border border-gray-300 bg-white px-3 py-2 text-gray-900"
                    inputMode="numeric"
                    placeholder="e.g. 1234"
                    value={newAccountDigits}
                    onChange={(e) => setNewAccountDigits(e.target.value)}
                  />
                </label>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => handleChooseAccount()}
                  disabled={busy || !accountPick || (accountPick === 'new' && !/^\d{4,6}$/.test(newAccountDigits.trim()))}
                  className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50"
                >
                  Use this account
                </button>
                <button type="button" onClick={reset} className="text-sm underline">
                  Cancel
                </button>
              </div>
            </>
          )}

          {message && <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900" role="alert">{message}</p>}
          {accountOwnerConflict && (
            <div className="rounded border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-900" role="alert" data-testid="account-owner-conflict">
              <p>{accountOwnerConflict}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className="rounded bg-trust px-3 py-1.5 text-white" onClick={() => handleChooseAccount(true, accountChoice.reason === 'new_account_suggested' && !showExistingAccounts)} disabled={busy}>
                  Yes, change the account&apos;s owner and continue
                </button>
                <button type="button" className="rounded border border-amber-400 px-3 py-1.5" onClick={() => setAccountOwnerConflict(null)}>
                  No, choose another account
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {phase === 'awaiting_password' && (
        <div className="mt-4 space-y-3">
          <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">{message ?? FAILURE_MESSAGES.password_required}</p>
          <label className="block text-sm">
            <span className="mb-1 block text-muted">Statement password</span>
            <input
              type="password"
              className="w-full max-w-xs rounded border border-gray-300 px-3 py-2"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleSubmitPassword}
              disabled={!password || busy}
              className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              Continue
            </button>
            <button type="button" onClick={reset} className="rounded border border-gray-300 px-3 py-1 text-sm">
              Cancel
            </button>
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div className="mt-4 space-y-3">
          <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">{message}</p>
          <button type="button" onClick={reset} className="rounded border border-gray-300 px-3 py-1 text-sm">
            Try again
          </button>
        </div>
      )}

      {phase === 'done' && (
        <div className="mt-4 space-y-3">
          <p className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">
            {summary?.alreadyImported
              ? `${DUPLICATE_UPLOAD_MESSAGE} Nothing new was added.`
              : summary && summary.transactionsCreated > 0
              ? `Done. ${summary.transactionsCreated} transaction${summary.transactionsCreated === 1 ? '' : 's'} extracted${
                  summary.duplicatesSkipped > 0
                    ? ` (${summary.duplicatesSkipped} already-imported duplicate${summary.duplicatesSkipped === 1 ? '' : 's'} skipped)`
                    : ''
                } — ready for your review.`
              : summary && summary.duplicatesSkipped > 0
                ? `Done. Every transaction on this statement was already imported (${summary.duplicatesSkipped} duplicate${summary.duplicatesSkipped === 1 ? '' : 's'} skipped).`
                : 'Done. This statement has been processed.'}
          </p>
          {unreadLinesText(summary?.unreadLines) && (
            <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">{unreadLinesText(summary?.unreadLines)}</p>
          )}
          {summary?.incompleteExtraction && (
            <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
              This statement was read by AI and may be missing transactions. Before you can approve it, check it against your
              statement: add any missing transactions by hand, or confirm on the review page that every transaction is listed.
            </p>
          )}
          {summary?.statementId && !summary.alreadyImported && <StatementDetailsDrawer statementId={summary.statementId} />}
          {/* 2026-09-26: straight to THIS statement's category-totals review
              (approve totals per category; only unrecognised lines are
              listed one by one). The review page links back to Expenses. */}
          <a
            href={summary?.statementId
              ? `/financial-data-hub/review?statement=${encodeURIComponent(summary.statementId)}&from=expenses`
              : '/financial-data-hub/review?from=expenses'}
            className="inline-block rounded bg-trust px-4 py-2 text-sm text-white"
          >
            Review by category and approve
          </a>
          <button type="button" onClick={reset} className="ml-3 rounded border border-gray-300 px-3 py-1 text-sm">
            Upload another
          </button>
        </div>
      )}
    </div>
  );
}
