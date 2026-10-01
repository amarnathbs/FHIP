// Net Worth current-NAV re-mark: migration, wiring, UI and read-model contracts.
// Static contracts read the real source / migration text; the UI and read-model
// tests render / run the real components and selectors. Each static check is a
// function that is run on the real file (must pass) and on a deliberately broken
// text (must fail with its own named message), so a green result is not vacuous.

import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { DashboardDataStatusNotice } from '@/components/dashboard/DashboardDataStatusNotice';
import { PublishedFundValuationsTable, type Line } from '@/components/investments/PublishedFundValuations';
import { computeDashboard, type DashboardDataStatus, type DashboardInput } from '@/lib/engines/dashboard';
import { allUnavailableCashFlow } from '@/lib/services/dashboardCanonicalAdapter';
import { summarisePublishedValuations } from '@/lib/engines/investment-intelligence/valuation/publishedRowRemark';
import { selectInvestments } from '@/lib/read-models/investments';
import { ensurePublishedValuesCurrent } from '@/lib/services/investment-intelligence/publishedValueRemark';
import { makeFakeSupabase } from './readModels/helpers/fakeSupabase';
import { profile, tables, USER } from './readModels/helpers/fixtures';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const stripSqlComments = (s: string) => s.replace(/--[^\n]*/g, '');

// ---------------------------------------------------------------------------
// 1. The migration
// ---------------------------------------------------------------------------
const MIGRATION = '0240_networth_current_nav_remark.sql';

/** Returns the named violations found in a migration's executable text. */
function lintMigration(sql: string): string[] {
  const code = stripSqlComments(sql).toLowerCase();
  const v: string[] = [];
  if (/\bdrop\s+(constraint|table|column|policy\s+(?!if exists))/.test(code.replace(/drop policy if exists/g, ''))) v.push('MIG-1: drops an existing object');
  if (/\balter\s+table\s+\w+\s+alter\s+column/.test(code)) v.push('MIG-2: alters an existing column');
  if (/\b(delete\s+from|truncate|update\s+\w+\s+set)\b/.test(code)) v.push('MIG-3: rewrites existing data (a backfill)');
  for (const m of code.matchAll(/add\s+column\s+(?!if not exists)/g)) v.push(`MIG-4: add column without if not exists at ${m.index}`);
  if (/create\s+table\s+(?!if not exists)/.test(code)) v.push('MIG-5: create table without if not exists');
  if (/create\s+policy[^;]*for\s+(insert|update|delete|all)\b/.test(code)) v.push('MIG-6: grants a write policy on the revision table');
  if (/ii_audit_events/.test(code)) v.push('MIG-7: touches the shared audit-event vocabulary');
  if (/ii_fhip_publications\s+(drop|alter)|alter\s+table\s+ii_fhip_publications/.test(code)) v.push('MIG-8: alters the publication table');
  return v;
}

describe('migration 0240 (additive, idempotent, RLS-safe, no CHECK recreate)', () => {
  const sql = read(`supabase/migrations/${MIGRATION}`);

  it('is numbered above every other migration in this branch and is the only file with its prefix', () => {
    const files = readdirSync(path.join(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql'));
    expect(files.filter((f) => f.startsWith('0240'))).toEqual([MIGRATION]);
    const others = files.filter((f) => f !== MIGRATION).map((f) => Number(f.slice(0, 4)));
    expect(Math.max(...others)).toBeLessThan(240);
  });

  it('passes the migration lint: no drops, no column alterations, no backfill, guarded adds, read-only policy, no audit-vocabulary change', () => {
    expect(lintMigration(sql)).toEqual([]);
  });

  it('NEGATIVE CONTROL: the same lint flags each forbidden construct by name', () => {
    expect(lintMigration('alter table x drop constraint c;')).toContain('MIG-1: drops an existing object');
    expect(lintMigration('alter table investments alter column current_value type int;')).toContain('MIG-2: alters an existing column');
    expect(lintMigration('update investments set current_value = 0;')).toContain('MIG-3: rewrites existing data (a backfill)');
    expect(lintMigration('alter table investments add column z int;').some((m) => m.startsWith('MIG-4'))).toBe(true);
    expect(lintMigration('create table t (id int);')).toContain('MIG-5: create table without if not exists');
    expect(lintMigration('create policy "p" on t for all using (true);')).toContain('MIG-6: grants a write policy on the revision table');
    expect(lintMigration("alter table ii_audit_events drop constraint ii_audit_events_event_type_check;").length).toBeGreaterThan(1);
  });

  it('adds exactly the six nullable investment columns and the revision table, with RLS enabled and a select-only owner policy', () => {
    const code = stripSqlComments(sql);
    for (const col of ['ii_value_as_of date', 'ii_valuation_basis text', 'ii_valuation_units numeric(20, 6)', 'ii_valuation_nav numeric(20, 6)', 'ii_valuation_fingerprint text', 'ii_valuation_remarked_at timestamptz']) {
      expect(code).toContain(`add column if not exists ${col};`);
    }
    expect(code).toContain('alter table ii_investment_value_revisions enable row level security;');
    expect(code).toMatch(/create policy "read own ii_investment_value_revisions" on ii_investment_value_revisions\s+for select using \(auth\.uid\(\) = user_id\);/);
  });

  it('the only CHECK it adds is on a column it creates itself, under a new name (no predecessor constraint to derive)', () => {
    const code = stripSqlComments(sql);
    const adds = [...code.matchAll(/add constraint (\w+)/g)].map((m) => m[1]);
    expect(adds).toEqual(['chk_investments_ii_valuation_basis']);
    expect(code).toMatch(/check \(ii_valuation_basis is null or ii_valuation_basis in \('market_nav', 'statement', 'redeemed'\)\)/);
  });

  it('every table it references already exists in the ledger before 0240', () => {
    const files = readdirSync(path.join(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql') && f < MIGRATION);
    const ledger = files.map((f) => read(`supabase/migrations/${f}`)).join('\n').toLowerCase();
    for (const t of ['investments', 'ii_fhip_publications', 'ii_instruments']) expect(ledger).toMatch(new RegExp(`create table (if not exists )?${t}\\b`));
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 2. Source wiring
// ---------------------------------------------------------------------------
describe('wiring: every Net Worth entry point evaluates the published funds first; the publication evidence is never rewritten', () => {
  const callsIn = (src: string) => [...src.matchAll(/ensurePublishedValuesCurrent\(/g)].length;

  it('publish / refresh / republish each re-mark the row they touched, and publication keeps the certified statement value', () => {
    const src = read('lib/services/investment-intelligence/investmentPublicationService.ts');
    expect(src).toMatch(/ensurePublishedValuesCurrent\(userId, supabase, 'publish', \[publishedRowId\]\)/);
    expect(src).toMatch(/ensurePublishedValuesCurrent\(userId, supabase, 'refresh', \[active\.published_row_id as string\]\)/);
    expect(src).toMatch(/ensurePublishedValuesCurrent\(userId, supabase, 'republish', \[pub\.published_row_id as string\]\)/);
    expect(src).toContain('published_value: snapshot.value,');
    expect(callsIn(src)).toBe(3);
  });

  it('the canonical snapshot (Dashboard, Goals, Twin, Reports) re-marks BEFORE any selector reads investments', () => {
    const check = (src: string) => {
      const call = src.indexOf("ensurePublishedValuesCurrent(userId, ctx.client, 'dashboard_read')");
      const firstSelector = src.indexOf('selectInvestments(userId');
      if (call < 0 || firstSelector < 0 || call > firstSelector) throw new Error('RULE WIRE-1: the re-mark must run before the investments selector');
    };
    const src = read('lib/read-models/snapshot.ts');
    expect(() => check(src)).not.toThrow();
    // negative control: the same source with the call moved after the selectors
    const moved = src.replace("await ensurePublishedValuesCurrent(userId, ctx.client, 'dashboard_read');", '').replace('return { status: \'ok\', userId, fx: ctx.fx, window: ctx.window, ledger: ledgerSection, income', "await ensurePublishedValuesCurrent(userId, ctx.client, 'dashboard_read');\n  return { status: 'ok', userId, fx: ctx.fx, window: ctx.window, ledger: ledgerSection, income");
    expect(() => check(moved)).toThrow(/RULE WIRE-1: the re-mark must run before the investments selector/);
  });

  it('the Investments list API, the published-valuations API and the report resolver re-mark first', () => {
    expect(read('app/api/investments/route.ts')).toMatch(/ensurePublishedValuesCurrent\(user\.id, await createClient\(\), 'investments_read'\);\s+const \{ data, error \} = await registry\.list/);
    expect(read('app/api/investments/published-valuations/route.ts')).toMatch(/ensurePublishedValuesCurrent\(user\.id, supabase, 'investments_read'\);\s+const investments = await selectInvestments/);
    const resolver = read('lib/services/reportSnapshotResolver.ts');
    expect(resolver.indexOf("ensurePublishedValuesCurrent(userId, supabase, 'report_read')")).toBeGreaterThan(0);
    expect(resolver.indexOf("ensurePublishedValuesCurrent(userId, supabase, 'report_read')")).toBeLessThan(resolver.indexOf('const [dashboard, canonicalSnapshot'));
  });

  it('the re-mark service never inserts into investments and never writes the publication table', () => {
    const check = (src: string) => {
      const code = src.replace(/\/\/[^\n]*/g, '');
      if (/from\('investments'\)\s*\.insert\(/.test(code)) throw new Error("RULE WIRE-2: the re-mark must never insert into 'investments'");
      if (/from\('ii_fhip_publications'\)[\s\S]{0,300}?\.(update|insert|delete|upsert)\(/.test(code)) throw new Error("RULE WIRE-2: the re-mark must never write 'ii_fhip_publications'");
    };
    const src = read('lib/services/investment-intelligence/publishedValueRemark.ts');
    expect(() => check(src)).not.toThrow();
    expect(() => check(`${src}\nawait client.from('investments').insert({});`)).toThrow(/WIRE-2: the re-mark must never insert/);
    expect(() => check(`${src}\nawait client.from('ii_fhip_publications').update({ published_value: 1 });`)).toThrow(/WIRE-2: the re-mark must never write 'ii_fhip_publications'/);
  });

  it('the re-mark reads only II-published rows, with the compare-and-set guard, and shares the ONE valuation rule', () => {
    const src = read('lib/services/investment-intelligence/publishedValueRemark.ts');
    expect(src).toContain(".eq('source_type', 'investment_intelligence_published')");
    expect(src).toMatch(/is\('ii_valuation_fingerprint', null\)/);
    expect(src).toContain('loadUnitMovementsSince');
    const planner = read('lib/engines/investment-intelligence/valuation/publishedRowRemark.ts');
    expect(planner).toContain('valueHoldingAsOf({');
    // no second NAV rule: the planner never inspects NAV quality, currency or dates itself
    expect(planner).not.toMatch(/quality_?status\s*(===|!==)/i);
    expect(planner).not.toMatch(/currencyCode\s*(===|!==)\s*\w+\.currencyCode/);
  });

  it('no caching layer sits between the register and Net Worth (nothing to invalidate)', () => {
    for (const f of ['lib/services/dashboardData.ts', 'lib/read-models/snapshot.ts', 'lib/read-models/investments.ts', 'lib/services/investment-intelligence/publishedValueRemark.ts']) {
      expect(read(f)).not.toMatch(/unstable_cache|revalidate(Path|Tag)|cache:\s*['"]force-cache/);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Read model and fail-soft behaviour
// ---------------------------------------------------------------------------
describe('read model: deployment-order safety and fail-soft', () => {
  const inv = (id: string, value: number, extra: Record<string, unknown> = {}) => ({
    id, user_id: USER, investment_name: id, investment_type: 'managed_fund', current_value: value, currency_code: 'AUD', owner: 'self',
    master_item_key: null, source_type: 'manual', ii_canonical_account_id: null, ii_canonical_instrument_id: null, is_active: true, ...extra,
  });
  const data = () => tables(profile(), { investments: [inv('m', 5000), inv('p', 8000, { source_type: 'investment_intelligence_published', ii_canonical_account_id: 'a', ii_canonical_instrument_id: 'i' })], ii_holding_snapshots: [], ii_fhip_publications: [] });

  it('before migration 0240 is applied the register still reads (legacy column list): Net Worth does not go offline', async () => {
    const { client } = makeFakeSupabase(data(), { missingColumns: { investments: ['ii_value_as_of', 'ii_valuation_basis', 'ii_valuation_units', 'ii_valuation_nav'] } });
    const res = await selectInvestments(USER, { client });
    expect(res.status).toBe('ok');
    if (res.status === 'ok') {
      expect(res.publishedTotal).toBe(13000);
      expect(res.lines.every((l) => l.valuation === undefined)).toBe(true);
    }
  });

  it('a GENUINE failure is not masked by the fallback: a missing base column is still reported unavailable', async () => {
    const { client } = makeFakeSupabase(data(), { missingColumns: { investments: ['current_value'] } });
    expect((await selectInvestments(USER, { client })).status).toBe('unavailable');
  });

  it('the fail-soft entry never throws, even when the client itself throws', async () => {
    const summary = await ensurePublishedValuesCurrent(USER, { from: () => { throw new Error('connection reset'); } }, 'dashboard_read');
    expect(summary.error).toBeTruthy();
    expect(summary.updated).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Dashboard disclosure and the Investments table
// ---------------------------------------------------------------------------
const status = (publishedValuation: DashboardDataStatus['publishedValuation']): DashboardDataStatus => ({
  basis: 'canonical_read_models', unavailable: [], unconverted: { count: 0, byCurrency: {} }, netIncomeUnknownComponents: 0, netIncomeBasis: 'net',
  grossIncomeIncludesNetFloor: false, costOfDebtMonthly: 0, window: null, importedNotInNetWorth: null, bankBalanceEvidence: null, publishedValuation,
  retirementContributionFrequencyUnknown: 0, possibleDuplicateIncomeCount: 0, unknownPendingCount: 0,
});
const html = (s: DashboardDataStatus) => renderToStaticMarkup(React.createElement(DashboardDataStatusNotice, { status: s, currency: 'INR' }));

describe('Dashboard: how the mutual funds in Net Worth were valued is disclosed with their as-of dates', () => {
  it('names the NAV date range, the statement-value funds and the stale ones', () => {
    const out = html(status({ count: 3, marketNavCount: 2, statementCount: 1, redeemedCount: 0, staleCount: 1, oldestAsOf: '2026-09-25', latestAsOf: '2026-09-30' }));
    expect(out).toContain('Mutual funds in your Net Worth: 2 at the latest NAV dated 2026-09-25 to 2026-09-30, 1 at a statement value (no newer NAV on file).');
    expect(out).toContain('1 is valued on a NAV or statement more than a week old and may be out of date.');
  });
  it('a single date reads "dated <date>"; redeemed funds are disclosed as counted 0', () => {
    const out = html(status({ count: 2, marketNavCount: 1, statementCount: 0, redeemedCount: 1, staleCount: 0, oldestAsOf: '2026-09-30', latestAsOf: '2026-09-30' }));
    expect(out).toContain('1 at the latest NAV dated 2026-09-30, 1 redeemed (counted as 0).');
  });
  it('NEGATIVE CONTROL: with no published funds the notice says nothing about NAV valuation', () => {
    expect(html(status(null))).not.toContain('Mutual funds in your Net Worth');
  });
  it('the engine carries the summary through into dataStatus untouched (and Net Worth does not depend on it)', () => {
    const summary = summarisePublishedValuations([{ basis: 'market_nav', asOf: '2026-09-30', units: 100, nav: 112 }], '2026-10-01');
    const canonical = { ...allUnavailableCashFlow({ status: 'unavailable', reason: 'x', source: 'y' }), publishedValuation: summary };
    const empty: DashboardInput = { income: [], expenses: [], assets: [], liabilities: [], investments: [{ current_value: 11200, cost_base: null, investment_type: 'managed_fund', master_item_key: 'managed_funds', country_code: 'IN', annual_contribution: null, institution: 'A', currency_code: 'INR' }], retirement: [], insurance: [], goals: [], snapshots: [], canonical };
    const d = computeDashboard(empty, 'INR', 56);
    expect(d.dataStatus?.publishedValuation).toEqual(summary);
    expect(d.netWorth).toBe(11200);
  });
});

describe('Investments tab: each published fund shows value, units, NAV, NAV date and its tag', () => {
  const line = (id: string, value: number, v: Line['valuation']): Line => ({ id, name: `Fund ${id}`, owner: 'self', currency: 'INR', value, valuation: v });
  const render = (lines: Line[]) => renderToStaticMarkup(React.createElement(PublishedFundValuationsTable, { lines }));

  it('latest NAV row: 11,200.00 for 100 units at NAV 112.00 dated 2026-09-30, tagged Latest NAV', () => {
    const out = render([line('a', 11200, { basis: 'market_nav', asOf: '2026-09-30', units: 100, nav: 112, tag: 'latest_nav', label: 'Latest NAV', stale: false, ageDays: 1 })]);
    expect(out).toContain('11,200.00');
    expect(out).toContain('112.00');
    expect(out).toContain('2026-09-30');
    expect(out).toContain('>100<');
    expect(out).toContain('Latest NAV');
    expect(out).not.toContain('Statement value');
  });
  it('statement row: labelled Statement value, never Latest NAV, with the statement date', () => {
    const out = render([line('b', 10000, { basis: 'statement', asOf: '2026-06-30', units: 100, nav: 100, tag: 'statement_value', label: 'Statement value', stale: true, ageDays: 93 })]);
    expect(out).toContain('Statement value');
    expect(out).toContain('2026-06-30');
    expect(out).not.toContain('Latest NAV');
  });
  it('stale and redeemed rows carry their own tags', () => {
    const stale = render([line('c', 11200, { basis: 'market_nav', asOf: '2026-09-10', units: 100, nav: 112, tag: 'stale_nav', label: 'Stale NAV', stale: true, ageDays: 21 })]);
    expect(stale).toContain('Stale NAV');
    expect(stale).toContain('2026-09-10');
    const redeemed = render([line('d', 0, { basis: 'redeemed', asOf: '2026-06-30', units: 0, nav: null, tag: 'redeemed', label: 'Redeemed', stale: false, ageDays: null })]);
    expect(redeemed).toContain('Redeemed');
    expect(redeemed).toContain('—');
  });
  it('the page mounts the panel above the grid and the panel reads the one API route', () => {
    expect(read('app/(app)/investments/page.tsx')).toContain('<PublishedFundValuations refreshKey={gridKey} />');
    expect(read('components/investments/PublishedFundValuations.tsx')).toContain("fetch('/api/investments/published-valuations')");
    expect(existsSync(path.join(ROOT, 'app/api/investments/published-valuations/route.ts'))).toBe(true);
  });
});
