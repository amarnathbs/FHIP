// Investment Intelligence R9 — LIVE-DEV certification (LIVE-R9-001..020) +
// 12 independent live reconciliations.
//
// Runs for real against DEV (vqycarelcoijzwlpkpcz) + a real running
// `next dev` instance. Migration 0067 is confirmed live on DEV (verified
// separately before this script runs). Every user created here is tagged
// r9-live-cert-<stamp>@test.fhip.internal and deleted at the end via the
// service-role admin API; deletion is independently re-verified by re-query
// (see the CLEANUP section at the bottom), never merely assumed.
//
// Pattern reused from scripts/ii_r6_final_live_dev_cases.mjs: service-role
// REST for fixtures, real signup + cookie-based session for HTTP calls
// against the app's own API routes, service-role reads to inspect what
// actually got persisted.
//
// Run: node scripts/ii_r9_live_dev_certification.mjs [baseUrl]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const APP = process.argv[2] ?? 'http://localhost:3219';

function loadEnv() {
  const p = path.join(repoRoot, '.env.local');
  const env = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnv();
const BASE = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
const PROJECT_REF = new URL(BASE).host.split('.')[0];

const results = [];
const reconciliations = [];
function record(id, description, status, detail, extra = {}) {
  results.push({ id, description, status, detail, ...extra });
  console.log(`[${status}] ${id} — ${description}`);
  if (detail) console.log(`        ${String(detail).slice(0, 700)}`);
}
function reconcile(id, description, independentValue, productionValue, match, detail) {
  reconciliations.push({ id, description, independentValue, productionValue, match, detail });
  console.log(`[RECONCILE ${match ? 'MATCH' : 'MISMATCH'}] ${id} — ${description} (independent=${JSON.stringify(independentValue)}, production=${JSON.stringify(productionValue)})`);
  if (detail) console.log(`        ${detail}`);
}

async function sb(p, { method = 'GET', body, prefer, range } = {}) {
  const headers = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  if (range) headers.Range = range;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { ok: res.ok, status: res.status, json, text, contentRange: res.headers.get('content-range') };
}

/** True server-side row count via Content-Range, never subject to PostgREST's
 * default 1000-row page cap on a plain SELECT (spec/pagination-guard note:
 * a test's OWN sanity-count query must not silently hit the exact cap it is
 * trying to prove the app code doesn't hit). */
async function sbExactCount(p) {
  const r = await sb(p, { prefer: 'count=exact', range: '0-0' });
  const total = r.contentRange ? Number(r.contentRange.split('/')[1]) : NaN;
  return total;
}

const stamp = Date.now();
const cleanup = { users: [], instruments: [] };

async function makeUser(tag) {
  const email = `r9-live-cert-${tag}-${stamp}@test.fhip.internal`;
  const password = 'TestPass!' + stamp + 'Aa1';
  const created = await sb('/auth/v1/admin/users', { method: 'POST', body: { email, password, email_confirm: true } });
  const id = created.json?.id;
  const res2 = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  const session = await res2.json();
  if (!id || !session?.access_token) throw new Error(`user setup failed for ${tag}: ${created.text} ${JSON.stringify(session)}`);
  cleanup.users.push({ id, tag });
  const cookieValue = 'base64-' + Buffer.from(JSON.stringify(session), 'utf8').toString('base64');
  return { id, email, session, cookie: `sb-${PROJECT_REF}-auth-token=${cookieValue}` };
}

async function app(pathname, { cookie, method = 'GET', body } = {}) {
  const res = await fetch(`${APP}${pathname}`, {
    method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

// Direct PostgREST call as the REAL end-user (their own access_token, anon
// apikey) — NOT the service role, NOT the app's server-side admin client.
// Used specifically for the same-user forgery tests (LIVE-R9-019) where the
// question is exactly "what can this user's own JWT do against the table
// directly, bypassing the app's API layer entirely?"
async function asUser(p, { accessToken, method = 'GET', body, prefer } = {}) {
  const headers = { apikey: ANON, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { ok: res.ok, status: res.status, json, text };
}

async function makeInvestment(userId, overrides = {}) {
  const row = {
    user_id: userId,
    investment_name: overrides.name ?? `R9-LIVE Test Investment ${stamp}`,
    investment_type: overrides.investmentType ?? 'managed_fund',
    current_value: overrides.currentValue ?? 100000,
    currency_code: overrides.currencyCode ?? 'AUD',
    country_code: overrides.countryCode ?? (overrides.currencyCode === 'INR' ? 'IN' : 'AU'),
    is_active: true,
    source_type: overrides.sourceType ?? 'manual',
    ii_last_refreshed_at: overrides.iiLastRefreshedAt ?? null,
  };
  if (overrides.id) row.id = overrides.id;
  const r = await sb('/rest/v1/investments', { method: 'POST', prefer: 'return=representation', body: row });
  const created = r.json?.[0];
  if (!created) throw new Error(`investment seed failed: ${r.text}`);
  return created;
}

async function makeGoal(userId, overrides = {}) {
  const row = {
    user_id: userId,
    goal_name: overrides.name ?? `R9-LIVE Test Goal ${stamp}`,
    goal_type: overrides.goalType ?? 'investment_portfolio_target',
    goal_category: overrides.goalCategory ?? 'investment',
    target_amount: overrides.targetAmount ?? 100000,
    current_amount: overrides.currentAmount ?? 0,
    currency_code: overrides.currencyCode ?? 'AUD',
    target_date: overrides.targetDate ?? '2035-01-01',
    status: 'active',
    planned_contribution_amount: overrides.plannedContributionAmount ?? 0,
  };
  const r = await sb('/rest/v1/user_goals', { method: 'POST', prefer: 'return=representation', body: row });
  const created = r.json?.[0];
  if (!created) throw new Error(`goal seed failed: ${r.text}`);
  return created;
}

async function getReviewItems(userId, extraFilter = '') {
  const r = await sb(`/rest/v1/ii_review_items?user_id=eq.${userId}&select=*${extraFilter}`);
  return r.json ?? [];
}
async function getGoalAllocations(userId) {
  const r = await sb(`/rest/v1/ii_goal_allocations?user_id=eq.${userId}&select=*`);
  return r.json ?? [];
}
async function getFundingSources(userId) {
  const r = await sb(`/rest/v1/goal_funding_sources?user_id=eq.${userId}&select=*`);
  return r.json ?? [];
}

// ---------------------------------------------------------------------------
// Independent (non-production) arithmetic — same shape as
// scripts/r9_independent_goals_forecasting_oracle.mjs, re-transcribed here
// so live-fixture reconciliation doesn't import any R9 production module.
// ---------------------------------------------------------------------------
function indepGoalLinkedValue(investments, sources) {
  const byGoal = {};
  for (const s of sources) {
    const inv = investments.find((i) => i.id === s.investmentId);
    if (!inv) continue;
    const share = s.allocationPct !== null ? inv.currentValue * (s.allocationPct / 100) : s.allocatedAmount;
    byGoal[s.goalId] = (byGoal[s.goalId] ?? 0) + share;
  }
  return byGoal;
}
function indepPortfolioSplit(investments, sources) {
  let totalValue = 0, allocatedValue = 0;
  const perInvestment = [];
  for (const inv of investments) {
    totalValue += inv.currentValue;
    const pct = sources.filter((s) => s.investmentId === inv.id).reduce((sum, s) => sum + (s.allocationPct ?? 0), 0);
    const fixed = sources.filter((s) => s.investmentId === inv.id && s.allocationPct === null).reduce((sum, s) => sum + s.allocatedAmount, 0);
    const pctValue = inv.currentValue * (Math.min(pct, 100) / 100);
    const allocValue = Math.min(pctValue + fixed, inv.currentValue);
    allocatedValue += allocValue;
    perInvestment.push({ id: inv.id, allocatedValue: allocValue, unallocatedValue: Math.max(inv.currentValue - allocValue, 0) });
  }
  return { totalValue, allocatedValue, unallocatedValue: totalValue - allocatedValue, perInvestment };
}
function indepGoalForecastGapFlag(trackStatus, hasActiveFundingSource) {
  return hasActiveFundingSource && ['off_track', 'at_risk'].includes(trackStatus);
}

async function main() {
  console.log(`\n=== R9 LIVE-DEV CERTIFICATION — run stamp ${stamp}, app=${APP}, DEV project=${PROJECT_REF} ===\n`);

  // =========================================================================
  // LIVE-R9-001 — single goal, 100% allocation.
  // =========================================================================
  const userA = await makeUser('main-a');
  console.log(`Test user A (LIVE-R9-001..010, 013..020): ${userA.id}\n`);
  {
    const inv = await makeInvestment(userA.id, { currentValue: 120000, name: 'LIVE-R9-001 Investment' });
    const goal = await makeGoal(userA.id, { name: 'LIVE-R9-001 Goal', targetAmount: 500000, currentAmount: 500000 }); // funded at creation so this collateral goal is on_track and doesn't pollute later goal_forecast_gap refreshes
    const res = await app('/api/investment-intelligence/goal-allocations', {
      cookie: userA.cookie, method: 'POST',
      body: { goalId: goal.id, investmentPositionId: inv.id, allocationType: 'percentage', allocationValue: 100, linkedInvestmentId: inv.id },
    });
    const fundingSources = await getFundingSources(userA.id);
    const fs1 = fundingSources.find((f) => f.linked_investment_id === inv.id);
    const expected = 120000;
    const match = res.status === 200 && !!res.json?.data?.allocationId && fs1 && Math.abs(fs1.allocated_amount - expected) < 0.01 && fs1.allocation_percentage === 100;
    record('LIVE-R9-001', 'Single goal, one investment, 100% allocation', match ? 'PASS' : 'FAIL',
      `HTTP ${res.status} ${JSON.stringify(res.json)} | persisted goal_funding_sources: ${JSON.stringify(fs1)}`);

    const indep = indepGoalLinkedValue([{ id: inv.id, currentValue: 120000 }], [{ goalId: goal.id, investmentId: inv.id, allocationPct: 100, allocatedAmount: 0 }]);
    reconcile('RECONCILE-R9-01', 'Goal allocation math: single goal 100% of a 120000 investment', indep[goal.id], fs1?.allocated_amount, Math.abs((indep[goal.id] ?? -1) - (fs1?.allocated_amount ?? -2)) < 0.01);
  }

  // =========================================================================
  // LIVE-R9-002 — multiple goals from one investment (50/30/20 split).
  // =========================================================================
  {
    const inv = await makeInvestment(userA.id, { currentValue: 100000, name: 'LIVE-R9-002 Investment' });
    const g1 = await makeGoal(userA.id, { name: 'LIVE-R9-002 Goal A', targetAmount: 200000, currentAmount: 200000 });
    const g2 = await makeGoal(userA.id, { name: 'LIVE-R9-002 Goal B', targetAmount: 200000, currentAmount: 200000 });
    const g3 = await makeGoal(userA.id, { name: 'LIVE-R9-002 Goal C', targetAmount: 200000, currentAmount: 200000 });
    const r1 = await app('/api/investment-intelligence/goal-allocations', { cookie: userA.cookie, method: 'POST', body: { goalId: g1.id, investmentPositionId: inv.id, allocationType: 'percentage', allocationValue: 50, linkedInvestmentId: inv.id } });
    const r2 = await app('/api/investment-intelligence/goal-allocations', { cookie: userA.cookie, method: 'POST', body: { goalId: g2.id, investmentPositionId: inv.id, allocationType: 'percentage', allocationValue: 30, linkedInvestmentId: inv.id } });
    const r3 = await app('/api/investment-intelligence/goal-allocations', { cookie: userA.cookie, method: 'POST', body: { goalId: g3.id, investmentPositionId: inv.id, allocationType: 'percentage', allocationValue: 20, linkedInvestmentId: inv.id } });
    const fundingSources = (await getFundingSources(userA.id)).filter((f) => f.linked_investment_id === inv.id);
    const byGoal = Object.fromEntries(fundingSources.map((f) => [f.goal_id, f.allocated_amount]));
    const match = [r1, r2, r3].every((r) => r.status === 200) && Math.abs((byGoal[g1.id] ?? 0) - 50000) < 0.01 && Math.abs((byGoal[g2.id] ?? 0) - 30000) < 0.01 && Math.abs((byGoal[g3.id] ?? 0) - 20000) < 0.01;
    const sum = (byGoal[g1.id] ?? 0) + (byGoal[g2.id] ?? 0) + (byGoal[g3.id] ?? 0);
    record('LIVE-R9-002', 'Multiple goals from one 100000 investment, 50/30/20 split, sums to exactly 100000', match && Math.abs(sum - 100000) < 0.01 ? 'PASS' : 'FAIL',
      `persisted amounts: A=${byGoal[g1.id]}, B=${byGoal[g2.id]}, C=${byGoal[g3.id]}, sum=${sum}`);

    const indep = indepGoalLinkedValue([{ id: inv.id, currentValue: 100000 }], [
      { goalId: g1.id, investmentId: inv.id, allocationPct: 50, allocatedAmount: 0 },
      { goalId: g2.id, investmentId: inv.id, allocationPct: 30, allocatedAmount: 0 },
      { goalId: g3.id, investmentId: inv.id, allocationPct: 20, allocatedAmount: 0 },
    ]);
    const indepSum = Object.values(indep).reduce((a, b) => a + b, 0);
    reconcile('RECONCILE-R9-02', 'Goal allocation math: 3-way 50/30/20 split sums to exactly the source investment value (no double counting)', indepSum, sum, Math.abs(indepSum - sum) < 0.01);
  }

  // =========================================================================
  // LIVE-R9-003 — multiple investments to one goal.
  // =========================================================================
  {
    const inv1 = await makeInvestment(userA.id, { currentValue: 40000, name: 'LIVE-R9-003 Investment 1' });
    const inv2 = await makeInvestment(userA.id, { currentValue: 60000, name: 'LIVE-R9-003 Investment 2' });
    const goal = await makeGoal(userA.id, { name: 'LIVE-R9-003 Goal', targetAmount: 200000, currentAmount: 200000 });
    const r1 = await app('/api/investment-intelligence/goal-allocations', { cookie: userA.cookie, method: 'POST', body: { goalId: goal.id, investmentPositionId: inv1.id, allocationType: 'percentage', allocationValue: 100, linkedInvestmentId: inv1.id } });
    const r2 = await app('/api/investment-intelligence/goal-allocations', { cookie: userA.cookie, method: 'POST', body: { goalId: goal.id, investmentPositionId: inv2.id, allocationType: 'percentage', allocationValue: 100, linkedInvestmentId: inv2.id } });
    const fundingSources = (await getFundingSources(userA.id)).filter((f) => f.goal_id === goal.id);
    const sum = fundingSources.reduce((s, f) => s + Number(f.allocated_amount), 0);
    const match = r1.status === 200 && r2.status === 200 && fundingSources.length === 2 && Math.abs(sum - 100000) < 0.01;
    record('LIVE-R9-003', 'Two investments (40000+60000) fully allocated to one goal', match ? 'PASS' : 'FAIL',
      `persisted funding sources for goal: ${JSON.stringify(fundingSources.map((f) => ({ inv: f.linked_investment_id, amt: f.allocated_amount })))}`);

    const indep = indepGoalLinkedValue([{ id: inv1.id, currentValue: 40000 }, { id: inv2.id, currentValue: 60000 }], [
      { goalId: goal.id, investmentId: inv1.id, allocationPct: 100, allocatedAmount: 0 },
      { goalId: goal.id, investmentId: inv2.id, allocationPct: 100, allocatedAmount: 0 },
    ]);
    reconcile('RECONCILE-R9-03', 'Goal allocation math: two investments fully allocated to one goal sum to 100000', indep[goal.id], sum, Math.abs((indep[goal.id] ?? -1) - sum) < 0.01);
  }

  // =========================================================================
  // LIVE-R9-004 — unallocated portfolio + Review Centre observation.
  // =========================================================================
  let stampedUnallocatedInvId, stampedUnallocatedValue;
  {
    const inv = await makeInvestment(userA.id, { currentValue: 77777.77, name: 'LIVE-R9-004 Fully Unallocated Investment' });
    stampedUnallocatedInvId = inv.id;
    stampedUnallocatedValue = 77777.77;
    const refresh = await app('/api/investment-intelligence/review/refresh', { cookie: userA.cookie, method: 'POST' });
    const items = await getReviewItems(userA.id, `&category=eq.unallocated_investment&source_record_id=eq.${inv.id}`);
    const item = items[0];
    const match = refresh.status === 200 && item && item.severity === 'info' && Math.abs(item.evidence.unallocatedValue - 77777.77) < 0.01;
    record('LIVE-R9-004', 'Fully unallocated investment surfaces as an info-severity unallocated_investment Review Centre observation, never an error', match ? 'PASS' : 'FAIL',
      `refresh HTTP ${refresh.status} ${JSON.stringify(refresh.json)} | item: ${JSON.stringify(item)}`);
  }

  // =========================================================================
  // LIVE-R9-005 — over-allocation blocked.
  // =========================================================================
  {
    const inv = await makeInvestment(userA.id, { currentValue: 100000, name: 'LIVE-R9-005 Investment' });
    const g1 = await makeGoal(userA.id, { name: 'LIVE-R9-005 Goal A', targetAmount: 200000, currentAmount: 200000 });
    const g2 = await makeGoal(userA.id, { name: 'LIVE-R9-005 Goal B', targetAmount: 200000, currentAmount: 200000 });
    const r1 = await app('/api/investment-intelligence/goal-allocations', { cookie: userA.cookie, method: 'POST', body: { goalId: g1.id, investmentPositionId: inv.id, allocationType: 'percentage', allocationValue: 70, linkedInvestmentId: inv.id } });
    const r2 = await app('/api/investment-intelligence/goal-allocations', { cookie: userA.cookie, method: 'POST', body: { goalId: g2.id, investmentPositionId: inv.id, allocationType: 'percentage', allocationValue: 40, linkedInvestmentId: inv.id } });
    const fundingSources = (await getFundingSources(userA.id)).filter((f) => f.linked_investment_id === inv.id);
    const allocations = (await getGoalAllocations(userA.id)).filter((a) => a.linked_investment_id === inv.id && a.status === 'active');
    const match = r1.status === 200 && r2.status === 409 && fundingSources.length === 1 && allocations.length === 1;
    record('LIVE-R9-005', 'Over-allocation blocked: 70% + 40% (110%) rejected with 409, exactly the first allocation persists, no orphaned row', match ? 'PASS' : 'FAIL',
      `70%: HTTP ${r1.status} | 40% attempt: HTTP ${r2.status} ${JSON.stringify(r2.json)} | persisted funding sources for this investment: ${fundingSources.length} | active ii_goal_allocations rows: ${allocations.length}`);

    reconcile('RECONCILE-R9-04', 'Allocation cap decision: 70% existing + 40% candidate = 110% must exceed the 100% cap', 70 + 40 > 100, r2.status === 409, (70 + 40 > 100) === (r2.status === 409));
  }

  // =========================================================================
  // LIVE-R9-006 — on-track goal, not flagged.
  // =========================================================================
  {
    const goal = await makeGoal(userA.id, { name: 'LIVE-R9-006 On-Track Goal', targetAmount: 50000, currentAmount: 50000, targetDate: '2027-01-01' });
    const goalsRes = await app('/api/investment-intelligence/goals', { cookie: userA.cookie });
    const g = goalsRes.json?.data?.goals?.find((x) => x.id === goal.id);
    const refresh = await app('/api/investment-intelligence/review/refresh', { cookie: userA.cookie, method: 'POST' });
    const items = await getReviewItems(userA.id, `&category=eq.goal_forecast_gap&status=eq.open`);
    const flaggedThisGoal = items.some((i) => i.evidence?.goalId === goal.id);
    const match = goalsRes.status === 200 && g && (g.trackStatus === 'on_track' || g.trackStatus === 'ahead') && refresh.status === 200 && !flaggedThisGoal;
    record('LIVE-R9-006', 'On-track goal (fully funded, currentAmount==targetAmount) is never flagged by goal_forecast_gap', match ? 'PASS' : 'FAIL',
      `trackStatus=${g?.trackStatus}, flaggedThisGoal=${flaggedThisGoal}`);
    reconcile('RECONCILE-R9-09', 'Goal forecast gap gate: on_track goal never flagged regardless of funding', indepGoalForecastGapFlag('on_track', true), flaggedThisGoal, indepGoalForecastGapFlag('on_track', true) === flaggedThisGoal);
  }

  // =========================================================================
  // LIVE-R9-007 — off-track goal + review item.
  // =========================================================================
  let offTrackGoalId, offTrackInvId;
  {
    const inv = await makeInvestment(userA.id, { currentValue: 500, name: 'LIVE-R9-007 Tiny Investment' });
    const goal = await makeGoal(userA.id, { name: 'LIVE-R9-007 Off-Track Goal', targetAmount: 900000, currentAmount: 0, plannedContributionAmount: 0, targetDate: '2028-01-01' });
    offTrackGoalId = goal.id; offTrackInvId = inv.id;
    // A tiny allocation gives the goal an active funding source without meaningfully funding it.
    await app('/api/investment-intelligence/goal-allocations', { cookie: userA.cookie, method: 'POST', body: { goalId: goal.id, investmentPositionId: inv.id, allocationType: 'percentage', allocationValue: 100, linkedInvestmentId: inv.id } });
    const goalsRes = await app('/api/investment-intelligence/goals', { cookie: userA.cookie });
    const g = goalsRes.json?.data?.goals?.find((x) => x.id === goal.id);
    const refresh = await app('/api/investment-intelligence/review/refresh', { cookie: userA.cookie, method: 'POST' });
    const items = await getReviewItems(userA.id, `&category=eq.goal_forecast_gap&status=eq.open`);
    const item = items.find((i) => i.evidence?.goalId === goal.id);
    const match = ['off_track', 'at_risk'].includes(g?.trackStatus) && refresh.status === 200 && !!item && item.severity === 'medium' && item.source_module === 'goals';
    record('LIVE-R9-007', 'Off-track/at-risk goal with an active funding source produces a medium-severity goal_forecast_gap review item', match ? 'PASS' : 'FAIL',
      `trackStatus=${g?.trackStatus}, item=${JSON.stringify(item)}`);
    reconcile('RECONCILE-R9-10', 'Goal forecast gap gate: off_track WITH active funding source -> flagged', indepGoalForecastGapFlag(g?.trackStatus, true), !!item, indepGoalForecastGapFlag(g?.trackStatus, true) === !!item);
  }

  // =========================================================================
  // LIVE-R9-008 — goal change triggering staleness (evidence change -> resolved).
  // =========================================================================
  {
    // Fix the LIVE-R9-007 goal so it becomes on_track, then re-refresh: the
    // previously-open goal_forecast_gap item for it must transition to
    // 'resolved' (condition no longer holds), never silently vanish or stay open.
    await sb(`/rest/v1/user_goals?id=eq.${offTrackGoalId}`, { method: 'PATCH', body: { current_amount: 900000 } });
    const goalsRes = await app('/api/investment-intelligence/goals', { cookie: userA.cookie });
    const g = goalsRes.json?.data?.goals?.find((x) => x.id === offTrackGoalId);
    const beforeItems = await getReviewItems(userA.id, `&category=eq.goal_forecast_gap`);
    const beforeOpen = beforeItems.find((i) => i.evidence?.goalId === offTrackGoalId && i.status === 'open');
    const refresh = await app('/api/investment-intelligence/review/refresh', { cookie: userA.cookie, method: 'POST' });
    const afterItems = await getReviewItems(userA.id, `&category=eq.goal_forecast_gap`);
    const afterRow = afterItems.find((i) => i.id === beforeOpen?.id);
    const match = ['on_track', 'ahead'].includes(g?.trackStatus) && !!beforeOpen && afterRow?.status === 'resolved' && !!afterRow?.resolved_at;
    record('LIVE-R9-008', 'Goal change (current_amount raised to fully fund it) flips trackStatus and the previously-open review item is marked resolved on next refresh, not silently dropped', match ? 'PASS' : 'FAIL',
      `new trackStatus=${g?.trackStatus}, before-open-item=${beforeOpen?.id}, after-status=${afterRow?.status}, resolved_at=${afterRow?.resolved_at}`);
  }

  // =========================================================================
  // LIVE-R9-009 — investment value change triggering refresh (re-derives unallocated value from the LIVE current_value, not a stale cache).
  // =========================================================================
  {
    const inv = await makeInvestment(userA.id, { currentValue: 200000, name: 'LIVE-R9-009 Investment' });
    const goal = await makeGoal(userA.id, { name: 'LIVE-R9-009 Goal', targetAmount: 500000, currentAmount: 500000 });
    await app('/api/investment-intelligence/goal-allocations', { cookie: userA.cookie, method: 'POST', body: { goalId: goal.id, investmentPositionId: inv.id, allocationType: 'percentage', allocationValue: 30, linkedInvestmentId: inv.id } });
    await app('/api/investment-intelligence/review/refresh', { cookie: userA.cookie, method: 'POST' });
    const itemsBefore = await getReviewItems(userA.id, `&category=eq.unallocated_investment&source_record_id=eq.${inv.id}`);
    const beforeUnalloc = itemsBefore[0]?.evidence?.unallocatedValue;

    // Simulate a real II-publishing refresh bumping current_value (service-role write, matching how a real revaluation would land).
    await sb(`/rest/v1/investments?id=eq.${inv.id}`, { method: 'PATCH', body: { current_value: 350000 } });
    const refresh2 = await app('/api/investment-intelligence/review/refresh', { cookie: userA.cookie, method: 'POST' });
    const itemsAfter = await getReviewItems(userA.id, `&category=eq.unallocated_investment&source_record_id=eq.${inv.id}&status=eq.open`);
    const afterUnalloc = itemsAfter[0]?.evidence?.unallocatedValue;
    const expectedBefore = 200000 * 0.7;
    const expectedAfter = 350000 * 0.7;
    const match = refresh2.status === 200 && Math.abs(beforeUnalloc - expectedBefore) < 0.01 && Math.abs(afterUnalloc - expectedAfter) < 0.01;
    record('LIVE-R9-009', 'Investment value change (200000->350000) is re-derived live on next refresh, not served from stale evidence', match ? 'PASS' : 'FAIL',
      `before unallocated=${beforeUnalloc} (expected ${expectedBefore}), after unallocated=${afterUnalloc} (expected ${expectedAfter})`);

    const split1 = indepPortfolioSplit([{ id: inv.id, currentValue: 200000 }], [{ investmentId: inv.id, allocationPct: 30, allocatedAmount: 0 }]);
    const split2 = indepPortfolioSplit([{ id: inv.id, currentValue: 350000 }], [{ investmentId: inv.id, allocationPct: 30, allocatedAmount: 0 }]);
    reconcile('RECONCILE-R9-06', 'Portfolio unallocated split re-derives from the live current_value after a revaluation (200000->350000, 30% allocated)', { before: split1.unallocatedValue, after: split2.unallocatedValue }, { before: beforeUnalloc, after: afterUnalloc },
      Math.abs(split1.unallocatedValue - beforeUnalloc) < 0.01 && Math.abs(split2.unallocatedValue - afterUnalloc) < 0.01);
  }

  // =========================================================================
  // LIVE-R9-010 — re-running refresh with unchanged evidence is idempotent, no duplication (spec section 50/78 dedup guarantee — reinterpreted from the literal "new transaction" framing since R9 owns no transaction ledger of its own).
  // =========================================================================
  {
    const before = await getReviewItems(userA.id, `&status=in.(open,acknowledged)`);
    const beforeGapSample = before.find((i) => i.category === 'goal_forecast_gap');
    const refresh1 = await app('/api/investment-intelligence/review/refresh', { cookie: userA.cookie, method: 'POST' });
    const mid = await getReviewItems(userA.id, `&status=in.(open,acknowledged)`);
    const midGapSample = beforeGapSample ? mid.find((i) => i.evidence?.goalId === beforeGapSample.evidence?.goalId) : null;
    const refresh2 = await app('/api/investment-intelligence/review/refresh', { cookie: userA.cookie, method: 'POST' });
    const after = await getReviewItems(userA.id, `&status=in.(open,acknowledged)`);
    const identityKeys = after.map((i) => i.identity_key);
    const noDuplicateIdentityKeys = new Set(identityKeys).size === identityKeys.length;
    const match = refresh1.status === 200 && refresh2.status === 200 && refresh2.json?.data?.created === 0 && mid.length === after.length && noDuplicateIdentityKeys;
    record('LIVE-R9-010', 'Re-running review/refresh twice in a row over unchanged data creates 0 new rows the second time and never produces two open rows for the same identity_key', match ? 'PASS' : 'FAIL',
      `refresh1=${JSON.stringify(refresh1.json)}, refresh2=${JSON.stringify(refresh2.json)}, open/ack rows before=${before.length} mid=${mid.length} after=${after.length}, unique identity keys=${noDuplicateIdentityKeys} | DIAGNOSTIC same goal_forecast_gap item's evidence before-refresh1 vs after-refresh1(mid): ${JSON.stringify(beforeGapSample?.evidence)} VS ${JSON.stringify(midGapSample?.evidence)} (identity_key same? ${beforeGapSample?.identity_key === midGapSample?.identity_key}, row id same (not superseded)? ${beforeGapSample?.id === midGapSample?.id})`);
  }

  // =========================================================================
  // LIVE-R9-011 — retirement linkage.
  // =========================================================================
  {
    const inv = await makeInvestment(userA.id, { currentValue: 300000, name: 'LIVE-R9-011 Retirement Investment' });
    const goal = await makeGoal(userA.id, { name: 'LIVE-R9-011 Retirement Goal', goalType: 'retirement_balance_target', goalCategory: 'retirement', targetAmount: 1000000, currentAmount: 1000000, targetDate: '2045-01-01' });
    const allocRes = await app('/api/investment-intelligence/goal-allocations', { cookie: userA.cookie, method: 'POST', body: { goalId: goal.id, investmentPositionId: inv.id, allocationType: 'percentage', allocationValue: 100, linkedInvestmentId: inv.id } });
    const detailRes = await app(`/api/investment-intelligence/goals/${goal.id}`, { cookie: userA.cookie });
    const retirementAccountsBefore = await sb(`/rest/v1/retirement_accounts?user_id=eq.${userA.id}&select=id`);
    const match = allocRes.status === 200 && detailRes.status === 200 && detailRes.json?.data?.goal?.goalCategory === 'retirement' && detailRes.json?.data?.goal?.forecasts && (retirementAccountsBefore.json ?? []).length === 0;
    record('LIVE-R9-011', 'Retirement-category goal: investment allocation processed via the SAME goal-allocation path (no separate retirement engine), and R9 never writes a retirement_accounts row', match ? 'PASS' : 'FAIL',
      `allocRes HTTP ${allocRes.status}, detail goalCategory=${detailRes.json?.data?.goal?.goalCategory}, retirement_accounts rows written by this test=${(retirementAccountsBefore.json ?? []).length}`);

    const indep = indepGoalLinkedValue([{ id: inv.id, currentValue: 300000 }], [{ goalId: goal.id, investmentId: inv.id, allocationPct: 100, allocatedAmount: 0 }]);
    const fs1 = (await getFundingSources(userA.id)).find((f) => f.goal_id === goal.id && f.linked_investment_id === inv.id);
    reconcile('RECONCILE-R9-05', 'Goal allocation math: retirement-category goal, single investment 100% allocation', indep[goal.id], fs1?.allocated_amount, Math.abs((indep[goal.id] ?? -1) - (fs1?.allocated_amount ?? -2)) < 0.01);
  }

  // =========================================================================
  // LIVE-R9-012 — cross-currency: a goal with investments in two different currencies never has its allocation math silently converted/merged.
  // =========================================================================
  {
    const invAud = await makeInvestment(userA.id, { currentValue: 50000, currencyCode: 'AUD', name: 'LIVE-R9-012 AUD Investment' });
    const invInr = await makeInvestment(userA.id, { currentValue: 500000, currencyCode: 'INR', name: 'LIVE-R9-012 INR Investment' });
    const goal = await makeGoal(userA.id, { name: 'LIVE-R9-012 Cross-Currency Goal', currencyCode: 'AUD', targetAmount: 100000, currentAmount: 100000 });
    const r1 = await app('/api/investment-intelligence/goal-allocations', { cookie: userA.cookie, method: 'POST', body: { goalId: goal.id, investmentPositionId: invAud.id, allocationType: 'percentage', allocationValue: 100, linkedInvestmentId: invAud.id } });
    const r2 = await app('/api/investment-intelligence/goal-allocations', { cookie: userA.cookie, method: 'POST', body: { goalId: goal.id, investmentPositionId: invInr.id, allocationType: 'percentage', allocationValue: 100, linkedInvestmentId: invInr.id } });
    const fundingSources = (await getFundingSources(userA.id)).filter((f) => f.goal_id === goal.id);
    const aud = fundingSources.find((f) => f.linked_investment_id === invAud.id);
    const inr = fundingSources.find((f) => f.linked_investment_id === invInr.id);
    // The two amounts are NEVER summed together into one reporting-currency figure anywhere in R9 (spec section 21/22) — each funding-source row keeps its own investment's raw current_value untouched, no FX conversion invented.
    const match = r1.status === 200 && r2.status === 200 && Math.abs(aud.allocated_amount - 50000) < 0.01 && Math.abs(inr.allocated_amount - 500000) < 0.01;
    record('LIVE-R9-012', 'Cross-currency goal (AUD + INR linked investments): each funding-source row keeps its own raw currency value, no invented FX conversion or silent merge', match ? 'PASS' : 'FAIL',
      `AUD row amount=${aud?.allocated_amount}, INR row amount=${inr?.allocated_amount}`);

    const indep = indepGoalLinkedValue(
      [{ id: invAud.id, currentValue: 50000, currencyCode: 'AUD' }, { id: invInr.id, currentValue: 500000, currencyCode: 'INR' }],
      [{ goalId: goal.id, investmentId: invAud.id, allocationPct: 100, allocatedAmount: 0 }, { goalId: goal.id, investmentId: invInr.id, allocationPct: 100, allocatedAmount: 0 }]
    );
    // Independently re-derive currencyCode nullability: >1 distinct currency across a goal's linked investments -> null (per computeGoalLinkedValues contract), never a fabricated conversion.
    const currencies = new Set([aud ? 'AUD' : null, inr ? 'INR' : null].filter(Boolean));
    const expectedCurrencyCodeNull = currencies.size > 1;
    reconcile('RECONCILE-R9-07', 'Goal-linked value across 2 currencies: sum is the raw arithmetic sum (no FX invented) and spans >1 currency', indep[goal.id], aud.allocated_amount + inr.allocated_amount, Math.abs(indep[goal.id] - (aud.allocated_amount + inr.allocated_amount)) < 0.01 && expectedCurrencyCodeNull);
  }

  // =========================================================================
  // LIVE-R9-013 — data-quality observation, provenance ii_publishing (stale_valuation).
  // =========================================================================
  {
    const staleDate = new Date(Date.now() - 95 * 86400000).toISOString();
    const inv = await makeInvestment(userA.id, { currentValue: 80000, name: 'LIVE-R9-013 Stale Investment', sourceType: 'investment_intelligence_published', iiLastRefreshedAt: staleDate });
    const refresh = await app('/api/investment-intelligence/review/refresh', { cookie: userA.cookie, method: 'POST' });
    const items = await getReviewItems(userA.id, `&category=eq.stale_valuation&source_record_id=eq.${inv.id}`);
    const item = items[0];
    const allStale = await getReviewItems(userA.id, `&category=eq.stale_valuation`);
    const invCheck = await sb(`/rest/v1/investments?id=eq.${inv.id}&select=*`);
    const match = refresh.status === 200 && !!item && item.severity === 'low' && item.source_module === 'ii_publishing' && item.evidence.ageDays > 90;
    record('LIVE-R9-013', 'Data-quality review item (stale_valuation, 95-day-old II-published valuation) with correct provenance back to ii_publishing', match ? 'PASS' : 'FAIL',
      `item=${JSON.stringify(item)} | refresh=${JSON.stringify(refresh.json)} | all stale_valuation items for user=${JSON.stringify(allStale.map((i) => i.source_record_id))} | seeded investment row=${JSON.stringify(invCheck.json?.[0])}`);
  }

  // =========================================================================
  // LIVE-R9-014 — performance observation, provenance R4 ii_analytics_results.
  // =========================================================================
  {
    const instId = crypto.randomUUID();
    await sb('/rest/v1/ii_instruments', { method: 'POST', body: { id: instId, instrument_name: `R9-LIVE-014 Underperformer ${stamp}`, instrument_class: 'mutual_fund', country_of_domicile: 'IN', base_currency: 'INR' } });
    cleanup.instruments.push(instId);
    const analyticsInsert = await sb('/rest/v1/ii_analytics_results', {
      method: 'POST', prefer: 'return=representation',
      body: {
        user_id: userA.id, scope_type: 'scheme', scope_id: instId, metric_key: 'scheme_active_return',
        metric_version: 'r9-live-cert-test-v1', engine_version: 'r9-live-cert-test-v1', data_as_of_date: '2026-08-23',
        input_snapshot_version: 'r9-live-cert-test-snapshot-v1', quality_status: 'ok',
        result_value: { status: 'ok', value: { activeReturn: -0.05, family: 'test', benchmarkKey: 'test' } },
      },
    });
    if (!analyticsInsert.ok) throw new Error(`ii_analytics_results seed failed: ${analyticsInsert.text}`);
    const refresh = await app('/api/investment-intelligence/review/refresh', { cookie: userA.cookie, method: 'POST' });
    const items = await getReviewItems(userA.id, `&category=eq.benchmark_underperformance&source_record_id=eq.${instId}`);
    const item = items[0];
    const allPerf = await getReviewItems(userA.id, `&category=eq.benchmark_underperformance`);
    const arCheck = await sb(`/rest/v1/ii_analytics_results?user_id=eq.${userA.id}&scope_id=eq.${instId}&select=*`);
    const match = refresh.status === 200 && !!item && item.severity === 'medium' && item.source_module === 'ii_r4_performance' && Math.abs(item.evidence.activeReturn - -0.05) < 0.001;
    record('LIVE-R9-014', 'Performance review item (benchmark_underperformance, -5% active return) with correct provenance back to R4 ii_analytics_results, consumed not recomputed', match ? 'PASS' : 'FAIL',
      `item=${JSON.stringify(item)} | refresh=${JSON.stringify(refresh.json)} | all benchmark_underperformance items=${JSON.stringify(allPerf.map((i) => i.source_record_id))} | seeded ii_analytics_results row=${JSON.stringify(arCheck.json?.[0])}`);
  }

  // =========================================================================
  // LIVE-R9-015 — SIP observation, provenance R5 ii_sip_series.
  // =========================================================================
  {
    const acctRes = await sb('/rest/v1/ii_accounts', { method: 'POST', prefer: 'return=representation', body: { user_id: userA.id, account_type: 'mf_folio', institution_name: 'R9-LIVE Test AMC', country_code: 'IN', currency_code: 'INR', status: 'active' } });
    if (!acctRes.ok) throw new Error(`ii_accounts seed failed (LIVE-R9-015): ${acctRes.text}`);
    const acctId = acctRes.json?.[0]?.id;
    const instId = crypto.randomUUID();
    await sb('/rest/v1/ii_instruments', { method: 'POST', body: { id: instId, instrument_name: `R9-LIVE-015 SIP Fund ${stamp}`, instrument_class: 'mutual_fund', country_of_domicile: 'IN', base_currency: 'INR' } });
    cleanup.instruments.push(instId);
    const latestContribution = new Date(Date.now() - 100 * 86400000).toISOString().slice(0, 10); // >2 missed monthly instalments
    const sipInsert = await sb('/rest/v1/ii_sip_series', { method: 'POST', body: { user_id: userA.id, account_id: acctId, instrument_id: instId, series_key: `r9-live-015-${stamp}`, cadence: 'MONTHLY', detection_confidence: 'CONFIRMED_SOURCE', latest_contribution_date: latestContribution, detection_method_version: 'r9-live-cert-test-v1', threshold_config_version: 'r9-live-cert-test-v1' } });
    if (!sipInsert.ok) throw new Error(`ii_sip_series seed failed: ${sipInsert.text}`);
    const refresh = await app('/api/investment-intelligence/review/refresh', { cookie: userA.cookie, method: 'POST' });
    const items = await getReviewItems(userA.id, `&category=eq.sip_interruption`);
    const item = items.find((i) => i.evidence?.instrumentId === instId);
    const match = refresh.status === 200 && !!item && item.severity === 'low' && item.source_module === 'ii_r5_sip_xray' && item.evidence.missedInstalments >= 2;
    record('LIVE-R9-015', 'SIP review item (sip_interruption, 100 days since last MONTHLY contribution) with correct provenance back to R5 ii_sip_series', match ? 'PASS' : 'FAIL',
      `item=${JSON.stringify(item)}`);
  }

  // =========================================================================
  // LIVE-R9-016 — tax-cost observation, provenance R6 ii_capital_gains_computations.
  // =========================================================================
  {
    const acctRes = await sb('/rest/v1/ii_accounts', { method: 'POST', prefer: 'return=representation', body: { user_id: userA.id, account_type: 'mf_folio', institution_name: 'R9-LIVE Test AMC 2', country_code: 'IN', currency_code: 'INR', status: 'active' } });
    if (!acctRes.ok) throw new Error(`ii_accounts seed failed (LIVE-R9-016): ${acctRes.text}`);
    const acctId = acctRes.json?.[0]?.id;
    const instId = crypto.randomUUID();
    await sb('/rest/v1/ii_instruments', { method: 'POST', body: { id: instId, instrument_name: `R9-LIVE-016 Exit-Load Fund ${stamp}`, instrument_class: 'mutual_fund', country_of_domicile: 'IN', base_currency: 'INR' } });
    cleanup.instruments.push(instId);
    const purchaseRes = await sb('/rest/v1/ii_transactions', { method: 'POST', prefer: 'return=representation', body: { user_id: userA.id, account_id: acctId, instrument_id: instId, currency_code: 'INR', transaction_type: 'purchase', transaction_date: '2026-06-01', gross_amount: 10000, units: 100, price_per_unit: 100, status: 'reconciled' } });
    if (!purchaseRes.ok) throw new Error(`ii_transactions purchase seed failed: ${purchaseRes.text}`);
    const redemptionRes = await sb('/rest/v1/ii_transactions', { method: 'POST', prefer: 'return=representation', body: { user_id: userA.id, account_id: acctId, instrument_id: instId, currency_code: 'INR', transaction_type: 'redemption', transaction_date: '2026-08-01', gross_amount: 11000, units: 100, price_per_unit: 110, status: 'reconciled' } });
    if (!redemptionRes.ok) throw new Error(`ii_transactions redemption seed failed: ${redemptionRes.text}`);
    const lotRes = await sb('/rest/v1/ii_tax_lots', { method: 'POST', prefer: 'return=representation', body: { user_id: userA.id, account_id: acctId, instrument_id: instId, opening_transaction_id: purchaseRes.json?.[0]?.id, status: 'closed', acquisition_date: '2026-06-01', units_acquired: 100, units_remaining: 0, cost_per_unit: 100 } });
    if (!lotRes.ok) throw new Error(`ii_tax_lots seed failed: ${lotRes.text}`);
    const cgcRes = await sb('/rest/v1/ii_capital_gains_computations', {
      method: 'POST', prefer: 'return=representation',
      body: { user_id: userA.id, disposal_transaction_id: redemptionRes.json?.[0]?.id, lot_id: lotRes.json?.[0]?.id, instrument_id: instId, classification: 'equity_oriented', gain_type: 'stcg', holding_days: 61, sale_value: 11000, cost_basis_used: 10000, taxable_gain: 1000, exit_load_pct: 1.0, exit_load_amount: 110, engine_version: 'r9-live-cert-test-v1' },
    });
    if (!cgcRes.ok) throw new Error(`ii_capital_gains_computations seed failed: ${cgcRes.text}`);
    const computationId = cgcRes.json?.[0]?.id;
    const refresh = await app('/api/investment-intelligence/review/refresh', { cookie: userA.cookie, method: 'POST' });
    const exitLoadItems = await getReviewItems(userA.id, `&category=eq.exit_load_exposure`);
    const exitLoadItem = exitLoadItems.find((i) => i.evidence?.lotId === lotRes.json?.[0]?.id);
    const match = refresh.status === 200 && !!exitLoadItem && exitLoadItem.severity === 'low' && exitLoadItem.source_module === 'ii_r6_tax' && Math.abs(exitLoadItem.evidence.exitLoadPct - 1.0) < 0.001;
    record('LIVE-R9-016', 'Tax-cost review item (exit_load_exposure, 1.0% exit load) with correct provenance back to R6 ii_capital_gains_computations, tax not recomputed', match ? 'PASS' : 'FAIL',
      `computationId=${computationId}, exitLoadItem=${JSON.stringify(exitLoadItem)}`);
  }

  // =========================================================================
  // LIVE-R9-017 — review resolution lifecycle (acknowledge -> resolve-on-vanish; dismiss).
  // =========================================================================
  {
    // Acknowledge the LIVE-R9-013 stale_valuation item, then resolve it by refreshing the underlying investment.
    const staleItems = await getReviewItems(userA.id, `&category=eq.stale_valuation&status=eq.open`);
    const target = staleItems[0];
    const ackRes = await app(`/api/investment-intelligence/review/${target.id}/acknowledge`, { cookie: userA.cookie, method: 'POST', body: { note: 'R9-LIVE-017 test acknowledgement' } });
    const afterAck = await sb(`/rest/v1/ii_review_items?id=eq.${target.id}&select=*`);
    const ackRow = afterAck.json?.[0];

    await sb(`/rest/v1/investments?id=eq.${target.source_record_id}`, { method: 'PATCH', body: { ii_last_refreshed_at: new Date().toISOString() } });
    await app('/api/investment-intelligence/review/refresh', { cookie: userA.cookie, method: 'POST' });
    const afterResolve = await sb(`/rest/v1/ii_review_items?id=eq.${target.id}&select=*`);
    const resolvedRow = afterResolve.json?.[0];

    // Separate item for dismiss lifecycle.
    const dismissInv = await makeInvestment(userA.id, { currentValue: 12345, name: 'LIVE-R9-017 Dismiss-Test Investment' });
    await app('/api/investment-intelligence/review/refresh', { cookie: userA.cookie, method: 'POST' });
    const dismissItems = await getReviewItems(userA.id, `&category=eq.unallocated_investment&source_record_id=eq.${dismissInv.id}&status=eq.open`);
    const dismissTarget = dismissItems[0];
    const dismissRes = await app(`/api/investment-intelligence/review/${dismissTarget.id}/dismiss`, { cookie: userA.cookie, method: 'POST', body: { note: 'R9-LIVE-017 test dismissal' } });
    const afterDismiss = await sb(`/rest/v1/ii_review_items?id=eq.${dismissTarget.id}&select=*`);
    const dismissedRow = afterDismiss.json?.[0];

    const match = ackRes.status === 200 && ackRow?.status === 'acknowledged' && !!ackRow?.acknowledged_at && resolvedRow?.status === 'resolved' && !!resolvedRow?.resolved_at &&
      dismissRes.status === 200 && dismissedRow?.status === 'dismissed' && !!dismissedRow?.dismissed_at;
    record('LIVE-R9-017', 'Review resolution lifecycle: open->acknowledged (user action)->resolved (condition vanished on refresh), and open->dismissed (user action), all DB-persisted with timestamps', match ? 'PASS' : 'FAIL',
      `ack: status=${ackRow?.status} at=${ackRow?.acknowledged_at} | resolve: status=${resolvedRow?.status} at=${resolvedRow?.resolved_at} | dismiss: status=${dismissedRow?.status} at=${dismissedRow?.dismissed_at}`);
  }

  // =========================================================================
  // LIVE-R9-018 — cross-user security: User B blocked from User A's goal-linked data.
  // =========================================================================
  const userB = await makeUser('victim-b');
  console.log(`\nTest user B (LIVE-R9-018 victim probe target, LIVE-R9-019 attacker): ${userB.id}\n`);
  {
    const aItems = await getReviewItems(userA.id, `&status=eq.open&limit=1`);
    const aTargetItem = aItems[0];
    const aGoalRes = await sb(`/rest/v1/user_goals?user_id=eq.${userA.id}&limit=1&select=id`);
    const aGoalId = aGoalRes.json?.[0]?.id;

    const bListRes = await app('/api/investment-intelligence/review', { cookie: userB.cookie });
    const bSeesAnyOfA = (bListRes.json?.data?.items ?? []).some((i) => i.user_id === userA.id);
    const bAckAttempt = await app(`/api/investment-intelligence/review/${aTargetItem.id}/acknowledge`, { cookie: userB.cookie, method: 'POST', body: {} });
    const bGoalDetailAttempt = await app(`/api/investment-intelligence/goals/${aGoalId}`, { cookie: userB.cookie });
    const aItemUnchanged = await sb(`/rest/v1/ii_review_items?id=eq.${aTargetItem.id}&select=status`);

    const match = bListRes.status === 200 && !bSeesAnyOfA && bAckAttempt.status === 400 && bGoalDetailAttempt.status === 404 && aItemUnchanged.json?.[0]?.status === aTargetItem.status;
    record('LIVE-R9-018', "User B genuinely blocked from User A's review items (list never includes A, direct-id acknowledge rejected, goal detail 404) — A's row provably untouched", match ? 'PASS' : 'FAIL',
      `B list leaked A? ${bSeesAnyOfA} | B acknowledge-A-item HTTP ${bAckAttempt.status} ${JSON.stringify(bAckAttempt.json)} | B goal-detail-of-A HTTP ${bGoalDetailAttempt.status} | A's item status before=${aTargetItem.status} after=${aItemUnchanged.json?.[0]?.status}`);
  }

  // =========================================================================
  // LIVE-R9-019 — same-user forgery, valid own FKs (4 vectors).
  // =========================================================================
  {
    // (a) forecast/goal mismatch forgery: mismatched goalId in body vs. path.
    const goalRes = await sb(`/rest/v1/user_goals?user_id=eq.${userB.id}&limit=1&select=id`);
    let bGoalId = goalRes.json?.[0]?.id;
    if (!bGoalId) { const g = await makeGoal(userB.id, { name: 'LIVE-R9-019 B Goal' }); bGoalId = g.id; }
    const otherGoal = await makeGoal(userB.id, { name: 'LIVE-R9-019 B Other Goal' });
    const bInv = await makeInvestment(userB.id, { currentValue: 1000, name: 'LIVE-R9-019 B Investment' });
    const mismatchRes = await app(`/api/investment-intelligence/goals/${bGoalId}/allocations`, { cookie: userB.cookie, method: 'POST', body: { goalId: otherGoal.id, investmentPositionId: bInv.id, allocationType: 'percentage', allocationValue: 10, linkedInvestmentId: bInv.id } });
    record('LIVE-R9-019a', 'Same-user forgery: goalId in request body must match the goal in the URL path — mismatched goalId rejected (422), not silently coerced to the path value', mismatchRes.status === 422 ? 'PASS' : 'FAIL', `HTTP ${mismatchRes.status} ${JSON.stringify(mismatchRes.json)}`);

    // Set up one real review item owned by B to attack directly.
    await app('/api/investment-intelligence/review/refresh', { cookie: userB.cookie, method: 'POST' });
    const bItems = await getReviewItems(userB.id, `&status=eq.open&limit=1`);
    const bItem = bItems[0];

    // (b) direct-REST severity forgery on B's OWN row, using B's OWN JWT (not the app API, not the service role).
    let severityForgeRes = null, severityAfter = null;
    if (bItem) {
      severityForgeRes = await asUser(`/rest/v1/ii_review_items?id=eq.${bItem.id}`, { accessToken: userB.session.access_token, method: 'PATCH', prefer: 'return=representation', body: { severity: 'high', status: 'resolved' } });
      const check = await sb(`/rest/v1/ii_review_items?id=eq.${bItem.id}&select=severity,status`);
      severityAfter = check.json?.[0];
      const forged = severityAfter && (severityAfter.severity === 'high' || severityAfter.status === 'resolved') && severityAfter.severity !== bItem.severity;
      record('LIVE-R9-019b', "Same-user forgery: user attempts direct PostgREST PATCH of severity/status on their OWN ii_review_items row (own JWT, bypassing the app's bounded acknowledge/dismiss API)",
        !forged ? 'PASS' : 'FAIL',
        `original severity=${bItem.severity} status=${bItem.status} | PATCH HTTP ${severityForgeRes.status} ${JSON.stringify(severityForgeRes.json ?? severityForgeRes.text).slice(0, 300)} | row after: ${JSON.stringify(severityAfter)}${forged ? ' — GENUINE FINDING: RLS scopes rows only, not columns; the app-layer bounded API is the only real control on this field, exactly like the disclosed goal_funding_sources.linked_investment_id gap in R9_GOAL_ALLOCATION_CONTRACT.md' : ''}`);
    } else {
      record('LIVE-R9-019b', 'Same-user severity-forgery probe', 'BLOCKED', 'No open review item existed for user B to attack');
    }

    // (c) direct-REST evidence forgery on B's own row.
    if (bItem) {
      const evidenceForgeRes = await asUser(`/rest/v1/ii_review_items?id=eq.${bItem.id}`, { accessToken: userB.session.access_token, method: 'PATCH', prefer: 'return=representation', body: { evidence: { forged: true, unallocatedValue: 999999999 } } });
      const check2 = await sb(`/rest/v1/ii_review_items?id=eq.${bItem.id}&select=evidence`);
      const evidenceAfter = check2.json?.[0]?.evidence;
      const forged2 = evidenceAfter?.forged === true;
      record('LIVE-R9-019c', "Same-user forgery: user attempts direct PostgREST PATCH of evidence on their OWN ii_review_items row",
        !forged2 ? 'PASS' : 'FAIL',
        `PATCH HTTP ${evidenceForgeRes.status} | evidence after: ${JSON.stringify(evidenceAfter).slice(0, 200)}${forged2 ? ' — GENUINE FINDING: same root cause as 019b' : ''}`);
    } else {
      record('LIVE-R9-019c', 'Same-user evidence-forgery probe', 'BLOCKED', 'No open review item existed for user B to attack');
    }

    // (d) system-status forgery: user attempts to write ii_review_rule_registry directly (own JWT) — must be blocked (trusted-service-write-only table, no authenticated insert/update policy).
    const registryInsertRes = await asUser('/rest/v1/ii_review_rule_registry', { accessToken: userB.session.access_token, method: 'POST', prefer: 'return=representation', body: { rule_key: 'forged_rule', rule_version: 'forged-1.0.0', review_type: 'goal', category: 'forged', default_severity: 'high', description: 'forged by LIVE-R9-019d' } });
    const registryCheck = await sb(`/rest/v1/ii_review_rule_registry?rule_key=eq.forged_rule&select=id`);
    const registryUpdateRes = await asUser(`/rest/v1/ii_review_rule_registry?rule_key=eq.unallocated_investment`, { accessToken: userB.session.access_token, method: 'PATCH', prefer: 'return=representation', body: { default_severity: 'high' } });
    const registryUpdateCheck = await sb(`/rest/v1/ii_review_rule_registry?rule_key=eq.unallocated_investment&select=default_severity`);
    const registryBlocked = (registryCheck.json ?? []).length === 0 && registryUpdateCheck.json?.[0]?.default_severity === 'info';
    record('LIVE-R9-019d', 'Same-user forgery: user attempts direct INSERT/UPDATE of ii_review_rule_registry (system thresholds) with their own JWT — structurally blocked (service-role-write-only, no authenticated write policy)',
      registryBlocked ? 'PASS' : 'FAIL',
      `INSERT HTTP ${registryInsertRes.status}, forged rows visible=${(registryCheck.json ?? []).length} | UPDATE HTTP ${registryUpdateRes.status}, unallocated_investment.default_severity after=${registryUpdateCheck.json?.[0]?.default_severity}`);
  }

  // =========================================================================
  // LIVE-R9-020 — >1000-row pagination guard (PostgREST-truncation guard).
  // =========================================================================
  const userC = await makeUser('pagination-c');
  console.log(`\nTest user C (LIVE-R9-020, >1000-row pagination): ${userC.id}\n`);
  {
    const FILLER_COUNT = 1001;
    const MARKER_VALUE = 918273.45;
    const goal = await makeGoal(userC.id, { name: 'LIVE-R9-020 Pagination Goal', targetAmount: 10_000_000 });

    const fillerIds = [];
    for (let i = 0; i < FILLER_COUNT; i++) fillerIds.push(`11111111-1111-4111-8111-${i.toString(16).padStart(12, '0')}`);
    const markerId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

    // Batch-insert fillers (chunks of 250) — all fully allocated (100%) to the one goal so they do NOT themselves generate unallocated_investment noise.
    const CHUNK = 250;
    for (let i = 0; i < fillerIds.length; i += CHUNK) {
      const chunk = fillerIds.slice(i, i + CHUNK);
      const invRows = chunk.map((id, idx) => ({ id, user_id: userC.id, investment_name: `R9-LIVE-020 filler ${i + idx}`, investment_type: 'managed_fund', current_value: 1000, currency_code: 'AUD', country_code: 'AU', is_active: true, source_type: 'manual' }));
      const r = await sb('/rest/v1/investments', { method: 'POST', prefer: 'return=minimal', body: invRows });
      if (!r.ok) throw new Error(`filler investment batch insert failed at ${i}: ${r.text}`);
    }
    await sb('/rest/v1/investments', { method: 'POST', prefer: 'return=minimal', body: { id: markerId, user_id: userC.id, investment_name: 'R9-LIVE-020 marker (row 1002)', investment_type: 'managed_fund', current_value: MARKER_VALUE, currency_code: 'AUD', country_code: 'AU', is_active: true, source_type: 'manual' } });

    for (let i = 0; i < fillerIds.length; i += CHUNK) {
      const chunk = fillerIds.slice(i, i + CHUNK);
      const fsRows = chunk.map((id) => ({ user_id: userC.id, goal_id: goal.id, source_type: 'investment', linked_investment_id: id, allocation_percentage: 100, allocated_amount: 1000, is_active: true }));
      const r = await sb('/rest/v1/goal_funding_sources', { method: 'POST', prefer: 'return=minimal', body: fsRows });
      if (!r.ok) throw new Error(`filler funding-source batch insert failed at ${i}: ${r.text}`);
    }
    // Mirror onto ii_goal_allocations too, matching what the real write path keeps in lockstep (not exercised via HTTP here — these are bulk fixture rows, not testing the create-path itself).
    for (let i = 0; i < fillerIds.length; i += CHUNK) {
      const chunk = fillerIds.slice(i, i + CHUNK);
      const gaRows = chunk.map((id) => ({ user_id: userC.id, goal_id: goal.id, investment_position_id: id, linked_investment_id: id, allocation_type: 'percentage', allocation_value: 100, source: 'system_suggested', status: 'active' }));
      await sb('/rest/v1/ii_goal_allocations', { method: 'POST', prefer: 'return=minimal', body: gaRows });
    }

    // Exact server-side count (Content-Range), NOT a plain-array .length --
    // a naive SELECT here would itself be silently capped at PostgREST's
    // default 1000-row page, defeating the point of this exact test.
    const totalCount = await sbExactCount(`/rest/v1/investments?user_id=eq.${userC.id}&select=id&is_active=eq.true`);

    const refresh = await app('/api/investment-intelligence/review/refresh', { cookie: userC.cookie, method: 'POST' });
    const markerItems = await getReviewItems(userC.id, `&category=eq.unallocated_investment&source_record_id=eq.${markerId}`);
    const markerItem = markerItems[0];
    const unallocatedItemCount = (await getReviewItems(userC.id, `&category=eq.unallocated_investment`)).length;

    const match = totalCount === FILLER_COUNT + 1 && refresh.status === 200 && !!markerItem && Math.abs(markerItem.evidence.unallocatedValue - MARKER_VALUE) < 0.01 && unallocatedItemCount === 1;
    record('LIVE-R9-020', `>1000-row pagination guard: ${FILLER_COUNT} allocated filler investments + 1 unallocated marker (sorted last by id, past PostgREST's default 1000-row cap) — the marker's review item must exist with the correct value, proving fetchAllPages actually reached row ${FILLER_COUNT + 1}, not silently truncated at 1000`,
      match ? 'PASS' : 'FAIL',
      `total investments seeded/visible=${totalCount} (expected ${FILLER_COUNT + 1}) | refresh HTTP ${refresh.status} ${JSON.stringify(refresh.json)} | marker item=${JSON.stringify(markerItem)} | total unallocated_investment items=${unallocatedItemCount} (expected exactly 1)`);

    const negSplit = indepPortfolioSplit(
      [...fillerIds.map((id) => ({ id, currentValue: 1000 })), { id: markerId, currentValue: MARKER_VALUE }],
      fillerIds.map((id) => ({ investmentId: id, allocationPct: 100, allocatedAmount: 0 }))
    );
    const markerIndep = negSplit.perInvestment.find((p) => p.id === markerId);
    reconcile('RECONCILE-R9-08', `Portfolio unallocated split at scale (${FILLER_COUNT + 1} investments, marker at the very end of id-sort order): marker's unallocatedValue must equal its full current_value`, markerIndep?.unallocatedValue, markerItem?.evidence?.unallocatedValue, Math.abs((markerIndep?.unallocatedValue ?? -1) - (markerItem?.evidence?.unallocatedValue ?? -2)) < 0.01);
  }

  // =========================================================================
  // RECONCILE-R9-11, 12 — additional goal-forecast-gap gate reconciliations reusing LIVE-R9-008's before/after states.
  // =========================================================================
  {
    // Before state (off_track, active funding) already reconciled as RECONCILE-R9-10. Independently re-derive the after-state (on_track) gate outcome directly against the persisted resolved row from LIVE-R9-008.
    const goalsRes = await app('/api/investment-intelligence/goals', { cookie: userA.cookie });
    const g = goalsRes.json?.data?.goals?.find((x) => x.id === offTrackGoalId);
    const openItemsForGoal = (await getReviewItems(userA.id, `&category=eq.goal_forecast_gap`)).filter((i) => i.evidence?.goalId === offTrackGoalId && i.status === 'open');
    const expectFlagged = indepGoalForecastGapFlag(g?.trackStatus, true);
    reconcile('RECONCILE-R9-11', 'Goal forecast gap gate re-derived after LIVE-R9-008\'s goal-change: on_track -> no OPEN goal_forecast_gap item for this goal', expectFlagged, openItemsForGoal.length > 0, expectFlagged === (openItemsForGoal.length > 0));

    // Independent re-derivation of the allocation-cap boundary at exactly 100% (not exceeded) using a fresh pair on a fresh investment, to complement RECONCILE-R9-04's over-the-cap case with an at-the-cap case.
    const inv = await makeInvestment(userA.id, { currentValue: 60000, name: 'RECONCILE-R9-12 Investment' });
    const g1 = await makeGoal(userA.id, { name: 'RECONCILE-R9-12 Goal A', targetAmount: 100000, currentAmount: 100000 });
    const g2 = await makeGoal(userA.id, { name: 'RECONCILE-R9-12 Goal B', targetAmount: 100000, currentAmount: 100000 });
    const rA = await app('/api/investment-intelligence/goal-allocations', { cookie: userA.cookie, method: 'POST', body: { goalId: g1.id, investmentPositionId: inv.id, allocationType: 'percentage', allocationValue: 70, linkedInvestmentId: inv.id } });
    const rB = await app('/api/investment-intelligence/goal-allocations', { cookie: userA.cookie, method: 'POST', body: { goalId: g2.id, investmentPositionId: inv.id, allocationType: 'percentage', allocationValue: 30, linkedInvestmentId: inv.id } });
    const indepAtCap = (70 + 30) > 100; // false: exactly 100%, must NOT be rejected
    reconcile('RECONCILE-R9-12', 'Allocation cap boundary at exactly 100% (70%+30%) must NOT be rejected (indepAtCap=false means "does not exceed")', indepAtCap, rB.status === 409, indepAtCap === (rB.status === 409));
  }

  // =========================================================================
  // SUMMARY
  // =========================================================================
  console.log('\n--- LIVE CASES SUMMARY ---');
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const blocked = results.filter((r) => r.status === 'BLOCKED').length;
  console.log(`PASS=${pass} FAIL=${fail} BLOCKED=${blocked} (of ${results.length} recorded cases across 20 LIVE-R9 scenarios)`);

  console.log('\n--- RECONCILIATION SUMMARY ---');
  const rMatch = reconciliations.filter((r) => r.match).length;
  const rMismatch = reconciliations.filter((r) => !r.match).length;
  console.log(`MATCH=${rMatch} MISMATCH=${rMismatch} (of ${reconciliations.length} independent reconciliations, target 12)`);

  fs.writeFileSync(path.join(__dirname, 'ii-r9-live-cert-results.json'), JSON.stringify({ ranAt: new Date().toISOString(), stamp, results, reconciliations, cleanup: { users: cleanup.users.map((u) => u.id), instruments: cleanup.instruments } }, null, 2));

  // =========================================================================
  // CLEANUP — delete every test user (cascades through every FK'd table) and
  // the standalone ii_instruments rows (no user_id, don't cascade), then
  // INDEPENDENTLY RE-VERIFY the deletion actually worked by re-querying.
  // =========================================================================
  console.log('\n--- CLEANUP ---');
  for (const inst of cleanup.instruments) {
    await sb(`/rest/v1/ii_instruments?id=eq.${inst}`, { method: 'DELETE' });
  }
  for (const u of cleanup.users) {
    const del = await sb(`/auth/v1/admin/users/${u.id}`, { method: 'DELETE' });
    console.log(`deleted user ${u.tag} (${u.id}): HTTP ${del.status}`);
  }

  console.log('\n--- CLEANUP VERIFICATION (independent re-query, not assumed) ---');
  let cleanupOk = true;
  for (const u of cleanup.users) {
    const userCheck = await sb(`/auth/v1/admin/users/${u.id}`);
    const invCheck = await sb(`/rest/v1/investments?user_id=eq.${u.id}&select=id`);
    const goalCheck = await sb(`/rest/v1/user_goals?user_id=eq.${u.id}&select=id`);
    const reviewCheck = await sb(`/rest/v1/ii_review_items?user_id=eq.${u.id}&select=id`);
    const allocCheck = await sb(`/rest/v1/ii_goal_allocations?user_id=eq.${u.id}&select=id`);
    const fundingCheck = await sb(`/rest/v1/goal_funding_sources?user_id=eq.${u.id}&select=id`);
    const ok = userCheck.status === 404 && (invCheck.json ?? []).length === 0 && (goalCheck.json ?? []).length === 0 && (reviewCheck.json ?? []).length === 0 && (allocCheck.json ?? []).length === 0 && (fundingCheck.json ?? []).length === 0;
    cleanupOk = cleanupOk && ok;
    console.log(`  ${ok ? 'CONFIRMED' : 'FAILED'} cleanup for ${u.tag} (${u.id}): auth user lookup HTTP ${userCheck.status} (expect 404), investments=${(invCheck.json ?? []).length}, goals=${(goalCheck.json ?? []).length}, review_items=${(reviewCheck.json ?? []).length}, goal_allocations=${(allocCheck.json ?? []).length}, funding_sources=${(fundingCheck.json ?? []).length} (all expect 0)`);
  }
  for (const inst of cleanup.instruments) {
    const instCheck = await sb(`/rest/v1/ii_instruments?id=eq.${inst}&select=id`);
    const ok = (instCheck.json ?? []).length === 0;
    cleanupOk = cleanupOk && ok;
    console.log(`  ${ok ? 'CONFIRMED' : 'FAILED'} instrument ${inst} deleted: rows visible=${(instCheck.json ?? []).length}`);
  }
  console.log(`\nCLEANUP ${cleanupOk ? 'FULLY VERIFIED' : 'INCOMPLETE — SEE ABOVE'}`);

  console.log('\n=== DONE ===');
}

main().catch((e) => {
  console.error('HARNESS FAILURE:', e.stack ?? e.message);
  process.exitCode = 1;
});
