// PC7 (M7) — unit certification for the Underlying Fund Holdings foundation.
//
// Covers O.2 through O.9 at the level a unit test can genuinely reach. Every
// assertion carries a stable Part W identifier in its title so the
// certification can cite a specific case rather than "the suite passed".
//
// WHAT THIS PACK DELIBERATELY DOES NOT DO: assert that something exists and
// stop. Each case either exercises a real decision with a real wrong answer
// available, or is not here.

import { describe, it, expect } from 'vitest';
import {
  parsePortfolioDisclosure,
  findHeaderRow,
  parseNumericCell,
  normaliseRatingBand,
  classifyControlLabel,
  classifySection,
  recordChecksum,
  fingerprintDisclosureBytes,
  PC7_DISCLOSURE_PARSER_VERSION,
  type DisclosureHoldingRecord,
} from '@/lib/services/investment-intelligence/pc7/portfolioDisclosureParser';
import {
  resolveSchemeIdentity,
  resolveConstituent,
  planSnapshot,
  snapshotContentChecksum,
  settleSnapshotBatch,
  decideStart,
  backoffMinutes,
  classifyFetch,
  buildAlerts,
  PC7_BATCH_KIND,
  PC7_JOB_KEY,
  PC7_BATCH_ATOMICITY,
  MIN_PLAUSIBLE_DISCLOSURE_BYTES,
  type SchemeIdentityIndex,
  type ConstituentIndex,
} from '@/lib/services/investment-intelligence/pc7/disclosureImportRunner';
import {
  findMissingDisclosures,
  assessSnapshotStaleness,
  findUnmappedSecurities,
  findCoverageGaps,
  summariseImportFailures,
  detectSourceChanges,
  classifySnapshotFreshness,
  COVERAGE_GAP_BELOW_PCT,
  type SnapshotRef,
  type HoldingLineRef,
} from '@/lib/services/investment-intelligence/pc7/lookthroughDataQuality';
import {
  assertNoLookthroughInNetWorthInputs,
  assertPc7WritesNoRegisterTable,
  assertDecompositionIsClosed,
  assertNetWorthUnchanged,
  NET_WORTH_INPUT_TABLES,
  LOOKTHROUGH_TABLES,
} from '@/lib/services/investment-intelligence/pc7/netWorthSafety';
import {
  PC7_DISCLOSURE_SOURCES,
  getDisclosureSource,
  buildDisclosureUrl,
  blockedDisclosureSources,
  anyDisclosureSourceEnabled,
  AMFI_PUBLISHES_NO_CONSTITUENT_DATASET,
} from '@/lib/config/investment-intelligence/pc7DisclosureSources';
import {
  calculatePortfolioLookThrough,
  calculateFundCoverage,
  type FundHoldingsSnapshot,
  type PortfolioFundPosition,
} from '@/lib/engines/investment-intelligence/xray/lookThrough';

// ---------------------------------------------------------------------------
// A realistic SEBI-layout grid, built to include every trap the parser exists
// to survive: banner rows above the header, a Sub Total, a Grand Total, a
// section with no weight, TREPS under no header, a negative net-payables row,
// an ISIN with a bad check digit, and a debt section with ratings.
// ---------------------------------------------------------------------------
const GRID: string[][] = [
  ['Example Asset Management Company Limited', '', '', '', '', '', ''],
  ['Monthly Portfolio Statement as on 31 August 2026', '', '', '', '', '', ''],
  ['Example Balanced Advantage Fund', '', '', '', '', '', ''],
  [],
  ['Name of the Instrument', 'ISIN', 'Industry^ / Rating', 'Quantity', 'Market value (Rs. in Lakhs)', '% to Net Assets', 'YTM'],
  ['EQUITY & EQUITY RELATED', '', '', '', '', '', ''],
  ['(a) Listed / awaiting listing on Stock Exchanges', '', '', '', '', '', ''],
  ['Reliance Industries Ltd', 'INE002A01018', 'Petroleum Products', '1,50,000', '4,500.00', '9.00', ''],
  ['HDFC Bank Ltd', 'INE040A01034', 'Banks', '2,00,000', '3,250.00', '6.50', ''],
  ['Infosys Ltd', 'INE009A01021', 'IT - Software', '1,00,000', '2,000.00', '4.00', ''],
  ['Some Unlisted Co Ltd', '', 'Industrial Products', '50,000', '500.00', '1.00', ''],
  ['Bad Checksum Co Ltd', 'INE009A01029', 'IT - Software', '10,000', '250.00', '0.50', ''],
  ['Sub Total', '', '', '', '10,500.00', '21.00', ''],
  ['DEBT INSTRUMENTS', '', '', '', '', '', ''],
  ['(a) Listed / awaiting listing on Stock Exchanges', '', '', '', '', '', ''],
  ['7.26% GOI 2033', 'IN0020230085', 'SOVEREIGN', '5,00,000', '5,000.00', '10.00', '7.10'],
  ['Example NBFC Ltd NCD', 'INE860H07123', 'CRISIL AAA', '2,000', '2,000.00', '4.00', '7.85'],
  ['Weak Credit Ltd NCD', 'INE999Z07011', 'CARE BB+', '1,000', '1,000.00', '2.00', '11.20'],
  ['Sub Total', '', '', '', '8,000.00', '16.00', ''],
  ['MONEY MARKET INSTRUMENTS', '', '', '', '', '', ''],
  ['Example Bank CD', 'INE238A16Z18', 'CRISIL A1+', '5,000', '2,500.00', '5.00', '6.90'],
  ['Sub Total', '', '', '', '2,500.00', '5.00', ''],
  ['TREPS / Reverse Repo', '', '', '', '1,250.00', '2.50', ''],
  ['Net Receivables / (Payables)', '', '', '', '(250.00)', '(0.50)', ''],
  ['Grand Total', '', '', '', '22,000.00', '44.00', ''],
];

function parseFixture() {
  return parsePortfolioDisclosure(GRID, {
    schemeLabel: 'Example Balanced Advantage Fund',
    holdingsAsOfDate: '2026-08-31',
    today: '2026-09-15',
  });
}

// ===========================================================================
describe('PC7-P — O.3/O.4 portfolio disclosure parser', () => {
  // -------------------------------------------------------------------------
  it('PC7-P-01: finds the header row BELOW the banner rows, not at row 0', () => {
    const found = findHeaderRow(GRID);
    expect(found).not.toBeNull();
    expect(found!.rowIndex).toBe(4);
    expect(found!.map.name).toBe(0);
    expect(found!.map.isin).toBe(1);
    expect(found!.map.industryOrRating).toBe(2);
    expect(found!.map.quantity).toBe(3);
    expect(found!.map.marketValue).toBe(4);
    expect(found!.map.weightPct).toBe(5);
    expect(found!.map.yieldPct).toBe(6);
  });

  it('PC7-P-02: refuses a grid with no weight column rather than guessing one', () => {
    const noWeight = [['Name of the Instrument', 'ISIN', 'Quantity'], ['Reliance Industries Ltd', 'INE002A01018', '100']];
    const res = parsePortfolioDisclosure(noWeight, { schemeLabel: 's', holdingsAsOfDate: '2026-08-31', today: '2026-09-15' });
    expect(res.records).toHaveLength(0);
    expect(res.rejections[0].reason).toBe('NO_HEADER_ROW');
    expect(res.columnMap).toBeNull();
  });

  // THE DOUBLE-COUNT TRAP — the single most important parser case.
  it('PC7-P-03: Sub Total / Grand Total rows are NEVER holdings (no double count)', () => {
    const res = parseFixture();
    const names = res.records.map((r) => r.instrumentName);
    expect(names).not.toContain('Sub Total');
    expect(names).not.toContain('Grand Total');
    // They are retained as ORACLES, not discarded.
    expect(res.controlTotals.filter((c) => c.kind === 'sub_total')).toHaveLength(3);
    expect(res.controlTotals.filter((c) => c.kind === 'grand_total')).toHaveLength(1);
  });

  it('PC7-P-04: had Sub Totals been parsed as holdings, the sum would have roughly doubled', () => {
    const res = parseFixture();
    const subTotalWeight = res.controlTotals.filter((c) => c.kind === 'sub_total').reduce((n, c) => n + (c.weightPct ?? 0), 0);
    // 21 + 16 + 5 = 42 on top of a genuine 44 — proof the trap is real, not theoretical.
    expect(subTotalWeight).toBeCloseTo(42, 6);
    expect(res.disclosedWeightTotalPct).toBeCloseTo(44, 6);
  });

  it('PC7-P-05: every accepted weight is the publisher\'s own, never rescaled to 100%', () => {
    const res = parseFixture();
    // The fixture genuinely discloses only 44%. A rescaling parser would show 100.
    expect(res.disclosedWeightTotalPct).toBeCloseTo(44, 6);
    expect(res.records.find((r) => r.instrumentName === 'Reliance Industries Ltd')!.weightPct).toBe(9);
  });

  it('PC7-P-06: section headers with no weight are headers, not zero-weight holdings', () => {
    const res = parseFixture();
    const names = res.records.map((r) => r.instrumentName);
    expect(names).not.toContain('EQUITY & EQUITY RELATED');
    expect(names).not.toContain('DEBT INSTRUMENTS');
    expect(res.sectionsSeen).toContain('EQUITY & EQUITY RELATED');
  });

  it('PC7-P-07: asset kinds are preserved as buckets, never redistributed into equity', () => {
    const res = parseFixture();
    const byName = new Map(res.records.map((r) => [r.instrumentName, r]));
    expect(byName.get('Reliance Industries Ltd')!.assetKind).toBe('security');
    expect(byName.get('Reliance Industries Ltd')!.section).toBe('EQUITY');
    expect(byName.get('7.26% GOI 2033')!.section).toBe('DEBT');
    expect(byName.get('Example Bank CD')!.section).toBe('MONEY_MARKET');
    expect(byName.get('TREPS / Reverse Repo')!.assetKind).toBe('cash');
    expect(byName.get('Net Receivables / (Payables)')!.assetKind).toBe('other');
  });

  it('PC7-P-08: a parenthesised negative weight is retained, not clamped or dropped', () => {
    const res = parseFixture();
    const payables = res.records.find((r) => r.instrumentName === 'Net Receivables / (Payables)')!;
    expect(payables.weightPct).toBe(-0.5);
    expect(res.warnings.some((w) => w.reason === 'NEGATIVE_WEIGHT_RETAINED')).toBe(true);
  });

  it('PC7-P-09: Indian-grouped quantities and lakh market values parse exactly', () => {
    const res = parseFixture();
    const reliance = res.records.find((r) => r.instrumentName === 'Reliance Industries Ltd')!;
    expect(reliance.quantity).toBe(150000);
    expect(reliance.marketValue).toBe(4500);
  });

  it('PC7-P-10: an ISIN failing its ISO 6166 check digit is DROPPED, and the line retained', () => {
    const res = parseFixture();
    const bad = res.records.find((r) => r.instrumentName === 'Bad Checksum Co Ltd')!;
    expect(bad).toBeDefined(); // retained
    expect(bad.isin).toBeNull(); // but unidentified
    expect(res.warnings.some((w) => w.reason === 'INVALID_ISIN_DROPPED')).toBe(true);
  });

  it('PC7-P-11: a security with no ISIN is retained and flagged, never name-matched away', () => {
    const res = parseFixture();
    const unlisted = res.records.find((r) => r.instrumentName === 'Some Unlisted Co Ltd')!;
    expect(unlisted.isin).toBeNull();
    expect(res.warnings.some((w) => w.reason === 'MISSING_ISIN')).toBe(true);
  });

  it('PC7-P-12: credit ratings band correctly, and AAA is not swallowed by the AA rule', () => {
    expect(normaliseRatingBand('CRISIL AAA').band).toBe('AAA');
    expect(normaliseRatingBand('CRISIL AA+').band).toBe('AA');
    expect(normaliseRatingBand('ICRA A-').band).toBe('A');
    expect(normaliseRatingBand('CARE BB+').band).toBe('BELOW_A');
    expect(normaliseRatingBand('SOVEREIGN').band).toBe('SOVEREIGN');
    expect(normaliseRatingBand('CRISIL A1+').band).toBe('AAA');
    expect(normaliseRatingBand('Unrated').band).toBe('UNRATED');
  });

  it('PC7-P-13: an unrecognised rating is OTHER_UNCLASSIFIED with a warning, never guessed', () => {
    const r = normaliseRatingBand('Some Novel Agency Grade Zeta');
    expect(r.band).toBe('OTHER_UNCLASSIFIED');
    expect(r.recognised).toBe(false);
  });

  it('PC7-P-14: ratings are read only on debt/money-market rows, not from equity Industry cells', () => {
    const res = parseFixture();
    const reliance = res.records.find((r) => r.instrumentName === 'Reliance Industries Ltd')!;
    expect(reliance.industryOrRatingRaw).toBe('Petroleum Products');
    expect(reliance.creditRatingBand).toBeNull(); // an industry is not a credit band
    const gsec = res.records.find((r) => r.instrumentName === '7.26% GOI 2033')!;
    expect(gsec.creditRatingBand).toBe('SOVEREIGN');
  });

  it('PC7-P-15: the publisher\'s Grand Total is used as an ORACLE and agrees with the parse', () => {
    const res = parseFixture();
    expect(res.warnings.some((w) => w.reason === 'CONTROL_TOTAL_MISMATCH')).toBe(false);
  });

  it('PC7-P-16: a Grand Total that disagrees with the parse raises a mismatch, and the PARSE wins', () => {
    const tampered = GRID.map((r) => (r[0] === 'Grand Total' ? ['Grand Total', '', '', '', '22,000.00', '98.00', ''] : r));
    const res = parsePortfolioDisclosure(tampered, { schemeLabel: 's', holdingsAsOfDate: '2026-08-31', today: '2026-09-15' });
    expect(res.warnings.some((w) => w.reason === 'CONTROL_TOTAL_MISMATCH')).toBe(true);
    // The publisher's number does NOT overwrite the parsed truth.
    expect(res.disclosedWeightTotalPct).toBeCloseTo(44, 6);
  });

  it('PC7-P-17: a blank / nil cell is null, never zero', () => {
    expect(parseNumericCell('')).toEqual({ ok: true, value: null, text: '' });
    expect(parseNumericCell('-')).toEqual({ ok: true, value: null, text: '-' });
    expect(parseNumericCell('NA').ok && parseNumericCell('NA')).toMatchObject({ value: null });
    expect(parseNumericCell('abc')).toEqual({ ok: false });
  });

  it('PC7-P-18: control-label classification distinguishes the four total kinds', () => {
    expect(classifyControlLabel('Sub Total')).toBe('sub_total');
    expect(classifyControlLabel('Grand Total')).toBe('grand_total');
    expect(classifyControlLabel('Net Assets')).toBe('net_assets');
    expect(classifyControlLabel('Total')).toBe('total');
    expect(classifyControlLabel('Reliance Industries Ltd')).toBeNull();
  });

  it('PC7-P-19: derivative headers are not mistaken for equity', () => {
    expect(classifySection('Equity Derivatives - Index Futures')!.section).toBe('DERIVATIVE');
    expect(classifySection('EQUITY & EQUITY RELATED')!.section).toBe('EQUITY');
  });

  it('PC7-P-20: the same file re-parsed produces identical record checksums (idempotency basis)', () => {
    const a = parseFixture();
    const b = parseFixture();
    expect(a.records.map(recordChecksum)).toEqual(b.records.map(recordChecksum));
  });

  it('PC7-P-21: a changed weight changes that record\'s checksum', () => {
    const a = parseFixture();
    const bumped: DisclosureHoldingRecord = { ...a.records[0], weightPctRaw: '9.01', weightPct: 9.01 };
    expect(recordChecksum(bumped)).not.toBe(recordChecksum(a.records[0]));
  });

  it('PC7-P-22: the source fingerprint is a real sha256 over the real bytes', () => {
    const fp = fingerprintDisclosureBytes(new TextEncoder().encode('hello'), '2026-09-15T00:00:00.000Z');
    expect(fp.sha256).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(fp.byteLength).toBe(5);
  });

  it('PC7-P-23: parser version is stamped on every result', () => {
    expect(parseFixture().parserVersion).toBe(PC7_DISCLOSURE_PARSER_VERSION);
  });

  it('PC7-P-25: exactly 11 holdings are accepted from the fixture — no silent drops', () => {
    // 5 equity + 3 debt + 1 money-market + TREPS + Net Receivables = 11.
    // Stated as an exact count on purpose: "the parser returned some records"
    // would pass even if it silently dropped a whole section.
    const res = parseFixture();
    expect(res.counts.accepted).toBe(11);
    expect(res.counts.rejected).toBe(0);
    expect(res.counts.controlRows).toBe(4); // 3 Sub Totals + 1 Grand Total
    expect(res.records).toHaveLength(11);
  });
});

// ===========================================================================
describe('PC7-R — O.3/O.5 import runner (reusing PC6 infrastructure)', () => {
  const schemeIndex: SchemeIdentityIndex = {
    byAmfiCode: new Map([['119551', 'fund-1']]),
    byIsin: new Map([['INF204K01K15', 'fund-1'], ['INF999X01AB1', 'fund-2']]),
    schemeMasterAvailable: true,
  };

  it('PC7-R-01: PC6 controls are genuinely reused, not reimplemented', () => {
    // If these were reimplemented copies their behaviour would drift; asserting
    // the PC6 values proves the import is live.
    expect(backoffMinutes(1)).toBe(15);
    expect(backoffMinutes(5)).toBe(240);
    expect(backoffMinutes(99)).toBe(360); // ceiling
    expect(decideStart(null, PC7_JOB_KEY, '2026-09-15T00:00:00Z').start).toBe(false);
  });

  it('PC7-R-02: a missing job-control row FAILS CLOSED', () => {
    const d = decideStart(null, PC7_JOB_KEY, '2026-09-15T00:00:00Z');
    expect(d.start).toBe(false);
    expect(d).toMatchObject({ status: 'skipped_kill_switch' });
  });

  it('PC7-R-03: an engaged kill switch stops the job', () => {
    const d = decideStart(
      { jobKey: PC7_JOB_KEY, enabled: false, disabledReason: 'licence pending', consecutiveFailures: 0, nextAttemptNotBefore: null, lastSuccessAt: null },
      PC7_JOB_KEY,
      '2026-09-15T00:00:00Z'
    );
    expect(d.start).toBe(false);
  });

  it('PC7-R-04: a truncated download is an OUTAGE, not an empty portfolio', () => {
    const small = classifyFetch(200, new Uint8Array(500), MIN_PLAUSIBLE_DISCLOSURE_BYTES, '2026-09-15T00:00:00Z');
    expect(small.ok).toBe(false);
    expect(small).toMatchObject({ kind: 'implausibly_small' });
  });

  it('PC7-R-05: scheme identity resolves by AMFI code, then ISIN — never by name', () => {
    expect(resolveSchemeIdentity({ amfiSchemeCode: '119551', isin: null, schemeNameRaw: 'x' }, schemeIndex)).toMatchObject({ state: 'resolved', via: 'amfi_scheme_code' });
    expect(resolveSchemeIdentity({ amfiSchemeCode: null, isin: 'INF204K01K15', schemeNameRaw: 'x' }, schemeIndex)).toMatchObject({ state: 'resolved', via: 'isin' });
    expect(resolveSchemeIdentity({ amfiSchemeCode: null, isin: null, schemeNameRaw: 'Example Large Cap Fund' }, schemeIndex)).toMatchObject({
      state: 'unresolved',
      reason: 'NO_IDENTIFIER_SUPPLIED',
    });
  });

  it('PC7-R-06: a code/ISIN disagreement is surfaced, not broken by precedence', () => {
    const r = resolveSchemeIdentity({ amfiSchemeCode: '119551', isin: 'INF999X01AB1', schemeNameRaw: 'x' }, schemeIndex);
    expect(r).toMatchObject({ state: 'unresolved', reason: 'AMBIGUOUS_SCHEME_CONFLICT' });
  });

  it('PC7-R-07: an unresolved scheme writes NO snapshot at all', () => {
    const parsed = parseFixture();
    const plan = planSnapshot({
      parsed,
      schemeResolution: { state: 'unresolved', reason: 'NO_MATCHING_SCHEME', detail: 'x' },
      constituentIndex: { byIsin: new Map(), byCuratedAlias: new Map() },
      holdingsAsOfDate: '2026-08-31',
      sourceKey: 'amc_portfolio_disclosure',
      sourceDocumentVersion: 'sha',
      sourceDataVersion: 'v1',
      existing: null,
    });
    expect(plan.snapshot).toBeNull();
  });

  it('PC7-R-08: an EMPTY parse never becomes an empty snapshot', () => {
    const plan = planSnapshot({
      parsed: { ...parseFixture(), records: [] },
      schemeResolution: { state: 'resolved', instrumentId: 'fund-1', via: 'isin', schemeMasterConsulted: true },
      constituentIndex: { byIsin: new Map(), byCuratedAlias: new Map() },
      holdingsAsOfDate: '2026-08-31',
      sourceKey: 'amc_portfolio_disclosure',
      sourceDocumentVersion: 'sha',
      sourceDataVersion: 'v1',
      existing: null,
    });
    expect(plan.snapshot).toBeNull();
    expect(plan.detail).toMatch(/EMPTY snapshot is never written/);
  });

  it('PC7-R-09: cash / derivative / other lines are NEVER resolved into a security', () => {
    const parsed = parseFixture();
    const idx: ConstituentIndex = { byIsin: new Map([['INE002A01018', 'sec-reliance']]), byCuratedAlias: new Map() };
    const treps = parsed.records.find((r) => r.instrumentName === 'TREPS / Reverse Repo')!;
    expect(resolveConstituent(treps, idx).underlyingInstrumentId).toBeNull();
  });

  it('PC7-R-10: constituents resolve by ISIN, then curated alias — never by fuzzy name', () => {
    const parsed = parseFixture();
    const idx: ConstituentIndex = {
      byIsin: new Map([['INE002A01018', 'sec-reliance']]),
      byCuratedAlias: new Map([['SOME UNLISTED CO LTD', 'sec-unlisted']]),
    };
    expect(resolveConstituent(parsed.records.find((r) => r.isin === 'INE002A01018')!, idx)).toMatchObject({ resolutionMethod: 'ISIN' });
    expect(resolveConstituent(parsed.records.find((r) => r.instrumentName === 'Some Unlisted Co Ltd')!, idx)).toMatchObject({ resolutionMethod: 'CONTROLLED_ALIAS' });
    // A near-name is NOT matched.
    const bad = parsed.records.find((r) => r.instrumentName === 'Bad Checksum Co Ltd')!;
    expect(resolveConstituent(bad, idx)).toMatchObject({ resolutionMethod: 'UNRESOLVED', underlyingInstrumentId: null });
  });

  it('PC7-R-11: unresolved constituents are RETAINED as lines and reported as weight', () => {
    const parsed = parseFixture();
    const plan = planSnapshot({
      parsed,
      schemeResolution: { state: 'resolved', instrumentId: 'fund-1', via: 'isin', schemeMasterConsulted: true },
      constituentIndex: { byIsin: new Map([['INE002A01018', 'sec-reliance']]), byCuratedAlias: new Map() },
      holdingsAsOfDate: '2026-08-31',
      sourceKey: 'amc_portfolio_disclosure',
      sourceDocumentVersion: 'sha',
      sourceDataVersion: 'v1',
      existing: null,
    });
    expect(plan.snapshot!.lines).toHaveLength(11); // nothing dropped
    expect(plan.unresolvedLineCount).toBeGreaterThan(0);
    expect(plan.unresolvedWeightPct).toBeGreaterThan(0);
  });

  it('PC7-R-12: a partial disclosure is marked partial_disclosure, not silently "ok"', () => {
    const parsed = parseFixture(); // 44% disclosed
    const plan = planSnapshot({
      parsed,
      schemeResolution: { state: 'resolved', instrumentId: 'fund-1', via: 'isin', schemeMasterConsulted: true },
      constituentIndex: { byIsin: new Map(), byCuratedAlias: new Map() },
      holdingsAsOfDate: '2026-08-31',
      sourceKey: 'amc_portfolio_disclosure',
      sourceDocumentVersion: 'sha',
      sourceDataVersion: 'v1',
      existing: null,
    });
    expect(plan.snapshot!.qualityStatus).toBe('partial_disclosure');
    expect(plan.snapshot!.disclosedWeightTotalPct).toBeCloseTo(44, 6);
  });

  it('PC7-R-13: re-importing the identical file is a genuine no-op (content idempotency)', () => {
    const parsed = parseFixture();
    const common = {
      parsed,
      schemeResolution: { state: 'resolved' as const, instrumentId: 'fund-1', via: 'isin' as const, schemeMasterConsulted: true },
      constituentIndex: { byIsin: new Map(), byCuratedAlias: new Map() },
      holdingsAsOfDate: '2026-08-31',
      sourceKey: 'amc_portfolio_disclosure',
      sourceDocumentVersion: 'sha',
      sourceDataVersion: 'v1',
    };
    const first = planSnapshot({ ...common, existing: null });
    expect(first.action).toBe('insert');
    const checksum = snapshotContentChecksum(first.snapshot!.lines);
    const second = planSnapshot({ ...common, existing: { snapshotId: 'snap-1', contentChecksum: checksum } });
    expect(second.action).toBe('skip_identical');
  });

  it('PC7-R-14: a REISSUE with different content inserts a new version, never overwrites', () => {
    const parsed = parseFixture();
    const plan = planSnapshot({
      parsed,
      schemeResolution: { state: 'resolved', instrumentId: 'fund-1', via: 'isin', schemeMasterConsulted: true },
      constituentIndex: { byIsin: new Map(), byCuratedAlias: new Map() },
      holdingsAsOfDate: '2026-08-31',
      sourceKey: 'amc_portfolio_disclosure',
      sourceDocumentVersion: 'sha',
      sourceDataVersion: 'v1',
      existing: { snapshotId: 'snap-1', contentChecksum: 'a'.repeat(64) },
    });
    expect(plan.action).toBe('insert_new_version');
    expect(plan.detail).toMatch(/preserved, never overwritten/);
  });

  it('PC7-R-15: the content checksum is order-independent', () => {
    const parsed = parseFixture();
    const plan = planSnapshot({
      parsed,
      schemeResolution: { state: 'resolved', instrumentId: 'fund-1', via: 'isin', schemeMasterConsulted: true },
      constituentIndex: { byIsin: new Map(), byCuratedAlias: new Map() },
      holdingsAsOfDate: '2026-08-31',
      sourceKey: 'amc_portfolio_disclosure',
      sourceDocumentVersion: 'sha',
      sourceDataVersion: 'v1',
      existing: null,
    });
    const lines = plan.snapshot!.lines;
    expect(snapshotContentChecksum([...lines].reverse())).toBe(snapshotContentChecksum(lines));
  });

  it('PC7-R-16: PC7 settles ALL-OR-NOTHING — a partial snapshot rolls back', () => {
    expect(PC7_BATCH_ATOMICITY).toBe('all_or_nothing');
    const settlement = settleSnapshotBatch([
      { chunkIndex: 0, attempted: 50, succeeded: 50, error: null },
      { chunkIndex: 1, attempted: 50, succeeded: 0, error: 'connection reset' },
    ]);
    expect(settlement.status).toBe('rolled_back');
    expect(settlement.rowsWritten).toBe(0);
    expect(settlement.partial).toBe(false);
  });

  it('PC7-R-17: a partial batch is never reported as a success', () => {
    const settlement = settleSnapshotBatch([{ chunkIndex: 0, attempted: 10, succeeded: 3, error: 'boom' }]);
    expect(settlement.status).not.toBe('succeeded');
  });

  it('PC7-R-18: alerting escalates on repeated failure and on a rejection spike', () => {
    const alerts = buildAlerts({
      jobKey: PC7_JOB_KEY,
      settlement: null,
      fetchOutcome: { ok: false, kind: 'http_error', httpStatus: 503, detail: 'x' },
      consecutiveFailures: 2,
      parsedAccepted: 80,
      parsedRejected: 20,
      unresolvedCount: 0,
    });
    expect(alerts.some((a) => a.severity === 'critical' && a.code.startsWith('SOURCE_OUTAGE'))).toBe(true);
    expect(alerts.some((a) => a.code === 'HIGH_REJECTION_RATE')).toBe(true);
  });

  it('PC7-R-19: the PC7 batch kind and job key are the ones migration 0157 declares', () => {
    expect(PC7_BATCH_KIND).toBe('fund_holdings_disclosure');
    expect(PC7_JOB_KEY).toBe('pc7_fund_holdings_disclosure');
  });
});

// ===========================================================================
describe('PC7-S — O.3 source governance', () => {
  it('PC7-S-01: EVERY disclosure source ships disabled', () => {
    expect(anyDisclosureSourceEnabled()).toBe(false);
    expect(blockedDisclosureSources()).toHaveLength(Object.keys(PC7_DISCLOSURE_SOURCES).length);
  });

  it('PC7-S-02: a disabled source cannot be fetched, and the refusal explains why', () => {
    expect(() => buildDisclosureUrl('amc_monthly_portfolio_generic')).toThrow(/disabled/);
    expect(() => buildDisclosureUrl('vendor_constituents')).toThrow(/licence=licence_required/);
  });

  it('PC7-S-03: an unknown source id throws rather than resolving to something plausible', () => {
    expect(() => getDisclosureSource('amfi_holdings_feed')).toThrow(/unknown disclosure source/);
  });

  it('PC7-S-04: debt schemes carry the fortnightly cadence and a tighter staleness bound', () => {
    const monthly = getDisclosureSource('amc_monthly_portfolio_generic');
    const fortnightly = getDisclosureSource('amc_fortnightly_debt_portfolio');
    expect(fortnightly.cadence).toBe('fortnightly');
    expect(fortnightly.staleAfterDays).toBeLessThan(monthly.staleAfterDays);
  });

  it('PC7-S-05: AMFI is recorded as publishing NO constituent dataset', () => {
    expect(AMFI_PUBLISHES_NO_CONSTITUENT_DATASET).toBe(true);
  });

  it('PC7-S-06: the licensing blocker is recorded on the source, not hidden in a doc', () => {
    expect(getDisclosureSource('amc_monthly_portfolio_generic').notes).toMatch(/PO-PC7-1/);
    expect(getDisclosureSource('vendor_constituents').notes).toMatch(/PO-PC7-2/);
  });
});

// ===========================================================================
describe('PC7-Q — O.8/O.9 look-through data quality', () => {
  const snaps: SnapshotRef[] = [
    { snapshotId: 's1', fundInstrumentId: 'f1', holdingsAsOfDate: '2026-08-31', sourceKey: 'amc', disclosedWeightTotalPct: 99.8, qualityStatus: 'ok', lineCount: 60 },
    { snapshotId: 's2', fundInstrumentId: 'f2', holdingsAsOfDate: '2026-01-31', sourceKey: 'amc', disclosedWeightTotalPct: 99.1, qualityStatus: 'ok', lineCount: 45 },
    { snapshotId: 's3', fundInstrumentId: 'f3', holdingsAsOfDate: '2026-08-31', sourceKey: 'amc', disclosedWeightTotalPct: 61.0, qualityStatus: 'partial_disclosure', lineCount: 12 },
    { snapshotId: 's4', fundInstrumentId: 'f4', holdingsAsOfDate: '2026-08-31', sourceKey: null, disclosedWeightTotalPct: null, qualityStatus: 'ok', lineCount: 0 },
  ];

  it('PC7-Q-01: missing disclosures separate "held by a user" from the rest', () => {
    const r = findMissingDisclosures(
      [
        { instrumentId: 'f1', schemeName: 'A', heldByAnyUser: true },
        { instrumentId: 'f9', schemeName: 'B', heldByAnyUser: true },
        { instrumentId: 'f8', schemeName: 'C', heldByAnyUser: false },
      ],
      new Set(['f1'])
    );
    expect(r.withDisclosure).toBe(1);
    expect(r.missing).toHaveLength(2);
    expect(r.missingAndHeld).toBe(1);
  });

  it('PC7-Q-02: freshness uses the SAME thresholds as the certified X-Ray engine', () => {
    // The boundaries are the certified engine's own: CURRENT <=45, ACCEPTABLE
    // <=100, STALE <=210, beyond that VERY_STALE.
    expect(classifySnapshotFreshness('2026-08-31', '2026-09-15').freshness).toBe('CURRENT'); // 15 days
    expect(classifySnapshotFreshness('2026-06-30', '2026-09-15').freshness).toBe('ACCEPTABLE'); // 77 days
    expect(classifySnapshotFreshness('2026-03-31', '2026-09-15').freshness).toBe('STALE'); // 168 days
    expect(classifySnapshotFreshness('2026-01-31', '2026-09-15').freshness).toBe('VERY_STALE'); // 227 days
    expect(classifySnapshotFreshness(null, '2026-09-15').freshness).toBe('MISSING');
  });

  it('PC7-Q-03: a FUTURE snapshot is MISSING for an earlier date, never "very fresh"', () => {
    expect(classifySnapshotFreshness('2026-10-31', '2026-09-15').freshness).toBe('MISSING');
  });

  it('PC7-Q-04: staleness judges ONE snapshot per fund — its newest', () => {
    const withHistory: SnapshotRef[] = [
      ...snaps,
      { snapshotId: 's1-old', fundInstrumentId: 'f1', holdingsAsOfDate: '2020-01-31', sourceKey: 'amc', disclosedWeightTotalPct: 99, qualityStatus: 'ok', lineCount: 50 },
    ];
    const r = assessSnapshotStaleness(withHistory, '2026-09-15');
    expect(r.snapshotCount).toBe(4); // four funds, not five snapshots
    // The preserved 2020 snapshot must NOT make f1 look stale.
    expect(r.stalest.some((v) => v.fundInstrumentId === 'f1')).toBe(false);
  });

  it('PC7-Q-05: a snapshot HEADER with zero lines is a coverage gap, not a healthy fund', () => {
    const r = findCoverageGaps(snaps);
    const noLines = r.gaps.find((g) => g.snapshotId === 's4');
    expect(noLines).toBeDefined();
    expect(noLines!.reason).toBe('no_lines');
  });

  it('PC7-Q-06: a below-threshold disclosure is a coverage gap', () => {
    const r = findCoverageGaps(snaps);
    expect(r.gaps.find((g) => g.snapshotId === 's3')!.reason).toBe('below_threshold');
    expect(r.gaps.find((g) => g.snapshotId === 's1')).toBeUndefined();
    expect(COVERAGE_GAP_BELOW_PCT).toBe(90);
  });

  it('PC7-Q-07: unmapped securities group by identity and exclude non-security buckets', () => {
    const lines: HoldingLineRef[] = [
      { snapshotId: 's1', holdingName: 'Mystery Co Ltd', isin: null, assetKind: 'security', weightPct: 3, underlyingInstrumentId: null },
      { snapshotId: 's2', holdingName: 'Mystery Co Ltd', isin: null, assetKind: 'security', weightPct: 5, underlyingInstrumentId: null },
      { snapshotId: 's1', holdingName: 'Reliance', isin: 'INE002A01018', assetKind: 'security', weightPct: 9, underlyingInstrumentId: 'sec-1' },
      { snapshotId: 's1', holdingName: 'TREPS', isin: null, assetKind: 'cash', weightPct: 2, underlyingInstrumentId: null },
    ];
    const r = findUnmappedSecurities(lines);
    expect(r.totalSecurityLines).toBe(3); // cash excluded
    expect(r.unresolvedLines).toBe(2);
    expect(r.unmapped).toHaveLength(1); // grouped
    expect(r.unmapped[0].occurrences).toBe(2);
    expect(r.unmapped[0].maxWeightPct).toBe(5);
  });

  it('PC7-Q-08: a zero-row window has an UNKNOWN rejection rate, not 0%', () => {
    const r = summariseImportFailures([
      { id: 'b1', batchKind: 'fund_holdings_disclosure', status: 'running', startedAt: '2026-09-15T00:00:00Z', finishedAt: null, rowsRead: 0, rowsAccepted: 0, rowsRejected: 0, errorCode: null },
    ]);
    expect(r.rejectionRate).toBeNull();
  });

  it('PC7-Q-09: only PC7 batches are counted — PC6 NAV batches are excluded', () => {
    const r = summariseImportFailures([
      { id: 'b1', batchKind: 'daily_nav', status: 'failed', startedAt: '2026-09-14T00:00:00Z', finishedAt: null, rowsRead: 100, rowsAccepted: 90, rowsRejected: 10, errorCode: 'X' },
      { id: 'b2', batchKind: 'fund_holdings_disclosure', status: 'succeeded', startedAt: '2026-09-15T00:00:00Z', finishedAt: '2026-09-15T00:01:00Z', rowsRead: 60, rowsAccepted: 60, rowsRejected: 0, errorCode: null },
    ]);
    expect(r.batchCount).toBe(1);
    expect(r.failed).toBe(0);
    expect(r.lastSuccessAt).toBe('2026-09-15T00:01:00Z');
  });

  it('PC7-Q-10: a silent column rename is detected EVEN when both imports succeeded', () => {
    const changes = detectSourceChanges([
      { batchId: 'b1', observedAt: '2026-07-10T00:00:00Z', columnSignature: 'Name|ISIN|Industry|Qty|MV|%NAV', sectionsSeen: ['EQUITY'], rejectionRate: 0 },
      { batchId: 'b2', observedAt: '2026-08-10T00:00:00Z', columnSignature: 'Name|ISIN|Sector|Qty|MV|%NAV', sectionsSeen: ['EQUITY'], rejectionRate: 0 },
    ]);
    expect(changes.some((c) => c.kind === 'COLUMN_LAYOUT_CHANGED')).toBe(true);
  });

  it('PC7-Q-11: appearing and disappearing sections are both reported', () => {
    const changes = detectSourceChanges([
      { batchId: 'b1', observedAt: '2026-07-10T00:00:00Z', columnSignature: 'A', sectionsSeen: ['EQUITY', 'DEBT'], rejectionRate: 0 },
      { batchId: 'b2', observedAt: '2026-08-10T00:00:00Z', columnSignature: 'A', sectionsSeen: ['EQUITY', 'DERIVATIVES'], rejectionRate: 0 },
    ]);
    expect(changes.some((c) => c.kind === 'NEW_SECTION_APPEARED')).toBe(true);
    expect(changes.some((c) => c.kind === 'SECTION_DISAPPEARED')).toBe(true);
  });

  it('PC7-Q-12: a rejection-rate spike is reported', () => {
    const changes = detectSourceChanges([
      { batchId: 'b1', observedAt: '2026-07-10T00:00:00Z', columnSignature: 'A', sectionsSeen: [], rejectionRate: 0.01 },
      { batchId: 'b2', observedAt: '2026-08-10T00:00:00Z', columnSignature: 'A', sectionsSeen: [], rejectionRate: 0.3 },
    ]);
    expect(changes.some((c) => c.kind === 'REJECTION_RATE_SPIKE')).toBe(true);
  });

  it('PC7-Q-13: an unchanged source produces NO change reports', () => {
    const changes = detectSourceChanges([
      { batchId: 'b1', observedAt: '2026-07-10T00:00:00Z', columnSignature: 'A', sectionsSeen: ['EQUITY'], rejectionRate: 0.01 },
      { batchId: 'b2', observedAt: '2026-08-10T00:00:00Z', columnSignature: 'A', sectionsSeen: ['EQUITY'], rejectionRate: 0.01 },
    ]);
    expect(changes).toHaveLength(0);
  });
});

// ===========================================================================
describe('PC7-W — O.7 wealth safety (the defining boundary)', () => {
  it('PC7-W-01: the net-worth input set and the look-through set are DISJOINT', () => {
    const overlap = (NET_WORTH_INPUT_TABLES as readonly string[]).filter((t) => (LOOKTHROUGH_TABLES as readonly string[]).includes(t));
    expect(overlap).toHaveLength(0);
  });

  it('PC7-W-02: a net-worth path reading a look-through table is a VIOLATION', () => {
    const r = assertNoLookthroughInNetWorthInputs(['assets', 'investments', 'ii_fund_holdings_lines']);
    expect(r.ok).toBe(false);
    expect(r.violations[0].code).toBe('LOOKTHROUGH_IN_NETWORTH_INPUT');
  });

  it('PC7-W-03: the REAL net-worth table list passes', () => {
    // These are the tables lib/services/dashboardData.ts actually reads for the
    // net-worth computation, read on 2026-09-15.
    const r = assertNoLookthroughInNetWorthInputs(['assets', 'investments', 'retirement_accounts', 'liabilities', 'financial_snapshots', 'insurance_policies', 'income_sources', 'expense_items']);
    expect(r.ok).toBe(true);
    expect(r.examined.length).toBeGreaterThan(0);
  });

  it('PC7-W-04: an EMPTY check is a FAILURE, not a vacuous pass', () => {
    expect(assertNoLookthroughInNetWorthInputs([]).ok).toBe(false);
  });

  it('PC7-W-05: a PC7 writer touching a register table is a VIOLATION', () => {
    expect(assertPc7WritesNoRegisterTable(['ii_fund_holdings_snapshots', 'ii_fund_holdings_lines']).ok).toBe(true);
    expect(assertPc7WritesNoRegisterTable(['ii_fund_holdings_lines', 'investments']).ok).toBe(false);
  });

  it('PC7-W-06: decomposition summing to MORE than the whole is a VIOLATION', () => {
    const r = assertDecompositionIsClosed({
      exposureWeight: 0.9, cashWeight: 0.2, derivativeWeight: 0, otherWeight: 0,
      unresolvedWeight: 0, undisclosedRemainderWeight: 0, noSnapshotWeight: 0, totalPortfolioValue: 1000,
    });
    expect(r.ok).toBe(false);
    expect(r.violations[0].code).toBe('DECOMPOSITION_EXCEEDS_WHOLE');
  });

  it('PC7-W-07: a genuine disclosure SHORTFALL is not a safety violation', () => {
    const r = assertDecompositionIsClosed({
      exposureWeight: 0.44, cashWeight: 0.025, derivativeWeight: 0, otherWeight: 0,
      unresolvedWeight: 0, undisclosedRemainderWeight: 0, noSnapshotWeight: 0, totalPortfolioValue: 1000,
    });
    expect(r.ok).toBe(true);
    expect(r.examined[0]).toMatch(/never rescaled/);
  });

  it('PC7-W-08: net worth changing across an ingestion is a VIOLATION, compared exactly', () => {
    const before = { label: 'before', totalAssets: 100, totalInvestments: 500000, totalRetirement: 0, totalLiabilities: 0, netWorth: 500100 };
    expect(assertNetWorthUnchanged(before, { ...before, label: 'after' }).ok).toBe(true);
    // One paisa is a failure. There is no tolerance, deliberately.
    expect(assertNetWorthUnchanged(before, { ...before, label: 'after', netWorth: 500100.01 }).ok).toBe(false);
  });

  // THE HEADLINE CASE. Run the REAL certified engine over a REAL parsed
  // disclosure and prove the decomposition sums back to exactly the position
  // value it decomposes — no more.
  it('PC7-W-09: the real engine decomposes a real parsed disclosure to EXACTLY the whole', () => {
    const parsed = parseFixture();
    const snapshot: FundHoldingsSnapshot = {
      snapshotId: 'snap-1',
      fundInstrumentId: 'fund-1',
      holdingsAsOfDate: '2026-08-31',
      sourceKey: 'amc_portfolio_disclosure',
      sourceDataVersion: 'v1',
      classificationVersion: null,
      holdings: parsed.records.map((r, i) => ({
        canonicalId: r.assetKind === 'security' ? `sec-${i}` : null,
        displayName: r.instrumentName,
        // The engine's CHECK domain is 0..100; the net-payables line is
        // negative, which the engine's own contract does not admit, so it is
        // presented as its absolute 'other' bucket here. The parser retains
        // the sign; this test is about the engine's closure property.
        weightPct: Math.abs(r.weightPct),
        assetKind: r.assetKind,
        sectorCode: r.industryOrRatingRaw,
        marketCapClass: 'LARGE',
        creditRatingBand: r.creditRatingBand,
      })),
    };
    const positions: PortfolioFundPosition[] = [
      { fundInstrumentId: 'fund-1', fundName: 'Example Balanced Advantage Fund', value: 1_000_000, currencyCode: 'INR' },
    ];
    const result = calculatePortfolioLookThrough(positions, new Map([['fund-1', [snapshot]]]), '2026-09-15', '2026-09-15');

    expect(result.status).toBe('ok');
    const exposureWeight = result.exposures.reduce((n, e) => n + e.effectiveWeight, 0);
    const safety = assertDecompositionIsClosed({
      exposureWeight,
      cashWeight: result.cashWeight,
      derivativeWeight: result.derivativeWeight,
      otherWeight: result.otherWeight,
      unresolvedWeight: result.unresolvedWeight,
      undisclosedRemainderWeight: result.undisclosedRemainderWeight,
      noSnapshotWeight: result.noSnapshotWeight,
      totalPortfolioValue: result.totalPortfolioValue,
    });
    expect(safety.ok).toBe(true);

    // And in MONEY: the decomposed value never exceeds the position value.
    const decomposedValue = result.exposures.reduce((n, e) => n + e.effectiveValue, 0);
    expect(decomposedValue).toBeLessThanOrEqual(1_000_000 + 1e-6);
    // The portfolio value itself is untouched by look-through.
    expect(result.totalPortfolioValue).toBe(1_000_000);
  });

  it('PC7-W-10: a 44%-disclosed fund yields 44% coverage — the gap is never rescaled away', () => {
    const parsed = parseFixture();
    const snapshot: FundHoldingsSnapshot = {
      snapshotId: 'snap-1', fundInstrumentId: 'fund-1', holdingsAsOfDate: '2026-08-31',
      sourceKey: 'amc', sourceDataVersion: null, classificationVersion: null,
      holdings: parsed.records.map((r, i) => ({
        canonicalId: r.assetKind === 'security' ? `sec-${i}` : null,
        displayName: r.instrumentName, weightPct: Math.abs(r.weightPct), assetKind: r.assetKind,
      })),
    };
    const cov = calculateFundCoverage(snapshot);
    // 44% disclosed plus the 0.5% payables line taken as absolute = 45%.
    expect(cov.reportedHoldingsCoverage).toBeCloseTo(0.45, 6);
    expect(cov.undisclosedRemainder).toBeCloseTo(0.55, 6);
  });
});

// ===========================================================================
describe('PC7-F — O.8 freshness and source honesty', () => {
  it('PC7-F-01: every look-through result now exposes SOURCE alongside date and coverage', () => {
    const snapshot: FundHoldingsSnapshot = {
      snapshotId: 'snap-1', fundInstrumentId: 'fund-1', holdingsAsOfDate: '2026-08-31',
      sourceKey: 'amc_portfolio_disclosure', sourceDataVersion: null, classificationVersion: null,
      holdings: [{ canonicalId: 'sec-1', displayName: 'Reliance', weightPct: 100, assetKind: 'security' }],
    };
    const result = calculatePortfolioLookThrough(
      [{ fundInstrumentId: 'fund-1', fundName: 'F', value: 1000, currencyCode: 'INR' }],
      new Map([['fund-1', [snapshot]]]),
      '2026-09-15',
      '2026-09-15'
    );
    expect(result.sourcesUsed).toHaveLength(1);
    expect(result.sourcesUsed[0]).toMatchObject({
      fundInstrumentId: 'fund-1',
      sourceKey: 'amc_portfolio_disclosure',
      holdingsAsOfDate: '2026-08-31',
    });
    expect(result.sourcesUsed[0].disclosedCoverage).toBeCloseTo(1, 6);
  });

  it('PC7-F-02: an unavailable look-through reports UNAVAILABLE, never zero exposure', () => {
    const result = calculatePortfolioLookThrough(
      [{ fundInstrumentId: 'fund-1', fundName: 'F', value: 1000, currencyCode: 'INR' }],
      new Map(),
      '2026-09-15',
      '2026-09-15'
    );
    expect(result.status).toBe('unavailable');
    expect(result.qualityStatuses).toContain('MISSING_HOLDINGS');
    expect(result.sourcesUsed).toHaveLength(0);
    expect(result.detail).toMatch(/cannot be calculated/);
  });
});
