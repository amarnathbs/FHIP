// Premium Report v2 — 13 additional sections built on top of the 13 Free
// sections in reportSections.ts. Per the plan, every section here is a
// presentation/aggregation layer over calculations that already exist
// elsewhere (Health Score, Financial DNA, Financial Twin, Forecasting
// Engine, Resilience Stress) — nothing here recalculates anything (Rule 15).
// Only ever called when source.premium is non-null (planTier === 'premium').
import type { ReportSourceData, PremiumSourceData } from '@/lib/services/reportSnapshotResolver';
import type { PremiumSectionCode } from './reportEligibility';
import type { BuiltSection } from './reportSections';
import { formatMoneyWhole } from './money';
import { applyStressScenario, type StressScenarioType, type StressScenarioResult } from './resilienceStress';
import { convertToReportingCurrency, type SupportedCurrency } from './fx';

const STRESS_SCENARIOS: StressScenarioType[] = [
  'income_stops',
  'income_falls_pct',
  'unexpected_expense',
  'interest_rate_rise',
  'rental_vacancy',
  'investment_market_decline',
  'currency_shock',
  'combined_severe',
];

const PREMIUM_SECTION_TITLES: Record<PremiumSectionCode, string> = {
  twelve_month_trends: '12-Month Trends',
  score_diagnostic_full: 'Full Financial Health Score Diagnostic',
  financial_dna_full: 'Full Financial DNA Profile',
  investment_analysis: 'Investment Analysis',
  retirement_readiness: 'Retirement Readiness',
  insurance_analysis: 'Insurance Analysis',
  goal_forecast_detail: 'Detailed Goal Forecasting',
  scenario_forecasting: 'Scenario Forecasting',
  financial_twin_full: 'Full Financial Twin Comparison',
  cross_border_full: 'Full Cross-Border Wealth Breakdown',
  stress_testing: 'Financial Stress Testing',
  personal_action_plan: 'Your Personal Action Plan',
  appendices: 'Appendices — Recorded Data',
};

// Same "what it reviews" pattern as the Free report's health-score page,
// used so an action plan item can point somewhere concrete without
// inventing a new navigation model.
const MODULE_REVIEW_STEP: Record<string, string> = {
  cash_flow: 'Review your Income and Expenses pages.',
  savings: 'Review your Income and Expenses pages.',
  emergency_fund: 'Review your Assets page (cash and liquid holdings).',
  debt: 'Review your Liabilities page.',
  net_worth: 'Review your Assets and Liabilities pages.',
  investment: 'Review your Investments page.',
  retirement: 'Review your Retirement page.',
  insurance: 'Review your Insurance page.',
  resilience: 'Review your Financial Resilience page.',
  behaviour: 'Review your Goals and Financial Health Score pages.',
  goals: 'Review your Goals page.',
};

function empty(code: PremiumSectionCode, displayOrder: number, reason: string | null): BuiltSection {
  return {
    sectionCode: code,
    sectionTitle: PREMIUM_SECTION_TITLES[code],
    displayOrder,
    sectionStatus: 'unavailable',
    sectionData: {},
    narrativeText: null,
    chartData: null,
    sourceReferences: {},
    confidenceLevel: null,
    limitationText: reason,
  };
}

function buildTwelveMonthTrends(source: ReportSourceData, premium: PremiumSourceData): BuiltSection {
  const netWorthHistory = source.dashboard.snapshots.map((s) => ({
    month: s.snapshot_month,
    netWorth: s.net_worth,
    monthlyIncome: s.monthly_income,
    monthlyExpenses: s.monthly_expenses,
    monthlySurplus: s.monthly_surplus,
  }));
  const healthScoreHistory = source.healthScore?.history ?? [];
  const resilienceHistory = source.resilience?.history ?? [];
  const goalsOnTrackHistory = premium.goalsOnTrackHistory;

  const hasAnyHistory = netWorthHistory.length >= 2 || healthScoreHistory.length >= 2 || resilienceHistory.length >= 2;

  return {
    sectionCode: 'twelve_month_trends',
    sectionTitle: PREMIUM_SECTION_TITLES.twelve_month_trends,
    displayOrder: 15,
    sectionStatus: hasAnyHistory ? 'included' : 'unavailable',
    sectionData: { netWorthHistory, healthScoreHistory, resilienceHistory, goalsOnTrackHistory },
    narrativeText: hasAnyHistory
      ? 'These charts show how your recorded net worth, Financial Health Score, Financial Resilience score and goal progress have moved over the periods captured to date.'
      : null,
    chartData: hasAnyHistory ? { netWorthHistory, healthScoreHistory, resilienceHistory, goalsOnTrackHistory } : null,
    sourceReferences: {},
    confidenceLevel: null,
    limitationText: hasAnyHistory
      ? 'Trend charts only display periods for which a snapshot or score was actually recorded — gaps are not interpolated or estimated.'
      : 'At least two recorded periods are required before a trend can be shown.',
  };
}

function buildScoreDiagnosticFull(source: ReportSourceData): BuiltSection {
  const hs = source.healthScore;
  if (!hs) return empty('score_diagnostic_full', 16, 'A Financial Health Score has not been calculated for this period.');
  // healthScore.ts's overallScore is computed from each scored component's
  // *effective* weight (its config weight rescaled so the scored components'
  // weights sum to 1, since unavailable components are excluded rather than
  // scored as 0) — but each component's own `weight` field still stores the
  // original, un-rescaled config weight. Displaying rawScore x weight next
  // to weightedContribution without this correction makes the arithmetic
  // look wrong whenever any component is unavailable. Recompute the same
  // rescaling here so the displayed weight actually reconciles.
  const scoredWeightTotal = hs.components.filter((c) => c.treatment === 'scored' && c.rawScore !== null).reduce((sum, c) => sum + c.weight, 0);
  const effectiveWeightOf = (c: (typeof hs.components)[number]) =>
    c.treatment === 'scored' && c.rawScore !== null && scoredWeightTotal > 0 ? c.weight / scoredWeightTotal : c.weight;
  return {
    sectionCode: 'score_diagnostic_full',
    sectionTitle: PREMIUM_SECTION_TITLES.score_diagnostic_full,
    displayOrder: 16,
    sectionStatus: 'included',
    sectionData: {
      overallScore: hs.overallScore,
      roundedScore: hs.roundedScore,
      modelVersion: hs.modelVersion,
      components: hs.components.map((c) => ({
        code: c.code,
        label: c.label,
        rawScore: c.rawScore,
        weight: c.weight,
        effectiveWeight: effectiveWeightOf(c),
        weightAdjusted: Math.abs(effectiveWeightOf(c) - c.weight) > 0.0005,
        weightedContribution: c.weightedContribution,
        statusBand: c.statusBand,
        dataCompleteness: c.dataCompleteness,
        treatment: c.treatment,
        currentValue: c.currentValue,
        benchmarkValue: c.benchmarkValue,
        explanation: c.explanation,
      })),
    },
    narrativeText:
      'Each pillar below shows its weight in the overall score, the weighted contribution it made, and the underlying values used to calculate it, so you can see exactly how your overall score was built. Where a pillar is unavailable, the remaining pillars\' weights are rescaled so they still sum to 100% — the "effective weight" column reflects that adjustment.',
    chartData: {
      components: hs.components.map((c) => ({ code: c.code, label: c.label, score: c.rawScore, weight: effectiveWeightOf(c), weightedContribution: c.weightedContribution })),
    },
    sourceReferences: { modelVersion: hs.modelVersion },
    confidenceLevel: hs.dataConfidence.toFixed(0),
    limitationText: null,
  };
}

function buildFinancialDnaFull(source: ReportSourceData, isFirstReport: boolean): BuiltSection {
  const dna = source.dna;
  if (!dna) return empty('financial_dna_full', 17, 'A Financial DNA profile is not yet available.');
  // The archetype's static long_description narrates a pattern over time
  // ("net worth is trending upward", "aggressive investing") — asserting a
  // trend on a genuine first report (no prior snapshot to compare against)
  // directly contradicts the report's own "not enough history yet" trend
  // disclaimer shown elsewhere. Fall back to the evidence-based, single-
  // snapshot trait sentences instead, which only cite real computed values.
  const evidenceBasedSummary =
    dna.traits.length > 0
      ? `Based on this report's figures: ${dna.traits.slice(0, 3).map((t) => t.explanation).join(' ')}`
      : null;
  return {
    sectionCode: 'financial_dna_full',
    sectionTitle: PREMIUM_SECTION_TITLES.financial_dna_full,
    displayOrder: 17,
    sectionStatus: 'included',
    sectionData: {
      primaryProfileCode: dna.primaryProfileCode,
      primaryProfileLabel: dna.primaryProfileCode ? dna.archetypes[dna.primaryProfileCode]?.profile_name : null,
      primaryScore: dna.primaryScore,
      secondaryProfileCode: dna.secondaryProfileCode,
      secondaryProfileLabel: dna.secondaryProfileCode ? dna.archetypes[dna.secondaryProfileCode]?.profile_name : null,
      secondaryScore: dna.secondaryScore,
      confidence: dna.confidence,
      confidenceLabel: dna.confidenceLabel,
      profileChanged: dna.profileChanged,
      traits: dna.traits,
      strengths: dna.strengths,
      risks: dna.risks,
      actions: dna.actions,
      history: dna.history,
    },
    narrativeText:
      !isFirstReport && dna.primaryProfileCode && dna.archetypes[dna.primaryProfileCode]
        ? dna.archetypes[dna.primaryProfileCode].long_description
        : evidenceBasedSummary,
    chartData: { history: dna.history },
    sourceReferences: { modelVersion: dna.modelVersion },
    confidenceLevel: dna.confidence.toFixed(0),
    limitationText: 'Financial DNA describes a current behavioural pattern based on recorded data, not a fixed or permanent personality label.',
  };
}

function buildInvestmentAnalysis(source: ReportSourceData, premium: PremiumSourceData): BuiltSection {
  const rows = premium.investments;
  if (rows.length === 0) return empty('investment_analysis', 18, 'No investment holdings are currently recorded.');

  // FHIP_50_User_Report_Accuracy_Validation_Review P0 finding — totals used
  // to sum each row's current_value/cost_base raw, regardless of
  // currency_code, so a cross-border household's foreign-currency holdings
  // (e.g. an INR 900,000 managed fund) were counted at face value into an
  // AUD total, overstating it by tens of times. Converted to the report's
  // currency via the same helper + fx_rate_aud_inr assumption dashboard.ts's
  // canonical totalInvestments already uses, so this can never again drift
  // from the correctly-converted figure shown elsewhere in the same report.
  // byCountry deliberately stays in each country's own currency — matching
  // dashboard.ts's per-country breakdowns, which show local totals "as
  // recorded" by design; every row within one country bucket already shares
  // one currency, so there's nothing to convert there.
  const toReportingCurrency = (amount: number, rowCurrencyCode: string | null | undefined) => {
    const rowCurrency: SupportedCurrency = rowCurrencyCode === 'AUD' || rowCurrencyCode === 'INR' ? rowCurrencyCode : source.currency;
    return convertToReportingCurrency(amount, rowCurrency, source.currency, premium.fxRateAudInr);
  };
  const totalCurrentValue = rows.reduce((s, r) => s + toReportingCurrency(r.current_value, r.currency_code), 0);
  const totalCostBase = rows.reduce((s, r) => s + toReportingCurrency(r.cost_base ?? 0, r.currency_code), 0);
  const byType = new Map<string, { type: string; label: string; value: number; count: number }>();
  const byCountry = new Map<string, { country: string; value: number; count: number }>();
  for (const r of rows) {
    const convertedValue = toReportingCurrency(r.current_value, r.currency_code);
    const t = byType.get(r.investment_type) ?? { type: r.investment_type, label: source.content.categoryLabel(r.investment_type), value: 0, count: 0 };
    t.value += convertedValue;
    t.count += 1;
    byType.set(r.investment_type, t);
    const c = byCountry.get(r.country_code) ?? { country: r.country_code, value: 0, count: 0 };
    c.value += r.current_value;
    c.count += 1;
    byCountry.set(r.country_code, c);
  }
  const byTypeArr = Array.from(byType.values()).sort((a, b) => b.value - a.value);
  const byCountryArr = Array.from(byCountry.values()).sort((a, b) => b.value - a.value);
  const largestSharePct = totalCurrentValue > 0 && byTypeArr.length > 0 ? (byTypeArr[0].value / totalCurrentValue) * 100 : null;

  return {
    sectionCode: 'investment_analysis',
    sectionTitle: PREMIUM_SECTION_TITLES.investment_analysis,
    displayOrder: 18,
    sectionStatus: 'included',
    sectionData: {
      holdings: rows,
      totalCurrentValue,
      totalCostBase,
      unrealisedGain: totalCurrentValue - totalCostBase,
      byType: byTypeArr,
      byCountry: byCountryArr,
    },
    narrativeText:
      largestSharePct !== null
        ? `Your recorded investment holdings total ${formatMoneyWhole(totalCurrentValue, source.currency)}, with ${byTypeArr[0].label} representing approximately ${largestSharePct.toFixed(0)}% of the total. Concentration in a single investment type is not automatically negative, but it may increase sensitivity to conditions affecting that type specifically.`
        : null,
    chartData: { byType: byTypeArr, byCountry: byCountryArr },
    sourceReferences: {},
    confidenceLevel: null,
    limitationText: 'Values are as recorded at the report date and do not reflect real-time market pricing.',
  };
}

function buildRetirementReadiness(source: ReportSourceData, premium: PremiumSourceData): BuiltSection {
  const run = premium.forecastReportData?.retirementRun;
  if (!run || run.results.length === 0) {
    return empty('retirement_readiness', 19, 'A retirement forecast has not yet been generated — visit the Retirement Forecast page to create one.');
  }
  return {
    sectionCode: 'retirement_readiness',
    sectionTitle: PREMIUM_SECTION_TITLES.retirement_readiness,
    displayOrder: 19,
    sectionStatus: 'included',
    sectionData: {
      results: run.results,
      explanations: run.explanations,
    },
    narrativeText:
      'This projection uses your recorded retirement balances, contribution rates and the assumptions shown in this report to estimate your retirement income position. It reuses the same Retirement Forecast calculation available on the Forecasting pages — it is not a new or separate calculation.',
    chartData: { results: run.results },
    sourceReferences: { forecastRunId: (run.run as { id?: string } | null)?.id ?? null },
    confidenceLevel: null,
    limitationText: 'Retirement projections are estimates based on current balances, recorded contributions and disclosed assumptions. Actual outcomes depend on future contributions, investment returns, inflation and legislative change.',
  };
}

// Cover types are not economically comparable and must never be summed into
// one "total cover" figure: life/home/vehicle cover amounts are lump sums,
// income protection is normally a monthly benefit, and health cover often
// has no single lump-sum figure at all (a $0 cover_amount there means "no
// lump-sum measure applies", not "no cover recorded").
const COVER_UNIT: Record<string, 'lump_sum' | 'monthly_benefit' | 'no_lump_sum'> = {
  life: 'lump_sum',
  home: 'lump_sum',
  vehicle: 'lump_sum',
  income_protection: 'monthly_benefit',
  health: 'no_lump_sum',
};

function buildInsuranceAnalysis(source: ReportSourceData, premium: PremiumSourceData): BuiltSection {
  const rows = premium.insurancePolicies;
  if (rows.length === 0) return empty('insurance_analysis', 20, 'No insurance policies are currently recorded.');

  const monthlyOf = (premiumAmount: number, freq: string) => {
    const f = freq.toLowerCase();
    if (f === 'annually' || f === 'yearly') return premiumAmount / 12;
    if (f === 'quarterly') return premiumAmount / 3;
    if (f === 'fortnightly') return (premiumAmount * 26) / 12;
    if (f === 'weekly') return (premiumAmount * 52) / 12;
    return premiumAmount;
  };
  const byType = new Map<string, { type: string; label: string; unit: string; coverAmount: number; monthlyPremium: number; count: number }>();
  for (const r of rows) {
    const unit = COVER_UNIT[r.cover_type] ?? 'lump_sum';
    const t = byType.get(r.cover_type) ?? { type: r.cover_type, label: source.content.categoryLabel(r.cover_type), unit, coverAmount: 0, monthlyPremium: 0, count: 0 };
    if (unit !== 'no_lump_sum') t.coverAmount += r.cover_amount;
    t.monthlyPremium += monthlyOf(r.premium, r.premium_frequency);
    t.count += 1;
    byType.set(r.cover_type, t);
  }
  const byTypeArr = Array.from(byType.values()).sort((a, b) => b.coverAmount - a.coverAmount);
  const totalMonthlyPremium = byTypeArr.reduce((s, t) => s + t.monthlyPremium, 0);

  return {
    sectionCode: 'insurance_analysis',
    sectionTitle: PREMIUM_SECTION_TITLES.insurance_analysis,
    displayOrder: 20,
    sectionStatus: 'included',
    sectionData: { policies: rows, byType: byTypeArr, totalMonthlyPremium },
    narrativeText: `Your household has ${rows.length} recorded insurance ${rows.length === 1 ? 'policy' : 'policies'} covering ${byTypeArr.map((t) => t.label).join(', ')}, for approximately ${formatMoneyWhole(totalMonthlyPremium, source.currency)} per month in premiums combined. Cover amounts are shown separately by type below because lump-sum, monthly-benefit and policy-based cover are not directly comparable.`,
    chartData: { byType: byTypeArr },
    sourceReferences: {},
    confidenceLevel: null,
    limitationText: 'This analysis reviews recorded cover types and amounts only. It does not assess policy wording, exclusions, premium affordability, policy expiry or whether cover amounts are adequate for your specific household circumstances.',
  };
}

function buildGoalForecastingDetail(source: ReportSourceData): BuiltSection {
  const activeGoals = source.goals.goals.filter((g) => g.status === 'active');
  if (activeGoals.length === 0) return empty('goal_forecast_detail', 21, 'No active goals with a forecast were found for this period.');

  return {
    sectionCode: 'goal_forecast_detail',
    sectionTitle: PREMIUM_SECTION_TITLES.goal_forecast_detail,
    displayOrder: 21,
    sectionStatus: 'included',
    sectionData: {
      goals: activeGoals.map((g) => ({
        goalName: g.goalName,
        targetAmount: g.forecasts.base.targetAmountFuture,
        currentAmount: g.forecasts.base.currentAmount,
        targetDate: g.targetDate,
        conservative: g.forecasts.conservative,
        base: g.forecasts.base,
        optimistic: g.forecasts.optimistic,
        milestones: g.milestones,
        fundingSources: g.fundingSources,
      })),
    },
    narrativeText:
      'Each goal below is projected under three scenarios — conservative, base and optimistic — using different contribution and return assumptions, alongside the milestones and funding sources recorded for that goal.',
    chartData: null,
    sourceReferences: {},
    confidenceLevel: null,
    limitationText: 'Conservative, base and optimistic scenarios reflect different assumption sets, not a guaranteed range of outcomes.',
  };
}

function buildScenarioForecasting(source: ReportSourceData, premium: PremiumSourceData): BuiltSection {
  const fr = premium.forecastReportData;
  if (!fr) return empty('scenario_forecasting', 22, 'Scenario forecasting data is not yet available.');

  return {
    sectionCode: 'scenario_forecasting',
    sectionTitle: PREMIUM_SECTION_TITLES.scenario_forecasting,
    displayOrder: 22,
    sectionStatus: 'included',
    sectionData: {
      activeScenarioName: fr.scenarioName,
      scenarioComparison: fr.scenarioComparison,
      netWorthRun: fr.netWorthRun?.results ?? [],
      debtRun: fr.debtRun?.results ?? [],
      investmentRun: fr.investmentRun?.results ?? [],
      crossBorderRun: fr.crossBorderRun?.results ?? [],
      resilienceRun: fr.resilienceRun?.results ?? [],
      assumptions: fr.assumptions,
      variances: fr.variances,
    },
    narrativeText: `Net worth is projected under ${fr.scenarioComparison.length} scenario${fr.scenarioComparison.length === 1 ? '' : 's'} you have configured on the Forecasting pages, using the assumptions shown below. This reuses the same Forecasting Engine that powers the Consolidated Forecasting Report — no separate projection is calculated here.`,
    chartData: { scenarioComparison: fr.scenarioComparison, netWorthRun: fr.netWorthRun?.results ?? [] },
    sourceReferences: { activeScenarioId: fr.scenarioId },
    confidenceLevel: null,
    limitationText: 'Scenario forecasts are indicative projections based on the assumptions and scenario settings you have configured. They are not guarantees of future performance.',
  };
}

function buildFinancialTwinFull(source: ReportSourceData): BuiltSection {
  const twin = source.financialTwin;
  if (!twin) return empty('financial_twin_full', 23, 'No Financial Twin has been generated yet — visit the Financial Twin page to create one.');

  return {
    sectionCode: 'financial_twin_full',
    sectionTitle: PREMIUM_SECTION_TITLES.financial_twin_full,
    displayOrder: 23,
    sectionStatus: 'included',
    sectionData: {
      cohortTier: twin.cohortTier,
      cohortDescription: twin.cohortDescription,
      overallConfidence: twin.overallConfidence,
      metrics: twin.metrics,
    },
    narrativeText: `This is the complete set of ${twin.metrics.length} metrics compared against your peer cohort and FHIP planning ranges, grouped by category, with the underlying user value, peer value and healthy range shown for each.`,
    chartData: { metrics: twin.metrics },
    sourceReferences: { financialTwinRunId: twin.id },
    confidenceLevel: twin.overallConfidence !== null ? twin.overallConfidence.toFixed(0) : null,
    limitationText: 'Financial Twin comparisons are indicative synthetic peer profiles, not actual households.',
  };
}

function buildCrossBorderFull(source: ReportSourceData): BuiltSection {
  const d = source.dashboard;
  if (d.countriesInUse.length <= 1) {
    return {
      sectionCode: 'cross_border_full',
      sectionTitle: PREMIUM_SECTION_TITLES.cross_border_full,
      displayOrder: 24,
      sectionStatus: 'omitted',
      sectionData: {},
      narrativeText: null,
      chartData: null,
      sourceReferences: {},
      confidenceLevel: null,
      limitationText: 'Recorded in a single country for this period.',
    };
  }
  return {
    sectionCode: 'cross_border_full',
    sectionTitle: PREMIUM_SECTION_TITLES.cross_border_full,
    displayOrder: 24,
    sectionStatus: 'included',
    sectionData: {
      countries: d.countriesInUse,
      assetsByCountry: d.assetsByCountry,
      liabilitiesByCountry: d.liabilitiesByCountry,
      investmentsByCountry: d.investmentByCountry,
      retirementByCountry: d.retirementByCountry,
      reportingCurrency: source.currency,
    },
    narrativeText: `Your household holds recorded assets, investments, retirement balances or liabilities across ${d.countriesInUse.length} countries. Full local-currency totals for each country are shown below, alongside each category's breakdown.`,
    chartData: {
      assetsByCountry: d.assetsByCountry,
      liabilitiesByCountry: d.liabilitiesByCountry,
      investmentsByCountry: d.investmentByCountry,
      retirementByCountry: d.retirementByCountry,
    },
    sourceReferences: {},
    confidenceLevel: null,
    limitationText: 'Local-country totals are shown as recorded, in each country\'s own currency. A fully converted single-reporting-currency consolidated view is not yet implemented.',
  };
}

// A scenario that doesn't apply to this household's recorded data should say
// so plainly rather than showing "Indefinite survival", which reads as a
// reassuring result rather than "this shock has nothing to act on here".
function applicabilityNote(scenario: StressScenarioType, d: ReportSourceData['dashboard']): string | null {
  if (scenario === 'currency_shock') {
    const homeCountry = d.currency === 'AUD' ? 'AU' : 'IN';
    const foreignInvestments = d.investmentByCountry.filter((c) => c.countryCode !== homeCountry).reduce((s, c) => s + c.value, 0);
    if (foreignInvestments <= 0) return 'Not applicable — no overseas investment holdings are currently recorded.';
  }
  if (scenario === 'rental_vacancy' && d.rentalMonthlyIncome <= 0) {
    return 'Not applicable — no rental or Airbnb income is currently recorded.';
  }
  return null;
}

function buildStressTesting(source: ReportSourceData): BuiltSection {
  const d = source.dashboard;
  if (!d.hasIncome || !d.hasExpenses) {
    return empty('stress_testing', 25, 'Add income and expenses to include stress-test scenarios.');
  }
  const results: StressScenarioResult[] = STRESS_SCENARIOS.map((scenario) => applyStressScenario(d, scenario, source.commitments));

  return {
    sectionCode: 'stress_testing',
    sectionTitle: PREMIUM_SECTION_TITLES.stress_testing,
    displayOrder: 25,
    sectionStatus: 'included',
    sectionData: {
      scenarios: results.map((r) => ({
        scenario: r.scenario,
        label: r.label,
        before: r.before,
        after: r.after,
        monthlyShortfall: r.monthlyShortfall,
        survivalMonths: r.survivalMonths,
        durationMonths: r.durationMonths,
        // netWorth/accessibleLiquidResources deltas were already computed by
        // applyStressScenario but previously unused — surfacing them is what
        // makes combined_severe visibly differ from income_stops alone,
        // since a market decline and rate rise don't move monthlyShortfall
        // (a cash-flow figure) but do move net worth.
        netWorthImpact: r.after.netWorth - r.before.netWorth,
        applicabilityNote: applicabilityNote(r.scenario, d),
      })),
    },
    narrativeText:
      'Each scenario below simulates a single hypothetical shock applied to your current recorded position — such as a job loss, market decline or interest-rate rise — and estimates how many months your accessible liquid resources could sustain the resulting shortfall, if any, alongside any impact on net worth. The combined severe scenario applies job loss, a market decline and a rate rise together, so its net-worth impact is larger even where its monthly-shortfall figure matches job loss alone.',
    chartData: {
      scenarios: results.map((r) => ({
        scenario: r.scenario,
        label: r.label,
        monthlyShortfall: r.monthlyShortfall,
        survivalMonths: r.survivalMonths,
        netWorthImpact: r.after.netWorth - r.before.netWorth,
      })),
    },
    sourceReferences: {},
    confidenceLevel: null,
    limitationText: 'Stress scenarios are simplified simulations based on fixed assumptions (see each scenario\'s parameters). They do not predict actual future events and are not a substitute for personal financial advice.',
  };
}

function buildPersonalActionPlan(source: ReportSourceData): BuiltSection {
  const items: {
    priority: string;
    title: string;
    gapDescription: string;
    currentValue: Record<string, unknown> | null;
    targetValue: Record<string, unknown> | null;
    reviewStep: string;
    module: string;
  }[] = [];

  // Real recommendation-engine matches (action_recommendation_master, Report
  // v3 Phase 3a) — blends pillar-triggered and forecast-triggered rows.
  // Replaces the old direct sourcing from healthScore.recommendations, which
  // bypassed the admin-editable library entirely; pillar-sourced items still
  // carry the underlying component's currentValue/benchmarkValue so the gap
  // display below is unchanged for those.
  for (const rec of source.actionRecommendations) {
    const component = rec.pillarCode ? source.healthScore?.components.find((c) => c.code === rec.pillarCode) : undefined;
    items.push({
      priority: rec.severity === 'critical' || rec.severity === 'high' ? 'high' : rec.severity === 'medium' ? 'medium' : 'low',
      title: rec.title,
      gapDescription: rec.content,
      currentValue: component?.currentValue ?? null,
      targetValue: component?.benchmarkValue ?? null,
      reviewStep: (rec.pillarCode && MODULE_REVIEW_STEP[rec.pillarCode]) || 'Review the relevant section of the platform.',
      module: rec.pillarCode ?? rec.forecastCategory ?? 'general',
    });
  }
  for (const act of source.resilience?.actions ?? []) {
    items.push({
      priority: act.priority,
      title: act.title,
      gapDescription: act.explanation,
      currentValue: null,
      targetValue: null,
      reviewStep: MODULE_REVIEW_STEP[act.relatedModule] ?? 'Review your Financial Resilience page.',
      module: act.relatedModule,
    });
  }

  const priorityRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const top = items.sort((a, b) => (priorityRank[a.priority] ?? 3) - (priorityRank[b.priority] ?? 3)).slice(0, 5);

  if (top.length === 0) return empty('personal_action_plan', 26, 'No deterministic recommendations were available for this period.');

  return {
    sectionCode: 'personal_action_plan',
    sectionTitle: PREMIUM_SECTION_TITLES.personal_action_plan,
    displayOrder: 26,
    sectionStatus: 'included',
    sectionData: { actions: top },
    narrativeText:
      'The items below are ranked by priority and drawn directly from your Financial Health Score and Financial Resilience results. Each shows the gap identified, the current and target values behind that gap where available, and where to go in the platform to review it.',
    chartData: null,
    sourceReferences: {},
    confidenceLevel: null,
    limitationText: 'This plan does not track completion status — it reflects the recommendations current as of this report\'s calculation date.',
  };
}

function buildAppendices(source: ReportSourceData, premium: PremiumSourceData): BuiltSection {
  return {
    sectionCode: 'appendices',
    sectionTitle: PREMIUM_SECTION_TITLES.appendices,
    displayOrder: 27,
    sectionStatus: 'included',
    sectionData: {
      investments: premium.investments,
      insurancePolicies: premium.insurancePolicies,
      assets: premium.assets,
      liabilities: premium.liabilities,
      incomeSources: premium.incomeSources,
      expenseItems: premium.expenseItems,
    },
    narrativeText: 'The tables below list every recorded item used in this report\'s calculations, for full transparency and reconciliation.',
    chartData: null,
    sourceReferences: {},
    confidenceLevel: null,
    limitationText: 'Fields such as rejected records or duplicate-record decisions are not shown as the platform does not yet track record-level review status.',
  };
}

export function buildPremiumSections(source: ReportSourceData, isFirstReport: boolean): BuiltSection[] {
  const premium = source.premium;
  if (!premium) return [];

  return [
    buildTwelveMonthTrends(source, premium),
    buildScoreDiagnosticFull(source),
    buildFinancialDnaFull(source, isFirstReport),
    buildInvestmentAnalysis(source, premium),
    buildRetirementReadiness(source, premium),
    buildInsuranceAnalysis(source, premium),
    buildGoalForecastingDetail(source),
    buildScenarioForecasting(source, premium),
    buildFinancialTwinFull(source),
    buildCrossBorderFull(source),
    buildStressTesting(source),
    buildPersonalActionPlan(source),
    buildAppendices(source, premium),
  ];
}
