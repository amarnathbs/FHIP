// SYNTHETIC Premium household shaped like the Product Owner's (18-10-2026 print complaint): personal + spouse + SMSF entity,
// 17 India mutual-fund holdings over three owners, 28 planned expenses, 5 income sources, goals, forecast, 67 Financial Twin
// metrics and every Premium chapter. Invented names and amounts only: no real person, folio or account.
//
// It supplies (a) the PostgREST-shaped tables the REAL report source resolver reads and (b) the payloads the resolver would
// load from the score / resilience / DNA / goals / twin / forecast / Investment Intelligence services. The generator
// (generateMonthlyReportFixture.vitest.ts) feeds both through the REAL section builders and writes the stored sections.
import { METRIC_CATALOGUE } from '@/lib/engines/twin/metricCatalogue';
import { buildIndiaMfReport, type IndiaMfReportInput, type MfTransaction } from '@/lib/engines/investment-intelligence/indiaMfReport';
import type { Row } from '../../../tests/unit/readModels/helpers/fakeSupabase';
import { expenseItem, incomeSource, liability, profile, tables, USER } from '../../../tests/unit/readModels/helpers/fixtures';

export { USER };

const asset = (id: string, name: string, value: number, owner: string, extra: Row = {}): Row => ({
  id, user_id: USER, asset_name: name, asset_class: 'other', current_value: value, currency_code: 'AUD', owner, master_item_key: null,
  source_type: 'manual', linked_liability_id: null, country_code: 'AU', is_active: true, ...extra,
});
const investment = (id: string, name: string, value: number, owner: string, key: string, extra: Row = {}): Row => ({
  id, user_id: USER, investment_name: name, investment_type: key, current_value: value, cost_base: Math.round(value * 0.8), currency_code: 'AUD', owner,
  master_item_key: key, source_type: 'manual', ii_canonical_account_id: null, ii_canonical_instrument_id: null, country_code: 'AU', annual_contribution: 1200, institution: 'Broker', is_active: true, ...extra,
});
const retirement = (id: string, name: string, balance: number, owner: string, extra: Row = {}): Row => ({
  id, user_id: USER, account_name: name, account_type: 'super', current_balance: balance, currency_code: 'AUD', owner, employer_contribution: 1500,
  personal_contribution: 0, contribution_frequency: 'monthly', source_type: 'manual', retirement_member_id: null, country_code: 'AU', target_retirement_age: 60, is_active: true, ...extra,
});

const EXPENSES: [string, number, string, boolean][] = [
  ['Mortgage repayment', 4000, 'mortgage', true], ['Investment loan repayment', 3000, 'mortgage', true], ['Groceries', 1100, 'groceries', true], ['Electricity', 220, 'utilities', true],
  ['Gas', 90, 'utilities', true], ['Water', 80, 'utilities', true], ['Internet and mobile', 190, 'utilities', true], ['Council rates', 210, 'housing', true],
  ['Home insurance', 160, 'insurance', true], ['Health insurance', 420, 'insurance', true], ['Car insurance', 130, 'insurance', true], ['Car fuel', 320, 'transport', true],
  ['Car registration', 70, 'transport', true], ['Public transport', 110, 'transport', true], ['School fees', 900, 'education', true], ['Childcare and activities', 350, 'education', true],
  ['Medical and pharmacy', 180, 'health', true], ['Dining out', 450, 'dining', false], ['Streaming and subscriptions', 85, 'entertainment', false], ['Gym memberships', 120, 'health', false],
  ['Clothing', 260, 'shopping', false], ['Holidays', 700, 'travel', false], ['Gifts and donations', 150, 'gifts', false], ['Pet care', 140, 'household', true],
  ['Home maintenance', 250, 'housing', true], ['Family support overseas', 500, 'family_support_remittance', false], ['Personal care', 120, 'personal', false], ['Miscellaneous', 200, 'other', false],
];

export function insurancePolicies() {
  const p = (id: string, name: string, cover: number, premium: number, freq: string, type: string) => ({ id, policy_name: name, cover_amount: cover, premium, premium_frequency: freq, cover_type: type, renewal_date: '2027-03-01', waiting_period_days: null });
  return [p('p1', 'Life cover (self)', 900000, 1450, 'annually', 'life'), p('p2', 'Life cover (spouse)', 700000, 1120, 'annually', 'life'), p('p3', 'Income protection', 7000, 2200, 'annually', 'income_protection'), p('p4', 'Private health', 0, 420, 'monthly', 'health'), p('p5', 'Home and contents', 1_400_000, 160, 'monthly', 'home'), p('p6', 'Car comprehensive', 38000, 130, 'monthly', 'vehicle')];
}

export function monthlyReportTables(): Record<string, Row[]> {
  return tables(
    profile('AUD', 'AU', 56),
    {
      assets: [
        asset('a-house', 'Family home', 1_395_000, 'joint'),
        asset('a-cash', 'Savings and offset', 21_798, 'self', { asset_class: 'cash', master_item_key: 'savings_account' }),
        asset('a-other', 'Other assets', 253_500, 'spouse', { master_item_key: 'collectibles' }),
        asset('a-in-flat', 'Pune flat', 22_400_000, 'self', { asset_class: 'property', master_item_key: 'investment_property', currency_code: 'INR', country_code: 'IN' }),
      ],
      insurance_policies: insurancePolicies().map((p) => ({ ...p, user_id: USER, is_active: true })),
      investments: [
        investment('v-shares', 'Shares', 25_000, 'self', 'shares'),
        investment('v-prop', 'Investment property', 565_000, 'joint', 'property'),
      ],
      retirement_accounts: [
        retirement('r-smsf', 'Family SMSF', 503_000, 'self'),
        retirement('r-other', 'Other Retirement Assets', 133_000, 'smsf'),
        retirement('r-sp', 'Spouse super', 0, 'spouse'),
      ],
      liabilities: [
        liability('l-home', { liability_name: 'Home loan', debt_type: 'mortgage', master_item_key: 'home_loan', balance: 800_000, owner: 'joint', monthly_repayment: 4000, interest_rate: 6.1, country_code: 'AU' }),
        liability('l-inv', { liability_name: 'Investment loan', debt_type: 'mortgage', master_item_key: 'investment_loan', balance: 585_857, owner: 'self', monthly_repayment: 3000, interest_rate: 6.4, country_code: 'AU' }),
      ],
      income_sources: [
        incomeSource('i-1', 'Employment Salary (self)', 9000, 'monthly', { net_amount: 6700, employer_name: 'Acme Pty Ltd' }),
        incomeSource('i-2', 'Employment Salary (spouse)', 7416, 'monthly', { net_amount: 5700, employer_name: 'Globex' }),
        incomeSource('i-3', 'Rental Income', 2123, 'monthly', { net_amount: 2123, income_type: 'rental', master_item_key: 'rental_income' }),
        incomeSource('i-4', 'Interest', 150, 'monthly', { net_amount: 150, income_type: 'interest', master_item_key: 'interest_income' }),
        incomeSource('i-5', 'Dividends', 120, 'monthly', { net_amount: 120, income_type: 'dividend', master_item_key: 'dividend_income' }),
      ],
      expense_items: EXPENSES.map(([name, amount, key, essential], i) => expenseItem(`e-${i}`, name, amount, 'monthly', { master_item_key: key, is_essential: essential })),
    },
  );
}

// ---------------------------------------------------------------------------
// Score, resilience, DNA, goals, twin, forecast payloads (what the real loaders would return)
// ---------------------------------------------------------------------------
const FULL_ELIGIBILITY = {
  state: 'full', reviewedSections: 7, totalRelevantSections: 7, scoredComponents: 7, totalRelevantComponents: 7, confidencePercent: 92,
  confidenceTier: 'high', missingSections: [], preliminaryReasons: [], canDisplayNumericScore: true,
};

const comp = (code: string, label: string, score: number, weight: number, band: string, explanation: string) => ({
  code, label, rawScore: score, weight, weightedContribution: score * weight, statusBand: band, dataCompleteness: 100, treatment: 'scored', explanation, currentValue: {}, benchmarkValue: {},
});

export function healthScorePayload() {
  return {
    overallScore: 66.8, roundedScore: 67, statusBand: 'good', statusLabel: 'Good', dataConfidence: 92, riskOverrideApplied: false, riskOverrideReason: null,
    components: [
      comp('cash_flow', 'Cash Flow Health', 69, 0.15, 'good', 'Your monthly surplus is positive but a large share of income is committed to debt repayments.'),
      comp('savings', 'Savings Capacity', 58, 0.12, 'fair', 'Savings and investment contributions are modest relative to net income.'),
      comp('emergency_fund', 'Emergency Fund', 72, 0.12, 'good', 'Accessible reserves cover about 7.8 months of essential expenses.'),
      comp('debt', 'Debt Management', 41, 0.18, 'needs_attention', 'Debt balances are high against annual income and repayments are heavy.'),
      comp('net_worth', 'Net Worth Position', 74, 0.12, 'good', 'Assets comfortably exceed liabilities.'),
      comp('investment', 'Investment Health', 71, 0.1, 'good', 'The portfolio is diversified across property, shares, retirement assets and Indian mutual funds.'),
      comp('retirement', 'Retirement Readiness', 76, 0.11, 'good', 'Recorded retirement balances and contributions are on a reasonable path.'),
      comp('insurance', 'Insurance Protection', 63, 0.1, 'fair', 'Core cover is in place; review income protection and life cover amounts.'),
    ],
    recommendations: [], positiveContributors: ['Emergency fund', 'Net worth position'], reductions: ['Debt management'], modelVersion: 'fhs-2.0.0',
    previousScore: 66, scoreChange: 1,
    history: [{ score_month: '2026-08-01', rounded_score: 65 }, { score_month: '2026-09-01', rounded_score: 66 }, { score_month: '2026-10-01', rounded_score: 67 }],
    eligibility: FULL_ELIGIBILITY,
    sectionStatus: { income: 'complete', expenses: 'complete', assets: 'complete', liabilities: 'complete', investments: 'complete', retirement: 'complete', insurance: 'complete' },
  };
}

export function resiliencePayload() {
  const rc = (code: string, label: string, score: number, band: string, explanation: string) => comp(code, label, score, 0.2, band, explanation);
  return {
    overallScore: 68.4, roundedScore: 68, statusBand: 'moderately_vulnerable', statusLabel: 'Moderately Vulnerable', confidence: 90, riskOverrideApplied: false, riskOverrideReason: null,
    components: [
      rc('liquidity', 'Liquidity buffer', 72, 'good', 'Accessible liquid resources cover several months.'),
      rc('income_stability', 'Income stability', 80, 'good', 'Two stable salaries and rental income.'),
      rc('debt_pressure', 'Debt pressure', 45, 'needs_attention', 'Debt repayments take a large share of net income.'),
    ],
    risks: [
      { code: 'debt_service', category: 'debt', severity: 'high', title: 'High debt-service load', explanation: 'Required repayments are a large share of monthly net income.', metricValue: 0.48, thresholdValue: 0.35 },
      { code: 'concentration', category: 'concentration', severity: 'medium', title: 'Property concentration', explanation: 'A large share of recorded assets is in property.', metricValue: 0.7, thresholdValue: 0.6 },
      { code: 'insurance_gap', category: 'protection', severity: 'low', title: 'Income protection not recorded', explanation: 'No income protection policy is recorded.', metricValue: null, thresholdValue: null },
    ],
    actions: [{ code: 'build_liquid', title: 'Build liquid reserves', explanation: 'Add to savings to cover at least six months of essential expenses.', priority: 'medium', relatedModule: 'savings', relatedMetric: 'emergency_fund' }],
    accessibleLiquidResources: 61000, committedCash90d: 12000, modelVersion: 'res-1.0.0',
    previousScore: 67, scoreChange: 1, history: [{ score_month: '2026-08-01', rounded_score: 66 }, { score_month: '2026-09-01', rounded_score: 67 }, { score_month: '2026-10-01', rounded_score: 68 }],
    eligibility: { state: 'full', canDisplayNumericScore: true, confidencePercent: 90 },
  };
}

export function dnaPayload() {
  const driver = (type: string, metricCode: string, explanation: string) => ({ type, metricCode, metricValue: 1, thresholdValue: 1, contribution: 1, explanation });
  return {
    status: 'confirmed', primaryProfileCode: 'property_focused_investor', primaryScore: 82, secondaryProfileCode: 'steady_builder', secondaryScore: 64, confidence: 88, confidenceBand: 'high',
    confidenceLabel: 'Very high', profileChanged: false, candidates: [], drivers: [],
    strengths: [driver('strength', 'net_worth', 'Net worth is well above the median for the cohort.'), driver('strength', 'income_stability', 'Income is stable and diversified across employment and rent.')],
    risks: [driver('risk', 'liquidity', 'A high share of wealth is in property, which is illiquid.'), driver('risk', 'debt', 'Debt balances are large relative to annual income.')],
    actions: [
      { code: 'liquid', title: 'Build liquid reserves', explanation: 'Consider building liquid reserves alongside your property holdings.', priority: 'high', relatedModule: 'savings', relatedMetric: 'liquidity', estimatedEffect: 'Improves resilience' },
      { code: 'diversify', title: 'Broaden diversification', explanation: 'Consider whether investments beyond property and shares would reduce concentration.', priority: 'medium', relatedModule: 'investments', relatedMetric: 'concentration', estimatedEffect: 'Lowers concentration risk' },
    ],
    traits: [
      { code: 'property_tilt', label: 'Property tilt', level: 'high', direction: 'stable', value: 0.7, targetRangeLabel: '30-50%', explanation: 'Property is a very large share of recorded assets.' },
      { code: 'liquidity', label: 'Liquidity', level: 'moderate', direction: 'improving', value: 0.2, targetRangeLabel: '15-30%', explanation: 'Liquid assets are a moderate share of the total.' },
      { code: 'debt_load', label: 'Debt load', level: 'high', direction: 'stable', value: 0.48, targetRangeLabel: 'below 35%', explanation: 'Debt repayments take a large share of net income.' },
      { code: 'saving_habit', label: 'Saving habit', level: 'moderate', direction: 'stable', value: 0.12, targetRangeLabel: '15-25%', explanation: 'Savings are positive but below the planning range.' },
    ],
    dataCompletenessPct: 95, modelVersion: 'dna-1.0.0',
    archetypes: { property_focused_investor: { profile_code: 'property_focused_investor', profile_name: 'Property-Focused Investor', short_description: '', long_description: '', icon: null }, steady_builder: { profile_code: 'steady_builder', profile_name: 'Steady Builder', short_description: '', long_description: '', icon: null } },
    history: [], propertyDebtBreakdown: [], propertyDebtBreakdownAvailable: true,
  };
}

const forecast = (target: number, current: number, status: string, required: number | null) => ({
  targetAmountOriginal: target, targetAmountFuture: target * 1.1, currentAmount: current, projectedTargetDateValue: target * 0.9, projectedCompletionDate: null,
  requiredMonthlyContribution: required, currentMonthlyContribution: 800, fundingGapAtTargetDate: target * 0.1, progressPct: Math.round((current / target) * 100),
  forecastFundingPct: 90, trackStatus: status, explanation: 'Projected on the approved assumptions.', currentValue: {},
});
export function goalsPayload() {
  const goal = (id: string, name: string, type: string, target: number, current: number, date: string, status: string) => ({
    id, goalName: name, goalType: type, goalCategory: null, forecastLogicKey: 'standard', description: null, status: 'active', ownerMemberId: null, beneficiaryMemberId: null, countryCode: 'AU',
    currencyCode: 'AUD', userPriority: 1, importanceType: 'important', targetAmount: target, targetDate: date, targetDateFlexibility: 'fixed', currentAmount: current, manualCurrentAmount: current,
    plannedContributionAmount: 800, contributionFrequency: 'monthly', allocatedMonthlyContribution: 800, annualContributionGrowthPct: 0, inflationAdjusted: true, nextReviewDate: null,
    forecasts: { conservative: forecast(target, current, 'at_risk', 1200), base: forecast(target, current, status, 950), optimistic: forecast(target, current, 'on_track', 700) },
    milestones: [{ milestone_name: 'Half way', target_amount: target / 2, status: 'pending' }, { milestone_name: 'Three quarters', target_amount: target * 0.75, status: 'pending' }],
    fundingSources: [],
  });
  return {
    goals: [
      goal('g1', 'Children education fund', 'education', 120000, 38000, '2034-01-31', 'on_track'),
      goal('g2', 'Holiday home deposit', 'property', 250000, 90000, '2031-06-30', 'at_risk'),
      goal('g3', 'Retire at 60 income top-up', 'retirement', 400000, 150000, '2042-06-30', 'on_track'),
      goal('g4', 'Debt-free target', 'debt', 585857, 120000, '2036-12-31', 'at_risk'),
    ],
    summary: { activeGoalsCount: 4, totalTargetAmount: 1355857, totalCurrentAmount: 398000, overallProgressPct: 29, totalMonthlyContribution: 3200, onTrackCount: 2, atRiskCount: 2, offTrackCount: 0, achievedCount: 0, nextGoalDue: null },
    affordability: { status: 'ok', monthlySurplus: 1877, totalPlannedGoalContributions: 3200, unallocatedAmount: 0, overallocatedAmount: 1323, usageRatio: 1.7, warning: null },
    modelVersion: 'goals-1.0.0', goalTypes: [],
  };
}

export function twinDetail() {
  const metrics = METRIC_CATALOGUE.map((m, i) => ({
    metricCode: m.code, categoryCode: m.category,
    userValue: i === 20 ? null : m.unit === 'currency' ? 50_000 + i * 17_345.25 : m.unit === 'percentage' ? 5 + ((i * 7.3) % 90) : m.unit === 'months' ? 3 + (i % 9) : m.unit === 'days' ? 2 + (i % 10) : m.unit === 'ratio' ? 0.4 + (i % 7) * 0.9 : 2 + (i % 4),
    peerValue: m.unit === 'currency' ? 70_000 + i * 9_000 : m.unit === 'percentage' ? 10 + ((i * 5.1) % 70) : 4 + (i % 6), healthyMin: m.unit === 'percentage' ? 10 : null, healthyMax: m.unit === 'percentage' ? 40 : null,
    futureSelfValue: null, statisticType: 'median', absoluteGap: null, percentageGap: null, percentileRank: null, comparisonStatus: i % 3 === 0 ? 'behind' : i % 3 === 1 ? 'aligned' : 'ahead',
    benchmarkClass: 'indicative', confidenceScore: 70, notComparableReason: null,
  }));
  return {
    id: 'twin-1', runDate: '2026-10-01', cohortTier: 2, overallConfidence: 78, metricsCompared: 67, aheadCount: 22, alignedCount: 23, behindCount: 22, notComparableCount: 0,
    dataCompletenessPct: 95, status: 'completed', createdAt: '2026-10-01T00:00:00Z', primaryCohortId: 'c1', cohortDescription: 'Dual-income household, 35-44, Sydney, two dependants', metrics, insights: [],
  };
}

const scenarioRows = (start: number, growth: number) => Array.from({ length: 11 }, (_, i) => ({ period_number: i * 12, period_date: `${2026 + i}-10-01`, closing_value: Math.round(start * Math.pow(growth, i)), entity_id: null }));
export function forecastReportData() {
  return {
    generatedAt: '2026-10-18T00:00:00Z', comparisonDate: '2026-10-16', dataLastUpdated: '2026-10-16', currency: 'AUD', scenarioName: 'Base case', scenarioId: 's1', dashboard: {}, variances: [],
    netWorthRun: { run: { id: 'run-nw' }, results: scenarioRows(1_377_441, 1.045), explanations: [] },
    retirementRun: {
      run: { id: 'run-ret' }, results: scenarioRows(636_000, 1.07),
      explanations: [
        { title: 'How your retirement balance is projected', explanationText: 'The projection grows recorded balances by the assumed return and adds recorded contributions each month until the target retirement age.' },
        { title: 'Contribution assumptions', explanationText: 'Employer and personal contributions are held at their recorded amounts, increased by the assumed wage growth.' },
      ],
    },
    goalRun: null, debtRun: null, investmentRun: null, crossBorderRun: null, resilienceRun: null,
    scenarioComparison: [
      { scenarioId: 's1', scenarioName: 'Base case', scenarioType: 'base', runId: 'r1', oneYear: 1_450_000, fiveYear: 1_780_000, tenYear: 2_250_000 },
      { scenarioId: 's2', scenarioName: 'Conservative', scenarioType: 'conservative', runId: 'r2', oneYear: 1_410_000, fiveYear: 1_640_000, tenYear: 1_950_000 },
      { scenarioId: 's3', scenarioName: 'Optimistic', scenarioType: 'optimistic', runId: 'r3', oneYear: 1_490_000, fiveYear: 1_930_000, tenYear: 2_600_000 },
    ],
    assumptions: {}, actionPlan: [],
  };
}

// ---------------------------------------------------------------------------
// India mutual funds: 17 holdings across Self (9), Spouse (5) and a HUF (3)
// ---------------------------------------------------------------------------
const FUNDS = [
  'Axis Large Cap Fund - Direct Plan - Growth', 'HDFC Flexi Cap Fund - Direct Plan - Growth', 'ICICI Prudential Bluechip Fund - Direct Plan - Growth', 'Parag Parikh Flexi Cap Fund - Direct Plan - Growth',
  'SBI Small Cap Fund - Direct Plan - Growth', 'Nippon India Small Cap Fund - Direct Plan - Growth', 'Kotak Emerging Equity Fund - Direct Plan - Growth', 'UTI Nifty 50 Index Fund - Direct Plan - Growth',
  'Mirae Asset Large and Midcap Fund - Direct Plan - Growth', 'Motilal Oswal Midcap Fund - Direct Plan - Growth', 'Canara Robeco Equity Hybrid Fund - Direct Plan - Growth', 'Franklin India Prima Fund - Direct Plan - IDCW',
  'Aditya Birla Sun Life Short Term Fund - Direct Plan - Growth', 'DSP Tax Saver Fund - Direct Plan - Growth', 'Tata Digital India Fund - Direct Plan - Growth', 'Bandhan Core Equity Fund - Direct Plan - Growth', 'Quant Active Fund - Direct Plan - Growth',
];

export function indiaMfInput(): IndiaMfReportInput {
  let n = 0;
  const t = (accountId: string, instrumentId: string, type: string, date: string, units: number | null, amount: number): MfTransaction => {
    n += 1;
    return { id: `p-${n}`, accountId, instrumentId, type, date, units, amount, pricePerUnit: units ? amount / units : null, status: 'parsed', sourceReference: null };
  };
  const owners = ['m-self', 'm-spouse', null];
  const accounts = FUNDS.map((_, i) => ({ id: `a-${i}`, folioNumber: `${9049492104 + i * 7919}${i % 3 === 0 ? ' / 0' : ''}`, ownerMemberId: i < 9 ? owners[0] : i < 14 ? owners[1] : owners[2], currencyCode: 'INR', countryCode: 'IN' }));
  const transactions: MfTransaction[] = [];
  FUNDS.forEach((_, i) => {
    const a = `a-${i}`;
    const inst = `i-${i}`;
    transactions.push(t(a, inst, 'purchase', `202${1 + (i % 3)}-0${1 + (i % 9)}-1${i % 9}`, 400 + i * 35, 80_000 + i * 6_500));
    for (let k = 0; k < 8; k += 1) transactions.push(t(a, inst, 'sip', `2024-${String(1 + k).padStart(2, '0')}-05`, 20 + i, 5_000 + k * 100));
    if (i % 4 === 1) transactions.push(t(a, inst, 'redemption', '2025-12-01', 50, 12_000 + i * 700));
    if (i % 5 === 2) transactions.push(t(a, inst, 'dividend', '2025-03-28', null, 1_800));
  });
  return {
    valuationDate: '2026-10-16', reportDate: '2026-10-16', accounts,
    instruments: FUNDS.map((name, i) => ({ id: `i-${i}`, name, isin: null, instrumentClass: 'mutual_fund' })),
    transactions, snapshots: [],
    navs: FUNDS.map((_, i) => ({ instrumentId: `i-${i}`, date: '2026-10-15', price: 150 + i * 23.4567 })), truth: [], allocations: [],
    members: [{ id: 'm-self', fullName: 'Amar Rao', relationship: 'self' }, { id: 'm-spouse', fullName: 'Asha Rao', relationship: 'spouse' }], entities: [{ id: 'e-huf', name: 'Rao Family HUF', entityType: 'huf' }],
    sensex: { date: '2026-10-16', value: 84021.5 }, nifty: { date: '2026-10-16', value: 25760.35 },
  };
}
export function indiaMfReport() {
  const input = indiaMfInput();
  // The last three folios belong to the HUF entity.
  input.allocations = [14, 15, 16].map((i) => ({ accountId: `a-${i}`, instrumentId: null, ownerMemberId: null, ownerEntityId: 'e-huf', basisPoints: 10000, groupId: `g-${i}`, status: 'active', effectiveFrom: null, effectiveTo: null }));
  return buildIndiaMfReport(input);
}

export function iiChapters() {
  const portfolio = (ccy: string, rate: number) => ({
    currencyCode: ccy, schemeCount: 17, totalValue: 5_200_000, portfolioXirr: { status: 'CALCULATED', value: { rate } },
    blendedBenchmarkReturn: { status: 'CALCULATED', value: { blendedReturn: rate - 0.03, coveragePct: 90 } }, risk: {}, rolling: {}, drawdownSeries: [], performanceVsBenchmarkSeries: [], contributingBenchmarks: [], annotations: [], inputFingerprint: 'x',
  });
  const performance = { results: { asOfDate: '2026-10-15', periodStart: '2025-10-15', engineVersion: 'v-fixture', subVersions: {}, portfolios: [portfolio('INR', 0.162), portfolio('AUD', 0.081)], schemes: [], crossCurrency: { status: 'NOT_APPLICABLE' }, annotations: [] }, warnings: [], earliestCashFlowDateByInstrument: {} };
  const obs = (i: number) => ({ classification: 'consistent', text: `Series ${i}: contributions were recorded in 11 of the last 12 months, on or near the 5th, with a median amount of INR ${(5000 + i * 250).toLocaleString('en-IN')}.` });
  const sip = {
    results: { asOfDate: '2026-10-15', engineVersion: 'v-fixture', seriesCount: 18, presentableCount: 15, analytics: Array.from({ length: 6 }, (_, i) => ({ series: { seriesKey: `s${i}` }, actualXirr: null, benchmarkSip: null, observations: [obs(i), obs(i + 10)] })) },
    warnings: [], earliestTransactionDateByInstrument: {},
  };
  const sectors = ['Financial Services', 'Information Technology', 'Consumer Goods', 'Healthcare', 'Energy', 'Automobile', 'Industrials', 'Materials', 'Telecom', 'Utilities', 'Real Estate'];
  const xray = {
    results: {
      asOfDate: '2026-10-15', engineVersion: 'v-fixture', classificationVersion: 'cls-1',
      sectorExposure: { status: 'ok', buckets: sectors.map((s, i) => ({ key: s, label: s, effectiveWeight: 0.26 - i * 0.021 })) }, securityConcentration: { status: 'ok', buckets: [] }, schemeConcentration: { status: 'ok', buckets: [] },
    },
    warnings: [],
  };
  const disposals = Array.from({ length: 8 }, (_, i) => ({ instrumentKey: `i-${i}`, disposalDate: `2025-1${(i % 3)}-0${1 + i}`, classification: i % 2 ? 'long_term' : 'short_term', taxableGain: 12_000 + i * 3_400 }));
  const taxAndCost = {
    results: { disposalResults: disposals, exitLoadResults: [{}, {}], taxYearAggregation: [], disclaimer: 'This is a simulation based on recorded data and is not tax advice.', residencyNote: null, ruleVersionNote: 'Rule version FY2025-26.', engineVersion: 'v-fixture' },
    asOfDate: '2026-10-15', taxProfileSource: 'persisted_profile', instrumentNames: Object.fromEntries(FUNDS.map((f, i) => [`i-${i}`, f])),
  };
  const sev = ['high', 'medium', 'medium', 'low', 'low'];
  const reviewItems = {
    totalOpenCount: 5,
    openItems: sev.map((s, i) => ({ title: `Review item ${i + 1}: holding needs attention`, description: 'A recorded holding has an incomplete cost basis, so the overall gain for that holding is shown as not available. Upload the earlier statement to complete the history.', severity: s, category: 'data_quality', compliance_classification: 'observation', source_module: 'reconciliation', as_of_date: '2026-10-15', rule_key: `rule_${i}`, rule_version: 'v1' })),
  };
  return { performance, sip, xray, taxAndCost, reviewItems };
}

// ---------------------------------------------------------------------------
// The Consolidated Forecasting Report (components/forecast/ForecastReportContent.tsx): runs, variances, scenarios, assumptions
// ---------------------------------------------------------------------------
function run(startValue: number, monthlyGrowth: number, months: number, entities: { id: string | null; type: string; title: string; text: string }[] = [{ id: null, type: 'household', title: 'How this was projected', text: 'The projection applies the assumed growth rate to the recorded balance and adds the recorded monthly contribution, month by month, over the horizon.' }]) {
  const results = entities.flatMap((e, ei) =>
    Array.from({ length: months + 1 }, (_, i) => ({
      period_number: i,
      period_date: `${2026 + Math.floor((9 + i) / 12)}-${String(((9 + i) % 12) + 1).padStart(2, '0')}-01`,
      closing_value: Math.round((startValue / (ei + 1)) * Math.pow(1 + monthlyGrowth, i)),
      target_value: null,
      entity_id: e.id,
      entity_type: e.type,
    })),
  );
  return { run: { id: `run-${startValue}`, status: 'completed', created_at: '2026-10-16T00:00:00Z' }, results, explanations: entities.map((e) => ({ title: e.title, explanation_text: e.text, entity_id: e.id, entity_type: e.type })) };
}

export function forecastingReportData(dashboard: unknown) {
  const goalEntities = ['Children education fund', 'Holiday home deposit', 'Retire at 60 income top-up', 'Debt-free target'].map((t, i) => ({ id: `g${i}`, type: 'goal', title: t, text: `${t} is projected from its recorded balance and planned contributions under the base assumptions; the projected value at the target date is shown above.` }));
  const debtEntities = ['Home loan', 'Investment loan'].map((t, i) => ({ id: `d${i}`, type: 'liability', title: t, text: `${t} reduces with the scheduled repayments at the recorded interest rate until it is repaid.` }));
  const invEntities = ['Shares', 'Investment property'].map((t, i) => ({ id: `i${i}`, type: 'investment', title: t, text: `${t} grows at the assumed long-term return, with recorded annual contributions added.` }));
  const variance = (category: string, start: number, forecast: number, actual: number, status: string) => ({
    forecastCategory: category, hasOriginal: true, baselineDate: '2026-01-01', comparisonDate: '2026-10-16', dataLastUpdated: '2026-10-16', startValue: start, forecastTillDate: forecast, actualTillDate: actual,
    varianceAmount: actual - forecast, variancePercentage: ((actual - forecast) / forecast) * 100, result: actual >= forecast ? 'ahead' : 'behind', status, finalTarget: category === 'retirement' ? 1_800_000 : null,
    revisedForecast: null, finalTargetGap: category === 'retirement' ? 1_200_000 : null, primaryDriver: null, forecastHorizonExceeded: category === 'debt',
    actualBasis: 'Sum of recorded personal assets, investments and retirement accounts less recorded liabilities, as at the comparison date.',
    finalTargetBasis: 'No final target recorded for this category.',
  });
  return {
    generatedAt: '2026-10-18T08:00:00Z', comparisonDate: '2026-10-16', dataLastUpdated: '2026-10-16', currency: 'AUD', scenarioName: 'Base case', scenarioId: 's1', dashboard,
    variances: [variance('net_worth', 1_250_000, 1_330_000, 1_377_441, 'ahead_of_plan'), variance('retirement', 560_000, 600_000, 636_000, 'on_track'), variance('goal', 380_000, 395_000, 398_000, 'on_track'), variance('debt', 1_450_000, 1_420_000, 1_385_857, 'ahead_of_plan'), variance('cross_border', 400_000, 410_000, 400_000, 'slightly_behind')],
    netWorthRun: run(1_377_441, 0.0035, 120), retirementRun: run(636_000, 0.0055, 120), goalRun: run(398_000, 0.004, 120, goalEntities), debtRun: run(1_385_857, -0.003, 120, debtEntities),
    investmentRun: run(590_000, 0.005, 120, invEntities), crossBorderRun: run(400_000, 0.004, 120), resilienceRun: run(1_100_000, 0.003, 120),
    scenarioComparison: forecastReportData().scenarioComparison,
    assumptions: Object.fromEntries(
      [['inflation', 3.0, '%', 'percentage', 'system_default', 'RBA target band midpoint'], ['wage_growth', 3.5, '%', 'percentage', 'system_default', 'ABS wage price index'], ['equity_return', 7.0, '%', 'percentage', 'user_override', 'Your setting'], ['property_growth', 4.5, '%', 'percentage', 'system_default', 'Long-run national median'], ['fx_rate_aud_inr', 56, '', 'number', 'system_default', 'Admin-managed rate'], ['retirement_age', 60, 'years', 'number', 'user_override', 'Your goal'], ['super_return', 6.5, '%', 'percentage', 'system_default', 'Default fund assumption'], ['savings_interest', 4.0, '%', 'percentage', 'system_default', 'Typical high-interest savings']].map(([key, value, unit, valueType, sourceType, sourceReference]) => [key, { key, value, unit, valueType, sourceType, sourceReference }]),
    ),
    actionPlan: ['Reduce debt faster', 'Build a six-month emergency fund', 'Review retirement contributions', 'Check insurance cover', 'Diversify beyond property'].map((t, i) => ({ id: `a${i}`, title: t, severity: ['high', 'medium', 'medium', 'low', 'low'][i], content: `${t}: a deterministic observation from the recommendation library for this household, written in plain English so the reader can decide what, if anything, to change.` })),
  };
}
