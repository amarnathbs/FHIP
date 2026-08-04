import { SectionCard } from '@/components/dashboard/SectionCard';
import { formatMoney } from '@/lib/engines/money';
import type { GoalPayload } from '@/lib/services/goalsData';

const HORIZON_BUCKETS = [
  { key: 'next12', label: 'Next 12 Months', maxMonths: 12 },
  { key: 'y1_3', label: '1–3 Years', maxMonths: 36 },
  { key: 'y3_5', label: '3–5 Years', maxMonths: 60 },
  { key: 'y5_10', label: '5–10 Years', maxMonths: 120 },
  { key: 'y10plus', label: 'More Than 10 Years', maxMonths: Infinity },
];

function monthsFromNow(dateStr: string): number {
  const target = new Date(dateStr);
  const now = new Date();
  return (target.getFullYear() - now.getFullYear()) * 12 + (target.getMonth() - now.getMonth());
}

export function GoalTimeline({ goals, currency }: { goals: GoalPayload[]; currency: 'AUD' | 'INR' }) {
  const withDates = goals.filter((g) => g.status === 'active' && g.targetDate);
  return (
    <SectionCard title="Goal Timeline" description="Your active goals plotted across their target-date horizon.">
      {withDates.length === 0 ? (
        <p className="text-sm text-gray-500">No goals with a target date yet.</p>
      ) : (
        <div className="space-y-4">
          {HORIZON_BUCKETS.map((bucket, i) => {
            const prevMax = i === 0 ? -Infinity : HORIZON_BUCKETS[i - 1].maxMonths;
            const inBucket = withDates.filter((g) => {
              const m = monthsFromNow(g.targetDate!);
              return m > prevMax && m <= bucket.maxMonths;
            });
            if (inBucket.length === 0) return null;
            return (
              <div key={bucket.key}>
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">{bucket.label}</p>
                <div className="mt-2 space-y-2">
                  {inBucket.map((g) => (
                    <div key={g.id} className="flex items-center justify-between rounded border px-3 py-2 text-sm">
                      <div>
                        <p className="font-medium text-gray-800">{g.goalName}</p>
                        <p className="text-xs text-gray-500">
                          Target: {new Date(g.targetDate!).toLocaleDateString('en-AU', { month: 'short', year: 'numeric' })} ·{' '}
                          {formatMoney(g.forecasts.base.targetAmountFuture, currency)}
                        </p>
                      </div>
                      <span className="text-xs text-gray-500">
                        Expected:{' '}
                        {g.forecasts.base.projectedCompletionDate
                          ? new Date(g.forecasts.base.projectedCompletionDate).toLocaleDateString('en-AU', {
                              month: 'short',
                              year: 'numeric',
                            })
                          : '—'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}
