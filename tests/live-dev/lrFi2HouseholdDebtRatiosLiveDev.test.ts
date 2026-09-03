// LR-FI-2 — HOUSEHOLD/SMSF DEBT RATIOS, LIVE HOSTED-DEV.
//
// WHAT THIS SUITE EXISTS TO SETTLE
// --------------------------------
// The unit suite (tests/unit/lrFi2HouseholdDebtRatios.test.ts) proves the
// ENGINE is correct given an input object. It cannot prove the two things
// that only real rows in the real database can settle:
//
//   1. That the production READ PATH actually carries the `owner` column far
//      enough for the rule to fire. `computeDashboard()` treats a missing
//      owner as household context (the LR-FI-1 fail-safe), so a SELECT that
//      silently dropped `owner` would make every unit test still pass while
//      the live product reverted to the pre-fix, mixed-entity DTI. This suite
//      therefore goes through `loadDashboard()` — the real function the
//      dashboard, reports, twin and forecasts all use — never a hand-built
//      DashboardInput.
//
//   2. That the correction is measurable end-to-end on rows written the way
//      the live grid writes them, and that it does NOT move Net Worth.
//
// METHOD — every scenario is a matched triple, so nothing here can pass
// vacuously:
//   A  personal-only                      the control
//   B  A's rows + a real SMSF liability   must EQUAL A on DTI/DSR,
//                                         must DIFFER from A on Net Worth
//   C  B's rows with owner retagged 'self' must DIFFER from B on DTI
//                                         (reproduces the pre-fix behaviour)
// Expected values are hand-derived from the amounts inserted, never read back
// from the engine.
//
// FIXTURE PROVENANCE: the .env.local parser, the hard DEV-project guard and
// the synthetic-user helper are taken from
// tests/live-dev/iiPc2WorkspaceLiveDev.test.ts, which is already certified,
// so their behaviour is not re-litigated here.

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js';
import { loadDashboard, type SupabaseServerClient } from '@/lib/services/dashboardData';
import { runNetWorthForecast } from '@/lib/engines/forecast/netWorthCalculator';
import { SMSF_OWNER } from '@/lib/engines/householdContext';
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
// loadDashboard() only ever calls .from()/.select() on this client, so the
// service-role supabase-js client stands in for the cookie-session server
// client the app uses. The read path under test is byte-identical.
const adminAsServerClient = admin as unknown as SupabaseServerClient;

const RUN_TAG = `lrfi2-${Date.now()}`;
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
  // auth and REST services, not a behaviour under test.
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
const salary = (userId: string) => ({
  user_id: userId,
  source_name: 'Salary',
  amount: 8000,
  net_amount: 8000,
  frequency: 'monthly',
  master_item_key: 'salary_wages',
  income_type: 'salary',
  currency_code: 'AUD',
  owner: 'self',
  is_active: true,
});
const living = (userId: string) => ({
  user_id: userId,
  expense_name: 'Living costs',
  amount: 2500,
  frequency: 'monthly',
  is_essential: true,
  master_item_key: 'groceries',
  expense_category: 'other',
  currency_code: 'AUD',
  owner: 'self',
  is_active: true,
});
const personalMortgage = (userId: string) => ({
  user_id: userId,
  liability_name: 'Home loan',
  balance: 400000,
  interest_rate: 6,
  monthly_repayment: 3000,
  debt_type: 'mortgage',
  master_item_key: 'home_loan',
  currency_code: 'AUD',
  country_code: 'AU',
  owner: 'joint',
  is_active: true,
});
const smsfLoan = (userId: string, owner: string) => ({
  user_id: userId,
  liability_name: 'SMSF property loan',
  balance: 365000,
  interest_rate: 6,
  monthly_repayment: 2000,
  debt_type: 'mortgage',
  master_item_key: 'investment_loan',
  currency_code: 'AUD',
  country_code: 'AU',
  owner,
  is_active: true,
});

async function insertAll(userId: string, opts: { smsf: 'none' | 'tagged' | 'retagged' }) {
  const ins = async (table: string, rows: Record<string, unknown>[]) => {
    const { error } = await admin.from(table).insert(rows);
    if (error) throw new Error(`${table} insert failed: ${error.message}`);
  };
  await ins('income_sources', [salary(userId)]);
  await ins('expense_items', [living(userId)]);
  const liabilities: Record<string, unknown>[] = [personalMortgage(userId)];
  if (opts.smsf === 'tagged') liabilities.push(smsfLoan(userId, SMSF_OWNER));
  if (opts.smsf === 'retagged') liabilities.push(smsfLoan(userId, 'self'));
  await ins('liabilities', liabilities);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
let A: DashboardSummary; // personal-only control
let B: DashboardSummary; // personal + SMSF, correctly tagged  (the fix)
let C: DashboardSummary; // same rows retagged personal        (pre-fix behaviour)

beforeAll(async () => {
  // Sequential, not Promise.all — see the retry note in makeUser().
  const ua = await makeUser('a-personal');
  const ub = await makeUser('b-smsf');
  const uc = await makeUser('c-retagged');
  await insertAll(ua, { smsf: 'none' });
  await insertAll(ub, { smsf: 'tagged' });
  await insertAll(uc, { smsf: 'retagged' });
  A = await loadDashboard(ua, adminAsServerClient);
  B = await loadDashboard(ub, adminAsServerClient);
  C = await loadDashboard(uc, adminAsServerClient);
}, 120000);

// Hand-derived from the inserted amounts. Gross 8,000/mo = 96,000/yr.
const ANNUAL_GROSS = 96000;
const PERSONAL_BALANCE = 400000;
const SMSF_BALANCE = 365000;

describe('LR-FI-2 live DEV — the production read path carries `owner` into DTI', () => {
  it('B (SMSF-tagged) reports the household-only DTI, hand-derived', () => {
    expect(B.debtToIncome).toBeCloseTo(PERSONAL_BALANCE / ANNUAL_GROSS, 10);
    expect(B.householdLiabilityBalance).toBe(PERSONAL_BALANCE);
  });

  it('B equals the SMSF-free control A on every household debt ratio', () => {
    expect(B.debtToIncome).toBe(A.debtToIncome);
    expect(B.debtServiceRatio).toBe(A.debtServiceRatio);
    expect(B.debtMonthlyRepayments).toBe(A.debtMonthlyRepayments);
    expect(B.householdLiabilityBalance).toBe(A.householdLiabilityBalance);
    expect(B.monthlySurplus).toBe(A.monthlySurplus);
  });

  it('NEGATIVE CONTROL — C (same rows, owner=self) genuinely differs, so the filter is doing work', () => {
    expect(C.debtToIncome).toBeCloseTo((PERSONAL_BALANCE + SMSF_BALANCE) / ANNUAL_GROSS, 10);
    expect(C.debtToIncome).not.toBe(B.debtToIncome);
    expect(C.householdLiabilityBalance).toBe(PERSONAL_BALANCE + SMSF_BALANCE);
    // ...and the correction crosses a real benchmark band on live data.
    // The debt_to_income ratio's own bands: <3x good, <5x caution, else risk.
    // B = 400,000/96,000 = 4.17x -> caution. C = 765,000/96,000 = 7.97x -> risk.
    const band = (d: DashboardSummary) => d.ratios.find((r) => r.key === 'debt_to_income')?.status;
    expect(band(B)).toBe('caution');
    expect(band(C)).toBe('risk');
  });

  it('SMSF wealth is untouched — Net Worth still differs from the control (LR-FI-1 §28)', () => {
    expect(B.totalLiabilities).toBe(PERSONAL_BALANCE + SMSF_BALANCE);
    expect(A.totalLiabilities).toBe(PERSONAL_BALANCE);
    expect(B.netWorth).not.toBe(A.netWorth);
    // B and C hold the identical balance sheet — only the ratio differs.
    expect(B.totalLiabilities).toBe(C.totalLiabilities);
    expect(B.netWorth).toBe(C.netWorth);
    expect(B.goodDebt).toBe(C.goodDebt);
    expect(B.badDebt).toBe(C.badDebt);
  });
});

describe('LR-FI-2 live DEV — §6c wealth-side amortisation on real rows', () => {
  it('exposes the all-owner repayment total distinctly from the household one', () => {
    expect(B.debtMonthlyRepayments).toBe(3000);
    expect(B.totalLiabilityMonthlyRepayments).toBe(5000);
    // Equal for the household with no SMSF rows.
    expect(A.totalLiabilityMonthlyRepayments).toBe(A.debtMonthlyRepayments);
  });

  it('the live household would have projected debt COMPOUNDING UPWARD before this fix', () => {
    const project = (repayment: number) => {
      const r = runNetWorthForecast({
        baselineDate: '2026-09-01',
        months: 12,
        currency: 'AUD',
        openingAssets: 0,
        openingInvestments: 0,
        openingRetirement: 0,
        openingLiabilities: B.totalLiabilities,
        monthlyAssetContribution: 0,
        monthlyInvestmentContribution: 0,
        monthlyRetirementContribution: 0,
        monthlyLoanRepayment: repayment,
        assumptions: {},
      });
      return r.results[r.results.length - 1].metadata!.liabilities as number;
    };
    // Pre-fix pairing: whole balance, household-only repayment.
    expect(project(B.debtMonthlyRepayments)).toBeGreaterThan(B.totalLiabilities);
    // Post-fix pairing: whole balance, whole repayment.
    expect(project(B.totalLiabilityMonthlyRepayments)).toBeLessThan(B.totalLiabilities);
  });
});

// ---------------------------------------------------------------------------
// Cleanup — every table this suite wrote, plus financial_snapshots, which
// loadDashboard() upserts as a side effect of every call above.
// ---------------------------------------------------------------------------
afterAll(async () => {
  for (const userId of cleanupUserIds) {
    await admin.from('financial_snapshots').delete().eq('user_id', userId);
    await admin.from('liabilities').delete().eq('user_id', userId);
    await admin.from('expense_items').delete().eq('user_id', userId);
    await admin.from('income_sources').delete().eq('user_id', userId);
    await admin.from('user_profiles').delete().eq('user_id', userId);
    await admin.auth.admin.deleteUser(userId);
  }

  // Independently re-verify zero residue rather than trusting the deletes.
  for (const userId of cleanupUserIds) {
    for (const table of ['financial_snapshots', 'liabilities', 'expense_items', 'income_sources', 'user_profiles']) {
      const { count, error } = await admin.from(table).select('*', { count: 'exact', head: true }).eq('user_id', userId);
      if (error) throw new Error(`residue check failed on ${table}: ${error.message}`);
      if ((count ?? 0) !== 0) throw new Error(`RESIDUE: ${count} row(s) left in ${table} for ${userId}`);
    }
    const { data: stillThere } = await admin.auth.admin.getUserById(userId);
    if (stillThere?.user) throw new Error(`RESIDUE: auth user ${userId} was not deleted`);
  }
}, 120000);
