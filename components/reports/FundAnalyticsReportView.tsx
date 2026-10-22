'use client';

import { useMemo, useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { DataTable } from '@/components/ui/DataTable';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { SelectField } from '@/components/admin/benchmarkData/ui';
import { REPORT_PERIOD_LABELS } from '@/lib/engines/nav2/analysisSpec';
import type { FundAnalyticsReport, FundAnalyticsSchemeBlock } from '@/lib/engines/nav2/fundAnalyticsReport';
import { INVESTOR_XIRR_LABEL, SCHEME_CAGR_LABEL } from '@/lib/engines/nav2/investorExperience';
import { chartRowsWithGaps, navPrice, period, pct, ratio, rupees, showResult, type ShownCell } from '@/lib/engines/nav2/presentation';
import { showDate, type Nav2Context, type Nav2Result } from '@/lib/engines/nav2/types';
import { BETA_ALPHA_NO_BENCHMARK_LINE, betaAlphaNoBenchmark, FUND_ANALYTICS_CAGR_CONVENTION_NOTE, HOW_CALCULATED_HEADING, pricesRunToLine, riskFreeLabelOf } from '@/lib/engines/nav2/reportWording';
import { ownershipSentence, percentLabel } from '@/lib/engines/nav2/ownershipShare';
import { buildFundAnalyticsSummary, compareTwoFunds, comparisonPickerOptions, defaultComparisonPair, describeComparisonCoverage, FUND_SUMMARY_HEAD, rankingPrerequisites, type FundComparison } from '@/lib/engines/nav2/fundAnalyticsInsight';
import type { CorrelationValue } from '@/lib/engines/nav2/schemeRisk';
import { NAV2_POLICY } from '@/lib/config/nav2/metricPolicy';
import { NUM_CELL_CLASS, NUM_HEADER_CLASS } from '@/lib/ui/tableAlign';

// The Fund analytics report, shown. One component renders the interactive page AND the print route (the PDF), so they
// cannot disagree. Every figure goes through showResult(): an unavailable result is its fixed headline plus the engine's own
// sentence, never a number. Tables are real <table>s with captions and column scopes (keyboard / screen-reader friendly) and
// scroll sideways on a phone instead of squashing; the pairwise correlation is a focused two-fund picker, not a matrix.

function Cell({ c }: { c: ShownCell }) {
  if (c.available) {
    return (
      <>
        <span>{c.text}</span>
        {c.notes.map((n, i) => (
          <span key={i} className="block text-xs font-normal text-muted">
            {n}
          </span>
        ))}
      </>
    );
  }
  return (
    <>
      <span className="font-medium text-[#8A5A12]">{c.headline}</span>
      {c.detail && <span className="block text-xs font-normal text-muted">{c.detail}</span>}
    </>
  );
}

/** A figure, or (when it cannot be worked out) its short headline with a marker; the explanation is printed once under the table. */
function ShortCell({ c }: { c: ShownCell }) {
  if (c.available) return <Cell c={c} />;
  return (
    <span className="font-medium text-[#8A5A12]">
      {c.headline}
      {c.detail ? <sup>*</sup> : null}
    </span>
  );
}

/** " (RBI 91-day T-bill)" or " (RBI policy repo-rate proxy)": the risk-free series every Sharpe, Sortino and alpha figure rests on, stated beside it. */
function rfLabel(r: Nav2Result<unknown> | null | undefined): string {
  if (!r || r.state !== 'available') return '';
  const l = riskFreeLabelOf((r.provenance as { riskFree?: { seriesId?: string; seriesLabel?: string } }).riskFree);
  return l ? ` (${l})` : '';
}

function Table({ caption, head, children }: { caption: string; head: Array<{ label: string; num?: boolean }>; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <DataTable label={caption} className="text-sm">
        <caption className="mb-1 text-left text-xs text-muted">{caption}</caption>
        <thead>
          <tr className="text-left text-muted">
            {head.map((h) => (
              <th key={h.label} scope="col" className={`py-1 pr-3 font-medium ${h.num ? NUM_HEADER_CLASS : ''}`}>
                {h.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="align-top">{children}</tbody>
      </DataTable>
    </div>
  );
}

const rowCls = 'border-t border-line';

/**
 * Document2 (4) F1: a date range is TWO lines, each a date that never breaks (a dd-mm-yyyy date has hyphens, and a table cell that is only as wide as
 * it must be breaks a date at every one of them, which the Product Owner saw as four lines at every width). The "to" starts the second line.
 */
export function DatesUsed({ ctx, from, to }: { ctx: Pick<Nav2Context, 'currency'>; from: string | null; to: string | null }) {
  return (
    <>
      <span className="block whitespace-nowrap">{showDate(ctx, from)}</span>
      <span className="block whitespace-nowrap">to {showDate(ctx, to)}</span>
    </>
  );
}

/** The widest a date-range cell is ever allowed to be: two lines of an unbreakable dd-mm-yyyy date (10 characters), plus the word "to". */
export const DATES_USED_MAX_LINES = 2;

export function NavChart({ block, ctx, height = 220 }: { block: FundAnalyticsSchemeBlock; ctx: Nav2Context; height?: number }) {
  const rows = useMemo(() => chartRowsWithGaps(block.chart).map((r) => ({ ...r, label: showDate(ctx, r.date) })), [block.chart, ctx]);
  if (block.chart.navPoints.length < 2) {
    return <p className="mt-3 rounded-card border border-dashed p-4 text-sm text-muted">Not enough price history to draw a chart.</p>;
  }
  return (
    <div className="mt-3" role="img" aria-label={`Price (NAV) history of ${block.schemeName} with the 50 and 200 observation simple moving averages. The line is broken wherever price history is missing.`}>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={rows}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} minTickGap={48} />
          <YAxis tick={{ fontSize: 11 }} domain={['auto', 'auto']} width={64} tickFormatter={(v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 0 })} />
          <Tooltip formatter={(v: number) => navPrice(v)} />
          <Legend />
          <Line type="monotone" dataKey="nav" name="NAV" stroke="#2563eb" strokeWidth={1.5} dot={false} connectNulls={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="sma50" name="SMA 50" stroke="#16a34a" strokeWidth={1} dot={false} connectNulls={false} isAnimationActive={false} />
          <Line type="monotone" dataKey="sma200" name="SMA 200" stroke="#9333ea" strokeWidth={1} dot={false} connectNulls={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
      {block.chart.gaps.length > 0 && <p className="mt-1 text-xs text-muted">The line is broken where {block.chart.gaps.length} stretch(es) of price history are missing; nothing is filled in.</p>}
      {block.chart.downsampled && <p className="mt-1 text-xs text-muted">The chart shows a sample of the daily prices; the figures use every price.</p>}
    </div>
  );
}

function SchemeSection({ block, ctx }: { block: FundAnalyticsSchemeBlock; ctx: Nav2Context }) {
  const a = block.analytics;
  const s = a.scheme;
  const inv = a.investor;
  const meta = [block.categoryLabel, block.planType && block.planType !== 'not_applicable' ? `${block.planType} plan` : null, block.optionType && block.optionType !== 'not_applicable' ? block.optionType.replace(/_/g, ' ') : null].filter(Boolean).join(' - ');
  return (
    <SectionCard title={block.schemeName} description={meta || undefined}>
      {ownershipSentence(block.ownership) && (
        <p className="mb-2 text-sm font-medium text-ink" data-testid="ownership-share" data-ownership={block.ownership?.mode}>
          {ownershipSentence(block.ownership)}
        </p>
      )}
      <p className="text-xs text-muted">
        Price history: {block.navSeriesSummary.count.toLocaleString('en-IN')} prices from {showDate(ctx, block.navSeriesSummary.firstDate)} to {showDate(ctx, block.navSeriesSummary.lastDate)}
        {block.navSeriesSummary.materialGapCount > 0 ? `, with ${block.navSeriesSummary.materialGapCount} gap(s)` : ''}.
      </p>
      <NavChart block={block} ctx={ctx} />

      <h3 className="mt-5 text-base font-semibold text-ink">The fund&apos;s own growth</h3>
      <p className="text-xs text-muted">{SCHEME_CAGR_LABEL}</p>
      <p className="text-xs text-muted" data-testid="cagr-convention-note">{FUND_ANALYTICS_CAGR_CONVENTION_NOTE}</p>
      <Table caption="Fund return over trailing periods" head={[{ label: 'Period' }, { label: 'Total return', num: true }, { label: 'CAGR (a year)', num: true }, { label: 'Dates used' }]}>
        {s.pointToPoint.map((p) => {
          const abs = showResult(p.result, (v) => pct(v.absoluteReturn));
          const cg = showResult(p.cagr, (v) => pct(v.cagr));
          return (
            <tr key={p.id} className={rowCls}>
              <th scope="row" className="py-2 pr-3 text-left font-medium">{p.id.replace('Y', ' year')}</th>
              <td className={`py-2 pr-3 ${NUM_CELL_CLASS}`}><ShortCell c={abs} /></td>
              <td className={`py-2 pr-3 ${NUM_CELL_CLASS}`}><ShortCell c={cg} /></td>
              <td className="py-2 pr-3 text-xs text-muted" data-testid="dates-used">
                {p.result.state === 'available' ? <DatesUsed ctx={ctx} from={p.result.value.startDate} to={p.result.value.endDate} /> : ''}
              </td>
            </tr>
          );
        })}
      </Table>
      {/* The full sentence ONCE per fund, not repeated in every cell. */}
      {(() => {
        const first = s.pointToPoint.map((p) => showResult(p.result, (v) => pct(v.absoluteReturn))).find((c) => !c.available && c.detail);
        return first ? (
          <p className="mt-1 text-xs text-muted">
            <sup>*</sup> {first.detail} The same applies to every figure marked * in this table; each uses its own date.
          </p>
        ) : null;
      })()}

      <Table caption="Rolling returns: every available window, not a single start date" head={[{ label: 'Window' }, { label: 'Median', num: true }, { label: 'Lowest', num: true }, { label: 'Highest', num: true }, { label: 'Windows above zero', num: true }]}>
        {s.rolling.map((r) => {
          const v = r.result.state === 'available' ? r.result.value : null;
          const withheld = v !== null && v.summary === null;
          const cellFor = (f: (x: NonNullable<typeof v>['summary'] & object) => string): ShownCell =>
            withheld ? { available: false, text: 'Summary withheld', headline: 'Summary withheld', detail: `Only ${v!.windowCount} window(s): too few to summarise.`, notes: [], noteCodes: [] } : showResult(r.result, (x) => (x.summary ? f(x.summary) : ''));
          return (
            <tr key={r.horizonId} className={rowCls}>
              <th scope="row" className="py-2 pr-3 text-left font-medium">{r.horizonId}</th>
              <td className={`py-2 pr-3 ${NUM_CELL_CLASS}`}><Cell c={cellFor((x) => pct(x.median))} /></td>
              <td className={`py-2 pr-3 ${NUM_CELL_CLASS}`}><Cell c={cellFor((x) => pct(x.min))} /></td>
              <td className={`py-2 pr-3 ${NUM_CELL_CLASS}`}><Cell c={cellFor((x) => pct(x.max))} /></td>
              <td className={`py-2 pr-3 ${NUM_CELL_CLASS}`}><Cell c={cellFor((x) => pct(x.positiveWindowShare))} /></td>
            </tr>
          );
        })}
      </Table>

      <h3 className="mt-5 text-base font-semibold text-ink">Risk and risk-adjusted measures</h3>
      <Table caption="Over the report period, from daily prices" head={[{ label: 'Measure' }, { label: 'Value', num: true }]}>
        {[
          ['Volatility (annualised)', showResult(s.volatility, (v) => pct(v.annualisedVolatility))],
          [`Sharpe ratio${rfLabel(s.sharpe)}`, showResult(s.sharpe, (v) => ratio(v.annualisedRatio))],
          [`Sortino ratio${rfLabel(s.sortino)}`, showResult(s.sortino, (v) => ratio(v.annualisedRatio))],
          ['Maximum drawdown', showResult(s.maxDrawdown, (v) => `${pct(v.maxDrawdown)} (${v.status === 'no_drawdown' ? 'no fall' : `peak ${showDate(ctx, v.peakDate)}, low ${showDate(ctx, v.troughDate)}${v.recoveryDate ? `, recovered ${showDate(ctx, v.recoveryDate)}` : ', not yet recovered'}`})`)],
          ...(betaAlphaNoBenchmark({ beta: s.beta as never, alpha: s.alpha as never })
            ? []
            : [
                ['Beta (against the fund’s declared benchmark)', showResult(s.beta, (v) => `${ratio(v.beta)} (${v.benchmarkLabel})`)],
                [`Jensen’s alpha (a year)${rfLabel(s.alpha)}`, showResult(s.alpha, (v) => `${pct(v.alphaAnnualised)} (${v.benchmarkLabel})`)],
              ]),
        ].map(([label, cell]) => (
          <tr key={label as string} className={rowCls}>
            <th scope="row" className="py-2 pr-3 text-left font-medium">{label as string}</th>
            <td className={`py-2 pr-3 ${NUM_CELL_CLASS}`}><Cell c={cell as ShownCell} /></td>
          </tr>
        ))}
      </Table>
      {betaAlphaNoBenchmark({ beta: s.beta as never, alpha: s.alpha as never }) && (
        <p className="mt-2 text-sm text-muted" data-testid="beta-alpha-none">
          {BETA_ALPHA_NO_BENCHMARK_LINE}
        </p>
      )}

      <h3 className="mt-5 text-base font-semibold text-ink">Trend</h3>
      <Table caption="Latest value of each average, counted in price observations (not calendar days)" head={[{ label: 'Measure' }, { label: 'Latest', num: true }, { label: 'As at' }]}>
        {[
          ...s.movingAverages.map((m) => ({ label: `${m.kind.toUpperCase()} ${m.period}`, r: m.result, fmt: (v: { latest: { value: number } }) => navPrice(v.latest.value) })),
          ...s.rateOfChange.map((m) => ({ label: `Rate of change, ${m.period} observations`, r: m.result, fmt: (v: { latest: { value: number } }) => pct(v.latest.value) })),
        ].map((row) => {
          const cell = showResult(row.r as Nav2Result<{ latest: { value: number; date: string } }>, row.fmt);
          return (
            <tr key={row.label} className={rowCls}>
              <th scope="row" className="py-2 pr-3 text-left font-medium">{row.label}</th>
              <td className={`py-2 pr-3 ${NUM_CELL_CLASS}`}><Cell c={cell} /></td>
              <td className="py-2 pr-3 text-xs text-muted">{row.r.state === 'available' ? showDate(ctx, (row.r.value as { latest: { date: string } }).latest.date) : ''}</td>
            </tr>
          );
        })}
        <tr className={rowCls}>
          <th scope="row" className="py-2 pr-3 text-left font-medium">Highest NAV in the period</th>
          <td className={`py-2 pr-3 ${NUM_CELL_CLASS}`}><Cell c={showResult(s.extremes, (v) => navPrice(v.highestNav))} /></td>
          <td className="py-2 pr-3 text-xs text-muted">{s.extremes.state === 'available' ? showDate(ctx, s.extremes.value.highestNavDate) : ''}</td>
        </tr>
        <tr className={rowCls}>
          <th scope="row" className="py-2 pr-3 text-left font-medium">Lowest NAV in the period</th>
          <td className={`py-2 pr-3 ${NUM_CELL_CLASS}`}><Cell c={showResult(s.extremes, (v) => navPrice(v.lowestNav))} /></td>
          <td className="py-2 pr-3 text-xs text-muted">{s.extremes.state === 'available' ? showDate(ctx, s.extremes.value.lowestNavDate) : ''}</td>
        </tr>
        <tr className={rowCls}>
          <th scope="row" className="py-2 pr-3 text-left font-medium">Average NAV (mean / median)</th>
          <td className={`py-2 pr-3 ${NUM_CELL_CLASS}`}><Cell c={showResult(s.average, (v) => `${navPrice(v.meanNav)} / ${navPrice(v.medianNav)}`)} /></td>
          <td className="py-2 pr-3 text-xs text-muted">a description of prices, not a return</td>
        </tr>
      </Table>

      <h3 className="mt-5 text-base font-semibold text-ink">Your own money in this fund</h3>
      {inv ? (
        <>
          <p className="text-xs text-muted">{INVESTOR_XIRR_LABEL}</p>
          <Table caption="From your own purchases, redemptions and current holding" head={[{ label: 'Measure' }, { label: 'Value', num: true }]}>
            {[
              ['Your return (XIRR, a year)', showResult(inv.xirr, (v) => pct(v.rate))],
              ['Current value', showResult(inv.currentValue, (v) => `${rupees(v.value)} (${v.basis === 'statement' ? 'statement value' : v.basis === 'redeemed' ? 'fully redeemed' : 'units x latest NAV'}${v.navDate ? `, NAV of ${showDate(ctx, v.navDate)}` : ''})`)],
              ['Amount you put in', showResult(inv.investedAmount, (v) => `${rupees(v.invested)}${v.firstInvestmentDate ? ` (first on ${showDate(ctx, v.firstInvestmentDate)})` : ''}`)],
              ['Amount you took out', showResult(inv.investedAmount, (v) => rupees(v.received))],
              ['Gain or loss', showResult(inv.gainLoss, (v) => rupees(v.gainLoss))],
            ].map(([label, cell]) => (
              <tr key={label as string} className={rowCls}>
                <th scope="row" className="py-2 pr-3 text-left font-medium">{label as string}</th>
                <td className={`py-2 pr-3 ${NUM_CELL_CLASS}`}><Cell c={cell as ShownCell} /></td>
              </tr>
            ))}
          </Table>
          <p className="mt-2 text-sm text-ink">{a.explanation}</p>
        </>
      ) : (
        <p className="mt-2 text-sm text-muted">Your own return is not shown for this fund because your transactions and holding could not be matched to it.</p>
      )}
    </SectionCard>
  );
}

function pairCell(report: FundAnalyticsReport, aId: string, bId: string, ctx: Nav2Context): ShownCell {
  const p = report.comparison.correlations.find((x) => (x.aInstrumentId === aId && x.bInstrumentId === bId) || (x.aInstrumentId === bId && x.bInstrumentId === aId));
  if (!p) return { available: false, text: 'Not calculated', headline: 'Not calculated', detail: null, notes: [], noteCodes: [] };
  return showResult(p.result as Nav2Result<CorrelationValue>, (v) => `${ratio(v.correlation)} (${v.commonReturnCount.toLocaleString('en-IN')} common returns, ${period(ctx, v.windowStart, v.windowEnd)})`);
}

/** What the picked pair shows: the verdict, the coverage it rests on, or the reason it cannot be worked out, and the two funds side by side. */
export function ComparisonResult({ comparison, ctx }: { comparison: FundComparison; ctx: Nav2Context }) {
  if (comparison.status === 'invalid') {
    return (
      <p className="mt-3 text-sm font-medium text-[#8A5A12]" role="status" aria-live="polite" data-testid="comparison-invalid">
        {comparison.message}
      </p>
    );
  }
  const table = (
    <Table caption={`${comparison.fundA} and ${comparison.fundB}, side by side`} head={[{ label: 'Measure' }, { label: comparison.fundA, num: true }, { label: comparison.fundB, num: true }]}>
      {comparison.rows.map((row) => (
        <tr key={row.label} className={rowCls}>
          <th scope="row" className="py-2 pr-3 text-left font-medium">{row.label}</th>
          <td className={`py-2 pr-3 ${NUM_CELL_CLASS}`}><ShortCell c={row.a} /></td>
          <td className={`py-2 pr-3 ${NUM_CELL_CLASS}`}><ShortCell c={row.b} /></td>
        </tr>
      ))}
    </Table>
  );
  if (comparison.status === 'unavailable') {
    return (
      <div className="mt-3" aria-live="polite" data-testid="comparison-unavailable">
        <p className="text-sm font-medium text-[#8A5A12]">{comparison.headline}</p>
        <p className="text-sm text-muted">{comparison.message}</p>
        <p className="mt-1 text-sm text-ink">{comparison.whatToDo}</p>
        {table}
      </div>
    );
  }
  return (
    <div className="mt-3" aria-live="polite" data-testid="comparison-ok">
      <p className="text-sm text-muted">How closely they moved together</p>
      <p className="text-2xl font-semibold tabular-nums text-ink">{ratio(comparison.correlation)}</p>
      <p className="text-sm text-ink">{comparison.reading}</p>
      {describeComparisonCoverage(comparison, ctx).map((line) => (
        <p key={line} className="mt-1 text-xs text-muted">{line}</p>
      ))}
      {comparison.cautions.map((c) => (
        <p key={c} className="mt-1 text-xs text-[#8A5A12]">{c}</p>
      ))}
      {table}
    </div>
  );
}

/** Document2 (4) F10: "Your funds at a glance", the page the PDF opens with, from the SAME model (buildFundAnalyticsSummary). */
export function FundSummaryCard({ report }: { report: FundAnalyticsReport }) {
  const rows = buildFundAnalyticsSummary(report, percentLabel);
  if (rows.length === 0) return null;
  const cellOf = (c: ShownCell | null) => (c ? <ShortCell c={c} /> : <span className="text-muted">Not matched to your transactions</span>);
  const firstWhy = rows.flatMap((r) => [r.valueNow, r.gainLoss, r.xirr, r.cagr3Year]).find((c) => c && !c.available && c.detail);
  return (
    <SectionCard title="Your funds at a glance" description="One line per fund: what it is worth now, what you have gained or lost, your own return and the fund's own 3 year growth.">
      <div data-testid="fund-summary">
        <DataTable label="Your funds at a glance" className="text-sm">
          <thead>
            <tr className="text-left text-muted">
              {FUND_SUMMARY_HEAD.map((h, i) => (
                <th key={h} scope="col" className={`py-1 pr-3 font-medium ${i > 0 ? NUM_HEADER_CLASS : ''}`}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="align-top">
            {rows.map((r) => (
              <tr key={r.instrumentId} className={rowCls}>
                <th scope="row" className="py-2 pr-3 text-left font-medium">
                  <a href={`#fund-${r.instrumentId}`} className="text-primary underline">
                    {r.name}
                  </a>
                </th>
                <td className={`py-2 pr-3 ${NUM_CELL_CLASS}`}>{cellOf(r.valueNow)}</td>
                <td className={`py-2 pr-3 ${NUM_CELL_CLASS}`}>{cellOf(r.gainLoss)}</td>
                <td className={`py-2 pr-3 ${NUM_CELL_CLASS}`}>{cellOf(r.xirr)}</td>
                <td className={`py-2 pr-3 ${NUM_CELL_CLASS}`}>{cellOf(r.cagr3Year)}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </div>
      {firstWhy && firstWhy.detail && (
        <p className="mt-2 text-xs text-muted">
          <sup>*</sup> {firstWhy.detail} Each fund&apos;s own section below says what is missing for it.
        </p>
      )}
      {report.schemes.some((b) => b.ownership) && (
        <p className="mt-2 text-xs text-muted">Where a fund is held jointly, the figures about your own money are your share of it. Your share of each fund is shown beside its name.</p>
      )}
    </SectionCard>
  );
}

function Comparison({ report, ctx, printMode }: { report: FundAnalyticsReport; ctx: Nav2Context; printMode: boolean }) {
  const names = new Map(report.schemes.map((s) => [s.instrumentId, s.schemeName]));
  // Each fund ONCE, and two funds with the same printed name told apart (Document2 (4) F12).
  const options = useMemo(() => comparisonPickerOptions(report), [report]);
  const ids = options.map((o) => o.value);
  const [a, setA] = useState(defaultComparisonPair(options)[0]);
  const [b, setB] = useState(defaultComparisonPair(options)[1]);
  const comparison = useMemo(() => compareTwoFunds(report, a, b), [report, a, b]);
  const nm = (id: string) => names.get(id) ?? 'Unknown fund';
  return (
    <SectionCard title="Comparing your funds" description={report.comparison.label + ': only the funds you hold are compared with each other, and only against funds of the same category, plan and option.'}>
      {report.comparison.rankings.map((r) => {
        const cell = showResult(r.result, () => '');
        const v = r.result.state === 'available' ? r.result.value : null;
        return (
          <div key={r.horizonId} className="mt-3">
            <h3 className="text-base font-semibold text-ink">Ranked by CAGR, {r.horizonId.replace('Y', ' year')}</h3>
            {!v && <p className="text-sm text-muted"><Cell c={cell} /></p>}
            {!v && (
              <div className="mt-1 text-sm text-muted" data-testid="ranking-needs">
                <p className="text-ink font-medium">What is needed for this to show</p>
                <ul className="list-disc pl-5">
                  {rankingPrerequisites(report, r.horizonId).map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            )}
            {v && v.groups.length === 0 && <p className="text-sm text-muted">No two of your funds are comparable over this period.</p>}
            {v?.groups.map((g) => (
              <Table key={`${g.category}|${g.planType}|${g.optionType}`} caption={`${g.category.replace(/_/g, ' ')}${g.planType ? `, ${g.planType} plan` : ''}${g.optionType ? `, ${g.optionType.replace(/_/g, ' ')}` : ''}`} head={[{ label: 'Rank', num: true }, { label: 'Fund' }, { label: 'CAGR', num: true }]}>
                {g.rows.map((row) => (
                  <tr key={row.instrumentId} className={rowCls}>
                    <td className={`py-2 pr-3 ${NUM_CELL_CLASS}`}>{row.rank}{row.tied ? ' (tied)' : ''}</td>
                    <td className="py-2 pr-3">{nm(row.instrumentId)}</td>
                    <td className={`py-2 pr-3 ${NUM_CELL_CLASS}`}>{pct(row.value)}</td>
                  </tr>
                ))}
              </Table>
            ))}
            {v && v.notComparable.length > 0 && (
              <p className="mt-1 text-xs text-muted">
                Not comparable: {v.notComparable.map((n) => `${nm(n.instrumentId)} (${n.reason === 'category_unknown' ? 'its category is not known' : 'no other held fund of the same category, plan and option'})`).join('; ')}.
              </p>
            )}
            {v && v.excluded.length > 0 && <p className="mt-1 text-xs text-muted">Left out of this ranking (no figure available): {v.excluded.map((e) => nm(e.instrumentId)).join('; ')}.</p>}
          </div>
        );
      })}

      <h3 className="mt-6 text-base font-semibold text-ink">How closely two of your funds move together</h3>
      {report.comparison.correlationsSkippedReason ? (
        <p className="text-sm text-muted">{report.comparison.correlationsSkippedReason}</p>
      ) : ids.length < 2 ? (
        <p className="text-sm text-muted">You need at least two different funds in this report to compare how they move together.</p>
      ) : printMode ? (
        <Table caption="Correlation of periodic returns, each pair of your funds" head={[{ label: 'Fund A' }, { label: 'Fund B' }, { label: 'Correlation', num: true }]}>
          {report.comparison.correlations.map((p) => (
            <tr key={`${p.aInstrumentId}|${p.bInstrumentId}`} className={rowCls}>
              <td className="py-2 pr-3">{nm(p.aInstrumentId)}</td>
              <td className="py-2 pr-3">{nm(p.bInstrumentId)}</td>
              <td className={`py-2 pr-3 ${NUM_CELL_CLASS}`}><Cell c={pairCell(report, p.aInstrumentId, p.bInstrumentId, ctx)} /></td>
            </tr>
          ))}
        </Table>
      ) : (
        <div className="mt-2">
          <div className="flex flex-wrap gap-3">
            <div className="min-w-[14rem] max-w-full flex-1">
              <SelectField label="First fund" value={a} hidePlaceholder options={options} onChange={setA} />
            </div>
            <div className="min-w-[14rem] max-w-full flex-1">
              <SelectField label="Second fund" value={b} hidePlaceholder options={options} onChange={setB} />
            </div>
          </div>
          <ComparisonResult comparison={comparison} ctx={ctx} />
          <p className="mt-1 text-xs text-muted">A correlation near 1 means the two funds usually rise and fall together; near 0, little relationship; below 0, they tend to move in opposite directions. It describes past returns only.</p>
        </div>
      )}
    </SectionCard>
  );
}

export default function FundAnalyticsReportView({ report, printMode = false }: { report: FundAnalyticsReport; printMode?: boolean }) {
  const ctx: Nav2Context = { policy: NAV2_POLICY, currency: report.displayCurrency };
  const latestPriceDate = report.schemes.map((b) => b.navSeriesSummary.lastDate).filter((d): d is string => !!d).sort().slice(-1)[0] ?? null;
  return (
    <div className="space-y-6">
      <SectionCard title="Fund analytics report" description={`As at ${showDate(ctx, report.asOfDate)}. Period: ${REPORT_PERIOD_LABELS[report.periodChoice]}.`}>
        {report.schemes.length === 0 ? (
          <p className="text-sm text-muted">This report covers Indian mutual funds, and none could be analysed.</p>
        ) : (
          <p className="text-sm text-ink">{report.schemes.length} fund{report.schemes.length === 1 ? '' : 's'} analysed. The fund&apos;s own growth and your own return are different things and are shown separately for each fund.</p>
        )}
        {latestPriceDate && (
          <p className="mt-2 text-sm text-muted" data-testid="prices-run-to">
            {pricesRunToLine(showDate(ctx, latestPriceDate))}
          </p>
        )}
        {report.notes.length > 0 && (
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted">
            {report.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        )}
        {report.calculationNotes && report.calculationNotes.length > 0 && (
          <details className="mt-3 text-sm text-muted" data-testid="how-calculated">
            <summary className="cursor-pointer font-medium text-ink">{HOW_CALCULATED_HEADING}</summary>
            {report.calculationNotes.map((n, i) => (
              <p key={i} className="mt-2">{n}</p>
            ))}
          </details>
        )}
      </SectionCard>
      {!printMode && <FundSummaryCard report={report} />}
      {report.schemes.map((b) => (
        <div key={b.instrumentId} id={`fund-${b.instrumentId}`}>
          <SchemeSection block={b} ctx={ctx} />
        </div>
      ))}
      {report.schemes.length > 0 && <Comparison report={report} ctx={ctx} printMode={printMode} />}
    </div>
  );
}
