'use client';

/**
 * FDH-11 — Australia Investment Statement Intelligence: the Investments-tab
 * statement import journey (spec sections 2, 15-25, 43-46, 63-65, 76, 108).
 *
 * Upload -> Review evidence -> Match account -> Match securities -> Bank
 * match -> Approve evidence -> Current vs statement -> explicit Apply.
 * Every step before the final Apply click is INERT — nothing here mutates
 * canonical Investment Intelligence until the user presses "Apply" (spec
 * section 63).
 *
 * WHY THIS FILE, NOT A NEW TOP-LEVEL DESTINATION. Product architecture (spec
 * section 76): FDH-11 lives entirely behind the Investments tab, exactly
 * like FDH-9/FDH-10 live behind Income/Liabilities
 * (`components/income/PayslipImportPanel.tsx`,
 * `components/liabilities/LiabilityImportPanel.tsx`, whose structure this
 * file deliberately mirrors). This component talks to the FDH-backed API
 * surface purely over `fetch()`.
 */

import { useEffect, useRef, useState } from 'react';
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
import { needsSecurityMatch } from '@/lib/investment-import-bridge/auLineRules';

// 'ai_fallback_review' (2026-09-23, AIE unified document fallback): the native
// CSV extractor could not read this layout and an AI read a DRAFT off the same
// file. Nothing is saved until the user confirms from this phase — it sits
// BEFORE the ordinary 'review' phase, which shows evidence that already exists
// in the database.
type Phase = 'form' | 'uploading' | 'scanning' | 'unable_to_read' | 'scan_timeout' | 'duplicate' | 'ai_fallback_review' | 'review' | 'matching' | 'comparing' | 'applied' | 'publishing' | 'published' | 'error';

/** One AI-read holdings line, exactly as the confirm route accepts it. Every
 * numeric is an exact decimal STRING — FDH-11 stores units and money as
 * strings to keep float loss out of a share registry's 6-decimal unit
 * holdings, and parsing them to numbers here just to display them would
 * reintroduce it on the way back. */
interface AiDraftHolding {
  securityNameRaw: string;
  tickerRaw: string | null;
  isin: string | null;
  quantity: string;
  unitPrice: string | null;
  marketValue: string | null;
  valuationDate: string;
}

/** One AI-read activity line, exactly as the confirm route accepts it. */
interface AiDraftActivity {
  transactionType: string;
  tradeDate: string | null;
  settlementDate: string | null;
  securityNameRaw: string | null;
  tickerRaw: string | null;
  quantity: string | null;
  unitPrice: string | null;
  amount: string;
  brokerageRaw: string | null;
}

interface AiFallbackDraft {
  holdings: AiDraftHolding[];
  activities: AiDraftActivity[];
  institutionName: string | null;
  statementDate: string | null;
  statementPeriodStart: string | null;
  statementPeriodEnd: string | null;
  allRowsListed: boolean;
  warnings: string[];
}

// 2026-09-21 (real-malware-gate async fix) — same honest, non-technical
// discipline as every other FDH-3 panel's failure copy: never "malware" or
// "virus".
const SCAN_REJECTION_MESSAGES: Record<string, string> = {
  malware_detected: 'This file could not be accepted because it failed a security check. Please try a different file, or add this investment manually below.',
  malware_scan_suspicious: 'This file could not be accepted because it failed a security check. Please try a different file, or add this investment manually below.',
  malware_scan_failed: 'We could not finish checking this file for safety. Please try again, or add this investment manually below.',
  malware_scan_timeout: 'We could not finish checking this file for safety in time. Please try again, or add this investment manually below.',
  malware_scan_unknown: 'We could not finish checking this file for safety. Please try again, or add this investment manually below.',
};

/** Shown when the user rejects an AI-read draft. Deliberately the same
 * "we couldn't read it, add it yourself" dead end an unreadable statement
 * already produces — declining a draft must not read as an error the user
 * caused. */
const AI_FALLBACK_DECLINED_MESSAGE =
  "We haven't saved anything. You can try a different file, or add this investment manually instead.";

interface Statement {
  id: string;
  statement_type: string;
  institution_name: string | null;
  masked_account_identifier: string | null;
  base_currency: string;
  statement_date: string | null;
  statement_start_date: string | null;
  statement_end_date: string | null;
  opening_portfolio_value: number | null;
  closing_portfolio_value: number | null;
  cash_balance: number | null;
  reconciliation_status: 'reconciled' | 'variance' | 'insufficient_data';
  approval_status: 'pending' | 'approved';
  canonical_account_id: string | null;
  extraction_warnings?: { code: string; count: number; rowsDropped?: boolean; rows?: number[] }[] | null;
}
interface Position {
  id: string;
  security_name_raw: string;
  ticker_raw: string | null;
  isin: string | null;
  quantity: string;
  market_value: string | null;
  valuation_date: string | null;
  security_match_status: string;
  matched_instrument_id: string | null;
  apply_status: string;
  apply_rejected_reason?: string | null;
}
interface Activity {
  id: string;
  activity_type: string;
  trade_date: string | null;
  settlement_date: string | null;
  amount: string;
  security_name_raw: string | null;
  ticker_raw: string | null;
  isin: string | null;
  brokerage_raw: string | null;
  franking_credit_raw: string | null;
  withholding_tax_raw: string | null;
  security_match_status: string;
  bank_match_status: string;
  apply_status: string;
  apply_rejected_reason: string | null;
}

/** Household member, as GET /api/household-members returns it (snake_case). */
interface HouseholdMember {
  id: string;
  full_name: string;
  relationship: string;
  is_active?: boolean;
}

interface AccountCandidate {
  accountId: string;
  institutionName: string | null;
  maskedAccountIdentifier: string | null;
  ownerRecorded: boolean;
}

interface AccountMatchState {
  outcome: 'single_match' | 'ambiguous' | 'no_match' | 'add_new' | null;
  candidates: AccountCandidate[];
  ownerRecorded: boolean;
}

interface ApplyRow {
  id: string;
  ok: boolean;
  code: string | null;
  reason: string | null;
  activity_type?: string;
  trade_date?: string | null;
  amount?: number;
  security_name?: string;
}

interface ApplyResult {
  applied_count: number;
  skipped_count: number;
  activities: ApplyRow[];
  positions: ApplyRow[];
  bank_legs: { reclassified: number } | null;
  bank_leg_error: string | null;
}

interface PublishHolding {
  snapshot_id: string;
  name: string;
  as_of_date: string;
  value: number;
  currency_code: string;
  eligibility_status: string | null;
  blocking_reasons: string[];
  warning_reasons: string[];
  duplicate_candidates: { investment_id: string; existing_value: number; existing_currency: string; existing_institution: string | null }[];
  published: boolean;
  refreshes_existing: boolean;
  error: string | null;
}

interface CompareRow {
  securityNameRaw: string;
  currentQuantity: string | null;
  statementQuantity: string;
  matched: boolean;
}

const WARNING_LABELS: Record<string, string> = {
  unrecognised_transaction_type: 'had a transaction type we do not recognise',
  unparseable_date: 'had a date we could not read',
  unparseable_amount: 'had an amount we could not read',
  unparseable_quantity: 'had a quantity we could not read',
  unparseable_price: 'had a price we could not read (kept without a price)',
  unparseable_market_value: 'had a market value we could not read (kept without a value)',
  unparseable_brokerage: 'had a brokerage amount we could not read',
  unparseable_franking_credit: 'had a franking credit we could not read',
  unparseable_withholding_tax: 'had a withholding tax amount we could not read',
  unparseable_settlement_date: 'had a settlement date we could not read',
  unparseable_valuation_date_used_statement_date: 'had a valuation date we could not read (the statement date was used)',
  unparseable_summary_value: 'was a total or cash line we could not read',
  zero_positions_extracted: 'no holdings could be read from this file',
  read_by_ai_fallback_not_native_parser: 'this statement was read by AI and confirmed by you',
};

const money = (v: number | string | null | undefined, currency = 'AUD') =>
  v === null || v === undefined || v === '' ? '—' : new Intl.NumberFormat('en-AU', { style: 'currency', currency }).format(Number(v));

async function readJson(res: Response) {
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

const reconciliationLabel: Record<string, string> = {
  reconciled: 'Reconciled — the holdings add up to the statement total',
  variance: 'Needs review — the holdings do not add up to the statement total',
  insufficient_data: 'Not checked — this statement does not print a total we can check the holdings against',
};

export function AuInvestmentStatementImportPanel({
  onClose,
  onApplied,
  resumeDocumentId,
}: {
  onClose: () => void;
  onApplied?: () => void;
  /** WP-12 (PO D-05): open straight at an imported statement, e.g. to add its holdings to Net Worth. */
  resumeDocumentId?: string | null;
}) {
  const [phase, setPhase] = useState<Phase>('form');
  const [csvKind, setCsvKind] = useState<'transaction' | 'portfolio'>('transaction');
  const [institutionName, setInstitutionName] = useState('');
  const [maskedAccountIdentifier, setMaskedAccountIdentifier] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [statement, setStatement] = useState<Statement | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [busy, setBusy] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
  // WP-12 (INV-G3/INV-G10): account + holder, security picks, the pre-Apply
  // comparison, and the D-05 "Add to Net Worth" step.
  const [accountMatch, setAccountMatch] = useState<AccountMatchState>({ outcome: null, candidates: [], ownerRecorded: false });
  const [members, setMembers] = useState<HouseholdMember[]>([]);
  const [ownerChoice, setOwnerChoice] = useState<string>('self');
  const [newAccountInstitution, setNewAccountInstitution] = useState('');
  const [newAccountMasked, setNewAccountMasked] = useState('');
  const [pickedAccountId, setPickedAccountId] = useState<string>('');
  const [securityCandidates, setSecurityCandidates] = useState<Record<string, { instrumentId: string; name: string }[]>>({});
  const [securityClass, setSecurityClass] = useState<Record<string, 'equity' | 'etf' | 'mutual_fund'>>({});
  const [compareRows, setCompareRows] = useState<CompareRow[] | null>(null);
  const [publishHoldings, setPublishHoldings] = useState<PublishHolding[]>([]);
  const [publishInclude, setPublishInclude] = useState<Record<string, boolean>>({});
  const [publishLink, setPublishLink] = useState<Record<string, string>>({});
  const [publishResults, setPublishResults] = useState<{ snapshot_id: string; ok: boolean; reason: string | null }[] | null>(null);
  // App Review 2026-09-14, item 2: same gap as BankStatementImportPanel.tsx
  // (see that file's identical comment) — this panel used to always render
  // as a fully working upload form and only discover the FDH-3 production
  // hard gate (lib/financial-data-hub/constants/featureFlags.ts) when the
  // upload itself failed. `null` = not checked yet; `true`/`false` once known.
  const [uploadEnabled, setUploadEnabled] = useState<boolean | null>(null);
  // AIE AU investment-statement AI-fallback (2026-09-23). Held only for the
  // lifetime of the `ai_fallback_review` phase; cleared by `reset()` and on
  // confirm. Nothing in this draft exists in the database yet.
  const [aiDraft, setAiDraft] = useState<AiFallbackDraft | null>(null);
  // 2026-09-25: true when the draft on screen was resumed from the waiting
  // list rather than read from this session's upload -- the form's CSV-kind
  // choice then says nothing about it, so the confirm leaves the kind to the
  // server (which infers it from the reviewed lines).
  const [draftResumed, setDraftResumed] = useState(false);
  // 2026-09-25: statements this user left part-way through. Before, a reload
  // stranded an AI reading, an unapproved statement or an unapplied one.
  const { items: waiting, reload: reloadWaiting } = useWaitingImports('investment');
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

  useEffect(() => {
    let cancelled = false;
    fetch('/api/household-members')
      .then((res) => (res.ok ? res.json() : { data: [] }))
      .then((json) => {
        if (cancelled) return;
        const active = ((json.data ?? []) as HouseholdMember[]).filter((m) => m.is_active !== false);
        setMembers(active);
        const me = active.find((m) => m.relationship === 'self');
        if (me) setOwnerChoice((c) => (c === 'self' ? me.id : c));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // WP-12 (PO D-05): opened from the Investments tab's "Imported statements"
  // list to finish a statement or add its holdings to Net Worth.
  useEffect(() => {
    if (!resumeDocumentId) return;
    setDocumentId(resumeDocumentId);
    void (async () => {
      const loaded = await loadReview(resumeDocumentId);
      if (loaded?.statement.approval_status === 'approved') {
        const anyApplied = loaded.positions.some((p) => p.apply_status === 'applied');
        const anyPending = [...loaded.positions, ...loaded.activities].some((r) => r.apply_status === 'pending');
        if (anyApplied && !anyPending) await loadPublishPreview(resumeDocumentId);
        else setPhase('comparing');
      }
    })();
    // loadReview/loadPublishPreview are stable closures over setters only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeDocumentId]);

  function ownerBody(): { owner_self: true } | { owner_member_id: string } {
    return ownerChoice === 'self' ? { owner_self: true } : { owner_member_id: ownerChoice };
  }

  async function postJson(url: string, body: unknown) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return readJson(res);
  }

  function reset() {
    setPhase('form');
    setFile(null);
    setDocumentId(null);
    setMessage(null);
    setStatement(null);
    setPositions([]);
    setActivities([]);
    setAiDraft(null);
    setDraftResumed(false);
    setApplyResult(null);
    setAccountMatch({ outcome: null, candidates: [], ownerRecorded: false });
    setSecurityCandidates({});
    setCompareRows(null);
    setPublishHoldings([]);
    setPublishResults(null);
  }

  /** Removes one AI-read line the user judges wrong. Deletion is the only
   * per-row edit offered here, deliberately: the statement's own review,
   * matching and approval steps (which this draft feeds into once saved) are
   * where values get examined in detail, and duplicating them as an editable
   * grid before anything exists would be a second review surface. Removing a
   * line the model hallucinated or double-counted is the one correction that
   * must happen BEFORE the write, because it is the one that would otherwise
   * become evidence. */
  function removeAiDraftHolding(index: number) {
    setAiDraft((d) => (d ? { ...d, holdings: d.holdings.filter((_, i) => i !== index) } : d));
  }

  function removeAiDraftActivity(index: number) {
    setAiDraft((d) => (d ? { ...d, activities: d.activities.filter((_, i) => i !== index) } : d));
  }

  async function handleConfirmAiDraft() {
    if (!aiDraft || !documentId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/financial-data-hub/investment-statement/${documentId}/ai-fallback/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // The user's own form choice travels back with the confirmation —
          // the statement's kind is caller context, never the model's reading.
          csv_kind: draftResumed ? undefined : csvKind,
          holdings: aiDraft.holdings,
          activities: aiDraft.activities,
          institutionName: institutionName || aiDraft.institutionName,
          maskedAccountIdentifier: maskedAccountIdentifier || null,
          statementDate: aiDraft.statementDate,
          statementPeriodStart: aiDraft.statementPeriodStart,
          statementPeriodEnd: aiDraft.statementPeriodEnd,
        }),
      });
      const { ok: confirmOk, json } = await readJson(res);
      if (!confirmOk) {
        setMessage(json.error ?? 'We could not save this statement.');
        setPhase('error');
        return;
      }
      setAiDraft(null);
      setDraftResumed(false);
      reloadWaiting();
      // The confirm route returns the SAME envelope as upload/process, so the
      // journey rejoins the ordinary path here: review -> match -> approve ->
      // apply, with nothing downstream aware that a model was involved.
      await handleStatementOutcome(json);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Something went wrong.');
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }

  async function loadReview(docId: string): Promise<{ statement: Statement; positions: Position[]; activities: Activity[] } | null> {
    const res = await fetch(`/api/financial-data-hub/investment-statement/${docId}`);
    const { ok, json } = await readJson(res);
    if (!ok) {
      setMessage(json.error ?? 'We could not load this statement.');
      setPhase('error');
      return null;
    }
    const loaded = {
      statement: json.data.statement as Statement,
      positions: (json.data.positions as Position[]) ?? [],
      activities: (json.data.activities as Activity[]) ?? [],
    };
    setStatement(loaded.statement);
    setPositions(loaded.positions);
    setActivities(loaded.activities);
    setNewAccountInstitution((v) => v || loaded.statement.institution_name || '');
    setNewAccountMasked((v) => v || loaded.statement.masked_account_identifier || '');
    if (loaded.statement.canonical_account_id) {
      // Know whether the matched account already records its holder.
      const { json: acct } = await postJson(`/api/financial-data-hub/investment-statement/${docId}/account-match`, { action: 'resolve', account_type: 'broker', currency_code: loaded.statement.base_currency ?? 'AUD' });
      if (acct?.data) setAccountMatch({ outcome: 'single_match', candidates: (acct.data.candidates as AccountCandidate[]) ?? [], ownerRecorded: Boolean(acct.data.owner_recorded) });
    }
    setPhase('review');
    return loaded;
  }

  // Handles the JSON body from EITHER the initial upload call or the
  // real-malware-gate async fix's `.../process` resumption call — both
  // return the identical `{ document_id, pipeline_status, statement_id,
  // error_message, duplicate }` shape (see the API routes), so one function
  // covers the "what do we do with this outcome" decision for both.
  async function handleStatementOutcome(json: Record<string, unknown>) {
    const data = json.data as Record<string, unknown>;
    // AIE AU investment-statement AI-fallback (2026-09-23). Checked BEFORE the
    // "no statement_id means we could not read it" branch below, which would
    // otherwise misread a perfectly good draft as a hard failure — an
    // AI-fallback response deliberately carries NO statement_id, because
    // nothing has been written yet.
    if (data.pipeline_status === 'ai_fallback_available' && data.ai_fallback_draft) {
      // For a re-upload, `document_id` is the ORIGINAL upload whose reading
      // still awaits a check (2026-09-25) -- the confirm goes there.
      setDocumentId(data.document_id as string);
      setMessage(data.duplicate_of_document_id ? DUPLICATE_UPLOAD_MESSAGE : null);
      setAiDraft(data.ai_fallback_draft as AiFallbackDraft);
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
      // `document_id` is the ORIGINAL upload (the copy has no evidence of its own).
      setMessage(DUPLICATE_UPLOAD_MESSAGE);
      await loadReview(data.document_id as string);
      setPhase('duplicate');
      return;
    }
    await loadReview(data.document_id as string);
  }

  async function handleUpload() {
    if (!file) return;
    setBusy(true);
    setPhase('uploading');
    setMessage(null);
    try {
      const params = new URLSearchParams({ csv_kind: csvKind, currency_code: 'AUD' });
      if (institutionName) params.set('institution_name', institutionName);
      if (maskedAccountIdentifier) params.set('masked_account_identifier', maskedAccountIdentifier);

      const res = await fetch(`/api/financial-data-hub/investment-statement/upload?${params.toString()}`, {
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
      // returns `pipeline_status: 'pending_scan'` (statement_id: null,
      // NOT a failure) instead of extracting immediately when the real
      // S3+GuardDuty scan has not yet resolved — see
      // investmentStatementProcessingService.ts's `resolveAuInvestment
      // StatementDocument()`. Checked BEFORE the "no statement_id means
      // unable to read" branch below, which would otherwise misread this
      // wait state as a real failure.
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
              ?? 'This file could not be accepted. Please try a different file, or add this investment manually below.',
          );
          setPhase('unable_to_read');
          return;
        }
        // The scan cleared -- finish the extraction the upload route
        // deferred, re-submitting the SAME metadata originally supplied.
        const processRes = await fetch(`/api/financial-data-hub/investment-statement/${docId}/process`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            csv_kind: csvKind,
            currency_code: 'AUD',
            institution_name: institutionName || undefined,
            masked_account_identifier: maskedAccountIdentifier || undefined,
          }),
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

  /** Continue a statement left part-way through (2026-09-25). */
  async function resumeWaiting(item: WaitingImport) {
    setDocumentId(item.document_id);
    setMessage(null);
    if (item.stage === 'ai_draft' && item.ai_fallback_draft) {
      setAiDraft(item.ai_fallback_draft as AiFallbackDraft);
      setDraftResumed(true);
      setPhase('ai_fallback_review');
      return;
    }
    setBusy(true);
    try {
      await loadReview(item.document_id);
    } finally {
      setBusy(false);
    }
  }

  async function handleMatchAll() {
    if (!documentId) return;
    setBusy(true);
    setPhase('matching');
    try {
      const { json: acct } = await postJson(`/api/financial-data-hub/investment-statement/${documentId}/account-match`, { action: 'resolve', account_type: 'broker', currency_code: statement?.base_currency ?? 'AUD' });
      if (acct?.data) {
        setAccountMatch({ outcome: acct.data.outcome, candidates: (acct.data.candidates as AccountCandidate[]) ?? [], ownerRecorded: Boolean(acct.data.owner_recorded) });
      }
      // Re-try every line that still has no match (a security created for one
      // line resolves every other line with the same code). Lines that never
      // need a security (broker cash, unsupported types) are not sent.
      const candidates: Record<string, { instrumentId: string; name: string }[]> = {};
      const rows: [string, { id: string; security_match_status: string; activity_type?: string; security_name_raw: string | null; ticker_raw: string | null; isin: string | null }][] = [
        ...positions.map((p) => ['fdh_investment_statement_positions', p] as [string, Position]),
        ...activities.map((a) => ['fdh_investment_statement_activities', a] as [string, Activity]),
      ];
      for (const [table, row] of rows) {
        if (row.security_match_status === 'matched' || !needsSecurityMatch(row)) continue;
        const { json: sec } = await postJson(`/api/financial-data-hub/investment-statement/${documentId}/security-match`, { table, row_id: row.id });
        if (sec?.data?.outcome === 'ambiguous') candidates[row.id] = (sec.data.candidates as { instrumentId: string; name: string }[]) ?? [];
      }
      setSecurityCandidates(candidates);
      await fetch(`/api/financial-data-hub/investment-statement/${documentId}/bank-match`, { method: 'POST' });
      await loadReview(documentId);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Something went wrong.');
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }

  /** Runs one account/security action, then reloads the review. Errors stay on the review screen. */
  async function runReviewAction(action: () => Promise<{ ok: boolean; json: { error?: string; message?: string } }>) {
    if (!documentId) return;
    setBusy(true);
    setMessage(null);
    try {
      const { ok, json } = await action();
      if (!ok) {
        // `bad(msg, status, code)` sends { error: code, message: msg } -- show the sentence, not the code.
        setMessage(json.message ?? json.error ?? 'That did not work. Please try again.');
        return;
      }
      await loadReview(documentId);
    } finally {
      setBusy(false);
    }
  }

  // INV-G3 / INV-G10: "Add as new account", with its holder.
  function handleAddNewAccount() {
    return runReviewAction(async () => {
      const r = await postJson(`/api/financial-data-hub/investment-statement/${documentId}/account-match`, {
        action: 'confirm_new',
        institution_name: newAccountInstitution.trim(),
        masked_account_identifier: newAccountMasked.trim() || null,
        currency_code: statement?.base_currency ?? 'AUD',
        ...ownerBody(),
      });
      if (r.ok) setAccountMatch({ outcome: 'single_match', candidates: [], ownerRecorded: true });
      return r;
    });
  }

  function handlePickAccount() {
    return runReviewAction(() => postJson(`/api/financial-data-hub/investment-statement/${documentId}/account-match`, { action: 'confirm_existing', account_id: pickedAccountId, ...ownerBody() }));
  }

  function handleSetOwner() {
    return runReviewAction(async () => {
      const r = await postJson(`/api/financial-data-hub/investment-statement/${documentId}/account-match`, { action: 'set_owner', ...ownerBody() });
      if (r.ok) setAccountMatch((m) => ({ ...m, ownerRecorded: true }));
      return r;
    });
  }

  // INV-G3: "Create security" for a line nothing matched, or pick among ambiguous candidates.
  function handleCreateSecurity(table: string, rowId: string) {
    return runReviewAction(async () => {
      const r = await postJson(`/api/financial-data-hub/investment-statement/${documentId}/security-match`, { table, row_id: rowId, confirm_new_security: true, instrument_class: securityClass[rowId] ?? 'equity' });
      if (r.ok) {
        // Any other line with the same code now resolves to the new security.
        for (const [t, row] of [
          ...positions.map((p) => ['fdh_investment_statement_positions', p] as [string, Position]),
          ...activities.map((a) => ['fdh_investment_statement_activities', a] as [string, Activity]),
        ]) {
          if (row.id === rowId || row.security_match_status === 'matched' || !needsSecurityMatch(row)) continue;
          await postJson(`/api/financial-data-hub/investment-statement/${documentId}/security-match`, { table: t, row_id: row.id });
        }
      }
      return r;
    });
  }

  function handlePickSecurity(table: string, rowId: string, instrumentId: string) {
    return runReviewAction(() => postJson(`/api/financial-data-hub/investment-statement/${documentId}/security-match`, { table, row_id: rowId, confirm_instrument_id: instrumentId }));
  }

  async function loadCompare(docId: string) {
    const res = await fetch(`/api/financial-data-hub/investment-statement/${docId}/current-vs-statement`);
    const { ok, json } = await readJson(res);
    setCompareRows(ok ? ((json.data?.rows as CompareRow[]) ?? []) : null);
  }

  async function handleApprove() {
    if (!documentId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/financial-data-hub/investment-statement/${documentId}/approve`, { method: 'POST' });
      const { ok, json } = await readJson(res);
      if (!ok) throw new Error(json.error ?? 'Could not approve this statement evidence.');
      await loadReview(documentId);
      // INV-G11: the current-vs-statement comparison is shown BEFORE Apply.
      await loadCompare(documentId);
      setPhase('comparing');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Something went wrong.');
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }

  async function handleApply() {
    if (!documentId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/financial-data-hub/investment-statement/${documentId}/apply`, { method: 'POST' });
      const { ok, json } = await readJson(res);
      if (!ok) throw new Error(json.error ?? 'The change could not be saved.');
      setApplyResult(json.data as ApplyResult);
      setPhase('applied');
      reloadWaiting(); // this statement is no longer waiting
      onApplied?.();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Something went wrong.');
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }

  // PO D-05: the explicit "Add to Net Worth" confirm step.
  async function loadPublishPreview(docId: string) {
    setBusy(true);
    setMessage(null);
    try {
      const { ok, json } = await postJson(`/api/financial-data-hub/investment-statement/${docId}/publish`, { action: 'preview' });
      if (!ok) throw new Error(json.error ?? 'We could not prepare these holdings.');
      const holdings = (json.data.holdings as PublishHolding[]) ?? [];
      setPublishHoldings(holdings);
      setPublishInclude(Object.fromEntries(holdings.map((h) => [h.snapshot_id, !h.published && h.eligibility_status !== 'NOT_ELIGIBLE'])));
      setPublishLink({});
      setPublishResults(null);
      setPhase('publishing');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Something went wrong.');
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }

  async function handlePublish() {
    if (!documentId) return;
    const decisions = publishHoldings
      .filter((h) => publishInclude[h.snapshot_id])
      .map((h) => {
        const link = publishLink[h.snapshot_id];
        return link && link !== 'new'
          ? { snapshot_id: h.snapshot_id, link_to_existing_investment_id: link }
          : { snapshot_id: h.snapshot_id, acknowledged_no_duplicate: h.duplicate_candidates.length > 0 ? link === 'new' : false };
      });
    if (decisions.length === 0) return;
    setBusy(true);
    try {
      const { ok, json } = await postJson(`/api/financial-data-hub/investment-statement/${documentId}/publish`, { action: 'publish', decisions });
      if (!ok) throw new Error(json.error ?? 'We could not add these holdings.');
      setPublishResults(json.data.results);
      setPhase('published');
      onApplied?.();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Something went wrong.');
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }

  // INV-G3: only lines that genuinely need a security block approval; broker
  // cash and unsupported lines are skipped at Apply with a visible reason.
  const unresolvedRows = [...positions, ...activities].filter((r) => r.security_match_status !== 'matched' && needsSecurityMatch(r));
  const unresolvedCount = unresolvedRows.length;
  const accountReady = Boolean(statement?.canonical_account_id) && accountMatch.ownerRecorded;
  const warnings = statement?.extraction_warnings ?? [];
  const droppedRows = warnings.filter((w) => w.rowsDropped).reduce((n, w) => n + Number(w.count || 0), 0);
  const hasBrokerCashLines = activities.some((a) => ['INTEREST', 'CASH_DEPOSIT', 'CASH_WITHDRAWAL'].includes(a.activity_type));
  const ownerPicker = (
    <label className="block text-sm">
      <span className="mb-1 block text-muted">Who holds this account?</span>
      <select className="w-full rounded border border-gray-300 px-3 py-2" value={ownerChoice} onChange={(e) => setOwnerChoice(e.target.value)}>
        {!members.some((m) => m.relationship === 'self') && <option value="self">Me</option>}
        {members
          .filter((m) => ['self', 'spouse', 'partner'].includes(m.relationship))
          .map((m) => (
            <option key={m.id} value={m.id}>
              {m.full_name} ({m.relationship === 'self' ? 'me' : m.relationship})
            </option>
          ))}
      </select>
    </label>
  );

  return (
    <div role="region" aria-label="Import an Australian investment statement" className="rounded border border-gray-200 p-5" aria-live="polite">
      <div className="flex items-start justify-between gap-4">
        <h2 className="text-lg font-semibold text-trust">Import Australian Investment Statement</h2>
        <button type="button" onClick={onClose} className="text-sm text-muted underline" aria-label="Close statement import">
          Close
        </button>
      </div>

      {uploadEnabled === false && phase === 'form' && (
        <div className="mt-4 space-y-2">
          <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Statement import isn&apos;t turned on in this environment yet. You can still add this investment
            yourself using the Investments form below.
          </p>
        </div>
      )}

      {phase === 'form' && <WaitingImportsList items={waiting} busy={busy} onContinue={(w) => void resumeWaiting(w)} />}

      {uploadEnabled !== false && phase === 'form' && (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-muted">
            Upload a transaction-history or portfolio-holdings CSV and FHIP will extract the details for you to review before
            anything is added to your Investments.
          </p>
          <p className="text-xs text-muted">
            FHIP currently reads two generic Australian CSV layouts (a transaction-history export and a portfolio/holdings
            export with standard column headers). Broker-specific exports or PDF statements outside these layouts are not
            yet supported — you can still add the investment manually below instead.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Statement contains</span>
              <select className="w-full rounded border border-gray-300 px-3 py-2" value={csvKind} onChange={(e) => setCsvKind(e.target.value as 'transaction' | 'portfolio')}>
                <option value="transaction">Transaction history</option>
                <option value="portfolio">Portfolio / holdings</option>
              </select>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Broker / institution</span>
              <input className="w-full rounded border border-gray-300 px-3 py-2" value={institutionName} onChange={(e) => setInstitutionName(e.target.value)} />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted">Account (masked, e.g. ****1234)</span>
              <input className="w-full rounded border border-gray-300 px-3 py-2" value={maskedAccountIdentifier} onChange={(e) => setMaskedAccountIdentifier(e.target.value)} />
            </label>
          </div>
          <label className="block text-sm">
            <span className="mb-1 block text-muted">Statement file (CSV)</span>
            <input type="file" accept="text/csv,.csv" className="block w-full text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <button type="button" onClick={handleUpload} disabled={!file || busy || uploadEnabled !== true} className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50">
            Upload statement
          </button>
        </div>
      )}

      {(phase === 'uploading' || phase === 'matching' || phase === 'scanning') && (
        <p className="mt-4 text-sm text-muted" role="status">
          {phase === 'uploading' && 'Uploading and reading your statement…'}
          {phase === 'scanning' && (message ?? SCANNING_MESSAGE)}
          {phase === 'matching' && 'Matching accounts, securities and bank evidence…'}
        </p>
      )}

      {phase === 'unable_to_read' && (
        <div className="mt-4 space-y-3">
          <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">{message}</p>
          <p className="text-sm text-muted">You can try a different file, or add this investment manually instead.</p>
          <button type="button" onClick={reset} className="rounded border border-gray-300 px-3 py-1 text-sm">Try again</button>
        </div>
      )}

      {phase === 'scan_timeout' && (
        <div className="mt-4 space-y-3">
          <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">{message ?? SCAN_TIMEOUT_MESSAGE}</p>
          <button type="button" onClick={reset} className="rounded border border-gray-300 px-3 py-1 text-sm">Try again</button>
        </div>
      )}

      {phase === 'error' && (
        <div className="mt-4 space-y-3">
          <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-800">{message}</p>
          <button type="button" onClick={reset} className="rounded border border-gray-300 px-3 py-1 text-sm">Try again</button>
        </div>
      )}

      {phase === 'ai_fallback_review' && aiDraft && (
        <div className="mt-4 space-y-4">
          {message && <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">{message}</p>}
          <p className="rounded bg-blue-50 px-3 py-2 text-sm text-blue-900">
            We could not recognise this statement&apos;s layout automatically, so we used AI to read it instead. Please
            check these lines before saving — <strong>nothing has been saved yet</strong>.
          </p>

          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-muted">Broker / institution</dt>
              <dd>{institutionName || aiDraft.institutionName || 'Not shown'}</dd>
            </div>
            <div>
              <dt className="text-muted">Statement date</dt>
              <dd>{aiDraft.statementDate ?? 'Not shown'}</dd>
            </div>
            <div>
              <dt className="text-muted">Period</dt>
              <dd>
                {aiDraft.statementPeriodStart ?? '?'} to {aiDraft.statementPeriodEnd ?? '?'}
              </dd>
            </div>
          </dl>

          {!aiDraft.allRowsListed && (
            <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
              The AI reported that it could <strong>not</strong> list every line on this statement. If you save this,
              the evidence will be incomplete — we recommend adding the missing lines by hand afterwards, or trying a
              different file.
            </p>
          )}

          {aiDraft.holdings.length > 0 && (
            <div>
              <p className="mb-2 text-sm text-muted">
                {aiDraft.holdings.length} holding{aiDraft.holdings.length === 1 ? '' : 's'} read. Remove any line that
                is wrong or is not really a holding.
              </p>
              <div className="max-h-72 overflow-y-auto rounded border border-gray-200">
                <table className="w-full text-sm">
                  <caption className="sr-only">Holdings read from this statement by AI, awaiting your confirmation</caption>
                  <thead className="sticky top-0 bg-gray-50 text-left">
                    <tr>
                      <th scope="col" className="px-3 py-2">Security</th>
                      <th scope="col" className="px-3 py-2">Code</th>
                      <th scope="col" className="px-3 py-2 text-right">Units</th>
                      <th scope="col" className="px-3 py-2 text-right">Value</th>
                      <th scope="col" className="px-3 py-2">As at</th>
                      <th scope="col" className="px-3 py-2"><span className="sr-only">Remove</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {aiDraft.holdings.map((h, i) => (
                      <tr key={`${h.securityNameRaw}-${i}`} className="border-t border-gray-100">
                        <td className="px-3 py-2">{h.securityNameRaw}</td>
                        <td className="px-3 py-2">{h.tickerRaw ?? '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{h.quantity}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{h.marketValue ?? '—'}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{h.valuationDate}</td>
                        <td className="px-3 py-2 text-right">
                          <button type="button" onClick={() => removeAiDraftHolding(i)} className="rounded border border-gray-300 px-2 py-1 text-xs">
                            Remove<span className="sr-only"> the {h.securityNameRaw} holding</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {aiDraft.activities.length > 0 && (
            <div>
              <p className="mb-2 text-sm text-muted">
                {aiDraft.activities.length} transaction{aiDraft.activities.length === 1 ? '' : 's'} read. Remove any
                line that is wrong or is not really a transaction.
              </p>
              <div className="max-h-72 overflow-y-auto rounded border border-gray-200">
                <table className="w-full text-sm">
                  <caption className="sr-only">Transactions read from this statement by AI, awaiting your confirmation</caption>
                  <thead className="sticky top-0 bg-gray-50 text-left">
                    <tr>
                      <th scope="col" className="px-3 py-2">Date</th>
                      <th scope="col" className="px-3 py-2">Type</th>
                      <th scope="col" className="px-3 py-2">Security</th>
                      <th scope="col" className="px-3 py-2 text-right">Units</th>
                      <th scope="col" className="px-3 py-2 text-right">Amount</th>
                      <th scope="col" className="px-3 py-2"><span className="sr-only">Remove</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {aiDraft.activities.map((a, i) => (
                      <tr key={`${a.transactionType}-${i}`} className="border-t border-gray-100">
                        <td className="px-3 py-2 whitespace-nowrap">{a.tradeDate ?? '—'}</td>
                        <td className="px-3 py-2">{a.transactionType}</td>
                        <td className="px-3 py-2">{a.securityNameRaw ?? a.tickerRaw ?? '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{a.quantity ?? '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{a.amount}</td>
                        <td className="px-3 py-2 text-right">
                          <button type="button" onClick={() => removeAiDraftActivity(i)} className="rounded border border-gray-300 px-2 py-1 text-xs">
                            Remove<span className="sr-only"> the {a.transactionType} line on {a.tradeDate ?? 'an unknown date'}</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="text-xs text-muted">
            AI-read values are shown for your confirmation only. Saving them creates statement evidence — exactly as a
            statement we read automatically would — which you then match, reconcile and explicitly approve before
            anything reaches your Investments.
          </p>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => {
                // 2026-09-25: recorded on the server too, so the reading is not
                // offered again as something to continue.
                if (documentId) void discardAiDraft(documentId).then(reloadWaiting);
                setAiDraft(null);
                setDraftResumed(false);
                setMessage(AI_FALLBACK_DECLINED_MESSAGE);
                setPhase('unable_to_read');
              }}
              className="rounded border border-gray-300 px-3 py-1 text-sm"
            >
              This doesn&apos;t look right
            </button>
            <button
              type="button"
              onClick={handleConfirmAiDraft}
              disabled={busy || aiDraft.holdings.length + aiDraft.activities.length === 0}
              className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              Save this statement
            </button>
          </div>
        </div>
      )}

      {(phase === 'review' || phase === 'duplicate' || phase === 'comparing') && statement && (
        <div className="mt-4 space-y-4">
          <h3 className="font-semibold">Statement review</h3>
          {message && <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">{message}</p>}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted">Institution</dt>
            <dd>{statement.institution_name ?? 'Not identified'}</dd>
            <dt className="text-muted">Account (masked)</dt>
            <dd>{statement.masked_account_identifier ?? 'Not provided'}</dd>
            <dt className="text-muted">Statement date</dt>
            <dd>{statement.statement_date ?? 'Not shown'}</dd>
            <dt className="text-muted">Period</dt>
            <dd>
              {statement.statement_start_date || statement.statement_end_date ? `${statement.statement_start_date ?? '?'} to ${statement.statement_end_date ?? '?'}` : 'Not shown'}
            </dd>
            {statement.closing_portfolio_value !== null && (
              <>
                <dt className="text-muted">Statement total</dt>
                <dd>{money(statement.closing_portfolio_value, statement.base_currency)}</dd>
              </>
            )}
          </dl>
          <p className="text-sm" role="status">
            <span className="font-medium">Reconciliation: </span>
            {reconciliationLabel[statement.reconciliation_status]}
          </p>

          {/* INV-G6: rows that could not be read are shown, never silently gone. */}
          {warnings.length > 0 && (
            <div className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {droppedRows > 0 && (
                <p className="font-medium">
                  {droppedRows} row{droppedRows === 1 ? '' : 's'} could not be read and {droppedRows === 1 ? 'was' : 'were'} not saved.
                </p>
              )}
              <ul className="mt-1 list-disc pl-5">
                {warnings.map((w) => (
                  <li key={w.code}>
                    {w.count > 1 || w.rows ? `${w.count} row${w.count === 1 ? '' : 's'} ` : ''}
                    {WARNING_LABELS[w.code] ?? w.code.replace(/_/g, ' ')}
                    {w.rows && w.rows.length > 0 ? ` (row${w.rows.length === 1 ? '' : 's'} ${w.rows.slice(0, 10).join(', ')}${w.rows.length > 10 ? '…' : ''})` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* PO D-11 / INV-G8: broker cash is shown, never counted. */}
          {(statement.cash_balance !== null || hasBrokerCashLines) && (
            <p className="rounded bg-blue-50 px-3 py-2 text-sm text-blue-900">
              {statement.cash_balance !== null ? `Broker cash on this statement: ${money(statement.cash_balance, statement.base_currency)}. ` : ''}
              Broker cash isn&apos;t tracked in FHIP yet, so cash held at your broker (and interest, deposits and withdrawals on it) is kept as statement
              evidence only — it is not added to your Investments or Net Worth. Money you moved from your bank to your broker is recorded as invested, not spent.
            </p>
          )}

          {/* INV-G3 / INV-G10: the investment account and who holds it. */}
          <div className="rounded border border-gray-200 p-3 text-sm">
            <h4 className="font-medium">Investment account</h4>
            {statement.canonical_account_id ? (
              <div className="mt-1 space-y-2">
                <p>
                  Matched to{' '}
                  {accountMatch.candidates[0]
                    ? `${accountMatch.candidates[0].institutionName ?? 'your account'}${accountMatch.candidates[0].maskedAccountIdentifier ? ` ${accountMatch.candidates[0].maskedAccountIdentifier}` : ''}`
                    : 'your investment account'}
                  .
                </p>
                {!accountMatch.ownerRecorded && statement.approval_status !== 'approved' && (
                  <div className="space-y-2">
                    <p className="text-muted">Tell us who holds this account so its holdings can count toward the right person.</p>
                    {ownerPicker}
                    <button type="button" onClick={() => void handleSetOwner()} disabled={busy} className="rounded border border-trust px-3 py-1 text-sm text-trust disabled:opacity-50">
                      Save account holder
                    </button>
                  </div>
                )}
              </div>
            ) : accountMatch.outcome === 'ambiguous' && accountMatch.candidates.length > 0 ? (
              <fieldset className="mt-2 space-y-2">
                <legend className="text-muted">More than one of your accounts could be this one. Which is it?</legend>
                {accountMatch.candidates.map((c) => (
                  <label key={c.accountId} className="flex items-center gap-2">
                    <input type="radio" name="au-account-pick" value={c.accountId} checked={pickedAccountId === c.accountId} onChange={() => setPickedAccountId(c.accountId)} />
                    {c.institutionName ?? 'Investment account'} {c.maskedAccountIdentifier ?? ''}
                  </label>
                ))}
                {ownerPicker}
                <button type="button" onClick={() => void handlePickAccount()} disabled={busy || !pickedAccountId} className="rounded border border-trust px-3 py-1 text-sm text-trust disabled:opacity-50">
                  Use this account
                </button>
              </fieldset>
            ) : accountMatch.outcome === 'no_match' ? (
              <div className="mt-2 space-y-2">
                <p className="text-muted">We did not find this account among your investment accounts. Add it as a new account:</p>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block text-sm">
                    <span className="mb-1 block text-muted">Broker / institution</span>
                    <input className="w-full rounded border border-gray-300 px-3 py-2" value={newAccountInstitution} onChange={(e) => setNewAccountInstitution(e.target.value)} />
                  </label>
                  <label className="block text-sm">
                    <span className="mb-1 block text-muted">Account (masked, e.g. ****1234)</span>
                    <input className="w-full rounded border border-gray-300 px-3 py-2" value={newAccountMasked} onChange={(e) => setNewAccountMasked(e.target.value)} />
                  </label>
                </div>
                {ownerPicker}
                <button type="button" onClick={() => void handleAddNewAccount()} disabled={busy || !newAccountInstitution.trim()} className="rounded border border-trust px-3 py-1 text-sm text-trust disabled:opacity-50">
                  Add as new account
                </button>
              </div>
            ) : (
              <p className="mt-1 text-muted">Not yet matched — press &quot;Match accounts &amp; securities&quot;.</p>
            )}
          </div>

          {positions.length > 0 && (
            <div>
              <h4 className="text-sm font-medium">Holdings on this statement ({positions.length})</h4>
              <ul className="mt-2 space-y-1 text-sm">
                {positions.map((p) => (
                  <li key={p.id} className="border-b border-gray-100 py-1">
                    <div className="flex justify-between gap-2">
                      <span>
                        {p.security_name_raw}
                        {p.ticker_raw ? ` (${p.ticker_raw})` : ''} — {p.quantity} units{p.market_value !== null ? `, ${money(p.market_value, statement.base_currency)}` : ', no value shown'}
                      </span>
                      <span className="text-muted">{p.security_match_status === 'matched' ? 'Security matched' : p.security_match_status === 'ambiguous' ? 'More than one match' : 'No match yet'}</span>
                    </div>
                    {statement.approval_status !== 'approved' && p.security_match_status !== 'matched' && (
                      <SecurityResolver
                        rowId={p.id}
                        table="fdh_investment_statement_positions"
                        label={p.security_name_raw}
                        candidates={securityCandidates[p.id] ?? []}
                        instrumentClass={securityClass[p.id] ?? 'equity'}
                        busy={busy}
                        onClass={(c) => setSecurityClass((s) => ({ ...s, [p.id]: c }))}
                        onCreate={() => void handleCreateSecurity('fdh_investment_statement_positions', p.id)}
                        onPick={(id) => void handlePickSecurity('fdh_investment_statement_positions', p.id, id)}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {activities.length > 0 && (
            <div>
              <h4 className="text-sm font-medium">Transactions on this statement ({activities.length})</h4>
              <ul className="mt-2 space-y-1 text-sm">
                {activities.map((a) => (
                  <li key={a.id} className="border-b border-gray-100 py-1">
                    <div className="flex justify-between gap-2">
                      <span>
                        {a.trade_date ?? '—'} — {a.activity_type} {a.security_name_raw ?? a.ticker_raw ?? ''} {money(a.amount, statement.base_currency)}
                        {a.settlement_date ? ` · settles ${a.settlement_date}` : ''}
                        {a.brokerage_raw ? ` · brokerage ${money(a.brokerage_raw, statement.base_currency)}` : ''}
                        {a.franking_credit_raw ? ` · franking ${money(a.franking_credit_raw, statement.base_currency)}` : ''}
                        {a.withholding_tax_raw ? ` · withholding ${money(a.withholding_tax_raw, statement.base_currency)}` : ''}
                      </span>
                      <span className="text-muted">
                        {needsSecurityMatch(a) ? (a.security_match_status === 'matched' ? 'Security matched' : 'No match yet') : 'Kept as evidence'}
                        {a.bank_match_status === 'matched' ? ' · bank payment found' : ''}
                      </span>
                    </div>
                    {statement.approval_status !== 'approved' && a.security_match_status !== 'matched' && needsSecurityMatch(a) && (
                      <SecurityResolver
                        rowId={a.id}
                        table="fdh_investment_statement_activities"
                        label={a.security_name_raw ?? a.ticker_raw ?? a.activity_type}
                        candidates={securityCandidates[a.id] ?? []}
                        instrumentClass={securityClass[a.id] ?? 'equity'}
                        busy={busy}
                        onClass={(c) => setSecurityClass((s) => ({ ...s, [a.id]: c }))}
                        onCreate={() => void handleCreateSecurity('fdh_investment_statement_activities', a.id)}
                        onPick={(id) => void handlePickSecurity('fdh_investment_statement_activities', a.id, id)}
                      />
                    )}
                    {a.apply_status === 'skipped' && a.apply_rejected_reason && <p className="text-xs text-muted">Not added: {a.apply_rejected_reason}</p>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {statement.approval_status !== 'approved' && (
            <div className="flex flex-wrap gap-3">
              <button type="button" onClick={handleMatchAll} disabled={busy} className="rounded border border-trust px-3 py-1 text-sm text-trust">
                Match accounts &amp; securities
              </button>
              <button type="button" onClick={handleApprove} disabled={busy || unresolvedCount > 0 || !accountReady} className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50">
                Approve evidence
              </button>
              {unresolvedCount > 0 && <span className="self-center text-xs text-muted">{unresolvedCount} item(s) still need a confirmed security — review required.</span>}
              {unresolvedCount === 0 && !accountReady && <span className="self-center text-xs text-muted">Confirm the investment account and who holds it first.</span>}
            </div>
          )}

          {statement.approval_status === 'approved' && (
            <div className="space-y-2">
              <p className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">This statement evidence has been approved. Nothing has been added to your Investments yet.</p>
              {/* INV-G11: what changes, shown BEFORE Apply. */}
              {compareRows && compareRows.length > 0 && (
                <table className="w-full text-sm">
                  <caption className="text-left text-sm font-medium">Current holding vs this statement</caption>
                  <thead className="text-left text-muted">
                    <tr>
                      <th scope="col" className="py-1">Security</th>
                      <th scope="col" className="py-1 text-right">Now</th>
                      <th scope="col" className="py-1 text-right">Statement</th>
                    </tr>
                  </thead>
                  <tbody>
                    {compareRows.map((r, i) => (
                      <tr key={`${r.securityNameRaw}-${i}`} className="border-t border-gray-100">
                        <td className="py-1">{r.securityNameRaw}</td>
                        <td className="py-1 text-right tabular-nums">{r.currentQuantity ?? 'none'}</td>
                        <td className="py-1 text-right tabular-nums">{r.statementQuantity}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <button type="button" onClick={handleApply} disabled={busy} className="rounded bg-trust px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                Apply to Investment Intelligence
              </button>
            </div>
          )}
        </div>
      )}

      {phase === 'applied' && applyResult && (
        <div className="mt-4 space-y-3">
          <p className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">
            {applyResult.applied_count} item(s) applied to your Investment Intelligence portfolio
            {applyResult.skipped_count > 0 ? `; ${applyResult.skipped_count} kept as evidence only (reasons below)` : ''}.
          </p>
          {/* INV-G9: every row's outcome, with the reason for anything not added. */}
          <ul className="space-y-1 text-sm">
            {applyResult.positions.map((r) => (
              <li key={r.id}>
                {r.ok ? 'Added' : 'Not added'}: {r.security_name}
                {!r.ok && r.reason ? <span className="block text-xs text-muted">{r.reason}</span> : null}
              </li>
            ))}
            {applyResult.activities.map((r) => (
              <li key={r.id}>
                {r.ok ? 'Added' : 'Not added'}: {r.trade_date ?? ''} {r.activity_type} {money(r.amount ?? null)}
                {!r.ok && r.reason ? <span className="block text-xs text-muted">{r.reason}</span> : null}
              </li>
            ))}
          </ul>
          {applyResult.bank_legs && applyResult.bank_legs.reclassified > 0 && (
            <p className="text-sm text-muted">
              {applyResult.bank_legs.reclassified} matching bank transaction(s) were marked as money invested or returned from your broker, so they are not counted as spending or income.
            </p>
          )}
          {applyResult.bank_leg_error && <p className="text-sm text-amber-900">{applyResult.bank_leg_error}</p>}
          {applyResult.positions.some((r) => r.ok) ? (
            <>
              <p className="text-sm text-muted">
                These holdings are imported but <strong>not yet in your Net Worth</strong>. Add them to include them in your Investments, Dashboard and Net Worth.
              </p>
              <div className="flex gap-3">
                <button type="button" onClick={() => documentId && void loadPublishPreview(documentId)} disabled={busy} className="rounded bg-trust px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                  Add to Net Worth…
                </button>
                <button type="button" onClick={onClose} className="rounded border border-gray-300 px-3 py-1 text-sm">Not now</button>
              </div>
            </>
          ) : (
            <div className="flex gap-3">
              <p className="text-sm text-muted">This statement had no holdings to add to your Net Worth (transaction history is kept in Investment Intelligence).</p>
              <button type="button" onClick={onClose} className="rounded border border-gray-300 px-3 py-1 text-sm">Done</button>
            </div>
          )}
        </div>
      )}

      {phase === 'publishing' && (
        <div className="mt-4 space-y-3">
          <h3 className="font-semibold">Add to Net Worth</h3>
          <p className="text-sm text-muted">
            Choose the holdings to include in your Investments and Net Worth. Until you do, they are shown on your Investments tab as &quot;Imported, not yet in Net Worth&quot;.
          </p>
          {publishHoldings.length === 0 && <p className="text-sm">No applied holdings were found on this statement.</p>}
          <ul className="space-y-3 text-sm">
            {publishHoldings.map((h) => (
              <li key={h.snapshot_id} className="rounded border border-gray-200 p-3">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={Boolean(publishInclude[h.snapshot_id])}
                    disabled={h.published || h.eligibility_status === 'NOT_ELIGIBLE'}
                    onChange={(e) => setPublishInclude((s) => ({ ...s, [h.snapshot_id]: e.target.checked }))}
                  />
                  <span>
                    <span className="font-medium">{h.name}</span> — {money(h.value, h.currency_code)} as at {h.as_of_date}
                    {h.published && <span className="block text-green-800">Already in your Net Worth.</span>}
                    {h.refreshes_existing && <span className="block text-muted">Updates the value already in your Net Worth.</span>}
                  </span>
                </label>
                {h.blocking_reasons.length > 0 && (
                  <ul className="mt-1 list-disc pl-8 text-xs text-amber-900">
                    {h.blocking_reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                )}
                {h.warning_reasons.length > 0 && (
                  <ul className="mt-1 list-disc pl-8 text-xs text-muted">
                    {h.warning_reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                )}
                {!h.published && h.duplicate_candidates.length > 0 && publishInclude[h.snapshot_id] && (
                  <fieldset className="mt-2 space-y-1 pl-6">
                    <legend className="text-xs text-muted">You already have an investment that might be this holding. Is it the same one?</legend>
                    {h.duplicate_candidates.map((d) => (
                      <label key={d.investment_id} className="flex items-center gap-2 text-xs">
                        <input type="radio" name={`dup-${h.snapshot_id}`} checked={publishLink[h.snapshot_id] === d.investment_id} onChange={() => setPublishLink((s) => ({ ...s, [h.snapshot_id]: d.investment_id }))} />
                        Yes — replace my {d.existing_institution ?? 'manual'} investment of {money(d.existing_value, d.existing_currency)} with this imported holding
                      </label>
                    ))}
                    <label className="flex items-center gap-2 text-xs">
                      <input type="radio" name={`dup-${h.snapshot_id}`} checked={publishLink[h.snapshot_id] === 'new'} onChange={() => setPublishLink((s) => ({ ...s, [h.snapshot_id]: 'new' }))} />
                      No — this is a separate holding
                    </label>
                  </fieldset>
                )}
              </li>
            ))}
          </ul>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => void handlePublish()}
              disabled={
                busy ||
                !publishHoldings.some((h) => publishInclude[h.snapshot_id]) ||
                publishHoldings.some((h) => publishInclude[h.snapshot_id] && h.duplicate_candidates.length > 0 && !publishLink[h.snapshot_id])
              }
              className="rounded bg-trust px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              Add to Net Worth
            </button>
            <button type="button" onClick={onClose} className="rounded border border-gray-300 px-3 py-1 text-sm">Not now</button>
          </div>
        </div>
      )}

      {phase === 'published' && publishResults && (
        <div className="mt-4 space-y-3">
          <p className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">
            {publishResults.filter((r) => r.ok).length} holding(s) added to your Investments and Net Worth, labelled &quot;Imported via Investment Intelligence&quot;.
          </p>
          {publishResults.some((r) => !r.ok) && (
            <ul className="list-disc pl-5 text-sm text-amber-900">
              {publishResults
                .filter((r) => !r.ok)
                .map((r) => (
                  <li key={r.snapshot_id}>
                    {publishHoldings.find((h) => h.snapshot_id === r.snapshot_id)?.name ?? 'Holding'}: {r.reason ?? 'Not added.'}
                  </li>
                ))}
            </ul>
          )}
          <button type="button" onClick={onClose} className="rounded border border-gray-300 px-3 py-1 text-sm">Done</button>
        </div>
      )}
    </div>
  );
}


/**
 * WP-12 (INV-G3): the per-line way out of "no match". A first-time AU user has
 * no ASX identifiers on file, so every line used to stay unresolved and the
 * statement could never be approved. The user either picks one of the
 * candidates an ambiguous match found, or creates the security (Investment
 * Intelligence's own provisional-instrument path, spec section 42).
 */
function SecurityResolver(props: {
  rowId: string;
  table: string;
  label: string;
  candidates: { instrumentId: string; name: string }[];
  instrumentClass: 'equity' | 'etf' | 'mutual_fund';
  busy: boolean;
  onClass: (c: 'equity' | 'etf' | 'mutual_fund') => void;
  onCreate: () => void;
  onPick: (instrumentId: string) => void;
}) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 pl-2 text-xs">
      {props.candidates.length > 0 && (
        <label className="flex items-center gap-1">
          <span className="text-muted">Which security is it?</span>
          <select className="rounded border border-gray-300 px-2 py-1" defaultValue="" onChange={(e) => e.target.value && props.onPick(e.target.value)} disabled={props.busy}>
            <option value="" disabled>
              Choose…
            </option>
            {props.candidates.map((c) => (
              <option key={c.instrumentId} value={c.instrumentId}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="flex items-center gap-1">
        <span className="sr-only">Type of security for {props.label}</span>
        <select className="rounded border border-gray-300 px-2 py-1" value={props.instrumentClass} onChange={(e) => props.onClass(e.target.value as 'equity' | 'etf' | 'mutual_fund')} disabled={props.busy}>
          <option value="equity">Share</option>
          <option value="etf">ETF</option>
          <option value="mutual_fund">Managed fund</option>
        </select>
      </label>
      <button type="button" onClick={props.onCreate} disabled={props.busy} className="rounded border border-trust px-2 py-1 text-trust disabled:opacity-50">
        Create security<span className="sr-only"> for {props.label}</span>
      </button>
    </div>
  );
}
