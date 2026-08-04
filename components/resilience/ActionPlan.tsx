import Link from 'next/link';
import { SectionCard } from '@/components/dashboard/SectionCard';
import type { ResilienceAction } from '@/lib/engines/resilience';

export function ActionPlan({ actions }: { actions: ResilienceAction[] }) {
  return (
    <SectionCard title="Resilience Action Plan" description="Prioritised, educational focus areas — not product advice.">
      {actions.length === 0 ? (
        <p className="text-sm text-gray-500">No focus areas right now — your resilience components are all scoring well.</p>
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
