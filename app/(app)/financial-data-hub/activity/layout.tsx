// FDH-8 closure fix (2026-08-25): the actual nav/period-selector content
// (which calls `useSearchParams()`) now lives in ActivityLayoutContent.tsx,
// wrapped here in a <Suspense> boundary — required by Next.js whenever
// `useSearchParams()` is used in a route that can be statically generated,
// otherwise `next build` fails static export with "useSearchParams() should
// be wrapped in a suspense boundary". This is a real, previously-
// undisclosed pre-existing defect in FDH-8's own layout (not introduced by
// this closure pass — the prior session's build never got far enough to
// surface it, since it failed earlier at an unrelated page for lack of DEV
// credentials).
import { Suspense } from 'react';
import { ActivityLayoutContent } from './ActivityLayoutContent';

function ActivityLayoutFallback() {
  return (
    <div className="space-y-6">
      <div>
        <div className="h-8 w-64 animate-pulse rounded bg-gray-100" aria-hidden="true" />
        <div className="mt-2 h-4 w-96 animate-pulse rounded bg-gray-100" aria-hidden="true" />
      </div>
      <div className="h-10 animate-pulse rounded bg-gray-100" aria-hidden="true" />
    </div>
  );
}

export default function FinancialActivityLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<ActivityLayoutFallback />}>
      <ActivityLayoutContent>{children}</ActivityLayoutContent>
    </Suspense>
  );
}
