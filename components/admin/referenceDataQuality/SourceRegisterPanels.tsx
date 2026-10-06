import { localiseIsoDatesInText, formatDateDMY } from '@/lib/services/investment-intelligence/pc6/referenceDataQualityView';

// F8 (PO review 2026-10-06): a source the Product Owner has already approved as a fallback is
// not "awaiting a Product Owner decision". It is listed in its own group, with the recorded
// decision, and is never shown as operational.

export interface BlockedSourceRow {
  sourceKey: string;
  label: string;
  licence: string;
  reason: string;
  termsUrl: string | null;
}

export interface ApprovedFallbackRow {
  sourceKey: string;
  label: string;
  licence: string;
  termsUrl: string | null;
  statement: string;
  decidedOn: string; // ISO from the server, rendered day-first here
  decisionBasis: string;
  technicalNotes: string;
  operational: boolean;
}

export function BlockedSourcesList({ rows }: { rows: readonly BlockedSourceRow[] }) {
  if (rows.length === 0) return <p>No source is currently waiting for a Product Owner decision.</p>;
  return (
    <ul>
      {rows.map((s) => (
        <li key={s.label} style={{ marginBottom: '0.5rem' }}>
          <strong>{s.label}</strong> ({s.licence}) - {localiseIsoDatesInText(s.reason)}
          {s.termsUrl ? (
            <>
              {' '}
              <a href={s.termsUrl} target="_blank" rel="noreferrer">
                Terms
              </a>
            </>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function ApprovedFallbackList({ rows }: { rows: readonly ApprovedFallbackRow[] }) {
  if (rows.length === 0) return <p>No approved fallback source is waiting to be proven.</p>;
  return (
    <ul>
      {rows.map((s) => (
        <li key={s.sourceKey} style={{ marginBottom: '0.75rem' }}>
          <strong>{s.label}</strong> ({s.licence})
          <div>{s.statement}</div>
          <div style={{ opacity: 0.85 }}>
            Decision recorded {formatDateDMY(s.decidedOn) ?? s.decidedOn} {s.decisionBasis}.
            {s.operational ? '' : ' Status: not operational.'}
          </div>
          <details>
            <summary>Technical notes</summary>
            <p>{localiseIsoDatesInText(s.technicalNotes)}</p>
          </details>
          {s.termsUrl ? (
            <a href={s.termsUrl} target="_blank" rel="noreferrer">
              Terms
            </a>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
