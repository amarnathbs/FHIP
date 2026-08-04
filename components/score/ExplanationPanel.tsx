import { SectionCard } from '@/components/dashboard/SectionCard';
import type { Recommendation } from '@/lib/engines/healthScore';

export function ExplanationPanel({
  positives,
  reductions,
  recommendations,
}: {
  positives: string[];
  reductions: string[];
  recommendations: Recommendation[];
}) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <SectionCard title="Top Positive Contributors">
        {positives.length === 0 ? (
          <p className="text-sm text-gray-500">Not enough data yet to identify strengths.</p>
        ) : (
          <ul className="space-y-2 text-sm text-gray-700">
            {positives.map((p, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-progress">✓</span>
                {p}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      <SectionCard title="Main Score Reductions">
        {reductions.length === 0 ? (
          <p className="text-sm text-gray-500">No significant weaknesses identified.</p>
        ) : (
          <ul className="space-y-2 text-sm text-gray-700">
            {reductions.map((r, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-risk">⚠</span>
                {r}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      <SectionCard title="Biggest Improvement Opportunities">
        {recommendations.length === 0 ? (
          <p className="text-sm text-gray-500">No recommendations right now — you&apos;re doing well.</p>
        ) : (
          <ul className="space-y-3 text-sm">
            {recommendations.map((r, i) => (
              <li key={i} className="border-b pb-2 last:border-0">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-gray-900">{r.title}</span>
                  <span className="text-xs font-semibold text-progress">+{r.estimatedScoreImprovement.toFixed(1)} pts</span>
                </div>
                <p className="mt-1 text-xs text-gray-500">{r.explanation}</p>
                <p className="mt-1 text-xs uppercase text-gray-400">{r.priority} priority</p>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
