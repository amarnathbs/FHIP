'use client';

// R1.3 revision history — spec §43-47. Read-only list of resource_post_versions
// rows: version number, timestamp, editor (shown as "you" when it matches
// the current user — the app has no safe display-name join for an
// arbitrary auth.users id, same reasoning ResourceContentDetailPage already
// documents for workflow history's actor_role-not-name choice), change
// summary. Full restore is explicitly optional/deferred (spec §47) — not
// implemented here; see the R1.3 completion report's Technical Debt section.

import { formatAdminDateTime } from '@/lib/resources/admin/labels';
import type { PostVersionSummary } from '@/lib/resources/editor/types';

// Admin A0.2 Wave 5 (§15, §18): two operator-facing copy defects.
//   1. The empty state named a button — "Save Draft" — that only ONE of the
//      four editors that render this panel actually has; the video, glossary
//      and money-update editors label the same control "Save". The copy now
//      describes the action rather than naming a button that may not exist
//      on the screen the reader is looking at.
//   2. The footer told an operator to "see the R1.3 completion report" — an
//      internal engineering document they have no way to open. Replaced with
//      what they can actually do.
export function RevisionHistoryPanel({ versions, currentUserId }: { versions: PostVersionSummary[]; currentUserId: string }) {
  return (
    <section aria-labelledby="revision-history-heading" className="rounded-card border border-line bg-white p-4">
      <h2 id="revision-history-heading" className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
        Revision History
      </h2>
      {versions.length === 0 ? (
        <p className="text-sm text-muted">No revisions saved yet. Add a change summary before you save to create version 1.</p>
      ) : (
        <ul className="space-y-2">
          {versions.map((v) => (
            <li key={v.id} className="border-l-2 border-line pl-3 text-sm">
              <p className="font-medium text-ink">Version {v.version_number}</p>
              <p className="text-xs text-muted">
                {formatAdminDateTime(v.created_at)} · by {v.created_by === currentUserId ? 'you' : 'another editor'}
              </p>
              {v.change_summary && <p className="mt-0.5 text-xs text-muted">{v.change_summary}</p>}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-muted">
        Restoring a past revision is not available in this release. To undo a change, edit the content back to what you want
        and save again — the earlier versions listed here are kept as a record either way.
      </p>
    </section>
  );
}
