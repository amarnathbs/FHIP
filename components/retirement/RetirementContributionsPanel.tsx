'use client';

import { useCallback, useEffect, useState } from 'react';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { DateInput } from '@/components/ui/DateInput';
import { DataTable } from '@/components/ui/DataTable';
import { formatDateShort } from '@/lib/engines/date';
import { formatMoney } from '@/lib/engines/money';
import { NUM_CELL_CLASS, NUM_HEADER_CLASS } from '@/lib/ui/tableAlign';
import { CONTRIBUTION_TYPES, CONTRIBUTION_TYPE_LABEL, type ContributionFrequency, type ContributionType } from '@/lib/retirement-contributions/types';

// Document2 (4) F25b (20-10-2026): manual retirement BALANCE entry and manual CONTRIBUTION entry are separate actions. The balance is
// the account form below; this panel is the contribution action and the contribution history (manual entries and payslip super, with
// where each came from). Nothing here can change a balance.

type Currency = 'AUD' | 'INR';
interface Destination { accountId: string; kind: 'retirement_account' | 'smsf'; name: string; currency: string }
export interface HistoryItemView {
  id: string;
  kind: 'ledger' | 'account_figure';
  typeLabelKey: ContributionType;
  amount: number;
  currency: string;
  frequency: ContributionFrequency | null;
  contributionDate: string | null;
  accountName: string | null;
  destinationKind: 'smsf' | 'retirement_account' | null;
  memberType: 'self' | 'spouse' | null;
  source: 'manual' | 'payslip' | 'account';
  employerName: string | null;
  status: string;
  notCountedBecause: string | null;
  monthlyEquivalent: number | null;
}
interface Payload { items: HistoryItemView[]; waiting: HistoryItemView[]; destinations: Destination[] }

const FREQUENCY_LABEL: Record<ContributionFrequency, string> = {
  weekly: 'every week', fortnightly: 'every fortnight', monthly: 'every month', quarterly: 'every quarter', annually: 'every year', one_off: 'one-off',
};

function currencyOf(code: string): Currency {
  return code === 'INR' ? 'INR' : 'AUD';
}

export function sourceText(item: Pick<HistoryItemView, 'source' | 'employerName'>): string {
  if (item.source === 'payslip') return item.employerName ? `From your payslip (${item.employerName})` : 'From your payslip';
  if (item.source === 'account') return 'Recorded on the account';
  return 'Entered by you';
}

export function amountText(item: Pick<HistoryItemView, 'amount' | 'currency' | 'frequency'>): string {
  const money = formatMoney(item.amount, currencyOf(item.currency));
  return item.frequency && item.frequency !== 'one_off' ? `${money} ${FREQUENCY_LABEL[item.frequency]}` : money;
}

export function RetirementContributionsView({
  data,
  onChoose,
  onRemove,
  chooseBusy,
  chooseError,
  form,
}: {
  data: Payload;
  onChoose?: (contributionId: string, accountId: string) => void;
  onRemove?: (id: string) => void;
  chooseBusy?: string | null;
  chooseError?: string | null;
  form?: React.ReactNode;
}) {
  const [picked, setPicked] = useState<Record<string, string>>({});
  return (
    <SectionCard
      title="Contributions"
      description="A contribution is money paid into a retirement account over time. It is recorded here, separately from the account balance, so adding one never changes a balance."
      className="mb-6"
    >
      {data.waiting.length > 0 && (
        <div className="mb-4 space-y-3" data-testid="waiting-contributions">
          {data.waiting.map((w) => {
            const options = data.destinations.filter((d) => d.currency === w.currency);
            return (
              <div key={w.id} className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
                <p className="font-medium">
                  Super from your payslip needs a destination: {amountText(w)}{w.contributionDate ? ` on ${formatDateShort(w.contributionDate, currencyOf(w.currency))}` : ''}.
                </p>
                <p className="mt-1">
                  FHIP could not tell from the payslip which of your accounts this goes to, so it has not guessed and has not counted it yet. Choose where it goes.
                </p>
                {options.length === 0 ? (
                  <p className="mt-2">You have no {w.currency} retirement account or SMSF yet. Add the account in the list below, then choose it here.</p>
                ) : (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <label htmlFor={`dest-${w.id}`} className="sr-only">Destination for this contribution</label>
                    <select
                      id={`dest-${w.id}`}
                      value={picked[w.id] ?? ''}
                      onChange={(e) => setPicked((p) => ({ ...p, [w.id]: e.target.value }))}
                      className="rounded border px-3 py-1.5 text-sm"
                    >
                      <option value="">Choose an account…</option>
                      {options.map((d) => (
                        <option key={d.accountId} value={d.accountId}>{d.kind === 'smsf' ? `${d.name} (SMSF)` : d.name}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={!picked[w.id] || chooseBusy === w.id}
                      onClick={() => onChoose?.(w.id, picked[w.id])}
                      className="rounded bg-trust px-3 py-1.5 text-sm text-white disabled:opacity-60"
                    >
                      {chooseBusy === w.id ? 'Saving…' : 'Use this account'}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          {chooseError && <p className="text-sm text-risk" role="alert">{chooseError}</p>}
        </div>
      )}

      {form}

      <div className="mt-4">
        {data.items.length === 0 ? (
          <p className="text-sm text-muted">No contributions recorded yet. Add one above, or approve a payslip that shows employer super.</p>
        ) : (
          <DataTable label="Contribution history" className="w-full min-w-[640px]">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-muted">
                <th className="pb-2 pr-3 font-medium">Date</th>
                <th className="pb-2 pr-3 font-medium">Type</th>
                <th className="pb-2 pr-3 font-medium">Person</th>
                <th className="pb-2 pr-3 font-medium">Goes to</th>
                <th className={`pb-2 pr-3 font-medium ${NUM_HEADER_CLASS}`}>Amount</th>
                <th className="pb-2 pr-3 font-medium">Source</th>
                <th className="pb-2 font-medium">Counted</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((i) => (
                <tr key={i.id} className="border-t border-line align-top">
                  <td className="py-2 pr-3">{i.contributionDate ? formatDateShort(i.contributionDate, currencyOf(i.currency)) : '—'}</td>
                  <td className="py-2 pr-3">{CONTRIBUTION_TYPE_LABEL[i.typeLabelKey]}</td>
                  <td className="py-2 pr-3">{i.memberType === 'spouse' ? 'Spouse/Partner' : i.memberType === 'self' ? 'Self' : '—'}</td>
                  <td className="py-2 pr-3">{i.accountName ? `${i.accountName}${i.destinationKind === 'smsf' ? ' (SMSF)' : ''}` : 'Waiting for you to choose'}</td>
                  <td className={`py-2 pr-3 ${NUM_CELL_CLASS}`}>
                    {amountText(i)}
                    {i.monthlyEquivalent !== null && i.notCountedBecause === null && i.frequency !== 'monthly' && (
                      <span className="block text-xs text-muted">{`about ${formatMoney(i.monthlyEquivalent, currencyOf(i.currency))} a month`}</span>
                    )}
                  </td>
                  <td className="py-2 pr-3">{sourceText(i)}</td>
                  <td className="py-2">
                    {i.notCountedBecause ?? (i.monthlyEquivalent !== null ? 'Yes, counted' : 'History only')}
                    {i.kind === 'ledger' && onRemove && (
                      <button type="button" onClick={() => onRemove(i.id)} className="ml-3 text-xs text-risk underline">Remove</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </div>
    </SectionCard>
  );
}

export function RetirementContributionsPanel({ refreshKey = 0, onChanged }: { refreshKey?: number; onChanged?: () => void }) {
  const [data, setData] = useState<Payload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chooseBusy, setChooseBusy] = useState<string | null>(null);
  const [chooseError, setChooseError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [type, setType] = useState<ContributionType>('personal');
  const [amount, setAmount] = useState('');
  const [frequency, setFrequency] = useState<ContributionFrequency | ''>('monthly');
  const [date, setDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const fetchPayload = useCallback(async (): Promise<Payload> => {
    const res = await fetch('/api/retirement/contributions');
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? 'Could not load contributions');
    return json.data as Payload;
  }, []);
  // Re-read after a change the person made (choose, remove, save, retry).
  const load = useCallback(async () => {
    try {
      setData(await fetchPayload());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Something went wrong');
    }
  }, [fetchPayload]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await fetchPayload();
        if (!cancelled) { setData(d); setLoadError(null); }
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Something went wrong');
      }
    })();
    return () => { cancelled = true; };
  }, [fetchPayload, refreshKey]);

  async function choose(id: string, account: string) {
    setChooseBusy(id);
    setChooseError(null);
    try {
      const res = await fetch(`/api/retirement/contributions/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ retirement_account_id: account }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not save that choice');
      await load();
      onChanged?.();
    } catch (e) {
      setChooseError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setChooseBusy(null);
    }
  }

  async function remove(id: string) {
    await fetch(`/api/retirement/contributions/${id}`, { method: 'DELETE' });
    await load();
    onChanged?.();
  }

  async function save() {
    setFormError(null);
    setMessage(null);
    const n = Number(amount);
    if (!accountId) return setFormError('Choose the account the contribution goes to.');
    if (!(n > 0)) return setFormError('Enter an amount greater than zero.');
    if (frequency === '' && !date) return setFormError('Choose how often it is paid, or enter the date it was paid.');
    if (frequency === 'one_off' && !date) return setFormError('A one-off contribution needs the date it was paid.');
    setSaving(true);
    try {
      const res = await fetch('/api/retirement/contributions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retirement_account_id: accountId, contribution_type: type, amount: n, frequency: frequency === '' ? null : frequency, contribution_date: date || null }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not save the contribution');
      setMessage('Contribution saved. Your account balance was not changed.');
      setAmount('');
      setDate('');
      setOpen(false);
      await load();
      onChanged?.();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <SectionCard title="Contributions" description="Money paid into your retirement accounts over time." className="mb-6">
        <p className="text-sm text-risk">{loadError}</p>
        <button type="button" onClick={() => void load()} className="mt-2 rounded border px-3 py-1 text-sm">Try again</button>
      </SectionCard>
    );
  }
  if (!data) return <SectionCard title="Contributions" description="Loading your contributions…" className="mb-6"><div /></SectionCard>;

  const selected = data.destinations.find((d) => d.accountId === accountId);
  const form = (
    <div>
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90">
          + Add contribution
        </button>
      ) : (
        <div className="rounded-card border border-line bg-white p-4" data-testid="add-contribution-form">
          <h3 className="text-sm font-semibold text-ink">Add a contribution</h3>
          <p className="mt-1 text-xs text-muted">This records money paid in. To change what an account is worth, use the account list below.</p>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="contrib-account" className="block text-xs text-muted">Goes to</label>
              <select id="contrib-account" value={accountId} onChange={(e) => setAccountId(e.target.value)} className="mt-1 w-full rounded border px-3 py-2 text-sm">
                <option value="">Choose an account…</option>
                {data.destinations.map((d) => (<option key={d.accountId} value={d.accountId}>{d.kind === 'smsf' ? `${d.name} (SMSF)` : d.name}</option>))}
              </select>
              {data.destinations.length === 0 && <p className="mt-1 text-xs text-muted">Add a retirement account in the list below first.</p>}
            </div>
            <div>
              <label htmlFor="contrib-type" className="block text-xs text-muted">Type</label>
              <select id="contrib-type" value={type} onChange={(e) => setType(e.target.value as ContributionType)} className="mt-1 w-full rounded border px-3 py-2 text-sm">
                {CONTRIBUTION_TYPES.map((t) => (<option key={t} value={t}>{CONTRIBUTION_TYPE_LABEL[t]}</option>))}
              </select>
            </div>
            <div>
              <label htmlFor="contrib-amount" className="block text-xs text-muted">Amount{selected ? ` (${selected.currency})` : ''}</label>
              <input id="contrib-amount" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1 w-full rounded border px-3 py-2 text-sm" />
            </div>
            <div>
              <label htmlFor="contrib-frequency" className="block text-xs text-muted">How often</label>
              <select id="contrib-frequency" value={frequency} onChange={(e) => setFrequency(e.target.value as ContributionFrequency | '')} className="mt-1 w-full rounded border px-3 py-2 text-sm">
                <option value="">Not regular (give the date below)</option>
                {(Object.keys(FREQUENCY_LABEL) as ContributionFrequency[]).map((f) => (<option key={f} value={f}>{f === 'one_off' ? 'One-off' : FREQUENCY_LABEL[f]}</option>))}
              </select>
            </div>
            <div>
              <label htmlFor="contrib-date" className="block text-xs text-muted">{frequency === '' || frequency === 'one_off' ? 'Date paid' : 'Date paid or started (optional)'}</label>
              <DateInput id="contrib-date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 w-full rounded border px-3 py-2 text-sm" />
            </div>
          </div>
          {formError && <p className="mt-2 text-sm text-risk" role="alert">{formError}</p>}
          <div className="mt-3 flex items-center gap-3">
            <button type="button" onClick={save} disabled={saving} className="rounded bg-trust px-4 py-1.5 text-sm text-white disabled:opacity-60">{saving ? 'Saving…' : 'Save contribution'}</button>
            <button type="button" onClick={() => setOpen(false)} className="text-sm text-muted underline">Cancel</button>
          </div>
        </div>
      )}
      {message && <p className="mt-2 text-sm text-progress">{message}</p>}
    </div>
  );

  return <RetirementContributionsView data={data} onChoose={choose} onRemove={remove} chooseBusy={chooseBusy} chooseError={chooseError} form={form} />;
}
