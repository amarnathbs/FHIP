'use client';

import { useId, useState } from 'react';
import { RENDER_ROW_CAP, type CorrectionGroup, type CorrectionView } from '@/lib/services/investment-intelligence/pc6/referenceDataQualityView';

// F7: identical correction lines (same table, row, kind, actor and message) are one row with a
// count and first/last date. Corrections made by a person, or of any kind other than the
// automatic importer's own source_correction, are listed first and never folded away.

const DEFAULT_GROUPS_SHOWN = 10;

function GroupLine({ g }: { g: CorrectionGroup }) {
  return (
    <li style={{ marginBottom: '0.35rem' }}>
      {g.notable && (
        <strong role="status" style={{ marginRight: '0.35rem' }}>
          Not an automatic import correction.
        </strong>
      )}
      <code>{g.correctionKind}</code> on <code>{g.targetTable}</code>
      {g.targetRowId ? (
        <>
          {' '}
          (row <code>{g.targetRowId}</code>)
        </>
      ) : null}{' '}
      by {g.actorKind}: {g.reason || 'no reason recorded'}
      {' - '}
      {g.count === 1 ? `once, ${g.lastAt ?? 'date unknown'}` : `${g.count} times, first ${g.firstAt ?? 'date unknown'}, last ${g.lastAt ?? 'date unknown'}`}
    </li>
  );
}

export function CorrectionsPanel({ view, defaultExpanded = false }: { view: CorrectionView; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const regionId = useId();

  if (view.totalLines === 0) return <p>No source corrections are recorded.</p>;

  const shown = expanded ? view.allCapped : view.groups.slice(0, DEFAULT_GROUPS_SHOWN);
  const folded = view.groups.length - DEFAULT_GROUPS_SHOWN;

  return (
    <div>
      <p style={{ opacity: 0.8 }}>
        {view.totalLines} correction line{view.totalLines === 1 ? '' : 's'} loaded, grouped into {view.groups.length} distinct correction
        {view.groups.length === 1 ? '' : 's'}.
      </p>
      <ul id={regionId} style={{ paddingLeft: '1.2rem' }}>
        {shown.map((g) => (
          <GroupLine key={g.key} g={g} />
        ))}
      </ul>
      {folded > 0 && (
        <button type="button" aria-expanded={expanded} aria-controls={regionId} onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show fewer' : `Show all ${view.groups.length} distinct corrections`}
        </button>
      )}
      {expanded && view.allTruncated && (
        <p style={{ opacity: 0.8 }}>
          Showing the first {RENDER_ROW_CAP} of {view.groups.length} distinct corrections. The rest are not shown here.
        </p>
      )}
    </div>
  );
}
