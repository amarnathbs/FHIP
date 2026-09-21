/**
 * ORACLE 2 — Net Worth treatment of an SMSF property loan, exercised through the
 * REAL user journey (Summary mode -> $0-variance gate -> Detailed mode), against
 * the REAL DEV database and the REAL engines.
 *
 * The architecture REQUIRES the SMSF property loan to exist as a row in the
 * personal `liabilities` register: smsf_linked_loans_total_aud() (migration 0084)
 * joins property_liability_links -> liabilities. So the same loan is
 *   (a) subtracted inside the fund's net value, which is written to
 *       retirement_accounts.current_balance, AND
 *   (b) present in `liabilities`, which computeDashboard() subtracts again.
 *
 * Ground truth for this household: one property worth 500,000 inside the fund,
 * financed by a 365,000 limited-recourse loan, nothing else.
 *   Correct Net Worth = 500,000 - 365,000 = 135,000.
 *
 * DEV ONLY. Disposable synthetic users, deleted at the end.
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

function loadEnv() {
  const p = path.resolve(process.cwd(), '.env.local');
  const env: Record<string, string> = {};
  for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/^﻿/, '').replace(/\r/g, '');
    const m = line.match(/^([A-Za-z_0-9]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnv();
process.env.NEXT_PUBLIC_SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const created: string[] = [];
async function makeUser(tag: string) {
  const email = `lr-audit-${tag}-${Date.now()}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: `Aud!t${Date.now()}x`, email_confirm: true });
  if (error) throw new Error(`createUser: ${error.message}`);
  const uid = data.user!.id;
  created.push(uid);
  const now = new Date().toISOString();
  await admin.from('user_profiles').update({
    full_name: `LR Audit ${tag}`, country_of_residence: 'AU', preferred_currency: 'AUD', onboarding_completed: true,
    country_confirmed_at: now, country_source: 'USER_CONFIRMED', country_updated_at: now,
    primary_country: 'AU', primary_country_set_at: now, primary_country_source: 'USER_CONFIRMED',
  }).eq('user_id', uid);
  return uid;
}
async function ins(table: string, row: Record<string, unknown>) {
  const { data, error } = await admin.from(table).insert(row).select('*').single();
  if (error) throw new Error(`insert ${table}: ${error.message}`);
  return data as Record<string, unknown>;
}
async function dash(userId: string) {
  const { loadDashboard } = await import('../../lib/services/dashboardData');
  return await loadDashboard(userId, admin as never);
}
async function twin(userId: string) {
  const mod = await import('../../lib/services/twinData');
  return mod;
}
async function cleanup() {
  for (const uid of created) await admin.auth.admin.deleteUser(uid);
  console.log(`\ncleanup: deleted ${created.length} synthetic DEV users`);
}

const GROUND_TRUTH_NET_WORTH = 500000 - 365000; // 135,000

async function main() {
  const uid = await makeUser('nw');

  // --- the fund and its single property, financed by a linked loan -------
  const ra = await ins('retirement_accounts', {
    user_id: uid, account_name: 'SMSF', account_type: 'smsf', master_item_key: 'smsf',
    current_balance: 0, currency_code: 'AUD', country_code: 'AU', owner: 'self', is_active: true,
  });
  const fund = await ins('smsf_funds', {
    user_id: uid, retirement_account_id: ra.id, fund_name: 'Audit SMSF', mode: 'summary',
    summary_balance: 0, currency_code: 'AUD',
  });
  await ins('smsf_holdings', {
    user_id: uid, smsf_fund_id: fund.id, holding_name: 'SMSF residential property',
    holding_type: 'residential_property', holding_class: 'property', value: 500000,
    currency_code: 'AUD', country_code: 'AU', is_active: true,
  });
  const loan = await ins('liabilities', {
    user_id: uid, liability_name: 'SMSF LRBA property loan', debt_type: 'mortgage', balance: 365000,
    monthly_repayment: 2000, currency_code: 'AUD', country_code: 'AU', owner: 'smsf', is_active: true,
  });
  await ins('property_liability_links', {
    user_id: uid, liability_id: loan.id, linked_retirement_id: ra.id, link_type: 'smsf_property_loan',
    is_active: true, is_primary: true, source: 'manual', confidence: 'user_confirmed',
  });

  // --- STAGE A: Summary mode, user enters the fund's NET value ----------
  // (migration 0084's own column comment: summary_balance is "Net-SMSF-value
  // (fund net assets), NOT gross-asset-value")
  await admin.from('smsf_funds').update({ summary_balance: 135000, summary_balance_date: '2026-09-14' }).eq('id', fund.id);
  const { data: raA } = await admin.from('retirement_accounts').select('current_balance').eq('id', ra.id).single();
  const dA = await dash(uid);
  console.log(`STAGE A (summary, net balance entered)`);
  console.log(`  retirement_accounts.current_balance = ${raA?.current_balance}`);
  console.log(`  totalRetirement=${dA.totalRetirement} totalLiabilities=${dA.totalLiabilities}`);
  console.log(`  netWorth = ${dA.netWorth}   ground truth = ${GROUND_TRUTH_NET_WORTH}   error = ${dA.netWorth - GROUND_TRUTH_NET_WORTH}`);
  console.log(`  ${Math.abs(dA.netWorth - GROUND_TRUTH_NET_WORTH) < 1 ? 'PASS' : 'FAIL'} summary-mode Net Worth`);

  // --- STAGE B: the $0-variance gate, then Detailed mode ----------------
  const { data: recomputed, error: recErr } = await admin.rpc('smsf_recompute_fund', { p_fund_id: fund.id });
  console.log(`\nSTAGE B (detailed)`);
  console.log(`  smsf_recompute_fund -> ${recomputed} ${recErr ? 'ERR ' + recErr.message : ''}`);
  const { error: swErr } = await admin.rpc('smsf_switch_to_detailed', { p_fund_id: fund.id });
  console.log(`  smsf_switch_to_detailed -> ${swErr ? 'ERR ' + swErr.message : 'OK (variance gate satisfied)'}`);
  const { data: raB } = await admin.from('retirement_accounts').select('current_balance').eq('id', ra.id).single();
  const { data: fundB } = await admin.from('smsf_funds').select('mode,detailed_net_value').eq('id', fund.id).single();
  const dB = await dash(uid);
  console.log(`  fund.mode=${fundB?.mode} detailed_net_value=${fundB?.detailed_net_value} retirement.current_balance=${raB?.current_balance}`);
  console.log(`  totalRetirement=${dB.totalRetirement} totalLiabilities=${dB.totalLiabilities}`);
  console.log(`  netWorth = ${dB.netWorth}   ground truth = ${GROUND_TRUTH_NET_WORTH}   error = ${dB.netWorth - GROUND_TRUTH_NET_WORTH}`);
  console.log(`  ${Math.abs(dB.netWorth - GROUND_TRUTH_NET_WORTH) < 1 ? 'PASS' : 'FAIL'} detailed-mode Net Worth`);

  // --- STAGE C: Financial Twin vs Dashboard (same user, same instant) ---
  console.log(`\nSTAGE C (Financial Twin's own dashboard loader vs the canonical one)`);
  try {
    const t = await twin(uid);
    const keys = Object.keys(t);
    console.log(`  twinData exports: ${keys.join(', ')}`);
    const loader = (t as Record<string, unknown>)['loadTwinSourceData'];
    if (typeof loader === 'function') {
      const outcome = await (loader as (u: string, c?: unknown) => Promise<{ status: string; data?: { dashboard?: { netWorth: number; debtServiceRatio: number | null; debtMonthlyRepayments: number } } }>)(uid, admin);
      console.log(`  loadTwinSourceData status=${outcome.status}`);
      const td = outcome.data?.dashboard;
      if (td) {
        console.log(`  twin.dashboard.netWorth=${td.netWorth} vs canonical ${dB.netWorth}  ${td.netWorth === dB.netWorth ? 'MATCH' : 'DIVERGES'}`);
        console.log(`  twin.dashboard.debtServiceRatio=${td.debtServiceRatio} vs canonical ${dB.debtServiceRatio}  ${td.debtServiceRatio === dB.debtServiceRatio ? 'MATCH' : 'DIVERGES'}`);
        console.log(`  twin.dashboard.debtMonthlyRepayments=${td.debtMonthlyRepayments} vs canonical ${dB.debtMonthlyRepayments}  ${td.debtMonthlyRepayments === dB.debtMonthlyRepayments ? 'MATCH' : 'DIVERGES'}`);
      } else {
        console.log('  twin loader returned no dashboard field');
      }
    } else {
      console.log('  no twin source loader found by name — skipped');
    }
  } catch (e) {
    console.log(`  twin comparison error: ${(e as Error).message}`);
  }

  await cleanup();
}

main().catch(async (e) => { console.error('FATAL', e); await cleanup(); process.exit(1); });
