import { createClient } from '@/lib/supabase/server';
import { loadDashboard, getLatestSnapshotAsOf, type LatestSnapshot } from '@/lib/services/dashboardData';
import { resolveAssumptions, getAssumptionValue, type RawForecastAssumption, type RawGlobalAssumption } from '@/lib/engines/forecast/assumptions';
import { runForecastCalculation, computeForecastInputHash, isForecastTypeSupported, FORECAST_ENGINE_VERSION } from '@/lib/engines/forecast/engine';
import type { NetWorthCalculatorInput, PlannedFinancialEvent } from '@/lib/engines/forecast/netWorthCalculator';
import { round2 } from '@/lib/engines/forecast/monthlyPrimitives';
import type { GoalCalculatorInput } from '@/lib/engines/forecast/goalCalculator';
import type { InvestmentCalculatorInput } from '@/lib/engines/forecast/investmentCalculator';
import type { DebtCalculatorInput } from '@/lib/engines/forecast/debtCalculator';
import type { RetirementCalculatorInput, RetirementTargetMethod } from '@/lib/engines/forecast/retirementCalculator';
import type { CrossBorderCalculatorInput } from '@/lib/engines/forecast/crossBorderCalculator';
import type { ResilienceCalculatorInput } from '@/lib/engines/forecast/resilienceCalculator';
import { applyStressScenario, type StressScenarioType, type StressScenarioParams } from '@/lib/engines/resilienceStress';
import { computeAccessibleLiquidResources, type CommitmentRow } from '@/lib/engines/resilience';
import type { ForecastType, ResolvedAssumptionSet } from '@/lib/engines/forecast/types';
import type { ForecastAssumptionUpsertInput, ForecastScenarioInput } from '@/lib/validation/forecast';
import { isPlausibleDob } from '@/lib/engines/age';
import { toMonthly, type Frequency } from '@/lib/engines/money';
import { convertToReportingCurrency } from '@/lib/engines/fx';
import { computeAllocatedMonthlyContribution, type AllocatedContributionInvestment, type AllocatedContributionRetirementAccount } from '@/lib/services/goalFundingAllocation';

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

const DEFAULT_MONTHS = 120; // 10 years, matches the longest Forecast Overview horizon in the spec

export async function getOrCreateForecastProfile(userId: string, client?: SupabaseServerClient) {
  const supabase = client ?? (await createClient());

  const { data: existing } = await supabase
    .from('forecast_profiles')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existing) return existing;

  const { data: profileRow } = await supabase
    .from('user_profiles')
    .select('preferred_currency, country_of_residence')
    .eq('user_id', userId)
    .single();

  const { data: created, error } = await supabase
    .from('forecast_profiles')
    .insert({
      user_id: userId,
      name: 'My Forecast',
      base_currency: profileRow?.preferred_currency ?? 'AUD',
      country_code: profileRow?.country_of_residence ?? null,
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return created;
}

export async function ensureDefaultScenario(userId: string, profileId: string, client?: SupabaseServerClient) {
  const supabase = client ?? (await createClient());

  const { data: existing } = await supabase
    .from('forecast_scenarios')
    .select('*')
    .eq('forecast_profile_id', profileId)
    .eq('is_default', true)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();
  if (existing) return existing;

  const { data: created, error } = await supabase
    .from('forecast_scenarios')
    .insert({
      user_id: userId,
      forecast_profile_id: profileId,
      scenario_name: 'Base scenario',
      scenario_type: 'base',
      description: 'Default forecast scenario using current assumptions.',
      is_default: true,
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);

  await supabase.from('forecast_profiles').update({ default_scenario_id: created.id }).eq('id', profileId);
  return created;
}

export async function listScenarios(userId: string, profileId: string, client?: SupabaseServerClient) {
  const supabase = client ?? (await createClient());
  const { data, error } = await supabase
    .from('forecast_scenarios')
    .select('*')
    .eq('user_id', userId)
    .eq('forecast_profile_id', profileId)
    .eq('is_active', true)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function createScenario(userId: string, profileId: string, input: ForecastScenarioInput, client?: SupabaseServerClient) {
  const supabase = client ?? (await createClient());
  const { data, error } = await supabase
    .from('forecast_scenarios')
    .insert({
      user_id: userId,
      forecast_profile_id: profileId,
      scenario_name: input.scenario_name,
      scenario_type: input.scenario_type,
      description: input.description ?? null,
      is_default: input.is_default ?? false,
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

// Deltas applied to the Base scenario's resolved values when a Conservative
// or Optimistic scenario is first created, so switching scenarios actually
// changes the forecast rather than silently reusing Base's numbers. Only
// applied once, at creation — a user (or a test-data seed) that later edits
// these scenario-scoped assumptions directly is never overwritten, since
// this only fires when the scenario didn't exist yet.
const CONSERVATIVE_DELTAS: Record<string, number> = {
  cash: -0.5,
  fixed_interest: -1,
  equity: -2,
  property: -1,
  retirement: -1.5,
  general_inflation: 0.5,
  withdrawal_rate: -0.5,
};
const OPTIMISTIC_DELTAS: Record<string, number> = {
  cash: 0.5,
  fixed_interest: 1,
  equity: 2,
  property: 1,
  retirement: 1.5,
  general_inflation: -0.5,
  withdrawal_rate: 0.5,
};

async function seedScenarioDeltas(
  userId: string,
  profileId: string,
  scenarioId: string,
  baseAssumptions: ResolvedAssumptionSet,
  deltas: Record<string, number>,
  supabase: SupabaseServerClient
) {
  for (const [key, delta] of Object.entries(deltas)) {
    const base = baseAssumptions[key];
    if (!base) continue; // key not resolved for this profile (e.g. no country default) — nothing to offset
    await upsertUserAssumption(
      userId,
      profileId,
      {
        scenario_id: scenarioId,
        assumption_category: base.category,
        assumption_key: key,
        assumption_value: round2(base.value + delta),
        value_type: base.valueType,
        unit: base.unit ?? undefined,
        notes: 'Auto-generated scenario delta from Base',
      },
      supabase
    );
  }
}

// Ensures a profile has all three standard scenarios (Base, Conservative,
// Optimistic) with Conservative/Optimistic actually differentiated from
// Base — Custom scenarios remain fully user-authored, never auto-seeded.
export async function ensureStandardScenarios(userId: string, profileId: string, client?: SupabaseServerClient) {
  const supabase = client ?? (await createClient());
  const base = await ensureDefaultScenario(userId, profileId, supabase);
  const existing = await listScenarios(userId, profileId, supabase);

  let conservative = existing.find((s) => s.scenario_type === 'conservative');
  let optimistic = existing.find((s) => s.scenario_type === 'optimistic');

  const baseAssumptions = !conservative || !optimistic ? await getResolvedAssumptions(userId, profileId, base.id, supabase) : null;

  if (!conservative) {
    conservative = await createScenario(
      userId,
      profileId,
      { scenario_name: 'Conservative', scenario_type: 'conservative', description: 'Lower assumed returns, higher inflation than Base.' },
      supabase
    );
    await seedScenarioDeltas(userId, profileId, conservative.id, baseAssumptions!, CONSERVATIVE_DELTAS, supabase);
  }
  if (!optimistic) {
    optimistic = await createScenario(
      userId,
      profileId,
      { scenario_name: 'Optimistic', scenario_type: 'optimistic', description: 'Higher assumed returns, lower inflation than Base.' },
      supabase
    );
    await seedScenarioDeltas(userId, profileId, optimistic.id, baseAssumptions!, OPTIMISTIC_DELTAS, supabase);
  }

  return { base, conservative, optimistic, all: await listScenarios(userId, profileId, supabase) };
}

// Shared by every dedicated forecast page: ensures the 3 standard scenarios
// exist, then resolves which one is "active" from the page's ?scenario=
// query param — falling back to Base if the param is missing or doesn't
// belong to this user (e.g. a stale/tampered link), never trusting the
// param blindly as a valid scenario id.
export async function resolveForecastPageContext(userId: string, requestedScenarioId: string | undefined, client?: SupabaseServerClient) {
  const supabase = client ?? (await createClient());
  const profile = await getOrCreateForecastProfile(userId, supabase);
  const { base, all: scenarios } = await ensureStandardScenarios(userId, profile.id, supabase);
  const activeScenario = (requestedScenarioId && scenarios.find((s) => s.id === requestedScenarioId)) || base;
  return { profile, scenarios, activeScenario };
}

async function loadResolvedAssumptions(
  userId: string,
  profileId: string,
  scenarioId: string,
  countryCode: string | null,
  supabase: SupabaseServerClient
): Promise<ResolvedAssumptionSet> {
  const [profileAssumptions, globalAssumptions] = await Promise.all([
    supabase
      .from('forecast_assumptions')
      .select('scenario_id, assumption_category, assumption_key, assumption_value, value_type, unit, source_reference')
      .eq('user_id', userId)
      .eq('forecast_profile_id', profileId)
      .is('effective_to', null),
    supabase
      .from('forecast_global_assumptions')
      .select('country_code, assumption_category, assumption_key, assumption_value, value_type, unit, source_reference')
      .eq('is_active', true),
  ]);
  if (profileAssumptions.error) throw new Error(profileAssumptions.error.message);
  if (globalAssumptions.error) throw new Error(globalAssumptions.error.message);

  return resolveAssumptions({
    scenarioId,
    countryCode,
    profileAssumptions: (profileAssumptions.data ?? []) as RawForecastAssumption[],
    globalAssumptions: (globalAssumptions.data ?? []) as RawGlobalAssumption[],
  });
}

export async function getResolvedAssumptions(userId: string, profileId: string, scenarioId: string, client?: SupabaseServerClient) {
  const supabase = client ?? (await createClient());
  const { data: profile } = await supabase.from('forecast_profiles').select('country_code').eq('id', profileId).single();
  return loadResolvedAssumptions(userId, profileId, scenarioId, profile?.country_code ?? null, supabase);
}

// Phase 1 keeps one active override per (profile, scenario, key) rather than
// full effective-dated versioning — closes out any existing open-ended row
// for the same key before inserting the new one, so getResolvedAssumptions()
// never sees two live overrides for the same key.
export async function upsertUserAssumption(
  userId: string,
  profileId: string,
  input: ForecastAssumptionUpsertInput,
  client?: SupabaseServerClient
) {
  const supabase = client ?? (await createClient());
  const scenarioId = input.scenario_id ?? null;

  let existingQuery = supabase
    .from('forecast_assumptions')
    .select('id')
    .eq('user_id', userId)
    .eq('forecast_profile_id', profileId)
    .eq('assumption_key', input.assumption_key)
    .is('effective_to', null);
  existingQuery = scenarioId ? existingQuery.eq('scenario_id', scenarioId) : existingQuery.is('scenario_id', null);
  const { data: existingRows } = await existingQuery;

  if (existingRows && existingRows.length > 0) {
    await supabase
      .from('forecast_assumptions')
      .update({ effective_to: new Date().toISOString().slice(0, 10) })
      .in(
        'id',
        existingRows.map((r) => r.id)
      );
  }

  const { data: created, error } = await supabase
    .from('forecast_assumptions')
    .insert({
      user_id: userId,
      forecast_profile_id: profileId,
      scenario_id: scenarioId,
      assumption_category: input.assumption_category,
      assumption_key: input.assumption_key,
      assumption_value: input.assumption_value,
      value_type: input.value_type ?? 'percentage',
      unit: input.unit ?? null,
      source_type: 'user_override',
      user_override: true,
      notes: input.notes ?? null,
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return created;
}

interface RetirementRunOptions {
  targetMethod: RetirementTargetMethod;
  targetCorpus?: number;
  desiredAnnualIncome?: number;
  replacementPercentage?: number;
}

interface ResilienceRunOptions {
  stressScenario?: StressScenarioType;
  stressParams?: StressScenarioParams;
}

// The `months` a caller asks for defaults to 120 (10 years — right for
// net worth's 1/5/10-year horizon), but retirement forecasts genuinely need
// to run out to the user's retirement age plus a post-retirement buffer, or
// balanceAtRetirement inside retirementCalculator.ts silently falls back to
// whatever balance the truncated loop happened to reach at month 120 instead
// of the real retirement date — so buildCalculatorInput returns the actual
// month count it used (effectiveMonths) alongside the calculator input, and
// every caller must use that value for period_end / hashing, not the
// original request.
const RETIREMENT_POST_RETIREMENT_BUFFER_MONTHS = 240; // 20 years, for depletion-date estimates
const MAX_FORECAST_MONTHS = 600; // matches forecastRunRequestSchema's ceiling

interface CalculatorInputResult {
  input:
    | NetWorthCalculatorInput
    | GoalCalculatorInput
    | InvestmentCalculatorInput
    | DebtCalculatorInput
    | RetirementCalculatorInput
    | CrossBorderCalculatorInput
    | ResilienceCalculatorInput;
  effectiveMonths: number;
}

async function buildCalculatorInput(
  forecastType: ForecastType,
  userId: string,
  profile: Awaited<ReturnType<typeof getOrCreateForecastProfile>>,
  assumptions: ResolvedAssumptionSet,
  baselineDate: string,
  months: number,
  supabase: SupabaseServerClient,
  additionalMonthlyRepayment: number,
  retirementOptions: RetirementRunOptions,
  plannedEvents: PlannedFinancialEvent[],
  resilienceOptions: ResilienceRunOptions
): Promise<CalculatorInputResult> {
  if (forecastType === 'resilience') {
    // Forecasting P1 fix FHIP-FC-RES-001 — commitments were previously
    // hardcoded to [] here (never queried), and openingLiquidAssets used the
    // raw liquidAssets bucket instead of the same accessible-after-
    // commitments figure applyStressScenario already computes internally
    // (computeAccessibleLiquidResources, shared with the current-state
    // resilience score in resilience.ts) — together these could show a
    // cash-rich household as already depleted at the start of a stress
    // scenario. Real commitments + the already-tested accessible figure
    // fixes both without inventing new calculation logic.
    const [dashboard, commitmentsRes] = await Promise.all([
      loadDashboard(userId, supabase),
      supabase.from('future_financial_commitments').select('amount, due_date, is_mandatory').eq('user_id', userId).eq('is_active', true),
    ]);
    const commitments = (commitmentsRes.data ?? []) as CommitmentRow[];
    const scenario = resilienceOptions.stressScenario;
    const shockResult = scenario ? applyStressScenario(dashboard, scenario, commitments, resilienceOptions.stressParams) : null;
    const shocked = shockResult?.shockedDashboard ?? dashboard;
    const openingLiquidAssets = shockResult
      ? shockResult.after.accessibleLiquidResources
      : computeAccessibleLiquidResources(dashboard, commitments).accessible;

    const input: ResilienceCalculatorInput = {
      baselineDate,
      months,
      assumptions,
      currency: dashboard.currency,
      openingLiquidAssets,
      openingOtherAssets: shocked.totalAssets - shocked.liquidAssets,
      openingInvestments: shocked.totalInvestments,
      openingRetirement: shocked.totalRetirement,
      openingLiabilities: dashboard.totalLiabilities,
      monthlyEssentialExpenses: dashboard.essentialMonthlyExpenses,
      baselineMonthlySurplus: dashboard.monthlySurplus,
      shockedMonthlySurplus: shocked.monthlySurplus,
      shockDurationMonths: shockResult?.durationMonths ?? null,
      scenarioLabel: shockResult?.label ?? 'Baseline (no stress)',
      monthlyLoanRepayment: dashboard.debtMonthlyRepayments,
      baselineNetWorthAtStart: dashboard.netWorth,
      baselineRetirementAtStart: dashboard.totalRetirement,
    };
    return { input, effectiveMonths: months };
  }

  if (forecastType === 'cross_border') {
    const reportingCurrency: 'AUD' | 'INR' = profile.base_currency;
    const foreignCurrency: 'AUD' | 'INR' = reportingCurrency === 'AUD' ? 'INR' : 'AUD';

    const [assetsResult, investmentsResult, liabilitiesResult, retirementResult] = await Promise.all([
      supabase.from('assets').select('current_value').eq('user_id', userId).eq('is_active', true).eq('currency_code', foreignCurrency),
      supabase
        .from('investments')
        .select('current_value, annual_contribution')
        .eq('user_id', userId)
        .eq('is_active', true)
        .eq('currency_code', foreignCurrency),
      supabase
        .from('liabilities')
        .select('balance, monthly_repayment')
        .eq('user_id', userId)
        .eq('is_active', true)
        .eq('currency_code', foreignCurrency),
      supabase
        .from('retirement_accounts')
        .select('current_balance, employer_contribution, personal_contribution, contribution_frequency')
        .eq('user_id', userId)
        .eq('is_active', true)
        .eq('currency_code', foreignCurrency),
    ]);
    if (assetsResult.error) throw new Error(assetsResult.error.message);
    if (investmentsResult.error) throw new Error(investmentsResult.error.message);
    if (liabilitiesResult.error) throw new Error(liabilitiesResult.error.message);
    if (retirementResult.error) throw new Error(retirementResult.error.message);

    const CONTRIBUTION_FREQUENCY_TO_MONTHLY: Record<string, number> = {
      weekly: 52 / 12,
      fortnightly: 26 / 12,
      monthly: 1,
      quarterly: 1 / 3,
      annually: 1 / 12,
    };
    const foreignAssets = (assetsResult.data ?? []).reduce((sum, a) => sum + a.current_value, 0);
    const foreignInvestments = (investmentsResult.data ?? []).reduce((sum, i) => sum + i.current_value, 0);
    const foreignInvestmentMonthlyContribution = (investmentsResult.data ?? []).reduce((sum, i) => sum + (i.annual_contribution ?? 0) / 12, 0);
    const foreignLiabilities = (liabilitiesResult.data ?? []).reduce((sum, l) => sum + l.balance, 0);
    const foreignLiabilityMonthlyRepayment = (liabilitiesResult.data ?? []).reduce((sum, l) => sum + (l.monthly_repayment ?? 0), 0);
    const foreignRetirement = (retirementResult.data ?? []).reduce((sum, r) => sum + (r.current_balance ?? 0), 0);
    const foreignRetirementMonthlyContribution = (retirementResult.data ?? []).reduce((sum, r) => {
      const factor = CONTRIBUTION_FREQUENCY_TO_MONTHLY[r.contribution_frequency ?? 'monthly'] ?? 1;
      return sum + ((r.employer_contribution ?? 0) + (r.personal_contribution ?? 0)) * factor;
    }, 0);

    const input: CrossBorderCalculatorInput = {
      baselineDate,
      months,
      assumptions,
      reportingCurrency,
      foreignCurrency,
      openingForeignAssets: foreignAssets,
      openingForeignInvestments: foreignInvestments,
      openingForeignRetirement: foreignRetirement,
      openingForeignLiabilities: foreignLiabilities,
      monthlyForeignAssetContribution: 0,
      monthlyForeignInvestmentContribution: foreignInvestmentMonthlyContribution,
      monthlyForeignRetirementContribution: foreignRetirementMonthlyContribution,
      monthlyForeignLoanRepayment: foreignLiabilityMonthlyRepayment,
    };
    return { input, effectiveMonths: months };
  }

  if (forecastType === 'retirement') {
    const [accountsResult, dobResult] = await Promise.all([
      supabase
        .from('retirement_accounts')
        .select('current_balance, employer_contribution, personal_contribution, contribution_frequency, currency_code')
        .eq('user_id', userId)
        .eq('is_active', true),
      supabase.from('user_profiles').select('date_of_birth').eq('user_id', userId).single(),
    ]);
    if (accountsResult.error) throw new Error(accountsResult.error.message);
    const accounts = accountsResult.data ?? [];
    // FHIP_50_User_Report_Accuracy_Validation_Review P0 finding: this used
    // to sum each account's current_balance/contributions raw, regardless of
    // currency_code, then labelled the sum with whichever account happened
    // to be first in the array — a cross-border household with e.g. 216,600
    // AUD + 1,100,000 INR + 30,000 AUD retirement accounts got "1,346,600"
    // stamped AUD, overstating the true ~265,566 AUD position by over 1M.
    // Convert every account to the forecast's reporting currency (same
    // helper + same fx_rate_aud_inr assumption dashboard.ts's canonical
    // totalRetirement already uses) before summing, so this starting
    // balance can never again drift from the correctly-converted canonical
    // figure shown elsewhere in the same report.
    const retirementReportingCurrency: 'AUD' | 'INR' = profile.base_currency;
    const retirementFxRateAudInr = getAssumptionValue(assumptions, 'fx_rate_aud_inr', 56);
    const toRetirementReportingCurrency = (amount: number, rowCurrencyCode: string | null | undefined) => {
      const rowCurrency = rowCurrencyCode === 'AUD' || rowCurrencyCode === 'INR' ? rowCurrencyCode : retirementReportingCurrency;
      return convertToReportingCurrency(amount, rowCurrency, retirementReportingCurrency, retirementFxRateAudInr);
    };
    const currentBalance = accounts.reduce((sum, a) => sum + toRetirementReportingCurrency(a.current_balance ?? 0, a.currency_code), 0);
    const CONTRIBUTION_FREQUENCY_TO_MONTHLY: Record<string, number> = {
      weekly: 52 / 12,
      fortnightly: 26 / 12,
      monthly: 1,
      quarterly: 1 / 3,
      annually: 1 / 12,
    };
    const monthlyContribution = accounts.reduce((sum, a) => {
      const factor = CONTRIBUTION_FREQUENCY_TO_MONTHLY[a.contribution_frequency ?? 'monthly'] ?? 1;
      const convertedContribution = toRetirementReportingCurrency((a.employer_contribution ?? 0) + (a.personal_contribution ?? 0), a.currency_code);
      return sum + convertedContribution * factor;
    }, 0);
    const currency = retirementReportingCurrency;

    // Forecasting P1 fix FHIP-FC-RET-001 — timing hierarchy:
    // (1) forecast_profiles.retirement_date -> months = explicit date diff (most precise;
    //     stands alone, does NOT require a DOB — knowing the exact retirement date already
    //     gives months-until-retirement with no need to derive current age at all. An
    //     earlier version of this fix incorrectly gated this tier behind DOB being present,
    //     which defeated its purpose as an independent, more-precise signal — caught live
    //     testing TC003 (no DOB on file, retirement_date alone was silently ignored).
    // (2) DOB (plausible) + retirement_age -> existing age-based calculation, computed inside
    //     the calculator itself (no override passed)
    // (3) forecast_profiles.retirement_timing_override_months -> manual fallback, used only
    //     when there's no retirement_date AND no plausible DOB to derive currentAge from
    // (4) none of the above -> monthsUntilRetirement stays null; the calculator already
    //     surfaces "could not be projected" rather than failing
    const dobRaw = dobResult.data?.date_of_birth as string | null | undefined;
    const baselineAsOf = new Date(baselineDate + 'T00:00:00Z');
    const dobPlausible = isPlausibleDob(dobRaw ?? null, baselineAsOf);
    let currentAge: number | null = null;
    if (dobRaw && dobPlausible) {
      const dob = new Date(dobRaw + 'T00:00:00Z');
      currentAge = (baselineAsOf.getUTCFullYear() - dob.getUTCFullYear()) + (baselineAsOf.getUTCMonth() - dob.getUTCMonth()) / 12;
    }
    const retirementAge = profile.retirement_age ?? getAssumptionValue(assumptions, 'retirement_age', 65);

    let monthsUntilRetirementOverride: number | null = null;
    if (profile.retirement_date) {
      const target = new Date(profile.retirement_date + 'T00:00:00Z');
      monthsUntilRetirementOverride = Math.max(
        0,
        (target.getUTCFullYear() - baselineAsOf.getUTCFullYear()) * 12 + (target.getUTCMonth() - baselineAsOf.getUTCMonth())
      );
    } else if (currentAge === null && profile.retirement_timing_override_months != null) {
      monthsUntilRetirementOverride = Math.max(0, profile.retirement_timing_override_months);
    }
    const monthsUntilRetirement =
      monthsUntilRetirementOverride ?? (currentAge !== null ? Math.max(0, Math.round((retirementAge - currentAge) * 12)) : null);
    const effectiveMonths =
      monthsUntilRetirement !== null
        ? Math.max(months, Math.min(MAX_FORECAST_MONTHS, monthsUntilRetirement + RETIREMENT_POST_RETIREMENT_BUFFER_MONTHS))
        : months;

    const dashboard = await loadDashboard(userId, supabase);
    const input: RetirementCalculatorInput = {
      baselineDate,
      months: effectiveMonths,
      assumptions,
      currency,
      currentBalance,
      monthlyContribution,
      currentAge,
      retirementAge,
      monthsUntilRetirementOverride,
      targetMethod: retirementOptions.targetMethod,
      targetCorpus: retirementOptions.targetCorpus,
      desiredAnnualIncome: retirementOptions.desiredAnnualIncome,
      currentAnnualEssentialExpenses: dashboard.essentialMonthlyExpenses * 12,
      replacementPercentage: retirementOptions.replacementPercentage,
    };
    return { input, effectiveMonths };
  }

  if (forecastType === 'debt') {
    // interest_rate_type/fixed_rate_expiry/credit_limit added for
    // FHIP-FC-DEBT-001/002/003's risk ranking — already existed on
    // liabilities (used elsewhere, e.g. dashboard.ts's variable-rate/
    // credit-utilization ratios), just weren't selected here before.
    const { data: liabilities, error } = await supabase
      .from('liabilities')
      .select('id, liability_name, balance, interest_rate, monthly_repayment, debt_type, currency_code, interest_rate_type, fixed_rate_expiry, credit_limit')
      .eq('user_id', userId)
      .eq('is_active', true);
    if (error) throw new Error(error.message);
    const input: DebtCalculatorInput = {
      baselineDate,
      months,
      assumptions,
      additionalMonthlyRepayment,
      liabilities: (liabilities ?? []).map((l) => ({
        id: l.id,
        name: l.liability_name,
        currentBalance: l.balance,
        annualInterestRatePercent: l.interest_rate ?? 0,
        monthlyRepayment: l.monthly_repayment ?? 0,
        debtType: l.debt_type,
        currency: l.currency_code,
        interestRateType: l.interest_rate_type ?? null,
        fixedRateExpiry: l.fixed_rate_expiry ?? null,
        creditLimit: l.credit_limit ?? null,
      })),
    };
    return { input, effectiveMonths: months };
  }

  if (forecastType === 'goal') {
    // Forecasting P1 fix FHIP-FC-GOAL-001 — contribution_frequency wasn't
    // even selected here before (planned_contribution_amount was treated as
    // already-monthly regardless of its actual frequency), and funding
    // sources' allocated share of a linked investment/retirement account's
    // own contribution was never added — same bug/fix as
    // goalsData.ts's toGoalRecord()/computeGoalsPagePayload(), mirrored here
    // for this persisted-run code path.
    const { data: goals, error } = await supabase
      .from('user_goals')
      .select('id, goal_name, current_amount, target_amount, target_date, currency_code, planned_contribution_amount, contribution_frequency')
      .eq('user_id', userId)
      .eq('status', 'active');
    if (error) throw new Error(error.message);
    const goalIds = (goals ?? []).map((g) => g.id as string);

    const fundingSourcesByGoal = new Map<string, { source_type: string; linked_investment_id: string | null; linked_retirement_id: string | null; allocation_percentage: number | null }[]>();
    if (goalIds.length > 0) {
      const { data: sources } = await supabase
        .from('goal_funding_sources')
        .select('goal_id, source_type, linked_investment_id, linked_retirement_id, allocation_percentage')
        .eq('user_id', userId)
        .eq('is_active', true)
        .in('goal_id', goalIds);
      for (const s of sources ?? []) {
        const list = fundingSourcesByGoal.get(s.goal_id as string) ?? [];
        list.push(s);
        fundingSourcesByGoal.set(s.goal_id as string, list);
      }
    }
    const investmentIds = new Set<string>();
    const retirementIds = new Set<string>();
    for (const list of fundingSourcesByGoal.values()) {
      for (const s of list) {
        if (s.source_type === 'investment' && s.linked_investment_id) investmentIds.add(s.linked_investment_id);
        if (s.source_type === 'retirement' && s.linked_retirement_id) retirementIds.add(s.linked_retirement_id);
      }
    }
    const investmentsById = new Map<string, AllocatedContributionInvestment>();
    const retirementAccountsById = new Map<string, AllocatedContributionRetirementAccount>();
    if (investmentIds.size > 0) {
      const { data } = await supabase.from('investments').select('id, annual_contribution').eq('user_id', userId).in('id', Array.from(investmentIds));
      for (const row of data ?? []) investmentsById.set(row.id, { annualContribution: row.annual_contribution ?? null });
    }
    if (retirementIds.size > 0) {
      const { data } = await supabase
        .from('retirement_accounts')
        .select('id, employer_contribution, personal_contribution, contribution_frequency')
        .eq('user_id', userId)
        .in('id', Array.from(retirementIds));
      for (const row of data ?? [])
        retirementAccountsById.set(row.id, {
          employerContribution: row.employer_contribution ?? null,
          personalContribution: row.personal_contribution ?? null,
          contributionFrequency: row.contribution_frequency ?? null,
        });
    }

    const input: GoalCalculatorInput = {
      baselineDate,
      months,
      assumptions,
      goals: (goals ?? []).map((g) => {
        const allocated = computeAllocatedMonthlyContribution(
          (fundingSourcesByGoal.get(g.id as string) ?? []).map((s) => ({
            sourceType: s.source_type,
            linkedInvestmentId: s.linked_investment_id,
            linkedRetirementId: s.linked_retirement_id,
            allocationPercentage: s.allocation_percentage,
          })),
          investmentsById,
          retirementAccountsById
        );
        return {
          id: g.id,
          name: g.goal_name,
          currentAmount: g.current_amount ?? 0,
          targetAmount: g.target_amount,
          targetDate: g.target_date,
          monthlyContribution: toMonthly(g.planned_contribution_amount ?? 0, (g.contribution_frequency as Frequency) ?? 'monthly') + allocated,
          currency: g.currency_code,
        };
      }),
    };
    return { input, effectiveMonths: months };
  }

  if (forecastType === 'investment') {
    // master_item_key added for FHIP-FC-INV-001/002 — see
    // investmentCalculator.ts's resolveAssetClass() for why it's the
    // reliable asset-class signal rather than investment_type.
    const { data: investments, error } = await supabase
      .from('investments')
      .select('id, investment_name, current_value, currency_code, investment_type, master_item_key, annual_contribution')
      .eq('user_id', userId)
      .eq('is_active', true);
    if (error) throw new Error(error.message);
    const input: InvestmentCalculatorInput = {
      baselineDate,
      months,
      assumptions,
      investments: (investments ?? []).map((inv) => ({
        id: inv.id,
        name: inv.investment_name,
        currentValue: inv.current_value,
        monthlyContribution: (inv.annual_contribution ?? 0) / 12,
        investmentType: inv.investment_type,
        masterItemKey: inv.master_item_key ?? null,
        currency: inv.currency_code,
      })),
    };
    return { input, effectiveMonths: months };
  }

  // net_worth (Phase 1's only other supported type)
  const dashboard = await loadDashboard(userId, supabase);
  const netWorthInput: NetWorthCalculatorInput = {
    baselineDate,
    months,
    currency: profile.base_currency,
    openingAssets: dashboard.totalAssets,
    openingInvestments: dashboard.totalInvestments,
    openingRetirement: dashboard.totalRetirement,
    openingLiabilities: dashboard.totalLiabilities,
    // Phase 1 simplification: retirement/investment account contributions
    // grow those balances directly; any remaining monthly surplus is swept
    // into general assets. Avoiding double-counting these against goal
    // funding is a Phase 5 net-worth-reconciliation concern per spec 13.4 —
    // the standalone goal/investment forecasts above are informational
    // projections of those specific balances, not summed into net worth.
    monthlyAssetContribution: Math.max(0, dashboard.monthlySurplus),
    monthlyInvestmentContribution: dashboard.investmentAnnualContribution / 12,
    monthlyRetirementContribution: dashboard.retirementEmployerMonthlyContribution + dashboard.retirementPersonalMonthlyContribution,
    monthlyLoanRepayment: dashboard.debtMonthlyRepayments,
    assumptions,
    plannedEvents,
  };
  return { input: netWorthInput, effectiveMonths: months };
}

export async function runForecast(
  userId: string,
  params: {
    scenarioId?: string;
    forecastType: ForecastType;
    months?: number;
    additionalMonthlyRepayment?: number;
    retirementTargetMethod?: RetirementTargetMethod;
    retirementTargetCorpus?: number;
    retirementDesiredAnnualIncome?: number;
    retirementReplacementPercentage?: number;
    plannedEvents?: PlannedFinancialEvent[];
    resilienceStressScenario?: StressScenarioType;
    resilienceStressParams?: StressScenarioParams;
  },
  client?: SupabaseServerClient
) {
  if (!isForecastTypeSupported(params.forecastType)) {
    throw new Error(`forecast_type "${params.forecastType}" is not implemented yet`);
  }
  const supabase = client ?? (await createClient());
  const months = params.months ?? DEFAULT_MONTHS;

  const profile = await getOrCreateForecastProfile(userId, supabase);
  const scenario = params.scenarioId
    ? (await supabase.from('forecast_scenarios').select('*').eq('id', params.scenarioId).eq('user_id', userId).single()).data
    : await ensureDefaultScenario(userId, profile.id, supabase);
  if (!scenario) throw new Error('Forecast scenario not found');

  const assumptions = await loadResolvedAssumptions(userId, profile.id, scenario.id, profile.country_code, supabase);
  const baselineDate = profile.forecast_start_date ?? new Date().toISOString().slice(0, 10);
  const { input: calculatorInput, effectiveMonths } = await buildCalculatorInput(
    params.forecastType,
    userId,
    profile,
    assumptions,
    baselineDate,
    months,
    supabase,
    params.additionalMonthlyRepayment ?? 0,
    {
      targetMethod: params.retirementTargetMethod ?? 'desired_income',
      targetCorpus: params.retirementTargetCorpus,
      desiredAnnualIncome: params.retirementDesiredAnnualIncome,
      replacementPercentage: params.retirementReplacementPercentage,
    },
    params.plannedEvents ?? [],
    {
      stressScenario: params.resilienceStressScenario,
      stressParams: params.resilienceStressParams,
    }
  );

  const inputHash = computeForecastInputHash({ forecastType: params.forecastType, scenarioId: scenario.id, months: effectiveMonths, calculatorInput });

  const { data: existingRun } = await supabase
    .from('forecast_runs')
    .select('*')
    .eq('user_id', userId)
    .eq('scenario_id', scenario.id)
    .eq('forecast_type', params.forecastType)
    .eq('input_hash', inputHash)
    .eq('engine_version', FORECAST_ENGINE_VERSION)
    .eq('status', 'completed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingRun) return { run: existingRun, reused: true };

  const periodStart = baselineDate;
  const periodEnd = new Date(new Date(baselineDate).setMonth(new Date(baselineDate).getMonth() + effectiveMonths)).toISOString().slice(0, 10);

  const { data: run, error: runError } = await supabase
    .from('forecast_runs')
    .insert({
      user_id: userId,
      forecast_profile_id: profile.id,
      scenario_id: scenario.id,
      forecast_type: params.forecastType,
      baseline_date: baselineDate,
      period_start: periodStart,
      period_end: periodEnd,
      status: 'running',
      input_hash: inputHash,
      engine_version: FORECAST_ENGINE_VERSION,
    })
    .select('*')
    .single();
  if (runError) throw new Error(runError.message);

  try {
    const { results, explanations } = runForecastCalculation(params.forecastType, calculatorInput);

    // II-R10 fix (root-caused this session): forecast_results.variance_percentage
    // is numeric(9,4) (max magnitude 99999.9999) but every calculator computes
    // it as (actual - target) / target * 100 guarded only against target <= 0,
    // never against target being a small-but-positive degenerate value (e.g.
    // a "desired retirement income" target of $1/year -- the Math.max(1, ...)
    // floor forecastReportData.ts uses precisely for a user with no recorded
    // essential expenses yet -- produces a required corpus of ~$25, and any
    // real balance divided by that is a variance percentage in the millions).
    // LIVE-REPRODUCED this session: a real retirement account with a real
    // balance and a plan with no recorded essential-expense data produced
    // variance_percentage=3220488.88 on period 1 alone (466 of ~480 rows
    // affected) -- Postgres rejected the whole INSERT with "numeric field
    // overflow", runForecast() correctly marked the run 'failed' and
    // re-threw, but forecastReportData.ts's safeRunDetail() catches ALL
    // errors silently by design (a category with genuinely no data must not
    // abort the whole report) -- so the Retirement Readiness chapter simply
    // rendered "unavailable" with no error surfaced anywhere, even though
    // the underlying retirement data and forecast trigger were both present
    // and correct.
    //
    // Fix: a variance percentage this large is not a meaningful "N% funded"
    // figure to show a user in the first place (the corpus target itself is
    // degenerate when this happens) -- null it out here, at the single
    // shared persistence point for every forecast type, exactly the same
    // "don't show a nonsensical percentage" principle reportNarrative.ts's
    // computeMetricMovement() already applies for a near-zero comparison
    // base. This is a safe-persistence guard, not a recalculation: the
    // underlying opening/closing/target values are stored completely
    // unchanged; only a percentage that cannot fit its own column (and would
    // not be a meaningful percentage even if it could) is suppressed.
    const VARIANCE_PERCENTAGE_MAX_MAGNITUDE = 99999.9999;
    const safeVariancePercentage = (v: number | null | undefined): number | null =>
      v === null || v === undefined || !Number.isFinite(v) || Math.abs(v) > VARIANCE_PERCENTAGE_MAX_MAGNITUDE ? null : v;

    const resultRows = results.map((r) => ({
      user_id: userId,
      forecast_run_id: run.id,
      forecast_type: r.forecastType,
      entity_type: r.entityType,
      entity_id: r.entityId,
      period_date: r.periodDate,
      period_number: r.periodNumber,
      opening_value: r.openingValue,
      contributions: r.contributions,
      withdrawals: r.withdrawals,
      income: r.income,
      expenses: r.expenses,
      interest: r.interest,
      investment_return: r.investmentReturn,
      fees: r.fees,
      fx_gain_loss: r.fxGainLoss,
      other_movement: r.otherMovement,
      closing_value: r.closingValue,
      target_value: r.targetValue,
      variance_value: r.varianceValue,
      variance_percentage: safeVariancePercentage(r.variancePercentage),
      currency: r.currency,
      base_currency_value: r.baseCurrencyValue,
      metadata: r.metadata,
    }));
    const explanationRows = explanations.map((e) => ({
      user_id: userId,
      forecast_run_id: run.id,
      entity_type: e.entityType,
      entity_id: e.entityId,
      explanation_type: e.explanationType,
      title: e.title,
      explanation_text: e.explanationText,
      calculation_inputs: e.calculationInputs,
      calculation_formula: e.calculationFormula,
      priority: e.priority,
    }));

    const BATCH = 500;
    for (let i = 0; i < resultRows.length; i += BATCH) {
      const { error } = await supabase.from('forecast_results').insert(resultRows.slice(i, i + BATCH));
      if (error) throw new Error(error.message);
    }
    if (explanationRows.length > 0) {
      const { error } = await supabase.from('forecast_explanations').insert(explanationRows);
      if (error) throw new Error(error.message);
    }

    const { data: completedRun, error: completeError } = await supabase
      .from('forecast_runs')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', run.id)
      .select('*')
      .single();
    if (completeError) throw new Error(completeError.message);
    return { run: completedRun, reused: false };
  } catch (err) {
    await supabase
      .from('forecast_runs')
      .update({ status: 'failed', error_message: err instanceof Error ? err.message : String(err) })
      .eq('id', run.id);
    throw err;
  }
}

export async function listForecastRuns(userId: string, profileId: string, client?: SupabaseServerClient) {
  const supabase = client ?? (await createClient());
  const { data, error } = await supabase
    .from('forecast_runs')
    .select('*')
    .eq('user_id', userId)
    .eq('forecast_profile_id', profileId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function getForecastRunDetail(userId: string, runId: string, client?: SupabaseServerClient) {
  const supabase = client ?? (await createClient());
  const [run, results, explanations] = await Promise.all([
    supabase.from('forecast_runs').select('*').eq('id', runId).eq('user_id', userId).single(),
    supabase.from('forecast_results').select('*').eq('forecast_run_id', runId).eq('user_id', userId).order('period_number', { ascending: true }),
    supabase
      .from('forecast_explanations')
      .select('*')
      .eq('forecast_run_id', runId)
      .eq('user_id', userId)
      .order('priority', { ascending: false }),
  ]);
  if (run.error) throw new Error(run.error.message);
  if (results.error) throw new Error(results.error.message);
  if (explanations.error) throw new Error(explanations.error.message);
  return { run: run.data, results: results.data ?? [], explanations: explanations.data ?? [] };
}

function monthsBetweenDates(fromIso: string, toIso: string): number {
  const from = new Date(fromIso + 'T00:00:00Z');
  const to = new Date(toIso + 'T00:00:00Z');
  return (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
}

export interface NetWorthVariance {
  hasOriginal: boolean;
  originalRunId: string | null;
  baselineDate: string | null;
  baselineNetWorth: number | null;
  actualNetWorth: number;
  comparisonDate: string;
  actualIncreaseSinceBaseline: number | null;
  monthsSinceBaseline: number | null;
  originalForecastNetWorthToday: number | null;
  variance: number | null;
  variancePercentage: number | null;
  baselineJustEstablished: boolean;
  forecastHorizonExceeded: boolean;
}

// Spec section 13.6: "Actual increase since baseline", "Original forecast
// net worth today", "Variance" — compares the earliest completed net_worth
// run for this profile+scenario (the retained "Original" forecast, per
// spec 3.1's three-path model) against actual net worth from dashboard.ts.
// Every later run stays untouched in forecast_runs, so "Original" always
// means the first one ever completed, not the most recent.
export async function getNetWorthVariance(
  userId: string,
  profileId: string,
  scenarioId: string,
  client?: SupabaseServerClient
): Promise<NetWorthVariance> {
  const supabase = client ?? (await createClient());
  const today = new Date().toISOString().slice(0, 10);

  const [originalRunResult, dashboard, snapshot] = await Promise.all([
    supabase
      .from('forecast_runs')
      .select('*')
      .eq('user_id', userId)
      .eq('forecast_profile_id', profileId)
      .eq('scenario_id', scenarioId)
      .eq('forecast_type', 'net_worth')
      .eq('status', 'completed')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
    loadDashboard(userId, supabase),
    getLatestSnapshotAsOf(userId, today, supabase),
  ]);

  // Prefer the latest recorded monthly snapshot (a committed, dated figure)
  // over live/present-moment dashboard data — this is what makes "today's
  // actual" a real, disclosed comparison date rather than the moment the
  // page happened to load. Falls back to live dashboard data when no
  // snapshot has been recorded yet (e.g. a brand-new user's very first
  // session, before loadDashboard's own upsert has run).
  const comparisonDate = snapshot?.snapshot_month ?? today;
  const actualNetWorth = snapshot?.net_worth ?? dashboard.netWorth;
  const originalRun = originalRunResult.data;
  if (!originalRun) {
    return {
      hasOriginal: false,
      originalRunId: null,
      baselineDate: null,
      baselineNetWorth: null,
      actualNetWorth,
      comparisonDate,
      actualIncreaseSinceBaseline: null,
      monthsSinceBaseline: null,
      originalForecastNetWorthToday: null,
      variance: null,
      variancePercentage: null,
      baselineJustEstablished: false,
      forecastHorizonExceeded: false,
    };
  }

  const monthsSinceBaseline = Math.max(0, monthsBetweenDates(originalRun.baseline_date, comparisonDate));

  const [firstPeriodResult, comparisonPeriodResult, lastPeriodResult] = await Promise.all([
    supabase.from('forecast_results').select('opening_value').eq('forecast_run_id', originalRun.id).eq('period_number', 1).maybeSingle(),
    supabase
      .from('forecast_results')
      .select('closing_value, period_number')
      .eq('forecast_run_id', originalRun.id)
      .eq('period_number', Math.max(1, monthsSinceBaseline))
      .maybeSingle(),
    supabase.from('forecast_results').select('closing_value, period_number').eq('forecast_run_id', originalRun.id).order('period_number', { ascending: false }).limit(1).maybeSingle(),
  ]);

  const baselineNetWorth = firstPeriodResult.data?.opening_value ?? null;
  const baselineJustEstablished = monthsSinceBaseline === 0;
  // Never silently substitute the final/long-term period for a same-date
  // lookup — only fall back to it when the comparison date genuinely falls
  // beyond this run's forecast horizon, and disclose that via the flag
  // rather than presenting the final value as if it were same-date.
  const forecastHorizonExceeded = !baselineJustEstablished && comparisonPeriodResult.data === null && lastPeriodResult.data !== null;
  const originalForecastNetWorthToday = baselineJustEstablished
    ? baselineNetWorth
    : (comparisonPeriodResult.data?.closing_value ?? lastPeriodResult.data?.closing_value ?? null);

  const actualIncreaseSinceBaseline = baselineNetWorth !== null ? round2(actualNetWorth - baselineNetWorth) : null;
  const variance = !baselineJustEstablished && originalForecastNetWorthToday !== null ? round2(actualNetWorth - originalForecastNetWorthToday) : null;
  const variancePercentage = variance !== null && originalForecastNetWorthToday ? round2((variance / originalForecastNetWorthToday) * 100) : null;

  return {
    hasOriginal: true,
    originalRunId: originalRun.id,
    baselineDate: originalRun.baseline_date,
    baselineNetWorth,
    actualNetWorth,
    comparisonDate,
    actualIncreaseSinceBaseline,
    monthsSinceBaseline,
    originalForecastNetWorthToday,
    variance,
    variancePercentage,
    baselineJustEstablished,
    forecastHorizonExceeded,
  };
}

export interface ScenarioNetWorthComparison {
  scenarioId: string;
  scenarioName: string;
  scenarioType: string;
  runId: string | null;
  oneYear: number | null;
  fiveYear: number | null;
  tenYear: number | null;
}

// Makes the Scenario Manager (built in Phase 1, inert until now) actually
// functional for net worth: runs (or reuses, via the existing input-hash
// dedup) a net_worth forecast for every active scenario and returns a
// 1/5/10-year comparison — spec's "Net-worth scenario comparison".
export async function compareNetWorthAcrossScenarios(userId: string, profileId: string, client?: SupabaseServerClient): Promise<ScenarioNetWorthComparison[]> {
  const supabase = client ?? (await createClient());
  const scenarios = await listScenarios(userId, profileId, supabase);

  const comparisons: ScenarioNetWorthComparison[] = [];
  for (const scenario of scenarios) {
    const { run } = await runForecast(userId, { scenarioId: scenario.id, forecastType: 'net_worth' }, supabase);
    const { data: results } = await supabase
      .from('forecast_results')
      .select('period_number, closing_value')
      .eq('forecast_run_id', run.id)
      .in('period_number', [12, 60, 120]);
    const byPeriod = new Map((results ?? []).map((r) => [r.period_number, r.closing_value]));
    comparisons.push({
      scenarioId: scenario.id,
      scenarioName: scenario.scenario_name,
      scenarioType: scenario.scenario_type,
      runId: run.id,
      oneYear: byPeriod.get(12) ?? null,
      fiveYear: byPeriod.get(60) ?? null,
      tenYear: byPeriod.get(120) ?? null,
    });
  }
  return comparisons;
}

export type VarianceForecastCategory = 'net_worth' | 'retirement' | 'goal' | 'debt' | 'cross_border' | 'investment';
export type VarianceResult = 'favourable' | 'unfavourable' | 'neutral';
export type VarianceStatus =
  | 'significantly_ahead'
  | 'ahead_of_plan'
  | 'on_track'
  | 'slightly_behind'
  | 'at_risk'
  | 'significantly_off_track'
  | 'baseline_established'
  | 'insufficient_data';

export interface CategoryVariance {
  forecastCategory: VarianceForecastCategory;
  hasOriginal: boolean;
  baselineDate: string | null;
  comparisonDate: string;
  // The date financial_snapshots data was actually current as of, when a
  // snapshot informed actualTillDate (net_worth only, today) — distinct from
  // comparisonDate (which the snapshot date normally becomes) and distinct
  // from "report generated at" (kept separately by callers). Null when no
  // snapshot backed the actual value (live/present-moment data was used).
  dataLastUpdated: string | null;
  startValue: number | null;
  forecastTillDate: number | null;
  actualTillDate: number | null;
  varianceAmount: number | null;
  variancePercentage: number | null;
  result: VarianceResult | null;
  status: VarianceStatus;
  finalTarget: number | null;
  revisedForecast: number | null;
  finalTargetGap: number | null;
  primaryDriver: string | null;
  // True only when the comparison date fell beyond the original forecast
  // run's horizon and forecastTillDate had to fall back to the final
  // projected period — callers must disclose this rather than presenting
  // the final period as if it were a genuine same-date value.
  forecastHorizonExceeded: boolean;
}

// Debt is the one category where a lower actual balance is favourable
// (spec: "use inverse favourable logic for debt") — every other category
// treats a higher actual value as favourable.
const HIGHER_IS_BETTER: Record<VarianceForecastCategory, boolean> = {
  net_worth: true,
  retirement: true,
  goal: true,
  debt: false,
  cross_border: true,
  investment: true,
};

// Percentage-driven bands only — callers must handle baseline-established
// (no elapsed comparison period) and zero-denominator cases themselves
// before reaching here, since those aren't expressible as a percentage.
function statusFromSignedPercentage(signedPct: number): VarianceStatus {
  if (signedPct >= 10) return 'significantly_ahead';
  if (signedPct >= 3) return 'ahead_of_plan';
  if (signedPct >= -3) return 'on_track';
  if (signedPct >= -10) return 'slightly_behind';
  if (signedPct >= -25) return 'at_risk';
  return 'significantly_off_track';
}

// Zero forecast denominator (e.g. a debt forecast to be fully repaid, or a
// goal with no target) means a percentage is genuinely Not Applicable, but
// that is not the same as "no data" — the sign/magnitude of the signed
// variance still tells us whether the actual position is favourable,
// unfavourable, or exactly on target.
function statusFromZeroDenominator(signedVariance: number): VarianceStatus {
  if (Math.abs(signedVariance) < 1) return 'on_track'; // both sides genuinely zero, e.g. debt target achieved
  return signedVariance > 0 ? 'ahead_of_plan' : 'significantly_off_track';
}

async function getCurrentActualValue(
  userId: string,
  category: VarianceForecastCategory,
  profile: { base_currency: 'AUD' | 'INR' },
  assumptions: ResolvedAssumptionSet,
  supabase: SupabaseServerClient,
  snapshot: LatestSnapshot | null
): Promise<{ actual: number; target: number | null }> {
  if (category === 'net_worth' || category === 'retirement' || category === 'debt' || category === 'investment') {
    // net_worth prefers the resolved comparison-date snapshot (a committed,
    // dated figure) over live present-moment data — this is what makes the
    // comparison genuinely "same date" rather than nominal. The other three
    // categories have no per-category historical snapshot to draw on (see
    // financial_snapshots' columns), so they remain live/present-moment,
    // consistent with comparisonDate itself falling back to "today" for them.
    if (category === 'net_worth' && snapshot) return { actual: snapshot.net_worth, target: null };
    const dashboard = await loadDashboard(userId, supabase);
    if (category === 'net_worth') return { actual: dashboard.netWorth, target: null };
    if (category === 'retirement') return { actual: dashboard.totalRetirement, target: null };
    if (category === 'investment') return { actual: dashboard.totalInvestments, target: null };
    return { actual: dashboard.totalLiabilities, target: 0 };
  }
  if (category === 'goal') {
    const { data: goals } = await supabase.from('user_goals').select('current_amount, target_amount').eq('user_id', userId).eq('status', 'active');
    const actual = (goals ?? []).reduce((sum, g) => sum + (g.current_amount ?? 0), 0);
    const target = (goals ?? []).reduce((sum, g) => sum + (g.target_amount ?? 0), 0);
    return { actual, target };
  }
  // cross_border — mirrors buildCalculatorInput's cross_border branch, but
  // only needs the live net-foreign-wealth figure, not a full monthly
  // calculator input.
  const reportingCurrency = profile.base_currency;
  const foreignCurrency: 'AUD' | 'INR' = reportingCurrency === 'AUD' ? 'INR' : 'AUD';
  const [assetsResult, investmentsResult, liabilitiesResult, retirementResult] = await Promise.all([
    supabase.from('assets').select('current_value').eq('user_id', userId).eq('is_active', true).eq('currency_code', foreignCurrency),
    supabase.from('investments').select('current_value').eq('user_id', userId).eq('is_active', true).eq('currency_code', foreignCurrency),
    supabase.from('liabilities').select('balance').eq('user_id', userId).eq('is_active', true).eq('currency_code', foreignCurrency),
    supabase.from('retirement_accounts').select('current_balance').eq('user_id', userId).eq('is_active', true).eq('currency_code', foreignCurrency),
  ]);
  const foreignAssets = (assetsResult.data ?? []).reduce((sum, a) => sum + a.current_value, 0);
  const foreignInvestments = (investmentsResult.data ?? []).reduce((sum, i) => sum + i.current_value, 0);
  const foreignRetirement = (retirementResult.data ?? []).reduce((sum, r) => sum + (r.current_balance ?? 0), 0);
  const foreignLiabilities = (liabilitiesResult.data ?? []).reduce((sum, l) => sum + l.balance, 0);
  const netForeignLocal = foreignAssets + foreignInvestments + foreignRetirement - foreignLiabilities;
  const fxRateAudInr = getAssumptionValue(assumptions, 'fx_rate_aud_inr', 56);
  const actual = foreignCurrency === 'INR' ? netForeignLocal / fxRateAudInr : netForeignLocal * fxRateAudInr;
  return { actual: round2(actual), target: null };
}

// Spec's consolidated variance table (5 rows: Net Worth, Retirement, Goals,
// Debt, Cross-Border). Compares the earliest completed run for this
// category+scenario (the retained "Original" forecast) against actual data
// AT THE SAME COMPARISON DATE. The comparison date is resolved from the
// latest recorded financial_snapshots row on or before the requested date
// (or today, if no date is requested) — not simply "today" — so a report
// generated at 11pm doesn't silently compare against a forecast value for a
// different moment than the actual data reflects. An explicit
// `comparisonDate` override (used by the 10 historical backtest cases and
// `/forecast/variance?date=`) still resolves through the same snapshot
// lookup, so the "actual" side stays anchored to a real recorded date too.
export async function getForecastVariance(
  userId: string,
  profileId: string,
  scenarioId: string,
  category: VarianceForecastCategory,
  comparisonDate?: string,
  client?: SupabaseServerClient
): Promise<CategoryVariance> {
  const supabase = client ?? (await createClient());
  const requestedDate = comparisonDate ?? new Date().toISOString().slice(0, 10);

  const [profileResult, originalRunResult, snapshot] = await Promise.all([
    supabase.from('forecast_profiles').select('base_currency, country_code').eq('id', profileId).single(),
    supabase
      .from('forecast_runs')
      .select('*')
      .eq('user_id', userId)
      .eq('forecast_profile_id', profileId)
      .eq('scenario_id', scenarioId)
      .eq('forecast_type', category)
      .eq('status', 'completed')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
    getLatestSnapshotAsOf(userId, requestedDate, supabase),
  ]);
  // Ground the comparison date to a real recorded snapshot date when one
  // exists at/before the requested date; otherwise fall back to the
  // requested date itself (no snapshot yet — e.g. a brand-new user whose
  // dashboard hasn't been loaded this month). dataLastUpdated is only set
  // when a snapshot actually backed the comparison, so callers can
  // distinguish "grounded in recorded data" from "live/present-moment".
  const effectiveComparisonDate = snapshot?.snapshot_month ?? requestedDate;
  const dataLastUpdated = snapshot?.snapshot_month ?? null;

  const profile = profileResult.data ?? { base_currency: 'AUD' as const, country_code: null };
  const assumptions = await loadResolvedAssumptions(userId, profileId, scenarioId, profile.country_code, supabase);
  const { actual: actualTillDate, target: liveTarget } = await getCurrentActualValue(userId, category, profile, assumptions, supabase, snapshot);

  const originalRun = originalRunResult.data;
  if (!originalRun) {
    return {
      forecastCategory: category,
      hasOriginal: false,
      baselineDate: null,
      comparisonDate: effectiveComparisonDate,
      dataLastUpdated,
      startValue: null,
      forecastTillDate: null,
      actualTillDate,
      varianceAmount: null,
      variancePercentage: null,
      result: null,
      status: 'insufficient_data',
      finalTarget: liveTarget,
      revisedForecast: null,
      finalTargetGap: null,
      primaryDriver: null,
      forecastHorizonExceeded: false,
    };
  }

  const monthsSinceBaseline = Math.max(0, monthsBetweenDates(originalRun.baseline_date, effectiveComparisonDate));
  const baselineJustEstablished = monthsSinceBaseline === 0;

  const [firstPeriodRows, comparisonPeriodRows, lastPeriodRows] = await Promise.all([
    supabase.from('forecast_results').select('opening_value').eq('forecast_run_id', originalRun.id).eq('period_number', 1),
    supabase
      .from('forecast_results')
      .select('closing_value')
      .eq('forecast_run_id', originalRun.id)
      .eq('period_number', Math.max(1, monthsSinceBaseline)),
    supabase.from('forecast_results').select('closing_value, target_value, period_number').eq('forecast_run_id', originalRun.id).order('period_number', { ascending: false }).limit(200),
  ]);

  const startValue = (firstPeriodRows.data ?? []).reduce((sum, r) => sum + (r.opening_value ?? 0), 0);
  const comparisonRows = comparisonPeriodRows.data ?? [];
  const finalPeriodNumber = lastPeriodRows.data?.[0]?.period_number ?? null;
  const finalPeriodRows = (lastPeriodRows.data ?? []).filter((r) => r.period_number === finalPeriodNumber);

  // If the comparison date IS the baseline date, the forecast "as at that
  // date" is trivially the starting value itself — period 1's closing value
  // already has a month of assumed growth baked in and would otherwise
  // manufacture a spurious variance on a same-day comparison (this case is
  // short-circuited to 'baseline_established' below regardless). Otherwise,
  // use the exact same-period value — NEVER silently substitute the
  // final/long-term period just because that lookup came up empty; only
  // fall back to it, with forecastHorizonExceeded disclosed, when the
  // comparison date genuinely exceeds this run's forecast horizon.
  const forecastHorizonExceeded = !baselineJustEstablished && comparisonRows.length === 0 && finalPeriodRows.length > 0;
  const forecastTillDate = baselineJustEstablished
    ? startValue
    : comparisonRows.length > 0
      ? comparisonRows.reduce((sum, r) => sum + (r.closing_value ?? 0), 0)
      : finalPeriodRows.reduce((sum, r) => sum + (r.closing_value ?? 0), 0);
  const revisedForecast = finalPeriodRows.length > 0 ? finalPeriodRows.reduce((sum, r) => sum + (r.closing_value ?? 0), 0) : null;
  const finalTarget = liveTarget ?? (finalPeriodRows[0]?.target_value ?? null);
  const finalTargetGap = finalTarget !== null && revisedForecast !== null ? round2(finalTarget - revisedForecast) : null;

  const rawVariance = round2(actualTillDate - forecastTillDate);
  const signedVariance = HIGHER_IS_BETTER[category] ? rawVariance : -rawVariance;

  // Baseline just established: no elapsed comparison period exists yet, so
  // a near-zero variance reflects "nothing has happened yet", not genuine
  // on-track performance — never let this reach statusFromSignedPercentage.
  if (baselineJustEstablished) {
    return {
      forecastCategory: category,
      hasOriginal: true,
      baselineDate: originalRun.baseline_date,
      comparisonDate: effectiveComparisonDate,
      dataLastUpdated,
      startValue: round2(startValue),
      forecastTillDate: round2(forecastTillDate),
      actualTillDate,
      varianceAmount: rawVariance,
      variancePercentage: null,
      result: null,
      status: 'baseline_established',
      finalTarget,
      revisedForecast,
      finalTargetGap,
      primaryDriver: `A baseline was established as at ${effectiveComparisonDate}. Performance tracking will be available once a later comparison period exists.`,
      forecastHorizonExceeded: false,
    };
  }

  // Zero forecast denominator (e.g. a debt due to be fully repaid, or a
  // goal/target of zero): a percentage is genuinely Not Applicable, but the
  // signed variance itself still says whether the actual position is
  // favourable, unfavourable, or exactly on target — this must not collapse
  // into "insufficient_data", which means something else entirely (no
  // original forecast at all, handled above).
  const variancePercentage = forecastTillDate !== 0 ? round2((signedVariance / Math.abs(forecastTillDate)) * 100) : null;
  // Neutral banding matches statusFromSignedPercentage's own "on track"
  // (-3% to +3%) center once a percentage exists; below 1% of a large
  // forecast value is a rounding-level difference, not a real variance. The
  // zero-denominator branch has no percentage to band against, so it falls
  // back to the same $1 absolute threshold statusFromZeroDenominator uses.
  const result: VarianceResult =
    variancePercentage !== null
      ? Math.abs(variancePercentage) < 1
        ? 'neutral'
        : signedVariance >= 0
          ? 'favourable'
          : 'unfavourable'
      : Math.abs(signedVariance) < 1
        ? 'neutral'
        : signedVariance >= 0
          ? 'favourable'
          : 'unfavourable';
  const status: VarianceStatus = variancePercentage !== null ? statusFromSignedPercentage(variancePercentage) : statusFromZeroDenominator(signedVariance);

  const primaryDriver =
    result === 'favourable'
      ? `Actual ${category.replace('_', ' ')} is tracking above the original forecast as at ${effectiveComparisonDate}.`
      : result === 'unfavourable'
        ? `Actual ${category.replace('_', ' ')} is tracking below the original forecast as at ${effectiveComparisonDate}.`
        : `Actual ${category.replace('_', ' ')} is close to the original forecast as at ${effectiveComparisonDate}.`;

  return {
    forecastCategory: category,
    hasOriginal: true,
    baselineDate: originalRun.baseline_date,
    comparisonDate: effectiveComparisonDate,
    dataLastUpdated,
    startValue: round2(startValue),
    forecastTillDate: round2(forecastTillDate),
    actualTillDate,
    varianceAmount: rawVariance,
    variancePercentage,
    result,
    status,
    finalTarget,
    revisedForecast,
    finalTargetGap,
    primaryDriver,
    forecastHorizonExceeded,
  };
}
