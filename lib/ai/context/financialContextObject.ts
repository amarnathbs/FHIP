// Module 11.0 — AIContextService: the FinancialContextObject builder.
//
// This is the ONLY place that assembles what an AI provider may ever see.
// Every domain is read through an EXISTING certified FHIP service
// (lib/services/*Data.ts) or an existing persisted table — nothing here
// recomputes a financial value (ADR-M11-001, decision #1-2). Any domain
// whose read fails, or whose source data isn't certified, is set to
// null/empty rather than partially-populated with unverified numbers.

import type { SupabaseServerClient } from '@/lib/services/dashboardData';
import { createClient } from '@/lib/supabase/server';
import { loadDashboard } from '@/lib/services/dashboardData';
import { loadHealthScore } from '@/lib/services/healthScoreData';
import { loadFinancialDna } from '@/lib/services/financialDnaData';
import { loadResilience } from '@/lib/services/resilienceData';
import { computeGoalsPagePayload } from '@/lib/services/goalsData';
import { listTwinRuns, getTwinRunDetail } from '@/lib/services/financialTwinService';
import { createCertifiedSourceClient, type SourceIntegrity } from '@/lib/ai/context/certifiedSourceClient';
import {
  certifyCashFlow,
  certifyBalanceSheet,
  certifyScore,
  certifyDna,
  certifyResilience,
  certifyInvestments,
  certifyRetirement,
  certifyInsurance,
  certifyGoals,
  certifyForecast,
  certifyTwin,
  certifyReports,
  certifyCrossBorder,
  rollUpCertification,
} from '@/lib/ai/certification/certificationService';
import { resolveDomainsForMode } from '@/lib/ai/context/contextSize';
import { assertAllowlisted } from '@/lib/ai/context/allowlist';
import {
  CONTEXT_VERSION,
  type CertificationState,
  type ContextDomain,
  type ContextSizeMode,
  type DataQualitySection,
  type DomainCertificationMap,
  type FinancialContextObject,
  type SourceReference,
} from '@/lib/ai/context/types';

// Supported currencies — anything outside this set fails the currency
// integrity check outright (spec section 21). Kept local rather than
// imported from lib/engines/fx.ts's internal type so this check can never
// silently loosen if that file's supported-currency list is ever widened
// without an explicit Module 11 review.
const SUPPORTED_CURRENCIES = new Set(['AUD', 'INR']);

export interface BuildContextOptions {
  mode: ContextSizeMode;
  intentCode?: string;
}

function opaqueRef(userId: string): string {
  // Deliberately not the raw auth user id verbatim in provider-facing
  // fields — a short, stable, non-reversible-looking reference. Real
  // reversal only ever happens server-side against ai_runs.user_id, never
  // by the provider. (Spec section 7: "use an internal opaque request/
  // reference ID where possible.")
  return `usr_${userId.replace(/-/g, '').slice(0, 16)}`;
}

async function checkCurrencyIntegrity(userId: string, supabase: SupabaseServerClient): Promise<boolean> {
  const results = await Promise.all([
    supabase.from('assets').select('currency_code').eq('user_id', userId).eq('is_active', true),
    supabase.from('liabilities').select('currency_code').eq('user_id', userId).eq('is_active', true),
    supabase.from('investments').select('currency_code').eq('user_id', userId).eq('is_active', true),
    supabase.from('retirement_accounts').select('currency_code').eq('user_id', userId).eq('is_active', true),
  ]);
  // FAIL CLOSED on a failed read. Previously a database error made `data`
  // null, `allRows` empty, and `[].every()` vacuously TRUE — so an outage
  // reported "currency integrity CERTIFIED" for a check that never actually
  // ran. A check that could not be performed is never a check that passed.
  if (results.some((r) => r.error)) return false;
  const allRows = [...(results[0].data ?? []), ...(results[1].data ?? []), ...(results[2].data ?? []), ...(results[3].data ?? [])];
  return allRows.every((r) => !r.currency_code || SUPPORTED_CURRENCIES.has(r.currency_code));
}

/**
 * The fail-closed context returned when the certification source database
 * could not be read. Every domain is INVALID (not UNAVAILABLE — "we could
 * not check" is a stronger negative than "there is nothing to check"), every
 * section is null/empty, and the root `certification_status` is INVALID,
 * which `AIModelGateway.generateExplanation()` already rejects before any
 * provider is reached.
 */
function buildSourceFailureContext(userId: string, mode: ContextSizeMode, integrity: SourceIntegrity): FinancialContextObject {
  const reason = `Certification source database read failed (${integrity.readFailures.length} failed read(s); first: ${integrity.readFailures[0]?.table} ${integrity.readFailures[0]?.code ?? ''}). Certification could not be established, so no domain is certified.`;
  const failed = { status: 'INVALID' as CertificationState, reason, model_versions: [] as string[], data_as_of: null };
  const domains: ContextDomain[] = [
    'cash_flow', 'balance_sheet', 'score', 'financial_dna', 'resilience', 'investments',
    'retirement', 'insurance', 'goals', 'forecasts', 'financial_twin', 'reports', 'cross_border',
  ];
  const domainCert = Object.fromEntries(domains.map((d) => [d, { ...failed }])) as DomainCertificationMap;

  return {
    meta: {
      context_version: CONTEXT_VERSION,
      generated_at: new Date().toISOString(),
      user_scope_identifier: opaqueRef(userId),
      household_scope_identifier: opaqueRef(userId),
      reporting_currency: 'AUD',
      country_of_residence: null,
      data_as_of: null,
      snapshot_id: null,
      source_snapshot_version: null,
      calculation_status: 'unavailable',
      integrity_status: 'INVALID',
      currency_integrity_status: 'INVALID',
      data_completeness: null,
      certification_status: 'INVALID',
      request_scope: mode,
    },
    household: null,
    cash_flow: null,
    balance_sheet: null,
    health_score: null,
    financial_dna: null,
    resilience: null,
    investments: null,
    retirement: null,
    insurance: null,
    goals: [],
    forecasts: [],
    financial_twin: null,
    risks: [],
    recommendations: [],
    reports: [],
    cross_border: null,
    data_quality: {
      complete_domains: [],
      incomplete_domains: [],
      missing_fields: [],
      confirmed_zero_fields: [],
      stale_fields: [],
      rejected_records: [],
      excluded_duplicates: [],
      valuation_date_issues: [],
      unsupported_calculations: [],
      unavailable_modules: domains,
      confidence_limitations: [reason],
    },
    domain_certification: domainCert,
    source_references: [],
  };
}

/**
 * Builds the full, certified, allowlisted Financial Context Object for one
 * authorised household. `userId` MUST already have been validated against
 * the caller's own session (requireUser()) — this function does not itself
 * re-authenticate; it is the caller's job to prove ownership before this is
 * ever invoked (see resolveHouseholdContext() usage in the internal API
 * routes).
 */
export async function buildFinancialContextObject(userId: string, options: BuildContextOptions): Promise<FinancialContextObject> {
  // Every source read on this path goes through the certified-source client:
  // it observes read failures (so a database outage fails the whole context
  // CLOSED instead of masquerading as "this household entered no data"), and
  // it blocks every write verb (so this read path is structurally incapable
  // of mutating canonical financial data — the Module 1-10 loaders below are
  // load-AND-persist functions, not pure readers). See certifiedSourceClient.ts.
  const { client: supabase, integrity } = createCertifiedSourceClient(await createClient());
  const includedDomains = resolveDomainsForMode(options.mode, options.intentCode);
  const include = (d: ContextDomain) => includedDomains.includes(d);

  const [profileRes, householdRes, currencyIntegrityOk] = await Promise.all([
    supabase.from('user_profiles').select('country_of_residence, secondary_country, preferred_currency, employment_status').eq('user_id', userId).maybeSingle(),
    supabase.from('households').select('household_type, marital_status, dependants_count').eq('user_id', userId).maybeSingle(),
    checkCurrencyIntegrity(userId, supabase),
  ]);

  const reportingCurrency = (profileRes.data?.preferred_currency as 'AUD' | 'INR') ?? 'AUD';
  const countryOfResidence = profileRes.data?.country_of_residence ?? null;
  const crossBorderIndicator = Boolean(profileRes.data?.secondary_country);

  const dashboard = await loadDashboard(userId, supabase);

  const missingFields: string[] = [];
  const staleFields: string[] = [];
  const unavailableModules: ContextDomain[] = [];
  const sourceReferences: SourceReference[] = [];

  // --- Health score -----------------------------------------------------
  let healthScorePayload: Awaited<ReturnType<typeof loadHealthScore>> | null = null;
  try {
    healthScorePayload = await loadHealthScore(userId, supabase);
  } catch {
    /* fail closed below via UNAVAILABLE certification */
  }

  // --- Financial DNA ------------------------------------------------------
  let dnaPayload: Awaited<ReturnType<typeof loadFinancialDna>> | null = null;
  try {
    dnaPayload = await loadFinancialDna(userId, supabase);
  } catch {
    /* fail closed */
  }

  // --- Resilience -----------------------------------------------------
  let resiliencePayload: Awaited<ReturnType<typeof loadResilience>> | null = null;
  try {
    resiliencePayload = await loadResilience(userId, supabase);
  } catch {
    /* fail closed */
  }

  // --- Goals --------------------------------------------------------------
  // computeGoalsPagePayload(), NOT loadGoalsPage(): goalsData.ts's own
  // comment says loadGoalsPage "writes a new immutable goal_forecasts history
  // row plus this month's goal_snapshots upsert" and that "anything else that
  // just needs to display goal data should call computeGoalsPagePayload
  // directly to avoid writing a new history row on every view". An AI context
  // build is exactly such a read-only consumer.
  let goalsPage: Awaited<ReturnType<typeof computeGoalsPagePayload>>['payload'] | null = null;
  try {
    goalsPage = (await computeGoalsPagePayload(userId, supabase)).payload;
  } catch {
    /* fail closed */
  }

  // --- Forecast (latest run only — reads the same persisted table
  // listForecastRuns/getForecastRunDetail read, without requiring a
  // pre-resolved forecast_profile_id) -------------------------------------
  const { data: latestForecastRun } = await supabase
    .from('forecast_runs')
    .select('id, status, engine_version, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // --- Financial Twin -------------------------------------------------
  const twinRuns = await listTwinRuns(userId, supabase);
  const latestTwin = twinRuns[0] ?? null;
  const twinDetail = latestTwin ? await getTwinRunDetail(userId, latestTwin.id, supabase) : null;

  // --- Reports --------------------------------------------------------
  // The same query listReports() issues, but through the certified-source
  // client rather than listReports()'s own createClient() — otherwise a
  // failed reports read would be invisible to the integrity check below.
  const reportsRes = await supabase
    .from('reports')
    .select('*')
    .eq('user_id', userId)
    .neq('status', 'archived')
    .order('report_month', { ascending: false });
  const reportRows = (reportsRes.data ?? []) as { id: string; status: string | null; report_month: string; as_of_date: string | null; version_number: number; data_completeness_pct: number | null }[];

  // =========================================================================
  // SOURCE-INTEGRITY GATE — fail closed on a certification-database failure.
  //
  // This runs BEFORE any domain is certified. If any source read errored, we
  // cannot distinguish "no data" from "could not read the data", so nothing
  // is certified at all: the whole context is INVALID and the gateway rejects
  // it before a provider is ever reached. This is the only correct answer —
  // reusing a previously-successful certification would require an explicit
  // stale-certification policy that Module 11.0 deliberately does not have
  // (certification is derived per request and never cached).
  // =========================================================================
  if (integrity.readFailures.length > 0) {
    const failureContext = buildSourceFailureContext(userId, options.mode, integrity);
    assertAllowlisted(failureContext);
    return failureContext;
  }

  // =========================================================================
  // Domain certification
  // =========================================================================
  const domainCert: DomainCertificationMap = {
    cash_flow: certifyCashFlow({ hasIncome: dashboard.hasIncome, hasExpenses: dashboard.hasExpenses, dataAsOf: dashboard.snapshots.at(-1)?.snapshot_month ?? null }),
    balance_sheet: certifyBalanceSheet({ hasAssets: dashboard.hasAssets, hasLiabilities: dashboard.hasLiabilities, dataAsOf: dashboard.snapshots.at(-1)?.snapshot_month ?? null }),
    score: healthScorePayload
      ? certifyScore({ eligibilityState: healthScorePayload.eligibility.state, modelVersion: healthScorePayload.modelVersion, calculationDate: null })
      : { status: 'UNAVAILABLE', reason: 'Financial Health Score could not be loaded.', model_versions: [], data_as_of: null },
    financial_dna: dnaPayload
      ? certifyDna({ status: dnaPayload.status, modelVersion: dnaPayload.modelVersion, classificationDate: null })
      : { status: 'UNAVAILABLE', reason: 'Financial DNA could not be loaded.', model_versions: [], data_as_of: null },
    resilience: resiliencePayload
      ? certifyResilience({ eligibilityState: resiliencePayload.eligibility.state, modelVersion: resiliencePayload.modelVersion, calculationDate: null })
      : { status: 'UNAVAILABLE', reason: 'Resilience score could not be loaded.', model_versions: [], data_as_of: null },
    investments: certifyInvestments({ hasInvestments: dashboard.hasInvestments, dataAsOf: dashboard.snapshots.at(-1)?.snapshot_month ?? null }),
    retirement: certifyRetirement({ hasRetirement: dashboard.hasRetirement, dataAsOf: dashboard.snapshots.at(-1)?.snapshot_month ?? null }),
    insurance: certifyInsurance({
      hasInsurance: dashboard.hasInsurance,
      missingCategoryCount: dashboard.hasInsurance ? 0 : 1,
      dataAsOf: dashboard.snapshots.at(-1)?.snapshot_month ?? null,
    }),
    goals: certifyGoals({ goalCount: goalsPage?.goals.length ?? 0, dataAsOf: null }),
    forecasts: certifyForecast({
      hasRun: Boolean(latestForecastRun),
      runStatus: latestForecastRun?.status ?? null,
      modelVersion: latestForecastRun?.engine_version ?? null,
      calculationDate: latestForecastRun?.created_at ?? null,
    }),
    financial_twin: certifyTwin({
      hasRun: Boolean(latestTwin),
      status: (latestTwin?.status as 'indicative' | 'confirmed' | 'restated' | null) ?? null,
      modelVersion: null,
      calculationDate: latestTwin?.createdAt ?? null,
    }),
    reports: certifyReports({ reportCount: reportRows.length, latestStatus: reportRows[0]?.status ?? null, dataAsOf: reportRows[0]?.as_of_date ?? null }),
    cross_border: certifyCrossBorder({ countriesInUse: dashboard.countriesInUse, currencyIntegrityOk, dataAsOf: dashboard.snapshots.at(-1)?.snapshot_month ?? null }),
  };

  const usable = (d: ContextDomain) => include(d) && (domainCert[d].status === 'CERTIFIED' || domainCert[d].status === 'PARTIAL' || domainCert[d].status === 'STALE');

  for (const [domain, c] of Object.entries(domainCert) as [ContextDomain, DomainCertificationMap[ContextDomain]][]) {
    if (c.status === 'UNAVAILABLE' || c.status === 'INVALID') unavailableModules.push(domain);
    if (c.status === 'STALE') staleFields.push(domain);
    if (c.status === 'PARTIAL' && c.reason) missingFields.push(`${domain}: ${c.reason}`);
  }

  // =========================================================================
  // Section assembly — only for domains both requested (context size mode)
  // AND usable (not INVALID/UNAVAILABLE). "Missing stays missing" (spec
  // section 57.6): an excluded/unusable domain is `null`/empty, never a
  // fabricated zero.
  // =========================================================================
  const cashFlow = usable('cash_flow')
    ? {
        monthly_gross_income: dashboard.grossMonthlyIncome,
        monthly_net_income: dashboard.netMonthlyIncome,
        monthly_expenses: dashboard.totalMonthlyExpenses,
        essential_monthly_expenses: dashboard.essentialMonthlyExpenses,
        discretionary_monthly_expenses: dashboard.lifestyleMonthlyExpenses,
        debt_repayments: dashboard.debtMonthlyRepayments,
        insurance_premiums: dashboard.totalAnnualPremium / 12,
        monthly_surplus_or_deficit: dashboard.monthlySurplus,
        savings_rate: dashboard.savingsRate,
        income_concentration: dashboard.largestIncomeSharePct,
        // No certified engine currently computes a distinct "fixed
        // commitment ratio" (fixed essential + debt commitments / income) —
        // left null rather than relabelling a different certified metric
        // (e.g. discretionaryRatio) under this name.
        fixed_commitment_ratio: null,
        data_as_of: dashboard.snapshots.at(-1)?.snapshot_month ?? null,
        calculation_version: 'dashboard-1.0.0',
      }
    : null;

  const balanceSheet = usable('balance_sheet')
    ? {
        total_assets: dashboard.totalAssetsCombined,
        total_liabilities: dashboard.totalLiabilities,
        net_worth: dashboard.netWorth,
        liquid_assets: dashboard.liquidAssets,
        property_assets: dashboard.netWorthAllocation.find((a) => a.bucket === 'property')?.value ?? null,
        investment_assets: dashboard.totalInvestments,
        retirement_assets: dashboard.totalRetirement,
        property_concentration: dashboard.propertyConcentration,
        investment_concentration: dashboard.institutionConcentration,
        debt_breakdown: dashboard.liabilityByType.map((l) => ({ debt_type: l.debtType, balance: l.balance })),
        country_breakdown: dashboard.assetsByCountry.map((a) => ({ country_code: a.countryCode, value: a.value })),
        currency_breakdown: [{ currency_code: reportingCurrency, value: dashboard.netWorth }],
        data_as_of: dashboard.snapshots.at(-1)?.snapshot_month ?? null,
        calculation_version: 'dashboard-1.0.0',
      }
    : null;

  const healthScore =
    usable('score') && healthScorePayload
      ? {
          overall_score: healthScorePayload.overallScore,
          score_band: healthScorePayload.statusBand,
          pillar_scores: healthScorePayload.components.map((c) => ({ code: c.code, score: c.rawScore, weight: c.weight })),
          principal_drivers: healthScorePayload.components.slice(0, 3).map((c) => c.code),
          prior_valid_score: healthScorePayload.previousScore,
          score_movement: healthScorePayload.scoreChange,
          confidence: null,
          calculation_date: null,
          model_version: healthScorePayload.modelVersion,
        }
      : null;
  if (healthScore) sourceReferences.push({ source_type: 'health_score', source_id: userId, model_version: healthScore.model_version, data_as_of: null });

  const financialDna =
    usable('financial_dna') && dnaPayload
      ? {
          primary_profile: dnaPayload.primaryProfileCode,
          secondary_profile: dnaPayload.secondaryProfileCode,
          driver_metrics: dnaPayload.drivers?.map((d) => d.metricCode) ?? [],
          confidence: dnaPayload.confidence,
          classification_date: null,
          model_version: dnaPayload.modelVersion,
        }
      : null;
  if (financialDna) sourceReferences.push({ source_type: 'financial_dna', source_id: userId, model_version: financialDna.model_version, data_as_of: null });

  const resilience =
    usable('resilience') && resiliencePayload
      ? {
          resilience_score: resiliencePayload.overallScore,
          resilience_status: resiliencePayload.statusBand,
          emergency_fund_months: dashboard.emergencyFundMonths,
          liquidity_position: dashboard.liquidAssetRatio !== null ? `${Math.round(dashboard.liquidAssetRatio * 100)}% liquid` : null,
          income_concentration: dashboard.employerConcentration,
          debt_pressure: dashboard.debtServiceRatio !== null ? `DSR ${Math.round(dashboard.debtServiceRatio * 100)}%` : null,
          insurance_protection_status: dashboard.hasInsurance ? 'has_cover_recorded' : 'no_cover_recorded',
          active_risks: resiliencePayload.risks.map((r) => ({ code: r.code, category: r.category, severity: r.severity })),
          stress_test_outputs: [],
          confidence: resiliencePayload.confidence,
          model_version: resiliencePayload.modelVersion,
        }
      : null;
  if (resilience) sourceReferences.push({ source_type: 'resilience', source_id: userId, model_version: resilience.model_version, data_as_of: null });

  const investments = usable('investments')
    ? {
        total_investment_value: dashboard.totalInvestments,
        contribution_rate: dashboard.investmentContributionRate,
        diversification_score: dashboard.investmentDiversificationScore,
        institution_concentration: dashboard.institutionConcentration,
        country_allocation: dashboard.investmentByCountry.map((c) => ({ country_code: c.countryCode, value: c.value })),
        dividend_monthly_income: dashboard.dividendMonthlyIncome,
        data_as_of: dashboard.snapshots.at(-1)?.snapshot_month ?? null,
        calculation_version: 'dashboard-1.0.0',
      }
    : null;

  const retirement = usable('retirement')
    ? {
        retirement_balance: dashboard.totalRetirement,
        account_categories: [], // dashboard.ts does not currently expose a per-account-type breakdown; left empty rather than guessed
        employer_contribution_rate: dashboard.retirementEmployerContributionRate,
        personal_contribution_rate: dashboard.retirementContributionRate,
        data_as_of: dashboard.snapshots.at(-1)?.snapshot_month ?? null,
        calculation_version: 'dashboard-1.0.0',
      }
    : null;

  const insurance = usable('insurance')
    ? {
        data_status: dashboard.hasInsurance ? ('complete' as const) : ('missing' as const),
        active_cover_categories: dashboard.insuranceByType.map((i) => i.coverType),
        confirmed_no_cover_categories: [],
        missing_or_unknown_categories: dashboard.hasInsurance ? [] : ['all'],
        premium_burden: dashboard.totalAnnualPremium,
        confidence: dashboard.hasInsurance ? 0.7 : null,
      }
    : null;

  const goals = usable('goals') && goalsPage
    ? goalsPage.goals.map((g) => {
        const base = g.forecasts?.base;
        return {
          goal_reference: g.id,
          goal_type: g.goalType,
          goal_status: g.status,
          target_amount: g.targetAmount,
          current_funding: g.currentAmount,
          contribution: g.allocatedMonthlyContribution,
          target_date: g.targetDate,
          track_status: base?.trackStatus ?? null,
          required_contribution: base?.requiredMonthlyContribution ?? null,
          forecast_completion_date: base?.projectedCompletionDate ?? null,
          confidence: null,
          calculation_version: goalsPage.modelVersion,
        };
      })
    : [];
  goals.forEach((g) => sourceReferences.push({ source_type: 'goal', source_id: g.goal_reference, model_version: g.calculation_version, data_as_of: null }));

  const forecasts = usable('forecasts') && latestForecastRun
    ? [
        {
          scenario_code: 'base',
          horizon_years: null,
          major_projected_metrics: {},
          assumption_set_id: null,
          model_version: latestForecastRun.engine_version ?? null,
          calculation_date: latestForecastRun.created_at ?? null,
          confidence: null,
          disclaimer: 'This forecast is a modelled estimate based on stated assumptions, not a guaranteed outcome.',
        },
      ]
    : [];
  if (forecasts.length > 0) sourceReferences.push({ source_type: 'retirement_forecast', source_id: latestForecastRun!.id, model_version: forecasts[0].model_version, data_as_of: forecasts[0].calculation_date });

  const financialTwin = usable('financial_twin') && twinDetail
    ? {
        peer_cohort_description: twinDetail.cohortDescription,
        cohort_tier: twinDetail.cohortTier !== null ? String(twinDetail.cohortTier) : null,
        metrics: twinDetail.metrics.map((m) => ({
          metric_code: m.metricCode,
          user_value: m.userValue,
          peer_value: m.peerValue,
          gap: m.absoluteGap,
          percentile: m.percentileRank,
          comparison_status: m.comparisonStatus,
        })),
        benchmark_source: null,
        benchmark_period: null,
        benchmark_version: null,
        benchmark_confidence: twinDetail.overallConfidence,
        status: (twinDetail.status as 'indicative' | 'confirmed' | 'restated') ?? null,
      }
    : null;
  if (financialTwin && latestTwin) sourceReferences.push({ source_type: 'financial_twin', source_id: latestTwin.id, model_version: null, data_as_of: latestTwin.runDate });

  const reports = usable('reports')
    ? reportRows.slice(0, 3).map((r) => ({
        report_id: r.id,
        reporting_period: r.report_month,
        data_as_of: r.as_of_date,
        report_version: String(r.version_number),
        executive_metrics: {},
        major_findings: [],
        active_risks: [],
        goal_references: [],
        report_confidence: r.data_completeness_pct,
        template_version: null,
      }))
    : [];
  reports.forEach((r) => sourceReferences.push({ source_type: 'report', source_id: r.report_id, model_version: r.template_version, data_as_of: r.data_as_of }));

  const crossBorder = usable('cross_border')
    ? {
        countries_present: dashboard.countriesInUse,
        currencies_present: [reportingCurrency],
        reporting_currency: reportingCurrency,
        local_country_totals: dashboard.assetsByCountry.map((a) => ({ country_code: a.countryCode, value: a.value })),
        converted_totals: dashboard.assetsByCountry.map((a) => ({ country_code: a.countryCode, value_in_reporting_currency: a.value })),
        fx_source: 'forecast_global_assumptions.fx_rate_aud_inr',
        fx_rate_date: null,
        currency_mismatch_metrics: [],
        // No certified engine currently computes a country-concentration
        // (HHI-style) metric distinct from property_concentration — left
        // null rather than relabelling a different certified metric.
        country_concentration: null,
        cross_border_goals: [],
        cross_border_debt_exposure: dashboard.liabilitiesByCountry.length > 1 ? dashboard.totalLiabilities : null,
      }
    : null;

  const household = include('cash_flow') || options.mode !== 'MINIMAL'
    ? {
        country_of_residence: countryOfResidence,
        reporting_currency: reportingCurrency,
        household_type: householdRes.data?.household_type ?? null,
        life_stage: null, // not tracked as a discrete field today — left null rather than guessed
        number_of_adults: householdRes.data?.marital_status === 'married' || householdRes.data?.marital_status === 'de_facto' ? 2 : householdRes.data?.marital_status ? 1 : null,
        number_of_dependants: householdRes.data?.dependants_count ?? null,
        employment_status_summary: profileRes.data?.employment_status ?? null,
        housing_tenure_category: null, // not reliably resolvable from a single certified field today
        cross_border_indicator: crossBorderIndicator,
      }
    : null;

  const dataQuality: DataQualitySection = {
    complete_domains: (Object.entries(domainCert) as [ContextDomain, DomainCertificationMap[ContextDomain]][])
      .filter(([, c]) => c.status === 'CERTIFIED')
      .map(([d]) => d),
    incomplete_domains: (Object.entries(domainCert) as [ContextDomain, DomainCertificationMap[ContextDomain]][])
      .filter(([, c]) => c.status === 'PARTIAL' || c.status === 'STALE')
      .map(([d]) => d),
    missing_fields: missingFields,
    confirmed_zero_fields: [],
    stale_fields: staleFields,
    rejected_records: [],
    excluded_duplicates: [],
    valuation_date_issues: [],
    unsupported_calculations: ['investment_asset_class_allocation', 'investment_geographic_allocation_detail', 'retirement_account_category_breakdown'],
    unavailable_modules: unavailableModules,
    confidence_limitations: !currencyIntegrityOk ? ['Currency integrity check failed — cross-border figures are not available.'] : [],
  };

  const overallStatus: CertificationState = rollUpCertification(Object.values(domainCert).map((c) => c.status));

  const contextObject: FinancialContextObject = {
    meta: {
      context_version: CONTEXT_VERSION,
      generated_at: new Date().toISOString(),
      user_scope_identifier: opaqueRef(userId),
      household_scope_identifier: opaqueRef(userId),
      reporting_currency: reportingCurrency,
      country_of_residence: countryOfResidence,
      data_as_of: dashboard.snapshots.at(-1)?.snapshot_month ?? null,
      snapshot_id: null,
      source_snapshot_version: 'dashboard-1.0.0',
      calculation_status: overallStatus === 'CERTIFIED' ? 'complete' : overallStatus === 'UNAVAILABLE' ? 'unavailable' : 'partial',
      integrity_status: overallStatus,
      currency_integrity_status: currencyIntegrityOk ? 'CERTIFIED' : 'INVALID',
      data_completeness: null,
      certification_status: overallStatus,
      request_scope: options.mode,
    },
    household,
    cash_flow: cashFlow,
    balance_sheet: balanceSheet,
    health_score: healthScore,
    financial_dna: financialDna,
    resilience,
    investments,
    retirement,
    insurance,
    goals,
    forecasts,
    financial_twin: financialTwin,
    risks: [],
    recommendations: [],
    reports,
    cross_border: crossBorder,
    data_quality: dataQuality,
    domain_certification: domainCert,
    source_references: sourceReferences,
  };

  // Final defence-in-depth scan before this object can leave the server
  // (spec sections 4, 12, privacy tests).
  assertAllowlisted(contextObject);

  return contextObject;
}
