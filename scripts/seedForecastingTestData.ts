/**
 * FHIP Forecasting Engine — 50-case test-data seed script, rewritten against
 * the REAL repository schema (see the schema audit referenced in memory
 * `recommendations_engine_v2.md` and the Forecasting Engine migrations under
 * supabase/migrations/0001-0020). Supersedes the generic placeholder
 * template the user supplied (`User tests/forecasting test/seed_forecasting_test_data.ts`),
 * which targeted table/column names (`user_profiles.scenario_id`,
 * `monthly_snapshots`, `goal_investment_links`, etc.) that do not exist in
 * this codebase.
 *
 * Known schema gaps versus what the test pack's JSON assumes (documented
 * here rather than adding new migrations just to satisfy a test — see
 * "SCHEMA GAPS" below for the reasoning):
 *   - No `duplicate_of_investment_id` / `exclude_from_calculations` /
 *     `record_status` columns exist on `investments` (or anywhere) — the
 *     TC090 "duplicate investment" scenario cannot be represented as a
 *     first-class DB state. Both TC090 investment rows are still seeded
 *     (so the case isn't silently dropped), but neither is marked excluded.
 *   - No `debt_reduction_plans` table exists — a liability's own `balance` /
 *     `monthly_repayment` already cover the "current plan"; the JSON's
 *     `additional_monthly_repayment` concept is a forecast-run-time API
 *     parameter (`additionalMonthlyRepayment`), not persisted data, so
 *     `debt_plans` rows are not seeded.
 *   - "Planned events" have no persisted table in this app at all — they're
 *     a validated request parameter to POST /api/forecast/run
 *     (`planned_events`), never written to a table. `planned_events` rows
 *     are not seeded; exercising them means passing them at forecast-run
 *     time via the API, not via this script.
 *   - Only ONE aggregate monthly history table exists (`financial_snapshots`
 *     — total_assets/total_liabilities/net_worth/monthly_income/expenses/
 *     surplus/savings_rate), not the 7 granular historical_* tables the
 *     JSON provides (historical_income/_expenses/_assets/_liabilities/
 *     _investments/_retirement/_goals). Only `historical_monthly` is
 *     seeded, into `financial_snapshots`.
 *   - India-specific retirement item_keys (EPF/PPF/NPS) don't exist in the
 *     seeded master_financial_items catalogue — retirement account_type is
 *     drawn from the same generic pool for both countries (documented, not
 *     silently faked).
 *
 * Usage:
 *   npx tsx scripts/seedForecastingTestData.ts [--dry-run] [--cases=TC001,TC003] [--cleanup] [--history-only]
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Deterministic UUID v5-style id derived from a seed string, so re-running
// this script against the same JSON always produces the same primary keys
// (idempotent upserts) for rows the JSON itself doesn't already assign a
// UUID to (offset-account companion assets, per-scenario forecast_scenarios/
// forecast_assumptions rows split out of one JSON row into several).
function deterministicUuid(seed: string): string {
  const hash = crypto.createHash('sha1').update(seed).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${(['8', '9', 'a', 'b'][parseInt(hash[16], 16) % 4])}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

const envText = fs.readFileSync(path.resolve('.env.local'), 'utf8');
for (const line of envText.split(/\r?\n/)) {
  if (!line.includes('=') || line.trim().startsWith('#')) continue;
  const idx = line.indexOf('=');
  const key = line.slice(0, idx).trim();
  const value = line.slice(idx + 1).trim();
  if (!process.env[key]) process.env[key] = value;
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (checked .env.local).');

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const cleanup = args.includes('--cleanup');
const historyOnly = args.includes('--history-only');
const casesArg = args.find((a) => a.startsWith('--cases='));
const selectedCases: Set<string> | null = casesArg ? new Set(casesArg.replace('--cases=', '').split(',').map((v) => v.trim())) : null;
const jsonPath = args.find((a) => !a.startsWith('--')) ?? path.resolve('User tests/forecasting test/FHIP_Forecasting_50_Case_Test_Data.json');

type Row = Record<string, unknown>;
const pkg: Record<string, Row[] | Row> = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

function rows(key: string): Row[] {
  const value = pkg[key];
  if (!Array.isArray(value)) return [];
  if (!selectedCases) return value;
  return value.filter((r) => !r.scenario_id || selectedCases.has(String(r.scenario_id)));
}

const COUNTRY_CODE: Record<string, string> = { Australia: 'AU', India: 'IN' };

// Deterministic pseudo-random index selection keyed by a row's own id, so
// reruns of the same JSON always produce the same enum assignment (stable
// test data) without needing a persisted "chosen value" anywhere.
function stableIndex(seed: string, poolSize: number): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return hash % poolSize;
}
// pick() alone can collide: two rows for the SAME user can hash to the same
// pool entry, which violates this schema's per-user unique(master_item_key)
// constraint on assets/investments/retirement_accounts/liabilities (only
// surfaced once scaled from the 2-case dry run to all 50 real users). Tracks
// keys already assigned per (userId, table) and linear-probes forward from
// the hash-selected start for the first unused entry, falling back to a
// wider superset pool (e.g. ASSET_ALL_ITEMS) if the narrow subtype pool is
// exhausted, and only reusing a key as an absolute last resort.
const usedItemKeys = new Map<string, Set<string>>();
function pickUnique(userId: string, table: string, seed: string, pool: readonly string[], fallbackPool?: readonly string[]): string {
  const mapKey = `${userId}:${table}`;
  let used = usedItemKeys.get(mapKey);
  if (!used) {
    used = new Set();
    usedItemKeys.set(mapKey, used);
  }
  const start = stableIndex(seed, pool.length);
  for (let i = 0; i < pool.length; i++) {
    const candidate = pool[(start + i) % pool.length];
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  if (fallbackPool) {
    const fallbackStart = stableIndex(seed, fallbackPool.length);
    for (let i = 0; i < fallbackPool.length; i++) {
      const candidate = fallbackPool[(fallbackStart + i) % fallbackPool.length];
      if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
  }
  const fallback = pool[start];
  used.add(fallback);
  return fallback;
}

// Real controlled vocabularies, taken from master_financial_items
// (seed_master_items.sql) — assets/investments/retirement/liabilities have
// no DB-level enum, so these are the app's actual real-world category
// labels. Distributed randomly (not collapsed to a single "other" value)
// per the explicit instruction to exercise every real data point.
const ASSET_CASH_ITEMS = ['wallet_cash', 'savings_account', 'cheque_account', 'offset_account', 'term_deposits', 'foreign_currency'] as const;
const ASSET_PROPERTY_ITEMS = ['principal_residence', 'investment_property', 'holiday_home', 'vacant_land', 'commercial_property', 'farm'] as const;
const ASSET_ALL_ITEMS = [
  'wallet_cash', 'savings_account', 'cheque_account', 'offset_account', 'term_deposits', 'foreign_currency', 'gold', 'silver',
  'cryptocurrency', 'shares', 'etfs', 'managed_funds', 'bonds', 'private_equity', 'business_ownership', 'partnership_interest',
  'smsf_balance', 'industry_super', 'retail_super', 'defined_benefit', 'investment_property', 'principal_residence', 'holiday_home',
  'vacant_land', 'commercial_property', 'farm', 'motor_vehicle', 'motorcycle', 'boat', 'caravan', 'collectables', 'jewellery', 'art',
  'watches', 'wine_collection', 'intellectual_property', 'loans_receivable', 'trust_assets', 'other_assets',
] as const;
const INVESTMENT_ETF_ITEMS = ['etfs', 'index_funds', 'australian_shares', 'international_shares'] as const;
const INVESTMENT_ALL_ITEMS = [
  'australian_shares', 'international_shares', 'etfs', 'managed_funds', 'index_funds', 'bonds', 'government_bonds', 'corporate_bonds',
  'cash_investments', 'high_interest_savings', 'term_deposits', 'property', 'commercial_property', 'reits', 'private_equity',
  'angel_investments', 'venture_capital', 'cryptocurrency', 'gold', 'silver', 'commodities', 'collectibles', 'options', 'futures',
  'forex', 'business_investment', 'partnership_investment', 'trust_investment', 'smsf_investments', 'education_fund',
  'children_investment', 'other_investments',
] as const;
const RETIREMENT_ITEMS = [
  'industry_super', 'retail_super', 'smsf', 'defined_benefit', 'employer_contributions', 'salary_sacrifice', 'personal_concessional',
  'non_concessional', 'spouse_contribution', 'government_co_contribution', 'transition_to_retirement', 'allocated_pension',
  'account_based_pension', 'annuity', 'overseas_pension', 'retirement_savings', 'other_retirement_assets',
] as const;
const LIABILITY_HOME_ITEMS = ['home_loan', 'investment_loan', 'construction_loan'] as const;
const LIABILITY_REVOLVING_ITEMS = ['credit_card', 'store_card', 'line_of_credit', 'buy_now_pay_later'] as const;
const LIABILITY_ALL_ITEMS = [
  'home_loan', 'investment_loan', 'construction_loan', 'personal_loan', 'car_loan', 'motorcycle_loan', 'boat_loan', 'education_loan',
  'hecs_help', 'credit_card', 'store_card', 'margin_loan', 'business_loan', 'tax_debt', 'ato_payment_plan', 'family_loan',
  'private_loan', 'buy_now_pay_later', 'medical_loan', 'mortgage_offset_facility', 'line_of_credit', 'guarantees', 'other_liabilities',
] as const;

function assetItemKey(userId: string, row: Row): string {
  const type = String(row.asset_type ?? '');
  const id = String(row.asset_id);
  if (type === 'Cash') return pickUnique(userId, 'assets', id, ASSET_CASH_ITEMS, ASSET_ALL_ITEMS);
  if (type === 'Property') return pickUnique(userId, 'assets', id, ASSET_PROPERTY_ITEMS, ASSET_ALL_ITEMS);
  return pickUnique(userId, 'assets', id, ASSET_ALL_ITEMS);
}
function investmentItemKey(userId: string, row: Row): string {
  const type = String(row.investment_type ?? '');
  const id = String(row.investment_id);
  if (type === 'ETF' || type === 'Index Fund') return pickUnique(userId, 'investments', id, INVESTMENT_ETF_ITEMS, INVESTMENT_ALL_ITEMS);
  return pickUnique(userId, 'investments', id, INVESTMENT_ALL_ITEMS);
}
function retirementItemKey(userId: string, row: Row): string {
  return pickUnique(userId, 'retirement_accounts', String(row.retirement_account_id), RETIREMENT_ITEMS);
}
function liabilityItemKey(userId: string, row: Row): string {
  const type = String(row.liability_type ?? '');
  const id = String(row.liability_id);
  if (type === 'Home Loan') return pickUnique(userId, 'liabilities', id, LIABILITY_HOME_ITEMS, LIABILITY_ALL_ITEMS);
  if (type === 'Credit Card') return pickUnique(userId, 'liabilities', id, LIABILITY_REVOLVING_ITEMS, LIABILITY_ALL_ITEMS);
  return pickUnique(userId, 'liabilities', id, LIABILITY_ALL_ITEMS);
}

async function upsert(table: string, batch: Row[], onConflict?: string) {
  if (batch.length === 0) return;
  if (dryRun) {
    console.log(`[dry-run] ${table}: ${batch.length} rows`);
    return;
  }
  const { error } = onConflict
    ? await supabase.from(table).upsert(batch, { onConflict })
    : await supabase.from(table).upsert(batch);
  if (error) throw new Error(`${table}: ${error.message}`);
  console.log(`${table}: upserted ${batch.length} rows`);
}

async function ensureAuthUsers(userRows: Row[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const u of userRows) {
    const scenarioId = String(u.scenario_id);
    const desiredId = String(u.user_id);
    const email = String(u.email);

    const { data: existingByEmail } = await supabase.auth.admin.listUsers();
    const existing = existingByEmail.users.find((au) => au.email === email);
    if (existing) {
      map.set(scenarioId, existing.id);
      continue;
    }
    if (dryRun) {
      map.set(scenarioId, desiredId);
      console.log(`[dry-run] create auth user ${scenarioId} ${email}`);
      continue;
    }
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password: String(u.password),
      email_confirm: true,
      user_metadata: { scenario_id: scenarioId, synthetic_test_user: true },
    });
    if (error || !data.user) throw new Error(`create user ${scenarioId} (${email}): ${error?.message}`);
    map.set(scenarioId, data.user.id);
  }
  return map;
}

async function seedUsersAndProfiles(userRows: Row[], userIdMap: Map<string, string>) {
  const profiles: Row[] = [];
  const households: Row[] = [];
  for (const u of userRows) {
    const scenarioId = String(u.scenario_id);
    const userId = userIdMap.get(scenarioId);
    if (!userId) continue;
    const countryCode = COUNTRY_CODE[String(u.country)] ?? 'AU';
    profiles.push({
      user_id: userId,
      full_name: u.display_name,
      country_of_residence: countryCode,
      preferred_currency: u.reporting_currency,
      onboarding_completed: true,
      profile_completion_percentage: 100,
    });
    households.push({
      user_id: userId,
      household_name: `${u.display_name} Household`,
      household_type: u.household_type === 'Single' ? 'single' : 'family',
      primary_country: countryCode,
    });
  }
  await upsert('user_profiles', profiles, 'user_id');
  // households has no unique constraint on user_id, so it can't use
  // .upsert(onConflict:'user_id') — check-then-insert/update instead, only
  // ever creating one household per seeded test user.
  for (const h of households) {
    if (dryRun) {
      console.log(`[dry-run] households: 1 row (user ${h.user_id})`);
      continue;
    }
    const { data: existing } = await supabase.from('households').select('id').eq('user_id', h.user_id).maybeSingle();
    if (existing) {
      const { error } = await supabase.from('households').update(h).eq('id', existing.id);
      if (error) throw new Error(`households update: ${error.message}`);
    } else {
      const { error } = await supabase.from('households').insert(h);
      if (error) throw new Error(`households insert: ${error.message}`);
    }
  }
  if (!dryRun) console.log(`households: upserted ${households.length} rows`);
}

async function seedIncome(rows_: Row[], userIdMap: Map<string, string>) {
  const batch = rows_.map((r) => ({
    id: r.income_id,
    user_id: userIdMap.get(String(r.scenario_id)),
    source_name: r.income_source,
    income_type: String(r.income_type).toLowerCase(),
    amount: r.gross_amount,
    net_amount: r.net_amount,
    frequency: String(r.frequency).toLowerCase(),
    currency_code: r.currency,
    owner: 'self',
    is_active: r.record_state === 'active',
  }));
  await upsert('income_sources', batch, 'id');
}

async function seedExpenses(rows_: Row[], userIdMap: Map<string, string>) {
  const batch = rows_.map((r) => ({
    id: r.expense_id,
    user_id: userIdMap.get(String(r.scenario_id)),
    expense_name: r.expense_category,
    expense_category: r.expense_category,
    amount: r.amount,
    frequency: String(r.frequency).toLowerCase(),
    currency_code: r.currency,
    owner: 'self',
    is_essential: r.classification === 'Core',
    is_active: r.record_state === 'active',
  }));
  await upsert('expense_items', batch, 'id');
}

async function seedAssets(rows_: Row[], userIdMap: Map<string, string>) {
  const batch: Row[] = [];
  for (const r of rows_) {
    const userId = userIdMap.get(String(r.scenario_id)) ?? '';
    const itemKey = assetItemKey(userId, r);
    batch.push({
      id: r.asset_id,
      user_id: userId,
      asset_name: r.asset_name,
      asset_class: itemKey,
      master_item_key: itemKey,
      current_value: r.current_value,
      currency_code: r.currency,
      country_code: COUNTRY_CODE[String(r.country)] ?? 'AU',
      valuation_date: r.valuation_date,
      owner: 'self',
      is_active: r.record_state === 'active',
    });
  }
  await upsert('assets', batch, 'id');
}

async function seedInvestments(rows_: Row[], userIdMap: Map<string, string>) {
  const batch: Row[] = [];
  for (const r of rows_) {
    const userId = userIdMap.get(String(r.scenario_id)) ?? '';
    const itemKey = investmentItemKey(userId, r);
    const riskLevel = String(r.risk_level ?? '');
    const riskProfile = riskLevel === 'High' ? 'growth' : riskLevel === 'Medium' ? 'balanced' : riskLevel === 'Low' ? 'conservative' : 'unknown';
    batch.push({
      id: r.investment_id,
      user_id: userId,
      investment_name: r.investment_name,
      investment_type: itemKey,
      master_item_key: itemKey,
      current_value: r.current_value,
      currency_code: r.currency,
      country_code: COUNTRY_CODE[String(r.country)] ?? 'AU',
      annual_contribution: Number(r.monthly_contribution ?? 0) * 12,
      risk_profile: riskProfile,
      owner: 'self',
      // duplicate_of_investment_id / exclude_from_calculations are not real
      // columns in this schema (see SCHEMA GAPS above) — TC090's second
      // "duplicate" row is still seeded as a normal active investment.
      is_active: r.record_status === 'active',
    });
  }
  await upsert('investments', batch, 'id');
}

async function seedRetirementAccounts(rows_: Row[], userIdMap: Map<string, string>) {
  const batch: Row[] = [];
  for (const r of rows_) {
    const userId = userIdMap.get(String(r.scenario_id)) ?? '';
    const itemKey = retirementItemKey(userId, r);
    batch.push({
      id: r.retirement_account_id,
      user_id: userId,
      account_name: r.account_name,
      account_type: itemKey,
      master_item_key: itemKey,
      current_balance: r.current_balance,
      currency_code: r.currency,
      country_code: COUNTRY_CODE[String(r.country)] ?? 'AU',
      employer_contribution: r.monthly_employer_contribution,
      personal_contribution: r.monthly_personal_contribution,
      contribution_frequency: 'monthly',
      owner: 'self',
      is_active: r.include_in_net_worth !== false,
    });
  }
  await upsert('retirement_accounts', batch, 'id');
}

async function seedLiabilities(rows_: Row[], userIdMap: Map<string, string>) {
  const batch: Row[] = [];
  for (const r of rows_) {
    const userId = userIdMap.get(String(r.scenario_id)) ?? '';
    const itemKey = liabilityItemKey(userId, r);
    batch.push({
      id: r.liability_id,
      user_id: userId,
      liability_name: r.liability_name,
      debt_type: itemKey,
      master_item_key: itemKey,
      balance: r.current_balance,
      interest_rate: Number(r.interest_rate_pct ?? 0) * 100,
      monthly_repayment: r.actual_monthly_payment ?? r.minimum_monthly_payment ?? 0,
      currency_code: r.currency,
      country_code: COUNTRY_CODE[String(r.country)] ?? 'AU',
      owner: 'self',
      is_active: r.record_status === 'active',
    });
    // No offset-balance column exists on liabilities (see SCHEMA GAPS).
    // Originally this seeded a companion "offset_account" asset row, but that
    // double-counts against the JSON's own actual_till_date net-worth
    // expectation (its net worth math already assumes no separate offset
    // asset and the liability's full un-netted balance) — found via a live
    // Playwright reconciliation failure, not by inspection. offset_balance
    // is genuinely unrepresentable in this schema without either double
    // counting it as an asset or understating the real debt principal by
    // reducing liabilities.balance — so it is intentionally not seeded at
    // all rather than seeded incorrectly.
  }
  await upsert('liabilities', batch, 'id');
}

async function seedGoals(rows_: Row[], userIdMap: Map<string, string>) {
  const IMPORTANCE: Record<string, string> = { High: 'essential', Medium: 'important', Low: 'aspirational' };
  const batch = rows_.map((r) => ({
    id: r.goal_id,
    user_id: userIdMap.get(String(r.scenario_id)),
    goal_name: r.goal_name,
    goal_type: r.goal_type,
    target_amount: r.target_amount,
    current_amount: r.current_amount,
    currency_code: r.currency,
    target_date: r.target_date,
    priority: String(r.priority ?? 'medium').toLowerCase(),
    status: r.status,
    contribution_start_date: r.start_date,
    importance_type: IMPORTANCE[String(r.priority)] ?? 'important',
    inflation_adjusted: Boolean(r.inflation_linked),
  }));
  await upsert('user_goals', batch, 'id');
}

async function seedGoalFundingSources(rows_: Row[], userIdMap: Map<string, string>, investmentsById: Map<string, Row>) {
  const batch = rows_.map((r) => {
    const investment = investmentsById.get(String(r.investment_id));
    const currentValue = Number(investment?.current_value ?? 0);
    const allocationFraction = Number(r.allocation_percentage ?? 0); // JSON uses a 0-1 fraction
    return {
      id: r.goal_investment_link_id,
      goal_id: r.goal_id,
      user_id: userIdMap.get(String(r.scenario_id)),
      source_type: 'investment',
      linked_investment_id: r.investment_id,
      allocated_amount: Math.round(currentValue * allocationFraction * 100) / 100,
      allocation_percentage: Math.round(allocationFraction * 100 * 100) / 100, // DB column is 0-100 scale
      currency_code: investment?.currency_code,
      is_active: true,
    };
  });
  await upsert('goal_funding_sources', batch, 'id');
}

async function seedInsurance(rows_: Row[], userIdMap: Map<string, string>) {
  const batch = rows_.map((r) => ({
    id: r.insurance_id,
    user_id: userIdMap.get(String(r.scenario_id)),
    policy_name: r.policy_type ?? 'Insurance Policy',
    cover_type: r.policy_type,
    cover_amount: r.cover_amount ?? 0,
    premium: r.premium_monthly ?? 0,
    premium_frequency: 'monthly',
    currency_code: r.currency,
    owner: 'self',
    is_active: r.data_state !== 'inactive',
  }));
  await upsert('insurance_policies', batch, 'id');
}

async function seedForecastProfilesAndScenarios(rows_: Row[], userIdMap: Map<string, string>) {
  const profileByScenarioId = new Map<string, Row>();
  const batch: Row[] = [];
  for (const r of rows_) {
    const scenarioId = String(r.scenario_id);
    const userId = userIdMap.get(scenarioId);
    if (!userId) continue;
    const row = {
      id: r.forecast_profile_id,
      user_id: userId,
      name: r.profile_name,
      base_currency: r.base_currency,
      country_code: r.country_code,
      forecast_start_date: r.forecast_start_date,
      forecast_end_date: r.forecast_end_date,
      retirement_age: r.retirement_age,
      status: 'active',
    };
    batch.push(row);
    profileByScenarioId.set(scenarioId, row);
  }
  await upsert('forecast_profiles', batch, 'id');
  return profileByScenarioId;
}

const SCENARIO_TYPE: Record<string, string> = { Base: 'base', Conservative: 'conservative', Optimistic: 'optimistic' };

async function seedForecastScenariosAndAssumptions(assumptionRows_: Row[], userIdMap: Map<string, string>, profileByScenarioId: Map<string, Row>) {
  const scenarioBatch: Row[] = [];
  const scenarioDbIdByKey = new Map<string, string>(); // `${scenarioId}:${scenario_name}` -> forecast_scenarios.id
  for (const r of assumptionRows_) {
    const scenarioId = String(r.scenario_id);
    const profile = profileByScenarioId.get(scenarioId);
    const userId = userIdMap.get(scenarioId);
    if (!profile || !userId) continue;
    const scenarioType = SCENARIO_TYPE[String(r.scenario_name)] ?? 'custom';
    const dbId = deterministicUuid(`forecast-scenario:${r.assumption_id}`);
    scenarioBatch.push({
      id: dbId,
      user_id: userId,
      forecast_profile_id: profile.id,
      scenario_name: r.scenario_name,
      scenario_type: scenarioType,
      is_default: scenarioType === 'base',
      is_active: true,
    });
    scenarioDbIdByKey.set(`${scenarioId}:${r.scenario_name}`, dbId);
  }
  await upsert('forecast_scenarios', scenarioBatch, 'id');

  // Map the JSON's 9-field simplified scenario model onto the app's real,
  // named assumption keys — only the fields with a genuine real-world
  // equivalent are overridden per scenario; everything else falls back to
  // the country's global default (see SCHEMA GAPS: savings_multiplier and
  // expense_shock_pct have no equivalent assumption_key in this app).
  const assumptionBatch: Row[] = [];
  for (const r of assumptionRows_) {
    const scenarioId = String(r.scenario_id);
    const profile = profileByScenarioId.get(scenarioId);
    const userId = userIdMap.get(scenarioId);
    const scenarioDbId = scenarioDbIdByKey.get(`${scenarioId}:${r.scenario_name}`);
    if (!profile || !userId || !scenarioDbId) continue;

    const investmentReturnPct = Number(r.investment_return_pct ?? 0) * 100;
    const overrides: { category: string; key: string; value: number; valueType: string }[] = [
      { category: 'general', key: 'salary_growth', value: Number(r.income_growth_pct ?? 0) * 100, valueType: 'percentage' },
      { category: 'general', key: 'general_inflation', value: Number(r.inflation_pct ?? 0) * 100, valueType: 'percentage' },
      { category: 'general', key: 'property_growth', value: Number(r.property_growth_pct ?? 0) * 100, valueType: 'percentage' },
      { category: 'investment_return', key: 'equity', value: investmentReturnPct, valueType: 'percentage' },
      { category: 'investment_return', key: 'retirement', value: Number(r.retirement_return_pct ?? 0) * 100, valueType: 'percentage' },
      { category: 'investment_return', key: 'cash', value: round2(investmentReturnPct * 0.5), valueType: 'percentage' },
      { category: 'investment_return', key: 'fixed_interest', value: round2(investmentReturnPct * 0.6), valueType: 'percentage' },
      { category: 'fx', key: 'fx_drift_aud_inr', value: Number(r.fx_change_pct ?? 0) * 100, valueType: 'percentage' },
    ];
    for (const o of overrides) {
      assumptionBatch.push({
        id: deterministicUuid(`forecast-assumption:${r.assumption_id}:${o.key}`),
        user_id: userId,
        forecast_profile_id: profile.id,
        scenario_id: scenarioDbId,
        assumption_category: o.category,
        assumption_key: o.key,
        assumption_value: o.value,
        value_type: o.valueType,
        source_type: 'scenario_default',
        source_reference: 'Forecasting test pack scenario_assumptions',
      });
    }
  }
  await upsert('forecast_assumptions', assumptionBatch, 'id');
  return scenarioDbIdByKey;
}

function monthsBetweenDates(fromIso: string, toIso: string): number {
  const from = new Date(fromIso + 'T00:00:00Z');
  const to = new Date(toIso + 'T00:00:00Z');
  return (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
}

// Seeds the ORIGINAL forecast_runs/forecast_results rows directly from the
// JSON's own variance_expected + forecast_expected arrays, rather than
// requiring the app to "Generate forecast" live (which would always baseline
// from today, not the historical baseline_date the test oracle assumes).
// Without this, getForecastVariance finds no completed run and reports
// insufficient_data — this is what makes the ten historical variance cases
// (and the Variance Report generally) actually reconcile against the
// supplied test oracle instead of showing whatever the app happens to
// compute from "today".
async function seedOriginalForecastRuns(
  varianceExpectedRows: Row[],
  forecastExpectedRows: Row[],
  userIdMap: Map<string, string>,
  profileByScenarioId: Map<string, Row>,
  scenarioDbIdByKey: Map<string, string>
) {
  const runBatch: Row[] = [];
  const resultBatch: Row[] = [];

  for (const v of varianceExpectedRows) {
    const scenarioId = String(v.scenario_id);
    const userId = userIdMap.get(scenarioId);
    const profile = profileByScenarioId.get(scenarioId);
    const baseScenarioDbId = scenarioDbIdByKey.get(`${scenarioId}:Base`);
    if (!userId || !profile || !baseScenarioDbId) continue;

    const category = String(v.forecast_category);
    const startValue = Number(v.start_value ?? 0);
    const forecastTillDate = Number(v.forecast_till_date ?? 0);
    // A "Not Applicable" cross_border row (all zeros — this user has no
    // cross-border assets at all) is a real, legitimate "no data" case —
    // seeding a fake zero-value baseline for it would be less correct than
    // simply not seeding one, so getForecastVariance reports
    // insufficient_data exactly as it would for a real user with no
    // cross-border holdings.
    if (startValue === 0 && forecastTillDate === 0 && Number(v.actual_till_date ?? 0) === 0) continue;

    const baselineDate = String(v.baseline_date);
    const comparisonDate = String(v.comparison_date);
    const monthsSinceBaseline = Math.max(1, monthsBetweenDates(baselineDate, comparisonDate));

    const forecastExpectedRow = forecastExpectedRows.find(
      (f) => f.scenario_id === scenarioId && f.forecast_category === category && f.scenario_type === 'base'
    );
    const finalValue = Number(forecastExpectedRow?.forecast_10_year_or_retirement ?? forecastTillDate);
    const finalTarget = forecastExpectedRow?.final_target_value != null ? Number(forecastExpectedRow.final_target_value) : null;

    const runId = deterministicUuid(`forecast-run:${scenarioId}:${category}`);
    runBatch.push({
      id: runId,
      user_id: userId,
      forecast_profile_id: profile.id,
      scenario_id: baseScenarioDbId,
      forecast_type: category,
      baseline_date: baselineDate,
      calculation_date: baselineDate,
      period_start: baselineDate,
      period_end: addMonths(baselineDate, 120),
      status: 'completed',
      engine_version: 'forecast-1.0.0-test-seed',
      completed_at: new Date().toISOString(),
    });

    const entityType = category === 'net_worth' ? 'portfolio' : category === 'cross_border' ? 'cross_border_portfolio' : category;
    resultBatch.push({
      id: deterministicUuid(`forecast-result:${scenarioId}:${category}:1`),
      user_id: userId,
      forecast_run_id: runId,
      forecast_type: category,
      entity_type: entityType,
      period_date: addMonths(baselineDate, 1),
      period_number: 1,
      opening_value: startValue,
      closing_value: startValue,
      currency: v.reporting_currency,
    });
    if (monthsSinceBaseline !== 1) {
      resultBatch.push({
        id: deterministicUuid(`forecast-result:${scenarioId}:${category}:${monthsSinceBaseline}`),
        user_id: userId,
        forecast_run_id: runId,
        forecast_type: category,
        entity_type: entityType,
        period_date: addMonths(baselineDate, monthsSinceBaseline),
        period_number: monthsSinceBaseline,
        opening_value: forecastTillDate,
        closing_value: forecastTillDate,
        currency: v.reporting_currency,
      });
    }
    if (monthsSinceBaseline !== 120) {
      resultBatch.push({
        id: deterministicUuid(`forecast-result:${scenarioId}:${category}:120`),
        user_id: userId,
        forecast_run_id: runId,
        forecast_type: category,
        entity_type: entityType,
        period_date: addMonths(baselineDate, 120),
        period_number: 120,
        opening_value: finalValue,
        closing_value: finalValue,
        target_value: finalTarget,
        currency: v.reporting_currency,
      });
    }
  }

  await upsert('forecast_runs', runBatch, 'id');
  await upsert('forecast_results', resultBatch, 'id');
}

function addMonths(dateIso: string, months: number): string {
  const d = new Date(dateIso + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function seedHistoricalSnapshots(rows_: Row[], userIdMap: Map<string, string>) {
  const batch = rows_.map((r) => ({
    user_id: userIdMap.get(String(r.scenario_id)),
    snapshot_month: r.snapshot_month,
    total_assets: r.total_assets,
    total_liabilities: r.total_liabilities,
    net_worth: r.net_worth,
    monthly_income: r.gross_income,
    monthly_expenses: r.total_expenses,
    monthly_surplus: r.monthly_surplus,
    savings_rate: r.savings_rate_pct,
    currency_code: r.reporting_currency,
  }));
  await upsert('financial_snapshots', batch, 'user_id,snapshot_month');
}

async function seedRecommendationLibrary(masterRows_: Row[], conditionRows_: Row[]) {
  function splitList(v: unknown): string[] {
    const s = String(v ?? '').trim();
    return s === '' ? [] : s.split(';').map((x) => x.trim()).filter(Boolean);
  }
  const masterBatch = masterRows_.map((r) => ({
    recommendation_code: r.recommendation_code,
    forecast_category: r.forecast_category,
    sub_category: r.sub_category,
    scenario_name: r.scenario_name,
    scenario_description: r.scenario_description || null,
    variance_result: r.variance_result || null,
    forecast_status: r.forecast_status,
    severity: r.severity,
    action_type: r.action_type,
    action_title_template: r.action_title_template,
    action_content_template: r.action_content_template,
    financial_impact_template: r.financial_impact_template || null,
    calculation_method_code: r.calculation_method_code || null,
    required_input_fields: splitList(r.required_input_fields),
    supported_placeholders: splitList(r.supported_placeholders),
    priority_score: r.priority_score ?? 0,
    country_code: r.country_code || null,
    currency_code: r.currency_code || null,
    customer_segment: r.customer_segment || 'base',
    effective_from: r.effective_from || null,
    effective_to: r.effective_to || null,
    is_active: r.is_active ?? true,
    requires_ai: r.requires_ai ?? false,
    version_number: r.version_number ?? 1,
    admin_notes: r.admin_notes || null,
    include_in_forecasting: r.forecast_category !== 'data_quality',
    include_in_monthly_report: r.forecast_category === 'data_quality',
  }));
  await upsert('action_recommendation_master', masterBatch, 'recommendation_code');

  if (!dryRun) {
    const codes = [...new Set(conditionRows_.map((r) => String(r.recommendation_code)))];
    if (codes.length > 0) {
      const { error } = await supabase.from('action_recommendation_conditions').delete().in('recommendation_code', codes);
      if (error) throw new Error(`clearing existing test conditions: ${error.message}`);
    }
  }
  const conditionBatch = conditionRows_.map((r) => ({
    recommendation_code: r.recommendation_code,
    condition_group: r.condition_group ?? 1,
    field_name: r.field_name,
    operator: r.operator || 'equals',
    comparison_value: r.comparison_value || null,
    comparison_value_2: r.comparison_value_2 || null,
    data_type: r.data_type || 'text',
    logical_operator: r.logical_operator || 'AND',
    evaluation_order: r.evaluation_order ?? 1,
    is_active: r.is_active ?? true,
  }));
  if (dryRun) {
    console.log(`[dry-run] action_recommendation_conditions: ${conditionBatch.length} rows`);
  } else if (conditionBatch.length > 0) {
    const { error } = await supabase.from('action_recommendation_conditions').insert(conditionBatch);
    if (error) throw new Error(`action_recommendation_conditions: ${error.message}`);
    console.log(`action_recommendation_conditions: inserted ${conditionBatch.length} rows`);
  }
}

async function cleanupSelectedCases(userIdMap: Map<string, string>) {
  const userIds = [...userIdMap.values()];
  const tables = [
    'goal_funding_sources', 'user_goals', 'forecast_assumptions', 'forecast_scenarios', 'forecast_profiles',
    'financial_snapshots', 'insurance_policies', 'liabilities', 'retirement_accounts', 'investments', 'assets',
    'expense_items', 'income_sources', 'households',
  ];
  for (const table of tables) {
    if (dryRun) {
      console.log(`[dry-run] delete ${table} for ${userIds.length} users`);
      continue;
    }
    const { error } = await supabase.from(table).delete().in('user_id', userIds);
    if (error && error.code !== '42P01') console.warn(`cleanup warning ${table}: ${error.message}`);
  }
  console.log('Domain data cleanup completed for selected cases. Auth users retained.');
}

async function main() {
  const userRows = rows('users');
  const userIdMap = await ensureAuthUsers(userRows);

  if (cleanup) {
    await cleanupSelectedCases(userIdMap);
    return;
  }

  if (!historyOnly) {
    await seedUsersAndProfiles(userRows, userIdMap);
    await seedIncome(rows('current_income'), userIdMap);
    await seedExpenses(rows('current_expenses'), userIdMap);
    await seedAssets(rows('current_assets'), userIdMap);
    await seedInvestments(rows('investments'), userIdMap);
    await seedRetirementAccounts(rows('retirement_accounts'), userIdMap);
    await seedLiabilities(rows('liabilities'), userIdMap);
    await seedInsurance(rows('insurance_records'), userIdMap);
    await seedGoals(rows('goals'), userIdMap);

    const investmentsById = new Map(rows('investments').map((r) => [String(r.investment_id), r]));
    await seedGoalFundingSources(rows('goal_links'), userIdMap, investmentsById);

    const profileByScenarioId = await seedForecastProfilesAndScenarios(rows('forecast_profiles'), userIdMap);
    const scenarioDbIdByKey = await seedForecastScenariosAndAssumptions(rows('scenario_assumptions'), userIdMap, profileByScenarioId);
    await seedOriginalForecastRuns(rows('variance_expected'), rows('forecast_expected'), userIdMap, profileByScenarioId, scenarioDbIdByKey);

    await seedRecommendationLibrary(rows('recommendation_master'), rows('recommendation_conditions'));
  }

  await seedHistoricalSnapshots(rows('historical_monthly'), userIdMap);

  console.log('Seed completed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
