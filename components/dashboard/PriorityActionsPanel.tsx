import Link from 'next/link';
import { SectionCard } from './SectionCard';
import type { StoredRecommendationMatch } from '@/lib/services/recommendationsData';
import type { HealthScoreState } from '@/lib/engines/healthScoreEligibility';

const SEVERITY_COLOR: Record<string, string> = {
  critical: '#C7362F',
  high: '#C25A24',
  medium: '#B7791F',
  low: '#5B677A',
};

// Phase 0C (UX-007): the single "No priority actions right now" message
// used to cover both "we checked and found nothing to flag" and "we don't
// have enough information yet" — indistinguishable to the reader. Reuses
// the same Health Score eligibility state already computed for the
// Dashboard/Score pages, rather than inventing a separate, unverifiable
// "baseline not ready" detector this component has no real visibility into.
export function PriorityActionsPanel({
  matches,
  healthScoreState,
}: {
  matches: StoredRecommendationMatch[];
  healthScoreState: HealthScoreState;
}) {
  const top = matches.filter((m) => !m.dismissed).slice(0, 5);
  const insufficientData = healthScoreState === 'not_yet_scored';

  return (
    <SectionCard
      title="Priority Actions"
      description={top.length > 0 ? 'Your highest-impact next steps, ranked by expected effect.' : undefined}
    >
      {top.length === 0 ? (
        insufficientData ? (
          <div>
            <p className="text-sm font-medium text-ink">We need more information before identifying your priorities.</p>
            <p className="mt-1 text-sm text-muted">
              Complete more of your Financial Picture so FHIP can identify the areas that may need attention.
            </p>
          </div>
        ) : (
          <div>
            <p className="text-sm font-medium text-ink">No high-priority actions identified right now.</p>
            <p className="mt-1 text-sm text-muted">
              Based on the information currently available, we have not identified any high-priority actions.
            </p>
          </div>
        )
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
