'use client';

/**
 * FDH-12 — Retirement Statement Intelligence: the Retirement-tab import
 * journey (spec sections 146-151).
 *
 * Upload -> Parse -> Match member & account -> Reconcile (payslip / bank /
 * rollover) -> Review evidence -> Approve evidence -> Compare current vs
 * proposed -> explicit Apply.
 *
 * EVERY STEP BEFORE THE FINAL APPLY CLICK IS INERT (spec sections 56, 129).
 * Nothing in this component mutates canonical Retirement until the user
 * presses "Apply" and `fdh12_apply_retirement_proposal()` accepts it. The
 * component has no direct write path to `retirement_accounts` at all — it
 * speaks only to the FDH-12 API surface over `fetch()`.
 *
 * WHY THIS FILE, NOT A NEW TOP-LEVEL DESTINATION. Product architecture:
 * FDH-12 lives entirely behind the Retirement tab, exactly as FDH-10 lives
 * behind Liabilities and FDH-9 behind Income. This component therefore lives
 * at `components/retirement/`, alongside `RetirementPlanningSection` and the
 * SMSF section whose boundary it respects.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatMoneyExact } from '@/lib/engines/money';
import {
  RetirementStatementDetails,
  normaliseRetirementActivity,
  normaliseRetirementPosition,
  normaliseRetirementStatement,
  type RetirementActivityRow,
  type RetirementPositionRow,
  type RetirementStatementRow,
} from '@/components/retirement/RetirementStatementHistory';
import {
  waitForDocumentToLeaveValidating,
  SCANNING_MESSAGE,
  SCAN_TIMEOUT_MESSAGE,
} from '@/components/financial-data-hub/scanStatusPolling';
import { readApiJson as readJson } from '@/lib/financial-data-hub/clientApiEnvelope';
import { normaliseProposedFields, type ProposedField } from '@/lib/import-bridge/proposedFieldShape';
import {
  useWaitingImports,
  WaitingImportsList,
  discardAiDraft,
  DUPLICATE_UPLOAD_MESSAGE,
  type WaitingImport,
} from '@/components/financial-data-hub/WaitingImports';

type Phase =
  | 'form'
  | 'uploading'
  | 'scanning'
  | 'unable_to_read'
  // AIE retirement-statement AI-fallback (2026-09-23). The native CSV parse
  // failed on a readable-but-unrecognised layout and an AI read a DRAFT off
  // it; nothing is saved until the user confirms from this phase.
  | 'ai_fallback_review'
  | 'scan_timeout'
  | 'duplicate'
  | 'routed_to_smsf'
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
  malware_detected: 'This file could not be accepted because it failed a security check. Please try a different file, or add this account manually above.',
  malware_scan_suspicious: 'This file could not be accepted because it failed a security check. Please try a different file, or add this account manually above.',
  malware_scan_failed: 'We could not finish checking this file for safety. Please try again, or add this account manually above.',
  malware_scan_timeout: 'We could not finish checking this file for safety in time. Please try again, or add this account manually above.',
  malware_scan_unknown: 'We could not finish checking this file for safety. Please try again, or add this account manually above.',
};

type Decision = 'add_new' | 'update_existing' | 'apply_selected_fields' | 'keep_existing';

// WP-13 (GAP-RET-04): the review reads EVERY persisted field -- the same row
// shapes, normalisers and details component as the Retirement tab's statement
// history (RetirementStatementHistory.tsx), so review and history can never
// disagree about what the statement said.
type Statement = RetirementStatementRow;
type Activity = RetirementActivityRow;
type Position = RetirementPositionRow;

/**
 * AIE retirement-statement AI-fallback (2026-09-23) — the draft the service
 * returns and the confirm route accepts back.
 *
 * MONEY IS A STRING, EVERYWHERE, DELIBERATELY. This mirrors
 * `RetirementStatementExtraction` exactly: that type's own header calls a
 * `number` on a money field "a defect", and the confirm route refuses a JSON
 * number. Parsing these into numbers for display and re-serialising them
 * would silently round values the user is being asked to verify.
 */
interface AiDraftActivity {
  activityType: string;
  amount: string;
  activityDate?: string;
  descriptionRaw?: string;
  employerNameRaw?: string;
  isSummaryTotal: boolean;
  isYearToDate: boolean;
}

interface AiDraftPosition {
  optionNameRaw: string;
  assetClassRaw?: string;
  units?: string;
  unitPrice?: string;
  marketValue?: string;
  valuationDate?: string;
}

interface AiFallbackDraft {
  statementType: string;
  jurisdiction: 'AU' | 'IN';
  accountType: string;
  currencyCode: string;
  fundName?: string;
  maskedAccountIdentifier?: string;
  statementDate?: string;
  statementStartDate?: string;
  statementEndDate?: string;
  openingBalance?: string;
  closingBalance?: string;
  employerContributions?: string;
  personalContributions?: string;
  salarySacrifice?: string;
  governmentContributions?: string;
  rolloversIn?: string;
  rolloversOut?: string;
  withdrawals?: string;
  pensionPayments?: string;
  investmentEarnings?: string;
  fees?: string;
  insurancePremiums?: string;
  tax?: string;
  activities: AiDraftActivity[];
  positions: AiDraftPosition[];
  warnings: string[];
}

interface Member { id: string; member_type: 'self' | 'spouse'; target_retirement_age: number | null }
interface AccountOption { id: string; account_name: string; account_type: string | null; currency_code: string; owner: string }

// 2026-09-25: the comparison rows are read through the shared
// `normaliseProposedFields` (lib/import-bridge/proposedFieldShape.ts). This
// panel used to cast them as snake_case, but POST .../proposal returns the
// adapter's draft fields in camelCase (fieldName, proposedValue, ...), so
// every label and value was undefined: a blank comparison table, nothing
// ticked, and "Add as a new retirement account" sent an empty selection the
// apply step refuses (NO_FIELDS_SELECTED) -- the payslip panel's production
// defect of the same day, in the retirement panel.
type ProposalField = ProposedField;

interface CurrentVsStatement {
  current: string | null;
  statement: string | null;
  difference: string | null;
  identical: boolean;
  account_name: string | null;
}

const FIELD_LABELS: Record<string, string> = {
  account_name: 'Account name',
  account_type: 'Account type',
  current_balance: 'Balance',
  currency_code: 'Currency',
  country_code: 'Country',
  owner: 'Belongs to',
  employer_contribution: 'Employer contribution',
  personal_contribution: 'Personal contribution',
  contribution_frequency: 'Contribution frequency',
};

/** WP-13: the proposal's review reasons, in words (GAP-RET-02 / GAP-RET-06). */
const REVIEW_REASON_TEXT: Record<string, string> = {
  statement_is_older_than_one_already_applied_balance_not_recommended:
    'This statement is older than one you have already applied to this account, so its balance is not ticked. Tick it only if you want to go back to this older balance.',
  statement_date_unknown_a_statement_is_already_applied_balance_not_recommended:
    'This statement shows no date and another statement is already applied to this account, so its balance is not ticked.',
  statement_period_unknown_contribution_rate_not_proposed:
    'The statement period is unknown, so its contribution totals cannot be turned into a yearly rate and are not offered.',
  existing_contribution_frequency_unknown_contribution_rates_cannot_be_combined:
    'Your account has a contribution with no frequency set. Set its frequency on the Retirement grid before applying contribution rates from a statement.',
  contribution_frequency_is_not_a_regular_rate_contributions_not_proposed:
    'The contribution frequency on this statement is not a regular rate, so contribution amounts are not offered.',
  no_closing_balance_on_statement: 'The statement shows no closing balance, so your balance is not changed.',
  statement_does_not_balance_review_the_figures: 'The figures on this statement do not add up. Check them before applying.',
  statement_lacks_enough_detail_to_check_the_balance: 'This statement does not show enough detail to check the figures.',
  more_than_one_account_could_match_this_statement: 'More than one of your accounts could match this statement.',
  ambiguous_account_match_review_required: 'More than one of your accounts could match this statement.',
  confirm_which_household_member_this_account_belongs_to: 'Confirm whose account this is before applying.',
};
const reviewReasonText = (code: string) => REVIEW_REASON_TEXT[code] ?? code.replace(/_/g, ' ');

const CONTRIBUTION_FIELDS = new Set(['employer_contribution', 'personal_contribution']);

function money(value: string | null | undefined, currency: string): string {
  // NEVER renders "$0" for an absent value (spec section 94). "Not shown on
  // statement" is a different fact from zero, and conflating them is the
  // specific failure the spec names.
  if (value === null || value === undefined || value === '') return 'Not shown on statement';
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  // App Review 2026-09-15 G1 sanctioned exception (a): literal statement
  // transcription shown for verification. See lib/engines/money.ts.
  return formatMoneyExact(n, currency);
}

function displayValue(value: string | null, kind: string, currency: string): string {
  if (value === null) return 'Not set';
  if (kind === 'money') return money(value, currency);
  return value;
}

export function RetirementStatementImportPanel({ onApplied }: { onApplied?: () => void }) {
  const [phase, setPhase] = useState<Phase>('form');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [jurisdiction, setJurisdiction] = useState<'AU' | 'IN'>('AU');
  const [fundName, setFundName] = useState('');
  const [maskedIdentifier, setMaskedIdentifier] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [file, setFile] = useState<File | null>(null);

  const [documentId, setDocumentId] = useState<string | null>(null);
  // AIE retirement-statement AI-fallback (2026-09-23). Held only for the
  // lifetime of the `ai_fallback_review` phase; cleared by `reset()` and on
  // confirm. Money stays a STRING end to end — the canonical extraction type
  // stores it that way and a round-trip through a JS number would reintroduce
  // the float loss that representation exists to prevent.
  const [aiDraft, setAiDraft] = useState<AiFallbackDraft | null>(null);
  const [statement, setStatement] = useState<Statement | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [currentVsStatement, setCurrentVsStatement] = useState<CurrentVsStatement | null>(null);

  const [chosenMemberId, setChosenMemberId] = useState<string>('');
  const [chosenAccountId, setChosenAccountId] = useState<string>('');

  const [proposalId, setProposalId] = useState<string | null>(null);
  const [reviewReasons, setReviewReasons] = useState<string[]>([]);
  const [busyActivityId, setBusyActivityId] = useState<string | null>(null);
  const [fields, setFields] = useState<ProposalField[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [decision, setDecision] = useState<Decision>('update_existing');
  // App Review 2026-09-14, item 2: same gap as BankStatementImportPanel.tsx
  // (see that file's identical comment) — this panel used to always render
  // as a fully working upload form and only discover the FDH-3 production
  // hard gate (lib/financial-data-hub/constants/featureFlags.ts) when the
  // upload itself failed. `null` = not checked yet; `true`/`false` once known.
  const [uploadEnabled, setUploadEnabled] = useState<boolean | null>(null);
  // Real-malware-gate async fix (2026-09-21): cancels an in-flight status
  // poll if the panel unmounts mid-scan.
  const scanPollCancelRef = useRef({ cancelled: false });
  useEffect(() => () => {
    scanPollCancelRef.current.cancelled = true;
  }, []);
  // 2026-09-25: statements this user left part-way through. Before, a reload
  // stranded an AI reading, an unapproved statement or an unapplied comparison.
  const { items: waiting, reload: reloadWaiting } = useWaitingImports('retirement');

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

  const currency = statement?.currency_code ?? (jurisdiction === 'IN' ? 'INR' : 'AUD');

  /** Items that block approval (spec sections 27, 66, 80). */
  const unresolvedCount = useMemo(
    () => activities.filter((a) =>
      a.payslip_match_status === 'multiple_candidates'
      || a.payslip_match_status === 'variance_review_required'
      || a.bank_match_status === 'multiple_candidates').length,
    [activities],
  );

  const loadReview = useCallback(async (docId: string) => {
    const res = await fetch(`/api/financial-data-hub/retirement-statement/${docId}`);
    const body = await readJson(res);
    if (!res.ok) { setPhase('error'); setMessage(String(body.error ?? 'Could not load this statement.')); return; }
    const stmt = normaliseRetirementStatement(body.statement);
    if (!stmt) { setPhase('error'); setMessage('Could not load this statement.'); return; }
    setStatement(stmt);
    setActivities((Array.isArray(body.activities) ? body.activities : []).map(normaliseRetirementActivity).filter((a): a is Activity => a !== null));
    setPositions((Array.isArray(body.positions) ? body.positions : []).map(normaliseRetirementPosition).filter((p): p is Position => p !== null));
    setMembers((body.members as Member[]) ?? []);
    setAccounts((body.accounts as AccountOption[]) ?? []);
    setCurrentVsStatement((body.current_vs_statement as CurrentVsStatement | null) ?? null);
    setPhase('review');
  }, []);

  /** Builds the same metadata query FDH-12's upload route reads, reusable
   * for the real-malware-gate async fix's `.../process` resumption call
   * (JSON body instead of query params, same field names). */
  const buildStatementMetadataQuery = useCallback(() => {
    const qs = new URLSearchParams({ jurisdiction, currency_code: jurisdiction === 'IN' ? 'INR' : 'AUD' });
    if (fundName.trim()) qs.set('fund_name', fundName.trim());
    if (maskedIdentifier.trim()) qs.set('masked_account_identifier', maskedIdentifier.trim());
    if (periodStart) qs.set('statement_period_start', periodStart);
    if (periodEnd) qs.set('statement_period_end', periodEnd);
    return qs;
  }, [jurisdiction, fundName, maskedIdentifier, periodStart, periodEnd]);

  /**
   * Handles the JSON body from EITHER the initial upload call or the
   * real-malware-gate async fix's `.../process` resumption call.
   *
   * NOTE ON RESPONSE SHAPE: both routes return via this codebase's shared
   * `ok()` helper (`lib/api.ts`), which wraps the payload as `{ data }`.
   * `readJson` (= `readApiJson`, lib/financial-data-hub/clientApiEnvelope.ts)
   * already unwraps that envelope on success, so `body` here IS the payload —
   * read fields directly off it.
   */
  const handleStatementOutcome = useCallback(async (body: Record<string, unknown>) => {
    const data = body;
    const docId = String(data.document_id);
    setDocumentId(docId);

    if (data.pipeline_status === 'routed_to_smsf') {
      setPhase('routed_to_smsf');
      setMessage(String(data.failure_message ?? ''));
      return;
    }
    // Checked BEFORE `extraction_failed`: for an AI-eligible failure kind the
    // service returns a DRAFT instead of failing, and the document is
    // deliberately left in `queued` rather than marked failed. Both the
    // single-call upload response and the post-scan `/process` response funnel
    // through this one function, so this single branch covers both paths.
    if (data.pipeline_status === 'ai_fallback_available' && data.ai_fallback_draft) {
      // For a re-upload, `document_id` is the ORIGINAL upload whose reading
      // still awaits a check (2026-09-25) -- the confirm goes there.
      if (data.duplicate_of_document_id) setMessage(DUPLICATE_UPLOAD_MESSAGE);
      setAiDraft(data.ai_fallback_draft as AiFallbackDraft);
      setPhase('ai_fallback_review');
      return;
    }
    if (data.pipeline_status === 'extraction_failed') {
      setPhase('unable_to_read');
      setMessage(String(data.failure_message ?? 'We could not read this statement.'));
      return;
    }
    if (data.pipeline_status === 'duplicate_statement') {
      // 2026-09-25: `document_id` is now the ORIGINAL upload. It used to be
      // the copy, which has no statement of its own, so this review 404ed and
      // the panel dead-ended on a blank screen.
      setPhase('duplicate');
      setMessage(DUPLICATE_UPLOAD_MESSAGE);
      await loadReview(docId);
      setPhase((p) => (p === 'error' ? p : 'duplicate'));
      return;
    }
    await loadReview(docId);
  }, [loadReview]);

  const handleUpload = useCallback(async () => {
    if (!file) { setMessage('Choose a statement file first.'); return; }
    setBusy(true); setMessage(null); setPhase('uploading');
    try {
      const qs = buildStatementMetadataQuery();
      const res = await fetch(`/api/financial-data-hub/retirement-statement/upload?${qs.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv' },
        body: await file.arrayBuffer(),
      });
      const body = await readJson(res);
      if (!res.ok) { setPhase('error'); setMessage(String(body.error ?? 'Could not read this statement.')); return; }

      // `readJson` already unwrapped the `{ data }` envelope (clientApiEnvelope.ts).
      const data = body;

      // Real-malware-gate async fix (2026-09-21): the upload route now
      // returns `pipeline_status: 'pending_scan'` (statement_id: null, NOT
      // a failure) instead of extracting immediately when the real
      // S3+GuardDuty scan has not yet resolved — see
      // retirementStatementProcessingService.ts's
      // `resolveRetirementStatementDocument()`.
      if (data.pipeline_status === 'pending_scan') {
        const docId = String(data.document_id);
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
              ?? 'This file could not be accepted. Please try a different file, or add this account manually above.',
          );
          setPhase('unable_to_read');
          return;
        }
        // The scan cleared -- finish the extraction the upload route
        // deferred, re-submitting the SAME metadata originally supplied.
        const processQs = buildStatementMetadataQuery();
        const processBody = Object.fromEntries(processQs.entries());
        const processRes = await fetch(`/api/financial-data-hub/retirement-statement/${docId}/process`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(processBody),
        });
        const processJson = await readJson(processRes);
        if (!processRes.ok) {
          setPhase('unable_to_read');
          setMessage(String(processJson.error ?? 'We could not process this statement.'));
          return;
        }
        await handleStatementOutcome(processJson);
        return;
      }

      await handleStatementOutcome(body);
    } finally { setBusy(false); }
  }, [file, buildStatementMetadataQuery, handleStatementOutcome]);

  const handleMatch = useCallback(async (action: 'auto' | 'resolve' | 'confirm_new') => {
    if (!documentId) return;
    setBusy(true); setMessage(null);
    try {
      const payload: Record<string, unknown> = { action };
      if (action === 'resolve') payload.account_id = chosenAccountId;
      if (chosenMemberId) payload.member_id = chosenMemberId;

      const res = await fetch(`/api/financial-data-hub/retirement-statement/${documentId}/account-match`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const body = await readJson(res);
      if (!res.ok) { setMessage(String(body.error ?? 'Could not match this statement to an account.')); return; }

      await fetch(`/api/financial-data-hub/retirement-statement/${documentId}/evidence-matches`, { method: 'POST' });
      await loadReview(documentId);
    } finally { setBusy(false); }
  }, [documentId, chosenAccountId, chosenMemberId, loadReview]);

  const handleApprove = useCallback(async () => {
    if (!documentId) return;
    setBusy(true); setMessage(null);
    try {
      const res = await fetch(`/api/financial-data-hub/retirement-statement/${documentId}/approve`, { method: 'POST' });
      const body = await readJson(res);
      if (!res.ok) { setMessage(String(body.error ?? 'Could not approve this statement.')); return; }
      await loadReview(documentId);
    } finally { setBusy(false); }
  }, [documentId, loadReview]);

  const handleGenerateProposal = useCallback(async (forDocumentId?: string) => {
    const target = forDocumentId ?? documentId;
    if (!target) return;
    setBusy(true); setMessage(null);
    try {
      const res = await fetch(`/api/financial-data-hub/retirement-statement/${target}/proposal`, { method: 'POST' });
      const body = await readJson(res);
      // 2026-09-25: this statement's comparison was already decided (a
      // re-upload leads back to it). Say so; never offer a second apply.
      if (!res.ok && body.error === 'already_decided') {
        setPhase(body.outcome === 'kept_existing' ? 'kept_existing' : 'applied');
        setMessage(String(body.message ?? 'This statement has already been added to your retirement accounts.'));
        reloadWaiting();
        return;
      }
      if (!res.ok) { setMessage(String(body.message ?? body.error ?? 'Could not prepare the comparison.')); return; }
      setProposalId(String(body.proposal_id));
      const nextFields = normaliseProposedFields(body.fields);
      setFields(nextFields);
      const summary = body.summary as { reviewReasons?: unknown } | undefined;
      setReviewReasons(Array.isArray(summary?.reviewReasons) ? summary!.reviewReasons.filter((r): r is string => typeof r === 'string') : []);
      // Only RECOMMENDED fields are ticked by default. Contribution rates
      // require explicit confirmation and so start unticked (spec section 109).
      setSelected(new Set(nextFields.filter((f) => f.isRecommended && !f.requiresConfirmation).map((f) => f.fieldName)));
      setDecision(body.recommended_apply_mode === 'add_new' ? 'add_new' : 'update_existing');
      setPhase('comparing');
    } finally { setBusy(false); }
  }, [documentId, reloadWaiting]);

  // WP-13 (GAP-RET-02 / D-12): a contribution amount is a rate only together
  // with its frequency, so the two are ticked and unticked together (the apply
  // RPC refuses one without the other).
  const toggleField = useCallback((name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const hasFrequency = fields.some((f) => f.fieldName === 'contribution_frequency');
      if (next.has(name)) {
        next.delete(name);
        if (name === 'contribution_frequency') for (const c of CONTRIBUTION_FIELDS) next.delete(c);
        if (CONTRIBUTION_FIELDS.has(name) && ![...CONTRIBUTION_FIELDS].some((c) => next.has(c))) next.delete('contribution_frequency');
      } else {
        next.add(name);
        if (CONTRIBUTION_FIELDS.has(name) && hasFrequency) next.add('contribution_frequency');
        if (name === 'contribution_frequency') {
          for (const f of fields) if (CONTRIBUTION_FIELDS.has(f.fieldName)) next.add(f.fieldName);
        }
      }
      return next;
    });
  }, [fields]);

  /** WP-13 (GAP-RET-07): the user confirms a matched bank payment. */
  const handleConfirmBankLeg = useCallback(async (activity: Activity) => {
    if (!documentId) return;
    setBusyActivityId(activity.id); setMessage(null);
    try {
      const res = await fetch(`/api/financial-data-hub/retirement-statement/${documentId}/bank-leg`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activity_id: activity.id }),
      });
      const body = await readJson(res);
      if (!res.ok) { setMessage(String(body.error ?? 'This bank payment could not be confirmed.')); return; }
      setMessage(body.outcome === 'skipped_user_override'
        ? 'Confirmed. You had already categorised this bank payment yourself, so it was left as you set it.'
        : body.counted_as === 'income'
          ? 'Confirmed. This bank payment now counts once, as retirement income.'
          : 'Confirmed. This bank payment now counts as a transfer into (or out of) super, not as spending or income.');
      await loadReview(documentId);
    } finally { setBusyActivityId(null); }
  }, [documentId, loadReview]);

  const handleApply = useCallback(async () => {
    if (!documentId || !proposalId) return;
    // WP-13 (GAP-RET-01): nothing ticked means nothing to apply -- never
    // "apply everything".
    if (decision !== 'keep_existing' && selected.size === 0) {
      setMessage('Tick at least one detail to apply, or choose to keep your account as it is.');
      return;
    }
    setBusy(true); setMessage(null);
    try {
      const res = await fetch(`/api/financial-data-hub/retirement-statement/${documentId}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proposal_id: proposalId,
          decision,
          // WP-13 (GAP-RET-01 / X-01): EVERY decision that writes sends the
          // ticked list. `update_existing` used to send none, which the RPC
          // read as "every proposed field" -- silently applying the
          // contribution amounts the user had left unticked.
          selected_fields: decision === 'keep_existing' ? undefined : [...selected],
        }),
      });
      const body = await readJson(res);
      if (!res.ok) {
        if (res.status === 409) {
          setPhase('stale');
          setMessage(String(body.error ?? 'Your retirement details changed. Review the updated comparison.'));
          await handleGenerateProposal();
          return;
        }
        setMessage(String(body.error ?? 'Could not apply this statement.'));
        return;
      }
      if (body.outcome === 'kept_existing') {
        setPhase('kept_existing');
        setMessage('Your retirement account was left exactly as it was.');
      } else {
        setPhase('applied');
        setMessage('Your retirement account has been updated from this statement.');
      }
      reloadWaiting(); // this statement is no longer waiting
      onApplied?.();
    } finally { setBusy(false); }
  }, [documentId, proposalId, decision, selected, onApplied, handleGenerateProposal, reloadWaiting]);

  /** Removes one AI-read line the user judges wrong. Deletion is the only
   * per-row edit offered, deliberately: the statement's own summary figures
   * (which the user CAN correct above) are what the reconciliation check
   * uses, and an inline editable grid for every activity would duplicate the
   * review screen the user reaches immediately after saving. Removing a line
   * the model invented or double-counted — most often a summary total it
   * failed to mark as one — is the correction that has to happen before the
   * write. */
  const removeAiActivity = useCallback((index: number) => {
    setAiDraft((d) => (d ? { ...d, activities: d.activities.filter((_, i) => i !== index) } : d));
  }, []);

  const removeAiPosition = useCallback((index: number) => {
    setAiDraft((d) => (d ? { ...d, positions: d.positions.filter((_, i) => i !== index) } : d));
  }, []);

  const updateAiMoney = useCallback((key: 'openingBalance' | 'closingBalance', raw: string) => {
    // Kept as a STRING. An empty box means "the statement did not show this",
    // which is a different fact from zero — see `money()` above.
    setAiDraft((d) => (d ? { ...d, [key]: raw === '' ? undefined : raw } : d));
  }, []);

  const handleConfirmAiDraft = useCallback(async () => {
    if (!aiDraft || !documentId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/financial-data-hub/retirement-statement/${documentId}/ai-fallback/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(aiDraft),
      });
      const body = await readJson(res);
      if (!res.ok) {
        setMessage(String(body.error ?? 'We could not save this statement.'));
        setPhase('error');
        return;
      }
      setAiDraft(null);
      reloadWaiting();
      await loadReview(documentId);
    } finally {
      setBusy(false);
    }
  }, [aiDraft, documentId, loadReview, reloadWaiting]);

  /** Continue a statement left part-way through (2026-09-25). */
  const resumeWaiting = useCallback(async (item: WaitingImport) => {
    if (item.country_code === 'AU' || item.country_code === 'IN') setJurisdiction(item.country_code);
    setDocumentId(item.document_id);
    setMessage(null);
    setProposalId(null);
    if (item.stage === 'ai_draft' && item.ai_fallback_draft) {
      setAiDraft(item.ai_fallback_draft as AiFallbackDraft);
      setPhase('ai_fallback_review');
      return;
    }
    setBusy(true);
    try {
      await loadReview(item.document_id);
    } finally { setBusy(false); }
    if (item.stage === 'compare') await handleGenerateProposal(item.document_id);
  }, [loadReview, handleGenerateProposal]);

  const reset = useCallback(() => {
    setPhase('form'); setBusy(false); setMessage(null); setFile(null);
    setDocumentId(null); setStatement(null); setActivities([]); setPositions([]);
    setCurrentVsStatement(null); setProposalId(null); setFields([]); setSelected(new Set());
    setReviewReasons([]);
    setChosenAccountId(''); setChosenMemberId('');
    setAiDraft(null);
  }, []);

  return (
    <section
      id="import-retirement-statement"
      className="rounded-lg border border-gray-200 bg-white p-4"
      role="region"
      aria-label="Import a retirement statement"
      aria-live="polite"
    >
      <h2 className="text-lg font-semibold">Import retirement statement</h2>
      <p className="mt-1 text-sm text-muted">
        Read your balance and contributions from a super or retirement statement instead of typing
        them in. Nothing changes in your retirement accounts until you review the figures and choose
        to apply them.
      </p>

      {message && phase !== 'comparing' && phase !== 'scanning' && phase !== 'scan_timeout' && (
        <p className="mt-3 rounded bg-gray-50 px-3 py-2 text-sm">{message}</p>
      )}

      {uploadEnabled === false && phase === 'form' && (
        <div className="mt-4 space-y-2">
          <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Statement import isn&apos;t turned on in this environment yet. You can still add this account yourself
            using the Retirement form above.
          </p>
        </div>
      )}

      {phase === 'form' && <WaitingImportsList items={waiting} busy={busy} onContinue={(w) => void resumeWaiting(w)} />}

      {uploadEnabled !== false && phase === 'form' && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col text-sm">
              <span className="mb-1 font-medium">Where is this account held?</span>
              <select
                value={jurisdiction}
                onChange={(e) => setJurisdiction(e.target.value as 'AU' | 'IN')}
                className="rounded border border-gray-300 px-2 py-1"
              >
                <option value="AU">Australia (superannuation)</option>
                <option value="IN">India (EPF / NPS)</option>
              </select>
            </label>
            <label className="flex flex-col text-sm">
              <span className="mb-1 font-medium">Fund name</span>
              <input
                type="text" value={fundName} onChange={(e) => setFundName(e.target.value)}
                className="rounded border border-gray-300 px-2 py-1" placeholder="As shown on the statement"
              />
            </label>
            <label className="flex flex-col text-sm">
              <span className="mb-1 font-medium">Last digits of your member number</span>
              <input
                type="text" value={maskedIdentifier} onChange={(e) => setMaskedIdentifier(e.target.value)}
                className="rounded border border-gray-300 px-2 py-1" placeholder="e.g. 4821" maxLength={12}
              />
              {/* spec sections 87-89: only a masked fragment is ever stored, and
                  a tax file number is never wanted, asked for, or accepted. */}
              <span className="mt-1 text-xs text-muted">
                Only the last few digits. Never enter your tax file number.
              </span>
            </label>
          </div>
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col text-sm">
              <span className="mb-1 font-medium">Statement period start</span>
              <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} className="rounded border border-gray-300 px-2 py-1" />
            </label>
            <label className="flex flex-col text-sm">
              <span className="mb-1 font-medium">Statement period end</span>
              <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} className="rounded border border-gray-300 px-2 py-1" />
            </label>
          </div>
          <label className="flex flex-col text-sm">
            <span className="mb-1 font-medium">Statement file (CSV)</span>
            <input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm" />
            {/* COVERAGE HONESTY (spec section 83). This states the ACTUAL
                certified scope. It does not say "all Australian super funds
                supported", because that is not true. */}
            <span className="mt-1 text-xs text-muted">
              CSV exports only in this release. PDF statements and scanned documents cannot be read
              automatically yet — you can still add or update the account manually.
            </span>
          </label>
          <button
            type="button" onClick={handleUpload} disabled={busy || !file || uploadEnabled !== true}
            className="rounded bg-trust px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Upload and read statement
          </button>
        </div>
      )}

      {phase === 'uploading' && <p className="mt-4 text-sm">Reading your statement…</p>}

      {phase === 'scanning' && <p className="mt-4 text-sm" role="status">{message ?? SCANNING_MESSAGE}</p>}

      {phase === 'scan_timeout' && (
        <div className="mt-4 space-y-3">
          <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">{message ?? SCAN_TIMEOUT_MESSAGE}</p>
          <button type="button" onClick={reset} className="rounded border border-gray-300 px-3 py-1 text-sm">
            Try another file
          </button>
        </div>
      )}

      {phase === 'routed_to_smsf' && (
        <div className="mt-4 space-y-3">
          {/* spec sections 10-11, 137: routed, never imported as ordinary
              super, and never silently. */}
          <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">{message}</p>
          <p className="text-sm text-muted">
            Self-managed super funds are managed in the SMSF section above, which keeps their balance
            and holdings in one place. This statement has not been imported into your ordinary super
            accounts.
          </p>
          <button type="button" onClick={reset} className="rounded border border-gray-300 px-3 py-1 text-sm">
            Start again
          </button>
        </div>
      )}

      {phase === 'ai_fallback_review' && aiDraft && (
        <div className="mt-4 space-y-4">
          <p className="rounded bg-blue-50 px-3 py-2 text-sm text-blue-900">
            We could not recognise this statement&apos;s layout automatically, so we used AI to read it instead. Please
            check these details before saving — <strong>nothing has been saved yet</strong>.
          </p>

          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div><dt className="text-muted">Fund</dt><dd>{aiDraft.fundName ?? 'Not identified'}</dd></div>
            <div><dt className="text-muted">Member number</dt><dd>{aiDraft.maskedAccountIdentifier ?? 'Not shown'}</dd></div>
            <div>
              <dt className="text-muted">Period</dt>
              <dd>{aiDraft.statementStartDate ?? '—'} to {aiDraft.statementEndDate ?? '—'}</dd>
            </div>
            <div><dt className="text-muted">Currency</dt><dd>{aiDraft.currencyCode}</dd></div>
          </dl>

          <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-muted" htmlFor="ai-opening-balance">Opening balance</label>
              <input
                id="ai-opening-balance"
                type="text"
                inputMode="decimal"
                className="w-full rounded border border-gray-300 px-3 py-2"
                placeholder="Not shown on statement"
                value={aiDraft.openingBalance ?? ''}
                onChange={(e) => updateAiMoney('openingBalance', e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-muted" htmlFor="ai-closing-balance">Closing balance</label>
              <input
                id="ai-closing-balance"
                type="text"
                inputMode="decimal"
                className="w-full rounded border border-gray-300 px-3 py-2"
                placeholder="Not shown on statement"
                value={aiDraft.closingBalance ?? ''}
                onChange={(e) => updateAiMoney('closingBalance', e.target.value)}
              />
            </div>
          </div>

          {aiDraft.activities.length > 0 && (
            <div>
              <p className="mb-2 text-sm text-muted">
                {aiDraft.activities.length} activit{aiDraft.activities.length === 1 ? 'y' : 'ies'} read. Remove any line
                that is wrong, or that is a total of other lines rather than a movement of its own.
              </p>
              <div className="max-h-72 overflow-y-auto rounded border border-gray-200">
                <table className="w-full text-sm">
                  <caption className="sr-only">Activities read from this statement by AI, awaiting your confirmation</caption>
                  <thead className="sticky top-0 bg-gray-50 text-left">
                    <tr>
                      <th scope="col" className="px-3 py-2">Date</th>
                      <th scope="col" className="px-3 py-2">Type</th>
                      <th scope="col" className="px-3 py-2 text-right">Amount</th>
                      <th scope="col" className="px-3 py-2">Total?</th>
                      <th scope="col" className="px-3 py-2"><span className="sr-only">Remove</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {aiDraft.activities.map((a, i) => (
                      <tr key={`${a.activityType}-${i}`} className="border-t border-gray-100">
                        <td className="px-3 py-2 whitespace-nowrap">{a.activityDate ?? '—'}</td>
                        <td className="px-3 py-2">{a.activityType}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{money(a.amount, aiDraft.currencyCode)}</td>
                        <td className="px-3 py-2">
                          {a.isSummaryTotal ? 'Summary total' : a.isYearToDate ? 'Year to date' : '—'}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button type="button" onClick={() => removeAiActivity(i)} className="rounded border border-gray-300 px-2 py-1 text-xs">
                            Remove<span className="sr-only"> the {a.activityType} activity</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {aiDraft.positions.length > 0 && (
            <div>
              <p className="mb-2 text-sm text-muted">{aiDraft.positions.length} investment option(s) read.</p>
              <ul className="space-y-1 text-sm">
                {aiDraft.positions.map((pos, i) => (
                  <li key={`${pos.optionNameRaw}-${i}`} className="flex items-center justify-between rounded border border-gray-200 px-3 py-2">
                    <span>
                      {pos.optionNameRaw} — {money(pos.marketValue, aiDraft.currencyCode)}
                    </span>
                    <button type="button" onClick={() => removeAiPosition(i)} className="rounded border border-gray-300 px-2 py-1 text-xs">
                      Remove<span className="sr-only"> the {pos.optionNameRaw} holding</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="text-xs text-muted">
            AI-read values are shown for your confirmation only. When you save, we check these figures against the
            statement&apos;s own opening and closing balances — exactly as we do for a statement we read automatically —
            and flag anything that does not add up.
          </p>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => {
                // 2026-09-25: recorded on the server too, so the reading is not
                // offered again as something to continue.
                if (documentId) void discardAiDraft(documentId).then(reloadWaiting);
                setAiDraft(null);
                setMessage('We could not read this statement. Please check the file, or add these details manually.');
                setPhase('unable_to_read');
              }}
              className="rounded border border-gray-300 px-3 py-1 text-sm"
            >
              This doesn&apos;t look right
            </button>
            <button
              type="button"
              onClick={handleConfirmAiDraft}
              disabled={busy || (aiDraft.activities.length === 0 && !aiDraft.closingBalance && !aiDraft.openingBalance)}
              className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              Save these details
            </button>
          </div>
        </div>
      )}

      {(phase === 'unable_to_read' || phase === 'error') && (
        <div className="mt-4 space-y-3">
          <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">{message}</p>
          <button type="button" onClick={reset} className="rounded border border-gray-300 px-3 py-1 text-sm">
            Try another file
          </button>
        </div>
      )}

      {(phase === 'review' || phase === 'duplicate') && statement && (
        <div className="mt-4 space-y-4">
          <h3 className="font-semibold">What we read from this statement</h3>

          {/* WP-13 (GAP-RET-04): EVERY persisted header total, the parser's
              warnings, every activity column (payslip / bank / rollover
              match) and every holdings column -- the same component the
              Retirement tab's statement history renders after Apply. The
              balance check is stated in words (spec section 151). A matched
              bank payment can be confirmed once the statement is approved. */}
          <RetirementStatementDetails
            statement={statement}
            activities={activities}
            positions={positions}
            busyActivityId={busyActivityId}
            onConfirmBankLeg={(a) => void handleConfirmBankLeg(a)}
          />

          {/* --- Member and account matching (spec sections 15-19, 112) ----- */}
          <div className="space-y-2">
            <h4 className="text-sm font-semibold">Which account is this?</h4>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col text-sm">
                <span className="mb-1">Belongs to</span>
                <select value={chosenMemberId} onChange={(e) => setChosenMemberId(e.target.value)} className="rounded border border-gray-300 px-2 py-1">
                  <option value="">Choose…</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>{m.member_type === 'self' ? 'Me' : 'My partner'}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col text-sm">
                <span className="mb-1">Existing account</span>
                <select value={chosenAccountId} onChange={(e) => setChosenAccountId(e.target.value)} className="rounded border border-gray-300 px-2 py-1">
                  <option value="">Choose…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.account_name}</option>
                  ))}
                </select>
              </label>
              <button type="button" onClick={() => handleMatch('resolve')} disabled={busy || !chosenAccountId} className="rounded border border-gray-300 px-3 py-1 text-sm disabled:opacity-50">
                Use this account
              </button>
              <button type="button" onClick={() => handleMatch('confirm_new')} disabled={busy} className="rounded border border-gray-300 px-3 py-1 text-sm disabled:opacity-50">
                Add as a new account
              </button>
            </div>
            <p className="text-xs text-muted">
              Matched: {statement.account_match_status.replace(/_/g, ' ')}
            </p>
          </div>

          {/* --- CURRENT vs STATEMENT (spec section 55) --------------------- */}
          {currentVsStatement && (
            <div className="rounded bg-gray-50 px-3 py-2 text-sm">
              <strong>{currentVsStatement.account_name}</strong>
              <div className="mt-1 grid grid-cols-3 gap-2">
                <div><span className="text-muted">Current</span><br />{money(currentVsStatement.current, currency)}</div>
                <div><span className="text-muted">Statement</span><br />{money(currentVsStatement.statement, currency)}</div>
                <div><span className="text-muted">Difference</span><br />{money(currentVsStatement.difference, currency)}</div>
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-3">
            {statement.approval_status !== 'approved' && (
              <button
                type="button" onClick={handleApprove} disabled={busy || unresolvedCount > 0}
                className="rounded border border-gray-300 px-3 py-1 text-sm disabled:opacity-50"
              >
                Approve these figures
              </button>
            )}
            {unresolvedCount > 0 && (
              <p className="text-sm text-amber-900">
                {unresolvedCount} item(s) need your review before you can approve this statement.
              </p>
            )}
            {statement.approval_status === 'approved' && !proposalId && (
              <button type="button" onClick={() => handleGenerateProposal()} disabled={busy} className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50">
                Continue to comparison
              </button>
            )}
          </div>
        </div>
      )}

      {(phase === 'comparing' || phase === 'stale') && (
        <div className="mt-4 space-y-4">
          <h3 className="font-semibold">Your retirement account vs this statement</h3>
          {phase === 'stale' && message && (
            <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">{message}</p>
          )}
          {reviewReasons.length > 0 && (
            <ul className="list-disc space-y-1 rounded bg-amber-50 py-2 pl-8 pr-3 text-sm text-amber-900">
              {reviewReasons.map((r) => <li key={r}>{reviewReasonText(r)}</li>)}
            </ul>
          )}
          {fields.some((f) => CONTRIBUTION_FIELDS.has(f.fieldName)) && (
            <p className="text-xs text-muted">
              Contribution amounts are shown as a yearly rate worked out from the statement period. They change your
              retirement accounts only if you tick them, and always together with how often they are paid.
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] border-collapse text-sm">
              <caption className="sr-only">Comparison of your current retirement account with the statement</caption>
              <thead>
                <tr className="border-b border-gray-200 text-left">
                  <th scope="col" className="py-2 pr-2">Field</th>
                  <th scope="col" className="py-2 pr-2">Current</th>
                  <th scope="col" className="py-2 pr-2">Statement</th>
                  <th scope="col" className="py-2">Apply this field</th>
                </tr>
              </thead>
              <tbody>
                {fields.map((f) => {
                  const changed = f.proposedValue !== f.existingValue;
                  const label = FIELD_LABELS[f.fieldName] ?? f.fieldName;
                  return (
                    <tr key={f.fieldName} className="border-b border-gray-100">
                      <th scope="row" className="py-2 pr-2 text-left font-normal text-muted">{label}</th>
                      <td className="py-2 pr-2">{displayValue(f.existingValue, f.valueKind, currency)}</td>
                      <td className={`py-2 pr-2 ${changed ? 'font-medium' : ''}`}>{displayValue(f.proposedValue, f.valueKind, currency)}</td>
                      <td className="py-2">
                        <label className="inline-flex items-center gap-2">
                          <input
                            type="checkbox" checked={selected.has(f.fieldName)}
                            onChange={() => toggleField(f.fieldName)}
                            aria-label={`Apply ${label}`}
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

          {/* spec sections 61, 113: stated to the user, not just enforced. */}
          <p className="text-xs text-muted">
            Your target retirement age is never changed by importing a statement.
          </p>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">What would you like to do?</legend>
            {(['add_new', 'update_existing', 'apply_selected_fields', 'keep_existing'] as Decision[]).map((d) => (
              <label key={d} className="flex items-center gap-2 text-sm">
                <input type="radio" name="retirement-apply-decision" checked={decision === d} onChange={() => setDecision(d)} />
                {d === 'add_new' && 'Add as a new retirement account'}
                {d === 'update_existing' && 'Update my existing retirement account'}
                {d === 'apply_selected_fields' && 'Apply only the fields I ticked above'}
                {d === 'keep_existing' && 'Keep my retirement account as it is'}
              </label>
            ))}
          </fieldset>

          <div className="flex gap-3">
            <button type="button" onClick={() => handleGenerateProposal()} disabled={busy} className="rounded border border-gray-300 px-3 py-1 text-sm">
              Refresh comparison
            </button>
            <button type="button" onClick={handleApply} disabled={busy} className="rounded bg-trust px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              Apply
            </button>
          </div>
          {message && phase === 'comparing' && <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">{message}</p>}
        </div>
      )}

      {(phase === 'applied' || phase === 'kept_existing') && (
        <div className="mt-4 space-y-3">
          <p className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">{message}</p>
          <button type="button" onClick={reset} className="rounded border border-gray-300 px-3 py-1 text-sm">
            Import another statement
          </button>
        </div>
      )}
    </section>
  );
}
