'use client';

import { useEffect, useState } from 'react';
import { PC6_REFERENCE_SOURCES } from '@/lib/config/investment-intelligence/pc6ReferenceSources';
import {
  buildCorrectionView,
  buildImportBatchView,
  formatDateDMY,
  formatDateTimeDMY,
  localiseIsoDatesInText,
} from '@/lib/services/investment-intelligence/pc6/referenceDataQualityView';
import { ImportBatchesPanel } from '@/components/admin/referenceDataQuality/ImportBatchesPanel';
import { CorrectionsPanel } from '@/components/admin/referenceDataQuality/CorrectionsPanel';
import {
  ApprovedFallbackList,
  BlockedSourcesList,
  type ApprovedFallbackRow,
  type BlockedSourceRow,
} from '@/components/admin/referenceDataQuality/SourceRegisterPanels';

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
// One control (added 2026-09-20, PO instruction): "Re-run" next to each
// scheduled job. It is NOT a way to correct reference data — it calls the
// exact same deterministic ingest the nightly cron calls, through the same
// kill switch, for when a night's run failed and an admin wants to retry the
// tail without a terminal. See the API route's POST handler.

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
  job_control?: Panel<Array<{ job_key: string; enabled: boolean; disabled_reason: string | null; last_success_at: string | null; last_failure_at?: string | null; consecutive_failures: number }>>;
  blocked_sources?: Panel<BlockedSourceRow[]>;
  approved_fallback_sources?: Panel<ApprovedFallbackRow[]>;
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

// job_key -> the sourceConfigId that job runs. Not a mechanical string
// transform (pc6_amfi_daily_nav's source is amfi_nav_daily, not
// amfi_daily_nav), so kept as an explicit, honest lookup rather than a
// pattern that would silently misfire if a new job's naming didn't match.
const JOB_SOURCE_CONFIG: Record<string, string> = {
  pc6_amfi_scheme_master: 'amfi_scheme_master',
  pc6_amfi_daily_nav: 'amfi_nav_daily',
};

// Feeds that are scheduled to run: one with no run at all in the loaded window is shown as missed.
const EXPECTED_FEEDS = Object.values(JOB_SOURCE_CONFIG);
// Staleness is judged only for scheduled feeds: a one-off backfill window is not expected to be recent.
const STALE_AFTER_DAYS_BY_FEED: Record<string, number> = Object.fromEntries(
  EXPECTED_FEEDS.map((id) => [id, PC6_REFERENCE_SOURCES[id].staleAfterDays])
);

export default function ReferenceDataQualityClient() {
  const [payload, setPayload] = useState<QualityPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState<string | null>(null);
  const [rerunResult, setRerunResult] = useState<{ jobKey: string; status: string; detail: string } | null>(null);

  async function load() {
    try {
      const r = await fetch('/api/admin/investment-intelligence/reference-data-quality');
      const j = await r.json();
      if (!r.ok) {
        setError(typeof j.error === 'string' ? j.error : `Request failed (${r.status})`);
        return;
      }
      setPayload(j.data as QualityPayload);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load reference-data quality');
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!cancelled) await load();
    })();
    return () => { cancelled = true; };
  }, []);

  async function handleRerun(jobKey: string) {
    const sourceConfigId = JOB_SOURCE_CONFIG[jobKey];
    if (!sourceConfigId) return;
    setRerunning(jobKey);
    setRerunResult(null);
    try {
      const r = await fetch('/api/admin/investment-intelligence/reference-data-quality', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceConfigId, jobKey }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(typeof j.error === 'string' ? j.error : `Request failed (${r.status})`);
      setRerunResult({ jobKey, status: j.data.status, detail: j.data.detail });
      await load(); // refresh job_control/import_batches so the new attempt shows immediately
    } catch (e) {
      setRerunResult({ jobKey, status: 'error', detail: e instanceof Error ? e.message : 'Re-run failed' });
    } finally {
      setRerunning(null);
    }
  }

  if (error) return <main style={{ padding: '1.5rem' }}><h1>Reference Data Quality</h1><p><strong>Unavailable.</strong> {error}</p></main>;
  if (!payload) return <main style={{ padding: '1.5rem' }}><h1>Reference Data Quality</h1><p>Loading…</p></main>;

  const importView = payload.import_batches?.data
    ? buildImportBatchView(payload.import_batches.data, {
        asOfDate: payload.asOfDate,
        staleAfterDaysByFeed: STALE_AFTER_DAYS_BY_FEED,
        expectedFeeds: EXPECTED_FEEDS,
      })
    : null;
  const correctionView = payload.corrections?.data ? buildCorrectionView(payload.corrections.data) : null;
  const nav = payload.nav_freshness?.data;
  const bm = payload.benchmark_mapping_gaps?.data;

  return (
    <main style={{ padding: '1.5rem', maxWidth: 1100 }}>
      <h1 style={{ fontSize: '1.4rem', fontWeight: 700 }}>Reference Data Quality</h1>
      <p style={{ opacity: 0.75, marginBottom: '1.5rem' }}>
        External market reference data only — scheme identity, NAV history, benchmarks, risk-free rates.
        Nothing here is derived from any user&apos;s holdings, and nothing here overrides what a user&apos;s
        statement said. As at {formatDateDMY(payload.asOfDate) ?? 'unknown date'}, generated{' '}
        {formatDateTimeDMY(payload.generatedAt) ?? 'at an unknown time'}.
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
                    {s.instrumentId} — last observation {formatDateDMY(s.latestAsOf) ?? 'never ingested'}
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
            {bm.mapped} of {bm.totalFunds} funds mapped; <strong>{bm.unmapped} unmapped</strong>. {localiseIsoDatesInText(bm.note)}
          </p>
        )}
      </Section>

      <Section title="Scheme mapping gaps" panel={payload.scheme_mapping_gaps}>
        <p>{payload.scheme_mapping_gaps?.data?.length ?? 0} scheme-master row(s) with no resolved instrument.</p>
      </Section>

      <Section title="Import batches — including failures and the last successful run" panel={payload.import_batches}>
        {importView && <ImportBatchesPanel view={importView} />}
      </Section>

      <Section title="Unusual jumps and outliers" panel={payload.outliers}>
        <p>{payload.outliers?.data?.length ?? 0} observation(s) flagged for review. A flagged value is stored and shown as flagged — never deleted or corrected automatically.</p>
      </Section>

      <Section title="Source corrections" panel={payload.corrections}>
        {correctionView && <CorrectionsPanel view={correctionView} />}
      </Section>

      <Section title="Risk-free freshness and governance" panel={payload.risk_free}>
        <ul>
          {Object.entries(payload.risk_free?.data ?? {}).map(([cc, v]) => (
            <li key={cc}>
              <strong>{cc}</strong> — {v.status}. {localiseIsoDatesInText(v.detail ?? '')} Freshness: {v.freshness.state} ({localiseIsoDatesInText(v.freshness.detail)})
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Scheduled jobs and kill switch" panel={payload.job_control}>
        <ul>
          {(payload.job_control?.data ?? []).map((j) => (
            <li key={j.job_key} style={{ marginBottom: '0.5rem' }}>
              <code>{j.job_key}</code> — {j.enabled ? 'enabled' : 'DISABLED'}
              {j.disabled_reason ? `: ${localiseIsoDatesInText(j.disabled_reason)}` : ''}. Last success {formatDateTimeDMY(j.last_success_at) ?? 'never'}; last failure {formatDateTimeDMY(j.last_failure_at) ?? 'none recorded'}; consecutive failures {j.consecutive_failures}.
              {JOB_SOURCE_CONFIG[j.job_key] && (
                <>
                  {' '}
                  <button
                    onClick={() => handleRerun(j.job_key)}
                    disabled={rerunning === j.job_key}
                    style={{ marginLeft: '0.5rem', padding: '0.15rem 0.6rem', fontSize: '0.85rem' }}
                  >
                    {rerunning === j.job_key ? 'Running…' : 'Re-run'}
                  </button>
                  {rerunResult?.jobKey === j.job_key && (
                    <span style={{ marginLeft: '0.5rem', opacity: 0.85 }}>
                      → <code>{rerunResult.status}</code>: {localiseIsoDatesInText(rerunResult.detail)}
                    </span>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Blocked sources — awaiting a Product Owner decision" panel={payload.blocked_sources}>
        <BlockedSourcesList rows={payload.blocked_sources?.data ?? []} />
      </Section>

      <Section title="Approved fallback sources" panel={payload.approved_fallback_sources}>
        <ApprovedFallbackList rows={payload.approved_fallback_sources?.data ?? []} />
      </Section>
    </main>
  );
}
