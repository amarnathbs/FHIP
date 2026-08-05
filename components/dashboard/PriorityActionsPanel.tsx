import Link from 'next/link';
import { SectionCard } from './SectionCard';
import type { StoredRecommendationMatch } from '@/lib/services/recommendationsData';

const SEVERITY_COLOR: Record<string, string> = {
  critical: '#C7362F',
  high: '#C25A24',
  medium: '#B7791F',
  low: '#5B677A',
};

export function PriorityActionsPanel({ matches }: { matches: StoredRecommendationMatch[] }) {
  const top = matches.filter((m) => !m.dismissed).slice(0, 5);

  return (
    <SectionCard
      title="Priority Actions"
      description={top.length > 0 ? 'Your highest-impact next steps, ranked by expected effect.' : undefined}
    >
      {top.length === 0 ? (
        <p className="text-sm text-muted">No priority actions right now — check back after your next data update.</p>
      ) : (
        <ul className="space-y-3">
          {top.map((m) => (
            <li key={m.id} className="flex items-start gap-3 border-b border-line pb-3 last:border-0 last:pb-0">
              <span
                className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full"
                style={{ background: SEVERITY_COLOR[m.recommendation.severity] ?? SEVERITY_COLOR.low }}
                aria-hidden="true"
              />
              <div>
                <p className="text-sm font-medium text-ink">{m.recommendation.actionTitleTemplate}</p>
                {m.evaluatedImpactText && <p className="mt-0.5 text-sm text-muted">{m.evaluatedImpactText}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <Link href="/recommendations" className="mt-4 block text-sm font-medium text-primary hover:underline">
        View all recommendations →
      </Link>
    </SectionCard>
  );
}
