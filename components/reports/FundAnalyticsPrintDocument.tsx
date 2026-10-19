import StaticNavChart from '@/components/reports/StaticNavChart';
import { COMPARISON_FULL_MAX_FUNDS, COMPARISON_MAX_RANK_ROWS, COMPARISON_TOP_PAIRS, FUND_ANALYTICS_DEFAULT_PAGES_PER_FUND, type FundPagePlan } from '@/lib/config/nav2/printLayout';
import { REPORT_PERIOD_LABELS } from '@/lib/engines/nav2/analysisSpec';
import type { FundAnalyticsReport, FundAnalyticsSchemeBlock } from '@/lib/engines/nav2/fundAnalyticsReport';
import { INVESTOR_XIRR_LABEL, SCHEME_CAGR_LABEL } from '@/lib/engines/nav2/investorExperience';
import { navPrice, period, pct, ratio, rupees, showResult, type ShownCell } from '@/lib/engines/nav2/presentation';
import { BETA_ALPHA_NO_BENCHMARK_LINE, betaAlphaNoBenchmark, HOW_CALCULATED_HEADING, pricesRunToLine, FUND_ANALYTICS_CAGR_CONVENTION_NOTE, FUND_ANALYTICS_SAVED_REPORT_SENTENCE, riskFreeLabelOf, versionMadeLinePrint } from '@/lib/engines/nav2/reportWording';
import { ownershipSentence, percentLabel } from '@/lib/engines/nav2/ownershipShare';
import type { CorrelationValue } from '@/lib/engines/nav2/schemeRisk';
import { showDate, type Nav2Context, type Nav2Result } from '@/lib/engines/nav2/types';
import { NAV2_POLICY } from '@/lib/config/nav2/metricPolicy';

// The Fund analytics report as a DOCUMENT (the print route and the PDF). One component, the page layout in app/globals.css under .fa-doc.
//
// LAYOUT RULES (PO feedback on the first PDF: big blank areas, headings stranded from their tables, one bordered card spread over several
// pages, no fund name on the later pages, cramped tables, the same long sentence in every cell):
//   * a COVER page (title, version line, the saved-report sentence, one summary row per fund, the report notes ONCE);
//   * THE DOCUMENT FLOWS (PO 19-10-2026, "a lot of empty space in the report"): nothing forces a page break. A fund (one-page plan, the default) is a
//     HEAD (name, price facts, chart) and a BODY of blocks (each a heading with its table) in two balanced columns; every head, block, ranking and the
//     method note is kept whole, so a chart or a table never splits, but a page may end between them. With more than one fund each body opens with
//     a one-line tag naming its fund, because a page can now begin with a body. A report that cannot compare anything (one fund, or no peers) ends with
//     ONE small block (the "not applicable" lines and "How this was calculated") that follows the last fund, never a page of its own;
//   * the two-page fallback plan (the headless export when a piece does not fit a page): each fund is TWO explicit sheets, each starting with the
//     fund name on a fresh page: sheet A (facts, price chart, trailing and rolling returns) and sheet B (risk, trend, your own money);
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

/** The chart's drawing height on a one-page fund (the two-page plan keeps the default). */
const CHART_HEIGHT_COMPACT = 125;
const WIDTHS_TWO_PAGES = { glance: [27, 22, 51], growth: [17, 22, 22, 39], rolling: [16, 20, 20, 20, 24], risk: [29, 29, 42], trend: [34, 24, 42], own: [34, 24, 42] };
// half-width tables (a column is 86 mm)
const WIDTHS_ONE_PAGE = { glance: [27, 22, 51], growth: [12, 22, 22, 44], rolling: [14, 21, 21, 21, 23], risk: [34, 22, 44], trend: [44, 28, 28], own: [38, 20, 42] };
const BOUNDARY_NOTE = 'Prices are not published every day. Where a start or end date had no price, the latest earlier price (within 10 days) was used; each fund’s own page shows the dates actually used.';
/** A correlation table of this many rows or fewer is kept whole on a page (a small table is never split); a longer one may split between rows, its header row repeating. */
const KEEP_TABLE_MAX_ROWS = 6;
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

/** A footnote is an explanation, not a data dump: the engine's own text can be very long (a solver listing hundreds of roots), so a printed note is capped. The full text stays in the stored report. */
export const FOOTNOTE_MAX_CHARS = 320;
export function clipFootnote(text: string): string {
  if (text.length <= FOOTNOTE_MAX_CHARS) return text;
  const cut = text.slice(0, FOOTNOTE_MAX_CHARS);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), FOOTNOTE_MAX_CHARS - 40))} ... (shortened here; the full text is in the stored report)`;
}

function FootnoteList({ fn }: { fn: Footnotes }) {
  const items = fn.list();
  if (items.length === 0) return null;
  return (
    <div className="fa-footnotes">
      {items.map((x) => (
        <p key={x.letter}>
          <sup className="fa-mark">{x.letter}</sup> {clipFootnote(x.text)}
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

function FundSheets({ block, ctx, riskFreeNote, onePage, nameTag }: { block: FundAnalyticsSchemeBlock; ctx: Nav2Context; riskFreeNote: number | null; onePage: boolean; nameTag: boolean }) {
  const a = block.analytics;
  const s = a.scheme;
  const inv = a.investor;
  const meta = [block.categoryLabel, block.planType && block.planType !== 'not_applicable' ? `${block.planType} plan` : null, block.optionType && block.optionType !== 'not_applicable' ? block.optionType.replace(/_/g, ' ') : null].filter(Boolean).join(' - ');
  const last = block.chart.navPoints[block.chart.navPoints.length - 1];
  const sum = block.navSeriesSummary;
  const fnA = new Footnotes();
  // one page per fund: ONE footnote list for the whole page, so the letters never repeat
  const fnB = onePage ? fnA : new Footnotes();
  const W = onePage ? WIDTHS_ONE_PAGE : WIDTHS_TWO_PAGES;

  // ---- sheet A ---------------------------------------------------------------------------------------------------
  const factRows: Row[] = [
    { key: 'hist', cells: ['Price history', `${sum.count.toLocaleString('en-IN')} prices`, `${showDate(ctx, sum.firstDate)} to ${showDate(ctx, sum.lastDate)}${sum.materialGapCount > 0 ? `, ${sum.materialGapCount} gap(s)` : ''}`] },
    ...(last ? [{ key: 'nav', cells: ['Latest price (NAV)', navPrice(last[1]), `on ${showDate(ctx, last[0])}`] }] : []),
  ];
  // one page per fund: Value now, Amount you put in, Gain or loss and Your return are printed ONCE, in "Your own money in this fund" (the two-page plan repeats them here)
  if (inv && !onePage) {
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
  // when no benchmark is linked the two rows are not printed, so their footnote must not be registered either (an orphan footnote)
  const noBenchmark = betaAlphaNoBenchmark({ beta: s.beta as never, alpha: s.alpha as never });
  const beta = noBenchmark ? null : riskCell(s.beta, (v) => ratio(v.beta), (v) => `against ${v.benchmarkLabel}`);
  const alpha = noBenchmark ? null : riskCell(s.alpha, (v) => pct(v.alphaAnnualised), (v) => `against ${v.benchmarkLabel}`);
  const riskRows: Row[] = [
    { key: 'vol', cells: ['Volatility (annualised)', vol.node, vol.basis] },
    { key: 'sharpe', cells: ['Sharpe ratio', sharpe.node, sharpe.basis] },
    { key: 'sortino', cells: ['Sortino ratio', sortino.node, sortino.basis] },
    { key: 'dd', cells: ['Maximum drawdown', dd.node, dd.basis] },
    ...(beta && alpha ? [
      { key: 'beta', cells: ['Beta (vs declared benchmark)', beta.node, beta.basis] },
      { key: 'alpha', cells: ['Jensen’s alpha (a year)', alpha.node, alpha.basis] },
    ] : []),
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
    { key: 'avg', cells: ['Average NAV (mean / median)', <span key="avg" className="fa-wrapnum">{figure(showResult(s.average, (v) => `${navPrice(v.meanNav)} / ${navPrice(v.medianNav)}`), fnB).node}</span>, 'describes prices, not a return'] },
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

  // ---- the pieces, built once and arranged for the chosen page plan ------------------------------------------------
  const nameLine = (continued: boolean) => (
    <h2 className="fa-fund-name">
      {block.schemeName}
      {continued ? <span className="fa-cont"> (continued)</span> : null}
    </h2>
  );
  const identity = (
    <>
      {meta && <p className="fa-meta">{meta}</p>}
      {ownershipSentence(block.ownership) && <p className="fa-meta fa-own-share" data-fa-ownership={block.ownership?.mode}>{ownershipSentence(block.ownership)}</p>}
    </>
  );
  const glance = onePage ? (
    // one page per fund: the two facts about the fund's prices are one plain line (the money figures are in "Your own money in this fund")
    <p className="fa-facts" data-fa-facts="true">
      <span className="fa-fact-label">Price history</span> {sum.count.toLocaleString('en-IN')} prices, {showDate(ctx, sum.firstDate)} to {showDate(ctx, sum.lastDate)}
      {sum.materialGapCount > 0 ? `, ${sum.materialGapCount} gap(s)` : ''}.
      {last ? (
        <>
          {' '}
          <span className="fa-fact-label">Latest price (NAV)</span> {navPrice(last[1])} on {showDate(ctx, last[0])}.
        </>
      ) : null}
    </p>
  ) : (
    <FaTable head={['At a glance', 'Value', 'Detail']} widths={W.glance} num={[false, true, false]} rows={factRows} />
  );
  const chart = (
    <div className="fa-chart">
      <StaticNavChart block={block} ctx={ctx} height={onePage ? CHART_HEIGHT_COMPACT : undefined} />
    </div>
  );
  const growth = (
    <div className="fa-block">
      <h3>The fund’s own growth</h3>
      <p className="fa-sub">{SCHEME_CAGR_LABEL}</p>
      <FaTable head={['Period', 'Total return', 'CAGR (a year)', 'Dates used']} widths={W.growth} num={[false, true, true, false]} rows={trailing} />
    </div>
  );
  const rollingBlock = (
    <div className="fa-block">
      <h3>Rolling returns</h3>
      <p className="fa-sub">Every available window, not a single start date.</p>
      <FaTable head={['Window', 'Median', 'Lowest', 'Highest', 'Windows above zero']} widths={W.rolling} num={[false, true, true, true, true]} rows={rolling} />
    </div>
  );
  const risk = (
    <div className="fa-block">
      <h3>Risk and risk-adjusted measures</h3>
      <p className="fa-sub">Over the report period, from daily prices.</p>
      <FaTable head={['Measure', 'Value', 'Basis']} widths={W.risk} num={[false, true, false]} rows={riskRows} />
      {noBenchmark && <p className="fa-sub" data-fa-beta-alpha="none">{BETA_ALPHA_NO_BENCHMARK_LINE}</p>}
    </div>
  );
  const trend = (
    <div className="fa-block">
      <h3>Trend</h3>
      <p className="fa-sub">Latest value of each average, counted in price observations (not calendar days).</p>
      <FaTable head={['Measure', 'Latest', 'As at']} widths={W.trend} num={[false, true, false]} rows={trendRows} />
    </div>
  );
  const own = (
    <div className="fa-block">
      <h3>Your own money in this fund</h3>
      {ownershipSentence(block.ownership) && <p className="fa-sub">{ownershipSentence(block.ownership)}</p>}
      {inv ? (
        <>
          <p className="fa-sub">{INVESTOR_XIRR_LABEL}</p>
          <FaTable head={['Measure', 'Value', 'Detail']} widths={W.own} num={[false, true, false]} rows={ownRows} />
          <p className="fa-text">{a.explanation}</p>
        </>
      ) : (
        <p className="fa-text">Your own return is not shown for this fund because your transactions and holding could not be matched to it.</p>
      )}
    </div>
  );

  if (onePage) {
    // ONE page per fund: the name, the glance table and the chart across the full width, then two columns, then ONE footnote list.
    // Two keep-together pieces, not one indivisible page (PO 19-10-2026, "a lot of empty space"): the HEAD (name, identity, price facts, chart)
    // and the BODY (the two columns and the footnotes). Each is kept whole, so a chart or a table never splits; between them a page may end, so
    // the first fund can start on the summary's page instead of leaving half of it empty. With more than one fund, the body opens with a one-line
    // tag naming the fund, because a page can now begin with a body.
    return (
      <section className="fa-fund fa-one" data-fa-fund={block.instrumentId}>
        <div className="fa-fund-head">
          {nameLine(false)}
          {identity}
          {glance}
          {chart}
        </div>
        <div className="fa-fund-body">
          {nameTag ? <p className="fa-body-tag" data-fa-body-tag="true">{block.schemeName}: returns, risk and your own money</p> : null}
          <div className="fa-cols">
            <div className="fa-col">
              {growth}
              {rollingBlock}
              {risk}
            </div>
            <div className="fa-col">
              {own}
              {trend}
            </div>
          </div>
          <FootnoteList fn={fnA} />
        </div>
      </section>
    );
  }
  // TWO pages per fund: page A (glance, chart, growth, rolling) and page B (risk, trend, own money), each starting with the fund name.
  return (
    <>
      <section className="fa-fund fa-sheet-a" data-fa-fund={block.instrumentId}>
        {nameLine(false)}
        {identity}
        {glance}
        {chart}
        {growth}
        {rollingBlock}
        <FootnoteList fn={fnA} />
      </section>
      <section className="fa-fund fa-sheet-b">
        {nameLine(true)}
        {risk}
        {trend}
        {own}
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

const groupCaption = (g: { category: string; planType: string | null; optionType: string | null }): string =>
  `${g.category.replace(/_/g, ' ')}${g.planType ? `, ${g.planType} plan` : ''}${g.optionType ? `, ${g.optionType.replace(/_/g, ' ')}` : ''}`;

/**
 * The COMPACT comparison (more than COMPARISON_FULL_MAX_FUNDS funds): ONE ranking table (a row per fund, its CAGR and its rank among funds of
 * the same category, plan and option for 1, 3 and 5 years) and the most closely related pairs, so the page is one page for any number of funds.
 * What is left out is said in plain words under each table; nothing is invented and no figure is shown as zero.
 */
function CompactComparison({ report, ctx, nm }: { report: FundAnalyticsReport; ctx: Nav2Context; nm: (id: string) => string }) {
  const horizons = report.comparison.rankings.map((r) => r.horizonId);
  const per = new Map<string, { caption: string; cells: Map<string, { value: number; rank: number; tied: boolean }> }>();
  for (const r of report.comparison.rankings) {
    if (r.result.state !== 'available') continue;
    for (const g of r.result.value.groups) {
      for (const row of g.rows) {
        const e = per.get(row.instrumentId) ?? { caption: groupCaption(g), cells: new Map() };
        e.cells.set(r.horizonId, { value: row.value, rank: row.rank, tied: row.tied });
        per.set(row.instrumentId, e);
      }
    }
  }
  const order = ['3Y', '1Y', '5Y'];
  const firstRank = (id: string) => {
    const h = order.find((o) => per.get(id)?.cells.has(o));
    return h ? per.get(id)!.cells.get(h)!.rank : 999;
  };
  const ranked = [...per.keys()].sort((a, b) => per.get(a)!.caption.localeCompare(per.get(b)!.caption) || firstRank(a) - firstRank(b));
  const shown = ranked.slice(0, COMPARISON_MAX_RANK_ROWS);
  const unranked = report.schemes.filter((b) => !per.has(b.instrumentId)).length;
  const cell = (id: string, h: string): React.ReactNode => {
    const c = per.get(id)?.cells.get(h);
    return c ? `${pct(c.value)} (${c.rank}${c.tied ? ', tied' : ''})` : <span className="fa-na">Not ranked</span>;
  };
  const pairs = report.comparison.correlations
    .map((p) => ({ p, r: p.result as Nav2Result<CorrelationValue> }))
    .filter((x): x is { p: (typeof report.comparison.correlations)[number]; r: Extract<Nav2Result<CorrelationValue>, { state: 'available' }> } => x.r.state === 'available')
    .sort((x, y) => y.r.value.correlation - x.r.value.correlation || `${x.p.aInstrumentId}|${x.p.bInstrumentId}`.localeCompare(`${y.p.aInstrumentId}|${y.p.bInstrumentId}`));
  const topPairs = pairs.slice(0, COMPARISON_TOP_PAIRS);
  const totalPairs = report.comparison.correlations.length;
  return (
    <>
      <div className="fa-rank">
      <h3>Ranked by CAGR, within each category</h3>
      <p className="fa-sub">Each fund is ranked only against your other funds of the same category, plan and option; its rank is in brackets (1 is the highest).</p>
      {shown.length === 0 ? (
        <p className="fa-text">No two of your funds are comparable over these periods.</p>
      ) : (
        <FaTable
          head={['Fund', 'Category', ...horizons.map((h) => h.replace('Y', ' year'))]}
          widths={[30, 21, 16, 16, 17]}
          num={[false, false, true, true, true]}
          rows={shown.map((id) => ({ key: id, cells: [nm(id), per.get(id)!.caption, ...horizons.map((h) => cell(id, h))] }))}
        />
      )}
      {ranked.length > shown.length && <p className="fa-sub">Showing {shown.length} of the {ranked.length} ranked funds; the others are in the stored report.</p>}
      {unranked > 0 && (
        <p className="fa-sub">
          {unranked} fund{unranked === 1 ? ' is' : 's are'} not ranked: no other fund of the same category, plan and option, a category that is not known, or no figure for the period.
        </p>
      )}
      </div>
      <div className={`fa-corr${topPairs.length <= KEEP_TABLE_MAX_ROWS ? ' fa-keep' : ''}`}>
      <h3>How closely your funds move together</h3>
      {report.comparison.correlationsSkippedReason ? (
        <p className="fa-text">{report.comparison.correlationsSkippedReason}</p>
      ) : topPairs.length === 0 ? (
        <p className="fa-text">No pair of your funds has enough common history to compare.</p>
      ) : (
        <>
          <FaTable
            head={['Fund A', 'Fund B', 'Correlation', 'Common returns', 'Period']}
            widths={[29, 29, 13, 11, 18]}
            num={[false, false, true, true, false]}
            rows={topPairs.map(({ p, r }) => ({ key: `${p.aInstrumentId}|${p.bInstrumentId}`, cells: [nm(p.aInstrumentId), nm(p.bInstrumentId), ratio(r.value.correlation), r.value.commonReturnCount.toLocaleString('en-IN'), period(ctx, r.value.windowStart, r.value.windowEnd)] }))}
          />
          <p className="fa-sub">
            Showing the {topPairs.length} most closely related of {totalPairs.toLocaleString('en-IN')} pairs; the others are in the stored report. A correlation near 1 means the two funds usually rise and fall together; near 0, little relationship; below 0, they tend to move in opposite directions. It describes past returns only.
          </p>
        </>
      )}
      </div>
    </>
  );
}

/**
 * Can this report compare anything? Not when no ranking has a group of two or more comparable funds AND no pair of funds has a correlation (one fund,
 * or funds with no peer, or no common history). Then the comparison section is a COMPACT block that flows after the content before it (PO 19-10-2026:
 * a page of its own for "Not applicable" and one sentence was a wasted page). Pure.
 */
export function comparisonPossible(report: Pick<FundAnalyticsReport, 'comparison'>): boolean {
  const ranked = report.comparison.rankings.some((r) => r.result.state === 'available' && r.result.value.groups.length > 0);
  const correlated = !report.comparison.correlationsSkippedReason && report.comparison.correlations.some((p) => p.result.state === 'available');
  return ranked || correlated;
}

/** The page margin boxes (running header and footer) of the named page `fa`, switched off for the headless renderer, which fixes its own margins and draws its own header and footer. */
const NO_MARGIN_BOXES = '@media print{@page fa{@top-left{content:none}@top-right{content:none}@bottom-left{content:none}@bottom-right{content:none}}}';
/** Plain text only (a version line has no quote, brace, angle bracket or backslash): the value goes into a CSS string. */
const cssText = (t: string): string => t.replace(/[<>"'{};\\\r\n]/g, ' ').replace(/\s+/g, ' ').trim();

export default function FundAnalyticsPrintDocument({ report, version, pagesPerFund = FUND_ANALYTICS_DEFAULT_PAGES_PER_FUND, serverRender = false, timeZone = null }: { report: FundAnalyticsReport; version?: { versionNumber: number; createdAt: string }; pagesPerFund?: FundPagePlan; serverRender?: boolean; timeZone?: string | null }) {
  const ctx: Nav2Context = { policy: NAV2_POLICY, currency: report.displayCurrency };
  const names = new Map(report.schemes.map((s) => [s.instrumentId, s.schemeName]));
  const nm = (id: string) => names.get(id) ?? 'Unknown fund';
  const riskFreeIdx = report.notes.findIndex((n) => /^(Risk-free rate|Sharpe and Sortino compare)/i.test(n));
  const riskFreeNote = riskFreeIdx >= 0 ? riskFreeIdx + 1 : null;
  const fnCover = new Footnotes();
  const latestPriceDate = report.schemes.map((b) => b.navSeriesSummary.lastDate).filter((d): d is string => !!d).sort().slice(-1)[0] ?? null;

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

  const compactComparison = report.schemes.length > COMPARISON_FULL_MAX_FUNDS;
  const noComparison = !comparisonPossible(report);
  const expectedCharts = report.schemes.filter((b) => b.chart.navPoints.length >= 2).length;
  return (
    // Everything below is server-rendered HTML (no client-only chart): the print renderer waits for this marker and then checks that every
    // expected chart is in the page, so a missing chart can never be printed as a blank rectangle.
    <div className="fa-doc" data-fa-print-ready="true" data-fa-expected-charts={expectedCharts} data-fa-pages-per-fund={pagesPerFund}>
      {/* The running header (report name, version line) for the browser print path: read by the margin boxes of @page fa in app/globals.css. */}
      {/* dangerouslySetInnerHTML: React escapes a quote inside a <style> child to &quot; when it renders on the server, which a browser does not decode in CSS (the
          custom property would be invalid and the header empty). The text is plain (cssText removes every character that could end the rule or the element). */}
      <style dangerouslySetInnerHTML={{ __html: `${version ? `html{--fa-print-version:"${cssText(versionMadeLinePrint(version.versionNumber, version.createdAt, report.displayCurrency, timeZone))}"}` : ''}${serverRender ? NO_MARGIN_BOXES : ''}` }} />
      <section className="fa-cover">
        <h1>Fund analytics report</h1>
        <p className="fa-lead">
          As at {showDate(ctx, report.asOfDate)}. Period: {REPORT_PERIOD_LABELS[report.periodChoice]}.
        </p>
        {version && <p className="fa-version">{versionMadeLinePrint(version.versionNumber, version.createdAt, report.displayCurrency, timeZone)}</p>}
        <p className="fa-saved">{FUND_ANALYTICS_SAVED_REPORT_SENTENCE}</p>
        {report.schemes.length === 0 ? (
          <p className="fa-text">This report covers Indian mutual funds, and none could be analysed.</p>
        ) : (
          <>
            <p className="fa-text">
              {report.schemes.length} fund{report.schemes.length === 1 ? '' : 's'} analysed. The fund’s own growth and your own return are different things and are shown separately for each fund.
            </p>
            <h3>Your funds at a glance</h3>
            <FaTable head={['Fund', 'Value now', 'Gain or loss', 'Your return (XIRR)', 'Fund CAGR, 3 year']} widths={[44, 14, 14, 14, 14]} num={[false, true, true, true, true]} rows={summaryRows} />
            {report.schemes.some((b) => b.ownership) && (
              <p className="fa-sub">Where a fund is held jointly, the figures about your own money (value now, gain or loss, your return) are your share of it, as the fund sheet states. Your share of each fund is shown beside its name.</p>
            )}
            <FootnoteList fn={fnCover} />
            {latestPriceDate && <p className="fa-text" data-fa-prices-run-to="true">{pricesRunToLine(showDate(ctx, latestPriceDate))}</p>}
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
          <li>Dates are written day first.</li>
        </ul>
      </section>

      {report.schemes.map((b) => (
        <FundSheets key={b.instrumentId} block={b} ctx={ctx} riskFreeNote={riskFreeNote} onePage={pagesPerFund === 1} nameTag={report.schemes.length > 1} />
      ))}

      {report.schemes.length > 0 && (
        <section className={`fa-comparison${noComparison ? ' fa-comparison-none' : compactComparison ? ' fa-compact' : ''}`} data-fa-comparison={noComparison ? 'none' : compactComparison ? 'compact' : 'full'}>
          <div className="fa-comparison-head">
            <h2 className="fa-fund-name">Comparing your funds</h2>
            <p className="fa-meta">{report.comparison.label}: only the funds you hold are compared with each other, and only against funds of the same category, plan and option.</p>
          </div>
          {compactComparison && !noComparison ? (
            <CompactComparison report={report} ctx={ctx} nm={nm} />
          ) : (
            <>
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
          <div className={`fa-corr${report.comparison.correlations.length <= KEEP_TABLE_MAX_ROWS ? ' fa-keep' : ''}`}>
          <h3>How closely two of your funds move together</h3>
          {report.comparison.correlationsSkippedReason ? (
            <p className="fa-text">{report.comparison.correlationsSkippedReason}</p>
          ) : report.schemes.length < 2 ? (
            <p className="fa-text">You need at least two funds to compare how they move together.</p>
          ) : (
            <>
              <FaTable head={['Fund A', 'Fund B', 'Correlation', 'Common returns', 'Period']} widths={[29, 29, 13, 11, 18]} num={[false, false, true, true, false]} rows={corrRows(report, ctx, nm)} />
              <p className="fa-sub">A correlation near 1 means the two funds usually rise and fall together; near 0, little relationship; below 0, they tend to move in opposite directions. It describes past returns only.</p>
            </>
          )}
          </div>
            </>
          )}
          {report.calculationNotes && report.calculationNotes.length > 0 && (
            <div className="fa-calc" data-fa-calc="true">
              <h3>{HOW_CALCULATED_HEADING}</h3>
              {report.calculationNotes.map((n, i) => (
                <p key={i} className="fa-sub">{n}</p>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
