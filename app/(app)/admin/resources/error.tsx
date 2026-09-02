'use client';

// Route-level error boundary for the Resources Admin shell (spec §51). FHIP
// has no pre-existing route-level error.tsx anywhere in the app (checked —
// this is the known gap tracked as UXD-022 in the Phase 0 audit), so there
// is no existing pattern to reuse; this is a first, Resources-scoped
// instance rather than an attempt to retrofit the whole app's error
// handling in this PR (spec §98: "do not redesign the entire application's
// error system here").
//
// Admin A0.2 Wave 5 (§19) corrected two real defects here:
//
//   1. `error.message` was rendered to the administrator. Next.js redacts
//      server-component messages in production, but client-component and
//      hydration errors keep their real text, so genuine internal strings
//      could reach the screen. Nothing about a thrown JavaScript error's
//      message is useful to an operator, and it can name internals.
//   2. `error.digest` — the one value that IS useful, because it is the
//      correlation id that ties this screen to the server log entry — was
//      never shown, so an administrator reporting the failure had nothing
//      to quote.
//
// The headline is now specific to this shell rather than the shared
// "We couldn't load Resources content." string, which was wrong on the
// Users & Roles and Analytics routes this boundary also covers.

import { useEffect } from 'react';
import { ResourceErrorState } from '@/components/resources/admin/ResourceStates';

export default function ResourcesAdminError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Full detail stays in the browser console and the server log for real
    // diagnosis — it is simply not rendered into the page.
    console.error('Resources Admin route error:', error);
  }, [error]);

  return (
    <div className="p-6">
      <ResourceErrorState
        title="This Resources Admin page could not be opened"
        message={
          error.digest
            ? `Reload the page to try again. If it keeps happening, report this reference: ${error.digest}`
            : 'Reload the page to try again. If it keeps happening, report it with the time you saw it.'
        }
        onRetry={reset}
      />
    </div>
  );
}
