'use client';

/**
 * FDH-9 — Payslip & Income Intelligence: the Income-tab payslip import
 * journey (spec sections 3-4, 21-46, 87).
 *
 * Upload -> Processing -> Review -> Approve payroll evidence -> Compare
 * current vs proposed -> explicit Apply. Every step before the final Apply
 * click is INERT — nothing here mutates canonical Income until the user
 * presses "Apply" and the atomic RPC accepts it (spec section 4).
 *
 * WHY THIS FILE, NOT A NEW `components/financial-data-hub/*` FILE. Product
 * architecture (spec section 3): FDH-9 is not a new technical destination —
 * it lives entirely behind the Income tab. This component therefore lives at
 * `components/income/`, alongside the rest of the Income experience, and
 * talks to the FDH-backed API surface purely over `fetch()` — the same
 * relationship any other HTTP client has to a public route, not a
 * `lib/financial-data-hub` import. `tests/unit/fdh1Isolation.test.ts`'s
 * "is imported by nothing outside itself" check is a naive path-substring
 * search, so this file (and its one call site,
 * `app/(app)/income/page.tsx`) is named alongside `incomeAdapter.ts` and
 * `lib/import-bridge/types.ts` in that test's own documented
 * `FDH_APPROVED_CONSUMER_FILES` allowlist, for the identical reason those two
 * are already there — see that test's own comment for the precedent.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatMoneyExact } from '@/lib/engines/money';
import { normaliseProposedFields, type ProposedField } from '@/lib/import-bridge/proposedFieldShape';
import { PayslipDetails } from '@/components/income/PayslipDetails';
import { fieldReasonText, reviewReasonText } from '@/lib/income/payslipProposalText';
import {
  waitForDocumentToLeaveValidating,
  SCANNING_MESSAGE,
  SCAN_TIMEOUT_MESSAGE,
} from '@/components/financial-data-hub/scanStatusPolling';

type Phase =
  | 'form'
  | 'uploading'
  | 'scanning'
  | 'processing'
  | 'unable_to_read'
  | 'scan_timeout'
  | 'ai_fallback_review'
  | 'duplicate'
  | 'review'
  // 2026-09-24. "Review / Correct" used to call `loadReview()`, which
  // re-fetched the payroll event and set the phase this panel was ALREADY in
  // — it re-rendered identical content and changed nothing a user could see,
  // with no correction surface behind it at all. This phase is that surface.
  | 'correcting'
  | 'comparing'
  | 'applied'
  | 'kept_existing'
  | 'stale'
  | 'error';

// 2026-09-21 (real-malware-gate async fix): a document can legitimately come
// back from the real S3+GuardDuty scan REJECTED (processing_status
// 'failed'/'rejected', not merely stuck) once the scan resolves after this
// panel already moved past `handleUpload()`'s own inline poll. Named the
// same honest, non-technical way `structural_scan_rejected` already is
// (FdhDocumentUploadClient.tsx's own precedent) — never "malware" or
// "virus", and never a raw enum name.
const SCAN_REJECTION_MESSAGES: Record<string, string> = {
  malware_detected: 'This file could not be accepted because it failed a security check. Please try a different file, or add this income manually below.',
  malware_scan_suspicious: 'This file could not be accepted because it failed a security check. Please try a different file, or add this income manually below.',
  malware_scan_failed: 'We could not finish checking this file for safety. Please try again, or add this income manually below.',
  malware_scan_timeout: 'We could not finish checking this file for safety in time. Please try again, or add this income manually below.',
  malware_scan_unknown: 'We could not finish checking this file for safety. Please try again, or add this income manually below.',
};

// AI-fallback addition (2026-09-22). Mirrors the money/date field subset
// `lib/aie/adapters/payslip/types.ts`'s `PAYSLIP_AI_COMPLETABLE_FIELDS`
// declares — this UI never invents a field the backend contract does not
// also recognise. Nothing here is written until the user presses "Save these
// details", matching this whole panel's own "every step before the final
// action is INERT" discipline (this file's header).
interface AiFallbackDraft {
  country: 'AU' | 'IN';
  currencyCode: string;
  employerName?: string | null;
  payPeriodStart?: string | null;
  payPeriodEnd?: string | null;
  paymentDate?: string | null;
  payFrequency: string;
  grossPay?: number | null;
  netPay?: number | null;
  taxWithheld?: number | null;
  employerRetirementContribution?: number | null;
}

const AI_DRAFT_FIELD_LABELS: Record<string, string> = {
  employerName: 'Employer',
  payPeriodStart: 'Pay period start (YYYY-MM-DD)',
  payPeriodEnd: 'Pay period end (YYYY-MM-DD)',
  grossPay: 'Gross pay',
  netPay: 'Net pay',
  taxWithheld: 'Tax withheld',
};

type Decision = 'add_new' | 'update_existing' | 'apply_selected_fields' | 'keep_existing';

interface PayrollEvent {
  id: string;
  employer_name: string | null;
  pay_period_start: string | null;
  pay_period_end: string | null;
  gross_pay: number | null;
  base_pay: number | null;
  overtime_pay: number | null;
  bonus_pay: number | null;
  net_pay: number | null;
  tax_withheld: number | null;
  employer_retirement_contribution: number | null;
  reconciliation_status: 'reconciled' | 'variance' | 'insufficient_data';
  reconciliation_variance: number | null;
  bank_match_status: 'matched' | 'no_match' | 'multiple_candidates' | 'not_attempted';
  approval_status: 'pending' | 'approved';
  country_code: string;
  currency_code: string;
  // Migration 0185. Present once that migration is applied; treated as
  // optional here so this panel renders correctly against an environment
  // where it is not, rather than showing `undefined`.
  gross_pay_source?: 'stated_on_document' | 'derived_from_components' | 'user_corrected' | null;
  user_corrected_fields?: string[] | null;
  last_corrected_at?: string | null;
  // WP-09.
  review_status?: 'not_required' | 'pending' | 'in_review' | 'resolved';
  income_owner?: 'self' | 'spouse' | null;
  payment_date?: string | null;
  pay_frequency?: string | null;
  [column: string]: unknown;
}

/** An earlier payslip this one would revise (GET /payslip/{id} `revision_of`). */
interface RevisionOf {
  payroll_event_id: string;
  pay_period_start: string | null;
  pay_period_end: string | null;
  gross_pay: number | null;
  net_pay: number | null;
  approval_status: string;
  currency_code: string;
}

/**
 * The fields this panel lets a user correct, in the order it shows them.
 * WP-09 (GAP-07): EXACTLY the vocabulary fdh9_correct_payroll_event (0185)
 * and the correct route accept -- every figure a payslip carries can be fixed,
 * not only the ten the first version offered.
 */
const CORRECTABLE_FIELDS = [
  'employer_name',
  'pay_period_start',
  'pay_period_end',
  'payment_date',
  'pay_frequency',
  'gross_pay',
  'base_pay',
  'overtime_pay',
  'bonus_pay',
  'commission_pay',
  'allowances_total',
  'reimbursements_total',
  'other_earnings',
  'tax_withheld',
  'employee_deductions_total',
  'salary_sacrifice',
  'professional_tax',
  'employer_retirement_contribution',
  'employee_retirement_contribution',
  'employer_nps_contribution',
  'employee_nps_contribution',
  'net_pay',
] as const;
type CorrectableField = (typeof CORRECTABLE_FIELDS)[number];

const CORRECTION_LABELS: Record<CorrectableField, string> = {
  employer_name: 'Employer',
  pay_period_start: 'Pay period start (YYYY-MM-DD)',
  pay_period_end: 'Pay period end (YYYY-MM-DD)',
  payment_date: 'Payment date (YYYY-MM-DD)',
  pay_frequency: 'How often you are paid',
  gross_pay: 'Gross pay for this pay period',
  base_pay: 'Ordinary earnings for this pay period',
  overtime_pay: 'Overtime for this pay period',
  bonus_pay: 'Bonus for this pay period',
  commission_pay: 'Commission for this pay period',
  allowances_total: 'Allowances for this pay period',
  reimbursements_total: 'Reimbursements for this pay period',
  other_earnings: 'Other earnings / arrears for this pay period',
  tax_withheld: 'Tax withheld for this pay period',
  employee_deductions_total: 'Other deductions for this pay period',
  salary_sacrifice: 'Salary sacrifice for this pay period',
  professional_tax: 'Professional tax for this pay period',
  employer_retirement_contribution: 'Employer super / retirement contribution',
  employee_retirement_contribution: 'Your super / PF contribution',
  employer_nps_contribution: 'Employer NPS contribution',
  employee_nps_contribution: 'Your NPS contribution',
  net_pay: 'Net pay for this pay period',
};

const MONEY_CORRECTION_FIELDS: readonly CorrectableField[] = [
  'gross_pay', 'base_pay', 'overtime_pay', 'bonus_pay', 'commission_pay', 'allowances_total',
  'reimbursements_total', 'other_earnings', 'tax_withheld', 'employee_deductions_total',
  'salary_sacrifice', 'professional_tax', 'employer_retirement_contribution',
  'employee_retirement_contribution', 'employer_nps_contribution', 'employee_nps_contribution', 'net_pay',
];

/** The payslip frequency vocabulary (fdh_payroll_events.pay_frequency). */
const PAY_FREQUENCY_OPTIONS: { value: string; label: string }[] = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'fortnightly', label: 'Fortnightly' },
  { value: 'semimonthly', label: 'Twice a month' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'annual', label: 'Annually' },
  { value: 'irregular', label: 'Irregular' },
  { value: 'unknown', label: 'Not sure' },
];

/** The Income frequencies a user may choose at the compare step (GAP-12). */
const INCOME_FREQUENCY_CHOICES: { value: string; label: string }[] = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'fortnightly', label: 'Fortnightly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'annually', label: 'Annually' },
];

/** A payslip left part-way (GET /waiting-imports?kind=payslip). */
interface WaitingPayslip {
  document_id: string;
  stage: 'ai_draft' | 'review' | 'compare' | 'apply';
  label: string | null;
  period_end: string | null;
  currency_code: string | null;
  ai_fallback_draft?: unknown;
}

const WAITING_STAGE_TEXT: Record<WaitingPayslip['stage'], string> = {
  ai_draft: 'AI reading waiting for your check',
  review: 'Waiting for your approval',
  compare: 'Approved — not yet added to your income',
  apply: 'Approved — not yet added to your income',
};

interface ProposalSummary {
  title: string;
  lines: { label: string; value: string; note?: string }[];
  reviewReasons: string[];
}

const DUPLICATE_MESSAGE = 'You have already uploaded this payslip, so FHIP is continuing with the copy already on file.';

/** Honest, non-technical wording for where a gross figure came from. */
const GROSS_SOURCE_NOTE: Record<string, string> = {
  stated_on_document: '',
  derived_from_components: 'Worked out from the pay lines on this payslip — this payslip does not print a gross total.',
  user_corrected: 'You corrected this figure.',
};

// The API sends snake_case rows; normaliseProposedFields maps them (see its
// header for the production defect this fixes).

const FIELD_LABELS: Record<string, string> = {
  source_name: 'Name',
  employer_name: 'Employer',
  income_type: 'Income type',
  amount: 'Gross amount',
  net_amount: 'Net amount',
  frequency: 'Frequency',
  currency_code: 'Currency',
  is_taxable: 'Taxable',
};

function money(value: number | null | undefined, currency: string) {
  if (value === null || value === undefined) return 'Not shown on payslip';
  // App Review 2026-09-15 G1 sanctioned exception (a): this renders the
  // value as printed on the payslip, next to the payslip, for
  // character-for-character verification. See lib/engines/money.ts.
  return formatMoneyExact(value, currency);
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

export function PayslipImportPanel({ onClose, onApplied }: { onClose: () => void; onApplied?: () => void }) {
  const [phase, setPhase] = useState<Phase>('form');
  const [country, setCountry] = useState<'AU' | 'IN'>('AU');
  const [file, setFile] = useState<File | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [event, setEvent] = useState<PayrollEvent | null>(null);
  const [proposalId, setProposalId] = useState<string | null>(null);
  const [fields, setFields] = useState<ProposedField[]>([]);
  const [decision, setDecision] = useState<Decision>('update_existing');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  // Real-malware-gate async fix (2026-09-21): cancels an in-flight status
  // poll if the panel unmounts (e.g. the user navigates away) mid-scan, so
  // no setState-after-unmount warning and no wasted polling.
  const scanPollCancelRef = useRef({ cancelled: false });
  useEffect(() => () => {
    scanPollCancelRef.current.cancelled = true;
  }, []);
  // AI-fallback addition: the draft `process` returned when native parsing
  // failed but AI-fallback produced a usable extraction. Editable — the
  // whole point of this step is to let the user correct it before anything
  // is saved.
  const [aiDraft, setAiDraft] = useState<AiFallbackDraft | null>(null);
  // 2026-09-24 correction surface. `corrections` holds the RAW string in each
  // input, seeded from the extracted event; only the entries that actually
  // differ from the stored value are ever submitted, so
  // `user_corrected_fields` records what the user really touched rather than
  // every field they looked at.
  const [corrections, setCorrections] = useState<Record<string, string>>({});
  const [correctionError, setCorrectionError] = useState<string | null>(null);
  const [correctionNotice, setCorrectionNotice] = useState<string | null>(null);
  // App Review 2026-09-14, item 2: same gap as BankStatementImportPanel.tsx
  // (see that file's identical comment) — this panel used to always render
  // as a fully working upload form and only discover the FDH-3 production
  // hard gate (lib/financial-data-hub/constants/featureFlags.ts) when the
  // upload itself failed. `null` = not checked yet; `true`/`false` once known.
  const [uploadEnabled, setUploadEnabled] = useState<boolean | null>(null);
  // 2026-09-25: payslips already read and waiting to be added. Before this,
  // closing the panel or reloading the page stranded a proposal -- nothing on
  // screen listed it, and re-uploading only reached the duplicate guard.
  const [waiting, setWaiting] = useState<WaitingPayslip[]>([]);
  // WP-09. Whose payslip this is (GAP-05) -- chosen at upload, confirmed at
  // review, recorded at approval and fixed from then on.
  const [incomeOwner, setIncomeOwner] = useState<'self' | 'spouse'>('self');
  // The user has looked at the figures this payslip flagged for review.
  const [reviewAcknowledged, setReviewAcknowledged] = useState(false);
  // GAP-15: an earlier payslip this one revises, and whether it replaces it.
  const [revisionOf, setRevisionOf] = useState<RevisionOf | null>(null);
  const [replacesEarlier, setReplacesEarlier] = useState(true);
  // GAP-07: the payslip's own lines, and the proposal's explanation.
  const [components, setComponents] = useState<Record<string, unknown>[]>([]);
  const [showDetails, setShowDetails] = useState(false);
  const [summary, setSummary] = useState<ProposalSummary | null>(null);
  // GAP-12: a frequency chosen for a payslip whose own has no Income equivalent.
  const [frequencyChoice, setFrequencyChoice] = useState('monthly');

  // WP-09 (GAP-11): every payslip left part-way -- an AI reading awaiting a
  // check, evidence awaiting approval, or an approved payslip never added --
  // not only a 'ready' proposal.
  const loadWaiting = useCallback(() => {
    fetch('/api/financial-data-hub/waiting-imports?kind=payslip')
      .then((res) => (res.ok ? res.json() : { data: { items: [] } }))
      .then((json) => setWaiting(Array.isArray(json.data?.items) ? (json.data.items as WaitingPayslip[]) : []))
      .catch(() => setWaiting([]));
  }, []);

  useEffect(() => {
    loadWaiting();
  }, [loadWaiting]);

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
    setPhase('form');
    setFile(null);
    setDocumentId(null);
    setMessage(null);
    setEvent(null);
    setProposalId(null);
    setFields([]);
    setSelected(new Set());
    setAiDraft(null);
    setCorrections({});
    setCorrectionError(null);
    setCorrectionNotice(null);
    setReviewAcknowledged(false);
    setRevisionOf(null);
    setReplacesEarlier(true);
    setComponents([]);
    setShowDetails(false);
    setSummary(null);
  }, []);

  /** Seed every correction input from what was actually extracted. */
  function startCorrecting(current: PayrollEvent) {
    const seeded: Record<string, string> = {};
    for (const field of CORRECTABLE_FIELDS) {
      const value = current[field as keyof PayrollEvent];
      if (value === null || value === undefined) {
        // Blank, not "0" — an absent figure stays absent until the user
        // decides otherwise.
        seeded[field] = '';
        continue;
      }
      // Money arrives from a numeric(20,4) column, so "2870.0000" is a
      // faithful but unreadable way to show $2,870. Trailing zeros are
      // dropped for display only; the value is identical.
      seeded[field] = MONEY_CORRECTION_FIELDS.includes(field) ? String(Number(value)) : String(value);
    }
    setCorrections(seeded);
    setCorrectionError(null);
    setCorrectionNotice(null);
    setPhase('correcting');
  }

  /** Only the fields whose value the user actually changed. */
  function changedCorrections(current: PayrollEvent): Record<string, string | number | null> {
    const body: Record<string, string | number | null> = {};
    for (const field of CORRECTABLE_FIELDS) {
      const raw = (corrections[field] ?? '').trim();
      const stored = current[field as keyof PayrollEvent];
      const storedText = stored === null || stored === undefined ? '' : String(stored);
      if (MONEY_CORRECTION_FIELDS.includes(field)) {
        // Compare numerically, so "2870" and "2870.0000" are not a change.
        const before = storedText === '' ? null : Number(storedText);
        const after = raw === '' ? null : Number(raw);
        if (after !== null && !Number.isFinite(after)) {
          throw new Error(`${CORRECTION_LABELS[field]} must be a number, or left blank.`);
        }
        if (before === after) continue;
        body[field] = after;
        continue;
      }
      if (raw === storedText) continue;
      body[field] = raw === '' ? null : raw;
    }
    return body;
  }

  async function handleSaveCorrections() {
    if (!documentId || !event) return;
    setCorrectionError(null);
    setCorrectionNotice(null);
    let body: Record<string, string | number | null>;
    try {
      body = changedCorrections(event);
    } catch (e) {
      setCorrectionError(e instanceof Error ? e.message : 'Check each figure and try again.');
      return;
    }
    if (Object.keys(body).length === 0) {
      setCorrectionError('Nothing has been changed yet. Edit a value, or choose Cancel.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/financial-data-hub/payslip/${documentId}/correct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const { ok, json } = await readJson(res);
      if (!ok) {
        setCorrectionError(json.error ?? 'These corrections could not be saved.');
        return;
      }
      const saved = json.data.payroll_event as PayrollEvent | null;
      if (saved) setEvent(saved);
      const count = (json.data.corrected_fields as string[] | undefined)?.length ?? Object.keys(body).length;
      setCorrectionNotice(
        `Saved ${count} ${count === 1 ? 'correction' : 'corrections'}. `
        + (json.data.reconciliation_restamped
          ? 'The gross-to-net check has been run again on your figures.'
          : 'The gross-to-net check is unchanged.'),
      );
      setPhase('review');
    } catch (e) {
      setCorrectionError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function loadReview(docId: string) {
    const res = await fetch(`/api/financial-data-hub/payslip/${docId}`);
    const { ok, json } = await readJson(res);
    if (!ok) {
      setMessage(json.error ?? 'We could not load this payslip.');
      setPhase('error');
      return;
    }
    const loaded = json.data.payroll_event as PayrollEvent;
    setEvent(loaded);
    setComponents(Array.isArray(json.data.components) ? (json.data.components as Record<string, unknown>[]) : []);
    setRevisionOf((json.data.revision_of as RevisionOf | null | undefined) ?? null);
    if (loaded.income_owner === 'spouse' || loaded.income_owner === 'self') setIncomeOwner(loaded.income_owner);
    setPhase('review');
  }

  async function handleUpload() {
    if (!file) return;
    setBusy(true);
    setPhase('uploading');
    setMessage(null);
    try {
      const sessionRes = await fetch('/api/financial-data-hub/documents/upload-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          document_type: 'payslip',
          source_type: 'pdf_native',
          country_code: country,
          declared_mime_type: 'application/pdf',
          declared_file_size_bytes: file.size,
        }),
      });
      const { ok: sessionOk, json: sessionJson } = await readJson(sessionRes);
      if (!sessionOk) throw new Error(sessionJson.error ?? 'Could not start upload');

      const completeRes = await fetch(
        `/api/financial-data-hub/documents/upload-sessions/${sessionJson.data.session_id}/complete`,
        { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: file },
      );
      const { ok: completeOk, json: completeJson } = await readJson(completeRes);
      if (!completeOk) throw new Error(completeJson.error ?? 'Upload failed');
      const docId = completeJson.data.document_id as string;
      setDocumentId(docId);

      // Real-malware-gate async fix (2026-09-21): completeUpload() may have
      // left this document genuinely, legally waiting in `validating` — the
      // real S3+GuardDuty scan has not resolved yet (see
      // malwareScanGate.ts's own header). Calling /process immediately in
      // that case used to surface a raw `invalid_state` error even though
      // nothing had gone wrong. Wait for the document to leave `validating`
      // first, showing an honest "scanning" state instead.
      if (completeJson.data.processing_status === 'validating') {
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
              ?? 'This file could not be accepted. Please try a different file, or add this income manually below.',
          );
          setPhase('unable_to_read');
          return;
        }
        setMessage(null);
      }

      setPhase('processing');
      const processRes = await fetch(`/api/financial-data-hub/payslip/${docId}/process`, { method: 'POST' });
      const { ok: processOk, json: processJson } = await readJson(processRes);
      if (!processOk) {
        setMessage(processJson.error ?? 'We could not process this payslip.');
        setPhase('unable_to_read');
        return;
      }
      if (processJson.data.pipeline_status === 'ai_fallback_available' && processJson.data.ai_fallback_draft) {
        setAiDraft(processJson.data.ai_fallback_draft as AiFallbackDraft);
        setPhase('ai_fallback_review');
        return;
      }
      if (processJson.data.error_code) {
        setMessage(processJson.data.error_message ?? 'We could not read this payslip.');
        setPhase('unable_to_read');
        return;
      }
      if (processJson.data.duplicate) {
        // Carry on with the ORIGINAL upload: this copy has no payroll
        // evidence of its own, so reviewing it dead-ends (production,
        // 2026-09-25).
        const original = (processJson.data.duplicate_of_document_id as string | null) ?? docId;
        setDocumentId(original);
        setMessage(DUPLICATE_MESSAGE);
        await loadReview(original);
        setPhase((p) => (p === 'error' ? p : 'duplicate'));
        return;
      }
      await loadReview(docId);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Something went wrong.');
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }

  function updateAiDraftField<K extends keyof AiFallbackDraft>(key: K, value: AiFallbackDraft[K]) {
    setAiDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  async function handleConfirmAiDraft() {
    if (!documentId || !aiDraft) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/financial-data-hub/payslip/${documentId}/ai-fallback/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(aiDraft),
      });
      const { ok, json } = await readJson(res);
      if (!ok) throw new Error(json.error ?? 'We could not save this payslip.');
      setAiDraft(null);
      if (json.data.duplicate) {
        const original = (json.data.duplicate_of_document_id as string | null) ?? documentId;
        setDocumentId(original);
        setMessage(DUPLICATE_MESSAGE);
        await loadReview(original);
        setPhase((p) => (p === 'error' ? p : 'duplicate'));
        return;
      }
      await loadReview(documentId);
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
      const res = await fetch(`/api/financial-data-hub/payslip/${documentId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          income_owner: incomeOwner,
          acknowledge_review: reviewAcknowledged,
          replaces_earlier: Boolean(revisionOf) && replacesEarlier,
        }),
      });
      const { ok, json } = await readJson(res);
      if (!ok) throw new Error(json.error ?? 'Could not approve this payroll evidence.');
      await loadReview(documentId);
      await handleGenerateProposal();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Something went wrong.');
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }

  /** Continue a payslip left part-way, at the stage it was left (GAP-11). */
  async function resumeWaiting(w: WaitingPayslip) {
    setDocumentId(w.document_id);
    setMessage(null);
    if (w.stage === 'ai_draft' && w.ai_fallback_draft) {
      setAiDraft(w.ai_fallback_draft as AiFallbackDraft);
      setPhase('ai_fallback_review');
      return;
    }
    if (w.stage === 'review') {
      setBusy(true);
      try {
        await loadReview(w.document_id);
      } finally {
        setBusy(false);
      }
      return;
    }
    await handleGenerateProposal(w.document_id);
  }

  async function handleGenerateProposal(forDocumentId?: string, frequency?: string) {
    const target = forDocumentId ?? documentId;
    if (!target) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/financial-data-hub/payslip/${target}/proposal`, {
        method: 'POST',
        ...(frequency ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ frequency }) } : {}),
      });
      const { ok, json } = await readJson(res);
      // A re-upload of an already-imported payslip: continue with the original.
      if (!ok && json.error === 'duplicate_payslip' && typeof json.duplicate_of_document_id === 'string' && !forDocumentId) {
        setDocumentId(json.duplicate_of_document_id);
        setMessage(DUPLICATE_MESSAGE);
        await handleGenerateProposal(json.duplicate_of_document_id);
        return;
      }
      // WP-09 (GAP-04): this payslip is already in Income -- never a second proposal.
      if (!ok && json.code === 'ALREADY_APPLIED') {
        setMessage('This payslip is already in your income, so nothing more needs to be added.');
        setPhase('applied');
        loadWaiting();
        return;
      }
      // WP-09 (GAP-11): a re-upload of a payslip that was never approved opens
      // its review step instead of an error.
      if (!ok && json.code === 'NOT_APPROVED') {
        setDocumentId(target);
        await loadReview(target);
        return;
      }
      if (!ok) throw new Error(json.message ?? json.error ?? 'We could not prepare an income comparison for this payslip.');
      setProposalId(json.data.proposal_id as string);
      const pfields = normaliseProposedFields(json.data.fields);
      setFields(pfields);
      const defaultSel = new Set(
        pfields.filter((f) => f.isRecommended && !f.requiresConfirmation && f.proposedValue !== f.existingValue).map((f) => f.fieldName),
      );
      setSelected(defaultSel);
      setDecision(json.data.proposal?.target_entity_id ? 'update_existing' : 'add_new');
      // GAP-07: the adapter's explanation, from this response or the stored proposal.
      const s = (json.data.summary ?? json.data.proposal?.summary ?? null) as ProposalSummary | null;
      setSummary(s && Array.isArray(s.lines) ? { title: String(s.title ?? ''), lines: s.lines, reviewReasons: Array.isArray(s.reviewReasons) ? s.reviewReasons : [] } : null);
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
      const res = await fetch(`/api/financial-data-hub/income-proposals/${proposalId}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision,
          // AIE-1 final completion (2026-09-25), found by the live DEV journey:
          // `add_new` used to send NO fields, and `fdh9_apply_income_proposal`
          // (0091/0120) resolves an empty selection to NO_FIELDS_SELECTED for
          // every decision except `update_existing` -- so "add as new income"
          // could never succeed for a user with no matching Income row. It
          // now sends the recommended selection the review already shows
          // (for a new row: every recommended field, since nothing exists).
          selectedFields: decision === 'apply_selected_fields' || decision === 'add_new' ? Array.from(selected) : undefined,
        }),
      });
      const { ok, status, json } = await readJson(res);
      if (!ok) {
        if (status === 409 && json.code === 'STALE_PROPOSAL') {
          setMessage('Your Income information has changed since this proposal was created. Review the latest values before applying.');
          setPhase('stale');
          return;
        }
        if (status === 409 && json.code === 'ALREADY_APPLIED') {
          setMessage('This payslip is already in your income, so it was not added again.');
          setPhase('applied');
          return;
        }
        // WP-09 (0210): the entry chosen belongs to someone else, or is in
        // another currency. Nothing was changed; "Refresh comparison" builds a
        // proposal from the payslip's own member and currency.
        if (status === 409 && (json.code === 'CURRENCY_MISMATCH' || json.code === 'MEMBER_MISMATCH')) {
          setMessage(`${json.error ?? 'This payslip cannot update that income entry.'} Nothing was changed.`);
          setPhase('stale');
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
      loadWaiting(); // this proposal is no longer waiting
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

  const reconciliationLabel: Record<string, string> = {
    reconciled: 'Reconciled — gross to net matches your payslip',
    variance: 'Needs review — a small gap between gross and net was found',
    insufficient_data: 'Insufficient information to check gross against net',
  };
  const bankMatchLabel: Record<string, string> = {
    matched: 'Matched to a bank deposit',
    no_match: 'No matching bank evidence is currently available',
    multiple_candidates: 'We found more than one possible matching deposit. Please review.',
    not_attempted: 'Bank matching was not attempted',
  };

  return (
    <div
      role="region"
      aria-label="Import income from payslip"
      className="rounded border border-gray-200 p-5"
      aria-live="polite"
    >
      <div className="flex items-start justify-between gap-4">
        <h2 className="text-lg font-semibold text-trust">Import from Payslip</h2>
        <button type="button" onClick={onClose} className="text-sm text-muted underline" aria-label="Close payslip import">
          Close
        </button>
      </div>

      {uploadEnabled === false && phase === 'form' && (
        <div className="mt-4 space-y-2">
          <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Payslip import isn&apos;t turned on in this environment yet. You can still add this income yourself
            using the Income form below.
          </p>
        </div>
      )}

      {phase === 'form' && waiting.length > 0 && (
        <section className="mt-4 space-y-2" aria-labelledby="payslips-waiting-heading">
          <h3 id="payslips-waiting-heading" className="text-sm font-semibold">
            {waiting.length === 1 ? 'A payslip is waiting for you' : `${waiting.length} payslips are waiting for you`}
          </h3>
          <ul className="space-y-2">
            {waiting.map((w) => (
              <li key={`${w.document_id}-${w.stage}`} className="flex flex-wrap items-center justify-between gap-2 rounded border border-gray-200 px-3 py-2 text-sm">
                <span>
                  {w.label ?? 'Employer not identified'}
                  {w.period_end && ` · period ending ${w.period_end}`}
                  <span className="block text-xs text-muted">{WAITING_STAGE_TEXT[w.stage]}</span>
                </span>
                <button
                  type="button"
                  onClick={() => resumeWaiting(w)}
                  disabled={busy}
                  className="rounded bg-trust px-3 py-1 text-white disabled:opacity-50"
                >
                  Continue
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {uploadEnabled !== false && phase === 'form' && (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-muted">
            Upload a payslip and FHIP will extract your income details for you to review before updating your Income
            information.
          </p>
          <label className="block text-sm">
            <span className="mb-1 block text-muted">Country this payslip is from</span>
            <select
              className="w-full max-w-xs rounded border border-gray-300 px-3 py-2"
              value={country}
              onChange={(e) => setCountry(e.target.value as 'AU' | 'IN')}
            >
              <option value="AU">Australia</option>
              <option value="IN">India</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-muted">Whose payslip is this?</span>
            <select
              className="w-full max-w-xs rounded border border-gray-300 px-3 py-2"
              value={incomeOwner}
              onChange={(e) => setIncomeOwner(e.target.value === 'spouse' ? 'spouse' : 'self')}
            >
              <option value="self">Mine</option>
              <option value="spouse">My spouse&apos;s</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-muted">Payslip file (PDF, up to 20MB)</span>
            <input
              type="file"
              accept="application/pdf"
              className="block w-full text-sm"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <button
            type="button"
            onClick={handleUpload}
            disabled={!file || busy || uploadEnabled !== true}
            className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            Upload payslip
          </button>
        </div>
      )}

      {(phase === 'uploading' || phase === 'processing' || phase === 'scanning') && (
        <p className="mt-4 text-sm text-muted" role="status">
          {phase === 'uploading' && 'Uploading your payslip…'}
          {phase === 'scanning' && (message ?? SCANNING_MESSAGE)}
          {phase === 'processing' && 'Processing your payslip — extracting payroll information…'}
        </p>
      )}

      {phase === 'unable_to_read' && (
        <div className="mt-4 space-y-3">
          <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">{message}</p>
          <p className="text-sm text-muted">You can try a different file, or add this income manually below.</p>
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

      {phase === 'ai_fallback_review' && aiDraft && (
        <div className="mt-4 space-y-4">
          <p className="rounded bg-blue-50 px-3 py-2 text-sm text-blue-900">
            We could not read this payslip&apos;s layout automatically, so we used AI to read it instead. Please check
            these details before saving — nothing has been saved yet.
          </p>
          <dl className="grid grid-cols-1 gap-3 text-sm">
            {(['employerName', 'payPeriodStart', 'payPeriodEnd', 'grossPay', 'netPay', 'taxWithheld'] as const).map((key) => (
              <div key={key}>
                <label className="mb-1 block text-muted" htmlFor={`ai-draft-${key}`}>
                  {AI_DRAFT_FIELD_LABELS[key] ?? key}
                </label>
                <input
                  id={`ai-draft-${key}`}
                  type={key.includes('Pay') || key === 'grossPay' || key === 'netPay' || key === 'taxWithheld' ? 'number' : 'text'}
                  className="w-full max-w-xs rounded border border-gray-300 px-3 py-2"
                  value={aiDraft[key] ?? ''}
                  onChange={(e) => {
                    const raw = e.target.value;
                    const isMoney = key === 'grossPay' || key === 'netPay' || key === 'taxWithheld';
                    updateAiDraftField(key, (isMoney ? (raw === '' ? null : Number(raw)) : raw === '' ? null : raw) as AiFallbackDraft[typeof key]);
                  }}
                />
              </div>
            ))}
          </dl>
          <p className="text-xs text-muted">
            AI-read values are shown for your confirmation only — correct anything that looks wrong before saving.
          </p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => {
                setAiDraft(null);
                setMessage("This doesn't look like a payslip we can read yet. Please check the file, or add this income manually.");
                setPhase('unable_to_read');
              }}
              className="rounded border border-gray-300 px-3 py-1 text-sm"
            >
              This doesn&apos;t look right
            </button>
            <button
              type="button"
              onClick={handleConfirmAiDraft}
              disabled={busy || (aiDraft.grossPay == null && aiDraft.netPay == null)}
              className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              Save these details
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

      {(phase === 'review' || phase === 'duplicate') && event && (
        <div className="mt-4 space-y-4">
          <h3 className="font-semibold">Payslip review</h3>
          {phase === 'duplicate' && message && (
            <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">{message}</p>
          )}
          {/* Announced, not just displayed: a correction that has just been
              saved is a status change the user may not be looking at. */}
          {correctionNotice && (
            <p className="rounded bg-green-50 px-3 py-2 text-sm text-green-800" role="status" aria-live="polite">
              {correctionNotice}
            </p>
          )}
          {(event.user_corrected_fields?.length ?? 0) > 0 && (
            <p className="text-xs text-muted">
              {event.user_corrected_fields!.length === 1 ? 'One figure below was' : `${event.user_corrected_fields!.length} figures below were`}{' '}
              corrected by you, not read from the payslip.
            </p>
          )}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted">Employer</dt>
            <dd>{event.employer_name ?? 'Not identified'}</dd>
            <dt className="text-muted">Pay period</dt>
            <dd>
              {event.pay_period_start && event.pay_period_end ? `${event.pay_period_start} – ${event.pay_period_end}` : 'Not identified'}
            </dd>
            <dt className="text-muted">Gross pay</dt>
            <dd>
              {money(event.gross_pay, event.currency_code)}
              {event.gross_pay_source && GROSS_SOURCE_NOTE[event.gross_pay_source] && (
                <span className="mt-0.5 block text-xs text-muted">{GROSS_SOURCE_NOTE[event.gross_pay_source]}</span>
              )}
              {event.gross_pay === null && (
                <span className="mt-0.5 block text-xs text-muted">
                  This payslip doesn&apos;t state a gross figure we could read, and we haven&apos;t assumed one. You can
                  enter it below.
                </span>
              )}
            </dd>
            <dt className="text-muted">Ordinary earnings</dt>
            <dd>{money(event.base_pay, event.currency_code)}</dd>
            {(event.overtime_pay ?? 0) > 0 && (
              <>
                <dt className="text-muted">Overtime</dt>
                <dd>{money(event.overtime_pay, event.currency_code)}</dd>
              </>
            )}
            {(event.bonus_pay ?? 0) > 0 && (
              <>
                <dt className="text-muted">Bonus</dt>
                <dd>{money(event.bonus_pay, event.currency_code)}</dd>
              </>
            )}
            <dt className="text-muted">Tax withheld</dt>
            <dd>{money(event.tax_withheld, event.currency_code)}</dd>
            {(event.employer_retirement_contribution ?? 0) > 0 && (
              <>
                <dt className="text-muted">Employer super / retirement contribution</dt>
                <dd>{money(event.employer_retirement_contribution, event.currency_code)} (evidence only — not added to your income)</dd>
              </>
            )}
            <dt className="text-muted">Net pay</dt>
            <dd>{money(event.net_pay, event.currency_code)}</dd>
          </dl>

          <p className="text-sm" role="status">
            <span className="font-medium">Gross-to-net check: </span>
            {reconciliationLabel[event.reconciliation_status]}
          </p>
          <p className="text-sm" role="status">
            <span className="font-medium">Bank match: </span>
            {bankMatchLabel[event.bank_match_status]}
          </p>

          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            aria-expanded={showDetails}
            className="text-sm text-trust underline"
          >
            {showDetails ? 'Hide every figure on this payslip' : 'See every figure on this payslip'}
          </button>
          {showDetails && <PayslipDetails event={event} components={components} />}

          {revisionOf && event.approval_status !== 'approved' && (
            <div className="rounded bg-blue-50 px-3 py-2 text-sm text-blue-900" data-testid="payslip-revision">
              <p>
                You already have a payslip from this employer for the period
                {revisionOf.pay_period_start ? ` ${revisionOf.pay_period_start} –` : ''} {revisionOf.pay_period_end ?? ''}
                {revisionOf.net_pay !== null && ` (net ${money(revisionOf.net_pay, revisionOf.currency_code)})`}.
              </p>
              <label className="mt-1 flex items-center gap-2">
                <input type="checkbox" checked={replacesEarlier} onChange={(e) => setReplacesEarlier(e.target.checked)} />
                This is a revised payslip — it replaces the earlier one
              </label>
            </div>
          )}

          {event.approval_status === 'approved' ? (
            <p className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">
              This payroll evidence has been approved{event.income_owner === 'spouse' ? ' as your spouse’s income' : ''}.
            </p>
          ) : (
            <fieldset className="space-y-2 text-sm">
              <legend className="font-medium">Whose payslip is this?</legend>
              <label className="mr-4 inline-flex items-center gap-2">
                <input type="radio" name="payslip-owner" checked={incomeOwner === 'self'} onChange={() => setIncomeOwner('self')} />
                Mine
              </label>
              <label className="inline-flex items-center gap-2">
                <input type="radio" name="payslip-owner" checked={incomeOwner === 'spouse'} onChange={() => setIncomeOwner('spouse')} />
                My spouse&apos;s
              </label>
              <p className="text-xs text-muted">It will only update that person&apos;s income, and cannot be changed after you approve.</p>
            </fieldset>
          )}

          {event.approval_status !== 'approved' && (event.review_status === 'pending' || event.review_status === 'in_review') && (
            <label className="flex items-start gap-2 rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <input type="checkbox" className="mt-1" checked={reviewAcknowledged} onChange={(e) => setReviewAcknowledged(e.target.checked)} />
              Some figures on this payslip need your check. I have checked them (or corrected them) and they are right.
            </label>
          )}

          {event.approval_status === 'approved' ? null : (
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => startCorrecting(event)}
                disabled={busy}
                className="rounded border border-gray-300 px-3 py-1 text-sm disabled:opacity-50"
              >
                Correct these figures
              </button>
              <button
                type="button"
                onClick={() => handleApprove()}
                disabled={busy || ((event.review_status === 'pending' || event.review_status === 'in_review') && !reviewAcknowledged)}
                className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50"
              >
                Approve
              </button>
            </div>
          )}
          {event.approval_status === 'approved' && !proposalId && (
            <button
              type="button"
              onClick={() => handleGenerateProposal()}
              disabled={busy}
              className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              Continue to income comparison
            </button>
          )}
        </div>
      )}

      {phase === 'correcting' && event && (
        <div className="mt-4 space-y-4">
          <h3 className="font-semibold">Correct the figures from this payslip</h3>
          <p className="text-sm text-muted">
            These are the figures we read from your payslip. Change anything that doesn&apos;t match what the payslip
            actually says for <strong>this pay period</strong> — year-to-date totals belong in the year-to-date
            columns, not here. Leave a box empty if your payslip doesn&apos;t show that figure; empty means &ldquo;not
            stated&rdquo;, not zero. Nothing is added to your Income until you approve and apply.
          </p>

          {correctionError && (
            <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
              {correctionError}
            </p>
          )}

          <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            {CORRECTABLE_FIELDS.map((field) => {
              const isMoney = MONEY_CORRECTION_FIELDS.includes(field);
              const wasCorrected = event.user_corrected_fields?.includes(field) ?? false;
              return (
                <div key={field}>
                  <label className="mb-1 block text-muted" htmlFor={`payslip-correct-${field}`}>
                    {CORRECTION_LABELS[field]}
                    {isMoney && <span className="text-xs"> ({event.currency_code})</span>}
                  </label>
                  {field === 'pay_frequency' ? (
                    <select
                      id={`payslip-correct-${field}`}
                      className="w-full rounded border border-gray-300 px-3 py-2"
                      value={corrections[field] || 'unknown'}
                      onChange={(e) => {
                        const next = e.target.value;
                        setCorrections((prev) => ({ ...prev, [field]: next }));
                      }}
                    >
                      {PAY_FREQUENCY_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  ) : (
                  <input
                    id={`payslip-correct-${field}`}
                    type={isMoney ? 'number' : 'text'}
                    inputMode={isMoney ? 'decimal' : undefined}
                    step={isMoney ? '0.01' : undefined}
                    min={isMoney ? '0' : undefined}
                    className="w-full rounded border border-gray-300 px-3 py-2"
                    value={corrections[field] ?? ''}
                    aria-describedby={wasCorrected ? `payslip-correct-${field}-note` : undefined}
                    onChange={(e) => {
                      const next = e.target.value;
                      setCorrections((prev) => ({ ...prev, [field]: next }));
                    }}
                  />
                  )}
                  {wasCorrected && (
                    <span id={`payslip-correct-${field}-note`} className="mt-0.5 block text-xs text-muted">
                      You corrected this earlier.
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          <p className="text-xs text-muted">
            We&apos;ll re-run the gross-to-net check on whatever you save, and tell you the result — a correction is
            never assumed to be right just because you typed it.
          </p>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => {
                setCorrections({});
                setCorrectionError(null);
                setPhase('review');
              }}
              disabled={busy}
              className="rounded border border-gray-300 px-3 py-1 text-sm disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSaveCorrections}
              disabled={busy}
              className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save corrections'}
            </button>
          </div>
        </div>
      )}

      {(phase === 'comparing' || phase === 'stale') && (
        <div className="mt-4 space-y-4">
          <h3 className="font-semibold">Current income vs payslip proposal</h3>
          {phase === 'stale' && message && <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">{message}</p>}
          {/* WP-09 (GAP-07): why each figure was proposed -- the adapter's own
              explanation, which used to be built and thrown away. */}
          {summary && (
            <div className="space-y-2 rounded border border-gray-200 px-3 py-2 text-sm" data-testid="payslip-proposal-summary">
              {summary.title && <p className="font-medium">{summary.title}</p>}
              <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
                {summary.lines.map((l) => (
                  <div key={l.label}>
                    <dt className="text-xs text-muted">{l.label}</dt>
                    <dd>
                      {l.value}
                      {l.note && <span className="block text-xs text-muted">{l.note}</span>}
                    </dd>
                  </div>
                ))}
              </dl>
              {summary.reviewReasons.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-xs text-amber-900" aria-label="Please check">
                  {summary.reviewReasons.map((r) => (
                    <li key={r}>{reviewReasonText(r)}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {/* GAP-12: a payslip paid twice a month or irregularly has no Income
              frequency of its own; the user chooses one and the comparison is
              rebuilt with it (twice-monthly amounts are converted exactly). */}
          {!fields.some((f) => f.fieldName === 'frequency') && (
            <div className="flex flex-wrap items-end gap-2 rounded bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="payslip-frequency-chooser">
              <label className="block">
                <span className="mb-1 block">How often should this income be recorded?</span>
                <select className="rounded border border-gray-300 px-2 py-1 text-gray-900" value={frequencyChoice} onChange={(e) => setFrequencyChoice(e.target.value)}>
                  {INCOME_FREQUENCY_CHOICES.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </label>
              <button type="button" disabled={busy} onClick={() => handleGenerateProposal(undefined, frequencyChoice)} className="rounded border border-gray-300 bg-white px-3 py-1 text-gray-900 disabled:opacity-50">
                Use this frequency
              </button>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] border-collapse text-sm">
              <caption className="sr-only">Comparison of current income to the proposed payslip values</caption>
              <thead>
                <tr className="border-b border-gray-200 text-left">
                  <th scope="col" className="py-2 pr-2">
                    Field
                  </th>
                  <th scope="col" className="py-2 pr-2">
                    Current
                  </th>
                  <th scope="col" className="py-2 pr-2">
                    Proposed
                  </th>
                  <th scope="col" className="py-2">
                    Apply this field
                  </th>
                </tr>
              </thead>
              <tbody>
                {fields.map((f) => {
                  const changed = f.proposedValue !== f.existingValue;
                  return (
                    <tr key={f.fieldName} className="border-b border-gray-100">
                      <th scope="row" className="py-2 pr-2 text-left font-normal text-muted">
                        {FIELD_LABELS[f.fieldName] ?? f.fieldName}
                        {fieldReasonText(f.reasonCode) && <span className="block text-xs">{fieldReasonText(f.reasonCode)}</span>}
                      </th>
                      <td className="py-2 pr-2">{displayValue(f.existingValue, f.valueKind)}</td>
                      <td className={`py-2 pr-2 ${changed ? 'font-medium' : ''}`}>{displayValue(f.proposedValue, f.valueKind)}</td>
                      <td className="py-2">
                        <label className="inline-flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={selected.has(f.fieldName)}
                            onChange={() => toggleField(f.fieldName)}
                            aria-label={`Apply ${FIELD_LABELS[f.fieldName] ?? f.fieldName}`}
                          />
                          {f.requiresConfirmation && <span className="text-xs text-amber-800">please confirm</span>}
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
                <input type="radio" name="apply-decision" checked={decision === d} onChange={() => setDecision(d)} />
                {d === 'add_new' && 'Add as a new income source'}
                {d === 'update_existing' && 'Update my existing income entry'}
                {d === 'apply_selected_fields' && 'Apply only the fields I ticked above'}
                {d === 'keep_existing' && 'Keep my existing income as-is'}
              </label>
            ))}
          </fieldset>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => handleGenerateProposal()}
              disabled={busy}
              className="rounded border border-gray-300 px-3 py-1 text-sm"
            >
              Refresh comparison
            </button>
            <button
              type="button"
              onClick={handleApply}
              disabled={busy}
              className="rounded bg-trust px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Apply
            </button>
          </div>
        </div>
      )}

      {phase === 'applied' && (
        <div className="mt-4 space-y-3">
          <p className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">
            {message ?? 'Your income has been updated from this payslip.'}
          </p>
          <button type="button" onClick={onClose} className="rounded border border-gray-300 px-3 py-1 text-sm">
            Done
          </button>
        </div>
      )}

      {phase === 'kept_existing' && (
        <div className="mt-4 space-y-3">
          <p className="rounded bg-gray-50 px-3 py-2 text-sm text-gray-800">Your existing income was kept unchanged.</p>
          <button type="button" onClick={onClose} className="rounded border border-gray-300 px-3 py-1 text-sm">
            Done
          </button>
        </div>
      )}
    </div>
  );
}
