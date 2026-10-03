// NAV2 Stage 1 -- the service contract end to end, determinism, and the standing
// guards (policy / register / documentation drift, purity, no ISO dates, no
// time-based return wording).
//
// Matrix rows: 17 (annualisation disclosed, via provenance), 41 (deterministic /
// byte-for-byte repeatable), 45 (nothing identifying in results), plus the typed-state
// contract of spec 11.
//
// NAMED NEGATIVE CONTROLS
//   NC-G1  every unavailable result, at any depth, carries no `value` key and carries a reason and a sentence
//          (a bare number can never stand in for a typed state);
//   NC-G2  the same inputs give a byte-identical result, and so do the same rows in a different order;
//   NC-G3  the register in code and the documentation cannot drift: a metric id with no `###` section (or the
//          reverse) fails; the test matrix document must list all 50 rows;
//   NC-G4  engine and config code never read a clock or the network;
//   NC-G5  no sentence the engine writes contains an ISO date.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NAV2_ENGINE_VERSION, NAV2_METRICS, NAV2_POLICY, NAV2_POLICY_VERSION, withPolicyOverrides } from '@/lib/config/nav2/metricPolicy';
import { standardAnalysisSpec } from '@/lib/engines/nav2/analysisSpec';
import { computeSchemePerformance } from '@/lib/engines/nav2/analyticsContract';
import { prepareSeries } from '@/lib/engines/nav2/series';
import { NAV2_UNAVAILABLE_STATES } from '@/lib/engines/nav2/types';
import { allStrings, buildSeries, ctxInr, IDENTITY, ISO_DATE_IN_TEXT, rowsFor, weekdays } from './support/fixtures';
import { benchmarkFor } from './support/benchmarks';
import { dataset, obs } from './support/riskFreeFixtures';

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

/** A deterministic pseudo-random walk (linear congruential generator): inputs only, never an expected value. */
function walk(n: number, start: number, seed: number, drift = 0.0003, scale = 0.012): number[] {
  let x = seed;
  const out = [start];
  for (let i = 0; i < n; i++) {
    x = (1103515245 * x + 12345) % 2147483648;
    const u = x / 2147483648 - 0.5;
    out.push(out[out.length - 1] * (1 + drift + u * scale * 2));
  }
  return out;
}

const DATES = weekdays('2023-01-02', 701); // 701 weekdays: about 2.7 years, to 18-09-2025
const SCHEME = walk(700, 100, 12345);
const BENCH = walk(700, 1000, 99991);

function weeklyThrough(from: string, to: string, yieldPercent: number) {
  const out = [];
  const cur = new Date(`${from}T00:00:00.000Z`);
  while (cur.toISOString().slice(0, 10) <= to) {
    out.push(obs(cur.toISOString().slice(0, 10), yieldPercent));
    cur.setUTCDate(cur.getUTCDate() + 7);
  }
  return dataset({ observations: out });
}

interface Found {
  path: string;
  node: Record<string, unknown>;
}
/** Every object in a value that has a `state` field (a Nav2Result at any depth). */
function findResults(value: unknown, trail = '$', acc: Found[] = []): Found[] {
  if (Array.isArray(value)) value.forEach((v, i) => findResults(v, `${trail}[${i}]`, acc));
  else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.state === 'string' && 'provenance' in o) acc.push({ path: trail, node: o });
    for (const [k, v] of Object.entries(o)) findResults(v, `${trail}.${k}`, acc);
  }
  return acc;
}

describe('the service contract (computeSchemePerformance, standard spec)', () => {
  const series = buildSeries(DATES, SCHEME);
  const spec = standardAnalysisSpec('2026-10-03', NAV2_POLICY);
  // the mapping must be in force for the WHOLE window: it starts before the first NAV (a control in nav2SchemeRisk shows a later start is refused)
  const benchmarks = benchmarkFor(DATES, BENCH, { effectiveFrom: new Date('2022-01-01T00:00:00.000Z') });
  const riskFree = weeklyThrough('2022-12-26', '2025-12-29', 6.5);

  it('with a benchmark and a risk-free series every family member is a typed result; histories too short are insufficient_history, not zero', () => {
    const out = computeSchemePerformance({ series, spec, ctx: ctxInr(), benchmarks, riskFree });
    expect(out.family).toBe('scheme_performance');
    expect(out.policyVersion).toBe(NAV2_POLICY_VERSION);
    expect(out.engineVersion).toBe(NAV2_ENGINE_VERSION);
    const byHorizon = Object.fromEntries(out.rolling.map((r) => [r.horizonId, r.result.state]));
    expect(byHorizon).toMatchObject({ '1M': 'available', '3M': 'available', '6M': 'available', '1Y': 'available', '3Y': 'insufficient_history', '5Y': 'insufficient_history' });
    expect(out.volatility?.state).toBe('available');
    expect(out.sharpe?.state).toBe('available');
    expect(out.sortino?.state).toBe('available');
    expect(out.maxDrawdown?.state).toBe('available');
    expect(out.beta?.state).toBe('available');
    expect(out.alpha?.state).toBe('available');
    expect(out.movingAverages.every((m) => m.result.state === 'available')).toBe(true); // SMA 20 / 50 / 100 / 200 and EMA 20 / 50 on 701 observations
    expect(out.extremes.state).toBe('available');
    expect(out.average.state).toBe('available');
  });

  it('NC-G1: every result at any depth is a typed state; an unavailable one has NO value key, a reason and a sentence', () => {
    for (const variant of [
      computeSchemePerformance({ series, spec, ctx: ctxInr(), benchmarks, riskFree }),
      computeSchemePerformance({ series, spec, ctx: ctxInr(), riskFree: null }), // no benchmark, no risk-free
      computeSchemePerformance({ series: buildSeries(DATES.slice(0, 40), SCHEME.slice(0, 40)), spec, ctx: ctxInr(), benchmarks, riskFree }), // short history
      computeSchemePerformance({ series: buildSeries(DATES, SCHEME, { identity: { resolved: false } }), spec, ctx: ctxInr(), benchmarks, riskFree }),
    ]) {
      const results = findResults(variant);
      expect(results.length).toBeGreaterThan(15);
      for (const { path: p, node } of results) {
        expect(['available', ...NAV2_UNAVAILABLE_STATES], p).toContain(node.state);
        if (node.state === 'available') {
          expect('value' in node, p).toBe(true);
        } else {
          expect('value' in node, p).toBe(false);
          expect(typeof node.reason, p).toBe('string');
          expect((node.detail as string).length, p).toBeGreaterThan(10);
        }
        const prov = node.provenance as Record<string, unknown>;
        expect(prov.policyVersion, p).toBe(NAV2_POLICY_VERSION);
        expect(prov.engineVersion, p).toBe(NAV2_ENGINE_VERSION);
        expect(typeof prov.definitionVersion, p).toBe('string');
      }
    }
  });

  it('typed states by cause: no benchmark -> benchmark_missing; no risk-free -> risk_free_missing; unresolved -> identity_unresolved', () => {
    const none = computeSchemePerformance({ series, spec, ctx: ctxInr(), riskFree: null });
    expect(none.beta?.state).toBe('benchmark_missing');
    expect(none.alpha?.state).toBe('benchmark_missing'); // alpha is never shown without beta
    expect(none.sharpe?.state).toBe('risk_free_missing');
    expect(none.sortino?.state).toBe('risk_free_missing');
    expect(none.volatility?.state).toBe('available'); // volatility needs neither
    const withBench = computeSchemePerformance({ series, spec, ctx: ctxInr(), benchmarks, riskFree: null });
    expect(withBench.beta?.state).toBe('available');
    expect(withBench.alpha?.state).toBe('risk_free_missing');
    const unresolved = computeSchemePerformance({ series: buildSeries(DATES, SCHEME, { identity: { resolved: false } }), spec, ctx: ctxInr(), benchmarks, riskFree });
    expect(findResults(unresolved).every((r) => r.node.state === 'identity_unresolved')).toBe(true);
  });

  it('the typed-state vocabulary is exactly the spec 11 list', () => {
    expect([...NAV2_UNAVAILABLE_STATES].sort()).toEqual(['benchmark_missing', 'currency_mismatch', 'data_quality_hold', 'history_hydrating', 'identity_unresolved', 'insufficient_history', 'not_applicable', 'risk_free_missing']);
  });

  it('matrix 17: the annualisation convention is in the provenance of every annualised result', () => {
    const out = computeSchemePerformance({ series, spec, ctx: ctxInr(), benchmarks, riskFree });
    for (const r of [out.volatility, out.sharpe, out.sortino, out.beta, out.alpha]) {
      expect(r?.provenance.convention.frequency).toBe('daily');
      expect(r?.provenance.convention.periodsPerYear).toBe(252);
    }
    expect(out.alpha?.provenance.convention.alphaAnnualisation).toBe('arithmetic_periodic_alpha_times_periods_per_year');
    expect(out.sortino?.provenance.convention.sortino).toBe('target_is_matched_risk_free_all_periods_population_denominator');
  });

  it('NC-G2 / matrix 41: the same inputs give a byte-identical result; so do the same rows in a different order', () => {
    const a = computeSchemePerformance({ series, spec, ctx: ctxInr(), benchmarks, riskFree });
    const b = computeSchemePerformance({ series, spec, ctx: ctxInr(), benchmarks, riskFree });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const reversed = prepareSeries({ identity: IDENTITY, asOfDate: '2026-10-03', rows: rowsFor(IDENTITY.instrumentId, DATES, SCHEME).reverse() }, NAV2_POLICY);
    const c = computeSchemePerformance({ series: reversed, spec, ctx: ctxInr(), benchmarks, riskFree });
    expect(JSON.stringify(c)).toBe(JSON.stringify(a));
  });

  it('NC-G5: no sentence the engine writes contains an ISO date, in INR or AUD', () => {
    for (const currency of ['INR', 'AUD'] as const) {
      const out = computeSchemePerformance({ series, spec, ctx: { policy: NAV2_POLICY, currency }, benchmarks, riskFree: weeklyThrough('2022-12-26', '2025-12-29', 6.5) });
      const sentences = findResults(out).flatMap(({ node }) => [
        ...(node.state === 'available' ? [] : [node.detail as string]),
        ...((node.disclosures as Array<{ detail: string }>) ?? []).map((d) => d.detail),
      ]);
      expect(sentences.length).toBeGreaterThan(5);
      for (const s of allStrings(sentences)) expect(s, s).not.toMatch(ISO_DATE_IN_TEXT);
    }
  });

  it('nothing identifying is in a result: no user, household, folio or document key anywhere', () => {
    const out = computeSchemePerformance({ series, spec, ctx: ctxInr(), benchmarks, riskFree });
    expect(JSON.stringify(out)).not.toMatch(/user_?id|household|folio|document_?id|"email"/i);
  });
});

describe('policy and versioning', () => {
  it('the policy is versioned; an override re-stamps the version so provenance shows it', () => {
    expect(NAV2_POLICY.version).toBe('nav2-policy-v1');
    const o = withPolicyOverrides({ minimums: { volatilityReturns: 5 } }, 'unit');
    expect(o.version).toBe('nav2-policy-v1+unit');
    expect(o.minimums.volatilityReturns).toBe(5);
    expect(o.minimums.sharpeSortinoReturns).toBe(60); // other fields keep their values
    expect(NAV2_POLICY.minimums.volatilityReturns).toBe(30); // the shared policy object is not mutated
    const s = buildSeries(weekdays('2025-01-06', 8), [100, 101, 100, 101, 100, 101, 100, 101]);
    const r = computeSchemePerformance({ series: s, spec: { ...standardAnalysisSpec('2026-10-03', o), rollingHorizonIds: [], movingAverages: [], rocPeriods: [], benchmarkRelative: false }, ctx: ctxInr(o), riskFree: null });
    expect(r.volatility?.provenance.policyVersion).toBe('nav2-policy-v1+unit');
  });

  it('every metric has a unique definition version and a formula; the two families are the only two', () => {
    const versions = Object.values(NAV2_METRICS).map((m) => m.version);
    expect(new Set(versions).size).toBe(versions.length);
    for (const m of Object.values(NAV2_METRICS)) {
      expect(m.formula.length).toBeGreaterThan(5);
      expect(['scheme_performance', 'investor_experience']).toContain(m.family);
    }
  });
});

describe('NC-G3: documentation cannot drift from the code', () => {
  const register = read('docs/nav2/NAV2_METRIC_DEFINITION_REGISTER.md');

  it('every metric id in NAV2_METRICS has a ### section in the register, and every ### section is a metric id (or one of the explicitly named extra sections)', () => {
    const ids = Object.keys(NAV2_METRICS);
    const headings = [...register.matchAll(/^### (\S+)\s*$/gm)].map((m) => m[1]);
    for (const id of ids) expect(headings, `missing section for ${id}`).toContain(id);
    for (const h of headings) expect(ids, `section ${h} has no metric`).toContain(h);
    // control: a fabricated id is not found
    expect(headings).not.toContain('time_weighted_return');
  });

  it('the register states the policy version and the definition version of each metric', () => {
    expect(register).toContain(NAV2_POLICY_VERSION);
    for (const m of Object.values(NAV2_METRICS)) {
      if (m.family === 'scheme_performance') expect(register, m.id).toContain(m.version);
    }
  });

  it('the test matrix document lists all 50 spec rows, each with a status, and every test file it cites exists', () => {
    const doc = read('docs/nav2/NAV2_TEST_MATRIX_AND_STAGE_PLAN.md');
    const rows = [...doc.matchAll(/^\| (\d{1,2}) \| (.+?) \| (COVERED|PARTIAL|DEFERRED|DROPPED) \|(.*)\|$/gm)];
    const numbers = rows.map((r) => Number(r[1]));
    expect(numbers).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    const cited = new Set([...doc.matchAll(/`(nav2[A-Za-z]+\.test\.ts)`/g)].map((m) => m[1]));
    expect(cited.size).toBeGreaterThan(5);
    for (const f of cited) expect(fs.existsSync(path.join(process.cwd(), 'tests/unit/nav2', f)), f).toBe(true);
    // the stated counts match the table (no hand-edited summary)
    const tally = (st: string) => rows.filter((r) => r[3] === st).length;
    expect(doc).toContain(`Count: COVERED ${tally('COVERED')}, PARTIAL ${tally('PARTIAL')}, DEFERRED ${tally('DEFERRED')}, DROPPED ${tally('DROPPED')}.`);
    // every COVERED row cites at least one test file
    for (const r of rows.filter((x) => x[3] === 'COVERED')) expect(r[4], `row ${r[1]}`).toMatch(/nav2[A-Za-z]+\.test\.ts/);
  });

  it('the Phase A documents all exist', () => {
    for (const f of ['NAV2_ARCHITECTURE_AND_DATA_FLOW', 'NAV2_METRIC_DEFINITION_REGISTER', 'NAV2_REQUIRED_HISTORY_WINDOW_POLICY', 'NAV2_SOURCE_AND_LINEAGE_MATRIX', 'NAV2_BENCHMARK_AND_RISK_FREE_DEPENDENCY_REGISTER', 'NAV2_REUSE_AND_DUPLICATE_FORMULAS', 'NAV2_TEST_MATRIX_AND_STAGE_PLAN']) {
      expect(fs.existsSync(path.join(process.cwd(), 'docs/nav2', `${f}.md`)), f).toBe(true);
    }
  });
});

describe('NC-G4: purity and wording guards on the NAV2 code', () => {
  const files = (dir: string): string[] => fs.readdirSync(path.join(process.cwd(), dir)).filter((f) => f.endsWith('.ts')).map((f) => `${dir}/${f}`);
  const engineFiles = [...files('lib/engines/nav2'), ...files('lib/config/nav2')];

  it('engine and config code never read the clock, the network, the filesystem or an environment variable', () => {
    for (const f of engineFiles) {
      const src = read(f);
      expect(src, `${f}: clock`).not.toMatch(/Date\.now\(|new Date\(\)|performance\.now\(|Math\.random\(/);
      expect(src, `${f}: io`).not.toMatch(/from ['"](node:)?(fs|http|https|net)['"]|\bfetch\(|process\.env/);
    }
    // control: the detector does flag a clock read
    expect(/Date\.now\(/.test('const t = Date.now();')).toBe(true);
  });

  it('no time-based return wording in NAV2 code (the repo-wide guard also covers lib/)', () => {
    const pattern = /twrr|time[-_ ]?weighted|\btwr(?![a-z])/i;
    for (const f of [...engineFiles, 'lib/services/investment-intelligence/nav2/windowPlannerService.ts']) expect(read(f), f).not.toMatch(pattern);
    expect(pattern.test('Time-Weighted Return')).toBe(true); // control
  });

  it('the NAV2 engine does not import any service that reaches a database (only the pure helpers it reuses)', () => {
    for (const f of files('lib/engines/nav2')) {
      const src = read(f);
      expect(src, f).not.toMatch(/@\/lib\/supabase|createAdminClient|createClient\(/);
    }
  });
});
