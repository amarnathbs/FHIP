import { SectionCard } from '@/components/dashboard/SectionCard';

export function GoalInsights({ insights }: { insights: string[] }) {
  return (
    <SectionCard title="Goal Insights" description="Data-supported observations from your current goal plan.">
      {insights.length === 0 ? (
        <p className="text-sm text-gray-500">No notable observations right now — your goals are tracking as planned.</p>
      ) : (
        <ul className="space-y-2 text-sm text-gray-700">
          {insights.map((insight, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-trust">•</span>
              {insight}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
