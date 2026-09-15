'use client';

import { useEffect, useState } from 'react';

// PC7/O.9 — read-only operator view of Underlying Fund Holdings data quality.
//
// TERMINOLOGY (O.2). This screen is about UNDERLYING FUND HOLDINGS — the
// securities held INSIDE a scheme. It says nothing about any user's own fund
// position, and the wording here is deliberate: "Fund Holdings" on its own is
// ambiguous between the two and is not used.
//
// ADMIN STANDARD §8 (result-state semantics). Every panel renders exactly one
// of `ok` / `never_ingested` / `unavailable`, and never a bare 0 standing in
// for "we do not know". "0 unmapped securities" when nothing has ever been
// ingested is a lie told with a true number, so that case renders as NEVER
// INGESTED instead.
//
// ADMIN STANDARD §9 (privacy). The only user-derived input behind this screen
// is a per-scheme BOOLEAN — "is this scheme held by anyone at all" — used to
// prioritise the mapping queue. No user id, no holding value and no per-user
// row reaches this component. See the API route's own §9 analysis.
//
// READ-ONLY. Nothing on this page writes anything.

type PanelState = 'ok' | 'never_ingested' | 'unavailable';
interface Panel<T = unknown> {
  state: PanelState;
  data?: T;
  reason?: string;
}

interface QualityPayload {
  asOfDate: string;
  generatedAt: string;
  qualityVersion: string;
  ingestionActive: boolean;
  missing_disclosures?: Panel<{ totalSchemes: number; withDisclosure: number; missingAndHeld: number; missing: Array<{ instrumentId: string; schemeName: string; heldByAnyUser: boolean }> }>;
  stale_snapshots?: Panel<{ snapshotCount: number; current: number; acceptable: number; stale: number; veryStale: number; stalest: Array<{ fundInstrumentId: string; holdingsAsOfDate: string; ageDays: number; freshness: string }> }>;
  unmapped_securities?: Panel<{ totalSecurityLines: number; resolvedLines: number; unresolvedLines: number; unmapped: Array<{ holdingName: string; isin: string | null; occurrences: number; maxWeightPct: number }> }>;
  coverage_gaps?: Panel<{ snapshotCount: number; withFullCoverage: number; gaps: Array<{ snapshotId: string; fundInstrumentId: string; holdingsAsOfDate: string; disclosedWeightTotalPct: number | null; lineCount: number; reason: string }> }>;
  import_failures?: Panel<{ batchCount: number; succeeded: number; failed: number; running: number; rejectionRate: number | null; lastSuccessAt: string | null; recentFailures: Array<{ id: string; status: string; startedAt: string; errorCode: string | null }> }>;
  source_changes?: Panel<{ observationCount: number; changes: Array<{ kind: string; detail: string }> }>;
  networth_safety?: Panel<{ satisfied: boolean; violationCount: number; violations: Array<{ violation_code: string; object_name: string; detail: string }>; note: string }>;
  blocked_sources?: Panel<Array<{ sourceKey: string; label: string; licence: string; reason: string; termsUrl: string | null }>>;
}

function Section({ title, panel, children }: { title: string; panel?: Panel<unknown>; children?: React.ReactNode }) {
  return (
    <section style={{ marginBottom: '2rem' }}>
      <h2 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.5rem' }}>{title}</h2>
      {!panel ? (
        <p style={{ opacity: 0.7 }}>Not requested.</p>
      ) : panel.state === 'unavailable' ? (
        <p style={{ opacity: 0.85 }}>
          <strong>Unavailable.</strong> {panel.reason}
        </p>
      ) : panel.state === 'never_ingested' ? (
        // §8: the distinct third state. This is NOT "healthy and empty".
        <p style={{ opacity: 0.85 }}>
          <strong>Never ingested.</strong> {panel.reason}
        </p>
      ) : (
        children
      )}
    </section>
  );
}

export default function LookthroughDataQualityClient() {
  const [payload, setPayload] = useState<QualityPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/admin/investment-intelligence/lookthrough-data-quality');
        const j = await r.json();
        if (cancelled) return;
        if (!r.ok) {
          setError(typeof j.error === 'string' ? j.error : `Request failed (${r.status})`);
          return;
        }
        setPayload(j.data as QualityPayload);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load look-through data quality');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (error) return <main style={{ padding: '1.5rem' }}><h1>Underlying Fund Holdings Quality</h1><p><strong>Unavailable.</strong> {error}</p></main>;
  if (!payload) return <main style={{ padding: '1.5rem' }}><h1>Underlying Fund Holdings Quality</h1><p>Loading…</p></main>;

  const missing = payload.missing_disclosures?.data;
  const stale = payload.stale_snapshots?.data;
  const unmapped = payload.unmapped_securities?.data;
  const coverage = payload.coverage_gaps?.data;
  const failures = payload.import_failures?.data;
  const safety = payload.networth_safety?.data;

  return (
    <main style={{ padding: '1.5rem', maxWidth: 1100 }}>
      <h1 style={{ fontSize: '1.4rem', fontWeight: 700 }}>Underlying Fund Holdings Quality</h1>
      <p style={{ opacity: 0.75, marginBottom: '1rem' }}>
        The constituent securities held <em>inside</em> mutual-fund schemes — the data Portfolio X-Ray
        decomposes a fund position into. This is external reference data about a scheme, identical for
        every user who holds it. It is never a user&apos;s own position, and it never contributes to any
        household&apos;s net worth. As at {payload.asOfDate}, generated{' '}
        {new Date(payload.generatedAt).toLocaleString()} ({payload.qualityVersion}).
      </p>

      {!payload.ingestionActive && (
        <p style={{ padding: '0.75rem', border: '1px solid currentColor', borderRadius: 6, marginBottom: '1.5rem', opacity: 0.9 }}>
          <strong>No disclosure source is enabled.</strong> Every PC7 source ships switched off pending a
          Product Owner licensing decision, so nothing is currently being ingested. Counts below describe
          whatever look-through data already exists, not the output of a running importer.
        </p>
      )}

      <Section title="Net-worth safety (O.7) — asserted by the database" panel={payload.networth_safety}>
        {safety && (
          <>
            <p>
              <strong>{safety.satisfied ? 'SATISFIED' : `${safety.violationCount} VIOLATION(S)`}</strong>. {safety.note}
            </p>
            {safety.violations.length > 0 && (
              <ul>
                {safety.violations.map((v) => (
                  <li key={v.object_name}><code>{v.violation_code}</code> — {v.object_name}: {v.detail}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </Section>

      <Section title="Missing scheme disclosures" panel={payload.missing_disclosures}>
        {missing && (
          <>
            <p>
              {missing.withDisclosure} of {missing.totalSchemes} schemes have a usable disclosure.{' '}
              <strong>{missing.missing.length} missing</strong>, of which <strong>{missing.missingAndHeld} are actually held</strong>{' '}
              by someone and are therefore degrading a real user&apos;s X-Ray coverage right now.
            </p>
            <ul>
              {missing.missing.filter((m) => m.heldByAnyUser).slice(0, 15).map((m) => (
                <li key={m.instrumentId}>{m.schemeName} — held, no disclosure</li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <Section title="Stale snapshots" panel={payload.stale_snapshots}>
        {stale && (
          <>
            <p>
              {stale.snapshotCount} scheme(s) judged on their newest disclosure — {stale.current} current,{' '}
              {stale.acceptable} acceptable, <strong>{stale.stale} stale</strong>, <strong>{stale.veryStale} very stale</strong>.
              Thresholds are the same ones the user-facing X-Ray uses, so this screen and a user&apos;s screen
              cannot disagree about what &ldquo;stale&rdquo; means.
            </p>
            <ul>
              {stale.stalest.slice(0, 10).map((s) => (
                <li key={s.fundInstrumentId}>{s.fundInstrumentId} — {s.holdingsAsOfDate} ({s.ageDays} days, {s.freshness})</li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <Section title="Unmapped securities" panel={payload.unmapped_securities}>
        {unmapped && (
          <>
            <p>
              {unmapped.resolvedLines} of {unmapped.totalSecurityLines} security lines resolved to a canonical
              security; <strong>{unmapped.unresolvedLines} unresolved</strong>. An unresolved line is kept and shown
              as unresolved exposure — it is never name-matched into a lookalike security and never dropped.
              Cash, derivative and receivable buckets are excluded here: they were never meant to resolve.
            </p>
            <ul>
              {unmapped.unmapped.slice(0, 15).map((u) => (
                <li key={u.isin ?? u.holdingName}>
                  {u.holdingName}{u.isin ? ` (${u.isin})` : ' (no ISIN)'} — in {u.occurrences} snapshot(s), up to {u.maxWeightPct}% of a fund
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <Section title="Coverage gaps" panel={payload.coverage_gaps}>
        {coverage && (
          <>
            <p>
              {coverage.withFullCoverage} of {coverage.snapshotCount} snapshots cover their fund;{' '}
              <strong>{coverage.gaps.length} gap(s)</strong>. A shortfall is retained as an explicit remainder —
              a partially-disclosed portfolio is never rescaled up to 100%.
            </p>
            <ul>
              {coverage.gaps.slice(0, 15).map((g) => (
                <li key={g.snapshotId}>
                  {g.fundInstrumentId} @ {g.holdingsAsOfDate} — <code>{g.reason}</code>
                  {g.reason === 'no_lines'
                    ? ' (a snapshot header with no constituent lines: the engine would select it and compute zero exposure that looks measured)'
                    : ` (${g.disclosedWeightTotalPct ?? '?'}% disclosed across ${g.lineCount} line(s))`}
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <Section title="Parser and import failures" panel={payload.import_failures}>
        {failures && (
          <>
            <p>
              {failures.batchCount} disclosure batch(es) — {failures.succeeded} succeeded, <strong>{failures.failed} failed</strong>,{' '}
              {failures.running} running. Rejection rate{' '}
              {failures.rejectionRate === null ? <em>unknown (no rows read)</em> : `${(failures.rejectionRate * 100).toFixed(1)}%`}.
              Last success {failures.lastSuccessAt ?? 'never'}.
            </p>
            <ul>
              {failures.recentFailures.slice(0, 10).map((b) => (
                <li key={b.id}><code>{b.status}</code> {b.startedAt} {b.errorCode ? `— ${b.errorCode}` : ''}</li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <Section title="Source changes" panel={payload.source_changes}>
        {payload.source_changes?.data && (
          <>
            <p>
              {payload.source_changes.data.observationCount} import(s) compared.{' '}
              <strong>{payload.source_changes.data.changes.length} change(s) detected.</strong> A layout change is
              reported even when both imports succeeded — a successful import of a silently renamed column is
              the dangerous case, because nobody looks at it.
            </p>
            <ul>
              {payload.source_changes.data.changes.slice(0, 10).map((c, i) => (
                <li key={i}><code>{c.kind}</code> — {c.detail}</li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <Section title="Blocked sources — awaiting a Product Owner decision" panel={payload.blocked_sources}>
        <ul>
          {(payload.blocked_sources?.data ?? []).map((s) => (
            <li key={s.label} style={{ marginBottom: '0.5rem' }}>
              <strong>{s.label}</strong> ({s.licence}) — {s.reason}
              {s.termsUrl ? <> <a href={s.termsUrl} target="_blank" rel="noreferrer">Reference</a></> : null}
            </li>
          ))}
        </ul>
      </Section>
    </main>
  );
}
