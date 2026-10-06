import StaticNavChart from '@/components/reports/StaticNavChart';
import { REPORT_PERIOD_LABELS } from '@/lib/engines/nav2/analysisSpec';
import type { FundAnalyticsReport, FundAnalyticsSchemeBlock } from '@/lib/engines/nav2/fundAnalyticsReport';
import { INVESTOR_XIRR_LABEL, SCHEME_CAGR_LABEL } from '@/lib/engines/nav2/investorExperience';
import { navPrice, period, pct, ratio, rupees, showResult, type ShownCell } from '@/lib/engines/nav2/presentation';
import { FUND_ANALYTICS_CAGR_CONVENTION_NOTE, FUND_ANALYTICS_SAVED_REPORT_SENTENCE, riskFreeLabelOf, versionMadeLine } from '@/lib/engines/nav2/reportWording';
import { ownershipSentence, percentLabel } from '@/lib/engines/nav2/ownershipShare';
import type { CorrelationValue } from '@/lib/engines/nav2/schemeRisk';
import { showDate, type Nav2Context, type Nav2Result } from '@/lib/engines/nav2/types';
import { NAV2_POLICY } from '@/lib/config/nav2/metricPolicy';

// The Fund analytics report as a DOCUMENT (the print route and the PDF). One component, the page layout in app/globals.css under .fa-doc.
//
// LAYOUT RULES (PO feedback on the first PDF: big blank areas, headings stranded from their tables, one bordered card spread over several
// pages, no fund name on the later pages, cramped tables, the same long sentence in every cell):
//   * a COVER page (title, version line, the saved-report sentence, one summary row per fund, the report notes ONCE);
//   * each fund is TWO explicit sheets, each starting with the fund name: sheet A (facts, price chart, trailing and rolling returns) and
//     sheet B (risk, trend, your own money). Sheets start on a new page; nothing inside a sheet is forced onto a new page;
//   * no card borders: thin rules and spacing; tables use fixed column widths so a label never wraps awkwardly and a number sits next to
//     its label; long tables may split between rows with the header row repeated, but a row, a heading with its first row, and a chart
//     with its caption never split;
//   * an explanation that would repeat in every cell is a LETTERED FOOTNOTE printed once per sheet (the marker sits in the cell); the
//     risk-free paragraph is report note 1, and each Sharpe / Sortino row only points to it. Every figure still comes from showResult(), so
//     an unavailable result is its fixed headline, never a number.

class Footnotes {
  private readonly items: Array<{ key: string; text: string; extra: number }> = [];
  mark(key: string, text: string): string {
    let i = this.items.findIndex((x) => x.key === key);
    if (i < 0) {
      this.items.push({ key, text, extra: 0 });
      i = this.items.length - 1;
    } else this.items[i].extra += 1;
    return String.fromCharCode(97 + i);
  }
  list(): Array<{ letter: string; text: string; shared: boolean }> {
    return this.items.map((x, i) => ({ letter: String.fromCharCode(97 + i), text: x.text, shared: x.extra > 0 }));
  }
}

const BOUNDARY_NOTE = 'Prices are not published every day. Where a start or end date had no price, the latest earlier price (within 10 days) was used; each fund’s own page shows the dates actually used.';
const RISK_FREE_CODES = new Set(['risk_free_series_used']);

function Marks({ letters }: { letters: string[] }) {
  return letters.length === 0 ? null : <sup className="fa-mark">{letters.join(',')}</sup>;
}

/** A figure, or its fixed headline; explanations go to the sheet's footnotes (never repeated in the cell). */
function figure(c: ShownCell, fn: Footnotes, opts: { riskFreeNote?: number | null; riskFreeLabel?: string | null } = {}) {
  const letters: string[] = [];
  let pointer: string | null = null;
  if (c.available) {
    c.notes.forEach((n, i) => {
      const code = c.noteCodes[i];
      if (RISK_FREE_CODES.has(code)) pointer = `${opts.riskFreeLabel ?? 'Risk-free series'}, ${opts.riskFreeNote ? `see note ${opts.riskFreeNote}` : 'see the report notes'}`;
      else letters.push(fn.mark(code === 'boundary_substitution' ? 'boundary_substitution' : `${code}:${n}`, code === 'boundary_substitution' ? BOUNDARY_NOTE : n));
    });
    return { node: <><span>{c.text}</span><Marks letters={[...new Set(letters)]} /></>, pointer };
  }
  const l = c.detail ? fn.mark(`na:${c.headline}`, c.detail) : null;
  return { node: <><span className="fa-na">{c.headline}</span><Marks letters={l ? [l] : []} /></>, pointer };
}

function FootnoteList({ fn }: { fn: Footnotes }) {
  const items = fn.list();
  if (items.length === 0) return null;
  return (
    <div className="fa-footnotes">
      {items.map((x) => (
        <p key={x.letter}>
          <sup className="fa-mark">{x.letter}</sup> {x.text}
          {x.shared ? (/\d{2}-\d{2}-\d{4}/.test(x.text) ? ' The same applies to every cell carrying this mark; each names its own date.' : ' The same applies to every cell carrying this mark.') : ''}
        </p>
      ))}
    </div>
  );
}

type Row = { key: string; cells: React.ReactNode[]; nums?: boolean[] };

/** A fixed-layout table: `widths` are percentages that add up to 100, `num[i]` right-aligns column i next to its label. */
function FaTable({ caption, head, widths, num, rows }: { caption?: string; head: string[]; widths: number[]; num: boolean[]; rows: Row[] }) {
  return (
    <table className="fa-table">
      {caption ? <caption>{caption}</caption> : null}
      <colgroup>
        {widths.map((w, i) => (
          <col key={i} style={{ width: `${w}%` }} />
        ))}
      </colgroup>
      <thead>
        <tr>
          {head.map((h, i) => (
            <th key={h} scope="col" className={num[i] ? 'num' : undefined}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            {r.cells.map((c, i) =>
              i === 0 ? (
                <th key={i} scope="row" className={num[0] ? 'fa-label num' : 'fa-label'}>
                  {c}
                </th>
              ) : (
                <td key={i} className={num[i] ? 'num' : undefined}>
                  {c}
                </td>
              )
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FundSheets({ block, ctx, riskFreeNote }: { block: FundAnalyticsSchemeBlock; ctx: Nav2Context; riskFreeNote: number | null }) {
  const a = block.analytics;
  const s = a.scheme;
  const inv = a.investor;
  const meta = [block.categoryLabel, block.planType && block.planType !== 'not_applicable' ? `${block.planType} plan` : null, block.optionType && block.optionType !== 'not_applicable' ? block.optionType.replace(/_/g, ' ') : null].filter(Boolean).join(' - ');
  const last = block.chart.navPoints[block.chart.navPoints.length - 1];
  const sum = block.navSeriesSummary;
  const fnA = new Footnotes();
  const fnB = new Footnotes();

  // ---- sheet A ---------------------------------------------------------------------------------------------------
  const factRows: Row[] = [
    { key: 'hist', cells: ['Price history', `${sum.count.toLocaleString('en-IN')} prices`, `${showDate(ctx, sum.firstDate)} to ${showDate(ctx, sum.lastDate)}${sum.materialGapCount > 0 ? `, ${sum.materialGapCount} gap(s)` : ''}`] },
    ...(last ? [{ key: 'nav', cells: ['Latest price (NAV)', navPrice(last[1]), `on ${showDate(ctx, last[0])}`] }] : []),
  ];
  if (inv) {
    const xirr = showResult(inv.xirr, (v) => pct(v.rate));
    const cur = showResult(inv.currentValue, (v) => rupees(v.value));
    const put = showResult(inv.investedAmount, (v) => rupees(v.invested));
    const gain = showResult(inv.gainLoss, (v) => rupees(v.gainLoss));
    factRows.push(
      { key: 'cur', cells: ['Value now', figure(cur, fnA).node, inv.currentValue.state === 'available' ? `${inv.currentValue.value.basis === 'statement' ? 'statement value' : inv.currentValue.value.basis === 'redeemed' ? 'fully redeemed' : 'units x latest NAV'}${inv.currentValue.value.navDate ? `, NAV of ${showDate(ctx, inv.currentValue.value.navDate)}` : ''}` : ''] },
      { key: 'put', cells: ['Amount you put in', figure(put, fnA).node, inv.investedAmount.state === 'available' && inv.investedAmount.value.firstInvestmentDate ? `first on ${showDate(ctx, inv.investedAmount.value.firstInvestmentDate)}` : ''] },
      { key: 'gain', cells: ['Gain or loss', figure(gain, fnA).node, ''] },
      { key: 'xirr', cells: ['Your return (XIRR, a year)', figure(xirr, fnA).node, inv.xirr.state === 'available' ? `${showDate(ctx, inv.xirr.value.periodStart)} to ${showDate(ctx, inv.xirr.value.periodEnd)}` : ''] }
    );
  }
  const trailing: Row[] = s.pointToPoint.map((p) => {
    const abs = figure(showResult(p.result, (v) => pct(v.absoluteReturn)), fnA);
    const cg = figure(showResult(p.cagr, (v) => pct(v.cagr)), fnA);
    return { key: p.id, cells: [p.id.replace('Y', ' year'), abs.node, cg.node, p.result.state === 'available' ? period(ctx, p.result.value.startDate, p.result.value.endDate) : ''] };
  });
  const rolling: Row[] = s.rolling.map((r) => {
    const v = r.result.state === 'available' ? r.result.value : null;
    const withheld = v !== null && v.summary === null;
    const cell = (f: (x: NonNullable<NonNullable<typeof v>['summary']>) => string): React.ReactNode =>
      withheld ? <><span className="fa-na">Summary withheld</span><Marks letters={[fnA.mark('withheld', `Only ${v!.windowCount} rolling window(s) fit in this period: too few to summarise.`)]} /></> : figure(showResult(r.result, (x) => (x.summary ? f(x.summary) : '')), fnA).node;
    return { key: r.horizonId, cells: [r.horizonId, cell((x) => pct(x.median)), cell((x) => pct(x.min)), cell((x) => pct(x.max)), cell((x) => pct(x.positiveWindowShare))] };
  });

  // ---- sheet B ---------------------------------------------------------------------------------------------------
  function riskCell<T>(r: Nav2Result<T> | null, fmt: (v: T) => string, basis?: (v: T) => string): { node: React.ReactNode; basis: React.ReactNode } {
    const label = r && r.state === 'available' ? riskFreeLabelOf((r.provenance as { riskFree?: { seriesId?: string; seriesLabel?: string } }).riskFree) : null;
    const f = figure(showResult(r, fmt), fnB, { riskFreeNote, riskFreeLabel: label });
    return { node: f.node, basis: f.pointer ?? (basis && r && r.state === 'available' ? basis(r.value) : '') };
  }
  const vol = riskCell(s.volatility, (v) => pct(v.annualisedVolatility), (v) => `from ${v.returnCount} daily returns`);
  const sharpe = riskCell(s.sharpe, (v) => ratio(v.annualisedRatio));
  const sortino = riskCell(s.sortino, (v) => ratio(v.annualisedRatio));
  const dd = riskCell(s.maxDrawdown, (v) => pct(v.maxDrawdown), (v) => (v.status === 'no_drawdown' ? 'no fall' : `peak ${showDate(ctx, v.peakDate)}, low ${showDate(ctx, v.troughDate)}${v.recoveryDate ? `, recovered ${showDate(ctx, v.recoveryDate)}` : ', not yet recovered'}`));
  const beta = riskCell(s.beta, (v) => ratio(v.beta), (v) => `against ${v.benchmarkLabel}`);
  const alpha = riskCell(s.alpha, (v) => pct(v.alphaAnnualised), (v) => `against ${v.benchmarkLabel}`);
  const riskRows: Row[] = [
    { key: 'vol', cells: ['Volatility (annualised)', vol.node, vol.basis] },
    { key: 'sharpe', cells: ['Sharpe ratio', sharpe.node, sharpe.basis] },
    { key: 'sortino', cells: ['Sortino ratio', sortino.node, sortino.basis] },
    { key: 'dd', cells: ['Maximum drawdown', dd.node, dd.basis] },
    { key: 'beta', cells: ['Beta (vs declared benchmark)', beta.node, beta.basis] },
    { key: 'alpha', cells: ['Jensen’s alpha (a year)', alpha.node, alpha.basis] },
  ];
  const trendRows: Row[] = [
    ...s.movingAverages.map((m) => {
      const c = figure(showResult(m.result as Nav2Result<{ latest: { value: number; date: string } }>, (v) => navPrice(v.latest.value)), fnB);
      return { key: `${m.kind}${m.period}`, cells: [`${m.kind.toUpperCase()} ${m.period}`, c.node, m.result.state === 'available' ? showDate(ctx, (m.result.value as { latest: { date: string } }).latest.date) : ''] };
    }),
    ...s.rateOfChange.map((m) => {
      const c = figure(showResult(m.result as Nav2Result<{ latest: { value: number; date: string } }>, (v) => pct(v.latest.value)), fnB);
      return { key: `roc${m.period}`, cells: [`Rate of change, ${m.period} prices`, c.node, m.result.state === 'available' ? showDate(ctx, (m.result.value as { latest: { date: string } }).latest.date) : ''] };
    }),
    { key: 'hi', cells: ['Highest NAV in the period', figure(showResult(s.extremes, (v) => navPrice(v.highestNav)), fnB).node, s.extremes.state === 'available' ? showDate(ctx, s.extremes.value.highestNavDate) : ''] },
    { key: 'lo', cells: ['Lowest NAV in the period', figure(showResult(s.extremes, (v) => navPrice(v.lowestNav)), fnB).node, s.extremes.state === 'available' ? showDate(ctx, s.extremes.value.lowestNavDate) : ''] },
    { key: 'avg', cells: ['Average NAV (mean / median)', figure(showResult(s.average, (v) => `${navPrice(v.meanNav)} / ${navPrice(v.medianNav)}`), fnB).node, 'describes prices, not a return'] },
  ];

  // The compact money table repeats under its own heading on sheet B (the heading never stands over a lone sentence).
  const ownRows: Row[] = inv
    ? [
        { key: 'xirr', cells: ['Your return (XIRR, a year)', figure(showResult(inv.xirr, (v) => pct(v.rate)), fnB).node, inv.xirr.state === 'available' ? `${showDate(ctx, inv.xirr.value.periodStart)} to ${showDate(ctx, inv.xirr.value.periodEnd)}` : ''] },
        { key: 'cur', cells: ['Value now', figure(showResult(inv.currentValue, (v) => rupees(v.value)), fnB).node, inv.currentValue.state === 'available' ? `${inv.currentValue.value.basis === 'statement' ? 'statement value' : inv.currentValue.value.basis === 'redeemed' ? 'fully redeemed' : 'units x latest NAV'}${inv.currentValue.value.navDate ? `, NAV of ${showDate(ctx, inv.currentValue.value.navDate)}` : ''}` : ''] },
        { key: 'put', cells: ['Amount you put in', figure(showResult(inv.investedAmount, (v) => rupees(v.invested)), fnB).node, inv.investedAmount.state === 'available' && inv.investedAmount.value.firstInvestmentDate ? `first on ${showDate(ctx, inv.investedAmount.value.firstInvestmentDate)}` : ''] },
        { key: 'out', cells: ['Amount you took out', figure(showResult(inv.investedAmount, (v) => rupees(v.received)), fnB).node, ''] },
        { key: 'gain', cells: ['Gain or loss', figure(showResult(inv.gainLoss, (v) => rupees(v.gainLoss)), fnB).node, ''] },
      ]
    : [];

  return (
    <>
      <section className="fa-sheet fa-fund">
        <h2 className="fa-fund-name">{block.schemeName}</h2>
        {meta && <p className="fa-meta">{meta}</p>}
        {ownershipSentence(block.ownership) && <p className="fa-meta fa-own-share" data-fa-ownership={block.ownership?.mode}>{ownershipSentence(block.ownership)}</p>}
        <FaTable head={['At a glance', 'Value', 'Detail']} widths={[27, 22, 51]} num={[false, true, false]} rows={factRows} />
        <div className="fa-chart">
          <StaticNavChart block={block} ctx={ctx} />
        </div>
        <h3>The fund’s own growth</h3>
        <p className="fa-sub">{SCHEME_CAGR_LABEL}</p>
        <FaTable head={['Period', 'Total return', 'CAGR (a year)', 'Dates used']} widths={[17, 22, 22, 39]} num={[false, true, true, false]} rows={trailing} />
        <h3>Rolling returns</h3>
        <p className="fa-sub">Every available window, not a single start date.</p>
        <FaTable head={['Window', 'Median', 'Lowest', 'Highest', 'Windows above zero']} widths={[16, 20, 20, 20, 24]} num={[false, true, true, true, true]} rows={rolling} />
        <FootnoteList fn={fnA} />
      </section>

      <section className="fa-sheet fa-sheet-b">
        <h2 className="fa-fund-name">
          {block.schemeName} <span className="fa-cont">(continued)</span>
        </h2>
        <h3>Risk and risk-adjusted measures</h3>
        <p className="fa-sub">Over the report period, from daily prices.</p>
        <FaTable head={['Measure', 'Value', 'Basis']} widths={[29, 29, 42]} num={[false, true, false]} rows={riskRows} />
        <h3>Trend</h3>
        <p className="fa-sub">Latest value of each average, counted in price observations (not calendar days).</p>
        <FaTable head={['Measure', 'Latest', 'As at']} widths={[34, 24, 42]} num={[false, true, false]} rows={trendRows} />
        <h3>Your own money in this fund</h3>
        {ownershipSentence(block.ownership) && <p className="fa-sub">{ownershipSentence(block.ownership)}</p>}
        {inv ? (
          <>
            <p className="fa-sub">{INVESTOR_XIRR_LABEL}</p>
            <FaTable head={['Measure', 'Value', 'Detail']} widths={[34, 24, 42]} num={[false, true, false]} rows={ownRows} />
            <p className="fa-text">{a.explanation}</p>
          </>
        ) : (
          <p className="fa-text">Your own return is not shown for this fund because your transactions and holding could not be matched to it.</p>
        )}
        <FootnoteList fn={fnB} />
      </section>
    </>
  );
}

function corrRows(report: FundAnalyticsReport, ctx: Nav2Context, nm: (id: string) => string): Row[] {
  return report.comparison.correlations.map((p) => {
    const r = p.result as Nav2Result<CorrelationValue>;
    const v = r.state === 'available' ? r.value : null;
    const c = showResult(r, (x) => ratio(x.correlation));
    return {
      key: `${p.aInstrumentId}|${p.bInstrumentId}`,
      cells: [nm(p.aInstrumentId), nm(p.bInstrumentId), v ? c.text : <span key="na" className="fa-na">{c.headline}</span>, v ? v.commonReturnCount.toLocaleString('en-IN') : '', v ? period(ctx, v.windowStart, v.windowEnd) : ''],
    };
  });
}

export default function FundAnalyticsPrintDocument({ report, version }: { report: FundAnalyticsReport; version?: { versionNumber: number; createdAt: string } }) {
  const ctx: Nav2Context = { policy: NAV2_POLICY, currency: report.displayCurrency };
  const names = new Map(report.schemes.map((s) => [s.instrumentId, s.schemeName]));
  const nm = (id: string) => names.get(id) ?? 'Unknown fund';
  const riskFreeIdx = report.notes.findIndex((n) => /^Risk-free rate/i.test(n));
  const riskFreeNote = riskFreeIdx >= 0 ? riskFreeIdx + 1 : null;
  const fnCover = new Footnotes();

  const summaryRows: Row[] = report.schemes.map((b) => {
    const inv = b.analytics.investor;
    const three = b.analytics.scheme.pointToPoint.find((p) => p.id === '3Y');
    return {
      key: b.instrumentId,
      cells: [
        `${b.schemeName}${b.ownership?.mode === 'share' && b.ownership.jointBasisPoints !== null ? ` (your share ${percentLabel(b.ownership.jointBasisPoints)})` : b.ownership?.mode === 'not_set' ? ' (ownership share not set)' : ''}`,
        inv ? figure(showResult(inv.currentValue, (v) => rupees(v.value)), fnCover).node : '',
        inv ? figure(showResult(inv.gainLoss, (v) => rupees(v.gainLoss)), fnCover).node : '',
        inv ? figure(showResult(inv.xirr, (v) => pct(v.rate)), fnCover).node : '',
        three ? figure(showResult(three.cagr, (v) => pct(v.cagr)), fnCover).node : '',
      ],
    };
  });

  const expectedCharts = report.schemes.filter((b) => b.chart.navPoints.length >= 2).length;
  return (
    // Everything below is server-rendered HTML (no client-only chart): the print renderer waits for this marker and then checks that every
    // expected chart is in the page, so a missing chart can never be printed as a blank rectangle.
    <div className="fa-doc" data-fa-print-ready="true" data-fa-expected-charts={expectedCharts}>
      <section className="fa-cover">
        <h1>Fund analytics report</h1>
        <p className="fa-lead">
          As at {showDate(ctx, report.asOfDate)}. Period: {REPORT_PERIOD_LABELS[report.periodChoice]}.
        </p>
        {version && <p className="fa-version">{versionMadeLine(version.versionNumber, version.createdAt, report.displayCurrency)}</p>}
        <p className="fa-saved">{FUND_ANALYTICS_SAVED_REPORT_SENTENCE}</p>
        {report.schemes.length === 0 ? (
          <p className="fa-text">This report covers Indian mutual funds, and none could be analysed.</p>
        ) : (
          <>
            <p className="fa-text">
              {report.schemes.length} fund{report.schemes.length === 1 ? '' : 's'} analysed. The fund’s own growth and your own return are different things and are shown separately for each fund.
            </p>
            <h3>Your funds at a glance</h3>
            <FaTable head={['Fund', 'Value now', 'Gain or loss', 'Your return (XIRR)', 'Fund CAGR, 3 year']} widths={[34, 16, 16, 17, 17]} num={[false, true, true, true, true]} rows={summaryRows} />
            {report.schemes.some((b) => b.ownership) && (
              <p className="fa-sub">Where a fund is held jointly, the figures about your own money (value now, gain or loss, your return) are your share of it, as the fund sheet states. Your share of each fund is shown beside its name.</p>
            )}
            <FootnoteList fn={fnCover} />
            <h3>Price history used</h3>
            <p className="fa-sub">Every figure for a fund comes from its own published price history. Gaps are never filled in.</p>
            <FaTable
              head={['Fund', 'Prices', 'From', 'To', 'Gaps']}
              widths={[34, 14, 18, 18, 16]}
              num={[false, true, true, true, true]}
              rows={report.schemes.map((b) => ({ key: b.instrumentId, cells: [b.schemeName, b.navSeriesSummary.count.toLocaleString('en-IN'), showDate(ctx, b.navSeriesSummary.firstDate), showDate(ctx, b.navSeriesSummary.lastDate), String(b.navSeriesSummary.materialGapCount)] }))}
            />
          </>
        )}
        {report.notes.length > 0 && (
          <>
            <h3>Notes</h3>
            <ol className="fa-notes">
              {report.notes.map((n, i) => (
                <li key={i}>
                  <span className="fa-note-no">Note {i + 1}</span> {n}
                </li>
              ))}
            </ol>
          </>
        )}
        <h3>How to read this report</h3>
        <ul className="fa-howto">
          <li>{SCHEME_CAGR_LABEL}</li>
          <li>{INVESTOR_XIRR_LABEL}</li>
          <li>{FUND_ANALYTICS_CAGR_CONVENTION_NOTE}</li>
          <li>A figure that cannot be worked out is shown as a plain label, never as zero, and a small letter beside it points to the explanation printed once at the foot of that page.</li>
          <li>Dates are written day first. Prices are published by AMFI; nothing here is a recommendation to buy, sell or switch.</li>
        </ul>
      </section>

      {report.schemes.map((b) => (
        <FundSheets key={b.instrumentId} block={b} ctx={ctx} riskFreeNote={riskFreeNote} />
      ))}

      {report.schemes.length > 0 && (
        <section className="fa-sheet fa-comparison">
          <h2 className="fa-fund-name">Comparing your funds</h2>
          <p className="fa-meta">{report.comparison.label}: only the funds you hold are compared with each other, and only against funds of the same category, plan and option.</p>
          {report.comparison.rankings.map((r) => {
            const v = r.result.state === 'available' ? r.result.value : null;
            const cell = showResult(r.result, () => '');
            return (
              <div key={r.horizonId} className="fa-rank">
                <h3>Ranked by CAGR, {r.horizonId.replace('Y', ' year')}</h3>
                {!v && <p className="fa-text">{cell.headline}{cell.detail ? `: ${cell.detail}` : ''}</p>}
                {v && v.groups.length === 0 && <p className="fa-text">No two of your funds are comparable over this period.</p>}
                {v?.groups.map((g) => (
                  <FaTable
                    key={`${g.category}|${g.planType}|${g.optionType}`}
                    caption={`${g.category.replace(/_/g, ' ')}${g.planType ? `, ${g.planType} plan` : ''}${g.optionType ? `, ${g.optionType.replace(/_/g, ' ')}` : ''}`}
                    head={['Rank', 'Fund', 'CAGR']}
                    widths={[12, 68, 20]}
                    num={[true, false, true]}
                    rows={g.rows.map((row) => ({ key: row.instrumentId, cells: [`${row.rank}${row.tied ? ' (tied)' : ''}`, nm(row.instrumentId), pct(row.value)] }))}
                  />
                ))}
                {v && v.notComparable.length > 0 && <p className="fa-sub">Not comparable: {v.notComparable.map((n) => `${nm(n.instrumentId)} (${n.reason === 'category_unknown' ? 'its category is not known' : 'no other held fund of the same category, plan and option'})`).join('; ')}.</p>}
                {v && v.excluded.length > 0 && <p className="fa-sub">Left out of this ranking (no figure available): {v.excluded.map((e) => nm(e.instrumentId)).join('; ')}.</p>}
              </div>
            );
          })}
          <h3>How closely two of your funds move together</h3>
          {report.comparison.correlationsSkippedReason ? (
            <p className="fa-text">{report.comparison.correlationsSkippedReason}</p>
          ) : report.schemes.length < 2 ? (
            <p className="fa-text">You need at least two funds to compare how they move together.</p>
          ) : (
            <>
              <FaTable head={['Fund A', 'Fund B', 'Correlation', 'Common returns', 'Period']} widths={[22, 22, 11, 16, 29]} num={[false, false, true, true, false]} rows={corrRows(report, ctx, nm)} />
              <p className="fa-sub">A correlation near 1 means the two funds usually rise and fall together; near 0, little relationship; below 0, they tend to move in opposite directions. It describes past returns only.</p>
            </>
          )}
        </section>
      )}
    </div>
  );
}
