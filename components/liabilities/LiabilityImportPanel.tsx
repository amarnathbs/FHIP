'use client';

/**
 * FDH-10 — Credit Cards & Loans Intelligence: the Liabilities-tab statement
 * import journey (spec sections 2, 15-27, 41-42).
 *
 * Type selector (Credit Card / Loan) -> Upload -> Processing -> Review
 * evidence -> Approve evidence -> Compare current vs proposed -> explicit
 * Apply. Every step before the final Apply click is INERT — nothing here
 * mutates canonical Liability until the user presses "Apply" and the atomic
 * RPC accepts it (spec section 21).
 *
 * WHY THIS FILE, NOT A NEW TOP-LEVEL DESTINATION. Product architecture (spec
 * section 2): FDH-10 lives entirely behind the Liabilities tab, exactly like
 * FDH-9 lives behind Income (`components/income/PayslipImportPanel.tsx`,
 * whose structure this file deliberately mirrors). This component therefore
 * lives at `components/liabilities/`, alongside the rest of the Liabilities
 * experience, and talks to the FDH-backed API surface purely over `fetch()`
 * — the same relationship any other HTTP client has to a public route.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatMoneyExact } from '@/lib/engines/money';
import {
  waitForDocumentToLeaveValidating,
  SCANNING_MESSAGE,
  SCAN_TIMEOUT_MESSAGE,
} from '@/components/financial-data-hub/scanStatusPolling';

type StatementType = 'credit_card' | 'loan';
type Phase =
  | 'type_select'
  | 'form'
  | 'uploading'
  | 'scanning'
  | 'processing'
  // AIE liability AI-fallback (2026-09-23). The native CSV extraction could
  // not map this export's layout and an AI read a DRAFT off it instead;
  // nothing is saved until the user confirms from this phase.
  | 'ai_fallback_review'
  | 'unable_to_read'
  | 'scan_timeout'
  | 'duplicate'
  | 'review'
  | 'comparing'
  | 'applied'
  | 'kept_existing'
  | 'stale'
  | 'error';

// 2026-09-21 (real-malware-gate async fix) — same honest, non-technical
// discipline as every other FDH-3 panel's failure copy: never "malware" or
// "virus".
const SCAN_REJECTION_MESSAGES: Record<string, string> = {
  malware_detected: 'This file could not be accepted because it failed a security check. Please try a different file, or add this liability manually below.',
  malware_scan_suspicious: 'This file could not be accepted because it failed a security check. Please try a different file, or add this liability manually below.',
  malware_scan_failed: 'We could not finish checking this file for safety. Please try again, or add this liability manually below.',
  malware_scan_timeout: 'We could not finish checking this file for safety in time. Please try again, or add this liability manually below.',
  malware_scan_unknown: 'We could not finish checking this file for safety. Please try again, or add this liability manually below.',
};

type Decision = 'add_new' | 'update_existing' | 'apply_selected_fields' | 'keep_existing';

/** One AI-read activity line, exactly as the confirm route accepts it. */
interface AiDraftActivity {
  activityType: string;
  activityDate: string;
  amount: number;
  descriptionRaw?: string;
  merchantRaw?: string;
  principalComponent?: number;
  interestComponent?: number;
  feeComponent?: number;
}

/** The header facts the AI read, in the same units the upload form uses. Each
 * is only used where the user left the corresponding form field blank — a
 * value the user typed themselves always wins over one a model read. */
interface AiDraftHeader {
  institutionName?: string;
  maskedIdentifier?: string;
  statementPeriodStart?: string;
  statementPeriodEnd?: string;
  statementDate?: string;
  dueDate?: string;
  openingBalance?: number;
  closingBalance?: number;
  creditLimit?: number;
  minimumPayment?: number;
  interestRate?: number;
}

interface AiFallbackDraft {
  activities: AiDraftActivity[];
  header: AiDraftHeader;
  allActivitiesListed: boolean;
  warnings: string[];
}

/** The loan facility types a user may choose at the AI review step.
 * `credit_card` is deliberately absent: a credit-card statement never reaches
 * this selector (its facility type is forced server-side), and a loan
 * statement must never be saved as one. There is no default — an unchosen
 * facility type blocks the save, because a wrong one does not merely mislabel
 * the row, it makes the user's existing liability unfindable and silently
 * creates a duplicate (see FDH-10's own live-certification finding, quoted in
 * `persistLiabilityStatementEvidence`). */
const LOAN_FACILITY_CHOICES: Array<{ value: string; label: string }> = [
  { value: 'home_loan', label: 'Home loan / mortgage' },
  { value: 'investment_property_loan', label: 'Investment property loan' },
  { value: 'personal_loan', label: 'Personal loan' },
  { value: 'vehicle_loan', label: 'Car / vehicle loan' },
  { value: 'line_of_credit', label: 'Line of credit' },
  { value: 'overdraft', label: 'Overdraft' },
  { value: 'other_term_loan', label: 'Another kind of term loan' },
];

const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  PURCHASE: 'Purchase',
  REFUND: 'Refund',
  PAYMENT: 'Payment',
  CASH_ADVANCE: 'Cash advance',
  INTEREST: 'Interest',
  FEE: 'Fee',
  PRINCIPAL: 'Principal',
  LOAN_ADVANCE: 'Drawdown',
  ADJUSTMENT: 'Adjustment',
  OTHER: 'Other',
};

interface LiabilityStatement {
  id: string;
  statement_type: StatementType;
  institution_name: string | null;
  masked_identifier: string | null;
  statement_period_start: string | null;
  statement_period_end: string | null;
  due_date: string | null;
  opening_balance: number | null;
  closing_balance: number | null;
  credit_limit: number | null;
  minimum_payment: number | null;
  opening_principal: number | null;
  closing_principal: number | null;
  interest_rate: number | null;
  repayment_frequency: string | null;
  purchases_total: number | null;
  cash_advances_total: number | null;
  interest_total: number | null;
  fees_total: number | null;
  payments_total: number | null;
  refunds_total: number | null;
  drawdowns_total: number | null;
  principal_repayments_total: number | null;
  reconciliation_status: 'reconciled' | 'variance' | 'insufficient_data';
  reconciliation_variance: number | null;
  approval_status: 'pending' | 'approved';
  currency_code: string;
}

interface StatementActivity {
  id: string;
  activity_type: string;
  activity_date: string;
  amount: number;
  description_raw: string | null;
  bank_match_status: 'matched' | 'no_match' | 'multiple_candidates' | 'not_attempted' | 'bank_evidence_not_available';
}

// NOTE: kept in snake_case to match the raw API/DB column names, exactly
// like LiabilityStatement/StatementActivity above -- this component talks
// to the FDH route handlers over plain fetch() with no camelCase mapping
// layer, and `liabilityProposalService.ts` selects these columns verbatim
// (field_name, proposed_value, existing_value, value_kind, is_recommended,
// requires_confirmation, reason_code). A prior camelCase version of this
// interface silently desynced from the real response shape: every field
// read as `undefined` (blank Field/Current/Proposed cells, "Apply undefined"
// checkbox labels, and no field ever auto-selected as recommended) despite
// the API returning fully populated rows.
interface ProposedField {
  field_name: string;
  value_kind: string;
  proposed_value: string | null;
  existing_value: string | null;
  is_recommended: boolean;
  requires_confirmation: boolean;
  reason_code: string;
}

const FIELD_LABELS: Record<string, string> = {
  liability_name: 'Name',
  debt_type: 'Type',
  lender: 'Lender',
  currency_code: 'Currency',
  country_code: 'Country',
  balance: 'Balance',
  interest_rate: 'Interest rate',
  monthly_repayment: 'Regular repayment',
  credit_limit: 'Credit limit',
  masked_identifier: 'Card / account (masked)',
  minimum_payment: 'Minimum payment',
  due_date: 'Due date',
};

function money(value: number | null | undefined, currency: string) {
  if (value === null || value === undefined) return 'Not shown on statement';
  // App Review 2026-09-15 G1 sanctioned exception (a): literal statement
  // transcription shown for verification. See lib/engines/money.ts.
  return formatMoneyExact(value, currency);
}

/** Shows what will actually be SAVED for one header figure: the value the
 * user typed on the upload form if they typed one, otherwise the value the AI
 * read, otherwise nothing. Written as an explicit null/empty check rather than
 * `||` because `0` is a real opening balance and a falsy-coalescing chain
 * would display (and, worse, imply we were discarding) a genuine zero. */
/** The same precedence as `headerFigure`, but producing the value actually
 * SENT (the route's Zod schema coerces either a numeric string or a number).
 * `undefined` means "we have no figure", which the server treats as the
 * statement not stating one — never as zero. */
function pickFigure(formValue: string, aiValue: number | undefined): string | number | undefined {
  if (formValue.trim() !== '') return formValue;
  if (aiValue === undefined || aiValue === null) return undefined;
  return aiValue;
}

function headerFigure(formValue: string, aiValue: number | undefined): string {
  if (formValue.trim() !== '') return formValue;
  if (aiValue === undefined || aiValue === null) return 'Not shown';
  return String(aiValue);
}

function displayValue(v: string | null, kind: string) {
  if (v === null) return '—';
  if (kind === 'bool') return v === 'true' ? 'Yes' : 'No';
  return v;
}

async function readJson(res: Response) {
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

const bankMatchLabel: Record<string, string> = {
  matched: 'Matched to a bank transaction',
  no_match: 'No matching bank evidence',
  multiple_candidates: 'More than one possible match — please review',
  not_attempted: 'Not attempted',
  bank_evidence_not_available: 'No bank evidence available yet',
};

const reconciliationLabel: Record<string, string> = {
  reconciled: 'Reconciled — the statement adds up',
  variance: 'Needs review — a gap was found between the statement figures',
  insufficient_data: 'Insufficient information to check this statement',
};

export function LiabilityImportPanel({ onClose, onApplied }: { onClose: () => void; onApplied?: () => void }) {
  const [phase, setPhase] = useState<Phase>('type_select');
  const [statementType, setStatementType] = useState<StatementType>('credit_card');
  const [country, setCountry] = useState<'AU' | 'IN'>('AU');
  const [currency, setCurrency] = useState<'AUD' | 'INR'>('AUD');
  const [institutionName, setInstitutionName] = useState('');
  const [maskedIdentifier, setMaskedIdentifier] = useState('');
  const [openingBalance, setOpeningBalance] = useState('');
  const [closingBalance, setClosingBalance] = useState('');
  const [creditLimit, setCreditLimit] = useState('');
  const [minimumPayment, setMinimumPayment] = useState('');
  const [interestRate, setInterestRate] = useState('');
  const [file, setFile] = useState<File | null>(null);

  const [documentId, setDocumentId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [statement, setStatement] = useState<LiabilityStatement | null>(null);
  const [activities, setActivities] = useState<StatementActivity[]>([]);
  const [proposalId, setProposalId] = useState<string | null>(null);
  const [fields, setFields] = useState<ProposedField[]>([]);
  const [decision, setDecision] = useState<Decision>('update_existing');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  // App Review 2026-09-14, item 2: same gap as BankStatementImportPanel.tsx
  // (see that file's identical comment) — this panel used to always render
  // as a fully working upload form and only discover the FDH-3 production
  // hard gate (lib/financial-data-hub/constants/featureFlags.ts) when the
  // upload itself failed. `null` = not checked yet; `true`/`false` once known.
  const [uploadEnabled, setUploadEnabled] = useState<boolean | null>(null);
  // AIE liability AI-fallback (2026-09-23). Held only for the lifetime of the
  // `ai_fallback_review` phase; cleared by `reset()` and on confirm.
  const [aiDraft, setAiDraft] = useState<AiFallbackDraft | null>(null);
  /** The user's own facility-type choice for an AI-read LOAN statement.
   * Empty until they pick — never pre-filled, and never read from the AI. */
  const [aiFacilityType, setAiFacilityType] = useState('');
  // Real-malware-gate async fix (2026-09-21): cancels an in-flight status
  // poll if the panel unmounts mid-scan.
  const scanPollCancelRef = useRef({ cancelled: false });
  useEffect(() => () => {
    scanPollCancelRef.current.cancelled = true;
  }, []);

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

  const reset = useCallback(() => {
    setPhase('type_select');
    setFile(null);
    setDocumentId(null);
    setMessage(null);
    setStatement(null);
    setActivities([]);
    setProposalId(null);
    setFields([]);
    setSelected(new Set());
    setAiDraft(null);
    setAiFacilityType('');
  }, []);

  async function loadReview(docId: string) {
    const res = await fetch(`/api/financial-data-hub/liability-statement/${docId}`);
    const { ok, json } = await readJson(res);
    if (!ok) {
      setMessage(json.error ?? 'We could not load this statement.');
      setPhase('error');
      return;
    }
    setStatement(json.data.statement as LiabilityStatement);
    setActivities((json.data.activities as StatementActivity[]) ?? []);
    setPhase('review');
  }

  // Handles the JSON body from EITHER the initial upload call or the
  // real-malware-gate async fix's `.../process` resumption call — both
  // return the identical `{ document_id, pipeline_status, statement_id,
  // error_message, duplicate }` shape, so one function covers "what do we
  // do with this outcome" for both.
  async function handleStatementOutcome(json: Record<string, unknown>) {
    const data = json.data as Record<string, unknown>;
    // AIE liability AI-fallback (2026-09-23). Checked BEFORE the "no
    // statement_id means unable to read" branch below, which would otherwise
    // swallow a perfectly good draft as a hard failure: an AI draft ALSO has a
    // null `statement_id` (deliberately — nothing has been written yet), so
    // ordering here is load-bearing, not stylistic.
    if (data.pipeline_status === 'ai_fallback_available' && data.ai_fallback_draft) {
      setDocumentId(data.document_id as string);
      setAiDraft(data.ai_fallback_draft as AiFallbackDraft);
      setAiFacilityType('');
      setPhase('ai_fallback_review');
      return;
    }
    if (!data.statement_id) {
      setMessage((data.error_message as string | undefined) ?? 'We could not read this statement.');
      setPhase('unable_to_read');
      return;
    }
    setDocumentId(data.document_id as string);
    if (data.duplicate) {
      setMessage('This statement has already been uploaded. Showing the evidence already on file.');
      await loadReview(data.document_id as string);
      setPhase((p) => (p === 'error' ? p : 'duplicate'));
      return;
    }
    await loadReview(data.document_id as string);
  }

  /** The same metadata JSON both `.../upload`'s query params and the
   * `.../process` resumption route's body carry — kept as one function so
   * the resend can never silently drift from what was originally chosen. */
  function buildStatementMetadataBody(): Record<string, unknown> {
    return {
      statement_type: statementType,
      country_code: country,
      currency_code: currency,
      institution_name: institutionName || undefined,
      masked_identifier: maskedIdentifier || undefined,
      opening_balance: openingBalance || undefined,
      closing_balance: closingBalance || undefined,
      credit_limit: statementType === 'credit_card' ? (creditLimit || undefined) : undefined,
      minimum_payment: statementType === 'credit_card' ? (minimumPayment || undefined) : undefined,
      interest_rate: statementType === 'loan' ? (interestRate || undefined) : undefined,
    };
  }

  /** Removes one AI-read line the user judges wrong. Deletion is the only
   * per-row edit offered here, deliberately: a statement can carry dozens of
   * lines, and an inline editable grid for all of them would duplicate the
   * statement review screen this panel already moves on to straight after
   * saving. Removing a line the model hallucinated or double-counted is the
   * one correction that must happen BEFORE the write, because it is the one
   * the reconciliation arithmetic will otherwise trip on. */
  function removeAiDraftActivity(index: number) {
    setAiDraft((d) => (d ? { ...d, activities: d.activities.filter((_, i) => i !== index) } : d));
  }

  /** Confirms the AI-read draft. The metadata sent is the SAME shape the
   * upload and resume calls use, with each AI-read header value applied only
   * where the user left that form field blank — a figure the user typed
   * themselves always wins over one a model read. */
  async function handleConfirmAiDraft() {
    if (!aiDraft || !documentId) return;
    setBusy(true);
    setMessage(null);
    try {
      const h = aiDraft.header;
      const res = await fetch(`/api/financial-data-hub/liability-statement/${documentId}/ai-fallback/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          metadata: {
            statement_type: statementType,
            country_code: country,
            currency_code: currency,
            institution_name: institutionName || h.institutionName || undefined,
            masked_identifier: maskedIdentifier || h.maskedIdentifier || undefined,
            statement_period_start: h.statementPeriodStart || undefined,
            statement_period_end: h.statementPeriodEnd || undefined,
            statement_date: h.statementDate || undefined,
            due_date: h.dueDate || undefined,
            opening_balance: pickFigure(openingBalance, h.openingBalance),
            closing_balance: pickFigure(closingBalance, h.closingBalance),
            credit_limit: statementType === 'credit_card' ? pickFigure(creditLimit, h.creditLimit) : undefined,
            minimum_payment: statementType === 'credit_card' ? pickFigure(minimumPayment, h.minimumPayment) : undefined,
            interest_rate: statementType === 'loan' ? pickFigure(interestRate, h.interestRate) : undefined,
          },
          // Forced for a card; the user's own explicit choice for a loan.
          facilityType: statementType === 'credit_card' ? 'credit_card' : aiFacilityType,
          activities: aiDraft.activities,
          aiWarnings: aiDraft.warnings,
        }),
      });
      const { ok, json } = await readJson(res);
      if (!ok) {
        setMessage(json.error ?? 'We could not save this statement.');
        setPhase('error');
        return;
      }
      setAiDraft(null);
      await loadReview(json.data.document_id as string);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Something went wrong.');
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }

  async function handleUpload() {
    if (!file) return;
    setBusy(true);
    setPhase('uploading');
    setMessage(null);
    try {
      const params = new URLSearchParams({
        statement_type: statementType,
        country_code: country,
        currency_code: currency,
      });
      if (institutionName) params.set('institution_name', institutionName);
      if (maskedIdentifier) params.set('masked_identifier', maskedIdentifier);
      if (openingBalance) params.set('opening_balance', openingBalance);
      if (closingBalance) params.set('closing_balance', closingBalance);
      if (statementType === 'credit_card') {
        if (creditLimit) params.set('credit_limit', creditLimit);
        if (minimumPayment) params.set('minimum_payment', minimumPayment);
      } else if (interestRate) {
        params.set('interest_rate', interestRate);
      }

      setPhase('processing');
      const res = await fetch(`/api/financial-data-hub/liability-statement/upload?${params.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv' },
        body: file,
      });
      const { ok, json } = await readJson(res);
      if (!ok) {
        setMessage(json.error ?? 'We could not process this statement.');
        setPhase('unable_to_read');
        return;
      }

      // Real-malware-gate async fix (2026-09-21): the upload route now
      // returns `pipeline_status: 'pending_scan'` (statement_id: null, NOT
      // a failure) instead of extracting immediately when the real
      // S3+GuardDuty scan has not yet resolved — see
      // liabilityStatementProcessingService.ts's
      // `resolveLiabilityStatementDocument()`. Checked BEFORE the "no
      // statement_id means unable to read" branch, which would otherwise
      // misread this wait state as a real failure.
      if (json.data.pipeline_status === 'pending_scan') {
        const docId = json.data.document_id as string;
        setDocumentId(docId);
        setPhase('scanning');
        setMessage(SCANNING_MESSAGE);
        const waited = await waitForDocumentToLeaveValidating(docId, { signal: scanPollCancelRef.current });
        if (waited.outcome === 'timeout') {
          setMessage(SCAN_TIMEOUT_MESSAGE);
          setPhase('scan_timeout');
          return;
        }
        if (waited.processingStatus === 'failed' || waited.processingStatus === 'rejected') {
          setMessage(
            (waited.errorCode && SCAN_REJECTION_MESSAGES[waited.errorCode])
              ?? 'This file could not be accepted. Please try a different file, or add this liability manually below.',
          );
          setPhase('unable_to_read');
          return;
        }
        // The scan cleared -- finish the extraction the upload route
        // deferred, re-submitting the SAME metadata originally supplied.
        const processRes = await fetch(`/api/financial-data-hub/liability-statement/${docId}/process`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildStatementMetadataBody()),
        });
        const { ok: processOk, json: processJson } = await readJson(processRes);
        if (!processOk) {
          setMessage(processJson.error ?? 'We could not process this statement.');
          setPhase('unable_to_read');
          return;
        }
        await handleStatementOutcome(processJson);
        return;
      }

      await handleStatementOutcome(json);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Something went wrong.');
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }

  async function handleApprove() {
    if (!documentId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/financial-data-hub/liability-statement/${documentId}/approve`, { method: 'POST' });
      const { ok, json } = await readJson(res);
      if (!ok) throw new Error(json.error ?? 'Could not approve this statement evidence.');
      await loadReview(documentId);
      await handleGenerateProposal();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Something went wrong.');
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }

  async function handleGenerateProposal() {
    if (!documentId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/financial-data-hub/liability-statement/${documentId}/proposal`, { method: 'POST' });
      const { ok, json } = await readJson(res);
      if (!ok) throw new Error(json.error ?? 'We could not prepare a comparison for this statement.');
      setProposalId(json.data.proposal_id as string);
      const pfields = (json.data.fields as ProposedField[]) ?? [];
      setFields(pfields);
      const defaultSel = new Set(
        pfields
          .filter((f) => f.is_recommended && !f.requires_confirmation && f.proposed_value !== f.existing_value)
          .map((f) => f.field_name),
      );
      setSelected(defaultSel);
      setDecision(json.data.proposal?.target_entity_id ? 'update_existing' : 'add_new');
      setPhase('comparing');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Something went wrong.');
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }

  async function handleApply() {
    if (!proposalId) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/financial-data-hub/liability-proposals/${proposalId}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision,
          // The atomic RPC (fdh10_apply_liability_proposal, migration 0096)
          // only auto-selects "all known proposal fields" when the decision
          // is 'update_existing' and no selectedFields are sent. For
          // 'add_new' it has no such fallback -- an omitted/empty selection
          // always fails NO_FIELDS_SELECTED, and 'add_new' additionally
          // requires liability_name/debt_type/balance/currency_code among
          // whatever is selected (DOMAIN_VALIDATION_FAILED otherwise). Live
          // reproduction: every "Add as a new liability" apply from this
          // panel failed with NO_FIELDS_SELECTED because selectedFields was
          // only ever sent for the 'apply_selected_fields' decision.
          // 'keep_existing' never reaches the field-selection logic at all
          // (it dismisses the proposal and returns early), so it's the only
          // other decision safe to omit this for.
          selectedFields:
            decision === 'add_new' || decision === 'apply_selected_fields' ? Array.from(selected) : undefined,
        }),
      });
      const { ok, status, json } = await readJson(res);
      if (!ok) {
        if (status === 409 && json.code === 'STALE_PROPOSAL') {
          setMessage('Your Liability information has changed since this proposal was prepared. Review the latest values before applying.');
          setPhase('stale');
          return;
        }
        if (status === 409 && json.code === 'ALREADY_APPLIED') {
          setMessage('This proposal has already been applied to your liabilities.');
          setPhase('applied');
          return;
        }
        throw new Error(json.error ?? 'The change could not be saved.');
      }
      if (json.data.outcome === 'kept_existing') {
        setPhase('kept_existing');
      } else {
        setPhase('applied');
        onApplied?.();
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Something went wrong.');
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }

  function toggleField(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  const isCreditCard = statementType === 'credit_card';

  return (
    <div role="region" aria-label="Import a credit card or loan statement" className="rounded border border-gray-200 p-5" aria-live="polite">
      <div className="flex items-start justify-between gap-4">
        <h2 className="text-lg font-semibold text-trust">Import Statement</h2>
        <button type="button" onClick={onClose} className="text-sm text-muted underline" aria-label="Close statement import">
          Close
        </button>
      </div>

      {uploadEnabled === false && phase === 'type_select' && (
        <div className="mt-4 space-y-2">
          <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Statement import isn&apos;t turned on in this environment yet. You can still add this credit card or
            loan yourself using the Liabilities form below.
          </p>
        </div>
      )}

      {uploadEnabled !== false && phase === 'type_select' && (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-muted">What would you like to import?</p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => { setStatementType('credit_card'); setPhase('form'); }}
              className="rounded border border-trust px-4 py-3 text-sm font-medium text-trust hover:bg-trust/5"
            >
              Credit Card Statement
            </button>
            <button
              type="button"
              onClick={() => { setStatementType('loan'); setPhase('form'); }}
              className="rounded border border-trust px-4 py-3 text-sm font-medium text-trust hover:bg-trust/5"
            >
              Loan Statement
            </button>
          </div>
        </div>
      )}

      {phase === 'form' && (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-muted">
            Upload your {isCreditCard ? 'credit card' : 'loan'} statement (CSV) and FHIP will extract the details for you to
            review before updating your Liabilities.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Country</span>
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
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Institution / lender</span>
              <input className="w-full rounded border border-gray-300 px-3 py-2" value={institutionName} onChange={(e) => setInstitutionName(e.target.value)} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Card / account (masked, e.g. ****1234)</span>
              <input className="w-full rounded border border-gray-300 px-3 py-2" value={maskedIdentifier} onChange={(e) => setMaskedIdentifier(e.target.value)} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted">{isCreditCard ? 'Opening balance' : 'Opening principal'}</span>
              <input type="number" step="0.01" className="w-full rounded border border-gray-300 px-3 py-2" value={openingBalance} onChange={(e) => setOpeningBalance(e.target.value)} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted">{isCreditCard ? 'Closing balance' : 'Closing principal'}</span>
              <input type="number" step="0.01" className="w-full rounded border border-gray-300 px-3 py-2" value={closingBalance} onChange={(e) => setClosingBalance(e.target.value)} />
            </label>
            {isCreditCard ? (
              <>
                <label className="block text-sm">
                  <span className="mb-1 block text-muted">Credit limit</span>
                  <input type="number" step="0.01" className="w-full rounded border border-gray-300 px-3 py-2" value={creditLimit} onChange={(e) => setCreditLimit(e.target.value)} />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-muted">Minimum payment</span>
                  <input type="number" step="0.01" className="w-full rounded border border-gray-300 px-3 py-2" value={minimumPayment} onChange={(e) => setMinimumPayment(e.target.value)} />
                </label>
              </>
            ) : (
              <label className="block text-sm">
                <span className="mb-1 block text-muted">Interest rate (%, if stated)</span>
                <input type="number" step="0.01" className="w-full rounded border border-gray-300 px-3 py-2" value={interestRate} onChange={(e) => setInterestRate(e.target.value)} />
              </label>
            )}
          </div>
          <label className="block text-sm">
            <span className="mb-1 block text-muted">Statement file (CSV)</span>
            <input type="file" accept="text/csv,.csv" className="block w-full text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <div className="flex gap-3">
            <button type="button" onClick={() => setPhase('type_select')} className="rounded border border-gray-300 px-3 py-1 text-sm">
              Back
            </button>
            <button
              type="button"
              onClick={handleUpload}
              disabled={!file || busy || uploadEnabled !== true}
              className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              Upload statement
            </button>
          </div>
        </div>
      )}

      {(phase === 'uploading' || phase === 'processing' || phase === 'scanning') && (
        <p className="mt-4 text-sm text-muted" role="status">
          {phase === 'uploading' && 'Uploading your statement…'}
          {phase === 'scanning' && (message ?? SCANNING_MESSAGE)}
          {phase === 'processing' && 'Processing your statement — extracting activity…'}
        </p>
      )}

      {phase === 'ai_fallback_review' && aiDraft && (
        <div className="mt-4 space-y-4">
          <p className="rounded bg-blue-50 px-3 py-2 text-sm text-blue-900">
            We could not recognise this statement&apos;s layout automatically, so we used AI to read it instead. Please
            check these figures before saving — <strong>nothing has been saved yet</strong>.
          </p>

          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-muted">Institution</dt>
              <dd>{institutionName || aiDraft.header.institutionName || 'Not shown'}</dd>
            </div>
            <div>
              <dt className="text-muted">Statement period</dt>
              <dd>
                {aiDraft.header.statementPeriodStart ?? '?'} to {aiDraft.header.statementPeriodEnd ?? '?'}
              </dd>
            </div>
            <div>
              <dt className="text-muted">{isCreditCard ? 'Opening balance' : 'Opening principal'}</dt>
              <dd>{headerFigure(openingBalance, aiDraft.header.openingBalance)}</dd>
            </div>
            <div>
              <dt className="text-muted">{isCreditCard ? 'Closing balance' : 'Closing principal'}</dt>
              <dd>{headerFigure(closingBalance, aiDraft.header.closingBalance)}</dd>
            </div>
          </dl>

          {!aiDraft.allActivitiesListed && (
            <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
              The AI reported that it could <strong>not</strong> list every line on this statement. If you save this,
              the evidence will be incomplete and the statement is unlikely to add up — we recommend trying a different
              export, or adding this liability by hand.
            </p>
          )}

          {!isCreditCard && (
            <label className="block text-sm">
              <span className="mb-1 block text-muted">What kind of loan is this statement for?</span>
              <select
                className="w-full rounded border border-gray-300 px-3 py-2"
                value={aiFacilityType}
                onChange={(e) => setAiFacilityType(e.target.value)}
              >
                <option value="">Please choose…</option>
                {LOAN_FACILITY_CHOICES.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
              <span className="mt-1 block text-xs text-muted">
                We ask rather than guess: this is what lets us match the statement to the loan you already have, instead
                of adding a second copy of it.
              </span>
            </label>
          )}

          <div>
            <p className="mb-2 text-sm text-muted">
              {aiDraft.activities.length} line{aiDraft.activities.length === 1 ? '' : 's'} read. Remove any line that is
              wrong or is not really an activity.
            </p>
            <div className="max-h-80 overflow-y-auto rounded border border-gray-200">
              <table className="w-full text-sm">
                <caption className="sr-only">Statement activity read by AI, awaiting your confirmation</caption>
                <thead className="sticky top-0 bg-gray-50 text-left">
                  <tr>
                    <th scope="col" className="px-3 py-2">Date</th>
                    <th scope="col" className="px-3 py-2">Type</th>
                    <th scope="col" className="px-3 py-2">Description</th>
                    <th scope="col" className="px-3 py-2 text-right">Amount</th>
                    <th scope="col" className="px-3 py-2">
                      <span className="sr-only">Remove</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {aiDraft.activities.map((a, i) => (
                    <tr key={`${a.activityDate}-${i}`} className="border-t border-gray-100">
                      <td className="px-3 py-2 whitespace-nowrap">{a.activityDate}</td>
                      <td className="px-3 py-2">{ACTIVITY_TYPE_LABELS[a.activityType] ?? a.activityType}</td>
                      <td className="px-3 py-2">{a.descriptionRaw ?? '—'}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{a.amount.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => removeAiDraftActivity(i)}
                          className="rounded border border-gray-300 px-2 py-1 text-xs"
                        >
                          Remove
                          <span className="sr-only"> the {ACTIVITY_TYPE_LABELS[a.activityType] ?? a.activityType} line on {a.activityDate}</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <p className="text-xs text-muted">
            AI-read values are shown for your confirmation only. When you save, we check these figures against the
            statement&apos;s own opening and closing balances — exactly as we do for a statement we read automatically —
            and flag the result for review if they do not add up. Nothing is applied to your Liabilities until you
            approve the evidence and then apply the comparison, as usual.
          </p>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => {
                setAiDraft(null);
                setMessage("We couldn't recognise the layout of this statement. Please check the file, or add this liability manually.");
                setPhase('unable_to_read');
              }}
              className="rounded border border-gray-300 px-3 py-1 text-sm"
            >
              This doesn&apos;t look right
            </button>
            <button
              type="button"
              onClick={handleConfirmAiDraft}
              disabled={busy || aiDraft.activities.length === 0 || (!isCreditCard && !aiFacilityType)}
              className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              Save this statement
            </button>
          </div>
        </div>
      )}

      {phase === 'unable_to_read' && (
        <div className="mt-4 space-y-3">
          <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">{message}</p>
          <p className="text-sm text-muted">You can try a different file, or add this liability manually below.</p>
          <button type="button" onClick={reset} className="rounded border border-gray-300 px-3 py-1 text-sm">
            Try again
          </button>
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

      {phase === 'error' && (
        <div className="mt-4 space-y-3">
          <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">{message}</p>
          <button type="button" onClick={reset} className="rounded border border-gray-300 px-3 py-1 text-sm">
            Try again
          </button>
        </div>
      )}

      {(phase === 'review' || phase === 'duplicate') && statement && (
        <div className="mt-4 space-y-4">
          <h3 className="font-semibold">Statement review</h3>
          {phase === 'duplicate' && message && <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">{message}</p>}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted">Institution</dt>
            <dd>{statement.institution_name ?? 'Not identified'}</dd>
            <dt className="text-muted">{isCreditCard ? 'Card' : 'Facility'} (masked)</dt>
            <dd>{statement.masked_identifier ?? 'Not provided'}</dd>
            <dt className="text-muted">Statement period</dt>
            <dd>
              {statement.statement_period_start && statement.statement_period_end
                ? `${statement.statement_period_start} – ${statement.statement_period_end}`
                : 'Not identified'}
            </dd>
            {isCreditCard ? (
              <>
                <dt className="text-muted">Opening balance</dt>
                <dd>{money(statement.opening_balance, statement.currency_code)}</dd>
                <dt className="text-muted">Closing balance</dt>
                <dd>{money(statement.closing_balance, statement.currency_code)}</dd>
                <dt className="text-muted">Purchases</dt>
                <dd>{money(statement.purchases_total, statement.currency_code)}</dd>
                <dt className="text-muted">Refunds</dt>
                <dd>{money(statement.refunds_total, statement.currency_code)}</dd>
                <dt className="text-muted">Cash advances</dt>
                <dd>{money(statement.cash_advances_total, statement.currency_code)}</dd>
                <dt className="text-muted">Interest</dt>
                <dd>{money(statement.interest_total, statement.currency_code)}</dd>
                <dt className="text-muted">Fees</dt>
                <dd>{money(statement.fees_total, statement.currency_code)}</dd>
                <dt className="text-muted">Payments</dt>
                <dd>{money(statement.payments_total, statement.currency_code)}</dd>
                <dt className="text-muted">Credit limit</dt>
                <dd>{money(statement.credit_limit, statement.currency_code)} <span className="text-xs text-muted">(not counted in net worth)</span></dd>
                <dt className="text-muted">Minimum payment</dt>
                <dd>{money(statement.minimum_payment, statement.currency_code)}</dd>
              </>
            ) : (
              <>
                <dt className="text-muted">Opening principal</dt>
                <dd>{money(statement.opening_principal, statement.currency_code)}</dd>
                <dt className="text-muted">Closing principal</dt>
                <dd>{money(statement.closing_principal, statement.currency_code)}</dd>
                <dt className="text-muted">Principal repaid</dt>
                <dd>{money(statement.principal_repayments_total, statement.currency_code)}</dd>
                <dt className="text-muted">Interest</dt>
                <dd>{money(statement.interest_total, statement.currency_code)}</dd>
                <dt className="text-muted">Fees</dt>
                <dd>{money(statement.fees_total, statement.currency_code)}</dd>
                <dt className="text-muted">Interest rate</dt>
                <dd>{statement.interest_rate !== null ? `${statement.interest_rate}%` : 'Not shown on statement'}</dd>
                <dt className="text-muted">Repayment frequency</dt>
                <dd>{statement.repayment_frequency ?? 'Not shown on statement'}</dd>
              </>
            )}
          </dl>

          <p className="text-sm" role="status">
            <span className="font-medium">Reconciliation: </span>
            {reconciliationLabel[statement.reconciliation_status]}
          </p>

          <div>
            <h4 className="text-sm font-medium">Activity requiring review</h4>
            <ul className="mt-2 space-y-1 text-sm">
              {activities.filter((a) => a.activity_type === 'PAYMENT').map((a) => (
                <li key={a.id} className="flex justify-between border-b border-gray-100 py-1">
                  <span>{a.activity_date} — Payment {money(a.amount, statement.currency_code)}</span>
                  <span className="text-muted">{bankMatchLabel[a.bank_match_status]}</span>
                </li>
              ))}
              {activities.filter((a) => a.activity_type === 'PAYMENT').length === 0 && (
                <li className="text-muted">No payment activity found on this statement.</li>
              )}
            </ul>
          </div>

          {statement.approval_status === 'approved' ? (
            <p className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">This statement evidence has been approved.</p>
          ) : (
            <div className="space-y-3">
              {/*
                2026-09-24. A correction button used to sit here whose
                only handler was `loadReview(documentId!)` — a re-fetch that
                set the phase this block is ALREADY rendered in, so it
                re-rendered identical content and changed nothing the user
                could see. The identical dead control existed on the payslip
                panel, where it has been replaced with a real correction
                surface (`.../payslip/{id}/correct`). No equivalent
                correction path exists for a liability statement yet — that
                needs its own narrowly-scoped RPC, because migration 0096's
                statement columns are system-authoritative in exactly the way
                `fdh_payroll_events`' are — so rather than keep offering a
                button that does nothing, this says plainly what the options
                actually are. Tracked as follow-up, not silently dropped.
              */}
              <p className="text-sm text-muted">
                Check these figures against your statement before approving. We can&apos;t edit them here yet — if
                something is wrong, choose Try again with a clearer copy of the statement, or add this liability
                yourself using the form below.
              </p>
              <div className="flex gap-3">
                <button type="button" onClick={reset} className="rounded border border-gray-300 px-3 py-1 text-sm">
                  Try again with a different file
                </button>
                <button type="button" onClick={handleApprove} disabled={busy} className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50">
                  Approve
                </button>
              </div>
            </div>
          )}
          {statement.approval_status === 'approved' && !proposalId && (
            <button type="button" onClick={handleGenerateProposal} disabled={busy} className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50">
              Continue to liability comparison
            </button>
          )}
        </div>
      )}

      {(phase === 'comparing' || phase === 'stale') && (
        <div className="mt-4 space-y-4">
          <h3 className="font-semibold">Current liability vs statement proposal</h3>
          {phase === 'stale' && message && <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">{message}</p>}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] border-collapse text-sm">
              <caption className="sr-only">Comparison of current liability to the proposed statement values</caption>
              <thead>
                <tr className="border-b border-gray-200 text-left">
                  <th scope="col" className="py-2 pr-2">Field</th>
                  <th scope="col" className="py-2 pr-2">Current</th>
                  <th scope="col" className="py-2 pr-2">Proposed</th>
                  <th scope="col" className="py-2">Apply this field</th>
                </tr>
              </thead>
              <tbody>
                {fields.map((f) => {
                  const changed = f.proposed_value !== f.existing_value;
                  return (
                    <tr key={f.field_name} className="border-b border-gray-100">
                      <th scope="row" className="py-2 pr-2 text-left font-normal text-muted">{FIELD_LABELS[f.field_name] ?? f.field_name}</th>
                      <td className="py-2 pr-2">{displayValue(f.existing_value, f.value_kind)}</td>
                      <td className={`py-2 pr-2 ${changed ? 'font-medium' : ''}`}>{displayValue(f.proposed_value, f.value_kind)}</td>
                      <td className="py-2">
                        <label className="inline-flex items-center gap-2">
                          <input type="checkbox" checked={selected.has(f.field_name)} onChange={() => toggleField(f.field_name)} aria-label={`Apply ${FIELD_LABELS[f.field_name] ?? f.field_name}`} />
                          {f.requires_confirmation && <span className="text-xs text-amber-800">please confirm</span>}
                        </label>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">What would you like to do?</legend>
            {(['add_new', 'update_existing', 'apply_selected_fields', 'keep_existing'] as Decision[]).map((d) => (
              <label key={d} className="flex items-center gap-2 text-sm">
                <input type="radio" name="liability-apply-decision" checked={decision === d} onChange={() => setDecision(d)} />
                {d === 'add_new' && 'Add as a new liability'}
                {d === 'update_existing' && 'Update my existing liability'}
                {d === 'apply_selected_fields' && 'Apply only the fields I ticked above'}
                {d === 'keep_existing' && 'Keep my existing liability as-is'}
              </label>
            ))}
          </fieldset>

          <div className="flex gap-3">
            <button type="button" onClick={handleGenerateProposal} disabled={busy} className="rounded border border-gray-300 px-3 py-1 text-sm">
              Refresh comparison
            </button>
            <button type="button" onClick={handleApply} disabled={busy} className="rounded bg-trust px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              Apply
            </button>
          </div>
        </div>
      )}

      {phase === 'applied' && (
        <div className="mt-4 space-y-3">
          <p className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">{message ?? 'Your liability has been updated from this statement.'}</p>
          <button type="button" onClick={onClose} className="rounded border border-gray-300 px-3 py-1 text-sm">Done</button>
        </div>
      )}

      {phase === 'kept_existing' && (
        <div className="mt-4 space-y-3">
          <p className="rounded bg-gray-50 px-3 py-2 text-sm text-gray-800">Your existing liability was kept unchanged.</p>
          <button type="button" onClick={onClose} className="rounded border border-gray-300 px-3 py-1 text-sm">Done</button>
        </div>
      )}
    </div>
  );
}
