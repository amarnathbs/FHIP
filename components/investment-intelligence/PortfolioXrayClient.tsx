'use client';

import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from 'recharts';

// R5 — Portfolio X-Ray UX (spec sections 98-99).
//
// THE RULE THIS FILE EXISTS TO ENFORCE (directly extending R4's own
// benchmark-coverage lesson): 0% holdings coverage MUST NOT render as an
// all-zero sector chart that looks like a real portfolio. When the API
// reports `available: false`, this component renders an explicit
// "Data unavailable" state and draws NO charts at all.
//
// Coverage and both as-of dates are displayed on every view. Portfolio
// positions as-at and fund-holdings as-at legitimately differ, and that
// difference is always visible.
//
// Nothing here classifies an overlap or concentration level as good or bad,
// and nothing suggests buying, selling, or switching a fund.

const SECTOR_COLOURS = ['#2563EB', '#0F766E', '#B45309', '#7C3AED', '#BE123C', '#0369A1', '#4D7C0F', '#A21CAF', '#C2410C', '#475569'];

interface Bucket {
  key: string;
  label: string;
  effectiveWeight: number;
  securityCount: number;
}
interface XrayResponse {
  empty: boolean;
  available?: boolean;
  message?: string;
  unavailableReason?: string;
  warnings?: Array<{ scope: string; detail: string }>;
  asOfDate?: string;
  portfolioAsOfDate?: string;
  holdingsAsOfDate?: string | null;
  oldestHoldingsDate?: string | null;
  currencyCode?: string | null;
  totalPortfolioValue?: number;
  dataQuality?: {
    effectiveCoverage: number;
    schemeCoverage: number;
    holdingsCoverageWithinSchemes: number;
    freshness: string;
    qualityStatuses: string[];
    portfolioConclusionSuppressed: boolean;
    mixedDateWarning: boolean;
    mixedDateSpreadDays: number | null;
    statement: string;
  };
  topHoldings?: Array<{
    canonicalId: string;
    name: string;
    effectiveWeight: number;
    effectiveValue: number;
    schemeCount: number;
    contributingFunds: Array<{ fundName: string; portfolioWeight: number; holdingWeightInFund: number; contribution: number }>;
    sectorCode: string | null;
    marketCapClass: string | null;
  }>;
  securityConcentration?: { status: string; top1?: number; top5?: number; top10?: number; hhi?: number; hhiConvention: string; securityCount?: number; detail?: string };
  schemeConcentration?: { status: string; top1?: number; top5?: number; hhi?: number; detail?: string };
  sectorExposure?: { status: string; buckets: Bucket[]; classifiedWeight: number; unclassifiedWeight: number; classificationVersion: string | null; detail?: string };
  marketCapExposure?: { status: string; buckets: Bucket[]; classifiedWeight: number; unclassifiedWeight: number; detail?: string };
  industryExposure?: { status: string; buckets: Bucket[]; detail?: string };
  amcConcentration?: { status: string; buckets: Array<{ amcId: string; amcName: string; value: number; weight: number; schemeCount: number }>; unattributedWeight: number; detail?: string };
  fundManagerConcentration?: { status: string; detail: string };
  preservedBuckets?: { cashWeight: number; derivativeWeight: number; otherWeight: number; unresolvedWeight: number; noSnapshotWeight: number; undisclosedRemainderWeight: number };
  debt?: {
    applicable: boolean;
    creditQuality?: { status: string; buckets: Bucket[]; consolidationSuppressed?: boolean; detail?: string };
    maturity?: { status: string; buckets: Bucket[]; detail?: string };
    duration?: { status: string; weightedModifiedDuration?: number; detail?: string };
    issuerConcentration?: { status: string; buckets: Array<{ issuerId: string; issuerName: string; effectiveWeight: number }>; detail?: string };
  };
}

interface OverlapResponse {
  empty: boolean;
  available?: boolean;
  message?: string;
  matrix?: { fundIds: string[]; fundNames: string[]; values: Array<Array<number | null>> };
  pairs?: Array<{ fundAId: string; fundBId: string; weightedOverlap: number | null; commonSecurityCount: number | null; topCommonHoldings: Array<{ displayName: string; overlapContribution: number }> | null; qualityWarning: string | null }>;
}

function fmtPct(v: number | null | undefined, dp = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(dp)}%`;
}
function fmtMoney(v: number | null | undefined, currency: string | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const c = currency ?? 'INR';
  return new Intl.NumberFormat(c === 'INR' ? 'en-IN' : 'en-AU', { style: 'currency', currency: c, maximumFractionDigits: 0 }).format(v);
}

function DataUnavailable({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="rounded border border-dashed border-slate-300 bg-slate-50 px-4 py-4 text-sm text-slate-600" data-testid="xray-unavailable">
      <p className="font-medium text-slate-800">{title}</p>
      {detail ? <p className="mt-1 leading-snug">{detail}</p> : null}
    </div>
  );
}

function FreshnessBadge({ freshness }: { freshness: string }) {
  const label =
    freshness === 'CURRENT' ? 'Current' : freshness === 'ACCEPTABLE' ? 'Recent' : freshness === 'STALE' ? 'Older data' : freshness === 'VERY_STALE' ? 'Much older data' : 'No holdings data';
  const tone =
    freshness === 'CURRENT' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : freshness === 'ACCEPTABLE' ? 'bg-sky-50 text-sky-800 border-sky-200' : 'bg-amber-50 text-amber-900 border-amber-200';
  return <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${tone}`} data-testid="freshness-badge">{label}</span>;
}

export function PortfolioXrayClient() {
  const [data, setData] = useState<XrayResponse | null>(null);
  const [overlap, setOverlap] = useState<OverlapResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'overview' | 'overlap'>('overview');

  // All state updates happen after an await, so nothing is set synchronously
  // during the effect body (which would cause cascading renders).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [xr, ov] = await Promise.all([fetch('/api/investment-intelligence/xray'), fetch('/api/investment-intelligence/xray/overlap')]);
        const xb = await xr.json();
        const ob = await ov.json();
        if (cancelled) return;
        if (!xr.ok) throw new Error(xb?.error ?? 'Request failed');
        setData(xb.data as XrayResponse);
        setOverlap(ov.ok ? (ob.data as OverlapResponse) : null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Unknown error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <p className="text-sm text-muted">Loading portfolio X-Ray…</p>;
  if (error) return <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">Could not load portfolio X-Ray: {error}</div>;
  if (!data) return null;
  if (data.empty) return <div className="rounded border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">{data.message}</div>;

  const dq = data.dataQuality;
  const currency = data.currencyCode;

  return (
    <div className="space-y-6">
      {/* As-of dates — portfolio and holdings shown separately, always. */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded border border-slate-200 bg-white px-4 py-3 text-sm" data-testid="xray-as-of">
        <span className="text-muted">
          Positions as at <strong className="text-ink">{data.portfolioAsOfDate}</strong>
        </span>
        <span className="text-muted">
          Fund holdings as at <strong className="text-ink">{data.holdingsAsOfDate ?? 'not available'}</strong>
          {data.oldestHoldingsDate && data.oldestHoldingsDate !== data.holdingsAsOfDate ? ` (oldest ${data.oldestHoldingsDate})` : ''}
        </span>
        {dq && <FreshnessBadge freshness={dq.freshness} />}
        {dq && (
          <span className="text-muted" data-testid="xray-coverage">
            Coverage <strong className="text-ink">{fmtPct(dq.effectiveCoverage)}</strong>
          </span>
        )}
      </div>

      {dq && <p className="rounded border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700" data-testid="xray-coverage-statement">{dq.statement}</p>}

      {(data.warnings ?? []).length > 0 && (
        <ul className="space-y-1 rounded border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {data.warnings!.map((w, i) => (
            <li key={i}>{w.detail}</li>
          ))}
        </ul>
      )}

      <nav className="flex gap-2 border-b border-slate-200">
        {(['overview', 'overlap'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium ${tab === t ? 'border-b-2 border-blue-600 text-blue-700' : 'text-slate-600 hover:text-slate-900'}`}
          >
            {t === 'overview' ? 'Exposure overview' : 'Fund overlap'}
          </button>
        ))}
      </nav>

      {tab === 'overview' ? (
        <div className="space-y-6">
          {/* THE CRITICAL BRANCH: unavailable renders NO charts, never zeros. */}
          {!data.available ? (
            <DataUnavailable
              title="Underlying holdings analysis is not available"
              detail={
                data.unavailableReason ??
                'No fund holdings disclosures are available for the schemes in this portfolio, so exposure to underlying securities cannot be calculated. No exposure figures are shown.'
              }
            />
          ) : (
            <>
              {/* Top holdings */}
              <section className="rounded-lg border border-slate-200 bg-white p-5">
                <h2 className="text-base font-semibold text-ink">Largest underlying holdings</h2>
                <p className="mt-1 text-xs text-muted">
                  Your effective exposure to each security after looking through every fund. Based on {fmtPct(dq?.effectiveCoverage)} of the portfolio.
                </p>
                <div className="mt-4 overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-muted">
                        <th className="py-2 pr-4">Security</th>
                        <th className="py-2 pr-4">Effective weight</th>
                        <th className="py-2 pr-4">Value</th>
                        <th className="py-2 pr-4">Held via</th>
                        <th className="py-2">Sector</th>
                      </tr>
                    </thead>
                    <tbody data-testid="top-holdings-body">
                      {(data.topHoldings ?? []).map((h) => (
                        <tr key={h.canonicalId} className="border-b border-slate-100">
                          <td className="py-2 pr-4 font-medium text-ink">{h.name}</td>
                          <td className="py-2 pr-4">{fmtPct(h.effectiveWeight, 2)}</td>
                          <td className="py-2 pr-4">{fmtMoney(h.effectiveValue, currency)}</td>
                          <td className="py-2 pr-4">
                            {h.schemeCount} scheme{h.schemeCount === 1 ? '' : 's'}
                            <span className="block text-xs text-muted">{h.contributingFunds.map((f) => f.fundName).join(', ')}</span>
                          </td>
                          <td className="py-2 text-xs text-slate-600">{h.sectorCode ?? 'Not classified'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              {/* Sector exposure */}
              <section className="rounded-lg border border-slate-200 bg-white p-5">
                <h2 className="text-base font-semibold text-ink">Sector exposure</h2>
                {data.sectorExposure?.status === 'ok' ? (
                  <>
                    <div className="mt-3 h-64 w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={data.sectorExposure.buckets.map((b) => ({ name: b.label, weight: b.effectiveWeight * 100 }))} layout="vertical" margin={{ left: 80 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                          <XAxis type="number" tick={{ fontSize: 10 }} unit="%" />
                          <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={80} />
                          <Tooltip formatter={(v: number) => `${v.toFixed(2)}%`} />
                          <Bar dataKey="weight" isAnimationActive={false}>
                            {data.sectorExposure.buckets.map((_, i) => (
                              <Cell key={i} fill={SECTOR_COLOURS[i % SECTOR_COLOURS.length]} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                    <p className="mt-2 text-xs text-muted">
                      Classified: {fmtPct(data.sectorExposure.classifiedWeight)} · Not classified: {fmtPct(data.sectorExposure.unclassifiedWeight)}
                      {data.sectorExposure.classificationVersion ? ` · Classification ${data.sectorExposure.classificationVersion}` : ''}
                    </p>
                  </>
                ) : (
                  <div className="mt-3">
                    <DataUnavailable title="Sector exposure is not available" detail={data.sectorExposure?.detail} />
                  </div>
                )}
              </section>

              {/* Market cap */}
              <section className="rounded-lg border border-slate-200 bg-white p-5">
                <h2 className="text-base font-semibold text-ink">Market-cap exposure</h2>
                {data.marketCapExposure?.status === 'ok' ? (
                  <>
                    <dl className="mt-3 grid gap-4 sm:grid-cols-4">
                      {data.marketCapExposure.buckets.map((b) => (
                        <div key={b.key}>
                          <dt className="text-xs uppercase tracking-wide text-muted">{b.label}</dt>
                          <dd className="mt-1 text-lg font-semibold text-ink">{fmtPct(b.effectiveWeight)}</dd>
                        </div>
                      ))}
                    </dl>
                    <p className="mt-2 text-xs text-muted">Not classified: {fmtPct(data.marketCapExposure.unclassifiedWeight)}</p>
                  </>
                ) : (
                  <div className="mt-3">
                    <DataUnavailable title="Market-cap exposure is not available" detail={data.marketCapExposure?.detail} />
                  </div>
                )}
              </section>

              {/* Concentration */}
              <section className="rounded-lg border border-slate-200 bg-white p-5">
                <h2 className="text-base font-semibold text-ink">Concentration</h2>
                {data.securityConcentration?.status === 'ok' ? (
                  <dl className="mt-3 grid gap-4 sm:grid-cols-4">
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-muted">Largest holding</dt>
                      <dd className="mt-1 text-lg font-semibold text-ink">{fmtPct(data.securityConcentration.top1, 2)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-muted">Top 5</dt>
                      <dd className="mt-1 text-lg font-semibold text-ink">{fmtPct(data.securityConcentration.top5, 2)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-muted">Top 10</dt>
                      <dd className="mt-1 text-lg font-semibold text-ink">{fmtPct(data.securityConcentration.top10, 2)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs uppercase tracking-wide text-muted">Securities</dt>
                      <dd className="mt-1 text-lg font-semibold text-ink">{data.securityConcentration.securityCount}</dd>
                    </div>
                  </dl>
                ) : (
                  <div className="mt-3">
                    <DataUnavailable title="Concentration is not available" detail={data.securityConcentration?.detail} />
                  </div>
                )}
              </section>

              {/* Preserved buckets — the honest remainder */}
              {data.preservedBuckets && (
                <section className="rounded-lg border border-slate-200 bg-slate-50 p-5 text-sm">
                  <h2 className="text-base font-semibold text-ink">What is not in the breakdown above</h2>
                  <p className="mt-1 text-xs text-muted">
                    These portions are shown separately rather than spread across the securities above, so the percentages stay honest.
                  </p>
                  <dl className="mt-3 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
                    {[
                      ['Cash', data.preservedBuckets.cashWeight],
                      ['Derivatives', data.preservedBuckets.derivativeWeight],
                      ['Other', data.preservedBuckets.otherWeight],
                      ['Unidentified holdings', data.preservedBuckets.unresolvedWeight],
                      ['Schemes with no disclosure', data.preservedBuckets.noSnapshotWeight],
                      ['Not disclosed', data.preservedBuckets.undisclosedRemainderWeight],
                    ].map(([label, v]) => (
                      <div key={label as string}>
                        <dt className="text-xs text-muted">{label as string}</dt>
                        <dd className="font-medium text-ink">{fmtPct(v as number)}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              )}

              {/* Debt — shown ONLY when genuine debt holdings exist */}
              {data.debt?.applicable && (
                <section className="rounded-lg border border-slate-200 bg-white p-5">
                  <h2 className="text-base font-semibold text-ink">Debt holdings</h2>
                  <div className="mt-3 grid gap-6 lg:grid-cols-2">
                    <div>
                      <h3 className="text-sm font-semibold text-ink">Credit quality</h3>
                      {data.debt.creditQuality?.status === 'ok' ? (
                        <ul className="mt-2 space-y-1 text-sm">
                          {data.debt.creditQuality.buckets.map((b: Bucket) => (
                            <li key={b.key} className="flex justify-between">
                              <span className="text-slate-700">{b.label}</span>
                              <span className="font-medium text-ink">{fmtPct(b.effectiveWeight, 2)}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="mt-2">
                          <DataUnavailable title="Credit-quality breakdown is not available" detail={data.debt.creditQuality?.detail} />
                        </div>
                      )}
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-ink">Maturity profile</h3>
                      {data.debt.maturity?.status === 'ok' ? (
                        <ul className="mt-2 space-y-1 text-sm">
                          {data.debt.maturity.buckets.map((b: Bucket) => (
                            <li key={b.key} className="flex justify-between">
                              <span className="text-slate-700">{b.label}</span>
                              <span className="font-medium text-ink">{fmtPct(b.effectiveWeight, 2)}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="mt-2">
                          <DataUnavailable title="Maturity profile is not available" detail={data.debt.maturity?.detail} />
                        </div>
                      )}
                      <h3 className="mt-4 text-sm font-semibold text-ink">Modified duration</h3>
                      {data.debt.duration?.status === 'ok' && data.debt.duration.weightedModifiedDuration !== undefined ? (
                        <p className="mt-1 text-lg font-semibold text-ink">{data.debt.duration.weightedModifiedDuration.toFixed(2)} years</p>
                      ) : (
                        <div className="mt-1">
                          <DataUnavailable title="Duration is not available" detail={data.debt.duration?.detail} />
                        </div>
                      )}
                    </div>
                  </div>
                </section>
              )}
            </>
          )}

          {/* Scheme-level analyses stay valid even at zero look-through coverage. */}
          <section className="rounded-lg border border-slate-200 bg-white p-5">
            <h2 className="text-base font-semibold text-ink">Fund house concentration</h2>
            {data.amcConcentration?.status === 'ok' ? (
              <ul className="mt-3 space-y-1 text-sm">
                {data.amcConcentration.buckets.map((b) => (
                  <li key={b.amcId} className="flex justify-between">
                    <span className="text-slate-700">
                      {b.amcName} <span className="text-xs text-muted">({b.schemeCount} scheme{b.schemeCount === 1 ? '' : 's'})</span>
                    </span>
                    <span className="font-medium text-ink">{fmtPct(b.weight)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="mt-3">
                <DataUnavailable title="Fund house concentration is not available" detail={data.amcConcentration?.detail} />
              </div>
            )}
            {data.fundManagerConcentration && <p className="mt-4 text-xs text-muted">{data.fundManagerConcentration.detail}</p>}
          </section>
        </div>
      ) : (
        <OverlapPanel overlap={overlap} />
      )}
    </div>
  );
}

/** Overlap heatmap. Descriptive only — no overlap level is labelled good or bad. */
function OverlapPanel({ overlap }: { overlap: OverlapResponse | null }) {
  if (!overlap) return <DataUnavailable title="Fund overlap is not available" />;
  if (overlap.empty) return <DataUnavailable title="Fund overlap is not available" detail={overlap.message} />;
  if (overlap.available === false || !overlap.matrix) {
    return <DataUnavailable title="Fund overlap is not available" detail={overlap.message} />;
  }

  const { fundNames, values } = overlap.matrix;
  // Shade purely by magnitude. Deliberately a single-hue ramp so no colour
  // reads as a warning or an endorsement.
  const shade = (v: number | null) => (v === null ? '#F1F5F9' : `rgba(37, 99, 235, ${Math.max(0.06, Math.min(1, v)) * 0.85})`);

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <h2 className="text-base font-semibold text-ink">How much your funds hold in common</h2>
        <p className="mt-1 text-xs text-muted">
          Each cell is the shared portion of two funds&apos; portfolios, matched by security identity. A higher figure means more of the two funds is the same
          underlying holdings. This is a description of what the funds hold, not a judgement about them.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="text-xs" data-testid="overlap-heatmap">
            <thead>
              <tr>
                <th className="p-2" />
                {fundNames.map((n, i) => (
                  <th key={i} className="max-w-[7rem] p-2 text-left align-bottom font-medium text-slate-700">
                    <span className="block truncate" title={n}>{n}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {values.map((row, i) => (
                <tr key={i}>
                  <th className="max-w-[10rem] p-2 text-left font-medium text-slate-700">
                    <span className="block truncate" title={fundNames[i]}>{fundNames[i]}</span>
                  </th>
                  {row.map((v, j) => (
                    <td key={j} className="p-2 text-center" style={{ backgroundColor: i === j ? '#E2E8F0' : shade(v) }} title={`${fundNames[i]} vs ${fundNames[j]}`}>
                      <span className={v !== null && v > 0.5 ? 'font-medium text-white' : 'text-slate-800'}>{v === null ? '—' : `${(v * 100).toFixed(0)}%`}</span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5">
        <h2 className="text-base font-semibold text-ink">Pair detail</h2>
        <div className="mt-3 space-y-4">
          {(overlap.pairs ?? [])
            .filter((p) => p.weightedOverlap !== null)
            .sort((a, b) => (b.weightedOverlap ?? 0) - (a.weightedOverlap ?? 0))
            .slice(0, 10)
            .map((p, i) => (
              <div key={i} className="border-b border-slate-100 pb-3 last:border-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-ink">
                    {overlap.matrix!.fundNames[overlap.matrix!.fundIds.indexOf(p.fundAId)]} &amp; {overlap.matrix!.fundNames[overlap.matrix!.fundIds.indexOf(p.fundBId)]}
                  </span>
                  <span className="text-sm font-semibold text-ink">{fmtPct(p.weightedOverlap)} in common</span>
                </div>
                <p className="mt-1 text-xs text-muted">{p.commonSecurityCount} securities held by both.</p>
                {(p.topCommonHoldings ?? []).length > 0 && (
                  <ul className="mt-1 text-xs text-slate-700">
                    {p.topCommonHoldings!.map((h, k) => (
                      <li key={k}>
                        {h.displayName} — contributes {fmtPct(h.overlapContribution, 2)}
                      </li>
                    ))}
                  </ul>
                )}
                {p.qualityWarning && <p className="mt-1 text-xs text-amber-800">{p.qualityWarning}</p>}
              </div>
            ))}
        </div>
      </section>
    </div>
  );
}
