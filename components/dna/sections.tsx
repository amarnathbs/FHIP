import Link from 'next/link';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { LockedFeatureCard } from '@/components/ui/LockedFeatureCard';
import type { DnaDriver, DnaTrait } from '@/lib/engines/financialDna';
import type { Archetype, DnaHistoryPoint } from '@/lib/services/financialDnaData';
import { formatDateShort } from '@/lib/engines/date';

const LEVEL_COLOR: Record<DnaTrait['level'], string> = {
  low: '#C7362F',
  moderate: '#B7791F',
  high: '#198754',
};

const LEVEL_LABEL: Record<DnaTrait['level'], string> = { low: 'Low', moderate: 'Moderate', high: 'High' };
const LEVEL_WIDTH: Record<DnaTrait['level'], number> = { low: 30, moderate: 60, high: 90 };

export function HeroCard({
  archetype,
  secondaryArchetype,
  confidence,
  confidenceLabel,
  profileChanged,
  previousProfileCode,
  archetypes,
  currency,
}: {
  archetype: Archetype | null;
  secondaryArchetype: Archetype | null;
  primaryScore: number | null;
  secondaryScore: number | null;
  confidence: number;
  confidenceLabel: string;
  profileChanged: boolean;
  previousProfileCode: string | null;
  archetypes: Record<string, Archetype>;
  currency: 'AUD' | 'INR';
}) {
  if (!archetype) return null;
  return (
    <div className="rounded-card border bg-white p-8">
      <p className="text-sm font-medium uppercase tracking-wide text-gray-400">Your Financial DNA</p>
      <h1 className="mt-2 text-3xl font-bold text-trust">{archetype.profile_name}</h1>
      <p className="mt-3 max-w-2xl text-gray-600">{archetype.long_description}</p>
      <div className="mt-5 flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <span>
          <span className="text-gray-500">Confidence: </span>
          <span className="font-semibold text-gray-900">
            {confidence.toFixed(0)}% ({confidenceLabel})
          </span>
        </span>
        {secondaryArchetype && (
          <span>
            <span className="text-gray-500">Secondary trait: </span>
            <span className="font-semibold text-gray-900">{secondaryArchetype.profile_name}</span>
          </span>
        )}
        <span>
          <span className="text-gray-500">Last calculated: </span>
          <span className="font-semibold text-gray-900">{formatDateShort(new Date(), currency)}</span>
        </span>
        <span>
          <span className="text-gray-500">Profile status: </span>
          <span className="font-semibold text-gray-900">
            {profileChanged && previousProfileCode
              ? `Changed from ${archetypes[previousProfileCode]?.profile_name ?? previousProfileCode}`
              : 'Stable'}
          </span>
        </span>
      </div>
      <p className="mt-4 text-xs text-gray-400">
        Your current financial pattern most closely resembles this profile — it describes your household&apos;s pattern
        today, not a permanent label. It can and will change as your data changes.
      </p>
    </div>
  );
}

export function TraitBars({ traits }: { traits: DnaTrait[] }) {
  if (traits.length === 0) return null;
  return (
    <SectionCard title="Profile Traits" description="Six to eight indicators describing your current pattern.">
      <div className="space-y-4">
        {traits.map((t) => (
          <div key={t.code}>
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium text-gray-800">{t.label}</span>
              <span className="text-gray-500">
                {LEVEL_LABEL[t.level]}
                {t.direction !== 'unknown' && t.direction !== 'stable' ? ` · ${t.direction}` : ''}
              </span>
            </div>
            <div className="mt-1 h-2 w-full rounded-full bg-gray-100">
              <div
                className="h-2 rounded-full"
                style={{ width: `${LEVEL_WIDTH[t.level]}%`, background: LEVEL_COLOR[t.level] }}
              />
            </div>
            <p className="mt-1 text-xs text-gray-500">
              {t.explanation} Indicative target: {t.targetRangeLabel}.
            </p>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

export function DriverList({ drivers }: { drivers: DnaDriver[] }) {
  return (
    <SectionCard title="Why You Received This Profile" description="The top classification drivers behind your result.">
      {drivers.length === 0 ? (
        <p className="text-sm text-gray-500">Not enough data yet to explain this classification.</p>
      ) : (
        <ol className="space-y-2 text-sm text-gray-700">
          {drivers.map((d, i) => (
            <li key={i} className="border-b pb-2 last:border-0">
              {i + 1}. {d.explanation}
            </li>
          ))}
        </ol>
      )}
    </SectionCard>
  );
}

export function StrengthsRisks({ strengths, risks }: { strengths: DnaDriver[]; risks: DnaDriver[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <SectionCard title="Your Strongest Financial Traits">
        {strengths.length === 0 ? (
          <p className="text-sm text-gray-500">Not enough data yet.</p>
        ) : (
          <ul className="space-y-2 text-sm text-gray-700">
            {strengths.map((s, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-progress">✓</span>
                {s.explanation}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      <SectionCard title="Risks Associated With This Pattern">
        {risks.length === 0 ? (
          <p className="text-sm text-gray-500">No significant risks identified.</p>
        ) : (
          <ul className="space-y-2 text-sm text-gray-700">
            {risks.map((r, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-caution">⚠</span>
                {r.explanation}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

export function FocusActions({
  actions,
}: {
  actions: { title: string; explanation: string; priority: string; relatedModule: string }[];
}) {
  return (
    <SectionCard title="What Should I Focus On Next?" description="Educational, prioritised focus areas — not product advice.">
      {actions.length === 0 ? (
        <p className="text-sm text-gray-500">No focus areas right now.</p>
      ) : (
        <div className="space-y-3">
          {actions.map((a, i) => (
            <div key={i} className="rounded-card border p-4">
              <div className="flex items-center justify-between">
                <p className="font-medium text-gray-900">{a.title}</p>
                <span className="text-xs uppercase text-gray-400">{a.priority} priority</span>
              </div>
              <p className="mt-1 text-sm text-gray-600">{a.explanation}</p>
              <Link href={`/${a.relatedModule}`} className="mt-2 inline-block text-xs font-medium text-trust hover:underline">
                View {a.relatedModule} →
              </Link>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

export function HistoryTimeline({ history, archetypes }: { history: DnaHistoryPoint[]; archetypes: Record<string, Archetype> }) {
  return (
    <SectionCard title="Financial DNA History" description="Your profile is never overwritten — each month is kept on record.">
      {history.length === 0 ? (
        <p className="text-sm text-gray-500">Not enough history yet — check back after a few months of data.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="py-1">Month</th>
              <th className="py-1">Primary profile</th>
              <th className="py-1">Secondary trait</th>
              <th className="py-1">Confidence</th>
            </tr>
          </thead>
          <tbody>
            {history
              .slice()
              .reverse()
              .map((h) => (
                <tr key={h.profile_month} className="border-t">
                  <td className="py-1">{new Date(h.profile_month).toLocaleDateString('en-AU', { month: 'short', year: '2-digit' })}</td>
                  <td className="py-1">{archetypes[h.primary_profile_code]?.profile_name ?? h.primary_profile_code}</td>
                  <td className="py-1">
                    {h.secondary_profile_code ? archetypes[h.secondary_profile_code]?.profile_name ?? h.secondary_profile_code : '—'}
                  </td>
                  <td className="py-1">{h.confidence_score.toFixed(0)}%</td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </SectionCard>
  );
}

export function Methodology({ modelVersion, dataCompletenessPct }: { modelVersion: string; dataCompletenessPct: number }) {
  return (
    <details className="rounded-card border bg-white p-6">
      <summary className="cursor-pointer text-sm font-medium text-gray-800">How this was calculated</summary>
      <div className="mt-3 space-y-2 text-sm text-gray-600">
        <p>
          Financial DNA is calculated deterministically from your income, expenses, assets, liabilities, investments,
          retirement and insurance data — never by an AI model. Each of the 8 profiles is scored against your data
          across weighted dimensions (savings discipline, spending pattern, debt structure, asset allocation,
          investment behaviour, liquidity, retirement preparation, income capacity and protection planning). The
          highest-scoring eligible profile becomes your primary Financial DNA.
        </p>
        <p>Model version: {modelVersion}</p>
        <p>Data completeness used in this calculation: {dataCompletenessPct.toFixed(0)}%</p>
        <p className="text-xs text-gray-400">
          This information is educational only and does not constitute personal financial product advice.
        </p>
      </div>
    </details>
  );
}

export function QuestionnairePlaceholder() {
  return (
    <LockedFeatureCard
      title="Behavioural Questionnaire"
      description="A short optional questionnaire about your saving, spending, investment, debt and planning attitudes will improve classification confidence and surface self-perception vs. observed-behaviour insights. Kept as a placeholder for a fast-follow so it isn't forgotten."
    />
  );
}

export function MissingDataPanel({ status }: { status: string }) {
  if (status !== 'insufficient_data') return null;
  return (
    <div className="rounded-card border border-dashed bg-gray-50 p-8 text-center">
      <p className="text-gray-700">
        We need income, expenses, assets and liabilities before we can estimate your Financial DNA.
      </p>
      <div className="mt-4 flex flex-wrap justify-center gap-3">
        <Link href="/income" className="rounded bg-trust px-4 py-2 text-sm text-white">
          Add income
        </Link>
        <Link href="/expenses" className="rounded border px-4 py-2 text-sm text-gray-700">
          Add expenses
        </Link>
        <Link href="/assets" className="rounded border px-4 py-2 text-sm text-gray-700">
          Add assets
        </Link>
        <Link href="/liabilities" className="rounded border px-4 py-2 text-sm text-gray-700">
          Add liabilities
        </Link>
      </div>
    </div>
  );
}
