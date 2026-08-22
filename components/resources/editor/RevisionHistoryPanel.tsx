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

export function RevisionHistoryPanel({ versions, currentUserId }: { versions: PostVersionSummary[]; currentUserId: string }) {
  return (
    <div className="rounded-card border border-line bg-white p-4">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Revision History</p>
      {versions.length === 0 ? (
        <p className="text-sm text-muted">No revisions saved yet. The first Save Draft will create version 1.</p>
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
      <p className="mt-2 text-xs text-muted">Full restore from a past revision is not available in this release — deferred, see the R1.3 completion report.</p>
    </div>
  );
}
