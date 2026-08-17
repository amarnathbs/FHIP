'use client';

// Route-level error boundary for the Resources Admin shell (spec §51). FHIP
// has no pre-existing route-level error.tsx anywhere in the app (checked —
// this is the known gap tracked as UXD-022 in the Phase 0 audit), so there
// is no existing pattern to reuse; this is a first, Resources-scoped
// instance rather than an attempt to retrofit the whole app's error
// handling in this PR (spec §98: "do not redesign the entire application's
// error system here").

import { ResourceErrorState } from '@/components/resources/admin/ResourceStates';

export default function ResourcesAdminError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="p-6">
      <ResourceErrorState message={error.message || 'An unexpected error occurred.'} onRetry={reset} />
    </div>
  );
}
