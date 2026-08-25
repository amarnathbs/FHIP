import { ResourceLoadingSkeleton } from '@/components/resources/admin/ResourceStates';

// FDH-8 closure (spec Phase J) — Next.js route-segment loading UI. Every
// page under app/(app)/financial-data-hub/activity/** is an async Server
// Component that awaits real data before rendering; without this file the
// browser shows a blank page during that await (or, worse on a slow
// connection, the PREVIOUS route's stale content) rather than an explicit
// "this is loading" state. This is a skeleton only — it never renders
// "Income: $0 / Expenses: $0" or any other numeral that could be mistaken
// for a real, zero result (spec: a loading state must never look like data).
export default function FinancialActivityLoading() {
  return (
    <div className="space-y-6">
      <div className="h-4 w-48 animate-pulse rounded bg-gray-100" aria-hidden="true" />
      <ResourceLoadingSkeleton rows={6} />
    </div>
  );
}
