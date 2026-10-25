import { SectionCard, Stat } from '@/components/dashboard/SectionCard';
import { formatMoney } from '@/lib/engines/money';
import type { FamilyRetirementViewAvailable } from '@/lib/engines/forecast/familyRetirement';

const STATUS_TEXT: Record<string, string> = {
  fully_funded: 'Fully funded',
  on_track: 'On track',
  minor_gap: 'Minor gap',
  material_gap: 'Material gap',
  high_risk: 'High risk',
  insufficient_information: 'Not enough information',
};

/**
 * PO-D24-01: the Family retirement view. A SEPARATE card beside the personal forecast: Personal retirement, the SMSF, and
 * Family retirement position = Personal + SMSF. It is only rendered when the person has an SMSF (the parent decides).
 */
export function FamilyRetirementView({ view, currency }: { view: FamilyRetirementViewAvailable; currency: 'AUD' | 'INR' }) {
  const money = (n: number | null) => (n === null ? '—' : formatMoney(n, currency));
  const perMonth = (n: number) => `${formatMoney(n, currency)} a month`;
  return (
    <SectionCard
      title="Family retirement position (Personal + SMSF)"
      description="Your personal retirement forecast stays as it is. This adds your SMSF so you can see your whole retirement picture. It is not saved as a forecast."
    >
      <div data-testid="family-retirement-view" className="space-y-4">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[32rem] text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-gray-500">
                <th className="py-2 pr-3 font-medium">Part</th>
                <th className="py-2 pr-3 text-right font-medium">Starting balance</th>
                <th className="py-2 pr-3 text-right font-medium">Added each month</th>
                <th className="py-2 text-right font-medium">Projected at retirement</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b" data-testid="family-row-personal">
                <td className="py-2 pr-3">Personal retirement</td>
                <td className="py-2 pr-3 text-right tabular-nums">{money(view.personal.opening)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{perMonth(view.personal.monthlyFlow)}</td>
                <td className="py-2 text-right tabular-nums">{money(view.personal.balanceAtRetirement)}</td>
              </tr>
              <tr className="border-b" data-testid="family-row-smsf">
                <td className="py-2 pr-3">{view.smsf.funds.length === 1 ? `SMSF (${view.smsf.funds[0].name})` : `SMSF (${view.smsf.funds.length} funds)`}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{money(view.smsf.opening)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{perMonth(view.smsf.monthlyFlow)}</td>
                <td className="py-2 text-right tabular-nums">{money(view.smsf.balanceAtRetirement)}</td>
              </tr>
              <tr className="font-semibold" data-testid="family-row-family">
                <td className="py-2 pr-3">Family retirement position</td>
                <td className="py-2 pr-3 text-right tabular-nums">{money(view.family.opening)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{perMonth(view.family.monthlyFlow)}</td>
                <td className="py-2 text-right tabular-nums">{money(view.family.balanceAtRetirement)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Family projected balance" value={money(view.family.balanceAtRetirement)} />
          <Stat label="Required corpus" value={money(view.family.requiredCorpus)} />
          <Stat label="Family funding gap" value={view.family.fundingGap !== null ? money(Math.max(0, view.family.fundingGap)) : '—'} />
          <Stat label="Family readiness" value={view.family.readinessPct !== null ? `${view.family.readinessPct.toFixed(0)}% (${STATUS_TEXT[view.family.status ?? ''] ?? '—'})` : '—'} />
        </div>
        <p className="text-xs text-gray-500" data-testid="family-basis">
          Retirement age {view.timing.retirementAge}, the same as your personal forecast. The personal forecast alone is{' '}
          {view.personal.readinessPct !== null ? `${view.personal.readinessPct.toFixed(0)}% funded` : 'not measured against a target'}.
        </p>
        <ul className="list-disc space-y-1 pl-5 text-xs text-gray-600" data-testid="family-notes">
          {view.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </div>
    </SectionCard>
  );
}
