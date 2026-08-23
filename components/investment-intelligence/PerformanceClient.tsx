'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

// R4 — Performance UX (spec sections 60-65).
//
// Two rules govern every figure rendered here:
//   1. A metric that is not CALCULATED is NEVER rendered as a number, and
//      never as 0.00%. It renders as an explicit "Not available" state
//      carrying the engine's own reason (spec section 66).
//   2. Every narrative string is an OBSERVATION or EDUCATION item — a
//      neutral description of what the number means (spec section 65).
//      Nothing here tells the user to buy, sell, switch or rebalance.

const PALETTE = {
  portfolio: '#2563EB',
  benchmark: '#9CA3AF',
  drawdown: '#C7362F',
};

type CalculationStatus =
  | 'CALCULATED'
  | 'INSUFFICIENT_HISTORY'
  | 'MISSING_REFERENCE_DATA'
  | 'STALE'
  | 'FAILED'
  | 'NOT_APPLICABLE'
  | 'AMBIGUOUS';

interface Outcome<T = Record<string, number | null>> {
  status: CalculationStatus;
  value?: T;
  qualityFlag?: string;
  engineReason?: string;
  detail?: string;
}

interface Annotation {
  flag: string;
  detail: string;
}

interface RollingHorizon {
  windowYears: number;
  series: Outcome<{ min: number; max: number; median: number; average: number; current: number; observationCount: number }>;
  beat: Outcome<{ beatPct: number; comparableWindows: number; benchmarkMedian: number }>;
}

interface PortfolioBlock {
  currencyCode: string;
  schemeCount: number;
  totalValue: number;
  portfolioTwrr: Outcome<{ twrr: number }>;
  portfolioXirr: Outcome<{ rate: number }>;
  blendedBenchmarkReturn: Outcome<{ blendedReturn: number; coveragePct: number }>;
  activeReturn: Outcome<{ activeReturn: number }>;
  risk: {
    volatility: Outcome<{ annualisedVolatility: number; observationCount: number }>;
    downsideDeviation: Outcome<{ annualisedDownsideDeviation: number }>;
    maxDrawdown: Outcome<{ maxDrawdown: number; peakDate: string; troughDate: string; recoveryDate: string | null }>;
    sharpeRatio: Outcome<{ sharpe: number }>;
    sortinoRatio: Outcome<{ sortino: number }>;
    beta: Outcome<{ beta: number }>;
    alpha: Outcome<{ alphaAnnualised: number; betaUsed: number }>;
    trackingError: Outcome<{ trackingError: number }>;
    informationRatio: Outcome<{ informationRatio: number }>;
    captureRatios: Outcome<{ upsideCapture: number | null; downsideCapture: number | null }>;
    calmarRatio: Outcome<{ calmar: number }>;
    riskFree: { status: string; rate?: number; source?: string; version?: string };
    frequency: string;
    periodsPerYear: number;
    methodVersion: string;
  };
  rolling: { horizons: RollingHorizon[]; methodVersion: string };
  drawdownSeries: Array<{ date: string; value: number; drawdown: number }>;
  performanceVsBenchmarkSeries: Array<{ date: string; portfolio: number; benchmark: number | null }>;
  contributingBenchmarks: Array<{ benchmarkId: string; benchmarkKey: string; returnType: string }>;
  annotations: Annotation[];
  inputFingerprint: string;
}

interface SchemeBlock {
  instrumentId: string;
  instrumentName: string;
  currencyCode: string;
  investorXirr: Outcome<{ rate: number }>;
  navReturns: Record<string, Outcome<{ pointToPoint?: number; cagr?: number }>>;
  activeReturn: Outcome<{ activeReturn: number; family: string; benchmarkKey: string }>;
  annotations: Annotation[];
  inputFingerprint: string;
}

interface ResultSet {
  asOfDate: string;
  periodStart: string;
  engineVersion: string;
  subVersions: Record<string, string>;
  portfolios: PortfolioBlock[];
  schemes: SchemeBlock[];
  crossCurrency: Outcome;
  annotations: Annotation[];
}

interface ApiPayload {
  empty: boolean;
  message?: string;
  warnings: Array<{ scope: string; detail: string }>;
  results?: ResultSet;
}

// ---------------------------------------------------------------------------
// Formatting — display rounding only; never used to decide availability.
// ---------------------------------------------------------------------------

function pct(v: number | undefined | null, digits = 2): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

function num(v: number | undefined | null, digits = 2): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

function money(v: number, currency: string): string {
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-AU', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(v);
  } catch {
    return `${currency} ${Math.round(v).toLocaleString()}`;
  }
}

const STATUS_LABEL: Record<CalculationStatus, string> = {
  CALCULATED: 'Calculated',
  INSUFFICIENT_HISTORY: 'Not enough history',
  MISSING_REFERENCE_DATA: 'Reference data missing',
  STALE: 'Needs recalculation',
  FAILED: 'Could not be calculated',
  NOT_APPLICABLE: 'Not applicable',
  AMBIGUOUS: 'Ambiguous result',
};

/**
 * The single place a metric turns into pixels. If the status is not
 * CALCULATED/STALE, the numeric slot is replaced by the status label and
 * the engine's explanation — never by a zero.
 */
function MetricValue({
  outcome,
  render,
  label,
}: {
  outcome: Outcome<never> | Outcome<Record<string, unknown>> | Outcome<never>;
  render: (v: never) => string;
  label: string;
}) {
  const o = outcome as Outcome<never>;
  const displayable = o.status === 'CALCULATED' || o.status === 'STALE';
  return (
    <div className="rounded-card border border-line bg-white p-4 shadow-sm">
      <p className="text-sm text-muted">{label}</p>
      {displayable && o.value !== undefined ? (
        <>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-ink">{render(o.value)}</p>
          {o.status === 'STALE' && (
            <p className="mt-1 text-xs text-attention">{o.detail ?? 'Shown as previously calculated.'}</p>
          )}
        </>
      ) : (
        <>
          <p className="mt-1 text-base font-medium text-muted">{STATUS_LABEL[o.status]}</p>
          {o.detail && <p className="mt-1 text-xs leading-relaxed text-muted">{o.detail}</p>}
        </>
      )}
    </div>
  );
}

function AnnotationList({ items }: { items: Annotation[] }) {
  if (!items.length) return null;
  return (
    <ul className="mt-4 space-y-2">
      {items.map((a, i) => (
        <li key={i} className="rounded-card border border-line bg-gray-50 p-3 text-xs leading-relaxed text-muted">
          <span className="font-medium text-ink">{a.flag.replace(/_/g, ' ').toLowerCase()}</span> — {a.detail}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------

export function PerformanceClient() {
  const [payload, setPayload] = useState<ApiPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/investment-intelligence/analytics');
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) setError(json.error ?? 'Analytics could not be loaded.');
        else setPayload(json.data as ApiPayload);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Analytics could not be loaded.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <p className="text-sm text-muted">Calculating performance…</p>;
  if (error) return <p className="rounded-card border border-risk bg-white p-4 text-sm text-risk">{error}</p>;
  if (!payload) return null;

  if (payload.empty || !payload.results) {
    return (
      <div className="rounded-card border border-line bg-white p-6">
        <p className="text-sm text-ink">{payload.message ?? 'No investment positions are available yet.'}</p>
        <WarningList warnings={payload.warnings} />
      </div>
    );
  }

  const r = payload.results;

  return (
    <div className="space-y-10">
      <WarningList warnings={payload.warnings} />

      {r.portfolios.length > 1 && (
        <div className="rounded-card border border-attention bg-white p-4 text-sm leading-relaxed text-ink">
          {r.crossCurrency.detail}
        </div>
      )}

      {r.portfolios.map((p) => (
        <PortfolioSection key={p.currencyCode} p={p} asOfDate={r.asOfDate} periodStart={r.periodStart} engineVersion={r.engineVersion} subVersions={r.subVersions} />
      ))}

      <SchemeTable schemes={r.schemes} />
    </div>
  );
}

function WarningList({ warnings }: { warnings: Array<{ scope: string; detail: string }> }) {
  if (!warnings?.length) return null;
  return (
    <ul className="space-y-2">
      {warnings.map((w, i) => (
        <li key={i} className="rounded-card border border-line bg-gray-50 p-3 text-xs leading-relaxed text-muted">
          <span className="font-medium text-ink">{w.scope}</span> — {w.detail}
        </li>
      ))}
    </ul>
  );
}

function PortfolioSection({
  p,
  asOfDate,
  periodStart,
  engineVersion,
  subVersions,
}: {
  p: PortfolioBlock;
  asOfDate: string;
  periodStart: string;
  engineVersion: string;
  subVersions: Record<string, string>;
}) {
  return (
    <section>
      <header className="mb-4">
        <h2 className="text-lg font-semibold text-ink">
          Portfolio performance — {p.currencyCode}
        </h2>
        <p className="mt-1 text-sm text-muted">
          {p.schemeCount} {p.schemeCount === 1 ? 'holding' : 'holdings'} · {money(p.totalValue, p.currencyCode)} · {periodStart} to {asOfDate}. All
          figures are shown in {p.currencyCode}, the currency these investments are actually held in.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricValue
          label="Time-weighted return (TWRR)"
          outcome={p.portfolioTwrr as never}
          render={(v: never) => pct((v as { twrr: number }).twrr)}
        />
        <MetricValue
          label="Money-weighted return (XIRR)"
          outcome={p.portfolioXirr as never}
          render={(v: never) => pct((v as { rate: number }).rate)}
        />
        <MetricValue
          label="Blended benchmark return"
          outcome={p.blendedBenchmarkReturn as never}
          render={(v: never) => pct((v as { blendedReturn: number }).blendedReturn)}
        />
        <MetricValue
          label="Active return vs benchmark"
          outcome={p.activeReturn as never}
          render={(v: never) => pct((v as { activeReturn: number }).activeReturn)}
        />
      </div>

      <p className="mt-3 text-xs leading-relaxed text-muted">
        TWRR measures how the underlying investments performed, independent of when you added or withdrew money. XIRR measures your own outcome,
        including the effect of your contribution timing. The two answer different questions and are not interchangeable.
      </p>

      <PerformanceVsBenchmarkChart p={p} />
      <DrawdownChart p={p} />
      <RiskPanel p={p} />
      <RollingPanel p={p} />

      <AnnotationList items={p.annotations} />

      <CalculationDetails p={p} asOfDate={asOfDate} periodStart={periodStart} engineVersion={engineVersion} subVersions={subVersions} />
    </section>
  );
}

function PerformanceVsBenchmarkChart({ p }: { p: PortfolioBlock }) {
  const data = p.performanceVsBenchmarkSeries ?? [];
  const hasBenchmark = data.some((d) => d.benchmark !== null);
  if (data.length < 2) {
    return (
      <div className="mt-6 rounded-card border border-dashed border-line bg-gray-50 p-6 text-sm text-muted">
        Not enough valuation history to chart performance against a benchmark.
      </div>
    );
  }
  return (
    <div className="mt-6 rounded-card border border-line bg-white p-4">
      <h3 className="mb-1 text-sm font-medium text-ink">Growth of 100 — portfolio vs blended benchmark</h3>
      <p className="mb-3 text-xs text-muted">
        {hasBenchmark
          ? 'Both lines start at 100 on the first date so the shapes are directly comparable.'
          : 'No benchmark series is available for this period, so only the portfolio line is shown — the gap is not drawn as zero.'}
      </p>
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={data}>
          <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={40} />
          <YAxis tick={{ fontSize: 11 }} width={50} domain={['auto', 'auto']} />
          <Tooltip formatter={(v: number) => num(v, 1)} />
          <Legend />
          <Line type="monotone" dataKey="portfolio" name="Portfolio" stroke={PALETTE.portfolio} strokeWidth={2} dot={false} isAnimationActive={false} />
          {hasBenchmark && (
            <Line
              type="monotone"
              dataKey="benchmark"
              name="Blended benchmark"
              stroke={PALETTE.benchmark}
              strokeWidth={2}
              strokeDasharray="4 3"
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function DrawdownChart({ p }: { p: PortfolioBlock }) {
  const data = p.drawdownSeries ?? [];
  if (data.length < 2) return null;
  return (
    <div className="mt-6 rounded-card border border-line bg-white p-4">
      <h3 className="mb-1 text-sm font-medium text-ink">Drawdown from peak</h3>
      <p className="mb-3 text-xs text-muted">
        How far the portfolio sat below its own highest previous value on each date. This describes past variability; it is not a forecast.
      </p>
      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={data}>
          <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={40} />
          <YAxis tick={{ fontSize: 11 }} width={60} tickFormatter={(v: number) => pct(v, 0)} />
          <Tooltip formatter={(v: number) => pct(v)} />
          <Area type="monotone" dataKey="drawdown" stroke={PALETTE.drawdown} fill={PALETTE.drawdown} fillOpacity={0.15} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function RiskPanel({ p }: { p: PortfolioBlock }) {
  const r = p.risk;
  return (
    <div className="mt-6">
      <h3 className="mb-3 text-sm font-medium text-ink">Risk and risk-adjusted measures</h3>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricValue label="Volatility (annualised)" outcome={r.volatility as never} render={(v: never) => pct((v as { annualisedVolatility: number }).annualisedVolatility)} />
        <MetricValue label="Downside deviation" outcome={r.downsideDeviation as never} render={(v: never) => pct((v as { annualisedDownsideDeviation: number }).annualisedDownsideDeviation)} />
        <MetricValue label="Maximum drawdown" outcome={r.maxDrawdown as never} render={(v: never) => pct((v as { maxDrawdown: number }).maxDrawdown)} />
        <MetricValue label="Calmar ratio" outcome={r.calmarRatio as never} render={(v: never) => num((v as { calmar: number }).calmar)} />
        <MetricValue label="Sharpe ratio" outcome={r.sharpeRatio as never} render={(v: never) => num((v as { sharpe: number }).sharpe)} />
        <MetricValue label="Sortino ratio" outcome={r.sortinoRatio as never} render={(v: never) => num((v as { sortino: number }).sortino)} />
        <MetricValue label="Beta vs benchmark" outcome={r.beta as never} render={(v: never) => num((v as { beta: number }).beta)} />
        <MetricValue label="Alpha (annualised)" outcome={r.alpha as never} render={(v: never) => pct((v as { alphaAnnualised: number }).alphaAnnualised)} />
        <MetricValue label="Tracking error" outcome={r.trackingError as never} render={(v: never) => pct((v as { trackingError: number }).trackingError)} />
        <MetricValue label="Information ratio" outcome={r.informationRatio as never} render={(v: never) => num((v as { informationRatio: number }).informationRatio)} />
        <MetricValue
          label="Upside capture"
          outcome={r.captureRatios as never}
          render={(v: never) => {
            const c = (v as { upsideCapture: number | null }).upsideCapture;
            return c === null ? '—' : pct(c);
          }}
        />
        <MetricValue
          label="Downside capture"
          outcome={r.captureRatios as never}
          render={(v: never) => {
            const c = (v as { downsideCapture: number | null }).downsideCapture;
            return c === null ? '—' : pct(c);
          }}
        />
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted">
        Sharpe, Sortino and alpha compare returns against a risk-free rate drawn from versioned reference data. Where that rate is not available for
        this country and period, the figure is withheld rather than calculated against an assumed rate.
      </p>
    </div>
  );
}

function RollingPanel({ p }: { p: PortfolioBlock }) {
  const horizons = p.rolling?.horizons ?? [];
  if (!horizons.length) return null;
  return (
    <div className="mt-6">
      <h3 className="mb-3 text-sm font-medium text-ink">Consistency — rolling returns</h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
              <th className="py-2 pr-4 font-medium">Horizon</th>
              <th className="py-2 pr-4 font-medium">Median</th>
              <th className="py-2 pr-4 font-medium">Min</th>
              <th className="py-2 pr-4 font-medium">Max</th>
              <th className="py-2 pr-4 font-medium">Windows</th>
              <th className="py-2 pr-4 font-medium">Beat benchmark</th>
            </tr>
          </thead>
          <tbody>
            {horizons.map((h) => {
              const ok = h.series.status === 'CALCULATED' && h.series.value;
              const s = h.series.value;
              return (
                <tr key={h.windowYears} className="border-b border-line align-top">
                  <td className="py-2 pr-4 font-medium text-ink">{h.windowYears}Y</td>
                  {ok && s ? (
                    <>
                      <td className="py-2 pr-4 tabular-nums text-ink">{pct(s.median)}</td>
                      <td className="py-2 pr-4 tabular-nums text-ink">{pct(s.min)}</td>
                      <td className="py-2 pr-4 tabular-nums text-ink">{pct(s.max)}</td>
                      <td className="py-2 pr-4 tabular-nums text-muted">{s.observationCount}</td>
                    </>
                  ) : (
                    <td className="py-2 pr-4 text-xs text-muted" colSpan={4}>
                      {h.series.detail ?? STATUS_LABEL[h.series.status]}
                    </td>
                  )}
                  <td className="py-2 pr-4 text-ink">
                    {h.beat.status === 'CALCULATED' && h.beat.value ? (
                      <span className="tabular-nums">
                        {pct(h.beat.value.beatPct, 0)}{' '}
                        <span className="text-xs text-muted">of {h.beat.value.comparableWindows} windows</span>
                      </span>
                    ) : (
                      <span className="text-xs text-muted">{h.beat.detail ?? STATUS_LABEL[h.beat.status]}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CalculationDetails({
  p,
  asOfDate,
  periodStart,
  engineVersion,
  subVersions,
}: {
  p: PortfolioBlock;
  asOfDate: string;
  periodStart: string;
  engineVersion: string;
  subVersions: Record<string, string>;
}) {
  return (
    <details className="mt-6 rounded-card border border-line bg-white p-4">
      <summary className="cursor-pointer text-sm font-medium text-ink">How this was calculated</summary>
      <div className="mt-4 space-y-4 text-xs leading-relaxed text-muted">
        <div>
          <p className="font-medium text-ink">Period and data</p>
          <p>
            {periodStart} to {asOfDate}, using {p.risk.frequency} observations ({p.risk.periodsPerYear} periods per year for annualisation).
          </p>
        </div>
        <div>
          <p className="font-medium text-ink">Benchmark</p>
          {p.contributingBenchmarks.length ? (
            <ul className="mt-1 list-inside list-disc">
              {p.contributingBenchmarks.map((b) => (
                <li key={b.benchmarkId}>
                  {b.benchmarkKey} ({b.returnType})
                </li>
              ))}
            </ul>
          ) : (
            <p>No benchmark contributed to this calculation.</p>
          )}
          {p.blendedBenchmarkReturn.status === 'CALCULATED' && p.blendedBenchmarkReturn.value && (
            <p className="mt-1">
              Benchmark coverage: {pct(p.blendedBenchmarkReturn.value.coveragePct, 1)} of portfolio value, blended with monthly rebalancing and
              chain-linked across periods.
            </p>
          )}
        </div>
        <div>
          <p className="font-medium text-ink">Risk-free rate</p>
          <p>
            {p.risk.riskFree.status === 'ok'
              ? `${pct(p.risk.riskFree.rate)} — source: ${p.risk.riskFree.source ?? 'reference data'} (version ${p.risk.riskFree.version ?? 'n/a'}).`
              : 'Not available in reference data for this country and period. Metrics requiring it are withheld.'}
          </p>
        </div>
        <div>
          <p className="font-medium text-ink">Versions</p>
          <p>Engine: {engineVersion}</p>
          <ul className="mt-1 list-inside list-disc">
            {Object.entries(subVersions).map(([k, v]) => (
              <li key={k}>
                {k}: {v}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="font-medium text-ink">Input snapshot</p>
          <p className="break-all font-mono">{p.inputFingerprint}</p>
          <p className="mt-1">
            This fingerprint identifies the exact inputs used. If any underlying transaction, valuation, NAV or benchmark value changes, the
            fingerprint changes and these figures are marked as needing recalculation.
          </p>
        </div>
      </div>
    </details>
  );
}

function SchemeTable({ schemes }: { schemes: SchemeBlock[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const sorted = useMemo(() => [...schemes].sort((a, b) => a.instrumentName.localeCompare(b.instrumentName)), [schemes]);
  if (!sorted.length) return null;

  return (
    <section>
      <h2 className="mb-1 text-lg font-semibold text-ink">Scheme performance</h2>
      <p className="mb-4 text-sm text-muted">
        Your own return (XIRR) for each holding, with its benchmark comparison. Select a row to see the scheme&apos;s NAV-based returns and any data
        limitations that apply to it.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
              <th className="py-2 pr-4 font-medium">Scheme</th>
              <th className="py-2 pr-4 font-medium">Currency</th>
              <th className="py-2 pr-4 font-medium">Your return (XIRR)</th>
              <th className="py-2 pr-4 font-medium">Active vs benchmark</th>
              <th className="py-2 pr-4 font-medium" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => {
              const isOpen = expanded === s.instrumentId;
              return (
                <tr key={s.instrumentId} className="border-b border-line align-top">
                  <td className="py-3 pr-4 font-medium text-ink">
                    {s.instrumentName}
                    {isOpen && <SchemeDetail s={s} />}
                  </td>
                  <td className="py-3 pr-4 text-muted">{s.currencyCode}</td>
                  <td className="py-3 pr-4">
                    {s.investorXirr.status === 'CALCULATED' && s.investorXirr.value ? (
                      <span className="tabular-nums text-ink">{pct(s.investorXirr.value.rate)}</span>
                    ) : (
                      <span className="text-xs text-muted">{STATUS_LABEL[s.investorXirr.status]}</span>
                    )}
                  </td>
                  <td className="py-3 pr-4">
                    {s.activeReturn.status === 'CALCULATED' && s.activeReturn.value ? (
                      <span className="tabular-nums text-ink">
                        {pct(s.activeReturn.value.activeReturn)}{' '}
                        <span className="text-xs text-muted">vs {s.activeReturn.value.benchmarkKey}</span>
                      </span>
                    ) : (
                      <span className="text-xs text-muted">{STATUS_LABEL[s.activeReturn.status]}</span>
                    )}
                  </td>
                  <td className="py-3 pr-4">
                    <button
                      type="button"
                      onClick={() => setExpanded(isOpen ? null : s.instrumentId)}
                      className="text-xs font-medium text-primary underline"
                      aria-expanded={isOpen}
                    >
                      {isOpen ? 'Hide detail' : 'Show detail'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SchemeDetail({ s }: { s: SchemeBlock }) {
  const horizons = Object.entries(s.navReturns);
  return (
    <div className="mt-3 max-w-xl space-y-3 rounded-card border border-line bg-gray-50 p-3 text-xs font-normal leading-relaxed text-muted">
      {s.investorXirr.status !== 'CALCULATED' && s.investorXirr.detail && <p>{s.investorXirr.detail}</p>}
      {s.activeReturn.status !== 'CALCULATED' && s.activeReturn.detail && <p>{s.activeReturn.detail}</p>}
      {horizons.length > 0 && (
        <div>
          <p className="font-medium text-ink">Scheme NAV returns</p>
          <ul className="mt-1 space-y-0.5">
            {horizons.map(([horizon, o]) => (
              <li key={horizon}>
                {horizon}:{' '}
                {o.status === 'CALCULATED' && o.value ? (
                  <span className="tabular-nums">{o.value.cagr !== undefined ? `${pct(o.value.cagr)} p.a.` : pct(o.value.pointToPoint)}</span>
                ) : (
                  <span>{STATUS_LABEL[o.status]}</span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2">
            Scheme NAV return is what the fund itself did over the period. Your XIRR differs because it reflects when you actually invested.
          </p>
        </div>
      )}
      <AnnotationList items={s.annotations} />
      <div>
        <p className="font-medium text-ink">Input snapshot</p>
        <p className="break-all font-mono">{s.inputFingerprint}</p>
      </div>
    </div>
  );
}
