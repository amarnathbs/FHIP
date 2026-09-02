'use client';

import { useCallback, useState } from 'react';

// Admin A0.2 Wave 5 (§9, §10, §11) — the shared "did my change actually
// commit?" feedback surface for Admin screens.
//
// Before this Wave, most Admin mutations gave no confirmation at all: role
// assignment, benchmark activation, CTA activation, related-content add and
// remove, and context-mapping changes all just silently refetched. The only
// evidence a change had committed was that a value in a list looked
// different afterwards — which a screen-reader user could not perceive at
// all, and which is indistinguishable from "nothing happened" when the new
// value happens to look like the old one.
//
// Rendering the outcome in a polite live region is what makes §9's
// `success` state real rather than assumed, and satisfies §11's
// "aria-live or status announcements for asynchronous results".
//
// Two roles are used deliberately:
//   - success -> role="status" (polite): it does not interrupt.
//   - failure -> role="alert" (assertive): the administrator must know the
//     change did NOT commit before they move on believing it did.

export type AdminActionOutcome = { kind: 'success' | 'failure'; message: string } | null;

export function useAdminActionStatus() {
  const [outcome, setOutcome] = useState<AdminActionOutcome>(null);

  const reportSuccess = useCallback((message: string) => setOutcome({ kind: 'success', message }), []);
  const reportFailure = useCallback((message: string) => setOutcome({ kind: 'failure', message }), []);
  const clearOutcome = useCallback(() => setOutcome(null), []);

  return { outcome, reportSuccess, reportFailure, clearOutcome };
}

export function AdminActionStatus({ outcome, className = '' }: { outcome: AdminActionOutcome; className?: string }) {
  // The live region is always mounted, even when empty. A region that is
  // inserted at the same moment its text appears is not reliably announced
  // by assistive technology — the region must already exist for the change
  // to be noticed.
  const isFailure = outcome?.kind === 'failure';
  return (
    <div
      role={isFailure ? 'alert' : 'status'}
      aria-live={isFailure ? 'assertive' : 'polite'}
      className={className || 'min-h-0'}
    >
      {outcome && (
        <p
          className={`rounded-compact border px-3 py-2 text-sm ${
            isFailure ? 'border-risk/30 bg-risk/5 font-medium text-risk' : 'border-positive/30 bg-positive/5 text-ink'
          }`}
        >
          {outcome.message}
        </p>
      )}
    </div>
  );
}
