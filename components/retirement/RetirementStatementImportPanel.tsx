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

import { useCallback, useMemo, useState } from 'react';

type Phase =
  | 'form'
  | 'uploading'
  | 'unable_to_read'
  | 'duplicate'
  | 'routed_to_smsf'
  | 'review'
  | 'comparing'
  | 'applied'
  | 'kept_existing'
  | 'stale'
  | 'error';

type Decision = 'add_new' | 'update_existing' | 'apply_selected_fields' | 'keep_existing';

interface Statement {
  id: string;
  statement_type: string;
  retirement_jurisdiction: string;
  account_type: string;
  fund_name: string | null;
  masked_account_identifier: string | null;
  currency_code: string;
  statement_date: string | null;
  statement_start_date: string | null;
  statement_end_date: string | null;
  opening_balance: string | null;
  closing_balance: string | null;
  employer_contributions: string | null;
  personal_contributions: string | null;
  investment_earnings: string | null;
  fees: string | null;
  insurance_premiums: string | null;
  tax: string | null;
  extraction_status: string;
  reconciliation_status: string;
  reconciliation_variance: string | null;
  account_match_status: string;
  canonical_account_id: string | null;
  retirement_member_id: string | null;
  smsf_classification: string;
  approval_status: string;
  review_status: string;
}

interface Activity {
  id: string;
  activity_type: string;
  activity_date: string | null;
  amount: string;
  currency_code: string;
  description_raw: string | null;
  is_summary_total: boolean;
  is_year_to_date: boolean;
  payslip_match_status: string;
  payslip_match_variance: string | null;
  bank_match_status: string;
  rollover_match_status: string;
  duplicate_of_activity_id: string | null;
}

interface Position {
  id: string;
  option_name_raw: string;
  asset_class_raw: string | null;
  market_value: string | null;
  currency_code: string;
}

interface Member { id: string; member_type: 'self' | 'spouse'; target_retirement_age: number | null }
interface AccountOption { id: string; account_name: string; account_type: string | null; currency_code: string; owner: string }

interface ProposalField {
  field_name: string;
  value_kind: string;
  proposed_value: string | null;
  existing_value: string | null;
  is_recommended: boolean;
  requires_confirmation: boolean;
  reason_code: string;
}

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

/** Plain-language labels. Note ROLLOVER is labelled a TRANSFER, never income
 * (spec section 149) — a user must understand the money moved between
 * retirement accounts rather than arriving as new money. */
const ACTIVITY_LABELS: Record<string, string> = {
  EMPLOYER_CONTRIBUTION: 'Employer contribution',
  PERSONAL_CONTRIBUTION: 'Personal contribution',
  SALARY_SACRIFICE: 'Salary sacrifice',
  GOVERNMENT_CONTRIBUTION: 'Government contribution',
  ROLLOVER_IN: 'Transfer in (rollover)',
  ROLLOVER_OUT: 'Transfer out (rollover)',
  INVESTMENT_EARNINGS: 'Investment earnings',
  INTEREST: 'Interest',
  DISTRIBUTION: 'Distribution',
  FEE: 'Fee',
  INSURANCE_PREMIUM: 'Insurance premium',
  TAX: 'Tax',
  PENSION_PAYMENT: 'Pension payment',
  WITHDRAWAL: 'Withdrawal',
  ADJUSTMENT: 'Adjustment',
  OTHER: 'Other',
  UNKNOWN: 'Not recognised',
};

/** Explains WHERE the money went, so an internal movement is never mistaken
 * for household cash (spec sections 39-42, 148). */
const ACTIVITY_NOTES: Record<string, string> = {
  EMPLOYER_CONTRIBUTION: 'Paid by your employer into the fund — not household spending or extra take-home pay.',
  SALARY_SACRIFICE: 'Deducted from pay before tax — not household spending.',
  GOVERNMENT_CONTRIBUTION: 'Paid by the government into the fund — not salary.',
  PERSONAL_CONTRIBUTION: 'A transfer from your bank into retirement — not household spending.',
  ROLLOVER_IN: 'Moved in from another retirement account — not new money.',
  ROLLOVER_OUT: 'Moved out to another retirement account — not spending.',
  INVESTMENT_EARNINGS: 'Earned and kept inside the fund — no money reached your bank account.',
  INTEREST: 'Credited inside the fund — no money reached your bank account.',
  DISTRIBUTION: 'Credited inside the fund — no money reached your bank account.',
  FEE: 'Deducted from your retirement balance — not a separate household bill.',
  INSURANCE_PREMIUM: 'Paid from your retirement balance — not a separate household bill.',
  TAX: 'Deducted from your retirement balance by the fund.',
};

const RECONCILIATION_LABEL: Record<string, string> = {
  reconciled: 'The figures on this statement add up.',
  variance: 'The figures on this statement do not add up. Check them before applying.',
  insufficient_data: 'This statement does not show enough detail to check the figures.',
};

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try { return (await res.json()) as Record<string, unknown>; } catch { return {}; }
}

function money(value: string | null | undefined, currency: string): string {
  // NEVER renders "$0" for an absent value (spec section 94). "Not shown on
  // statement" is a different fact from zero, and conflating them is the
  // specific failure the spec names.
  if (value === null || value === undefined || value === '') return 'Not shown on statement';
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toLocaleString(undefined, { style: 'currency', currency, minimumFractionDigits: 2 });
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
  const [statement, setStatement] = useState<Statement | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [currentVsStatement, setCurrentVsStatement] = useState<CurrentVsStatement | null>(null);

  const [chosenMemberId, setChosenMemberId] = useState<string>('');
  const [chosenAccountId, setChosenAccountId] = useState<string>('');

  const [proposalId, setProposalId] = useState<string | null>(null);
  const [fields, setFields] = useState<ProposalField[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [decision, setDecision] = useState<Decision>('update_existing');

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
    setStatement(body.statement as Statement);
    setActivities((body.activities as Activity[]) ?? []);
    setPositions((body.positions as Position[]) ?? []);
    setMembers((body.members as Member[]) ?? []);
    setAccounts((body.accounts as AccountOption[]) ?? []);
    setCurrentVsStatement((body.current_vs_statement as CurrentVsStatement | null) ?? null);
    setPhase('review');
  }, []);

  const handleUpload = useCallback(async () => {
    if (!file) { setMessage('Choose a statement file first.'); return; }
    setBusy(true); setMessage(null); setPhase('uploading');
    try {
      const qs = new URLSearchParams({ jurisdiction, currency_code: jurisdiction === 'IN' ? 'INR' : 'AUD' });
      if (fundName.trim()) qs.set('fund_name', fundName.trim());
      if (maskedIdentifier.trim()) qs.set('masked_account_identifier', maskedIdentifier.trim());
      if (periodStart) qs.set('statement_period_start', periodStart);
      if (periodEnd) qs.set('statement_period_end', periodEnd);

      const res = await fetch(`/api/financial-data-hub/retirement-statement/upload?${qs.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv' },
        body: await file.arrayBuffer(),
      });
      const body = await readJson(res);
      if (!res.ok) { setPhase('error'); setMessage(String(body.error ?? 'Could not read this statement.')); return; }

      const docId = String(body.document_id);
      setDocumentId(docId);

      if (body.pipeline_status === 'routed_to_smsf') {
        setPhase('routed_to_smsf');
        setMessage(String(body.failure_message ?? ''));
        return;
      }
      if (body.pipeline_status === 'extraction_failed') {
        setPhase('unable_to_read');
        setMessage(String(body.failure_message ?? 'We could not read this statement.'));
        return;
      }
      if (body.pipeline_status === 'duplicate_statement') {
        setPhase('duplicate');
        setMessage('You have already imported this exact statement, so nothing was added again.');
        await loadReview(docId);
        setPhase('duplicate');
        return;
      }
      await loadReview(docId);
    } finally { setBusy(false); }
  }, [file, jurisdiction, fundName, maskedIdentifier, periodStart, periodEnd, loadReview]);

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

  const handleGenerateProposal = useCallback(async () => {
    if (!documentId) return;
    setBusy(true); setMessage(null);
    try {
      const res = await fetch(`/api/financial-data-hub/retirement-statement/${documentId}/proposal`, { method: 'POST' });
      const body = await readJson(res);
      if (!res.ok) { setMessage(String(body.error ?? 'Could not prepare the comparison.')); return; }
      setProposalId(String(body.proposal_id));
      const nextFields = (body.fields as ProposalField[]) ?? [];
      setFields(nextFields);
      // Only RECOMMENDED fields are ticked by default. Contribution rates
      // require explicit confirmation and so start unticked (spec section 109).
      setSelected(new Set(nextFields.filter((f) => f.is_recommended && !f.requires_confirmation).map((f) => f.field_name)));
      setDecision(body.recommended_apply_mode === 'add_new' ? 'add_new' : 'update_existing');
      setPhase('comparing');
    } finally { setBusy(false); }
  }, [documentId]);

  const toggleField = useCallback((name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }, []);

  const handleApply = useCallback(async () => {
    if (!documentId || !proposalId) return;
    setBusy(true); setMessage(null);
    try {
      const res = await fetch(`/api/financial-data-hub/retirement-statement/${documentId}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proposal_id: proposalId,
          decision,
          // `add_new` and `apply_selected_fields` both need the tick list;
          // `update_existing` means "everything proposed" and sends none.
          // (FDH-10 shipped a live bug here by sending the list only for
          // `apply_selected_fields`, which made `add_new` fail
          // NO_FIELDS_SELECTED. Same shape, fixed from the start.)
          selected_fields: decision === 'update_existing' || decision === 'keep_existing'
            ? undefined
            : [...selected],
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
      onApplied?.();
    } finally { setBusy(false); }
  }, [documentId, proposalId, decision, selected, onApplied, handleGenerateProposal]);

  const reset = useCallback(() => {
    setPhase('form'); setBusy(false); setMessage(null); setFile(null);
    setDocumentId(null); setStatement(null); setActivities([]); setPositions([]);
    setCurrentVsStatement(null); setProposalId(null); setFields([]); setSelected(new Set());
    setChosenAccountId(''); setChosenMemberId('');
  }, []);

  return (
    <section
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

      {message && phase !== 'comparing' && (
        <p className="mt-3 rounded bg-gray-50 px-3 py-2 text-sm">{message}</p>
      )}

      {phase === 'form' && (
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
            type="button" onClick={handleUpload} disabled={busy || !file}
            className="rounded bg-trust px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Upload and read statement
          </button>
        </div>
      )}

      {phase === 'uploading' && <p className="mt-4 text-sm">Reading your statement…</p>}

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

          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div><dt className="text-muted">Fund</dt><dd>{statement.fund_name ?? 'Not identified'}</dd></div>
            <div><dt className="text-muted">Member number</dt><dd>{statement.masked_account_identifier ?? 'Not shown'}</dd></div>
            <div><dt className="text-muted">Period</dt><dd>{statement.statement_start_date ?? '—'} to {statement.statement_end_date ?? '—'}</dd></div>
            <div><dt className="text-muted">Opening balance</dt><dd>{money(statement.opening_balance, currency)}</dd></div>
            <div><dt className="text-muted">Closing balance</dt><dd>{money(statement.closing_balance, currency)}</dd></div>
            <div><dt className="text-muted">Employer contributions</dt><dd>{money(statement.employer_contributions, currency)}</dd></div>
            <div><dt className="text-muted">Personal contributions</dt><dd>{money(statement.personal_contributions, currency)}</dd></div>
            <div><dt className="text-muted">Investment earnings</dt><dd>{money(statement.investment_earnings, currency)}</dd></div>
            <div><dt className="text-muted">Fees</dt><dd>{money(statement.fees, currency)}</dd></div>
            <div><dt className="text-muted">Insurance premiums</dt><dd>{money(statement.insurance_premiums, currency)}</dd></div>
            <div><dt className="text-muted">Tax</dt><dd>{money(statement.tax, currency)}</dd></div>
          </dl>

          {/* Reconciliation status, stated in words as well as by colour
              (spec section 151: non-colour statuses). */}
          <p className="rounded bg-gray-50 px-3 py-2 text-sm">
            <strong>Balance check:</strong>{' '}
            {RECONCILIATION_LABEL[statement.reconciliation_status] ?? statement.reconciliation_status}
            {statement.reconciliation_status === 'variance' && statement.reconciliation_variance
              && ` Difference: ${money(statement.reconciliation_variance, currency)}.`}
          </p>

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

          {/* --- Activity evidence ----------------------------------------- */}
          {activities.length > 0 && (
            <div className="overflow-x-auto">
              <h4 className="mb-2 text-sm font-semibold">Activity on this statement</h4>
              <table className="w-full min-w-[560px] border-collapse text-sm">
                <caption className="sr-only">Retirement activity read from this statement</caption>
                <thead>
                  <tr className="border-b border-gray-200 text-left">
                    <th scope="col" className="py-2 pr-2">Date</th>
                    <th scope="col" className="py-2 pr-2">What happened</th>
                    <th scope="col" className="py-2 pr-2">Amount</th>
                    <th scope="col" className="py-2">Matched payslip</th>
                  </tr>
                </thead>
                <tbody>
                  {activities.map((a) => (
                    <tr key={a.id} className="border-b border-gray-100">
                      <td className="py-2 pr-2">{a.activity_date ?? '—'}</td>
                      <th scope="row" className="py-2 pr-2 text-left font-normal">
                        {ACTIVITY_LABELS[a.activity_type] ?? a.activity_type}
                        {a.is_summary_total && <span className="ml-2 text-xs text-muted">(statement total — not counted separately)</span>}
                        {a.is_year_to_date && <span className="ml-2 text-xs text-muted">(year to date — not counted separately)</span>}
                        {a.duplicate_of_activity_id && <span className="ml-2 text-xs text-muted">(already imported)</span>}
                        {ACTIVITY_NOTES[a.activity_type] && (
                          <span className="block text-xs text-muted">{ACTIVITY_NOTES[a.activity_type]}</span>
                        )}
                      </th>
                      <td className="py-2 pr-2">{money(a.amount, a.currency_code)}</td>
                      <td className="py-2">
                        {/* spec section 148: ONE financial event, annotated —
                            never two. */}
                        {a.payslip_match_status === 'matched' && 'Yes'}
                        {a.payslip_match_status === 'payslip_evidence_not_available' && 'No payslip on file'}
                        {a.payslip_match_status === 'variance_review_required' && `Amounts differ — please check (${money(a.payslip_match_variance, a.currency_code)})`}
                        {a.payslip_match_status === 'multiple_candidates' && 'More than one possible payslip — please choose'}
                        {a.payslip_match_status === 'no_match' && 'No'}
                        {a.payslip_match_status === 'not_attempted' && '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* --- Investment options: EVIDENCE ONLY (spec sections 12-13) ---- */}
          {positions.length > 0 && (
            <div>
              <h4 className="mb-1 text-sm font-semibold">What your super is invested in</h4>
              <p className="mb-2 text-xs text-muted">
                Shown for information only. These are already part of your super balance, so they are
                not added to your investments as well.
              </p>
              <ul className="text-sm">
                {positions.map((p) => (
                  <li key={p.id} className="border-b border-gray-100 py-1">
                    {p.option_name_raw} — {money(p.market_value, p.currency_code)}
                  </li>
                ))}
              </ul>
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
              <button type="button" onClick={handleGenerateProposal} disabled={busy} className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50">
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
                  const changed = f.proposed_value !== f.existing_value;
                  const label = FIELD_LABELS[f.field_name] ?? f.field_name;
                  return (
                    <tr key={f.field_name} className="border-b border-gray-100">
                      <th scope="row" className="py-2 pr-2 text-left font-normal text-muted">{label}</th>
                      <td className="py-2 pr-2">{displayValue(f.existing_value, f.value_kind, currency)}</td>
                      <td className={`py-2 pr-2 ${changed ? 'font-medium' : ''}`}>{displayValue(f.proposed_value, f.value_kind, currency)}</td>
                      <td className="py-2">
                        <label className="inline-flex items-center gap-2">
                          <input
                            type="checkbox" checked={selected.has(f.field_name)}
                            onChange={() => toggleField(f.field_name)}
                            aria-label={`Apply ${label}`}
                          />
                          {f.requires_confirmation && <span className="text-xs text-amber-800">please confirm</span>}
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
            <button type="button" onClick={handleGenerateProposal} disabled={busy} className="rounded border border-gray-300 px-3 py-1 text-sm">
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
