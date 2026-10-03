/**
 * Monthly Report - India investment chapters: the five issues found when the
 * DEV sample was rendered (PO instruction 2026-10-03).
 *
 *  1. Tiles Overall Gain / Net Investment / Current Value are computed on the SAME
 *     funds; an unvalued fund's flows no longer sit in F while its value is left
 *     out of G. Where cost is not recorded for all units, H is "n/a" and XIRR is
 *     visibly labelled; Start Dt and the basis label show the same date.
 *  2. Tax & Cost table: real fund name (never an id), day-first date, rupee
 *     amounts in INR (never "$" in an AUD report).
 *  3. Performance chapter and Mutual Fund section reconcile their XIRR in words;
 *     every chapter states one as-of date; India chapters use dd-mm-yyyy.
 *  4. SIP chapter: day-first dates and a human cadence label; one full stop after
 *     "Not available - reason"; an included X-Ray with no data says so.
 *
 * NEGATIVE CONTROLS. A green check that cannot fail proves nothing. For each fix the
 * pre-fix behaviour is reproduced here as a small faithful copy (or as the old
 * input to the new renderer) and the very assertion helper used on the new code is
 * shown to THROW against it (tests named "NEGATIVE CONTROL ...").
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildIndiaMfReport, formatIsoDateDMY, type IndiaMfReport, type IndiaMfReportInput, type MfTransaction, type OwnerRow } from '@/lib/engines/investment-intelligence/indiaMfReport';
import { IndiaMfInvestmentReportSection } from '@/components/reports/IndiaMfInvestmentReportSection';
import { taxTableRows, TAX_INSTRUMENT_NAME_MISSING } from '@/lib/engines/reportTaxTable';
import { asOfRuleSentence, chapterDateStyle, dayFirstDatesInText, xirrReconciliationNote } from '@/lib/engines/reportIndiaChapterConsistency';
import { buildInvestmentPerformance, buildSipContribution, buildPortfolioXray, buildTaxAndCost, buildIndiaMfInvestmentReport } from '@/lib/engines/reportSectionsPremium';
import { sipCadenceLabel } from '@/lib/engines/investment-intelligence/sip/sipDetection';
import { formatDateInText, formatDateShort } from '@/lib/engines/date';
import { formatMoneyWhole } from '@/lib/engines/money';
import { unavailableSentence, XRAY_NO_DATA_NOTE } from '@/lib/ui/reportNotes';
import type { ReportSourceData, PremiumSourceData } from '@/lib/services/reportSnapshotResolver';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let seq = 0;
function tx(over: Partial<MfTransaction> & Pick<MfTransaction, 'type' | 'date' | 'accountId' | 'instrumentId'>): MfTransaction {
  seq += 1;
  return { id: `t${seq}`, units: null, amount: 0, pricePerUnit: null, status: 'parsed', sourceReference: null, ...over };
}
function input(over: Partial<IndiaMfReportInput>): IndiaMfReportInput {
  return {
    valuationDate: '2026-10-03',
    reportDate: '2026-10-03',
    accounts: [{ id: 'A1', folioNumber: 'F-A1', ownerMemberId: 'M', currencyCode: 'INR', countryCode: 'IN' }],
    instruments: [],
    transactions: [],
    snapshots: [],
    navs: [],
    truth: [],
    allocations: [],
    members: [{ id: 'M', fullName: 'Asha Rao', relationship: 'self' }],
    entities: [],
    sensex: null,
    nifty: null,
    ...over,
  };
}
const fund = (id: string, name: string) => ({ id, name, isin: null, instrumentClass: 'mutual_fund' });

/** V: 100 units bought for 10,000, NAV 150 -> G 15,000, F 10,000, H 5,000.  U: 50 units bought for 5,000, NO NAV. */
function twoFundInput(): IndiaMfReportInput {
  return input({
    instruments: [fund('V', 'Valued Fund'), fund('U', 'Unvalued Fund')],
    transactions: [
      tx({ accountId: 'A1', instrumentId: 'V', type: 'purchase', date: '2025-01-02', units: 100, amount: 10000 }),
      tx({ accountId: 'A1', instrumentId: 'U', type: 'purchase', date: '2025-02-03', units: 50, amount: 5000 }),
    ],
    navs: [{ instrumentId: 'V', date: '2026-10-01', price: 150 }],
  });
}

/** Sample B shape: 10 opening units with no cost + 1 unit bought for 2,100, NAV 2,208.481. */
function partialCostInput(): IndiaMfReportInput {
  return input({
    instruments: [fund('H', 'HDFC Flexi Cap Fund')],
    transactions: [
      tx({ accountId: 'A1', instrumentId: 'H', type: 'adjustment', date: '2026-08-01', units: 10, amount: 0, sourceReference: 'OPENING_BALANCE' }),
      tx({ accountId: 'A1', instrumentId: 'H', type: 'purchase', date: '2026-08-15', units: 1, amount: 2100 }),
    ],
    navs: [{ instrumentId: 'H', date: '2026-09-24', price: 2208.481 }],
  });
}

function completeInput(): IndiaMfReportInput {
  return input({
    instruments: [fund('C', 'Complete Fund')],
    transactions: [tx({ accountId: 'A1', instrumentId: 'C', type: 'purchase', date: '2025-01-02', units: 100, amount: 10000 })],
    navs: [{ instrumentId: 'C', date: '2026-10-01', price: 150 }],
  });
}

// ---------------------------------------------------------------------------
// FIX 1 - tiles on one set of funds; incomplete cost basis is not a gain
// ---------------------------------------------------------------------------
/** The pre-fix tile maths (copied): every row's flows, only valued rows' value, gain = G - F. */
function legacyTiles(rows: OwnerRow[]) {
  const sum = (pick: (r: OwnerRow) => number) => rows.reduce((s, r) => s + pick(r), 0);
  const netInvestment = sum((r) => r.purchase) + sum((r) => r.switchIn) - sum((r) => r.switchOut) - sum((r) => r.redemptionSwp) - sum((r) => r.dividend);
  const currentValue = sum((r) => r.currentValue ?? 0);
  return { netInvestment, currentValue, overallGain: currentValue - netInvestment };
}

/** F and G must describe the same funds: F equals the net investment of exactly the valued rows. Throws otherwise. */
function assertSameFundSet(tiles: { netInvestment: number; currentValue: number }, rows: OwnerRow[]): void {
  const valued = rows.filter((r) => r.currentValue !== null);
  const f = valued.reduce((s, r) => s + r.netInvestment, 0);
  const g = valued.reduce((s, r) => s + (r.currentValue ?? 0), 0);
  if (Math.abs(tiles.netInvestment - f) > 1e-6) throw new Error(`Net Investment ${tiles.netInvestment} covers different funds than Current Value (valued funds' F = ${f})`);
  if (Math.abs(tiles.currentValue - g) > 1e-6) throw new Error(`Current Value ${tiles.currentValue} is not the sum of the valued funds (${g})`);
}

describe('FIX 1 - Net Investment, Current Value and Overall Gain cover the same funds', () => {
  it('a fund with units but no NAV is left out of F as well as G, so Overall Gain is not understated', () => {
    const section = buildIndiaMfReport(twoFundInput())!.sections[0];
    expect(section.rows).toHaveLength(2);
    const t = section.tiles;
    expect(t.unvaluedPositions).toBe(1);
    expect(t.purchase).toBeCloseTo(10000, 6); // not 15,000
    expect(t.netInvestment).toBeCloseTo(10000, 6);
    expect(t.currentValue).toBeCloseTo(15000, 6);
    expect(t.overallGain).toBeCloseTo(5000, 6); // legacy: 15,000 - 15,000 = 0
    expect(t.overallGain).toBeCloseTo((t.currentValue as number) - t.netInvestment, 9);
    assertSameFundSet(t, section.rows);
  });

  it('every tile, Avg Days and the total row cover the valued funds; the unvalued fund still shows its own row amounts', () => {
    const section = buildIndiaMfReport(twoFundInput())!.sections[0];
    const unvalued = section.rows.find((r) => r.schemeName === 'Unvalued Fund')!;
    expect(unvalued.purchase).toBeCloseTo(5000, 6); // its own row keeps its amounts
    expect(unvalued.currentValue).toBeNull();
    expect(section.tiles.xirr.status).toBe('ok'); // pooled on the valued fund only (it was n/a while an unvalued fund was pooled)
    const valuedOnly = buildIndiaMfReport(input({ instruments: [fund('V', 'Valued Fund')], transactions: [twoFundInput().transactions[0]], navs: twoFundInput().navs }))!.sections[0];
    expect(section.tiles.purchase).toBeCloseTo(valuedOnly.tiles.purchase, 9);
    expect(section.tiles.netInvestment).toBeCloseTo(valuedOnly.tiles.netInvestment, 9);
    expect(section.tiles.currentValue).toBeCloseTo(valuedOnly.tiles.currentValue, 9);
    expect(section.totalAvgDays).toBeCloseTo(valuedOnly.totalAvgDays as number, 9);
  });

  it('the rendered report says the unvalued fund is left out of the totals (footnote, tile hints, total row)', () => {
    const built = buildIndiaMfInvestmentReport({ currency: 'AUD' } as ReportSourceData, { indiaMf: { status: 'ok', report: buildIndiaMfReport(twoFundInput())! } } as unknown as PremiumSourceData)!;
    expect(built.narrativeText).toMatch(/1 holding has no NAV or statement value: it is listed but left out of the totals/);
    const report = (built.sectionData as { report: IndiaMfReport }).report;
    expect(report.footnotes.find((f) => f.code === 'NO_VALUATION')!.text).toMatch(/left out of every tile and of the Fund Portfolio Total row/);
    const html = renderToStaticMarkup(createElement(IndiaMfInvestmentReportSection, { report, title: 't', narrative: built.narrativeText, limitation: built.limitationText }));
    expect(html).toContain('excludes 1 unvalued');
    expect(html).toContain('excludes 1 fund without a valuation');
  });

  it('NEGATIVE CONTROL: the legacy tile maths puts the unvalued fund\'s flows in F while excluding its value, and the same-set check throws on it', () => {
    const rows = buildIndiaMfReport(twoFundInput())!.sections[0].rows;
    const legacy = legacyTiles(rows);
    expect(legacy.overallGain).toBeCloseTo(0, 6); // understated: the true gain of the valued fund is 5,000
    expect(() => assertSameFundSet(legacy, rows)).toThrow(/covers different funds/);
  });
});

describe('FIX 1 - incomplete cost basis is "n/a" / labelled, never a prominent gain', () => {
  it('Sample B shape: 1 of 11 units has a recorded cost -> Overall Gain n/a, XIRR carries the recorded-cost label', () => {
    const section = buildIndiaMfReport(partialCostInput())!.sections[0];
    const row = section.rows[0];
    expect(row.units).toBeCloseTo(11, 6);
    expect(row.basis.unitsWithoutRecordedCost).toBeCloseTo(10, 6);
    expect(row.unrealisedGain).toBeCloseTo(108.481, 3); // covers the recorded unit only (still shown, with the marker)
    expect(row.overallGain).toBeNull();
    expect(section.tiles.overallGain).toBeNull();
    expect(section.tiles.incompleteCostPositions).toBe(1);
    expect(row.xirr.status).toBe('ok');
    if (row.xirr.status === 'ok') expect(row.xirr.partialCost).toBe(true);
    expect(section.tiles.xirr.status === 'ok' && section.tiles.xirr.partialCost).toBe(true);
  });

  it('the report shows "n/a - incomplete cost basis" and "recorded cost only" instead of the 22,193 gain', () => {
    const report = buildIndiaMfReport(partialCostInput())!;
    const html = renderToStaticMarkup(createElement(IndiaMfInvestmentReportSection, { report, title: 't', narrative: null, limitation: null }));
    expect(html).toContain('n/a - incomplete cost basis');
    expect(html).toContain('recorded cost only');
    expect(html).toContain('overall gain n/a - incomplete cost basis (cost is recorded for 1.000 of 11.000 units held)');
    expect(html).not.toContain('22,193');
  });

  it('complete history is NOT blanket n/a: the gain and XIRR stay plain numbers', () => {
    const section = buildIndiaMfReport(completeInput())!.sections[0];
    expect(section.tiles.overallGain).toBeCloseTo(5000, 6);
    expect(section.tiles.incompleteCostPositions).toBe(0);
    expect(section.rows[0].overallGain).toBeCloseTo(5000, 6);
    const x = section.rows[0].xirr;
    expect(x.status === 'ok' && x.partialCost).toBeFalsy();
    const html = renderToStaticMarkup(createElement(IndiaMfInvestmentReportSection, { report: buildIndiaMfReport(completeInput())!, title: 't', narrative: null, limitation: null }));
    expect(html).not.toContain('recorded cost only');
    expect(html).not.toContain('incomplete cost basis');
  });

  it('NEGATIVE CONTROL: the legacy output (a 22,193 gain, an unlabelled XIRR) is rejected by the same prominence check', () => {
    const report = JSON.parse(JSON.stringify(buildIndiaMfReport(partialCostInput())!)) as IndiaMfReport;
    // Rebuild the legacy shape: gain = G - F over all units, XIRR without a label.
    const t = report.sections[0].tiles;
    (t as { overallGain: number | null }).overallGain = 24293.291 - 2100;
    if (t.xirr.status === 'ok') delete (t.xirr as { partialCost?: boolean }).partialCost;
    const row = report.sections[0].rows[0];
    if (row.xirr.status === 'ok') delete (row.xirr as { partialCost?: boolean }).partialCost;
    const assertNotProminent = (html: string) => {
      if (/22,193/.test(html)) throw new Error('an unreliable gain (G - F over all units) is shown as a number');
      if (!/recorded cost only/.test(html)) throw new Error('a partial-cost XIRR is shown without its label');
    };
    const legacyHtml = renderToStaticMarkup(createElement(IndiaMfInvestmentReportSection, { report, title: 't', narrative: null, limitation: null }));
    expect(() => assertNotProminent(legacyHtml)).toThrow();
    const fixedHtml = renderToStaticMarkup(createElement(IndiaMfInvestmentReportSection, { report: buildIndiaMfReport(partialCostInput())!, title: 't', narrative: null, limitation: null }));
    expect(() => assertNotProminent(fixedHtml)).not.toThrow();
  });
});

describe('FIX 1 - Start Dt and the basis label agree', () => {
  /** The legacy label date: the opening-balance (history) date, whatever Start Dt shows. */
  const legacyLabelDate = (row: OwnerRow) => row.basis.historyStartDate; // openingDate ?? historyStartDate
  function assertDatesAgree(row: { startDate: string | null; basis: { label: string | null } }, labelDate: string | null): void {
    if (row.startDate && labelDate && labelDate !== row.startDate) throw new Error(`Start Dt ${row.startDate} but the label says from ${labelDate}`);
  }

  it('Start Dt 15-08-2026 and the label "from 15-08-2026" show the same date', () => {
    const row = buildIndiaMfReport(partialCostInput())!.sections[0].rows[0];
    expect(row.startDate).toBe('2026-08-15');
    expect(row.basis.label).toBe(`from ${formatIsoDateDMY('2026-08-15')}; earlier history not uploaded`);
    expect(row.basis.label).toContain('15-08-2026');
    expect(row.basis.label).not.toContain('01-08-2026');
  });

  it('NEGATIVE CONTROL: the legacy label date (01-08-2026) disagrees with Start Dt and the check throws', () => {
    const row = buildIndiaMfReport(partialCostInput())!.sections[0].rows[0];
    expect(row.basis.historyStartDate).toBe('2026-08-01');
    expect(() => assertDatesAgree(row, legacyLabelDate(row))).toThrow(/Start Dt 2026-08-15 but the label says from 2026-08-01/);
    expect(() => assertDatesAgree(row, row.startDate)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// FIX 2 - Tax & Cost table
// ---------------------------------------------------------------------------
describe('FIX 2 - Tax & Cost table shows the fund name, a day-first date and rupee amounts', () => {
  const KEY = '0f1682d0-3236-43d3-a883-16f4e4f5f13d';
  const disposals = [{ instrumentKey: KEY, disposalDate: '2024-01-10', classification: 'equity_oriented', taxableGain: 80000 }];

  /** Throws on a blank/id instrument cell, an ISO date, or a "$" on rupee amounts. */
  function assertRowClean(r: { instrument: string; disposalDate: string; taxableGain: string }): void {
    if (!r.instrument.trim()) throw new Error('blank instrument cell');
    if (UUID.test(r.instrument)) throw new Error(`internal id visible: ${r.instrument}`);
    if (ISO_DATE.test(r.disposalDate)) throw new Error(`ISO date visible: ${r.disposalDate}`);
    if (r.taxableGain.includes('$')) throw new Error(`rupee amount shown with a dollar sign: ${r.taxableGain}`);
  }

  it('resolves the real name from the key, formats the date as dd-mm-yyyy and the gain in INR', () => {
    const [row] = taxTableRows(disposals, { [KEY]: 'R6F Threshold Fund X - Growth (Direct Plan)' });
    expect(row.instrument).toBe('R6F Threshold Fund X - Growth (Direct Plan)');
    expect(row.disposalDate).toBe('10-01-2024');
    expect(row.taxableGain).toBe(formatMoneyWhole(80000, 'INR'));
    expect(row.taxableGain).not.toContain('$');
    expect(row.taxableGain).not.toBe(formatMoneyWhole(80000, 'AUD'));
    expect(() => assertRowClean(row)).not.toThrow();
  });

  it('a fund whose name was not stored (older saved report) reads "Fund name not recorded", never the id', () => {
    const [row] = taxTableRows(disposals, undefined);
    expect(row.instrument).toBe(TAX_INSTRUMENT_NAME_MISSING);
    expect(JSON.stringify(row)).not.toMatch(UUID);
    const [named] = taxTableRows([{ ...disposals[0], instrumentName: KEY }], {});
    expect(named.instrument).toBe(TAX_INSTRUMENT_NAME_MISSING); // an id passed off as a name is also refused
  });

  it('the chapter builder carries the names in its section data and writes its narrative date in India\'s style even in an AUD report', () => {
    const tax = {
      results: { disposalResults: disposals, exitLoadResults: [], disclaimer: 'SIM.', residencyNote: null, ruleVersionNote: null },
      asOfDate: '2025-01-01',
      taxProfileSource: 'none',
      instrumentNames: { [KEY]: 'Named Fund' },
      earliestAcquisitionDateByInstrument: {},
    };
    const section = buildTaxAndCost({ currency: 'AUD', asOfDate: '2026-10-03' } as ReportSourceData, { taxAndCost: tax } as unknown as PremiumSourceData);
    expect((section.sectionData as { instrumentNames: Record<string, string> }).instrumentNames[KEY]).toBe('Named Fund');
    expect(section.narrativeText).toContain('01-01-2025');
    expect(section.narrativeText).not.toContain('01/01/2025');
  });

  it('ReportPreview uses the shared row builder (no raw instrumentName / disposalDate / report-currency fmt in the tax table)', () => {
    const src = read('components/reports/ReportPreview.tsx');
    const taxStart = src.indexOf('Tax & Cost Intelligence (II-R6)');
    const taxBlock = src.slice(taxStart, src.indexOf('India Mutual Fund Investment Report', taxStart));
    expect(taxBlock).toContain('taxTableRows(');
    expect(taxBlock).not.toContain('d.instrumentName');
    expect(taxBlock).not.toContain('formatDateShort');
    expect(taxBlock).not.toContain('fmt(d.taxableGain)');
  });

  it('NEGATIVE CONTROL: the legacy row (blank name, raw ISO date, AUD formatting) is rejected by the same check', () => {
    const legacyRow = (d: { instrumentName?: string; disposalDate: string; taxableGain: number }) => ({
      instrument: d.instrumentName ?? '', // the engine returns instrumentKey, so this was undefined -> blank
      disposalDate: d.disposalDate, // printed raw
      taxableGain: formatMoneyWhole(Number(d.taxableGain), 'AUD'), // the report currency
    });
    const legacy = legacyRow(disposals[0] as never);
    expect(() => assertRowClean(legacy)).toThrow(/blank instrument cell/);
    expect(() => assertRowClean({ ...legacy, instrument: 'X' })).toThrow(/ISO date visible/);
    expect(() => assertRowClean({ ...legacy, instrument: 'X', disposalDate: '10-01-2024' })).toThrow(/dollar sign/);
  });
});

// ---------------------------------------------------------------------------
// FIX 3 - XIRR reconciliation, one as-of date per chapter, one date style
// ---------------------------------------------------------------------------
function perfFixture(asOfDate: string, rate: number | null, currencyCode = 'INR') {
  return {
    results: {
      asOfDate,
      engineVersion: 'v-test',
      portfolios: [
        {
          currencyCode,
          portfolioXirr: rate === null ? { status: 'FAILED' } : { status: 'CALCULATED', value: { rate } },
          blendedBenchmarkReturn: { status: 'INSUFFICIENT_HISTORY' },
          drawdownSeries: [],
          performanceVsBenchmarkSeries: [],
        },
      ],
    },
    warnings: [],
    earliestCashFlowDateByInstrument: {},
  };
}
const AUD_SOURCE = { currency: 'AUD', asOfDate: '2026-10-03' } as ReportSourceData;

describe('FIX 3 - Performance chapter and Mutual Fund section do not disagree silently', () => {
  const mf = buildIndiaMfReport(completeInput())!;
  const mfRate = (mf.sections[0].tiles.xirr as { rate: number }).rate;

  /** Throws when the two XIRRs differ and the text says nothing about why. */
  function assertDifferenceExplained(perfRate: number | null, mfReport: IndiaMfReport, limitation: string): void {
    const mfX = mfReport.sections[0].tiles.xirr;
    const same = mfX.status === 'ok' && perfRate !== null && Math.abs(mfX.rate - perfRate) < 0.0005;
    if (!same && !/Mutual Fund Investment Report/.test(limitation)) throw new Error('XIRRs differ (or one is n/a) and the chapter does not say why');
  }

  it('agreeing XIRRs add no reconciliation sentence', () => {
    expect(xirrReconciliationNote([{ currencyCode: 'INR', xirr: { status: 'CALCULATED', rate: mfRate } }], '2026-10-01', mf, 'INR')).toBe('');
  });

  it('differing XIRRs are both stated with their as-of dates and the reason', () => {
    const note = xirrReconciliationNote([{ currencyCode: 'INR', xirr: { status: 'CALCULATED', rate: mfRate + 0.1 } }], '2026-09-24', mf, 'INR');
    expect(note).toContain('differs from the XIRR in the Mutual Fund Investment Report');
    expect(note).toContain('calculated to 24-09-2026');
    expect(note).toContain('valued at 03-10-2026');
    expect(note).toMatch(/every INR holding .* only mutual funds/);
  });

  it('an n/a on one side is explained with the engine\'s own reason', () => {
    const naMf = buildIndiaMfReport(twoFundInput())!; // single section, valued fund only -> XIRR ok; force the n/a
    const na = JSON.parse(JSON.stringify(naMf)) as IndiaMfReport;
    na.sections[0].tiles.xirr = { status: 'na', reason: 'NO_VALUATION', detail: 'no NAV or statement value is available to value the holding' };
    const note = xirrReconciliationNote([{ currencyCode: 'INR', xirr: { status: 'CALCULATED', rate: 0.3 } }], '2026-10-03', na, 'INR');
    expect(note).toContain('shows XIRR as n/a (no NAV or statement value is available to value the holding)');
    expect(note).toContain('30.0%');
  });

  it('several owner sections are not compared against one INR number; the chapter says so', () => {
    const two = JSON.parse(JSON.stringify(mf)) as IndiaMfReport;
    two.sections.push(two.sections[0]);
    expect(xirrReconciliationNote([{ currencyCode: 'INR', xirr: { status: 'CALCULATED', rate: 0.3 } }], '2026-10-03', two, 'INR')).toContain('for each owner separately');
  });

  it('the chapter builder puts the explanation and the as-of rule in the limitation text the report prints', () => {
    const section = buildInvestmentPerformance(AUD_SOURCE, { investmentPerformance: perfFixture('2026-09-24', mfRate + 0.1), indiaMf: { status: 'ok', report: mf } } as unknown as PremiumSourceData);
    expect(section.limitationText).toContain('differs from the XIRR in the Mutual Fund Investment Report');
    expect(section.limitationText).toContain('As-of date of this chapter: 24-09-2026');
    expect(() => assertDifferenceExplained(mfRate + 0.1, mf, section.limitationText as string)).not.toThrow();
  });

  it('NEGATIVE CONTROL: the legacy chapter text (no reconciliation) fails the same check when the XIRRs differ', () => {
    const legacyLimitation = 'Where a benchmark comparison is not shown, the platform does not fabricate a 0% or estimated benchmark return — it is marked as not available for that period.';
    expect(() => assertDifferenceExplained(0.3045, mf, legacyLimitation)).toThrow(/does not say why/);
  });
});

describe('FIX 3 - one as-of date per chapter, one date style per chapter', () => {
  const mfLoaded = { status: 'ok' as const, report: buildIndiaMfReport(completeInput())! };
  const sipResults = {
    asOfDate: '2026-09-24',
    seriesCount: 1,
    presentableCount: 0,
    engineVersion: 'sip-test',
    analytics: [{ series: { seriesKey: 's1' }, actualXirr: null, benchmarkSip: null, observations: [{ classification: 'OBSERVATION', text: 'x' }] }],
  };
  const xrayResults = { asOfDate: '2026-09-24', engineVersion: 'x', classificationVersion: 'v', sectorExposure: { status: 'unavailable', buckets: [] }, securityConcentration: {}, schemeConcentration: {} };
  const taxResults = { disposalResults: [{ instrumentKey: 'k', disposalDate: '2024-01-10', classification: 'long_term', taxableGain: 1 }], exitLoadResults: [], disclaimer: 'SIM.', residencyNote: null, ruleVersionNote: null };

  function chapters(source: ReportSourceData, premiumBits: Partial<PremiumSourceData> = {}) {
    const premium = {
      investmentPerformance: perfFixture('2026-09-24', 0.2),
      sip: { results: sipResults, warnings: [], earliestTransactionDateByInstrument: {} },
      xray: { results: xrayResults, warnings: [] },
      taxAndCost: { results: taxResults, asOfDate: '2025-01-01', taxProfileSource: 'none', instrumentNames: {}, earliestAcquisitionDateByInstrument: {} },
      indiaMf: mfLoaded,
      ...premiumBits,
    } as unknown as PremiumSourceData;
    return {
      performance: buildInvestmentPerformance(source, premium),
      sip: buildSipContribution(source, premium),
      xray: buildPortfolioXray(source, premium),
      tax: buildTaxAndCost(source, premium),
      mf: buildIndiaMfInvestmentReport(source, premium)!,
    };
  }
  const text = (s: { narrativeText: string | null; limitationText: string | null }) => `${s.narrativeText ?? ''} ${s.limitationText ?? ''}`;
  const SLASH_DATE = /\b\d{2}\/\d{2}\/\d{4}\b/;

  /** Throws when a chapter mixes styles, shows an ISO date, or states no as-of date. */
  function assertChapterConsistent(name: string, t: string): void {
    if (ISO_DATE.test(t)) throw new Error(`${name}: ISO date visible`);
    if (SLASH_DATE.test(t)) throw new Error(`${name}: AU slash date in an India chapter`);
    if (!/As-of date of this chapter: \d{2}-\d{2}-\d{4}/.test(t)) throw new Error(`${name}: no as-of date stated`);
  }

  it('in an AUD-currency report every India chapter writes dd-mm-yyyy and states its as-of date', () => {
    const c = chapters(AUD_SOURCE);
    for (const [name, section] of Object.entries(c)) assertChapterConsistent(name, text(section));
    expect(c.performance.narrativeText).toContain('24-09-2026');
    expect(c.sip.narrativeText).toContain('24-09-2026');
    expect(c.xray.narrativeText).toContain('24-09-2026');
    expect(c.tax.limitationText).toContain('As-of date of this chapter: 01-01-2025');
    expect(c.mf.limitationText).toContain('As-of date of this chapter: 03-10-2026');
  });

  it('a household with no India holdings keeps the report\'s own AU style in the SIP / X-Ray chapters', () => {
    const c = chapters(AUD_SOURCE, { indiaMf: null });
    expect(c.sip.narrativeText).toContain('24/09/2026');
    expect(c.xray.narrativeText).toContain('24/09/2026');
    expect(chapterDateStyle('AUD', ['AUD'])).toBe('AUD');
    expect(chapterDateStyle('AUD', ['INR'])).toBe('INR');
    expect(chapterDateStyle('INR', undefined)).toBe('INR');
  });

  it('asOfRuleSentence states one date and the report date in the requested style', () => {
    expect(asOfRuleSentence('2026-09-24', '2026-10-03', 'INR')).toBe('As-of date of this chapter: 24-09-2026, the latest date for which data exists for it (the report date is 03-10-2026).');
    expect(asOfRuleSentence('2026-09-24', null, 'AUD')).toBe('As-of date of this chapter: 24/09/2026, the latest date for which data exists for it.');
  });

  it('NEGATIVE CONTROL: legacy chapter text (AU slashes under a dd-mm-yyyy Mutual Fund section, no as-of rule) is rejected', () => {
    const legacyNarrative = `Your investment portfolio's XIRR and benchmark return as of ${formatDateInText('2026-09-24', 'AUD')} are shown below, where enough history exists to calculate them.`;
    expect(legacyNarrative).toContain('24/09/2026');
    expect(() => assertChapterConsistent('performance', legacyNarrative)).toThrow(/AU slash date/);
    const legacyIso = 'The most recent recorded contribution was on 2022-04-01.';
    expect(() => assertChapterConsistent('sip', legacyIso)).toThrow(/ISO date/);
    expect(() => assertChapterConsistent('x', 'As of 24-09-2026')).toThrow(/no as-of date stated/);
  });
});

// ---------------------------------------------------------------------------
// FIX 4 - SIP chapter text, the double full stop, the empty X-Ray
// ---------------------------------------------------------------------------
describe('FIX 4 - SIP chapter: day-first dates and a human cadence label', () => {
  const observations = [
    { classification: 'OBSERVATION', text: 'This series does not follow a regular interval. The most recent recorded contribution was on 2022-04-01.' },
    { classification: 'OBSERVATION', text: 'No published NAV is available on or before 2026-09-24, so the ending value cannot be established.' },
    { classification: 'OBSERVATION', text: '3 purchases occur at a consistent regular but non-standard interval, but the amounts vary.' },
  ];
  const sip = { results: { asOfDate: '2026-09-24', seriesCount: 3, presentableCount: 0, engineVersion: 'v', analytics: [{ series: { seriesKey: 's' }, actualXirr: null, benchmarkSip: null, observations }] }, warnings: [], earliestTransactionDateByInstrument: {} };

  /** Throws on an ISO date or an internal enum token inside a sentence. */
  function assertHumanText(t: string): void {
    if (ISO_DATE.test(t)) throw new Error(`ISO date inside a sentence: ${t}`);
    if (/\b[a-z]+_[a-z]+\b/.test(t)) throw new Error(`internal token inside a sentence: ${t}`);
  }

  it('the chapter shows every embedded date day-first (dd-mm-yyyy for an India household)', () => {
    const section = buildSipContribution(AUD_SOURCE, { sip, indiaMf: { status: 'ok', report: buildIndiaMfReport(completeInput())! } } as unknown as PremiumSourceData);
    const shown = (section.chartData?.observations as Array<{ text: string }>).map((o) => o.text);
    expect(shown[0]).toContain('on 01-04-2022');
    expect(shown[1]).toContain('on or before 24-09-2026');
    for (const t of shown) assertHumanText(t.replace(/\(.*?\)/g, ''));
  });

  it('dayFirstDatesInText leaves non-dates alone and honours the style', () => {
    expect(dayFirstDatesInText('on 2022-04-01 and 2023-1-1 and 12345', 'INR')).toBe('on 01-04-2022 and 2023-1-1 and 12345');
    expect(dayFirstDatesInText('on 2022-04-01', 'AUD')).toBe('on 01/04/2022');
  });

  it('the cadence token is a human phrase', () => {
    expect(sipCadenceLabel('OTHER_RECURRING')).toBe('regular but non-standard');
    expect(sipCadenceLabel('MONTHLY')).toBe('monthly');
    expect(sipCadenceLabel('OTHER_RECURRING')).not.toContain('_');
    const src = read('lib/engines/investment-intelligence/sip/sipDetection.ts');
    expect(src).not.toContain('${cadence.toLowerCase()}');
  });

  it('NEGATIVE CONTROL: the legacy sentences (ISO dates, other_recurring) fail the same check', () => {
    expect(() => assertHumanText('The most recent recorded contribution was on 2022-04-01.')).toThrow(/ISO date/);
    expect(() => assertHumanText(`3 purchases occur at a consistent ${'OTHER_RECURRING'.toLowerCase()} interval`)).toThrow(/internal token/);
    expect(() => assertHumanText('The most recent recorded contribution was on 01-04-2022.')).not.toThrow();
  });
});

describe('FIX 4 - "Not available" ends with exactly one full stop; an included X-Ray with no data says so', () => {
  const legacyUnavailable = (text: string | null) => `Not available${text ? ` — ${text}` : ''}.`;
  const assertSingleStop = (s: string) => {
    if (/\.\.$/.test(s)) throw new Error(`double full stop: ${s}`);
  };

  it('a reason that already ends in a full stop is not given a second one', () => {
    expect(unavailableSentence('Portfolio X-Ray requires fund-level look-through holding data.')).toBe('Not available — Portfolio X-Ray requires fund-level look-through holding data.');
    expect(unavailableSentence('no stop')).toBe('Not available — no stop.');
    expect(unavailableSentence(null)).toBe('Not available.');
    expect(unavailableSentence('trailing dots...  ')).toBe('Not available — trailing dots.');
    assertSingleStop(unavailableSentence('ends with a stop.'));
  });

  it('NEGATIVE CONTROL: the legacy sentence builder ends in ".." and the same check throws', () => {
    expect(() => assertSingleStop(legacyUnavailable('ends with a stop.'))).toThrow(/double full stop/);
  });

  it('an included X-Ray with an unavailable sector breakdown renders the one-line no-data note', () => {
    expect(XRAY_NO_DATA_NOTE).toMatch(/^No X-Ray data: /);
    const src = read('components/reports/ReportPreview.tsx');
    const xrayStart = src.indexOf('Portfolio X-Ray & Diversification (II-R5)');
    const xrayBlock = src.slice(xrayStart, src.indexOf('Tax & Cost Intelligence (II-R6)', xrayStart));
    expect(xrayBlock).toContain('XRAY_NO_DATA_NOTE');
    expect(xrayBlock).not.toMatch(/buckets\.length === 0\) return null/);
    expect(src).toContain('unavailableSentence(text)');
  });

  it('NEGATIVE CONTROL: the legacy X-Ray block (returns null when there is no table) is detected by the source check', () => {
    const legacyBlock = "if (!sectorExposure || sectorExposure.status !== 'ok' || sectorExposure.buckets.length === 0) return null;";
    expect(/buckets\.length === 0\) return null/.test(legacyBlock)).toBe(true);
  });
});

// Keep the shared formatter honest: India style is a dash, AU style a slash.
describe('formatter contract used by the fixes', () => {
  it('formatDateShort: INR dd-mm-yyyy, AUD dd/mm/yyyy', () => {
    expect(formatDateShort('2026-08-15', 'INR')).toBe('15-08-2026');
    expect(formatDateShort('2026-08-15', 'AUD')).toBe('15/08/2026');
  });
});
