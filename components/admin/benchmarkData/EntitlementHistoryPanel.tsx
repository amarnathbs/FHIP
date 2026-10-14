'use client';

// The audit timeline of one entitlement record: who did what, when, why, and what changed (before and after).
// The actor is "You" or a role, never another administrator. Dates are day-first.
import type { Ref } from 'react';
import type { EntitlementHistoryResponse } from '@/lib/services/investment-intelligence/benchmarkData/apiTypes';
import { useLoad } from './api';
import { apiPaths } from './benchmarkDataUiLogic';
import { changeLine, timelineHeading } from './entitlementEditLogic';
import { Btn, ErrorPanel, LoadingPanel, Panel } from './ui';

export default function EntitlementHistoryPanel({ id, title, onClose, headingRef }: { id: string; title: string; onClose: () => void; headingRef?: Ref<HTMLHeadingElement> }) {
  const { state, reload } = useLoad<EntitlementHistoryResponse>(apiPaths.entitlementHistory(id), 'load the history of this entitlement');
  return (
    <Panel headingRef={headingRef} title={title} description="Every change to this record and to the versions it replaced or was replaced by, oldest first. A person is shown only as You or by role." actions={<Btn kind="secondary" onClick={onClose}>Close history</Btn>}>
      {state.status === 'loading' ? <LoadingPanel what="the history" /> : null}
      {state.status === 'error' ? <ErrorPanel failure={state.failure} what="the history" onRetry={reload} /> : null}
      {state.status === 'ready' && state.data.entries.length === 0 ? <p className="text-sm text-muted">No change has been recorded for this record yet.</p> : null}
      {state.status === 'ready' && state.data.entries.length > 0 ? (
        <ol className="space-y-3">
          {state.data.entries.map((e, i) => (
            <li key={`${e.at}-${i}`} className="rounded-compact border border-line p-3 text-sm">
              <p className="font-semibold text-ink">{timelineHeading(e)}</p>
              {e.reason ? <p className="mt-1 text-ink">Reason: {e.reason}</p> : null}
              {e.changes.length > 0 ? (
                <ul className="mt-1 list-disc pl-5 text-muted">
                  {e.changes.map((c) => (
                    <li key={c.field}>{changeLine(c)}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </Panel>
  );
}
