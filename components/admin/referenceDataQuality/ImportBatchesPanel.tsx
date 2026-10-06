'use client';

import { useId, useState } from 'react';
import {
  RENDER_ROW_CAP,
  describeBatchLine,
  describeReasons,
  type BatchLine,
  type FeedSummary,
  type ImportBatchView,
} from '@/lib/services/investment-intelligence/pc6/referenceDataQualityView';

// F7 (PO review 2026-10-06): show the last update per feed plus anything abnormal, and fold the
// repeated healthy lines into a summary with a keyboard-accessible "Show all". The collapse
// rules live in the pure referenceDataQualityView module; nothing here decides what is hidden.

const mutedStyle = { opacity: 0.8 } as const;

function Flag({ children }: { children: React.ReactNode }) {
  return (
    <strong role="status" style={{ marginRight: '0.35rem' }}>
      {children}
    </strong>
  );
}

function FeedLine({ feed }: { feed: FeedSummary }) {
  const l = feed.latestSuccess;
  return (
    <li style={{ marginBottom: '0.6rem' }}>
      {feed.noRunRecorded && (
        <>
          <Flag>Missed.</Flag>
          <code>{feed.feedKey}</code>: no run recorded in the runs loaded. This is not the same as a healthy feed.
        </>
      )}
      {feed.noSuccessfulRun && (
        <>
          <Flag>No successful run.</Flag>
          <code>{feed.feedKey}</code>: runs exist but none succeeded (see the runs that need attention below).
        </>
      )}
      {l && (
        <>
          {feed.stale && (
            <Flag>
              Stale: last successful run is {feed.stale.ageDays} days old (limit {feed.stale.thresholdDays}).
            </Flag>
          )}
          {l.reasons.length > 0 && <Flag>Needs attention: {describeReasons(l.reasons)}.</Flag>}
          <span>
            Latest successful run: {describeBatchLine(l)}
            {l.startedAt ? `, started ${l.startedAt}` : ''}
          </span>
          {feed.summaryText && <div style={mutedStyle}>{feed.summaryText}</div>}
        </>
      )}
    </li>
  );
}

function RunLine({ l }: { l: BatchLine }) {
  return (
    <li style={{ marginBottom: '0.35rem' }}>
      {l.reasons.length > 0 && <Flag>{describeReasons(l.reasons)}.</Flag>}
      {describeBatchLine(l)}
      {l.startedAt ? `, started ${l.startedAt}` : ''}
    </li>
  );
}

export function ImportBatchesPanel({ view, defaultExpanded = false }: { view: ImportBatchView; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const regionId = useId();

  if (view.totalRuns === 0 && view.feeds.length === 0) {
    return <p>No import runs are recorded yet. This is not the same as a healthy feed.</p>;
  }

  return (
    <div>
      <p style={mutedStyle}>
        {view.needsAttention
          ? 'Something below needs attention. Healthy repeat runs are folded away; failures, rejections, stale and missed feeds are never folded.'
          : 'Every feed shows its latest successful run. Nothing failed, was rejected, went stale or was missed.'}
      </p>

      <ul style={{ paddingLeft: '1.2rem' }}>
        {view.feeds.map((f) => (
          <FeedLine key={f.feedKey} feed={f} />
        ))}
      </ul>

      {view.attention.length > 0 && (
        <>
          <h3 style={{ fontSize: '0.95rem', fontWeight: 600 }}>Runs that need attention ({view.attention.length})</h3>
          <ul style={{ paddingLeft: '1.2rem' }}>
            {view.attention.map((l) => (
              <RunLine key={l.id} l={l} />
            ))}
          </ul>
        </>
      )}

      {view.totalRuns > 0 && (
        <div>
          <button type="button" aria-expanded={expanded} aria-controls={regionId} onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Hide all runs' : `Show all ${view.totalRuns} runs loaded`}
          </button>
          <div id={regionId} hidden={!expanded}>
            {expanded && (
              <>
                <ul style={{ paddingLeft: '1.2rem' }}>
                  {view.all.map((l) => (
                    <RunLine key={l.id} l={l} />
                  ))}
                </ul>
                {view.allTruncated && (
                  <p style={mutedStyle}>
                    Showing the newest {RENDER_ROW_CAP} of {view.totalRuns} runs loaded. Older runs are not shown here.
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
