'use client';

import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

// R5 — SIP Intelligence UX (spec sections 98-100).
//
// Three rules govern every figure rendered here:
//   1. A metric that is not CALCULATED is NEVER rendered as a number, and
//      never as 0.00%. It renders as an explicit "Not available" state
//      carrying the engine's own reason.
//   2. Every narrative string is an OBSERVATION, EDUCATION, or SIMULATION
//      item. Nothing here tells the user to increase, stop, or switch a SIP.
//   3. A benchmark comparison is only ever shown as "SIP benchmark excess
//      return" over an identical contribution schedule — never as alpha, and
//      never against an ordinary benchmark CAGR.

const PALETTE = { actual: '#2563EB', benchmark: '#9CA3AF', contribution: '#0F766E' };

interface Unavailable {
  status: 'ok' | 'unavailable';
  reason?: string | null;
  detail?: string | null;
}
interface SipSeriesView {
  seriesKey: string;
  instrumentId: string;
  instrumentName: string | null;
  currencyCode: string;
  cadence: string;
  confidence: string;
  confidenceRationale: string;
  trend: string;
  firstContributionDate: string;
  latestContributionDate: string;
  contributionCount: number;
  contributions: Array<{ date: string; amount: number; units: number | null }>;
  activity: { status: string; statement: string; daysSinceLatest?: number };
  consistency: {
    status: string;
    contributionCount?: number;
    expectedPeriods?: number;
    observedPeriods?: number;
    skippedPeriods?: number;
    consistencyPct?: number;
    averageContribution?: number;
    medianContribution?: number;
    minContribution?: number;
    maxContribution?: number;
    totalContributed?: number;
    gaps?: Array<{ fromDate: string; toDate: string; days: number; missedPeriods: number }>;
    detail?: string;
  };
  actualXirr: Unavailable & { rate?: number; terminalValue?: number; totalContributed?: number; positionIsMixed?: boolean };
  benchmarkSip: Unavailable & { rate?: number | null; terminalValue?: number | null; benchmarkKey?: string | null; benchmarkReturnType?: string | null };
  excessReturn: Unavailable & { excessReturn?: number; label: string };
  wealthComparison: Unavailable & { totalContributed?: number; actualEndingValue?: number; benchmarkEndingValue?: number; difference?: number; differencePct?: number };
  timing: Unavailable & { staggeredEndingValue?: number; lumpSumAtStartEndingValue?: number; wealthDifference?: number; statement?: string };
  navAtAsOf: number | null;
  navDateUsed: string | null;
  attribution: { status: string; reason: string | null; positionIsMixed: boolean; detail: string | null };
  observations: Array<{ classification: string; text: string }>;
}
interface SipResponse {
  empty: boolean;
  message?: string;
  warnings?: Array<{ scope: string; detail: string }>;
  asOfDate?: string;
  engineVersion?: string;
  seriesCount?: number;
  presentableCount?: number;
  series?: SipSeriesView[];
  ambiguous?: Array<{ instrumentId: string; instrumentName: string | null; confidence: string; rationale: string }>;
}

function fmtPct(v: number | null | undefined, dp = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(dp)}%`;
}
function fmtMoney(v: number | null | undefined, currency: string): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-AU', { style: 'currency', currency, maximumFractionDigits: 0 }).format(v);
}

/** The ONLY way an unavailable metric is ever rendered. Never a zero. */
function NotAvailable({ reason, detail }: { reason?: string | null; detail?: string | null }) {
  return (
    <div className="rounded border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-600" data-testid="not-available">
      <span className="font-medium">Not available</span>
      {detail ? <p className="mt-1 leading-snug">{detail}</p> : reason ? <p className="mt-1 leading-snug">{reason}</p> : null}
    </div>
  );
}

function ConfidenceBadge({ confidence }: { confidence: string }) {
  const label =
    confidence === 'CONFIRMED_SOURCE'
      ? 'Confirmed by statement'
      : confidence === 'HIGH_CONFIDENCE'
        ? 'Identified by pattern'
        : confidence === 'POSSIBLE'
          ? 'Possible recurring series'
          : confidence === 'AMBIGUOUS'
            ? 'Not clearly recurring'
            : 'Not a recurring series';
  const tone =
    confidence === 'CONFIRMED_SOURCE' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : confidence === 'HIGH_CONFIDENCE' ? 'bg-sky-50 text-sky-800 border-sky-200' : 'bg-amber-50 text-amber-900 border-amber-200';
  return <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${tone}`}>{label}</span>;
}

function ActivityBadge({ status }: { status: string }) {
  const label =
    status === 'EXPECTED' ? 'On schedule' : status === 'LATE' ? 'Next contribution not yet recorded' : status === 'POSSIBLE_PAUSE' ? 'Gap in recorded contributions' : status === 'LIKELY_STOPPED' ? 'No recent recorded activity' : 'Schedule unknown';
  const tone = status === 'EXPECTED' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : status === 'LATE' ? 'bg-slate-50 text-slate-700 border-slate-200' : 'bg-amber-50 text-amber-900 border-amber-200';
  return <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${tone}`}>{label}</span>;
}

export function SipIntelligenceClient() {
  const [data, setData] = useState<SipResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [simulation, setSimulation] = useState<Record<string, unknown> | null>(null);
  const [simLoading, setSimLoading] = useState(false);

  // All state updates happen after an await, so nothing is set synchronously
  // during the effect body (which would cause cascading renders).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/investment-intelligence/sip');
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(body?.error ?? 'Request failed');
        setData(body.data as SipResponse);
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

  async function runSimulation(seriesKey: string) {
    setSimLoading(true);
    setSimulation(null);
    try {
      const res = await fetch('/api/investment-intelligence/sip/simulation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seriesKey }),
      });
      const body = await res.json();
      setSimulation(res.ok ? body.data : { error: body?.error });
    } catch (e) {
      setSimulation({ error: e instanceof Error ? e.message : 'Unknown error' });
    } finally {
      setSimLoading(false);
    }
  }

  if (loading) return <p className="text-sm text-muted">Loading recurring-contribution analysis…</p>;
  if (error) return <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">Could not load SIP analysis: {error}</div>;
  if (!data) return null;

  if (data.empty) {
    return <div className="rounded border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">{data.message}</div>;
  }

  const series = data.series ?? [];

  return (
    <div className="space-y-6">
      {/* As-of date is always displayed and never silently "today". */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted" data-testid="sip-as-of">
        <span>
          Analysis as at <strong className="text-ink">{data.asOfDate}</strong>
        </span>
        <span>
          {data.presentableCount} recurring series identified{(data.ambiguous?.length ?? 0) > 0 ? `, ${data.ambiguous!.length} grouping(s) not clearly recurring` : ''}
        </span>
      </div>

      {(data.warnings ?? []).length > 0 && (
        <ul className="space-y-1 rounded border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {data.warnings!.map((w, i) => (
            <li key={i}>{w.detail}</li>
          ))}
        </ul>
      )}

      {series.length === 0 && (
        <div className="rounded border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          No recurring contribution series were identified in the available transactions. Individual purchases are still included in the performance analysis.
        </div>
      )}

      {series.map((s) => {
        const isOpen = expanded === s.seriesKey;
        return (
          <section key={s.seriesKey} className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm" data-testid="sip-series-card">
            <header className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-ink">{s.instrumentName ?? s.instrumentId}</h2>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <ConfidenceBadge confidence={s.confidence} />
                  <ActivityBadge status={s.activity.status} />
                  <span className="text-xs text-muted">
                    {s.cadence.toLowerCase().replace('_', ' ')} · {s.contributionCount} contributions · {s.firstContributionDate} to {s.latestContributionDate}
                  </span>
                </div>
              </div>
              <button type="button" onClick={() => setExpanded(isOpen ? null : s.seriesKey)} className="rounded border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50">
                {isOpen ? 'Hide detail' : 'Show detail'}
              </button>
            </header>

            <p className="mt-3 text-sm text-slate-700">{s.confidenceRationale}</p>

            <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted">Total contributed</dt>
                <dd className="mt-1 text-lg font-semibold text-ink">{fmtMoney(s.consistency.totalContributed, s.currencyCode)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted">Value of these contributions</dt>
                <dd className="mt-1 text-lg font-semibold text-ink">
                  {s.actualXirr.status === 'ok' ? fmtMoney(s.actualXirr.terminalValue, s.currencyCode) : <span className="text-sm font-normal text-slate-600">Not available</span>}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted">Return on these contributions</dt>
                <dd className="mt-1">
                  {s.actualXirr.status === 'ok' ? (
                    <span className="text-lg font-semibold text-ink">{fmtPct(s.actualXirr.rate)}</span>
                  ) : (
                    <NotAvailable reason={s.actualXirr.reason} detail={s.actualXirr.detail} />
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted">Same contributions in {s.benchmarkSip.benchmarkKey ?? 'the benchmark'}</dt>
                <dd className="mt-1">
                  {s.benchmarkSip.status === 'ok' ? (
                    <span className="text-lg font-semibold text-ink">{fmtPct(s.benchmarkSip.rate)}</span>
                  ) : (
                    <NotAvailable reason={s.benchmarkSip.reason} detail={s.benchmarkSip.detail} />
                  )}
                </dd>
              </div>
            </dl>

            {/* The ONLY valid comparison, explicitly labelled. Never "alpha". */}
            <div className="mt-4 rounded border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="text-xs uppercase tracking-wide text-muted">{s.excessReturn.label}</p>
              {s.excessReturn.status === 'ok' ? (
                <>
                  <p className="mt-1 text-lg font-semibold text-ink">{fmtPct(s.excessReturn.excessReturn)}</p>
                  <p className="mt-1 text-xs text-slate-600">
                    Your money-weighted return minus what the same contributions, on the same dates, would have returned in the benchmark. Both sides use an identical
                    contribution schedule, so the two figures are directly comparable.
                  </p>
                </>
              ) : (
                <div className="mt-1">
                  <NotAvailable reason={s.excessReturn.reason} detail={s.excessReturn.detail} />
                </div>
              )}
            </div>

            {s.attribution.positionIsMixed && (
              <p className="mt-3 rounded border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
                This fund also holds purchases made outside this recurring series. Figures above cover only the units attributable to the recurring contributions,
                reconstructed on a first-in-first-out basis.
              </p>
            )}

            {isOpen && (
              <div className="mt-5 space-y-6 border-t border-slate-200 pt-5">
                {/* Contribution history */}
                <div>
                  <h3 className="text-sm font-semibold text-ink">Contribution history</h3>
                  <div className="mt-2 h-56 w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={s.contributions.map((c) => ({ date: c.date, amount: c.amount }))}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                        <XAxis dataKey="date" tick={{ fontSize: 10 }} minTickGap={24} />
                        <YAxis tick={{ fontSize: 10 }} />
                        <Tooltip formatter={(v: number) => fmtMoney(v, s.currencyCode)} />
                        <Bar dataKey="amount" fill={PALETTE.contribution} name="Contribution" isAnimationActive={false} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                {/* Wealth comparison */}
                <div>
                  <h3 className="text-sm font-semibold text-ink">Value comparison</h3>
                  {s.wealthComparison.status === 'ok' ? (
                    <div className="mt-2 h-56 w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          data={[
                            { label: 'Contributed', value: s.wealthComparison.totalContributed },
                            { label: 'This fund', value: s.wealthComparison.actualEndingValue },
                            { label: s.benchmarkSip.benchmarkKey ?? 'Benchmark', value: s.wealthComparison.benchmarkEndingValue },
                          ]}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                          <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                          <YAxis tick={{ fontSize: 10 }} />
                          <Tooltip formatter={(v: number) => fmtMoney(v, s.currencyCode)} />
                          <Bar dataKey="value" fill={PALETTE.actual} isAnimationActive={false} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <div className="mt-2">
                      <NotAvailable detail={s.wealthComparison.detail} />
                    </div>
                  )}
                </div>

                {/* Consistency */}
                <div>
                  <h3 className="text-sm font-semibold text-ink">Contribution consistency</h3>
                  {s.consistency.status === 'ok' && s.consistency.consistencyPct !== undefined ? (
                    <dl className="mt-2 grid gap-3 text-sm sm:grid-cols-3 lg:grid-cols-5">
                      <div>
                        <dt className="text-xs text-muted">Recorded</dt>
                        <dd className="font-medium text-ink">{s.consistency.observedPeriods} of {s.consistency.expectedPeriods}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted">Consistency</dt>
                        <dd className="font-medium text-ink">{fmtPct(s.consistency.consistencyPct, 0)}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted">Average</dt>
                        <dd className="font-medium text-ink">{fmtMoney(s.consistency.averageContribution, s.currencyCode)}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted">Smallest</dt>
                        <dd className="font-medium text-ink">{fmtMoney(s.consistency.minContribution, s.currencyCode)}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted">Largest</dt>
                        <dd className="font-medium text-ink">{fmtMoney(s.consistency.maxContribution, s.currencyCode)}</dd>
                      </div>
                    </dl>
                  ) : (
                    <div className="mt-2">
                      <NotAvailable detail={s.consistency.detail} />
                    </div>
                  )}
                  {(s.consistency.gaps ?? []).length > 0 && (
                    <ul className="mt-3 space-y-1 text-xs text-slate-700">
                      {s.consistency.gaps!.map((g, i) => (
                        <li key={i}>
                          No contribution recorded between {g.fromDate} and {g.toDate} ({g.days} days).
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* Calculation assumptions */}
                <div className="rounded border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-700">
                  <h3 className="text-sm font-semibold text-ink">How these figures were calculated</h3>
                  <ul className="mt-2 space-y-1">
                    <li>Contributions are treated as money out; redemptions, distributions received, and the closing value as money in.</li>
                    <li>
                      The closing value uses the NAV published on {s.navDateUsed ?? 'the latest available date'}
                      {s.navAtAsOf !== null ? ` (${s.navAtAsOf})` : ''}.
                    </li>
                    <li>
                      The benchmark comparison applies each contribution&apos;s exact amount, on its own date, to {s.benchmarkSip.benchmarkKey ?? 'the mapped benchmark'}
                      {s.benchmarkSip.benchmarkReturnType ? ` (${s.benchmarkSip.benchmarkReturnType})` : ''}. A contribution falling on a non-trading day uses the next
                      available observation.
                    </li>
                    <li>These figures describe what has already happened. They are not a forecast and not a recommendation.</li>
                  </ul>
                </div>

                {/* Timing comparison */}
                {s.timing.status === 'ok' && (
                  <div className="rounded border border-slate-200 px-4 py-3">
                    <h3 className="text-sm font-semibold text-ink">Historical timing comparison</h3>
                    <p className="mt-1 text-xs text-slate-700">{s.timing.statement}</p>
                    <dl className="mt-2 grid gap-3 text-sm sm:grid-cols-3">
                      <div>
                        <dt className="text-xs text-muted">Contributed progressively</dt>
                        <dd className="font-medium text-ink">{fmtMoney(s.timing.staggeredEndingValue, s.currencyCode)}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted">Same total invested at the start</dt>
                        <dd className="font-medium text-ink">{fmtMoney(s.timing.lumpSumAtStartEndingValue, s.currencyCode)}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted">Difference</dt>
                        <dd className="font-medium text-ink">{fmtMoney(s.timing.wealthDifference, s.currencyCode)}</dd>
                      </div>
                    </dl>
                  </div>
                )}

                {/* Simulation */}
                <div>
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-ink">Historical simulation</h3>
                    <button type="button" onClick={() => void runSimulation(s.seriesKey)} className="rounded border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50" disabled={simLoading}>
                      {simLoading ? 'Running…' : 'Run simulation'}
                    </button>
                  </div>
                  {simulation !== null && <SimulationPanel data={simulation} currency={s.currencyCode} />}
                </div>

                {/* Observations */}
                <div>
                  <h3 className="text-sm font-semibold text-ink">What the records show</h3>
                  <ul className="mt-2 space-y-2 text-sm text-slate-700">
                    {s.observations.map((o, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="mt-0.5 shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-600">{o.classification}</span>
                        <span>{o.text}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </section>
        );
      })}

      {(data.ambiguous?.length ?? 0) > 0 && (
        <section className="rounded-lg border border-slate-200 bg-slate-50 p-5">
          <h2 className="text-sm font-semibold text-ink">Groupings that are not clearly recurring</h2>
          <p className="mt-1 text-xs text-slate-600">
            These purchases were not regular enough to identify as a recurring mandate, so they are not shown as SIPs. They remain included in the overall performance
            analysis.
          </p>
          <ul className="mt-3 space-y-2 text-sm text-slate-700">
            {data.ambiguous!.map((a, i) => (
              <li key={i}>
                <strong>{a.instrumentName ?? a.instrumentId}</strong> — {a.rationale}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

interface SimulationAssumptionsView {
  contributionDayRule: string;
  stepUpAnniversaryRule: string;
  nonTradingDateRule: string;
  roundingTreatment: string;
  periodStart: string;
  periodEnd: string;
  distributionsIncluded: boolean | 'unknown';
  methodologyVersion: string;
}
interface SimulationVariant {
  status: 'ok' | 'unavailable';
  label?: string;
  contributionCount?: number;
  totalContributed?: number;
  terminalValue?: number;
  xirrRate?: number;
  detail?: string;
  assumptions?: SimulationAssumptionsView;
}

function SimulationPanel({ data, currency }: { data: Record<string, unknown>; currency: string }) {
  const err = data.error as string | undefined;
  if (err) return <div className="mt-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>;
  if (data.available === false) {
    return <div className="mt-2"><NotAvailable detail={data.message as string} /></div>;
  }
  const variants = (data.variants ?? []) as SimulationVariant[];
  const okVariants = variants.filter((v) => v.status === 'ok');

  return (
    <div className="mt-3 space-y-3">
      {/* Non-negotiable framing, rendered before any number. */}
      <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="simulation-disclaimer">
        <strong>Simulation.</strong> {String(data.disclaimer ?? '')}
      </p>
      {okVariants.length === 0 ? (
        <NotAvailable detail={(variants[0]?.detail as string) ?? 'This simulation could not be produced over the requested period.'} />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-muted">
                  <th className="py-2 pr-4">Schedule</th>
                  <th className="py-2 pr-4">Contributions</th>
                  <th className="py-2 pr-4">Total contributed</th>
                  <th className="py-2 pr-4">Value at end</th>
                  <th className="py-2">Return</th>
                </tr>
              </thead>
              <tbody>
                {okVariants.map((v, i) => (
                  <tr key={i} className="border-b border-slate-100">
                    <td className="py-2 pr-4 font-medium text-ink">{v.label}</td>
                    <td className="py-2 pr-4">{v.contributionCount}</td>
                    <td className="py-2 pr-4">{fmtMoney(v.totalContributed, currency)}</td>
                    <td className="py-2 pr-4">{fmtMoney(v.terminalValue, currency)}</td>
                    <td className="py-2">{fmtPct(v.xirrRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {okVariants[0]?.assumptions && (
            <details className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
              <summary className="cursor-pointer font-medium text-ink">Simulation assumptions</summary>
              <ul className="mt-2 space-y-1">
                <li>{okVariants[0].assumptions.contributionDayRule}</li>
                <li>{okVariants[0].assumptions.stepUpAnniversaryRule}</li>
                <li>{okVariants[0].assumptions.nonTradingDateRule}</li>
                <li>{okVariants[0].assumptions.roundingTreatment}</li>
                <li>
                  Period: {okVariants[0].assumptions.periodStart} to {okVariants[0].assumptions.periodEnd}.
                </li>
                <li>
                  Distributions included in the price series:{' '}
                  {okVariants[0].assumptions.distributionsIncluded === true ? 'yes' : okVariants[0].assumptions.distributionsIncluded === false ? 'no' : 'unknown'}.
                </li>
                <li>Methodology version: {okVariants[0].assumptions.methodologyVersion}</li>
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}
