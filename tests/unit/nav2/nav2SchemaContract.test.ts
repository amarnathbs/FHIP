// NAV2 SCHEMA CONTRACT: every table, column and function the NAV2 code names must exist in the real database shape.
//
// WHY: Stage 3 against the real DEV database found `column ii_prices_nav.provider does not exist` in the fund-analytics loader. Every unit
// suite had passed, because the in-memory database accepted any column name. The oracle here is derived from supabase/migrations (every
// numbered migration, in order, tests/unit/support/migrationSchema.ts): it parses each select list, filter / order column, insert / update /
// upsert payload key (when written as an object literal), table name, RPC name and RPC parameter name in the NAV2 sources and fails on any
// that the migrations do not define. Payloads built in a variable are checked at run time by the STRICT in-memory database
// (createInMemoryDb({ strictSchema: true })), which every NAV2 suite uses.
//
// The migration reader is itself checked against the real DEV column list of ii_prices_nav (PostgREST OpenAPI, supplied by the Stage 3 run)
// so a reader that drifted from the real database would fail here first. NEGATIVE CONTROLS re-run the checker on mutated copies of the real
// sources and name each defect, including the exact old select string that contained `provider`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationSchema } from '../support/migrationSchema';
import { checkUsage, constantMap, selectColumns, type SchemaViolation } from '../support/supabaseUsage';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

function walk(rel: string, acc: string[] = []): string[] {
  for (const name of readdirSync(path.join(ROOT, rel))) {
    const r = `${rel}/${name}`;
    if (statSync(path.join(ROOT, r)).isDirectory()) walk(r, acc);
    else if (/\.(ts|tsx)$/.test(name)) acc.push(r);
  }
  return acc;
}

/** Every NAV2 source that talks to the database: the service layer, the cache store, workers, the admin routes, monitoring, and the report routes. */
const FILES = [
  ...walk('lib/services/investment-intelligence/nav2'),
  ...walk('app/api/admin/investment-intelligence/nav2-monitoring'),
  ...walk('app/api/admin/investment-intelligence/risk-free-data'),
  ...walk('app/api/investment-intelligence/cron/nav2-correction-worker'),
  ...walk('app/api/investment-intelligence/cron/nav2-risk-free-refresh'),
  ...walk('app/api/reports/fund-analytics'),
  // The NAV2 report's data comes through these existing loaders; they are held to the same contract.
  'lib/services/investment-intelligence/analyticsRepository.ts',
  'lib/services/investment-intelligence/ownerClassReportScope.ts',
];
const SOURCES = new Map(FILES.map((f) => [f, read(f)]));
const CONSTANTS = constantMap([...SOURCES.values()]);

function checkAll(mutate?: (file: string, src: string) => string) {
  const violations: SchemaViolation[] = [];
  const total = { selects: 0, filters: 0, writes: 0, dynamic: 0, tables: new Set<string>(), functions: new Set<string>() };
  for (const [f, s] of SOURCES) {
    const r = checkUsage(f, mutate ? mutate(f, s) : s, CONSTANTS);
    violations.push(...r.violations);
    total.selects += r.summary.selectsChecked;
    total.filters += r.summary.filtersChecked;
    total.writes += r.summary.writesChecked;
    total.dynamic += r.summary.dynamicWrites;
    r.summary.tables.forEach((t) => total.tables.add(t));
    r.summary.functions.forEach((t) => total.functions.add(t));
  }
  return { violations, total };
}

function mutateOne(file: string, from: string, to: string): (f: string, s: string) => string {
  return (f, s) => {
    if (f !== file) return s;
    const next = s.replace(from, to);
    if (next === s) throw new Error(`the control did not change ${file}: ${from}`);
    return next;
  };
}

describe('the migration reader reproduces the real database', () => {
  it('ii_prices_nav has exactly the columns DEV reports (and NO provider column)', () => {
    const t = migrationSchema().tables.get('ii_prices_nav');
    expect(t).toBeDefined();
    expect([...(t?.columns ?? [])].sort()).toEqual(
      ['id', 'instrument_id', 'source_id', 'currency_code', 'price_date', 'price', 'created_at', 'source_timestamp', 'data_version', 'quality_status', 'import_batch_id', 'record_checksum', 'superseded_by_id', 'correction_of_id'].sort()
    );
    expect(t?.columns.has('provider')).toBe(false);
  });

  it('reads the whole chain, including 0260-0262, and the functions NAV2 calls', () => {
    const s = migrationSchema();
    expect(s.files).toBeGreaterThanOrEqual(224);
    for (const t of ['ii_sources', 'ii_risk_free_series', 'ii_risk_free_observations', 'nav2_result_cache', 'nav2_fund_analytics_reports', 'nav2_correction_events', 'nav2_report_nav_dependencies', 'nav2_report_render_tokens']) expect(s.tables.has(t), t).toBe(true);
    for (const f of ['commit_risk_free_upload', 'record_risk_free_refresh_results', 'correct_risk_free_observation', 'resolve_risk_free_review_item', 'set_risk_free_series_state', 'nav2_monitoring_snapshot']) expect(s.functions.has(f), f).toBe(true);
    expect(s.tables.get('admin_users')?.columns.has('can_upload_risk_free_data')).toBe(true);
  });

  it('select lists are read as PostgREST reads them (aliases, casts, embeds, star)', () => {
    expect(selectColumns('a, b:c, d::text, e(f, g), *, h->>i')).toEqual(['a', 'c', 'd', 'h']);
  });
});

describe('NAV2 code names only tables, columns and functions the migrations define', () => {
  it('covers the whole NAV2 database surface (guards against the scan silently emptying)', () => {
    const { total } = checkAll();
    expect(total.selects).toBeGreaterThanOrEqual(30);
    expect(total.filters).toBeGreaterThanOrEqual(50);
    expect(total.writes).toBeGreaterThanOrEqual(8);
    for (const t of ['ii_prices_nav', 'ii_sources', 'nav2_result_cache', 'nav2_fund_analytics_reports', 'ii_risk_free_observations', 'ii_risk_free_batches', 'admin_users']) expect(total.tables.has(t), t).toBe(true);
    for (const f of ['commit_risk_free_upload', 'nav2_monitoring_snapshot', 'record_risk_free_refresh_results']) expect(total.functions.has(f), f).toBe(true);
  });

  it('no unknown table, column, function or function parameter', () => {
    const { violations } = checkAll();
    expect(violations, JSON.stringify(violations, null, 1)).toEqual([]);
  });

  it('the fund-analytics loader reads the provider from ii_sources via source_id, never a provider column', () => {
    const src = SOURCES.get('lib/services/investment-intelligence/nav2/fundAnalyticsLoader.ts') as string;
    expect(src).toContain(".from('ii_sources').select('id, source_key')");
    expect(src).toContain('UNKNOWN_NAV_SOURCE');
    expect(/\.select\('[^']*\bprovider\b[^']*'\)/.test(src)).toBe(false);
  });
});

describe('repo-wide: the same contract over all of lib/ and app/ (found while auditing NAV2)', () => {
  // KNOWN DEFECTS found by this audit, outside NAV2, left for their owners (listed so the guard can fail on any NEW mismatch).
  const KNOWN: ReadonlyArray<{ file: string; what: string; table: string; why: string }> = [
    { file: 'app/api/admin/investment-intelligence/lookthrough-data-quality/route.ts', what: 'unknown-table', table: 'ii_holdings', why: 'no table ii_holdings exists; the read error is swallowed, so every fund shows as held by nobody' },
  ];
  it('no unknown table, column, function or parameter anywhere except the listed known defect(s)', () => {
    const files = [...walk('lib'), ...walk('app')];
    const srcs = new Map(files.map((f) => [f, read(f)]));
    const consts = constantMap([...srcs.values()]);
    const found: SchemaViolation[] = [];
    for (const [f, s] of srcs) {
      for (const v of checkUsage(f, s, consts).violations) {
        // A select built from a constant or variable that is not a literal in the same repo cannot be read statically: not a mismatch.
        if (v.what === 'unresolved-select') continue;
        if (KNOWN.some((k) => k.file === v.file && k.what === v.what && k.table === v.table)) continue;
        found.push(v);
      }
    }
    expect(found, JSON.stringify(found, null, 1)).toEqual([]);
  }, 60000);
});

describe('NEGATIVE CONTROLS: the checker demonstrably catches each defect', () => {
  const LOADER = 'lib/services/investment-intelligence/nav2/fundAnalyticsLoader.ts';

  it('SCHEMA-NC-1: the OLD loader select string (with provider) fails and names provider', () => {
    const v = checkAll(mutateOne(LOADER, "record_checksum, source_id, data_version')", "record_checksum, provider, data_version')")).violations;
    expect(v.some((x) => x.what === 'unknown-column' && x.table === 'ii_prices_nav' && /"provider"/.test(x.detail))).toBe(true);
  });

  it('SCHEMA-NC-2: an unknown column in a filter, an order and an insert payload is caught', () => {
    const store = 'lib/services/investment-intelligence/nav2/nav2ResultCacheStore.ts';
    expect(checkAll(mutateOne(store, ".order('id', { ascending: true })", ".order('processed_on', { ascending: true })")).violations.some((x) => /order\(\) column "processed_on"/.test(x.detail))).toBe(true);
    const svc = 'lib/services/investment-intelligence/nav2/fundAnalyticsRenderToken.ts';
    expect(checkAll(mutateOne(svc, 'insert({ token, user_id: userId,', 'insert({ token, owner_id: userId,')).violations.some((x) => /payload key "owner_id"/.test(x.detail))).toBe(true);
    expect(checkAll(mutateOne(svc, ".eq('token', token).maybeSingle()", ".eq('tok', token).maybeSingle()")).violations.some((x) => /eq\(\) column "tok"/.test(x.detail))).toBe(true);
  });

  it('SCHEMA-NC-3: an unknown table and an unknown RPC are caught', () => {
    const store = 'lib/services/investment-intelligence/nav2/nav2ResultCacheStore.ts';
    expect(checkAll(mutateOne(store, ".from('nav2_correction_events')", ".from('nav2_correction_event')")).violations.some((x) => x.what === 'unknown-table')).toBe(true);
    const route = 'app/api/admin/investment-intelligence/nav2-monitoring/route.ts';
    expect(checkAll(mutateOne(route, "rpc('nav2_monitoring_snapshot')", "rpc('nav2_monitoring_snapshots')")).violations.some((x) => x.what === 'unknown-function')).toBe(true);
  });

  it('SCHEMA-NC-4: a wrong RPC parameter name is caught', () => {
    const route = 'app/api/admin/investment-intelligence/risk-free-data/correct/route.ts';
    expect(checkAll(mutateOne(route, 'p_new_value:', 'p_value:')).violations.some((x) => x.what === 'unknown-function-param' && /p_value/.test(x.detail))).toBe(true);
  });

  it('SCHEMA-NC-5: a column in a select that goes through a template constant is resolved and checked (the admin_users capability columns)', () => {
    const f = 'lib/services/investment-intelligence/nav2/riskFreeAdmin.ts';
    const v = checkAll(mutateOne(f, "from('admin_users').select(`${RISK_FREE_UPLOAD_CAPABILITY}, ${RISK_FREE_SWITCH_CAPABILITY}`)", "from('admin_users').select(`${RISK_FREE_UPLOAD_CAPABILITY}, can_not_exist`)")).violations;
    expect(v.some((x) => /"can_not_exist"/.test(x.detail))).toBe(true);
  });

  it('SCHEMA-NC-6: the clean sources produce no violation (the controls are not noise)', () => {
    expect(checkAll().violations).toEqual([]);
  });
});
