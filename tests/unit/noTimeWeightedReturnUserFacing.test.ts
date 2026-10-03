/**
 * PO decision 2026-10-03 (Document2 D-2): "Remove TWRR working altogether. Keep
 * only XIRR for the user analysis. Wherever TWRR is, remove it completely. I don't
 * want this analysis at all; it will confuse the user."
 *
 * This is the standing guard. It proves, at three levels, that no time-weighted
 * return reaches a user:
 *   1. SOURCE  -- no file under app/, components/, lib/, hooks/, types/, data/,
 *                 public/ mentions TWRR / "time-weighted" / TWR, except the files
 *                 on the explicit DORMANT allow-list below (each with its reason).
 *   2. RESULT  -- the analytics engine's result object, its persistable rows and the
 *                 report chapter's narrative carry no time-weighted metric.
 *   3. UI      -- the Performance panel and the report table show XIRR only.
 *
 * Evidence label: static + unit-level. NOT browser-verified (no DOM environment).
 *
 * NEGATIVE CONTROLS (named, below): the guards are re-run on a faithful copy of
 * the PRE-REMOVAL behaviour -- the old Performance panel markup, the old report
 * table, the old narrative sentence, and an engine result that still carries
 * portfolioTwrr -- and each MUST be flagged. If any control stops failing, the
 * guard has gone vacuous.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { runAnalytics, toPersistableRows, type AnalyticsDataset, type SchemeDataset } from '@/lib/engines/investment-intelligence/analyticsOrchestrator';
import { buildInvestmentPerformance } from '@/lib/engines/reportSectionsPremium';
import type { ReportSourceData, PremiumSourceData } from '@/lib/services/reportSnapshotResolver';

const ROOT = path.resolve(__dirname, '..', '..');

// Time-weighted return, in every spelling the code base ever used: TWRR, TWR (standalone or as a
// key prefix such as twr_since_...), and the words "time-weighted" / "time weighted" / "timeWeighted".
// `\btwr` requires a word boundary so that words such as "inertWrite" / "snapshotWrite" do not match.
const TWR_PATTERN = /twrr|time[-_ ]?weighted|\btwr(?![a-z])/i;

/** The only files allowed to mention it, and why. Anything else is a failure. */
const DORMANT_ALLOW_LIST: Record<string, string> = {
  'lib/services/investment-intelligence/pc6/reportNavDependencyManifest.ts':
    "Legacy NAV-retention basis value 'twr_since_opening_balance': constrained by the DB CHECK on ii_report_nav_dependencies.basis (migration 0172), so it cannot be removed without a migration. No longer written; kept readable so rows written earlier still resolve. Never rendered.",
  'lib/services/investment-intelligence/pc6/reportNavDependencyIntegrity.ts':
    'Same legacy basis value in the type union that mirrors the DB CHECK. Never rendered.',
  'lib/services/investment-intelligence/pc6/reportNavDependencyWriter.ts':
    'A comment recording why the legacy basis is no longer written. Not rendered.',
};

const SCAN_DIRS = ['app', 'components', 'lib', 'hooks', 'types', 'data', 'public'];
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|sql|css|html|txt|csv)$/i;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (TEXT_EXT.test(name)) out.push(full);
  }
  return out;
}

function offendingFiles(): string[] {
  const hits: string[] = [];
  for (const d of SCAN_DIRS) {
    for (const file of walk(path.join(ROOT, d))) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (TWR_PATTERN.test(readFileSync(file, 'utf8'))) hits.push(rel);
    }
  }
  return hits.sort();
}

/** Deep key scan: every object key anywhere in a value, as a flat list. */
function allKeys(value: unknown, acc: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) allKeys(v, acc);
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      acc.push(k);
      allKeys(v, acc);
    }
  }
  return acc;
}

const d = (s: string) => new Date(s + 'T00:00:00.000Z');

function scheme(): SchemeDataset {
  return {
    instrumentId: 'fund-1',
    instrumentName: 'Test Fund',
    currencyCode: 'INR',
    countryOfDomicile: 'IN',
    historyCompleteness: 'complete_from_inception',
    optionType: null,
    hasDistributionAdjustment: false,
    cashFlows: [
      { date: d('2020-01-01'), amount: -1000 },
      { date: d('2022-01-01'), amount: 1500 },
    ],
    externalCashFlows: [
      { date: d('2020-01-01'), amount: -1000 },
      { date: d('2022-01-01'), amount: 1500 },
    ],
    externalCashFlowsExcludingTerminal: [{ date: d('2020-01-01'), amount: -1000 }],
    currentValue: 1500,
    currentValueDate: d('2022-01-01'),
    navSeries: [],
    valuationSeries: [
      { date: d('2020-01-01'), value: 1000 },
      { date: d('2022-01-01'), value: 1500 },
    ],
  };
}

function dataset(): AnalyticsDataset {
  return {
    userId: 'user-1',
    asOfDate: d('2022-01-01'),
    periodStart: d('2020-01-01'),
    schemes: [scheme()],
    mappings: [],
    benchmarkSeriesById: {},
    riskFreeSeries: [],
    navDataVersion: 'nav-v1',
    benchmarkDataVersion: 'bench-v1',
    benchmarkMappingVersion: 'map-v1',
    frequency: 'monthly',
  };
}

describe('1. SOURCE: no time-weighted return anywhere user-reachable', () => {
  const hits = offendingFiles();

  it('the only files that mention it are the explicitly listed dormant ones', () => {
    const unexpected = hits.filter((f) => !(f in DORMANT_ALLOW_LIST));
    expect(unexpected, `unexpected TWRR mentions in: ${unexpected.join(', ')}`).toEqual([]);
  });

  it('every allow-listed file really still mentions it (a stale allow-list entry hides nothing and must be removed)', () => {
    for (const f of Object.keys(DORMANT_ALLOW_LIST)) expect(hits, `${f} no longer needs an allow-list entry`).toContain(f);
  });

  it('the allow-list holds only internal NAV-retention files, never a component, route, report builder or engine result', () => {
    for (const f of Object.keys(DORMANT_ALLOW_LIST)) {
      expect(f).toMatch(/^lib\/services\/investment-intelligence\/pc6\/reportNavDependency/);
    }
  });

  it('the deleted calculation module is really gone', () => {
    expect(existsSync(path.join(ROOT, 'lib/engines/investment-intelligence/twrr.ts'))).toBe(false);
  });
});

describe('2. RESULT: the engine, its persisted rows and the report narrative carry no time-weighted metric', () => {
  const rs = runAnalytics(dataset());
  const portfolio = rs.portfolios[0];

  it('XIRR is still produced', () => {
    expect(portfolio.portfolioXirr.status).toBe('CALCULATED');
    expect(rs.schemes[0].investorXirr.status).toBe('CALCULATED');
  });

  it('no key anywhere in the result set is a time-weighted metric', () => {
    expect(allKeys(rs).filter((k) => TWR_PATTERN.test(k))).toEqual([]);
    expect('portfolioTwrr' in portfolio).toBe(false);
    expect('twrr' in rs.subVersions).toBe(false);
  });

  it('no persisted metric row is a time-weighted metric, and no portfolio-level active return (it was TWRR-based) is written', () => {
    const rows = toPersistableRows('user-1', rs, dataset());
    const keys = rows.map((r) => r.metric_key);
    expect(keys.filter((k) => TWR_PATTERN.test(k))).toEqual([]);
    expect(keys).not.toContain('portfolio_active_return');
    expect(keys).toContain('portfolio_xirr');
    expect(JSON.stringify(rows)).not.toMatch(TWR_PATTERN);
  });

  it('the report chapter narrative and limitation text never name it', () => {
    const premium = {
      investmentPerformance: { results: rs, warnings: [], earliestCashFlowDateByInstrument: {} },
    } as unknown as PremiumSourceData;
    const section = buildInvestmentPerformance({ currency: 'INR' } as unknown as ReportSourceData, premium);
    expect(section.sectionStatus).toBe('included');
    expect(section.narrativeText).toMatch(/XIRR/);
    expect(section.narrativeText ?? '').not.toMatch(TWR_PATTERN);
    expect(section.limitationText).not.toMatch(TWR_PATTERN);

    const multi = { ...rs, portfolios: [portfolio, { ...portfolio, currencyCode: 'AUD' }] };
    const multiSection = buildInvestmentPerformance({ currency: 'INR' } as unknown as ReportSourceData, {
      investmentPerformance: { results: multi, warnings: [], earliestCashFlowDateByInstrument: {} },
    } as unknown as PremiumSourceData);
    expect(multiSection.narrativeText ?? '').not.toMatch(TWR_PATTERN);
  });
});

describe('3. UI: the Performance panel and the report table show XIRR only', () => {
  const panel = readFileSync(path.join(ROOT, 'components/investment-intelligence/PerformanceClient.tsx'), 'utf8');
  const reportPreview = readFileSync(path.join(ROOT, 'components/reports/ReportPreview.tsx'), 'utf8');

  it('the Performance panel offers the XIRR card and no time-weighted card, no active-return-vs-benchmark card', () => {
    expect(panel).toContain('label="Your return (XIRR)"');
    expect(panel).not.toMatch(TWR_PATTERN);
    expect(panel).not.toContain('Active return vs benchmark');
  });

  it('the report performance table has XIRR and benchmark columns only', () => {
    expect(reportPreview).toContain('<th className="py-1">XIRR</th>');
    expect(reportPreview).not.toMatch(TWR_PATTERN);
  });
});

// ---------------------------------------------------------------------------
// NEGATIVE CONTROLS -- faithful copies of the pre-removal behaviour MUST be flagged.
// ---------------------------------------------------------------------------

// Verbatim from PerformanceClient.tsx / ReportPreview.tsx / reportSectionsPremium.ts before this change.
const LEGACY_PANEL_CARD = `        <MetricValue
          label="Time-weighted return (TWRR)"
          outcome={p.portfolioTwrr as never}
          render={(v: never) => pct((v as { twrr: number }).twrr)}
        />`;
const LEGACY_PANEL_NOTE = `TWRR measures how the underlying investments performed, independent of when you added or withdrew money. XIRR measures your own outcome,`;
const LEGACY_REPORT_COLUMN = `<th className="py-1">TWRR</th>`;
const LEGACY_REPORT_CELL = "p.portfolioTwrr.status === 'CALCULATED' && p.portfolioTwrr.value ? `${(p.portfolioTwrr.value.twrr * 100).toFixed(1)}%` : 'Not available'";
const LEGACY_NARRATIVE = "Your investment portfolio's XIRR, TWRR and benchmark comparison as of 01-10-2026 are shown below";
const LEGACY_MULTI_NARRATIVE = 'have enough history to calculate a return (XIRR/TWRR) as of 01-10-2026.';
const LEGACY_DISCLOSURE = 'The portfolio time-weighted return is not available for this period, so active return cannot be shown.';
const LEGACY_VERSION_ROW = 'twrr: twrr-chain-linked-eod-v1';

describe('NEGATIVE CONTROL: the pre-removal Performance panel, report table and narrative are all flagged', () => {
  it.each([
    ['legacy Performance card', LEGACY_PANEL_CARD],
    ['legacy Performance explainer', LEGACY_PANEL_NOTE],
    ['legacy report column header', LEGACY_REPORT_COLUMN],
    ['legacy report table cell', LEGACY_REPORT_CELL],
    ['legacy single-currency narrative', LEGACY_NARRATIVE],
    ['legacy multi-currency narrative', LEGACY_MULTI_NARRATIVE],
    ['legacy active-return disclosure sentence', LEGACY_DISCLOSURE],
    ['legacy "How this was calculated" version row', LEGACY_VERSION_ROW],
  ])('%s is caught by the guard pattern', (_name, text) => {
    expect(text).toMatch(TWR_PATTERN);
  });

  it('an engine result that still carried portfolioTwrr (the old shape) is caught by the deep key scan', () => {
    const legacyShape = {
      portfolios: [{ currencyCode: 'INR', portfolioTwrr: { status: 'CALCULATED', value: { twrr: 0.2 } }, portfolioXirr: { status: 'CALCULATED', value: { rate: 0.1 } } }],
      subVersions: { xirr: 'x', twrr: 'twrr-chain-linked-eod-v1' },
    };
    expect(allKeys(legacyShape).filter((k) => TWR_PATTERN.test(k)).length).toBeGreaterThanOrEqual(2);
  });

  it('a legacy persisted row (metric_key portfolio_twrr) is caught', () => {
    expect('portfolio_twrr').toMatch(TWR_PATTERN);
    expect('twr_since_opening_balance').toMatch(TWR_PATTERN);
  });

  it('the pattern does not fire on unrelated words that merely contain the letters (no false positives)', () => {
    for (const ok of ['snapshotWrite', 'inertWrite', 'writeFinancialSnapshots', 'XIRR', 'Money-weighted', 'unit-weighted valuation']) {
      expect(ok).not.toMatch(TWR_PATTERN);
    }
  });

  it('the source scan would fail if a user-facing file regained a mention (simulated by scanning a mutated copy)', () => {
    const panel = readFileSync(path.join(ROOT, 'components/investment-intelligence/PerformanceClient.tsx'), 'utf8');
    expect(panel).not.toMatch(TWR_PATTERN);
    const mutated = panel.replace('label="Your return (XIRR)"', 'label="Time-weighted return (TWRR)"');
    expect(mutated).not.toBe(panel);
    expect(mutated).toMatch(TWR_PATTERN);
  });
});
