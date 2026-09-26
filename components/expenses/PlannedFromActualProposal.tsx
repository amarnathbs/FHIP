'use client';

/**
 * WP-15 (a) -- "Update your planned expenses from your actual spending".
 *
 * Preview (GET, no writes) -> the user opens the review, which persists inert
 * proposals (POST generate) -> ticks items -> Apply selected (POST apply, one
 * all-or-nothing batch). Planned expenses change ONLY here, only for ticked
 * items (PO D-02). Items that already match are listed, never re-written;
 * spending that matches no single planned item is listed, never guessed.
 */
import { useEffect, useState } from 'react';
import { formatMoneyWhole } from '@/lib/engines/money';
import type { PlannedFromActualsDto, PlannedFromActualsResponse } from '@/lib/import-bridge/populationProposalDto';

const money = (v: number, c: string) => formatMoneyWhole(v, c === 'INR' ? 'INR' : 'AUD');

async function call<T>(init?: RequestInit): Promise<T> {
  const res = await fetch('/api/expenses/planned-from-actuals', init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? 'Request failed');
  return json.data as T;
}

export function PlannedFromActualProposal({ onApplied, disabled = false }: { onApplied: () => void; disabled?: boolean }) {
  const [preview, setPreview] = useState<PlannedFromActualsResponse | null>(null);
  const [review, setReview] = useState<PlannedFromActualsDto | null>(null);
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    call<PlannedFromActualsResponse>().then((d) => { if (!cancelled) setPreview(d); }).catch(() => { if (!cancelled) setPreview({ status: 'unavailable', reason: 'request_failed' }); });
    return () => { cancelled = true; };
  }, []);

  if (!preview || preview.status !== 'ok') return null;
  const changeable = preview.items.filter((i) => i.recommended !== 'keep_existing');
  if (preview.items.length === 0 && preview.unmatched.length === 0) return null;

  async function openReview() {
    setBusy(true);
    setMessage(null);
    try {
      const d = await call<PlannedFromActualsResponse>({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'generate' }) });
      if (d.status !== 'ok') throw new Error('Your actual spending is unavailable right now.');
      setReview(d);
      setTicked(Object.fromEntries(d.items.filter((i) => i.proposalId).map((i) => [i.masterItemKey, true])));
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : 'Could not prepare the suggestions.' });
    } finally {
      setBusy(false);
    }
  }

  async function applySelected() {
    if (!review) return;
    const decisions = review.items
      .filter((i) => i.proposalId && ticked[i.masterItemKey])
      .map((i) => ({ proposalId: i.proposalId as string, decision: i.recommended === 'add_new' ? 'add_new' : 'update_existing' }));
    if (decisions.length === 0) {
      setMessage({ kind: 'error', text: 'Tick at least one item to update.' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await call({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'apply', decisions }) });
      setMessage({ kind: 'ok', text: `Updated ${decisions.length} planned expense${decisions.length === 1 ? '' : 's'} from your actual spending.` });
      setReview(null);
      setPreview(await call<PlannedFromActualsResponse>());
      onApplied();
    } catch (e) {
      setMessage({ kind: 'error', text: `${e instanceof Error ? e.message : 'Nothing was changed.'} Nothing was changed.` });
    } finally {
      setBusy(false);
    }
  }

  const cur = preview.reportingCurrency;
  return (
    <section className="space-y-3 rounded-card border border-line bg-white p-4" aria-labelledby="planned-from-actual-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="planned-from-actual-heading" className="text-base font-semibold text-ink">Update your planned expenses from your actual spending</h2>
          <p className="mt-1 text-sm text-muted">
            {changeable.length > 0
              ? `${changeable.length} planned item${changeable.length === 1 ? '' : 's'} differ${changeable.length === 1 ? 's' : ''} from your average actual spending over the last ${preview.window.coveredMonths.length} complete month${preview.window.coveredMonths.length === 1 ? '' : 's'}. Nothing changes unless you apply it.`
              : 'Your planned expenses already match your average actual spending.'}
          </p>
        </div>
        {!review && changeable.length > 0 && (
          <button type="button" onClick={() => void openReview()} disabled={busy || disabled} className="rounded-full border border-trust px-4 py-1.5 text-sm font-medium text-trust hover:bg-trust/5 disabled:opacity-50">
            {busy ? 'Preparing…' : 'Review suggestions'}
          </button>
        )}
      </div>

      {message && <p className={`text-sm ${message.kind === 'ok' ? 'text-trust' : 'text-risk'}`} role="status">{message.text}</p>}

      {review && (
        <div className="space-y-3">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="planned-from-actual-review">
              <thead className="border-b bg-gray-50 text-left text-xs uppercase text-muted">
                <tr>
                  <th className="px-3 py-2"></th>
                  <th className="px-3 py-2">Planned item</th>
                  <th className="px-3 py-2 text-right">Your plan / month</th>
                  <th className="px-3 py-2 text-right">Actual average / month</th>
                  <th className="px-3 py-2">Suggestion</th>
                </tr>
              </thead>
              <tbody>
                {review.items.map((i) => (
                  <tr key={i.masterItemKey} className="border-b last:border-0">
                    <td className="px-3 py-2">
                      {i.proposalId ? (
                        <input type="checkbox" aria-label={`Update ${i.label}`} checked={Boolean(ticked[i.masterItemKey])} onChange={(e) => setTicked((t) => ({ ...t, [i.masterItemKey]: e.target.checked }))} />
                      ) : null}
                    </td>
                    <td className="px-3 py-2">{i.label} <span className="text-xs text-muted">({i.groupLabel})</span></td>
                    <td className="px-3 py-2 text-right">{i.existing ? (i.existing.monthlyReporting === null ? `${i.existing.currency} ${i.existing.amount}` : money(i.existing.monthlyReporting, cur)) : '—'}</td>
                    <td className="px-3 py-2 text-right">{money(i.actualMonthly, cur)}</td>
                    <td className="px-3 py-2 text-xs">
                      {i.recommended === 'add_new' ? 'Add to your plan' : i.recommended === 'update_existing' ? 'Update your plan' : 'Already matches — keep'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => void applySelected()} disabled={busy || disabled} className="rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">
              {busy ? 'Applying…' : 'Apply selected'}
            </button>
            <button type="button" onClick={() => setReview(null)} className="text-sm text-muted hover:underline">Cancel</button>
          </div>
        </div>
      )}

      {(review ?? preview).unmatched.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted">Spending not matched to a single planned item ({(review ?? preview).unmatched.length})</summary>
          <ul className="mt-2 space-y-1">
            {(review ?? preview).unmatched.map((u) => (
              <li key={u.key} className="flex justify-between gap-3">
                <span>{u.label} <span className="text-xs text-muted">— {u.reason}</span></span>
                <span className="text-muted">{money(u.actualMonthly, cur)} / month</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-muted">These still count in your actual spending above; add a custom planned item if you want to budget for them.</p>
        </details>
      )}
    </section>
  );
}
