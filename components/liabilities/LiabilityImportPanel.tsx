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

import { useCallback, useState } from 'react';

type StatementType = 'credit_card' | 'loan';
type Phase =
  | 'type_select'
  | 'form'
  | 'uploading'
  | 'processing'
  | 'unable_to_read'
  | 'duplicate'
  | 'review'
  | 'comparing'
  | 'applied'
  | 'kept_existing'
  | 'stale'
  | 'error';

type Decision = 'add_new' | 'update_existing' | 'apply_selected_fields' | 'keep_existing';

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
  return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);
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
      if (!json.data.statement_id) {
        setMessage(json.data.error_message ?? 'We could not read this statement.');
        setPhase('unable_to_read');
        return;
      }
      setDocumentId(json.data.document_id as string);
      if (json.data.duplicate) {
        setMessage('This statement has already been uploaded. Showing the evidence already on file.');
        await loadReview(json.data.document_id as string);
        setPhase((p) => (p === 'error' ? p : 'duplicate'));
        return;
      }
      await loadReview(json.data.document_id as string);
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

      {phase === 'type_select' && (
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
              disabled={!file || busy}
              className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              Upload statement
            </button>
          </div>
        </div>
      )}

      {(phase === 'uploading' || phase === 'processing') && (
        <p className="mt-4 text-sm text-muted" role="status">
          {phase === 'uploading' ? 'Uploading your statement…' : 'Processing your statement — extracting activity…'}
        </p>
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
            <div className="flex gap-3">
              <button type="button" onClick={() => loadReview(documentId!)} className="rounded border border-gray-300 px-3 py-1 text-sm">
                Review / Correct
              </button>
              <button type="button" onClick={handleApprove} disabled={busy} className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50">
                Approve
              </button>
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
