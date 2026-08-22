// R4 — LIVE integration test against DEV Supabase.
//
// Exercises the REAL production code path end to end:
//   loadAnalyticsDataset -> runAnalytics -> toPersistableRows -> persistAnalyticsRows
// against a genuinely seeded portfolio, read through an RLS-respecting
// client authenticated as a real throwaway user.
//
// This is the one thing the REST-level harness cannot cover: that harness
// seeds analytics rows via raw REST with the service role, which never
// touches persistAnalyticsRows() and therefore never validates the upsert's
// onConflict constraint specification.
//
// OPT-IN. Skipped unless II_R4_LIVE=1, so the normal suite stays hermetic:
//   II_R4_LIVE=1 npx vitest run tests/unit/iiR4LiveIntegration.test.ts

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js';

const LIVE = process.env.II_R4_LIVE === '1';
const d = describe.skipIf(!LIVE);

function loadEnv(): Record<string, string> {
  const repoRoot = path.resolve(__dirname, '..', '..');
  for (const p of [path.join(repoRoot, '.env.local'), path.resolve(repoRoot, '..', '..', '..', '.env.local')]) {
    if (fs.existsSync(p)) {
      const env: Record<string, string> = {};
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m) env[m[1]] = m[2].trim();
      }
      return env;
    }
  }
  throw new Error('No .env.local found');
}

const stamp = Date.now();
const state: {
  env: Record<string, string>;
  userId: string;
  userClient: SupabaseClient;
  admin: SupabaseClient;
  instrumentIds: string[];
  benchmarkId: string;
  accountId: string;
} = {} as never;

async function seed() {
  const { admin, userId } = state;

  const { data: bench, error: bErr } = await admin
    .from('ii_benchmarks')
    .insert({ benchmark_key: `R4LIVE_${stamp}`, benchmark_label: 'R4 live test', benchmark_category: 'index', country_code: 'IN', return_type: 'TRI' })
    .select('id')
    .single();
  if (bErr) throw new Error(`benchmark: ${bErr.message}`);
  state.benchmarkId = bench!.id as string;

  // 36 month-end benchmark points at 0.7%/mo.
  const series: Array<Record<string, unknown>> = [];
  let level = 100;
  for (let i = 0; i < 36; i++) {
    series.push({
      benchmark_id: state.benchmarkId,
      series_date: new Date(Date.UTC(2021, i + 1, 0)).toISOString().slice(0, 10),
      value: level.toFixed(6),
      quality_status: 'ok',
    });
    level *= 1.007;
  }
  const { error: sErr } = await admin.from('ii_benchmark_series').insert(series);
  if (sErr) throw new Error(`series: ${sErr.message}`);

  const { data: acct, error: aErr } = await admin
    .from('ii_accounts')
    .insert({ user_id: userId, country_code: 'IN', currency_code: 'INR', account_type: 'mf_folio', institution_name: 'R4 Live AMC', folio_number: `L-${stamp}` })
    .select('id')
    .single();
  if (aErr) throw new Error(`account: ${aErr.message}`);
  state.accountId = acct!.id as string;

  const { data: inst, error: iErr } = await admin
    .from('ii_instruments')
    .insert({ instrument_name: `R4 Live Fund ${stamp}`, instrument_class: 'mutual_fund', country_of_domicile: 'IN', base_currency: 'INR', status: 'verified' })
    .select('id')
    .single();
  if (iErr) throw new Error(`instrument: ${iErr.message}`);
  const instrumentId = inst!.id as string;
  state.instrumentIds = [instrumentId];

  await admin.from('ii_instrument_benchmarks').insert({
    instrument_id: instrumentId,
    benchmark_id: state.benchmarkId,
    relationship_type: 'primary',
    effective_from: '1900-01-01',
    mapping_version: 'r4live-v1',
    quality_status: 'ok',
  });

  // 36 month-end NAV points and matching valuation snapshots at ~1%/mo,
  // with enough observations for the 12-observation risk minimums.
  const navs: Array<Record<string, unknown>> = [];
  const snaps: Array<Record<string, unknown>> = [];
  let nav = 100;
  for (let i = 0; i < 36; i++) {
    const date = new Date(Date.UTC(2021, i + 1, 0)).toISOString().slice(0, 10);
    navs.push({ instrument_id: instrumentId, currency_code: 'INR', price_date: date, price: nav.toFixed(6), quality_status: 'ok' });
    snaps.push({
      user_id: userId,
      account_id: state.accountId,
      instrument_id: instrumentId,
      currency_code: 'INR',
      as_of_date: date,
      units: '1000.000000',
      value: (nav * 1000).toFixed(2),
      quality_status: 'certified',
    });
    // Alternating up/down months so volatility and drawdown are non-degenerate.
    nav *= i % 4 === 0 ? 0.985 : 1.018;
  }
  const { error: nErr } = await admin.from('ii_prices_nav').insert(navs);
  if (nErr) throw new Error(`nav: ${nErr.message}`);
  const { error: hErr } = await admin.from('ii_holding_snapshots').insert(snaps);
  if (hErr) throw new Error(`snapshots: ${hErr.message}`);

  await admin.from('ii_transactions').insert({
    user_id: userId,
    account_id: state.accountId,
    instrument_id: instrumentId,
    currency_code: 'INR',
    transaction_type: 'purchase',
    transaction_date: '2021-01-31',
    gross_amount: '100000.00',
    units: '1000.000000',
    status: 'reconciled',
  });

  await admin.from('ii_portfolio_truth_status').insert({
    user_id: userId,
    account_id: state.accountId,
    instrument_id: instrumentId,
    status: 'certified',
    history_completeness: 'complete_from_inception',
  });
}

d('R4 live integration — real code path against DEV', () => {
  beforeAll(async () => {
    state.env = loadEnv();
    process.env.NEXT_PUBLIC_SUPABASE_URL = state.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = state.env.SUPABASE_SERVICE_ROLE_KEY;

    state.admin = createSupabaseClient(state.env.NEXT_PUBLIC_SUPABASE_URL, state.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const email = `ii-r4-live-${stamp}@fhip-test.local`;
    const password = `TestPass!${stamp}`;
    const { data: created, error } = await state.admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(`createUser: ${error.message}`);
    state.userId = created.user!.id;

    const anonClient = createSupabaseClient(state.env.NEXT_PUBLIC_SUPABASE_URL, state.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: signIn, error: siErr } = await anonClient.auth.signInWithPassword({ email, password });
    if (siErr) throw new Error(`signIn: ${siErr.message}`);

    // RLS-respecting client bound to the real user's access token — the same
    // posture the API route's request client has.
    state.userClient = createSupabaseClient(state.env.NEXT_PUBLIC_SUPABASE_URL, state.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${signIn.session!.access_token}` } },
    });

    await seed();
  }, 120_000);

  afterAll(async () => {
    if (!state.admin) return;
    const { admin } = state;
    await admin.from('ii_analytics_results').delete().eq('user_id', state.userId);
    for (const id of state.instrumentIds ?? []) {
      await admin.from('ii_prices_nav').delete().eq('instrument_id', id);
      await admin.from('ii_instrument_benchmarks').delete().eq('instrument_id', id);
      await admin.from('ii_portfolio_truth_status').delete().eq('instrument_id', id);
      await admin.from('ii_transactions').delete().eq('instrument_id', id);
      await admin.from('ii_holding_snapshots').delete().eq('instrument_id', id);
      await admin.from('ii_instruments').delete().eq('id', id);
    }
    if (state.benchmarkId) {
      await admin.from('ii_benchmark_series').delete().eq('benchmark_id', state.benchmarkId);
      await admin.from('ii_benchmarks').delete().eq('id', state.benchmarkId);
    }
    if (state.accountId) await admin.from('ii_accounts').delete().eq('id', state.accountId);
    if (state.userId) await admin.auth.admin.deleteUser(state.userId);
  }, 120_000);

  it('LIVE-INT-001: loads a real dataset through the RLS-respecting client', async () => {
    const { loadAnalyticsDataset } = await import('@/lib/services/investment-intelligence/analyticsRepository');
    const { dataset, warnings, empty } = await loadAnalyticsDataset(state.userClient, state.userId);
    expect(empty).toBe(false);
    expect(dataset).not.toBeNull();
    expect(dataset!.schemes).toHaveLength(1);
    expect(dataset!.schemes[0].navSeries.length).toBe(36);
    expect(dataset!.schemes[0].valuationSeries.length).toBe(36);
    expect(dataset!.mappings).toHaveLength(1);
    // Risk-free reference data is now seeded, so no risk-free warning.
    expect(warnings.find((w) => w.scope === 'risk_free')).toBeUndefined();
    expect(dataset!.riskFreeSeries.length).toBeGreaterThan(0);
  }, 60_000);

  it('LIVE-INT-002: risk-free-dependent metrics COMPUTE live instead of suppressing', async () => {
    const { loadAnalyticsDataset } = await import('@/lib/services/investment-intelligence/analyticsRepository');
    const { runAnalytics } = await import('@/lib/engines/investment-intelligence/analyticsOrchestrator');
    const { dataset } = await loadAnalyticsDataset(state.userClient, state.userId);
    const rs = runAnalytics(dataset!);
    const p = rs.portfolios[0];

    expect(p.risk.riskFree.status).toBe('ok');
    expect(p.risk.riskFree.version).toBe('dev-seed-v1');
    // The three metrics that were correctly suppressed before the seed.
    expect(p.risk.sharpeRatio.status).toBe('CALCULATED');
    expect(p.risk.sortinoRatio.status).toBe('CALCULATED');
    expect(p.risk.alpha.status).toBe('CALCULATED');
    expect(Number.isFinite(p.risk.sharpeRatio.value!.sharpe)).toBe(true);
    expect(Number.isFinite(p.risk.alpha.value!.alphaAnnualised)).toBe(true);
    // Benchmark-relative metrics compute too, since a mapping + series exist.
    expect(p.risk.beta.status).toBe('CALCULATED');
    expect(p.risk.trackingError.status).toBe('CALCULATED');
  }, 60_000);

  it('LIVE-INT-003: persists through the real code path and is idempotent on re-run', async () => {
    const { loadAnalyticsDataset, persistAnalyticsRows } = await import('@/lib/services/investment-intelligence/analyticsRepository');
    const { runAnalytics, toPersistableRows } = await import('@/lib/engines/investment-intelligence/analyticsOrchestrator');

    const { dataset } = await loadAnalyticsDataset(state.userClient, state.userId);
    const rows = toPersistableRows(state.userId, runAnalytics(dataset!), dataset!);
    expect(rows.length).toBeGreaterThan(0);

    // This is the assertion the REST harness could not make: the upsert's
    // onConflict column list must actually match the table's unique index.
    const first = await persistAnalyticsRows(state.userId, rows);
    expect(first.persisted).toBe(rows.length);

    const { count: afterFirst } = await state.admin
      .from('ii_analytics_results')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', state.userId);
    expect(afterFirst).toBe(rows.length);

    // Re-running with identical inputs must not duplicate: same fingerprint,
    // same engine version, so the unique constraint absorbs it.
    await persistAnalyticsRows(state.userId, rows);
    const { count: afterSecond } = await state.admin
      .from('ii_analytics_results')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', state.userId);
    expect(afterSecond).toBe(afterFirst);
  }, 90_000);

  it('LIVE-INT-004: persisted rows carry full versioning and record unavailability honestly', async () => {
    const { data } = await state.admin
      .from('ii_analytics_results')
      .select('metric_key, quality_status, quality_reason, engine_version, input_snapshot_version, nav_data_version, benchmark_mapping_version, risk_free_version, result_value')
      .eq('user_id', state.userId);

    expect((data ?? []).length).toBeGreaterThan(0);
    for (const row of data ?? []) {
      expect(row.engine_version).toBeTruthy();
      expect(String(row.input_snapshot_version)).toMatch(/^[0-9a-f]{64}$/);
      expect(['ok', 'unavailable', 'stale']).toContain(row.quality_status);
      if (row.quality_status === 'unavailable') {
        expect(row.quality_reason).toBeTruthy();
        expect((row.result_value as { value: unknown }).value).toBeNull();
      }
    }

    // Sharpe specifically must be persisted as a real value with its
    // risk-free version recorded for traceability.
    const sharpe = (data ?? []).find((r) => r.metric_key === 'sharpe_ratio');
    expect(sharpe).toBeDefined();
    expect(sharpe!.quality_status).toBe('ok');
    expect(sharpe!.risk_free_version).toBe('dev-seed-v1');
  }, 60_000);

  it('LIVE-INT-005: the owning user can read their persisted rows; RLS still blocks writes', async () => {
    const { data: own } = await state.userClient.from('ii_analytics_results').select('metric_key').eq('user_id', state.userId);
    expect((own ?? []).length).toBeGreaterThan(0);

    const { error } = await state.userClient.from('ii_analytics_results').insert({
      user_id: state.userId,
      scope_type: 'portfolio',
      scope_id: 'currency:INR',
      metric_key: 'portfolio_twrr',
      metric_version: 'forged',
      engine_version: 'forged',
      data_as_of_date: '2023-12-31',
      input_snapshot_version: 'f'.repeat(64),
      quality_status: 'ok',
      result_value: { status: 'CALCULATED', value: { twrr: 9.99 } },
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/row-level security/i);
  }, 60_000);
});
