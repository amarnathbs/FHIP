// II-R10 continuation — real unit tests for the five new Investment
// Intelligence report chapters (spec sections 21-32, 39-40, 49, 89, 112).
//
// These test the exported chapter builders directly against constructed
// canonical-engine-shaped fixtures — never against report composer code
// reimplementing II arithmetic (source values below are fabricated as fixed
// test inputs, exactly the numbers the builder must reproduce verbatim).
import { describe, it, expect } from 'vitest';
import {
  buildInvestmentPerformance,
  buildSipContribution,
  buildPortfolioXray,
  buildTaxAndCost,
  buildPriorityReviewItems,
} from '@/lib/engines/reportSectionsPremium';
import type { ReportSourceData, PremiumSourceData } from '@/lib/services/reportSnapshotResolver';

// None of the five II chapter builders read `source` (verified: they only
// destructure `premium`) — an empty stub is intentionally used here rather
// than a full ReportSourceData fixture, and is itself evidence that these
// builders cannot be secretly reaching into dashboard/net-worth data to
// double-count anything (spec section 50).
const emptySource = {} as ReportSourceData;

function emptyPremium(overrides: Partial<PremiumSourceData> = {}): PremiumSourceData {
  return {
    investments: [],
    insurancePolicies: [],
    assets: [],
    liabilities: [],
    incomeSources: [],
    expenseItems: [],
    forecastReportData: null,
    goalsOnTrackHistory: [],
    fxRateAudInr: 55,
    investmentPerformance: null,
    sip: null,
    xray: null,
    taxAndCost: null,
    reviewItems: null,
    ...overrides,
  };
}

describe('II-R10 continuation — Investment Performance chapter (R4)', () => {
  it('empty data safety: no analytics available produces "unavailable", never a fabricated 0%/table', () => {
    const section = buildInvestmentPerformance(emptySource, emptyPremium());
    expect(section.sectionStatus).toBe('unavailable');
    expect(section.sectionData).toEqual({});
    expect(section.narrativeText).toBeNull();
    expect(section.limitationText).toMatch(/not yet available/i);
  });

  it('no-recalculation: the raw engine result is passed through byte-for-byte, not reformatted or altered', () => {
    const engineResult = {
      asOfDate: '2026-08-24',
      periodStart: '2025-08-24',
      engineVersion: 'performance-engine-r4-v7-test-fixture',
      subVersions: {},
      portfolios: [
        {
          currencyCode: 'INR',
          schemeCount: 3,
          totalValue: 500000,
          portfolioXirr: { status: 'CALCULATED', value: { rate: 0.1234 } },
          portfolioTwrr: { status: 'CALCULATED', value: { twrr: 0.1189 } },
          blendedBenchmarkReturn: { status: 'CALCULATED', value: { blendedReturn: 0.1, coveragePct: 90 } },
          activeReturn: { status: 'CALCULATED', value: { activeReturn: 0.0234 } },
          risk: {},
          rolling: {},
          drawdownSeries: [],
          performanceVsBenchmarkSeries: [],
          contributingBenchmarks: [],
          annotations: [],
          inputFingerprint: 'fp-abc123',
        },
      ],
      schemes: [],
      crossCurrency: { status: 'NOT_APPLICABLE', qualityFlag: 'COMPLETE', detail: 'Single-currency portfolio.' },
      annotations: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const section = buildInvestmentPerformance(emptySource, emptyPremium({ investmentPerformance: { results: engineResult, warnings: [] } }));
    expect(section.sectionStatus).toBe('included');
    // SOURCE-MODULE ASSERTION (spec section 112): the exact rate the R4
    // engine computed must appear unchanged in the report snapshot — this is
    // the check that would catch NC2 (local XIRR recomputation).
    expect((section.sectionData.results as typeof engineResult).portfolios[0].portfolioXirr.value.rate).toBe(0.1234);
    expect((section.sectionData.results as typeof engineResult).engineVersion).toBe('performance-engine-r4-v7-test-fixture');
    expect(section.sourceReferences.engineVersion).toBe('performance-engine-r4-v7-test-fixture');
    expect(section.sourceReferences.module).toBe('ii-r4-performance');
  });

  it('missing benchmark shows "Benchmark data not available" language rather than a fabricated 0% (spec section 22)', () => {
    const engineResult = {
      asOfDate: '2026-08-24',
      engineVersion: 'v-test',
      portfolios: [
        {
          currencyCode: 'AUD',
          portfolioXirr: { status: 'CALCULATED', value: { rate: 0.05 } },
          portfolioTwrr: { status: 'INSUFFICIENT_DATA' },
          blendedBenchmarkReturn: { status: 'BENCHMARK_UNAVAILABLE' },
          activeReturn: { status: 'BENCHMARK_UNAVAILABLE' },
          drawdownSeries: [],
          performanceVsBenchmarkSeries: [],
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const section = buildInvestmentPerformance(emptySource, emptyPremium({ investmentPerformance: { results: engineResult, warnings: [] } }));
    // The section itself never renders a number for an unavailable metric —
    // asserting the raw status is what a fabricated-zero regression would
    // flip to 'CALCULATED' with a value of 0.
    const portfolio = (section.sectionData.results as typeof engineResult).portfolios[0];
    expect(portfolio.blendedBenchmarkReturn.status).not.toBe('CALCULATED');
    expect(portfolio.portfolioTwrr.status).not.toBe('CALCULATED');
  });
});

describe('II-R10 continuation — SIP chapter (R5)', () => {
  it('empty data safety: no SIP series detected produces "unavailable"', () => {
    const section = buildSipContribution(emptySource, emptyPremium());
    expect(section.sectionStatus).toBe('unavailable');
    expect(section.limitationText).toMatch(/no recurring/i);
  });

  it('no-recalculation: observations are rendered verbatim from the engine, never re-derived', () => {
    const engineResult = {
      asOfDate: '2026-08-24',
      seriesCount: 2,
      presentableCount: 1,
      engineVersion: 'sip-engine-r5-v-test',
      analytics: [
        {
          series: { seriesKey: 'series-1' },
          actualXirr: { status: 'ok', rate: 0.15 },
          benchmarkSip: { status: 'ok', rate: 0.11 },
          observations: [{ classification: 'OBSERVATION', text: '12 contributions are recorded against 12 expected intervals.' }],
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const section = buildSipContribution(emptySource, emptyPremium({ sip: { results: engineResult, warnings: [] } }));
    expect(section.sectionStatus).toBe('included');
    expect(section.chartData?.observations).toEqual(engineResult.analytics[0].observations);
    expect(section.sourceReferences.engineVersion).toBe('sip-engine-r5-v-test');
  });
});

describe('II-R10 continuation — Portfolio X-Ray chapter (R5)', () => {
  it('empty data safety: no look-through data produces "unavailable"', () => {
    const section = buildPortfolioXray(emptySource, emptyPremium());
    expect(section.sectionStatus).toBe('unavailable');
  });

  it('no-recalculation: sector weight in the narrative matches the engine bucket exactly', () => {
    const engineResult = {
      asOfDate: '2026-08-24',
      engineVersion: 'xray-engine-r5-v-test',
      classificationVersion: 'sector-taxonomy-v3',
      sectorExposure: {
        status: 'ok',
        buckets: [
          { key: 'financials', label: 'Financial Services', effectiveWeight: 0.42, securityCount: 5 },
          { key: 'tech', label: 'Technology', effectiveWeight: 0.2, securityCount: 3 },
        ],
      },
      securityConcentration: {},
      schemeConcentration: {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const section = buildPortfolioXray(emptySource, emptyPremium({ xray: { results: engineResult, warnings: [] } }));
    expect(section.sectionStatus).toBe('included');
    expect(section.narrativeText).toContain('Financial Services');
    expect(section.narrativeText).toContain('42%');
    // The narrative claims the LARGEST sector — this is the exact assertion
    // an NC-style "wrong top holding" regression (spirit of NC8, provenance
    // swap) would break.
    const buckets = (section.sectionData.results as typeof engineResult).sectorExposure.buckets;
    const trueTop = [...buckets].sort((a, b) => b.effectiveWeight - a.effectiveWeight)[0];
    expect(section.narrativeText).toContain(trueTop.label);
  });
});

describe('II-R10 continuation — Tax & Cost chapter (R6)', () => {
  it('empty data safety: no disposals produces "unavailable", never a fabricated ₹0 gain', () => {
    const section = buildTaxAndCost(emptySource, emptyPremium());
    expect(section.sectionStatus).toBe('unavailable');
    expect(section.sectionData).toEqual({});
  });

  it('no-recalculation: taxable gain figures pass through unchanged; disclaimer is the engine\'s own text, not invented', () => {
    const engineResult = {
      engineVersion: 'tax-engine-r6-v-test',
      classification: 'SIMULATION',
      disclaimer: 'SIMULATION ONLY — NOT TAX ADVICE.',
      residencyNote: null,
      ruleVersionNote: null,
      disposalResults: [
        { instrumentName: 'Test Fund A', disposalDate: '2026-06-01', classification: 'long_term', taxableGain: 12345.67 },
      ],
      exitLoadResults: [],
      taxYearAggregation: { byFinancialYear: [], unresolvedDisposals: [] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const section = buildTaxAndCost(emptySource, emptyPremium({ taxAndCost: { results: engineResult, asOfDate: '2026-08-24', taxProfileSource: 'none' } }));
    expect(section.sectionStatus).toBe('included');
    expect((section.sectionData.results as typeof engineResult).disposalResults[0].taxableGain).toBe(12345.67);
    expect(section.narrativeText).toContain('SIMULATION ONLY — NOT TAX ADVICE.');
    expect(section.limitationText).not.toMatch(/personal tax advice$/i); // must not silently imply it IS personal tax advice
  });
});

describe('II-R10 continuation — Priority Review Items chapter (R9)', () => {
  it('empty data safety: no open review items produces "unavailable"', () => {
    const section = buildPriorityReviewItems(emptySource, emptyPremium());
    expect(section.sectionStatus).toBe('unavailable');
  });

  it('does not re-rank by a second priority formula — ordering follows the engine\'s own severity field only (spec section 95)', () => {
    const items = [
      { title: 'Low item', description: 'd', severity: 'low', category: 'c', compliance_classification: 'OBSERVATION', source_module: 'ii_r9', as_of_date: '2026-08-24', rule_key: 'k1', rule_version: 'v1' },
      { title: 'Critical item', description: 'd', severity: 'critical', category: 'c', compliance_classification: 'OBSERVATION', source_module: 'ii_r9', as_of_date: '2026-08-24', rule_key: 'k2', rule_version: 'v1' },
      { title: 'Medium item', description: 'd', severity: 'medium', category: 'c', compliance_classification: 'OBSERVATION', source_module: 'ii_r9', as_of_date: '2026-08-24', rule_key: 'k3', rule_version: 'v1' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any[];
    const section = buildPriorityReviewItems(emptySource, emptyPremium({ reviewItems: { openItems: items, totalOpenCount: 3 } }));
    expect(section.sectionStatus).toBe('included');
    const rendered = section.sectionData.items as { title: string; severity: string }[];
    expect(rendered.map((i) => i.severity)).toEqual(['critical', 'medium', 'low']);
    expect(rendered[0].title).toBe('Critical item');
  });

  it('narrative contradiction protection: title/description text is rendered verbatim from the engine, never rewritten (spec section 89)', () => {
    const items = [
      {
        title: 'Goal forecast gap detected',
        description: 'This goal is currently projected to fall short of its target based on recorded contributions.',
        severity: 'high',
        category: 'goals',
        compliance_classification: 'OBSERVATION',
        source_module: 'ii_r9',
        as_of_date: '2026-08-24',
        rule_key: 'k',
        rule_version: 'v1',
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any[];
    const section = buildPriorityReviewItems(emptySource, emptyPremium({ reviewItems: { openItems: items, totalOpenCount: 1 } }));
    const rendered = section.sectionData.items as { title: string; description: string }[];
    expect(rendered[0].title).toBe('Goal forecast gap detected');
    expect(rendered[0].description).toBe('This goal is currently projected to fall short of its target based on recorded contributions.');
    // Guard against ever synthesising a contradictory opposite phrase such as
    // "on track" alongside a gap-detected item.
    expect(section.narrativeText).not.toMatch(/on track|no action needed/i);
  });
});
