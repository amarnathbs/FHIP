'use client';

import { useEffect, useState } from 'react';

// PC6/N.11 — read-only operator view of reference-market-data health.
//
// ADMIN STANDARD §8 (result-state semantics). Every panel renders exactly one
// of `ok` / `unavailable`, and never a bare 0 standing in for "we do not
// know". A feed that has never been ingested is shown as "never ingested",
// which is a different thing from "0 days stale".
//
// ADMIN STANDARD §9 (privacy). Nothing rendered here is derived from any
// user's data. Every table behind this screen is global reference data with no
// tenancy column at all, so there is no cohort to suppress and no person to
// re-identify — see the API route's own §9 analysis.
//
// READ-ONLY. There is no control on this page that writes anything. A surface
// that lets an admin CORRECT reference data is a separate, separately-named
// capability and is out of PC6's scope (§5, §14).

interface Panel<T = unknown> {
  state: 'ok' | 'unavailable';
  data?: T;
  reason?: string;
}

interface QualityPayload {
  asOfDate: string;
  generatedAt: string;
  nav_freshness?: Panel<{ thresholdDays: number; seriesCount: number; fresh: number; stale: number; stalest: Array<{ instrumentId: string; latestAsOf: string | null; ageDays: number | null }> }>;
  benchmark_mapping_gaps?: Panel<{ totalFunds: number; mapped: number; unmapped: number; note: string }>;
  import_batches?: Panel<Array<Record<string, unknown>>>;
  outliers?: Panel<Array<Record<string, unknown>>>;
  corrections?: Panel<Array<Record<string, unknown>>>;
  risk_free?: Panel<Record<string, { status: string; detail?: string; freshness: { state: string; detail: string } }>>;
  job_control?: Panel<Array<{ job_key: string; enabled: boolean; disabled_reason: string | null; last_success_at: string | null; consecutive_failures: number }>>;
  blocked_sources?: Panel<Array<{ sourceKey: string; label: string; licence: string; reason: string; termsUrl: string | null }>>;
  scheme_mapping_gaps?: Panel<Array<Record<string, unknown>>>;
}

function Section({ title, panel, children }: { title: string; panel?: Panel<unknown>; children?: React.ReactNode }) {
  return (
    <section style={{ marginBottom: '2rem' }}>
      <h2 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.5rem' }}>{title}</h2>
      {!panel ? (
        <p style={{ opacity: 0.7 }}>Not requested.</p>
      ) : panel.state === 'unavailable' ? (
        // §8/§13: an unavailable panel says WHY. It never renders as a healthy
        // empty list, and never as a zero.
        <p style={{ opacity: 0.85 }}>
          <strong>Unavailable.</strong> {panel.reason}
        </p>
      ) : (
        children
      )}
    </section>
  );
}

export default function ReferenceDataQualityClient() {
  const [payload, setPayload] = useState<QualityPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/admin/investment-intelligence/reference-data-quality');
        const j = await r.json();
        if (cancelled) return;
        if (!r.ok) {
          setError(typeof j.error === 'string' ? j.error : `Request failed (${r.status})`);
          return;
        }
        setPayload(j.data as QualityPayload);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load reference-data quality');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (error) return <main style={{ padding: '1.5rem' }}><h1>Reference Data Quality</h1><p><strong>Unavailable.</strong> {error}</p></main>;
  if (!payload) return <main style={{ padding: '1.5rem' }}><h1>Reference Data Quality</h1><p>Loading…</p></main>;

  const nav = payload.nav_freshness?.data;
  const bm = payload.benchmark_mapping_gaps?.data;

  return (
    <main style={{ padding: '1.5rem', maxWidth: 1100 }}>
      <h1 style={{ fontSize: '1.4rem', fontWeight: 700 }}>Reference Data Quality</h1>
      <p style={{ opacity: 0.75, marginBottom: '1.5rem' }}>
        External market reference data only — scheme identity, NAV history, benchmarks, risk-free rates.
        Nothing here is derived from any user&apos;s holdings, and nothing here overrides what a user&apos;s
        statement said. As at {payload.asOfDate}, generated {new Date(payload.generatedAt).toLocaleString()}.
      </p>

      <Section title="NAV freshness" panel={payload.nav_freshness}>
        {nav && (
          <>
            <p>
              {nav.seriesCount} series tracked — <strong>{nav.fresh} fresh</strong>, <strong>{nav.stale} stale</strong>{' '}
              (threshold {nav.thresholdDays} days). Freshness is judged per series, not per file: one AMFI download
              legitimately contains both today&apos;s NAV and a wound-up scheme&apos;s final NAV from years ago.
            </p>
            {nav.stalest.length > 0 && (
              <ul>
                {nav.stalest.slice(0, 10).map((s) => (
                  <li key={s.instrumentId}>
                    {s.instrumentId} — last observation {s.latestAsOf ?? 'never ingested'}
                    {s.ageDays !== null ? ` (${s.ageDays} days old)` : ''}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Section>

      <Section title="Benchmark mapping gaps" panel={payload.benchmark_mapping_gaps}>
        {bm && (
          <p>
            {bm.mapped} of {bm.totalFunds} funds mapped; <strong>{bm.unmapped} unmapped</strong>. {bm.note}
          </p>
        )}
      </Section>

      <Section title="Scheme mapping gaps" panel={payload.scheme_mapping_gaps}>
        <p>{payload.scheme_mapping_gaps?.data?.length ?? 0} scheme-master row(s) with no resolved instrument.</p>
      </Section>

      <Section title="Import batches — including failures and the last successful run" panel={payload.import_batches}>
        <ul>
          {(payload.import_batches?.data ?? []).slice(0, 15).map((b, i) => (
            <li key={String(b.id ?? i)}>
              <code>{String(b.status)}</code> {String(b.source_config_id)} as at {String(b.as_of_date)} — read{' '}
              {String(b.rows_read)}, accepted {String(b.rows_accepted)}, rejected {String(b.rows_rejected)}, inserted{' '}
              {String(b.rows_inserted)}, unchanged {String(b.rows_unchanged)}, superseded {String(b.rows_superseded)}
              {b.error_code ? ` — ${String(b.error_code)}: ${String(b.error_detail ?? '')}` : ''}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Unusual jumps and outliers" panel={payload.outliers}>
        <p>{payload.outliers?.data?.length ?? 0} observation(s) flagged for review. A flagged value is stored and shown as flagged — never deleted or corrected automatically.</p>
      </Section>

      <Section title="Source corrections" panel={payload.corrections}>
        <ul>
          {(payload.corrections?.data ?? []).slice(0, 15).map((c, i) => (
            <li key={String(c.id ?? i)}>
              {String(c.created_at)} — {String(c.correction_kind)} on {String(c.target_table)} by {String(c.actor_kind)}: {String(c.reason)}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Risk-free freshness and governance" panel={payload.risk_free}>
        <ul>
          {Object.entries(payload.risk_free?.data ?? {}).map(([cc, v]) => (
            <li key={cc}>
              <strong>{cc}</strong> — {v.status}. {v.detail ?? ''} Freshness: {v.freshness.state} ({v.freshness.detail})
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Scheduled jobs and kill switch" panel={payload.job_control}>
        <ul>
          {(payload.job_control?.data ?? []).map((j) => (
            <li key={j.job_key}>
              <code>{j.job_key}</code> — {j.enabled ? 'enabled' : 'DISABLED'}
              {j.disabled_reason ? `: ${j.disabled_reason}` : ''}. Last success {j.last_success_at ?? 'never'}; consecutive failures {j.consecutive_failures}.
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Blocked sources — awaiting a Product Owner decision" panel={payload.blocked_sources}>
        <ul>
          {(payload.blocked_sources?.data ?? []).map((s) => (
            <li key={s.label} style={{ marginBottom: '0.5rem' }}>
              <strong>{s.label}</strong> ({s.licence}) — {s.reason}
              {s.termsUrl ? <> <a href={s.termsUrl} target="_blank" rel="noreferrer">Terms</a></> : null}
            </li>
          ))}
        </ul>
      </Section>
    </main>
  );
}
