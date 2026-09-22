// PC6 (M6) — unit tests for the reference-market-data logic.
//
// These cover the decisions that are easy to get subtly wrong and expensive to
// notice later: strict decimal parsing, the option/plan normalisation that
// must NOT collapse distinct products, per-series staleness, correction vs
// no-op, benchmark mapping precedence and the honest `unmapped` state, the
// audited-override rule, the risk-free blocker states, and every N.15 control.
//
// The parser cases below are built from REAL lines observed in AMFI's live
// NAVAll.txt on 2026-09-15, including its genuinely malformed "10." values and
// its genuinely missing AMC sub-headers — not from invented examples.

import { describe, it, expect } from 'vitest';
import {
  parseNavAll,
  parseNavHistory,
  parseAmfiDate,
  parseStrictDecimal,
  normalisePlan,
  normaliseOption,
  parseSectionHeader,
} from '@/lib/services/investment-intelligence/pc6/amfiParser';
import {
  assessFreshness,
  classifyGaps,
  detectJumps,
  decideUpsert,
  presentDualNav,
  daysBetween,
} from '@/lib/services/investment-intelligence/pc6/referenceDataQuality';
import {
  resolveMapping,
  validateOverride,
  checkReturnType,
  collectMappingGaps,
  MAPPING_BASIS_PRECEDENCE,
  type BenchmarkDefinition,
  type SchemeBenchmarkMapping,
  type GovernedCategoryDefault,
} from '@/lib/services/investment-intelligence/pc6/benchmarkGovernance';
import {
  classifyRiskFree,
  resolveRiskFree,
  INDIA_RISK_FREE_CANDIDATES,
} from '@/lib/services/investment-intelligence/pc6/riskFreeSeries';
import {
  decideStart,
  backoffMinutes,
  classifyFetch,
  settleBatch,
  buildAlerts,
  resolveScheme,
  planImport,
  MIN_PLAUSIBLE_FULL_UNIVERSE_BYTES,
} from '@/lib/services/investment-intelligence/pc6/referenceImportRunner';
import { buildUrl, toAmfiDate, blockedSources, PC6_REFERENCE_SOURCES } from '@/lib/config/investment-intelligence/pc6ReferenceSources';

const enc = (s: string) => new TextEncoder().encode(s);

const NAVALL_HEADER = 'Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date';

function navAll(lines: string[]): Uint8Array {
  return enc([NAVALL_HEADER, '', ...lines].join('\n'));
}

describe('PC6 amfiParser — strict decimal parsing', () => {
  it('accepts a well-formed decimal and preserves the exact source text', () => {
    const r = parseStrictDecimal('29.9628', 10);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe('29.9628');
  });

  it('REJECTS the real malformed "10." that AMFI publishes, which Number() would silently accept as 10', () => {
    expect(Number('10.')).toBe(10); // the trap
    const r = parseStrictDecimal('10.', 10);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('MALFORMED_NAV');
  });

  it('rejects a negative value outright', () => {
    expect(parseStrictDecimal('-1.5', 10).ok).toBe(false);
  });

  it('rejects precision beyond what the column can store, rather than rounding silently', () => {
    const r = parseStrictDecimal('14.86269632', 6);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('NAV_PRECISION_EXCEEDED');
    // At the 0155 scale of 10, the same real AMFI value is accepted intact.
    const wide = parseStrictDecimal('14.86269632', 10);
    expect(wide.ok).toBe(true);
    if (wide.ok) expect(wide.text).toBe('14.86269632');
  });

  it('accepts a genuinely published zero NAV as a real fact', () => {
    const r = parseStrictDecimal('0.0000', 10);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(0);
  });
});

describe('PC6 amfiParser — dates', () => {
  it('parses AMFI dd-MMM-yyyy by table, not by Date.parse', () => {
    expect(parseAmfiDate('11-Sep-2026')).toBe('2026-09-11');
    expect(parseAmfiDate('02-Oct-2008')).toBe('2008-10-02');
  });
  it('rejects an impossible calendar date', () => {
    expect(parseAmfiDate('31-Feb-2026')).toBeNull();
  });
  it('rejects a shape it does not recognise', () => {
    expect(parseAmfiDate('2026-09-11')).toBeNull();
    expect(parseAmfiDate('11-Sept-2026')).toBeNull();
  });
  it('round-trips through toAmfiDate', () => {
    expect(toAmfiDate('2026-09-11')).toBe('11-Sep-2026');
    expect(parseAmfiDate(toAmfiDate('2026-01-31'))).toBe('2026-01-31');
  });
});

describe('PC6 amfiParser — plan and option normalisation (N.3)', () => {
  it('maps the three real plan values, and leaves a blank plan UNKNOWN rather than not_applicable', () => {
    expect(normalisePlan('Direct Plan').planType).toBe('direct');
    expect(normalisePlan('Regular Plan').planType).toBe('regular');
    // AMFI leaves this blank on older rows. Null means "AMFI did not say";
    // 'not_applicable' would assert something AMFI never said.
    expect(normalisePlan('').planType).toBeNull();
  });

  it('never lets a reinvestment option fall into the payout bucket', () => {
    expect(normaliseOption('Monthly IDCW Re-investment').optionType).toBe('dividend_reinvestment');
    expect(normaliseOption('IDCW-Re-investment').optionType).toBe('dividend_reinvestment');
    expect(normaliseOption('QUARTERLY IDCW Payout').optionType).toBe('dividend_payout');
    expect(normaliseOption('Growth Option').optionType).toBe('growth');
    expect(normaliseOption('Periodic IDCW').optionType).toBe('idcw');
  });

  it('leaves an unrecognised option UNMAPPED with a warning rather than guessing', () => {
    const r = normaliseOption('Some AMC-specific wording nobody anticipated');
    expect(r.optionType).toBeNull();
    expect(r.warning?.reason).toBe('UNMAPPED_OPTION');
  });
});

describe('PC6 amfiParser — section headers', () => {
  it('splits structure, group and subcategory', () => {
    const h = parseSectionHeader('Open Ended Schemes(Equity Scheme - Large Cap Fund)');
    expect(h).toEqual({ raw: 'Open Ended Schemes(Equity Scheme - Large Cap Fund)', structure: 'open_ended', categoryGroup: 'Equity Scheme', subCategory: 'Large Cap Fund' });
  });

  it('keeps nested parentheses intact by splitting on the LAST separator', () => {
    const h = parseSectionHeader('Open Ended Schemes(Exchange Traded Funds (ETFs) - Gold ETF)');
    expect(h?.categoryGroup).toBe('Exchange Traded Funds (ETFs)');
    expect(h?.subCategory).toBe('Gold ETF');
  });

  it('handles a header with no dash at all', () => {
    const h = parseSectionHeader('Open Ended Schemes(Growth)');
    expect(h?.categoryGroup).toBeNull();
    expect(h?.subCategory).toBe('Growth');
  });

  it('recognises close-ended and interval structures', () => {
    expect(parseSectionHeader('Close Ended Schemes(ELSS)')?.structure).toBe('close_ended');
    expect(parseSectionHeader('Interval Fund Schemes(Income)')?.structure).toBe('interval');
  });

  it('does not mistake an AMC name for a section header', () => {
    expect(parseSectionHeader('Axis Mutual Fund')).toBeNull();
  });
});

describe('PC6 amfiParser — whole-file behaviour', () => {
  const GOOD = '135762;INF846K01WO1;-;Axis Children\'s Fund;Direct Plan;Growth Option;29.9628;11-Sep-2026';

  it('parses a well-formed file and fingerprints the bytes', () => {
    const r = parseNavAll(navAll(['Open Ended Schemes(Equity Scheme - Large Cap Fund)', '', 'Axis Mutual Fund', '', GOOD]), { asOfDate: '2026-09-15' });
    expect(r.counts.accepted).toBe(1);
    expect(r.counts.rejected).toBe(0);
    expect(r.fingerprint.sha256).toHaveLength(64);
    expect(r.records[0].amcName).toBe('Axis Mutual Fund');
    expect(r.records[0].navRaw).toBe('29.9628');
    expect(r.records[0].isinGrowthOrPayout).toBe('INF846K01WO1');
    expect(r.records[0].isinReinvestment).toBeNull(); // '-' means absent
  });

  it('keeps a row whose AMC sub-header AMFI omitted, flagged rather than rejected', () => {
    // This is a real condition: on 2026-09-15 the live file had 23 such rows,
    // all Franklin India segregated-portfolio schemes. The AMFI scheme code is
    // the identity key, so a missing AMC label degrades the record without
    // voiding the price.
    const r = parseNavAll(navAll(['Open Ended Schemes(Debt Scheme - Medium Duration Fund)', GOOD]), { asOfDate: '2026-09-15' });
    expect(r.counts.accepted).toBe(1);
    expect(r.records[0].amcName).toBeNull();
    expect(r.records[0].fieldWarnings.map((w) => w.reason)).toContain('AMC_HEADER_MISSING');
  });

  it('rejects a row that precedes any section header', () => {
    const r = parseNavAll(navAll([GOOD]), { asOfDate: '2026-09-15' });
    expect(r.counts.accepted).toBe(0);
    expect(r.rejections[0].reason).toBe('ORPHAN_ROW_NO_SECTION');
  });

  it('rejects a future-dated NAV against the supplied as-of date', () => {
    const r = parseNavAll(navAll(['Open Ended Schemes(Growth)', 'Axis Mutual Fund', GOOD]), { asOfDate: '2026-01-01' });
    expect(r.rejections.map((x) => x.reason)).toContain('FUTURE_DATE');
  });

  it('refuses to run without an explicit as-of date shape', () => {
    expect(() => parseNavAll(navAll([]), { asOfDate: 'today' })).toThrow(/ISO yyyy-mm-dd/);
  });

  it('collapses a byte-identical duplicate but REJECTS a conflicting one', () => {
    const conflicting = '135762;INF846K01WO1;-;Axis Children\'s Fund;Direct Plan;Growth Option;31.0000;11-Sep-2026';
    const r = parseNavAll(navAll(['Open Ended Schemes(Growth)', 'Axis Mutual Fund', GOOD, GOOD, conflicting]), { asOfDate: '2026-09-15' });
    expect(r.counts.accepted).toBe(1);
    expect(r.counts.duplicatesIdentical).toBe(1);
    expect(r.rejections.map((x) => x.reason)).toContain('DUPLICATE_CONFLICTING');
    // The FIRST occurrence wins — a later conflicting row never overwrites it.
    expect(r.records[0].navRaw).toBe('29.9628');
  });

  it('drops an invalid ISIN but keeps the price fact', () => {
    const badIsin = '135762;INF846K01WO9;-;Axis Children\'s Fund;Direct Plan;Growth Option;29.9628;11-Sep-2026';
    const r = parseNavAll(navAll(['Open Ended Schemes(Growth)', 'Axis Mutual Fund', badIsin]), { asOfDate: '2026-09-15' });
    expect(r.counts.accepted).toBe(1);
    expect(r.records[0].isinGrowthOrPayout).toBeNull();
    expect(r.records[0].fieldWarnings.map((w) => w.reason)).toContain('INVALID_ISIN_DROPPED');
  });

  it('is deterministic — identical bytes produce identical record checksums', () => {
    const bytes = navAll(['Open Ended Schemes(Growth)', 'Axis Mutual Fund', GOOD]);
    expect(parseNavAll(bytes, { asOfDate: '2026-09-15' }).records[0].recordChecksum)
      .toBe(parseNavAll(bytes, { asOfDate: '2026-09-15' }).records[0].recordChecksum);
  });

  it('uses the history report\'s DIFFERENT column order, not a reused layout', () => {
    const histHeader = 'Scheme Code;NAV Name;Plan;Option;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Net Asset Value;Date';
    // Real values for AMFI code 120503 as published on 2026-09-11. The ISIN is
    // the genuine INF846K01EW2, not a plausible-looking invention: the first
    // draft of this test used INF204K01UN8 (copied from a DEV fixture row) and
    // the parser correctly dropped it, because that string fails its ISO 6166
    // check digit. DEV's instrument master contains several such fabricated
    // ISINs — noted in the certification as a pre-existing fixture-data
    // observation, not a PC6 defect.
    const line = '120503;Axis ELSS- Tax Saver Fund;Direct Plan;Growth Option;INF846K01EW2;-;110.2610;11-Sep-2026';
    const r = parseNavHistory(enc([histHeader, '', 'Open Ended Schemes ( Growth )', '', 'Axis Mutual Fund', line].join('\n')), { asOfDate: '2026-09-15' });
    expect(r.counts.accepted).toBe(1);
    expect(r.records[0].schemeName).toBe('Axis ELSS- Tax Saver Fund');
    expect(r.records[0].isinGrowthOrPayout).toBe('INF846K01EW2');
    expect(r.records[0].navRaw).toBe('110.2610');
    expect(r.records[0].optionType).toBe('growth');
  });
});

describe('PC6 referenceDataQuality — freshness (N.5, N.11)', () => {
  it('distinguishes fresh, stale and never-ingested', () => {
    expect(assessFreshness('2026-09-14', '2026-09-15', 4).state).toBe('fresh');
    expect(assessFreshness('2008-10-02', '2026-09-15', 4).state).toBe('stale');
    expect(assessFreshness(null, '2026-09-15', 4).state).toBe('never_ingested');
  });

  it('never reports a never-ingested series as a zero-day-old one', () => {
    expect(assessFreshness(null, '2026-09-15', 4).ageDays).toBeNull();
  });

  it('treats exactly-at-threshold as fresh and one day beyond as stale', () => {
    expect(assessFreshness('2026-09-11', '2026-09-15', 4).state).toBe('fresh');
    expect(assessFreshness('2026-09-10', '2026-09-15', 4).state).toBe('stale');
  });

  it('computes calendar distance without timezone drift', () => {
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1); // 2026 is not a leap year
  });
});

describe('PC6 referenceDataQuality — gaps and outliers', () => {
  it('recognises a weekend hole without needing a holiday calendar', () => {
    expect(classifyGaps(['2026-09-04', '2026-09-07'])[0].classification).toBe('weekend_only');
  });

  it('surfaces a multi-weekday hole for a human to judge, rather than filling it', () => {
    const g = classifyGaps(['2026-09-07', '2026-09-15'])[0];
    expect(g.classification).toBe('long_gap');
    expect(g.missingWeekdays).toBeGreaterThan(1);
  });

  it('reports nothing for a contiguous series', () => {
    expect(classifyGaps(['2026-09-14', '2026-09-15'])).toHaveLength(0);
  });

  it('flags a large move, and scales the threshold by elapsed days', () => {
    // +60% in one day is flagged...
    expect(detectJumps([{ date: '2026-09-01', value: 100 }, { date: '2026-09-02', value: 160 }])).toHaveLength(1);
    // ...but a modest move across a long gap is not treated as a one-day jump.
    expect(detectJumps([{ date: '2026-01-01', value: 100 }, { date: '2026-09-01', value: 112 }])).toHaveLength(0);
  });

  it('gives zero crossings their own reasons instead of dividing by zero', () => {
    const j = detectJumps([{ date: '2026-09-01', value: 0 }, { date: '2026-09-02', value: 10 }, { date: '2026-09-03', value: 0 }]);
    expect(j.map((x) => x.reason)).toEqual(['ZERO_TO_NONZERO', 'NONZERO_TO_ZERO']);
  });
});

describe('PC6 referenceDataQuality — idempotency and corrections', () => {
  it('inserts when nothing exists', () => {
    expect(decideUpsert(null, { value: '10.0', recordChecksum: 'a' }).action).toBe('insert');
  });

  it('is a genuine NO-OP when the content is identical', () => {
    expect(decideUpsert({ value: '10.0', recordChecksum: 'a', quality_status: 'ok' }, { value: '10.0', recordChecksum: 'a' }).action).toBe('skip');
  });

  it('treats a changed value as a SOURCE CORRECTION carrying the prior value, never an overwrite', () => {
    const d = decideUpsert({ value: '10.0', recordChecksum: 'a', quality_status: 'ok' }, { value: '10.5', recordChecksum: 'b' });
    expect(d.action).toBe('supersede');
    if (d.action === 'supersede') {
      expect(d.reason).toBe('SOURCE_CORRECTION');
      expect(d.previousValue).toBe('10.0');
    }
  });
});

describe('PC6 D.7 — a statement fact is never rewritten (N.6)', () => {
  it('presents both facts with their own as-of dates and flags a disagreement', () => {
    const d = presentDualNav({ navOnStatement: '412.5500', statementDate: '2026-03-31' }, { navFromPc6: '418.9100', marketAsOfDate: '2026-09-14', sourceKey: 'amfi' });
    expect(d.statement.navOnStatement).toBe('412.5500');
    expect(d.differs).toBe(true);
    expect(d.asOfLabel).toContain('2026-03-31');
    expect(d.asOfLabel).toContain('2026-09-14');
  });

  it('says plainly when no market NAV exists, instead of leaving a blank', () => {
    const d = presentDualNav({ navOnStatement: '412.5500', statementDate: '2026-03-31' }, null);
    expect(d.differs).toBe(false);
    expect(d.asOfLabel).toMatch(/No external market NAV/);
  });

  it('returns no merged value a caller could mistake for "the" NAV', () => {
    const d = presentDualNav({ navOnStatement: '1', statementDate: '2026-01-01' }, { navFromPc6: '2', marketAsOfDate: '2026-02-01', sourceKey: 'amfi' });
    expect(Object.keys(d).sort()).toEqual(['asOfLabel', 'differs', 'market', 'statement']);
  });
});

describe('PC6 benchmarkGovernance — mapping resolution (N.8)', () => {
  const bm: BenchmarkDefinition = {
    benchmarkId: 'b1', benchmarkKey: 'TEST_BM', benchmarkLabel: 'Test', returnType: 'TRI',
    currencyCode: 'INR', countryCode: 'IN', frequency: 'business_daily', sourceKey: null,
    effectiveFrom: '2000-01-01', effectiveTo: null, lifecycle: 'active',
  };
  const mk = (basis: SchemeBenchmarkMapping['basis'], extra: Partial<SchemeBenchmarkMapping> = {}): SchemeBenchmarkMapping => ({
    instrumentId: 'i1', benchmarkId: 'b1', relationshipType: 'primary', basis,
    effectiveFrom: '2020-01-01', effectiveTo: null, mappingSourceKey: basis === 'admin_override' ? null : 'amfi',
    mappingVersion: 'v1', ...extra,
  });

  it('puts an admin override ahead of a disclosed benchmark, and both ahead of a category default', () => {
    expect(MAPPING_BASIS_PRECEDENCE).toEqual(['admin_override', 'scheme_disclosed', 'governed_category_default']);
    const r = resolveMapping('i1', '2026-09-15', [mk('governed_category_default'), mk('scheme_disclosed'), mk('admin_override')], { b1: bm }, [], null, 'IN');
    expect(r.state).toBe('mapped');
    if (r.state === 'mapped') expect(r.basis).toBe('admin_override');
  });

  it('reports UNMAPPED — never a guessed index — when nothing is on file', () => {
    const r = resolveMapping('i1', '2026-09-15', [], { b1: bm }, [], 'Open Ended Schemes(Equity Scheme - Large Cap Fund)', 'IN');
    expect(r.state).toBe('unmapped');
    if (r.state === 'unmapped') expect(r.reason).toBe('NO_GOVERNED_CATEGORY_DEFAULT');
  });

  it('distinguishes "mappings exist but none is effective today" from "none ever existed"', () => {
    const expired = mk('scheme_disclosed', { effectiveFrom: '2018-01-01', effectiveTo: '2019-12-31' });
    const r = resolveMapping('i1', '2026-09-15', [expired], { b1: bm }, [], null, 'IN');
    expect(r.state).toBe('unmapped');
    if (r.state === 'unmapped') expect(r.reason).toBe('ALL_MAPPINGS_EXPIRED');
  });

  it('refuses to substitute anything when the mapped benchmark is deprecated', () => {
    const r = resolveMapping('i1', '2026-09-15', [mk('scheme_disclosed')], { b1: { ...bm, lifecycle: 'deprecated' } }, [], null, 'IN');
    expect(r.state).toBe('unmapped');
    if (r.state === 'unmapped') expect(r.reason).toBe('BENCHMARK_DEPRECATED');
  });

  it('collects gaps for the admin surface with a reason on every row', () => {
    const gaps = collectMappingGaps(
      [{ instrumentId: 'i1', schemeName: 'Fund A', amfiSchemeCode: '120503', categoryHeaderRaw: null }],
      '2026-09-15', [], { b1: bm }, [], 'IN'
    );
    expect(gaps).toHaveLength(1);
    expect(gaps[0].detail.length).toBeGreaterThan(20);
  });

  it('uses a governed category default only when one genuinely exists for that category', () => {
    const def: GovernedCategoryDefault = {
      countryCode: 'IN', categoryHeaderRaw: 'Open Ended Schemes(Equity Scheme - Large Cap Fund)',
      benchmarkId: 'b1', effectiveFrom: '2020-01-01', effectiveTo: null,
      approvedByActorId: 'admin-1', approvedAt: '2026-01-01T00:00:00Z',
      rationale: 'Approved by the investment committee on 2026-01-01 for all large-cap schemes without a disclosed benchmark.',
    };
    const withDefault = resolveMapping('i1', '2026-09-15', [mk('governed_category_default')], { b1: bm }, [def], def.categoryHeaderRaw, 'IN');
    expect(withDefault.state).toBe('mapped');
  });
});

describe('PC6 benchmarkGovernance — audited override and TRI/PRI (N.7, N.8)', () => {
  const base: SchemeBenchmarkMapping = {
    instrumentId: 'i1', benchmarkId: 'b1', relationshipType: 'primary', basis: 'admin_override',
    effectiveFrom: '2020-01-01', effectiveTo: null, mappingSourceKey: null, mappingVersion: 'v1',
  };

  it('refuses an override with no actor, no time and no reason', () => {
    expect(validateOverride(base).ok).toBe(false);
  });

  it('refuses an override whose reason is a token word', () => {
    const r = validateOverride({ ...base, overrideActorId: 'a', overrideRecordedAt: 'now', overrideReason: 'because' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/at least 20 characters/);
  });

  it('accepts a properly attributed and reasoned override', () => {
    expect(validateOverride({
      ...base, overrideActorId: 'admin-1', overrideRecordedAt: '2026-09-15T00:00:00Z',
      overrideReason: 'The AMC changed the disclosed benchmark mid-year; mapped per the SID dated 2026-04-01.',
    }).ok).toBe(true);
  });

  it('refuses an override that claims an external source as its authority', () => {
    expect(validateOverride({
      ...base, mappingSourceKey: 'amfi', overrideActorId: 'admin-1', overrideRecordedAt: 'now',
      overrideReason: 'A twenty-plus character reason that is otherwise perfectly fine.',
    }).ok).toBe(false);
  });

  it('lets a PRI stand in for a TRI only as a QUALIFIED comparison', () => {
    const r = checkReturnType('TRI', 'PRI');
    expect(r.acceptable).toBe(true);
    expect(r.qualified).toBe(true);
    expect(r.detail).toMatch(/understates/);
  });

  it('refuses an incompatible return type outright', () => {
    expect(checkReturnType('TRI', 'COMMODITY_GOLD').acceptable).toBe(false);
  });
});

describe('PC6 riskFreeSeries — BLOCKER PO-PC6-2 is real, not papered over (N.10)', () => {
  it('offers three genuinely different candidates and marks none of them default', () => {
    expect(INDIA_RISK_FREE_CANDIDATES).toHaveLength(3);
    expect(INDIA_RISK_FREE_CANDIDATES.map((c) => c.key).sort()).toEqual(['rbi_gsec_10y', 'rbi_policy_repo', 'rbi_tbill_91d']);
    for (const c of INDIA_RISK_FREE_CANDIDATES) {
      expect(c.argumentFor.length).toBeGreaterThan(40);
      expect(c.argumentAgainst.length).toBeGreaterThan(40);
    }
  });

  it('reports pending_po_decision when nothing at all is on file', () => {
    expect(classifyRiskFree('IN', [], []).state).toBe('pending_po_decision');
  });

  it('separates "an uncertified seed is being read" from "the decision is merely open"', () => {
    const s = classifyRiskFree('IN', [], ['DEV SEED — approximate RBI 91-day T-Bill annual average (not a certified feed)']);
    expect(s.state).toBe('uncertified_seed');
  });

  it('marks a rate resolved from an uncertified seed as QUALIFIED rather than silently using it', () => {
    const periods = [{ countryCode: 'IN', periodStart: '2026-01-01', periodEnd: '2026-12-31', annualisedRate: 0.06, version: 'dev-seed-v1', source: 'DEV SEED — not a certified feed' }];
    const r = resolveRiskFree('IN', '2026-06-01', periods, classifyRiskFree('IN', [], periods.map((p) => p.source)));
    expect(r.state).toBe('ok');
    if (r.state === 'ok') {
      expect(r.qualified).toBe(true);
      expect(r.detail).toMatch(/PO-PC6-2/);
    }
  });

  it('returns unavailable — never a default rate — outside any covered period', () => {
    const periods = [{ countryCode: 'IN', periodStart: '2026-01-01', periodEnd: '2026-06-30', annualisedRate: 0.06, version: 'v1', source: 'x' }];
    const r = resolveRiskFree('IN', '2026-12-01', periods, { state: 'governed', methodology: { countryCode: 'IN', sourceKey: 'rbi_tbill_91d', tenor: '91d', method: 'period_average', gapRule: 'carry forward', version: 'v1', reference: 'r', approvedByActorId: 'a', approvedAt: 'now' } });
    expect(r.state).toBe('unavailable');
    if (r.state === 'unavailable') expect(r.reason).toBe('NO_PERIOD_COVERS_DATE');
  });
});

describe('PC6 referenceImportRunner — N.15 controls', () => {
  const now = '2026-09-15T10:00:00.000Z';

  it('FAILS CLOSED when no job-control row exists', () => {
    const d = decideStart(null, 'j', now);
    expect(d.start).toBe(false);
    if (!d.start) expect(d.status).toBe('skipped_kill_switch');
  });

  it('honours the kill switch and reports the operator reason', () => {
    const d = decideStart({ jobKey: 'j', enabled: false, disabledReason: 'feed suspended', consecutiveFailures: 0, nextAttemptNotBefore: null, lastSuccessAt: null }, 'j', now);
    expect(d.start).toBe(false);
    if (!d.start) expect(d.detail).toContain('feed suspended');
  });

  it('honours backoff, then allows the run once the window passes', () => {
    const control = { jobKey: 'j', enabled: true, disabledReason: null, consecutiveFailures: 2, nextAttemptNotBefore: '2026-09-15T11:00:00.000Z', lastSuccessAt: null };
    expect(decideStart(control, 'j', now).start).toBe(false);
    expect(decideStart(control, 'j', '2026-09-15T11:30:00.000Z').start).toBe(true);
  });

  it('backs off exponentially but BOUNDED, so a long outage still gets probed', () => {
    expect(backoffMinutes(0)).toBe(0);
    expect(backoffMinutes(1)).toBe(15);
    expect(backoffMinutes(2)).toBe(30);
    expect(backoffMinutes(4)).toBe(120);
    expect(backoffMinutes(50)).toBe(360); // capped, not astronomically far away
  });

  it('classifies every outage mode distinctly', () => {
    expect(classifyFetch(null, null, 100, now, 'ECONNREFUSED')).toMatchObject({ ok: false, kind: 'network' });
    expect(classifyFetch(503, null, 100, now)).toMatchObject({ ok: false, kind: 'http_error' });
    expect(classifyFetch(200, new Uint8Array(0), 100, now)).toMatchObject({ ok: false, kind: 'empty_body' });
    expect(classifyFetch(200, new Uint8Array(50), 100, now)).toMatchObject({ ok: false, kind: 'implausibly_small' });
    expect(classifyFetch(200, new Uint8Array(200), 100, now).ok).toBe(true);
  });

  it('treats a truncated full-universe file as an outage, not a small day', () => {
    const r = classifyFetch(200, new Uint8Array(1200), MIN_PLAUSIBLE_FULL_UNIVERSE_BYTES, now);
    expect(r.ok).toBe(false);
  });

  it('never reports a PARTIAL batch as a success', () => {
    const s = settleBatch([{ chunkIndex: 0, attempted: 5, succeeded: 5, error: null }, { chunkIndex: 1, attempted: 5, succeeded: 0, error: 'boom' }], 'commit_chunks');
    expect(s.status).toBe('failed');
    expect(s.partial).toBe(true);
    expect(s.rowsWritten).toBe(5);
  });

  it('rolls back to zero rows under all-or-nothing semantics', () => {
    const s = settleBatch([{ chunkIndex: 0, attempted: 5, succeeded: 5, error: null }, { chunkIndex: 1, attempted: 5, succeeded: 0, error: 'boom' }], 'all_or_nothing');
    expect(s.status).toBe('rolled_back');
    expect(s.rowsWritten).toBe(0);
  });

  it('reports a fully clean batch as succeeded', () => {
    expect(settleBatch([{ chunkIndex: 0, attempted: 5, succeeded: 5, error: null }], 'commit_chunks').status).toBe('succeeded');
  });

  it('escalates a partial batch and a rejection-rate spike, but stays quiet on a healthy run', () => {
    const noisy = buildAlerts({ jobKey: 'j', settlement: settleBatch([{ chunkIndex: 0, attempted: 5, succeeded: 5, error: null }, { chunkIndex: 1, attempted: 5, succeeded: 0, error: 'x' }], 'commit_chunks'), fetchOutcome: null, consecutiveFailures: 0, parsedAccepted: 50, parsedRejected: 50, unresolvedCount: 0 });
    expect(noisy.filter((a) => a.severity === 'critical').map((a) => a.code).sort()).toEqual(['HIGH_REJECTION_RATE', 'PARTIAL_BATCH']);

    const healthy = buildAlerts({ jobKey: 'j', settlement: settleBatch([{ chunkIndex: 0, attempted: 5, succeeded: 5, error: null }], 'commit_chunks'), fetchOutcome: null, consecutiveFailures: 0, parsedAccepted: 14344, parsedRejected: 17, unresolvedCount: 0 });
    expect(healthy.filter((a) => a.severity === 'critical')).toHaveLength(0);
  });
});

describe('PC6 referenceImportRunner — resolution and planning', () => {
  const rec = {
    amfiSchemeCode: '120503', schemeName: 'X', amcName: 'A', schemeStructure: 'open_ended' as const,
    categoryHeaderRaw: 'H', categoryGroup: null, subCategory: 'S', planRaw: '', planType: null,
    optionRaw: '', optionType: null, isinGrowthOrPayout: 'INF204K01UN8', isinReinvestment: null,
    navRaw: '10.5', nav: 10.5, navDate: '2026-09-11', sourceLine: 1, recordChecksum: 'c1', fieldWarnings: [],
  };

  it('resolves by AMFI code first, then by ISIN', () => {
    expect(resolveScheme(rec, { byAmfiCode: new Map([['120503', 'i-code']]), byIsin: new Map() })).toMatchObject({ state: 'resolved', via: 'amfi_scheme_code' });
    expect(resolveScheme(rec, { byAmfiCode: new Map(), byIsin: new Map([['INF204K01UN8', 'i-isin']]) })).toMatchObject({ state: 'resolved', via: 'isin' });
  });

  it('reports a code/ISIN disagreement rather than silently preferring one', () => {
    const r = resolveScheme(rec, { byAmfiCode: new Map([['120503', 'i-a']]), byIsin: new Map([['INF204K01UN8', 'i-b']]) });
    expect(r.state).toBe('unresolved');
    if (r.state === 'unresolved') expect(r.reason).toBe('AMBIGUOUS_ISIN_CONFLICT');
  });

  it('never name-matches — an unknown identifier stays unresolved', () => {
    expect(resolveScheme(rec, { byAmfiCode: new Map(), byIsin: new Map() }).state).toBe('unresolved');
  });

  it('plans zero inserts on a second pass over identical content', () => {
    const parsed = {
      records: [rec], rejections: [], fingerprint: { byteLength: 1, sha256: 'x', retrievedAt: 'now' },
      parserVersion: 'v', sectionHeaders: [], amcNames: [], navDateMin: null, navDateMax: null,
      counts: { totalLines: 1, dataLines: 1, accepted: 1, rejected: 0, duplicatesIdentical: 0 },
    };
    const index = { byAmfiCode: new Map([['120503', 'i1']]), byIsin: new Map() };
    const first = planImport({ parsed, index, existing: new Map(), currencyCode: 'INR' });
    expect(first.counts.toInsert).toBe(1);

    const second = planImport({
      parsed, index, currencyCode: 'INR',
      existing: new Map([['i1|2026-09-11', { value: '10.5', recordChecksum: 'c1', quality_status: 'ok' as const }]]),
    });
    expect(second.counts.toInsert).toBe(0);
    expect(second.counts.unchanged).toBe(1);
  });
});

describe('PC6 source configuration — blocked sources stay blocked (N.4, N.7, N.10)', () => {
  it('builds the AMFI daily URL from configuration', () => {
    expect(buildUrl('amfi_nav_daily')).toBe(PC6_REFERENCE_SOURCES.amfi_nav_daily.urlTemplate);
  });

  it('fills a backfill window in AMFI\'s own date spelling', () => {
    expect(buildUrl('amfi_nav_history', { fromDate: '2026-09-08', toDate: '2026-09-10' }))
      .toContain('frmdt=08-Sep-2026&todt=10-Sep-2026');
  });

  it('refuses a backfill with no window rather than silently fetching everything', () => {
    expect(() => buildUrl('amfi_nav_history')).toThrow(/needs a fromDate/);
  });

  it('REFUSES to build a URL for a licence-blocked index source', () => {
    expect(() => buildUrl('nse_index_tri')).toThrow(/licence_required/);
    expect(() => buildUrl('bse_index')).toThrow(/licence_required/);
  });

  it('REFUSES to build a URL for the risk-free source while the PO decision is open', () => {
    expect(() => buildUrl('india_risk_free')).toThrow(/po_decision_required/);
  });

  it('lists exactly the three LICENCE-blocked sources on the admin surface (N.4, N.7, N.10)', () => {
    // NAV 1 (2026-09-21) added two more disabled-but-public_open entries
    // (TIGZIG/mfnav, pending production-runtime qualification, not a
    // licence blocker) — blockedSources() now legitimately returns 5, but
    // the licence-blocked subset this test actually cares about is unchanged.
    const licenceBlocked = blockedSources().filter((s) => s.licence !== 'public_open');
    expect(licenceBlocked.map((s) => s.kind).sort()).toEqual(['benchmark_level', 'benchmark_level', 'risk_free_rate']);
  });

  it('registers the NAV 1 candidate historical sources as disabled pending production qualification, not licence-blocked', () => {
    const navCandidates = blockedSources().filter((s) => s.licence === 'public_open');
    expect(navCandidates.map((s) => s.kind).sort()).toEqual(['nav_history', 'nav_history']);
  });

  it('rejects an unknown source id loudly', () => {
    expect(() => buildUrl('made_up_source')).toThrow(/unknown reference source/);
  });
});
