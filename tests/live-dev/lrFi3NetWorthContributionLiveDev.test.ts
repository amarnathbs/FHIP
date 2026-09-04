// LR-FI-3 — NET WORTH FORECAST CONTRIBUTION EXACTLY-ONCE, LIVE HOSTED-DEV.
//
// WHAT THIS SUITE EXISTS TO SETTLE
// --------------------------------
// The unit suite (tests/unit/lrFi3NetWorthContributionExactlyOnce.test.ts)
// proves the ENGINE is correct given a hand-built NetWorthCalculatorInput. It
// cannot prove that the real, currently-deployed read/write path — real
// `income_sources`/`investments`/`retirement_accounts` rows, read back through
// the real `loadDashboard()`, fed through the real `runForecast()` entry
// point (the exact function `app/api/forecast/**` calls), persisted to real
// `forecast_runs`/`forecast_results` rows — produces the corrected number,
// end to end, on data written the way the live grid writes it.
//
// METHOD, mirroring tests/live-dev/lrFi2HouseholdDebtRatiosLiveDev.test.ts:
// two synthetic households are created, `runForecast()` (the real, deployed
// function, unmodified by this test) is called for forecast_type='net_worth'
// over exactly 1 month, and the persisted `forecast_results` row is read back
// and compared against a hand-derived oracle. The PRE-FIX formula is also
// independently reconstructed (by calling the pure `runNetWorthForecast()`
// calculator directly with the old literal, never by editing production
// code) against the SAME real dashboard figures, to prove the fix actually
// changes the number on live data rather than merely in the unit suite.
//
// FIXTURE PROVENANCE: the .env.local parser, the hard DEV-project guard and
// the synthetic-user helper are taken from
// tests/live-dev/lrFi2HouseholdDebtRatiosLiveDev.test.ts, already certified,
// so their behaviour is not re-litigated here.

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js';
import { loadDashboard, type SupabaseServerClient } from '@/lib/services/dashboardData';
import { runForecast } from '@/lib/services/forecastData';
import { runNetWorthForecast } from '@/lib/engines/forecast/netWorthCalculator';
import type { DashboardSummary } from '@/lib/engines/dashboard';

// ---------------------------------------------------------------------------
// Environment + hard DEV guard
// ---------------------------------------------------------------------------
const repoRoot = path.resolve(__dirname, '..', '..');
const envText = fs.readFileSync(path.join(repoRoot, '.env.local'), 'utf8');
const env: Record<string, string> = {};
for (const rawLine of envText.split('\n')) {
  const line = rawLine.replace(/^﻿/, '').trim();
  const m = line.match(/^([A-Za-z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
for (const required of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!env[required]) {
    throw new Error(`INFRASTRUCTURE DEPENDENCY — ${required} is absent from .env.local; live-DEV certification cannot run without it.`);
  }
}
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

const EXPECTED_DEV_REF = 'vqycarelcoijzwlpkpcz';
const actualRef = new URL(BASE).host.split('.')[0];
if (actualRef !== EXPECTED_DEV_REF) {
  throw new Error(`REFUSING TO RUN: target project "${actualRef}" is not the expected DEV project. This suite never touches production.`);
}

const admin = createSupabaseJsClient(BASE, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const adminAsServerClient = admin as unknown as SupabaseServerClient;

const RUN_TAG = `lrfi3-${Date.now()}`;
const cleanupUserIds: string[] = [];

async function makeUser(tag: string): Promise<string> {
  const email = `${RUN_TAG}-${tag}@fhip-synthetic.test`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: `Synthetic!${RUN_TAG}-${tag}`,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`could not create synthetic user ${tag}: ${error?.message}`);
  const userId = data.user.id;
  cleanupUserIds.push(userId);

  // Retried: the hosted DEV project intermittently rejects the first
  // PostgREST call made immediately after auth.admin.createUser() with
  // "JWT issued at future" — a sub-second clock-skew artefact between the
  // auth and REST services, not a behaviour under test (same as LR-FI-2's
  // live-dev suite).
  let lastErr = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const { error: pErr } = await admin
      .from('user_profiles')
      .upsert({ user_id: userId, preferred_currency: 'AUD', country_of_residence: 'AU' }, { onConflict: 'user_id' });
    if (!pErr) return userId;
    lastErr = pErr.message;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`user_profiles upsert failed for ${tag} after 5 attempts: ${lastErr}`);
}

// --- row builders (shapes match lib/grid/configs.ts's live grid writes) -----
const salary = (userId: string, amount: number) => ({
  user_id: userId,
  source_name: 'Salary',
  amount,
  net_amount: amount,
  frequency: 'monthly',
  master_item_key: 'salary_wages',
  income_type: 'salary',
  currency_code: 'AUD',
  owner: 'self',
  is_active: true,
});
const living = (userId: string, amount: number) => ({
  user_id: userId,
  expense_name: 'Living costs',
  amount,
  frequency: 'monthly',
  is_essential: true,
  master_item_key: 'groceries',
  expense_category: 'other',
  currency_code: 'AUD',
  owner: 'self',
  is_active: true,
});
const investmentSip = (userId: string, annualContribution: number) => ({
  user_id: userId,
  investment_name: 'Managed fund SIP',
  investment_type: 'managed_fund',
  current_value: 0,
  annual_contribution: annualContribution,
  currency_code: 'AUD',
  country_code: 'AU',
  owner: 'self',
  is_active: true,
});
const retirementAccount = (userId: string, employerContribution: number, personalContribution: number) => ({
  user_id: userId,
  account_name: 'Super',
  account_type: 'super',
  current_balance: 0,
  employer_contribution: employerContribution,
  personal_contribution: personalContribution,
  contribution_frequency: 'monthly',
  currency_code: 'AUD',
  country_code: 'AU',
  owner: 'self',
  is_active: true,
});

async function insertRows(userId: string, opts: { salaryAmount: number; expenseAmount: number; investmentAnnualContribution?: number; employerContribution?: number; personalContribution?: number }) {
  const ins = async (table: string, rows: Record<string, unknown>[]) => {
    const { error } = await admin.from(table).insert(rows);
    if (error) throw new Error(`${table} insert failed: ${error.message}`);
  };
  await ins('income_sources', [salary(userId, opts.salaryAmount)]);
  await ins('expense_items', [living(userId, opts.expenseAmount)]);
  if (opts.investmentAnnualContribution) await ins('investments', [investmentSip(userId, opts.investmentAnnualContribution)]);
  if (opts.employerContribution !== undefined || opts.personalContribution !== undefined) {
    await ins('retirement_accounts', [retirementAccount(userId, opts.employerContribution ?? 0, opts.personalContribution ?? 0)]);
  }
}

async function runNetWorthAndFetch(userId: string): Promise<{ closingValue: number; contributions: number }> {
  const { run } = await runForecast(userId, { forecastType: 'net_worth', months: 1 }, adminAsServerClient);
  const { data, error } = await admin
    .from('forecast_results')
    .select('closing_value, contributions')
    .eq('forecast_run_id', run.id)
    .eq('period_number', 1)
    .single();
  if (error || !data) throw new Error(`could not read back forecast_results for run ${run.id}: ${error?.message}`);
  return { closingValue: Number(data.closing_value), contributions: Number(data.contributions) };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let dashE: DashboardSummary; // investment-contribution case
let dashF: DashboardSummary; // mixed employer+personal retirement + investment case
let userE: string;
let userF: string;

beforeAll(async () => {
  userE = await makeUser('e-investment');
  userF = await makeUser('f-mixed-retirement');

  // E: $10,000 salary, $6,000 essential living, $12,000/yr ($1,000/mo)
  // investment contribution, no retirement. Hand-derived monthlySurplus =
  // 10,000 - 6,000 = 4,000; householdFundedMonthlyContribution = 1,000.
  await insertRows(userE, { salaryAmount: 10000, expenseAmount: 6000, investmentAnnualContribution: 12000 });

  // F: $10,000 salary, $6,000 essential living, $6,000/yr ($500/mo)
  // investment contribution, $300/mo employer + $700/mo personal retirement
  // contribution. Hand-derived monthlySurplus = 4,000;
  // householdFundedMonthlyContribution = 500 + 700 = 1,200.
  await insertRows(userF, { salaryAmount: 10000, expenseAmount: 6000, investmentAnnualContribution: 6000, employerContribution: 300, personalContribution: 700 });

  dashE = await loadDashboard(userE, adminAsServerClient);
  dashF = await loadDashboard(userF, adminAsServerClient);
}, 180000);

describe('LR-FI-3 live DEV — investment-contribution case', () => {
  it('the real loadDashboard() figures match the hand-derived oracle', () => {
    expect(dashE.monthlySurplus).toBe(4000);
    expect(dashE.investmentAnnualContribution).toBe(12000);
    expect(dashE.retirementPersonalMonthlyContribution).toBe(0);
    expect(dashE.retirementEmployerMonthlyContribution).toBe(0);
  });

  it('NEGATIVE CONTROL — the pre-fix formula, run on these SAME real dashboard figures, would have swept the full $4,000 into assets on top of the $1,000 investment bucket (a $5,000 total)', () => {
    const buggy = runNetWorthForecast({
      baselineDate: '2026-09-01',
      months: 1,
      currency: 'AUD',
      openingAssets: 0,
      openingInvestments: 0,
      openingRetirement: 0,
      openingLiabilities: 0,
      monthlyAssetContribution: Math.max(0, dashE.monthlySurplus), // the pre-fix literal
      monthlyInvestmentContribution: dashE.investmentAnnualContribution / 12,
      monthlyRetirementContribution: dashE.retirementEmployerMonthlyContribution + dashE.retirementPersonalMonthlyContribution,
      monthlyLoanRepayment: 0,
      assumptions: {},
    });
    expect(buggy.results[0].contributions).toBe(5000);
  });

  it('the REAL deployed runForecast() end-to-end persists the corrected $4,000 total, not $5,000', async () => {
    const { contributions } = await runNetWorthAndFetch(userE);
    // == monthlySurplus exactly (no employer contribution in this fixture).
    expect(contributions).toBe(dashE.monthlySurplus);
    expect(contributions).toBe(4000);
    expect(contributions).not.toBe(5000);
  });
});

describe('LR-FI-3 live DEV — mixed employer+personal retirement + investment case', () => {
  it('the real loadDashboard() figures match the hand-derived oracle', () => {
    expect(dashF.monthlySurplus).toBe(4000);
    expect(dashF.investmentAnnualContribution).toBe(6000);
    expect(dashF.retirementEmployerMonthlyContribution).toBe(300);
    expect(dashF.retirementPersonalMonthlyContribution).toBe(700);
  });

  it('NEGATIVE CONTROL — the pre-fix formula on these real figures would have credited $5,500, not $4,300', () => {
    const buggy = runNetWorthForecast({
      baselineDate: '2026-09-01',
      months: 1,
      currency: 'AUD',
      openingAssets: 0,
      openingInvestments: 0,
      openingRetirement: 0,
      openingLiabilities: 0,
      monthlyAssetContribution: Math.max(0, dashF.monthlySurplus), // the pre-fix literal: 4,000
      monthlyInvestmentContribution: dashF.investmentAnnualContribution / 12, // 500
      monthlyRetirementContribution: dashF.retirementEmployerMonthlyContribution + dashF.retirementPersonalMonthlyContribution, // 1,000
      monthlyLoanRepayment: 0,
      assumptions: {},
    });
    expect(buggy.results[0].contributions).toBe(5500); // 4,000 + 500 + 1,000
  });

  it('the REAL deployed runForecast() end-to-end persists exactly monthlySurplus + the employer contribution — $4,300, never $5,500', async () => {
    const { contributions } = await runNetWorthAndFetch(userF);
    expect(contributions).toBe(dashF.monthlySurplus + dashF.retirementEmployerMonthlyContribution);
    expect(contributions).toBe(4300);
    expect(contributions).not.toBe(5500);
  });
});

// ---------------------------------------------------------------------------
// Cleanup — every table this suite wrote, plus financial_snapshots and the
// forecast_* tables, which loadDashboard()/runForecast() write as a side
// effect of every call above. Independently re-verified rather than trusted.
// ---------------------------------------------------------------------------
const WRITTEN_TABLES = [
  'forecast_results',
  'forecast_explanations',
  'forecast_runs',
  'forecast_scenarios',
  'forecast_profiles',
  'financial_snapshots',
  'retirement_accounts',
  'investments',
  'expense_items',
  'income_sources',
  'user_profiles',
];

afterAll(async () => {
  for (const userId of cleanupUserIds) {
    for (const table of WRITTEN_TABLES) {
      await admin.from(table).delete().eq('user_id', userId);
    }
    await admin.auth.admin.deleteUser(userId);
  }

  // Independently re-verify zero residue rather than trusting the deletes.
  for (const userId of cleanupUserIds) {
    for (const table of WRITTEN_TABLES) {
      const { count, error } = await admin.from(table).select('*', { count: 'exact', head: true }).eq('user_id', userId);
      if (error) throw new Error(`residue check failed on ${table}: ${error.message}`);
      if ((count ?? 0) !== 0) throw new Error(`RESIDUE: ${count} row(s) left in ${table} for ${userId}`);
    }
    const { data: stillThere } = await admin.auth.admin.getUserById(userId);
    if (stillThere?.user) throw new Error(`RESIDUE: auth user ${userId} was not deleted`);
  }
}, 120000);
