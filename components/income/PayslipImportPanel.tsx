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

import { useCallback, useState } from 'react';

type Phase =
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
}

interface ProposedField {
  fieldName: string;
  valueKind: string;
  proposedValue: string | null;
  existingValue: string | null;
  isRecommended: boolean;
  requiresConfirmation: boolean;
  reasonCode: string;
}

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

  const reset = useCallback(() => {
    setPhase('form');
    setFile(null);
    setDocumentId(null);
    setMessage(null);
    setEvent(null);
    setProposalId(null);
    setFields([]);
    setSelected(new Set());
  }, []);

  async function loadReview(docId: string) {
    const res = await fetch(`/api/financial-data-hub/payslip/${docId}`);
    const { ok, json } = await readJson(res);
    if (!ok) {
      setMessage(json.error ?? 'We could not load this payslip.');
      setPhase('error');
      return;
    }
    setEvent(json.data.payroll_event as PayrollEvent);
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

      setPhase('processing');
      const processRes = await fetch(`/api/financial-data-hub/payslip/${docId}/process`, { method: 'POST' });
      const { ok: processOk, json: processJson } = await readJson(processRes);
      if (!processOk) {
        setMessage(processJson.error ?? 'We could not process this payslip.');
        setPhase('unable_to_read');
        return;
      }
      if (processJson.data.error_code) {
        setMessage(processJson.data.error_message ?? 'We could not read this payslip.');
        setPhase('unable_to_read');
        return;
      }
      if (processJson.data.duplicate) {
        setMessage('This payslip has already been uploaded. Showing the evidence already on file.');
        await loadReview(docId);
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

  async function handleApprove() {
    if (!documentId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/financial-data-hub/payslip/${documentId}/approve`, { method: 'POST' });
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

  async function handleGenerateProposal() {
    if (!documentId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/financial-data-hub/payslip/${documentId}/proposal`, { method: 'POST' });
      const { ok, json } = await readJson(res);
      if (!ok) throw new Error(json.error ?? 'We could not prepare an income comparison for this payslip.');
      setProposalId(json.data.proposal_id as string);
      const pfields = (json.data.fields as ProposedField[]) ?? [];
      setFields(pfields);
      const defaultSel = new Set(
        pfields.filter((f) => f.isRecommended && !f.requiresConfirmation && f.proposedValue !== f.existingValue).map((f) => f.fieldName),
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
      const res = await fetch(`/api/financial-data-hub/income-proposals/${proposalId}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision,
          selectedFields: decision === 'apply_selected_fields' ? Array.from(selected) : undefined,
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
          setMessage('This proposal has already been applied to your income.');
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

      {phase === 'form' && (
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
            disabled={!file || busy}
            className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            Upload payslip
          </button>
        </div>
      )}

      {(phase === 'uploading' || phase === 'processing') && (
        <p className="mt-4 text-sm text-muted" role="status">
          {phase === 'uploading' ? 'Uploading your payslip…' : 'Processing your payslip — extracting payroll information…'}
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
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted">Employer</dt>
            <dd>{event.employer_name ?? 'Not identified'}</dd>
            <dt className="text-muted">Pay period</dt>
            <dd>
              {event.pay_period_start && event.pay_period_end ? `${event.pay_period_start} – ${event.pay_period_end}` : 'Not identified'}
            </dd>
            <dt className="text-muted">Gross pay</dt>
            <dd>{money(event.gross_pay, event.currency_code)}</dd>
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

          {event.approval_status === 'approved' ? (
            <p className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">This payroll evidence has been approved.</p>
          ) : (
            <div className="flex gap-3">
              <button type="button" onClick={() => loadReview(documentId!)} className="rounded border border-gray-300 px-3 py-1 text-sm">
                Review / Correct
              </button>
              <button
                type="button"
                onClick={handleApprove}
                disabled={busy}
                className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50"
              >
                Approve
              </button>
            </div>
          )}
          {event.approval_status === 'approved' && !proposalId && (
            <button
              type="button"
              onClick={handleGenerateProposal}
              disabled={busy}
              className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              Continue to income comparison
            </button>
          )}
        </div>
      )}

      {(phase === 'comparing' || phase === 'stale') && (
        <div className="mt-4 space-y-4">
          <h3 className="font-semibold">Current income vs payslip proposal</h3>
          {phase === 'stale' && message && <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">{message}</p>}
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
              onClick={handleGenerateProposal}
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
