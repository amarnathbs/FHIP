import type { IndiaMfReport, OwnerRow, OwnerSection, OwnerTiles, XirrOutcome } from '@/lib/engines/investment-intelligence/indiaMfReport';
import { formatIsoDateDMY } from '@/lib/engines/investment-intelligence/indiaMfReport';
import { NUM_CELL_CLASS, NUM_HEADER_CLASS } from '@/lib/ui/tableAlign';

// India Mutual Fund Investment Report — presentational only. Every number is
// read from the stored section data (the pure module's result); nothing is
// recalculated here. Shared by the on-screen report and the print / PDF view
// (ReportPreview is the one renderer for both).
//
// PRINT / PDF FIT. The 16-column table is wider than the portrait A4 text
// area, so the whole section sits inside `.india-mf-landscape` — a CSS named
// page (app/globals.css) that prints on A4 LANDSCAPE while the rest of the
// report stays portrait. Verified in the PDF renderer's own Chromium (see
// docs/investment-intelligence/INDIA_MF_INVESTMENT_REPORT_REPORT.md).
//
// MONEY. Whole rupees with Indian digit grouping, no currency symbol per cell
// (the header states "All amounts in Indian rupees (INR)"). Units to 3 dp and
// NAVs to 4 dp are quantities/prices, not amounts.

const INR_FORMAT = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const UNITS_FORMAT = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const NAV_FORMAT = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const INDEX_FORMAT = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function inr(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return 'n/a';
  const rounded = Math.round(n);
  return `${rounded < 0 ? '-' : ''}${INR_FORMAT.format(Math.abs(rounded))}`;
}
function units(n: number): string {
  return UNITS_FORMAT.format(n);
}
function nav(n: number | null): string {
  return n === null ? 'n/a' : NAV_FORMAT.format(n);
}
function xirrText(x: XirrOutcome): string {
  return x.status === 'ok' ? `${(x.rate * 100).toFixed(2)}%` : 'n/a';
}

const FOOTNOTE_MARK: Record<string, string> = {
  SWP: 'a',
  STP: 'b',
  BONUS_SPLIT: 'c',
  REINVESTMENT: 'd',
  UNMODELLED_UNITS: 'e',
  PARTIAL_HISTORY: 'f',
  NO_TRANSACTIONS: 'g',
  REVIEW_EXCLUDED: 'h',
  STATEMENT_UNITS: 'i',
  NAV_FROM_STATEMENT: 'j',
  NAV_STALE: 'k',
  NO_VALUATION: 'l',
  JOINT: 'm',
  METHOD: 'n',
};

function rowMarks(r: OwnerRow): string {
  const marks: string[] = [];
  if (r.flags.hasSwp) marks.push(FOOTNOTE_MARK.SWP);
  if (r.flags.hasStp) marks.push(FOOTNOTE_MARK.STP);
  if (r.flags.hasBonusOrSplit) marks.push(FOOTNOTE_MARK.BONUS_SPLIT);
  if (r.flags.hasReinvestment) marks.push(FOOTNOTE_MARK.REINVESTMENT);
  if (r.flags.hasTransfer || r.flags.hasUnmodelled) marks.push(FOOTNOTE_MARK.UNMODELLED_UNITS);
  if (r.basis.partial && !r.flags.noTransactions) marks.push(FOOTNOTE_MARK.PARTIAL_HISTORY);
  if (r.flags.noTransactions) marks.push(FOOTNOTE_MARK.NO_TRANSACTIONS);
  if (r.flags.reviewExcludedCount > 0) marks.push(FOOTNOTE_MARK.REVIEW_EXCLUDED);
  if (r.flags.ledgerDiffersFromStatement) marks.push(FOOTNOTE_MARK.STATEMENT_UNITS);
  if (r.navSource === 'statement_value') marks.push(FOOTNOTE_MARK.NAV_FROM_STATEMENT);
  if (r.flags.navStale && r.latestNavDate) marks.push(FOOTNOTE_MARK.NAV_STALE);
  if (r.currentValue === null) marks.push(FOOTNOTE_MARK.NO_VALUATION);
  if (r.jointFolio) marks.push(FOOTNOTE_MARK.JOINT);
  return marks.join(',');
}

function Tile({ code, label, value, hint }: { code: string; label: string; value: string; hint?: string }) {
  return (
    <div className="rounded border border-gray-200 px-2 py-1.5">
      <p className="text-[10px] uppercase tracking-wide text-gray-500">
        <span className="font-semibold text-gray-700">{code}</span> {label}
      </p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums text-gray-900">{value}</p>
      {hint && <p className="text-[9px] text-gray-400">{hint}</p>}
    </div>
  );
}

function Tiles({ t }: { t: OwnerTiles }) {
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-9 print:grid-cols-9" data-testid="india-mf-tiles">
      <Tile code="A" label="Purchase" value={inr(t.purchase)} />
      <Tile code="B" label="Switch In" value={inr(t.switchIn)} />
      <Tile code="C" label="Switch Out" value={inr(t.switchOut)} />
      <Tile code="D" label="Red/SWP" value={inr(t.redemptionSwp)} />
      <Tile code="E" label="Div Payout" value={inr(t.dividend)} />
      <Tile code="F" label="Net Investment" value={inr(t.netInvestment)} hint="A+B-C-D-E" />
      <Tile code="G" label="Current Value" value={inr(t.currentValue)} hint={t.unvaluedPositions > 0 ? `excludes ${t.unvaluedPositions} unvalued` : undefined} />
      <Tile code="H" label="Overall Gain" value={inr(t.overallGain)} hint="G-F" />
      <Tile code="" label="XIRR%" value={xirrText(t.xirr)} hint={t.xirr.status === 'na' ? t.xirr.detail : undefined} />
    </div>
  );
}

const TH = 'px-1 py-1 align-bottom text-[9px] font-semibold uppercase leading-tight text-gray-500';
const TD = 'px-1 py-1 align-top text-[10px] leading-tight';

function OwnerTable({ section }: { section: OwnerSection }) {
  const t = section.tiles;
  const naNotes: string[] = [];
  for (const r of section.rows) {
    if (r.xirr.status === 'na') naNotes.push(`${r.schemeName}${r.folio ? ` (folio ${r.folio})` : ''}: XIRR n/a - ${r.xirr.detail}.`);
    if (r.avgNav === null && !r.flags.noTransactions && !r.flags.redeemed) naNotes.push(`${r.schemeName}${r.folio ? ` (folio ${r.folio})` : ''}: average NAV n/a - no unit with a recorded purchase cost is held.`);
    if (r.realisedGain === null && r.flags.redeemed === false && r.basis.reasons.includes('disposal_of_units_before_uploaded_history')) {
      naNotes.push(`${r.schemeName}${r.folio ? ` (folio ${r.folio})` : ''}: realised gain n/a - the units sold were bought before the uploaded history.`);
    }
  }
  return (
    <div className="overflow-x-auto" data-testid="india-mf-table-wrap">
      <table className="india-mf-table w-full min-w-[1000px] table-fixed border-collapse text-gray-900" data-testid="india-mf-table">
        <colgroup>
          <col style={{ width: '8%' }} />
          <col style={{ width: '15%' }} />
          <col style={{ width: '5.5%' }} />
          <col style={{ width: '5.5%' }} />
          <col style={{ width: '4.5%' }} />
          <col style={{ width: '5.5%' }} />
          <col style={{ width: '5.5%' }} />
          <col style={{ width: '5.5%' }} />
          <col style={{ width: '6%' }} />
          <col style={{ width: '6%' }} />
          <col style={{ width: '5%' }} />
          <col style={{ width: '4%' }} />
          <col style={{ width: '7.5%' }} />
          <col style={{ width: '6%' }} />
          <col style={{ width: '6%' }} />
          <col style={{ width: '4.5%' }} />
        </colgroup>
        <thead className="border-b border-gray-300 text-left">
          <tr>
            <th className={TH}>Folio</th>
            <th className={TH}>Scheme</th>
            <th className={TH}>Start Dt</th>
            <th className={`${TH} ${NUM_HEADER_CLASS}`}>Units</th>
            <th className={`${TH} ${NUM_HEADER_CLASS}`}>Avg NAV</th>
            <th className={`${TH} ${NUM_HEADER_CLASS}`}>Latest NAV</th>
            <th className={`${TH} ${NUM_HEADER_CLASS}`}>Inv Amt</th>
            <th className={`${TH} ${NUM_HEADER_CLASS}`}>Switch In Amt</th>
            <th className={`${TH} ${NUM_HEADER_CLASS}`}>Red/SWP Amt</th>
            <th className={`${TH} ${NUM_HEADER_CLASS}`}>Switch Out Amt</th>
            <th className={`${TH} ${NUM_HEADER_CLASS}`}>Dividend</th>
            <th className={`${TH} ${NUM_HEADER_CLASS}`}>Avg Days</th>
            <th className={`${TH} ${NUM_HEADER_CLASS}`}>Curr Value</th>
            <th className={`${TH} ${NUM_HEADER_CLASS}`}>Unrealised Gain</th>
            <th className={`${TH} ${NUM_HEADER_CLASS}`}>Realised Gain</th>
            <th className={`${TH} ${NUM_HEADER_CLASS}`}>XIRR</th>
          </tr>
        </thead>
        <tbody>
          {section.rows.map((r) => {
            const marks = rowMarks(r);
            return (
              <tr key={`${r.accountId}:${r.instrumentId}:${r.shareBasisPoints}`} className="border-t border-gray-100">
                <td className={`${TD} break-words`}>
                  {r.folio ?? 'n/a'}
                  {r.jointFolio && <span className="block text-[9px] text-gray-500">{(r.shareBasisPoints / 100).toFixed(2).replace(/\.00$/, '')}% share (joint folio)</span>}
                </td>
                <td className={`${TD} break-words`}>
                  {r.schemeName}
                  {marks && <sup className="ml-0.5 text-[8px] text-gray-500">{marks}</sup>}
                  {r.basis.label && <span className="block text-[9px] font-medium text-amber-700">{r.basis.label}</span>}
                  {r.flags.redeemed && <span className="block text-[9px] text-gray-500">fully redeemed</span>}
                </td>
                <td className={TD}>{r.startDate ? formatIsoDateDMY(r.startDate) : 'n/a'}</td>
                <td className={`${TD} ${NUM_CELL_CLASS}`}>{units(r.units)}</td>
                <td className={`${TD} ${NUM_CELL_CLASS}`}>{nav(r.avgNav)}</td>
                <td className={`${TD} ${NUM_CELL_CLASS}`}>
                  {nav(r.latestNav)}
                  {r.latestNavDate && <span className="block text-[8px] text-gray-400">{formatIsoDateDMY(r.latestNavDate)}</span>}
                </td>
                <td className={`${TD} ${NUM_CELL_CLASS}`}>{inr(r.purchase)}</td>
                <td className={`${TD} ${NUM_CELL_CLASS}`}>{inr(r.switchIn)}</td>
                <td className={`${TD} ${NUM_CELL_CLASS}`}>{inr(r.redemptionSwp)}</td>
                <td className={`${TD} ${NUM_CELL_CLASS}`}>{inr(r.switchOut)}</td>
                <td className={`${TD} ${NUM_CELL_CLASS}`}>{inr(r.dividend)}</td>
                <td className={`${TD} ${NUM_CELL_CLASS}`}>{r.avgDays === null ? 'n/a' : Math.round(r.avgDays)}</td>
                <td className={`${TD} ${NUM_CELL_CLASS}`}>{inr(r.currentValue)}</td>
                <td className={`${TD} ${NUM_CELL_CLASS}`}>{inr(r.unrealisedGain)}</td>
                <td className={`${TD} ${NUM_CELL_CLASS}`}>{inr(r.realisedGain)}</td>
                <td className={`${TD} ${NUM_CELL_CLASS}`}>{xirrText(r.xirr)}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-gray-300 font-semibold">
            <td className={TD} colSpan={2}>
              Fund Portfolio Total
            </td>
            <td className={TD} />
            <td className={TD} />
            <td className={TD} />
            <td className={TD} />
            <td className={`${TD} ${NUM_CELL_CLASS}`}>{inr(t.purchase)}</td>
            <td className={`${TD} ${NUM_CELL_CLASS}`}>{inr(t.switchIn)}</td>
            <td className={`${TD} ${NUM_CELL_CLASS}`}>{inr(t.redemptionSwp)}</td>
            <td className={`${TD} ${NUM_CELL_CLASS}`}>{inr(t.switchOut)}</td>
            <td className={`${TD} ${NUM_CELL_CLASS}`}>{inr(t.dividend)}</td>
            <td className={`${TD} ${NUM_CELL_CLASS}`}>{section.totalAvgDays === null ? 'n/a' : Math.round(section.totalAvgDays)}</td>
            <td className={`${TD} ${NUM_CELL_CLASS}`}>{inr(t.currentValue)}</td>
            <td className={`${TD} ${NUM_CELL_CLASS}`}>{inr(t.unrealisedGain)}</td>
            <td className={`${TD} ${NUM_CELL_CLASS}`}>{inr(t.realisedGain)}</td>
            <td className={`${TD} ${NUM_CELL_CLASS}`}>{xirrText(t.xirr)}</td>
          </tr>
        </tfoot>
      </table>
      {naNotes.length > 0 && (
        <ul className="mt-1 list-disc pl-4 text-[9px] text-gray-500" data-testid="india-mf-na-notes">
          {naNotes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function IndexQuoteView({ label, q }: { label: string; q: IndiaMfReport['indices']['sensex'] }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-gray-500">{label}</p>
      {q.status === 'ok' && q.value !== null && q.date ? (
        <p className="text-sm font-semibold tabular-nums text-gray-900">
          {INDEX_FORMAT.format(q.value)} <span className="text-[10px] font-normal text-gray-500">as at {formatIsoDateDMY(q.date)}</span>
        </p>
      ) : (
        <p className="text-sm font-semibold text-gray-500" title={q.reason ?? undefined}>
          not available
        </p>
      )}
    </div>
  );
}

export function IndiaMfInvestmentReportSection({ report, title, narrative, limitation }: { report: IndiaMfReport; title: string; narrative: string | null; limitation: string | null }) {
  return (
    <div className="india-mf-landscape space-y-4 rounded-card border bg-white p-6" data-testid="india-mf-report">
      <div>
        <h2 className="text-lg font-semibold text-trust">{title}</h2>
        {narrative && <p className="mt-1 text-justify text-sm text-gray-600">{narrative}</p>}
      </div>
      <div className="grid grid-cols-2 gap-3 rounded border border-gray-200 p-3 sm:grid-cols-4" data-testid="india-mf-header">
        <div>
          <p className="text-[10px] uppercase tracking-wide text-gray-500">Valuation Date</p>
          <p className="text-sm font-semibold tabular-nums text-gray-900">{formatIsoDateDMY(report.valuationDate)}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-gray-500">Report Date</p>
          <p className="text-sm font-semibold tabular-nums text-gray-900">{formatIsoDateDMY(report.reportDate)}</p>
        </div>
        <IndexQuoteView label="BSE Sensex" q={report.indices.sensex} />
        <IndexQuoteView label="Nifty 50" q={report.indices.nifty} />
      </div>
      <p className="text-[10px] text-gray-500">All amounts in Indian rupees (INR). {report.notSummedNote}</p>
      {report.sections.map((s) => (
        <section key={s.key} className={`space-y-2 ${s.rows.length <= 8 ? 'break-inside-avoid' : ''}`} data-testid={`india-mf-owner-${s.kind}`}>
          <h3 className="text-sm font-semibold text-gray-900">
            {s.label}
            {s.roleLabel && <span className="ml-2 text-xs font-normal text-gray-500">{s.roleLabel}</span>}
          </h3>
          {s.kind === 'entity' && <p className="text-[10px] text-gray-500">Held by an entity: shown separately and not added to any personal holdings.</p>}
          {s.notes.length > 0 && <p className="text-[10px] text-amber-700">Reason: {s.notes.join('; ')}.</p>}
          <Tiles t={s.tiles} />
          <OwnerTable section={s} />
        </section>
      ))}
      {(report.excluded.nonInrMutualFundPositions > 0 || report.excluded.nonMutualFundPositions > 0) && (
        <p className="text-[10px] text-gray-500">
          Not included in this report: {report.excluded.nonInrMutualFundPositions} mutual fund holding{report.excluded.nonInrMutualFundPositions === 1 ? '' : 's'} held in a non-INR account and{' '}
          {report.excluded.nonMutualFundPositions} holding{report.excluded.nonMutualFundPositions === 1 ? '' : 's'} that {report.excluded.nonMutualFundPositions === 1 ? 'is' : 'are'} not mutual funds. They appear elsewhere in your report.
        </p>
      )}
      {report.footnotes.length > 0 && (
        <ol className="space-y-1 text-[10px] text-gray-600" data-testid="india-mf-footnotes">
          {report.footnotes.map((f) => (
            <li key={f.code}>
              <span className="font-semibold">({FOOTNOTE_MARK[f.code] ?? '*'})</span> {f.text}
              {f.affected.length > 0 && <span className="text-gray-500"> Applies to: {f.affected.join('; ')}.</span>}
            </li>
          ))}
        </ol>
      )}
      {limitation && <p className="text-justify text-[10px] text-gray-400">{limitation}</p>}
    </div>
  );
}
