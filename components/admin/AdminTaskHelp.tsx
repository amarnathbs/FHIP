'use client';

import { getTaskHelp } from '@/lib/admin/taskHelp';

// Admin A0.2 Wave 5 (§17) — the one consistent Help affordance across every
// visible Admin page.
//
// Implemented as a native <details>/<summary> disclosure rather than a link
// out to a documentation site, a modal, or a side panel, for three reasons
// this Wave's own scope forces:
//   - §17 forbids creating a new documentation platform, and forbids
//     exposing repository paths to users. A link to a markdown file in the
//     repo would do both.
//   - §5 excludes the future Admin shell, so there is no global Help region
//     to dock a panel into. A per-page disclosure needs no shell.
//   - <summary> is keyboard-operable, focusable and announced as a
//     disclosure by assistive technology with no custom key handling, so it
//     satisfies §17's "the Help link is keyboard accessible" without adding
//     a bespoke widget whose focus behaviour would itself need certifying.
//
// The copy comes from lib/admin/taskHelp.ts, which is the same content as
// the operator manual for the same task ID — so the manual and the product
// cannot drift apart silently.

export function AdminTaskHelp({ taskId }: { taskId: string }) {
  const help = getTaskHelp(taskId);
  if (!help) return null;

  return (
    <details className="group rounded-card border border-line bg-white">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-4 py-2.5 text-sm font-semibold text-trust outline-offset-2 focus-visible:outline-2 focus-visible:outline-trust">
        <span>How to use this page</span>
        <span aria-hidden="true" className="text-xs text-muted transition-transform group-open:rotate-90">
          &rsaquo;
        </span>
      </summary>

      <div className="border-t border-line px-4 py-3 text-sm text-ink">
        {help.availability === 'not_operational' ? (
          <>
            <p className="font-semibold">Not available yet</p>
            <p className="mt-1 text-muted">{help.unavailableReason}</p>
            <p className="mt-3 text-muted">
              <span className="font-medium text-ink">What to do instead: </span>
              {help.nextStep}
            </p>
          </>
        ) : (
          <>
            <p className="text-muted">{help.purpose}</p>

            <p className="mt-3">
              <span className="font-medium">Who can do this: </span>
              <span className="text-muted">{help.eligibleRoles}</span>
            </p>

            {help.prerequisites.length > 0 && (
              <>
                <p className="mt-3 font-medium">Before you start</p>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-muted">
                  {help.prerequisites.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </>
            )}

            {help.steps.length > 0 && (
              <>
                <p className="mt-3 font-medium">Steps</p>
                <ol className="mt-1 list-decimal space-y-1 pl-5 text-muted">
                  {help.steps.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
              </>
            )}

            <p className="mt-3">
              <span className="font-medium">How you know it worked: </span>
              <span className="text-muted">{help.successEvidence}</span>
            </p>
            <p className="mt-2">
              <span className="font-medium">Undoing it: </span>
              <span className="text-muted">{help.reversal}</span>
            </p>
            <p className="mt-2">
              <span className="font-medium">Next: </span>
              <span className="text-muted">{help.nextStep}</span>
            </p>
          </>
        )}
      </div>
    </details>
  );
}
