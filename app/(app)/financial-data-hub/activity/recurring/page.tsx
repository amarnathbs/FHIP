import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getRecurring } from '@/lib/financial-data-hub/analytics/financialActivityAnalytics';
import { formatMoney } from '@/lib/engines/money';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { ResourceEmptyState, ResourceErrorState } from '@/components/resources/admin/ResourceStates';

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  candidate: 'Candidate',
  paused: 'Paused',
  ended: 'Ended',
};

// Status conveyed with a text label AND a colour, never colour alone (spec
// 102-104).
const STATUS_CLASSES: Record<string, string> = {
  active: 'bg-positive/10 text-positive',
  candidate: 'bg-attention/10 text-attention',
  paused: 'bg-muted/10 text-muted',
  ended: 'bg-muted/10 text-muted',
};

const FREQUENCY_LABELS: Record<string, string> = {
  weekly: 'Weekly',
  fortnightly: 'Fortnightly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annual: 'Annual',
  irregular: 'Irregular',
};

// FDH-8 spec 37-40 — Recurring activity, display-only over FDH-6/R8's
// fdh_recurring_transactions. No date is ever fabricated: `next_expected_date`
// is shown only when the certified engine itself set one.
export default async function FinancialActivityRecurringPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  let recurring: Awaited<ReturnType<typeof getRecurring>>;
  try {
    recurring = await getRecurring(user.id);
  } catch (e) {
    return <ResourceErrorState message={e instanceof Error ? e.message : 'Could not load your recurring activity.'} />;
  }

  if (recurring.length === 0) {
    return <ResourceEmptyState title="No recurring activity yet" message="Recurring payments and income FHIP has detected from your approved transactions will appear here." />;
  }

  return (
    <SectionCard title="Recurring activity" description="Detected from your approved transaction history. Not a forecast — no future date is shown unless it was actually calculated.">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Recurring merchants and payees</caption>
          <thead>
            <tr className="border-b border-line text-xs text-muted">
              <th scope="col" className="py-2 pr-2 font-medium">Merchant / payee</th>
              <th scope="col" className="py-2 pr-2 font-medium">Frequency</th>
              <th scope="col" className="py-2 pr-2 text-right font-medium">Expected amount</th>
              <th scope="col" className="py-2 pr-2 font-medium">Status</th>
              <th scope="col" className="py-2 font-medium">Next expected</th>
            </tr>
          </thead>
          <tbody>
            {recurring.map((r) => {
              const currency = (r.currencyCode ?? 'AUD') as 'AUD' | 'INR';
              return (
                <tr key={r.id} className="border-b border-line/60">
                  <td className="py-2 pr-2 text-ink">{r.merchantDisplayName ?? 'Unknown merchant'}</td>
                  <td className="py-2 pr-2 text-muted">{FREQUENCY_LABELS[r.frequency] ?? r.frequency}</td>
                  <td className="py-2 pr-2 text-right tabular-nums text-ink">
                    {r.expectedAmount !== null ? formatMoney(r.expectedAmount, currency) : '—'}
                  </td>
                  <td className="py-2 pr-2">
                    <span className={`inline-block rounded-compact px-2 py-0.5 text-xs font-semibold ${STATUS_CLASSES[r.status] ?? 'bg-muted/10 text-muted'}`}>
                      {STATUS_LABELS[r.status] ?? r.status}
                    </span>
                  </td>
                  <td className="py-2 text-muted">{r.nextExpectedDate ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}
