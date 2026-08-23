import type { DashboardSummary } from './dashboard';
import { percentChange } from './dashboard';

export const MODEL_VERSION = 'dna-1.0.0';

export type ProfileCode =
  | 'cash_rich_accumulator'
  | 'wealth_builder'
  | 'lifestyle_optimiser'
  | 'property_focused_investor'
  | 'debt_constrained_builder'
  | 'future_ready_professional'
  | 'financial_stabiliser'
  | 'retirement_focused_preserver';

export const ALL_PROFILE_CODES: ProfileCode[] = [
  'cash_rich_accumulator',
  'wealth_builder',
  'lifestyle_optimiser',
  'property_focused_investor',
  'debt_constrained_builder',
  'future_ready_professional',
  'financial_stabiliser',
  'retirement_focused_preserver',
];

// ---------------------------------------------------------------------------
// DNA metric vector — the inputs every profile is scored against. Reuses
// Module 3/4's shared DashboardSummary fields rather than recomputing ratios.
// ---------------------------------------------------------------------------
export interface DnaMetrics {
  age: number | null;
  dependantsCount: number;
  isSelfEmployed: boolean;
  isRetired: boolean;
  savingsRate: number | null;
  investmentContributionRate: number | null;
  retirementContributionRate: number | null;
  liquidAssetRatio: number | null;
  propertyConcentration: number | null;
  discretionaryRatio: number | null;
  essentialExpenseRatio: number | null;
  debtToIncome: number | null;
  debtServiceRatio: number | null;
  emergencyFundMonths: number | null;
  investmentDiversificationScore: number | null;
  passiveIncomeRatio: number | null;
  incomeSourceCount: number;
  netWorthGrowthPct: number | null;

  // -------------------------------------------------------------------
  // Debt-purpose split (App Review Spec 1 §24-28) — sourced from
  // dashboard.ts's classifyDebtPurpose()/DashboardSummary purpose fields,
  // never recomputed here. See assessDebtPurpose() below for how these
  // feed the three separately-banded debt-dependence assessments.
  // -------------------------------------------------------------------
  ownerOccupiedDebtBalance: number;
  ownerOccupiedDebtMonthlyRepayment: number;
  investmentPropertyDebtBalance: number;
  investmentPropertyDebtMonthlyRepayment: number;
  consumerOrOtherDebtBalance: number;
  consumerOrOtherDebtMonthlyRepayment: number;
  // Household rental/Airbnb income — used only as an informational
  // corroborating signal in the investment-property explanation text (see
  // "rental-income to specific property" note in assessDebtPurpose), never
  // to change a threshold. There is no schema link from a specific rental-
  // income row to a specific investment-property liability (confirmed:
  // Chunk 3a/3b added linked_liability_id only for SMSF-held property,
  // supabase/migrations/0035; the plain assets/income grids have no such
  // link), so this is a household-level aggregate, not a verified per-
  // property match.
  investmentPropertyRentalIncomeMonthly: number;
  // Reference-band inputs, computed once here so assessDebtPurpose() stays
  // a pure function of DnaMetrics and every number in it is traceable back
  // to a DashboardSummary field.
  ownerOccupiedDebtToGrossIncomeRatio: number | null; // repayment / gross monthly income (Spec 1 §24: ~30% reference)
  investmentPropertyDebtCapacity: number | null; // income - 1.5x living expenses - owner-occupied repayment (Spec 1 §25 worked example)
  investmentPropertyDebtToCapacityRatio: number | null; // repayment / capacity
  consumerOrOtherDebtServiceRatio: number | null; // consumer/other repayment / income — kept separate per Spec 1 §26 / DNA-05
  propertyPurposeDebtRatio: number | null; // (owner-occupied + investment-property balance) / total liabilities — the real purpose signal behind property_focused_investor, replacing a blended debtToIncome guess
}

export interface DnaProfileInput {
  dashboard: DashboardSummary;
  age: number | null;
  dependantsCount: number;
  isSelfEmployed: boolean;
  isRetired: boolean;
  config: DnaConfig;
  previousProfileCode: string | null;
}

export interface DnaConfig {
  dimensionWeights: Record<string, number>;
  secondaryThreshold: { minScore: number; maxGapFromPrimary: number };
  profileChangeThreshold: number;
  confidenceWeights: { dataCompleteness: number; signalConsistency: number; separation: number; recency: number };
  confidenceBands: { min: number; band: string; label: string }[];
}

function clamp(v: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, v));
}

export function computeDnaMetrics(input: {
  dashboard: DashboardSummary;
  age: number | null;
  dependantsCount: number;
  isSelfEmployed: boolean;
  isRetired: boolean;
}): DnaMetrics {
  const d = input.dashboard;
  const income = d.netMonthlyIncome || d.grossMonthlyIncome;
  const essentialExpenseRatio = income > 0 ? d.essentialMonthlyExpenses / income : null;
  const netWorthGrowthPct =
    d.snapshots.length >= 2 ? percentChange(d.netWorth, d.snapshots[0].net_worth) : null;

  // Spec 1 §24: owner-occupied debt is assessed against GROSS household
  // income (explicitly, not net) — the only place in this file gross is
  // used as the serviceability denominator rather than income/incomeForSurplus.
  const ownerOccupiedDebtToGrossIncomeRatio =
    d.grossMonthlyIncome > 0 ? d.ownerOccupiedDebtMonthlyRepayment / d.grossMonthlyIncome : null;

  // Spec 1 §25 worked example: capacity = income - 1.5x living expenses -
  // other already-committed debt repayments. d.totalMonthlyExpenses is
  // essential + lifestyle expenses and already EXCLUDES every debt
  // repayment (dashboard.ts's own "excludes debt repayments, tracked
  // separately" contract for that field) — i.e. it already is the worked
  // example's "living expenses excl. mortgage". Owner-occupied AND
  // consumer/other repayments are both netted out before assessing what's
  // left for investment debt: both are real, already-committed cash
  // outflows, so genuine capacity must account for both — this does NOT
  // mean consumer debt's OWN assessment (below) is influenced by
  // investment debt; the netting only runs this one direction. Uses the
  // same net-with-gross-fallback income basis as `income` above (this
  // file's established convention), since capacity is a cash-flow concept
  // — what's actually available to spend — not a gross-income reference
  // band like the owner-occupied rule above.
  const investmentPropertyDebtCapacity =
    income > 0
      ? income - 1.5 * d.totalMonthlyExpenses - d.ownerOccupiedDebtMonthlyRepayment - d.consumerOrOtherDebtMonthlyRepayment
      : null;
  const investmentPropertyDebtToCapacityRatio =
    investmentPropertyDebtCapacity !== null && investmentPropertyDebtCapacity > 0
      ? d.investmentPropertyDebtMonthlyRepayment / investmentPropertyDebtCapacity
      : null;

  const consumerOrOtherDebtServiceRatio =
    income > 0 ? d.consumerOrOtherDebtMonthlyRepayment / income : null;
  const propertyPurposeDebtRatio =
    d.totalLiabilities > 0
      ? (d.ownerOccupiedDebtBalance + d.investmentPropertyDebtBalance) / d.totalLiabilities
      : null;

  return {
    age: input.age,
    dependantsCount: input.dependantsCount,
    isSelfEmployed: input.isSelfEmployed,
    isRetired: input.isRetired,
    savingsRate: d.savingsRate,
    investmentContributionRate: d.investmentContributionRate,
    retirementContributionRate: d.retirementContributionRate,
    liquidAssetRatio: d.liquidAssetRatio,
    propertyConcentration: d.propertyConcentration,
    discretionaryRatio: d.discretionaryRatio,
    essentialExpenseRatio,
    debtToIncome: d.debtToIncome,
    debtServiceRatio: d.debtServiceRatio,
    emergencyFundMonths: d.emergencyFundMonths,
    investmentDiversificationScore: d.investmentDiversificationScore,
    passiveIncomeRatio:
      d.grossMonthlyIncome > 0 ? d.passiveMonthlyIncome / d.grossMonthlyIncome : null,
    incomeSourceCount: d.incomeSourceCount,
    netWorthGrowthPct,
    ownerOccupiedDebtBalance: d.ownerOccupiedDebtBalance,
    ownerOccupiedDebtMonthlyRepayment: d.ownerOccupiedDebtMonthlyRepayment,
    investmentPropertyDebtBalance: d.investmentPropertyDebtBalance,
    investmentPropertyDebtMonthlyRepayment: d.investmentPropertyDebtMonthlyRepayment,
    consumerOrOtherDebtBalance: d.consumerOrOtherDebtBalance,
    consumerOrOtherDebtMonthlyRepayment: d.consumerOrOtherDebtMonthlyRepayment,
    investmentPropertyRentalIncomeMonthly: d.rentalMonthlyIncome,
    ownerOccupiedDebtToGrossIncomeRatio,
    investmentPropertyDebtCapacity,
    investmentPropertyDebtToCapacityRatio,
    consumerOrOtherDebtServiceRatio,
    propertyPurposeDebtRatio,
  };
}

// ---------------------------------------------------------------------------
// Debt-purpose assessment (App Review Spec 1 §24-28) — the core of the
// Financial DNA debt-dependence redesign. Three debt purposes are kept
// analytically distinct throughout and NEVER blended into one number:
// owner-occupied home debt, investment/income-producing property debt, and
// consumer/other debt. A "worst of the three" rule (never an average)
// governs the overall debt_dependence trait below, so a good investment-
// debt outcome can never dilute a bad consumer-debt signal (Spec's DNA-05
// case), and a genuinely excessive investment-debt case is still flagged
// even though investment debt is not judged identically to consumer debt.
//
// Age/income threshold matrix (Spec 1 §27): NOT implemented here. Only the
// two rules the spec spells out with real numbers — the owner-occupied 30%
// reference band and the investment-property capacity formula — are built.
// See the completion report for this as an explicit Product-Owner-approval
// item, per the spec's own instruction not to invent one silently.
// ---------------------------------------------------------------------------
export type DebtDependenceLevel = 'low' | 'moderate' | 'high' | 'excessive';

export interface DebtPurposeBandAssessment {
  monthlyRepayment: number;
  balance: number;
  level: DebtDependenceLevel;
  explanation: string;
}

export interface DebtPurposeAssessment {
  ownerOccupied: DebtPurposeBandAssessment & { ratioOfGrossIncome: number | null; referenceBandPct: number };
  investmentProperty: DebtPurposeBandAssessment & {
    householdCapacity: number | null;
    livingCostBuffer: number | null;
    ratioOfCapacity: number | null;
  };
  consumerOrOther: DebtPurposeBandAssessment & { ratioOfIncome: number | null };
  // Known, disclosed limitations of this assessment — surfaced to the user/
  // report rather than silently assumed away.
  limitations: string[];
}

const OWNER_OCCUPIED_REFERENCE_BAND_PCT = 0.3; // Spec 1 §24: ~30% of gross household income
const LIVING_COST_BUFFER_MULTIPLE = 1.5; // Spec 1 §25 worked example

function ownerOccupiedLevel(ratio: number | null): DebtDependenceLevel {
  if (ratio === null) return 'low';
  if (ratio <= 0.3) return 'low';
  if (ratio <= 0.4) return 'moderate';
  if (ratio <= 0.5) return 'high';
  return 'excessive';
}

function investmentPropertyLevel(monthlyRepayment: number, capacity: number | null): DebtDependenceLevel {
  if (monthlyRepayment <= 0) return 'low';
  if (capacity === null) return 'moderate'; // can't assess capacity (e.g. no income data yet) — don't silently claim "low"
  if (capacity <= 0) return 'excessive';
  const ratio = monthlyRepayment / capacity;
  if (ratio <= 1) return 'low';
  if (ratio <= 1.2) return 'moderate';
  if (ratio <= 1.5) return 'high';
  return 'excessive';
}

function consumerLevel(ratio: number | null): DebtDependenceLevel {
  // Same 0.15/0.35 band already live on this file's debt_dependence trait
  // (levelFromRatio(m.debtServiceRatio, 0.15, 0.35) below) — reused here,
  // not a new threshold, now applied to the purpose-isolated figure.
  if (ratio === null) return 'low';
  if (ratio < 0.15) return 'low';
  if (ratio < 0.35) return 'moderate';
  return 'high';
}

export function assessDebtPurpose(m: DnaMetrics): DebtPurposeAssessment {
  const ownerLevel = ownerOccupiedLevel(m.ownerOccupiedDebtToGrossIncomeRatio);
  const investmentLevel = investmentPropertyLevel(
    m.investmentPropertyDebtMonthlyRepayment,
    m.investmentPropertyDebtCapacity
  );
  const consumerDebtLevel = consumerLevel(m.consumerOrOtherDebtServiceRatio);

  // Informational corroborating signal only (see the DnaMetrics field
  // comment above) — never changes a level or threshold, only the
  // explanation text.
  const investmentRentalSentence =
    m.investmentPropertyDebtMonthlyRepayment > 0
      ? m.investmentPropertyRentalIncomeMonthly > 0
        ? ' The household also records rental/Airbnb income, a supporting signal — not a verified link to this specific debt.'
        : ' No rental or Airbnb income is currently recorded against this household, even though investment-property debt is present.'
      : '';

  const investmentCapacityRatioForDisplay: number | null =
    m.investmentPropertyDebtCapacity !== null && m.investmentPropertyDebtCapacity <= 0
      ? m.investmentPropertyDebtToCapacityRatio ?? 2 // no positive capacity to divide by — display as clearly over 100%
      : m.investmentPropertyDebtToCapacityRatio;

  return {
    ownerOccupied: {
      monthlyRepayment: m.ownerOccupiedDebtMonthlyRepayment,
      balance: m.ownerOccupiedDebtBalance,
      level: ownerLevel,
      ratioOfGrossIncome: m.ownerOccupiedDebtToGrossIncomeRatio,
      referenceBandPct: OWNER_OCCUPIED_REFERENCE_BAND_PCT,
      explanation:
        m.ownerOccupiedDebtToGrossIncomeRatio === null
          ? 'Owner-occupied home debt cannot be assessed without income data.'
          : `Owner-occupied home debt repayments use ${fmtPct(m.ownerOccupiedDebtToGrossIncomeRatio)} of gross household income, against an indicative reference of around ${fmtPct(OWNER_OCCUPIED_REFERENCE_BAND_PCT)}.`,
    },
    investmentProperty: {
      monthlyRepayment: m.investmentPropertyDebtMonthlyRepayment,
      balance: m.investmentPropertyDebtBalance,
      level: investmentLevel,
      householdCapacity: m.investmentPropertyDebtCapacity,
      livingCostBuffer: m.investmentPropertyDebtCapacity === null ? null : LIVING_COST_BUFFER_MULTIPLE,
      ratioOfCapacity: m.investmentPropertyDebtToCapacityRatio,
      explanation:
        m.investmentPropertyDebtMonthlyRepayment <= 0
          ? 'No investment or income-producing property debt is currently recorded.'
          : m.investmentPropertyDebtCapacity === null
            ? 'Investment property debt capacity cannot be assessed without income data.'
            : `Investment property debt repayments are assessed against household capacity after living costs (a 1.5x living-expense buffer), not against a flat income percentage — repayments are currently ${fmtPct(investmentCapacityRatioForDisplay)} of that capacity.${investmentRentalSentence}`,
    },
    consumerOrOther: {
      monthlyRepayment: m.consumerOrOtherDebtMonthlyRepayment,
      balance: m.consumerOrOtherDebtBalance,
      level: consumerDebtLevel,
      ratioOfIncome: m.consumerOrOtherDebtServiceRatio,
      explanation:
        m.consumerOrOtherDebtServiceRatio === null
          ? 'Consumer/other debt cannot be assessed without income data.'
          : `Consumer and other debt (credit cards, personal loans and similar) uses ${fmtPct(m.consumerOrOtherDebtServiceRatio)} of income — assessed on its own, independent of any investment or owner-occupied debt held elsewhere in the household.`,
    },
    limitations: [
      'A single loan that is genuinely mixed-purpose (for example an offset-linked loan partly redrawn for an investment) cannot be split — each liability is classified under one purpose only, from its recorded debt type.',
      "Construction loans have no recorded purpose distinction in the data model and default to the owner-occupied band (the stricter of the two property bands) rather than the more lenient investment-capacity band.",
      'Rental/Airbnb income is matched to investment-property debt at the household level only — there is no per-property link between a specific income row and a specific liability.',
    ],
  };
}

// ---------------------------------------------------------------------------
// Profile definitions — declarative "ideal range" rules per metric, so each
// profile's classification logic is a readable table rather than bespoke
// code, while remaining fully deterministic, testable and version-tagged.
// ---------------------------------------------------------------------------
interface MetricRule {
  metric: keyof DnaMetrics;
  idealMin: number;
  idealMax: number;
  weight: number;
}
interface ProfileDefinition {
  code: ProfileCode;
  rules: MetricRule[];
  eligible?: (m: DnaMetrics) => boolean;
}

const PROFILE_DEFINITIONS: ProfileDefinition[] = [
  {
    code: 'cash_rich_accumulator',
    rules: [
      { metric: 'liquidAssetRatio', idealMin: 0.25, idealMax: 1, weight: 3 },
      { metric: 'emergencyFundMonths', idealMin: 9, idealMax: 24, weight: 3 },
      { metric: 'debtServiceRatio', idealMin: 0, idealMax: 0.1, weight: 2 },
      { metric: 'savingsRate', idealMin: 0.1, idealMax: 1, weight: 2 },
      { metric: 'investmentContributionRate', idealMin: 0, idealMax: 0.05, weight: 2 },
    ],
  },
  {
    code: 'wealth_builder',
    rules: [
      { metric: 'savingsRate', idealMin: 0.15, idealMax: 1, weight: 3 },
      { metric: 'investmentContributionRate', idealMin: 0.08, idealMax: 1, weight: 3 },
      { metric: 'netWorthGrowthPct', idealMin: 0.03, idealMax: 2, weight: 2 },
      { metric: 'debtServiceRatio', idealMin: 0, idealMax: 0.3, weight: 2 },
      { metric: 'investmentDiversificationScore', idealMin: 40, idealMax: 100, weight: 2 },
    ],
  },
  {
    code: 'lifestyle_optimiser',
    rules: [
      { metric: 'discretionaryRatio', idealMin: 0.3, idealMax: 1, weight: 3 },
      { metric: 'savingsRate', idealMin: -0.5, idealMax: 0.1, weight: 3 },
      { metric: 'emergencyFundMonths', idealMin: 0, idealMax: 3, weight: 2 },
    ],
  },
  {
    code: 'property_focused_investor',
    rules: [
      { metric: 'propertyConcentration', idealMin: 0.6, idealMax: 1, weight: 4 },
      // Replaces a blended debtToIncome 3-10x band (App Review Spec 1
      // §24-28 discovery: "infers a leveraged property pattern purely from
      // a blended debtToIncome band, with zero actual purpose signal").
      // propertyPurposeDebtRatio is the real signal: what share of total
      // debt is actually owner-occupied/investment-property debt, from
      // dashboard.ts's classifyDebtPurpose(). A household with high
      // blended DTI from e.g. margin/business debt alone no longer reads
      // as "leveraged property" without real property debt behind it.
      { metric: 'propertyPurposeDebtRatio', idealMin: 0.5, idealMax: 1, weight: 2 },
      { metric: 'liquidAssetRatio', idealMin: 0, idealMax: 0.2, weight: 2 },
    ],
  },
  {
    code: 'debt_constrained_builder',
    rules: [
      // Replaces blended debtServiceRatio (App Review Spec 1 §26 / DNA-05:
      // consumer debt must never benefit from investment-debt treatment —
      // the converse also holds here: a household whose investment-property
      // debt is large but genuinely serviceable within capacity must not be
      // pulled into "debt constrained" by that debt alone). Same approved
      // 0.35 threshold as before, now applied to the purpose-isolated
      // consumer/other figure so this profile reflects actual consumer debt
      // burden, not a blend that good investment debt can inflate.
      { metric: 'consumerOrOtherDebtServiceRatio', idealMin: 0.35, idealMax: 1, weight: 4 },
      { metric: 'propertyConcentration', idealMin: 0, idealMax: 0.4, weight: 2 },
      { metric: 'savingsRate', idealMin: -0.5, idealMax: 0.05, weight: 2 },
      { metric: 'emergencyFundMonths', idealMin: 0, idealMax: 2, weight: 2 },
    ],
  },
  {
    code: 'future_ready_professional',
    rules: [
      // Age alone shouldn't dominate — young age is necessary but not
      // sufficient, so it carries less weight than the behavioural signals.
      { metric: 'age', idealMin: 22, idealMax: 40, weight: 2 },
      { metric: 'savingsRate', idealMin: 0.12, idealMax: 1, weight: 3 },
      { metric: 'retirementContributionRate', idealMin: 0.03, idealMax: 1, weight: 2 },
      { metric: 'debtServiceRatio', idealMin: 0, idealMax: 0.35, weight: 2 },
    ],
  },
  {
    code: 'financial_stabiliser',
    rules: [
      { metric: 'savingsRate', idealMin: -1, idealMax: 0.05, weight: 3 },
      { metric: 'emergencyFundMonths', idealMin: 0, idealMax: 1, weight: 3 },
      { metric: 'essentialExpenseRatio', idealMin: 0.5, idealMax: 3, weight: 2 },
    ],
  },
  {
    code: 'retirement_focused_preserver',
    eligible: (m) => m.isRetired || (m.age !== null && m.age >= 60),
    rules: [
      { metric: 'passiveIncomeRatio', idealMin: 0.4, idealMax: 1, weight: 3 },
      { metric: 'debtToIncome', idealMin: 0, idealMax: 2, weight: 2 },
      { metric: 'liquidAssetRatio', idealMin: 0.15, idealMax: 1, weight: 2 },
    ],
  },
];

function scoreMetricMatch(value: number, min: number, max: number): number {
  if (value >= min && value <= max) return 100;
  const rangeWidth = Math.max(max - min, 0.0001);
  const distance = value < min ? min - value : value - max;
  return clamp(100 - (distance / rangeWidth) * 100);
}

export interface CandidateResult {
  code: ProfileCode;
  score: number;
  eligible: boolean;
  exclusionReason: string | null;
  dimensionScores: { metric: string; value: number | null; score: number | null; weight: number }[];
}

function evaluateCandidate(def: ProfileDefinition, metrics: DnaMetrics): CandidateResult {
  if (def.eligible && !def.eligible(metrics)) {
    return {
      code: def.code,
      score: 0,
      eligible: false,
      exclusionReason: 'Life-stage criteria not met for this profile.',
      dimensionScores: [],
    };
  }
  const dimensionScores = def.rules.map((r) => {
    const raw = metrics[r.metric];
    const value = typeof raw === 'number' ? raw : null;
    const score = value === null ? null : scoreMetricMatch(value, r.idealMin, r.idealMax);
    return { metric: r.metric, value, score, weight: r.weight };
  });
  const usable = dimensionScores.filter((d) => d.score !== null);
  if (usable.length === 0) {
    return {
      code: def.code,
      score: 0,
      eligible: false,
      exclusionReason: 'Not enough data available for this profile.',
      dimensionScores,
    };
  }
  const totalWeight = usable.reduce((sum, d) => sum + d.weight, 0);
  const weightedSum = usable.reduce((sum, d) => sum + d.score! * d.weight, 0);
  return {
    code: def.code,
    score: Math.round((weightedSum / totalWeight) * 100) / 100,
    eligible: true,
    exclusionReason: null,
    dimensionScores,
  };
}

export interface DnaDriver {
  type: 'classification' | 'strength' | 'risk';
  metricCode: string;
  metricValue: number | null;
  thresholdValue: number | null;
  contribution: number | null;
  explanation: string;
}

export interface DnaAction {
  code: string;
  title: string;
  explanation: string;
  priority: 'high' | 'medium' | 'low';
  relatedModule: string;
  relatedMetric: string;
  estimatedEffect: string;
}

export interface DnaResult {
  status: 'insufficient_data' | 'indicative' | 'confirmed' | 'high_confidence';
  primaryProfileCode: ProfileCode | null;
  primaryScore: number | null;
  secondaryProfileCode: ProfileCode | null;
  secondaryScore: number | null;
  confidence: number;
  confidenceBand: string;
  confidenceLabel: string;
  profileChanged: boolean;
  candidates: CandidateResult[];
  drivers: DnaDriver[];
  strengths: DnaDriver[];
  risks: DnaDriver[];
  actions: DnaAction[];
  traits: DnaTrait[];
  dataCompletenessPct: number;
  modelVersion: string;
  // Observed Financial Behaviour (App Review Spec 1 §28): this entire
  // result is derived from actual financial data the household has
  // recorded — never blended with Self-Reported Behaviour from the
  // separate, future behavioural questionnaire referenced elsewhere in the
  // DNA page/architecture. debtPurposeAssessment is the concrete output of
  // the debt-dependence redesign (§24-26): three analytically separate
  // debt-purpose bands, never averaged into one number.
  debtPurposeAssessment: DebtPurposeAssessment;
  behaviourSource: 'observed_financial_data';
}

export interface DnaTrait {
  code: string;
  label: string;
  level: 'low' | 'moderate' | 'high';
  direction: 'improving' | 'stable' | 'declining' | 'unknown';
  value: number | null;
  targetRangeLabel: string;
  explanation: string;
}

function levelFromRatio(value: number | null, lowMax: number, moderateMax: number): 'low' | 'moderate' | 'high' {
  if (value === null) return 'moderate';
  if (value < lowMax) return 'low';
  if (value < moderateMax) return 'moderate';
  return 'high';
}

const DEBT_LEVEL_SEVERITY: Record<DebtDependenceLevel, number> = { low: 0, moderate: 1, high: 2, excessive: 3 };

// "Worst of the three" — never an average — so a good investment-debt
// outcome can never dilute a bad consumer-debt signal, and a genuinely
// excessive investment-debt case is still surfaced (Spec 1 §26 / DNA-05).
function worstDebtLevel(...levels: DebtDependenceLevel[]): DebtDependenceLevel {
  return levels.reduce((worst, l) => (DEBT_LEVEL_SEVERITY[l] > DEBT_LEVEL_SEVERITY[worst] ? l : worst));
}

// DnaTrait.level is a pre-existing 3-tier type consumed by the DNA page UI
// (components/dna/sections.tsx's LEVEL_COLOR/LEVEL_LABEL/LEVEL_WIDTH), so
// 'excessive' collapses into 'high' for display — the full 4-tier detail
// remains available in DnaResult.debtPurposeAssessment for anything that
// needs it (e.g. a future report section).
function toTraitLevel(level: DebtDependenceLevel): 'low' | 'moderate' | 'high' {
  return level === 'excessive' ? 'high' : level;
}

function buildDebtDependenceExplanation(a: DebtPurposeAssessment): string {
  return `${a.ownerOccupied.explanation} ${a.investmentProperty.explanation} ${a.consumerOrOther.explanation}`;
}

function generateTraits(m: DnaMetrics): DnaTrait[] {
  const debtPurpose = assessDebtPurpose(m);
  return [
    {
      code: 'savings_discipline',
      label: 'Savings discipline',
      level: levelFromRatio(m.savingsRate, 0.05, 0.15),
      direction: 'unknown',
      value: m.savingsRate,
      targetRangeLabel: '15%+ of net income',
      explanation: `You are currently saving ${fmtPct(m.savingsRate)} of net income each month.`,
    },
    {
      code: 'spending_control',
      label: 'Spending control',
      level: m.discretionaryRatio === null ? 'moderate' : m.discretionaryRatio < 0.3 ? 'high' : m.discretionaryRatio < 0.5 ? 'moderate' : 'low',
      direction: 'unknown',
      value: m.discretionaryRatio,
      targetRangeLabel: 'under 30% of net income',
      explanation: `Discretionary spending is ${fmtPct(m.discretionaryRatio)} of your net income.`,
    },
    {
      code: 'debt_dependence',
      label: 'Debt dependence',
      // Redesigned per App Review Spec 1 §24-28: no longer a single
      // blended debtServiceRatio band. Owner-occupied, investment-property
      // and consumer/other debt are assessed separately (assessDebtPurpose
      // above) and the trait shows the worst of the three, never an
      // average — see buildDebtDependenceExplanation for the full,
      // purpose-separated narrative.
      level: toTraitLevel(
        worstDebtLevel(debtPurpose.ownerOccupied.level, debtPurpose.investmentProperty.level, debtPurpose.consumerOrOther.level)
      ),
      direction: 'unknown',
      value: m.debtServiceRatio,
      targetRangeLabel: 'owner-occupied ~30% of gross income; investment property within household capacity; consumer/other under 15% of income',
      explanation: buildDebtDependenceExplanation(debtPurpose),
    },
    {
      code: 'liquidity_strength',
      label: 'Liquidity strength',
      level: m.emergencyFundMonths === null ? 'moderate' : m.emergencyFundMonths < 3 ? 'low' : m.emergencyFundMonths < 6 ? 'moderate' : 'high',
      direction: 'unknown',
      value: m.emergencyFundMonths,
      targetRangeLabel: '4-6 months of essential expenses',
      explanation:
        m.emergencyFundMonths === null
          ? 'Liquid coverage cannot be calculated yet.'
          : `Liquid assets currently cover ${m.emergencyFundMonths.toFixed(1)} months of essential expenses.`,
    },
    {
      code: 'investment_orientation',
      label: 'Investment orientation',
      level: levelFromRatio(m.investmentContributionRate, 0.03, 0.08),
      direction: 'unknown',
      value: m.investmentContributionRate,
      targetRangeLabel: '8%+ of net income',
      explanation: `You contribute ${fmtPct(m.investmentContributionRate)} of net income to investments.`,
    },
    {
      code: 'property_concentration',
      label: 'Property concentration',
      level: levelFromRatio(m.propertyConcentration, 0.3, 0.6),
      direction: 'unknown',
      value: m.propertyConcentration,
      targetRangeLabel: 'depends on your goals',
      explanation: `Property represents ${fmtPct(m.propertyConcentration)} of your total assets.`,
    },
    {
      code: 'retirement_preparation',
      label: 'Retirement preparation',
      level: levelFromRatio(m.retirementContributionRate, 0.03, 0.09),
      direction: 'unknown',
      value: m.retirementContributionRate,
      targetRangeLabel: '9%+ of net income',
      explanation: `Employer and personal retirement contributions total ${fmtPct(m.retirementContributionRate)} of net income.`,
    },
    {
      code: 'financial_momentum',
      label: 'Financial momentum',
      level: m.netWorthGrowthPct === null ? 'moderate' : m.netWorthGrowthPct > 0.01 ? 'high' : m.netWorthGrowthPct < -0.01 ? 'low' : 'moderate',
      direction: m.netWorthGrowthPct === null ? 'unknown' : m.netWorthGrowthPct > 0.01 ? 'improving' : m.netWorthGrowthPct < -0.01 ? 'declining' : 'stable',
      value: m.netWorthGrowthPct,
      targetRangeLabel: 'positive over time',
      explanation:
        m.netWorthGrowthPct === null
          ? 'Not enough history yet to show a trend.'
          : `Net worth has changed by ${fmtPct(m.netWorthGrowthPct)} over the period on record.`,
    },
  ];
}

function bandFor(score: number, bands: DnaConfig['confidenceBands']): { band: string; label: string } {
  const sorted = [...bands].sort((a, b) => b.min - a.min);
  for (const b of sorted) if (score >= b.min) return { band: b.band, label: b.label };
  const last = sorted[sorted.length - 1];
  return { band: last.band, label: last.label };
}

function fmtPct(v: number | null): string {
  return v === null ? 'not available' : `${(v * 100).toFixed(0)}%`;
}

export function classifyFinancialDna(input: DnaProfileInput): DnaResult {
  const d = input.dashboard;
  const metrics = computeDnaMetrics(input);

  const hasMinimumData = d.hasIncome && d.hasExpenses && (d.hasAssets || d.hasLiabilities);
  if (!hasMinimumData) {
    return {
      status: 'insufficient_data',
      primaryProfileCode: null,
      primaryScore: null,
      secondaryProfileCode: null,
      secondaryScore: null,
      confidence: 0,
      confidenceBand: 'insufficient',
      confidenceLabel: 'Insufficient for confirmed classification',
      profileChanged: false,
      candidates: [],
      drivers: [],
      strengths: [],
      risks: [],
      actions: [],
      traits: [],
      dataCompletenessPct: 0,
      modelVersion: MODEL_VERSION,
      debtPurposeAssessment: assessDebtPurpose(metrics),
      behaviourSource: 'observed_financial_data',
    };
  }

  const candidates = PROFILE_DEFINITIONS.map((def) => evaluateCandidate(def, metrics)).sort(
    (a, b) => b.score - a.score
  );
  const eligible = candidates.filter((c) => c.eligible);

  const dataCategories = [d.hasIncome, d.hasExpenses, d.hasAssets, d.hasLiabilities, d.hasInvestments, d.hasRetirement, d.hasInsurance];
  const dataCompletenessPct = clamp((dataCategories.filter(Boolean).length / dataCategories.length) * 100);

  let topPick = eligible[0] ?? null;
  let profileChanged = false;

  if (topPick && input.previousProfileCode) {
    const previousCandidate = eligible.find((c) => c.code === input.previousProfileCode);
    if (previousCandidate && previousCandidate.code !== topPick.code) {
      const gap = topPick.score - previousCandidate.score;
      if (gap < input.config.profileChangeThreshold) {
        topPick = previousCandidate; // not enough separation to justify switching
      }
    }
    profileChanged = topPick?.code !== input.previousProfileCode;
  } else if (topPick) {
    profileChanged = true;
  }

  const runnerUp = eligible.find((c) => c.code !== topPick?.code) ?? null;
  const showSecondary =
    runnerUp !== null &&
    topPick !== null &&
    runnerUp.score >= input.config.secondaryThreshold.minScore &&
    topPick.score - runnerUp.score <= input.config.secondaryThreshold.maxGapFromPrimary;

  const restAverage =
    eligible.length > 1
      ? eligible.filter((c) => c.code !== topPick?.code).reduce((s, c) => s + c.score, 0) / (eligible.length - 1)
      : 0;
  const signalConsistency = topPick ? clamp((topPick.score - restAverage) * 2.5) : 0;
  const separation = topPick && runnerUp ? clamp((topPick.score - runnerUp.score) * 5) : 100;
  const recency = 100; // computed live from current data on every load

  const cw = input.config.confidenceWeights;
  const confidence = clamp(
    dataCompletenessPct * cw.dataCompleteness +
      signalConsistency * cw.signalConsistency +
      separation * cw.separation +
      recency * cw.recency
  );
  const { band, label } = bandFor(confidence, input.config.confidenceBands);

  const status: DnaResult['status'] =
    confidence < 40 ? 'indicative' : confidence < 70 ? 'indicative' : confidence < 85 ? 'confirmed' : 'high_confidence';

  const { drivers, strengths, risks, actions } = topPick
    ? generateExplanations(topPick.code, metrics)
    : { drivers: [], strengths: [], risks: [], actions: [] };

  return {
    status,
    primaryProfileCode: topPick?.code ?? null,
    primaryScore: topPick?.score ?? null,
    secondaryProfileCode: showSecondary ? (runnerUp!.code as ProfileCode) : null,
    secondaryScore: showSecondary ? runnerUp!.score : null,
    confidence,
    confidenceBand: band,
    confidenceLabel: label,
    profileChanged,
    candidates,
    drivers,
    strengths,
    risks,
    actions,
    traits: generateTraits(metrics),
    dataCompletenessPct,
    modelVersion: MODEL_VERSION,
    debtPurposeAssessment: assessDebtPurpose(metrics),
    behaviourSource: 'observed_financial_data',
  };
}

// ---------------------------------------------------------------------------
// Explanation generation — deterministic, per-profile templated statements
// using the user's actual metric values. Wording follows the "current
// pattern" framing throughout; never judgmental, never permanent-sounding.
// ---------------------------------------------------------------------------
function generateExplanations(
  profile: ProfileCode,
  m: DnaMetrics
): { drivers: DnaDriver[]; strengths: DnaDriver[]; risks: DnaDriver[]; actions: DnaAction[] } {
  const drivers: DnaDriver[] = [];
  const strengths: DnaDriver[] = [];
  const risks: DnaDriver[] = [];
  const actions: DnaAction[] = [];

  const push = (arr: DnaDriver[], type: DnaDriver['type'], metricCode: string, value: number | null, threshold: number | null, explanation: string) =>
    arr.push({ type, metricCode, metricValue: value, thresholdValue: threshold, contribution: null, explanation });

  switch (profile) {
    case 'cash_rich_accumulator':
      push(drivers, 'classification', 'liquid_asset_ratio', m.liquidAssetRatio, 0.25, `Cash and deposits make up ${fmtPct(m.liquidAssetRatio)} of your total financial assets.`);
      push(drivers, 'classification', 'emergency_fund_months', m.emergencyFundMonths, 9, `Your liquid reserves cover ${m.emergencyFundMonths?.toFixed(1) ?? 'an unknown number of'} months of essential expenses.`);
      push(strengths, 'strength', 'liquidity', m.liquidAssetRatio, null, 'Strong liquidity gives you real flexibility to handle unexpected costs.');
      push(strengths, 'strength', 'debt_service_ratio', m.debtServiceRatio, null, 'Low reliance on borrowing reduces your exposure to interest-rate changes.');
      push(risks, 'risk', 'investment_contribution_rate', m.investmentContributionRate, null, 'Holding a large cash buffer beyond your known goals may mean inflation erodes its real value over time.');
      push(risks, 'risk', 'investment_diversification_score', m.investmentDiversificationScore, null, 'Limited growth-asset exposure may slow long-term wealth accumulation.');
      actions.push({ code: 'separate_goals', title: 'Link surplus cash to specific goals', explanation: 'Consider separating your emergency reserve from any surplus cash and directing the surplus toward a specific goal or a diversified investment.', priority: 'medium', relatedModule: 'goals', relatedMetric: 'liquid_asset_ratio', estimatedEffect: 'Better alignment between cash holdings and your actual goals.' });
      actions.push({ code: 'review_allocation', title: 'Review your long-term asset allocation', explanation: 'Consider reviewing whether your current asset mix provides enough long-term growth alongside your strong liquidity.', priority: 'medium', relatedModule: 'investments', relatedMetric: 'investment_diversification_score', estimatedEffect: 'A better balance between safety and long-term growth.' });
      break;

    case 'wealth_builder':
      push(drivers, 'classification', 'savings_rate', m.savingsRate, 0.15, `Your savings rate is ${fmtPct(m.savingsRate)} of net income.`);
      push(drivers, 'classification', 'investment_contribution_rate', m.investmentContributionRate, 0.08, `You contribute ${fmtPct(m.investmentContributionRate)} of income to investments each month.`);
      if (m.netWorthGrowthPct !== null) push(drivers, 'classification', 'net_worth_growth', m.netWorthGrowthPct, 0.03, `Your net worth has changed by ${fmtPct(m.netWorthGrowthPct)} over the period on record.`);
      push(strengths, 'strength', 'savings_rate', m.savingsRate, null, 'Disciplined saving supports steady long-term wealth accumulation.');
      push(strengths, 'strength', 'investment_diversification_score', m.investmentDiversificationScore, null, 'Regular investment contributions build strong compounding potential over time.');
      push(risks, 'risk', 'emergency_fund_months', m.emergencyFundMonths, null, 'Aggressive investing without adequate liquidity can create cash-flow strain if plans change.');
      push(risks, 'risk', 'debt_service_ratio', m.debtServiceRatio, null, 'Rising wealth without periodic insurance review can leave gaps in protection.');
      actions.push({ code: 'maintain_diversification', title: 'Maintain diversification as wealth grows', explanation: 'Consider reviewing whether your investment mix remains diversified as your portfolio grows.', priority: 'medium', relatedModule: 'investments', relatedMetric: 'investment_diversification_score', estimatedEffect: 'Reduced concentration risk.' });
      actions.push({ code: 'review_protection', title: 'Review your protection needs', explanation: 'Consider checking whether your insurance cover has kept pace with your growing asset base.', priority: 'medium', relatedModule: 'insurance', relatedMetric: 'total_annual_premium', estimatedEffect: 'Cover that matches your current financial position.' });
      break;

    case 'lifestyle_optimiser':
      push(drivers, 'classification', 'discretionary_ratio', m.discretionaryRatio, 0.3, `Discretionary spending represents ${fmtPct(m.discretionaryRatio)} of your net income.`);
      push(drivers, 'classification', 'savings_rate', m.savingsRate, 0.1, `Your current savings rate is ${fmtPct(m.savingsRate)}.`);
      push(strengths, 'strength', 'discretionary_ratio', m.discretionaryRatio, null, 'Strong earning capacity supports a flexible, comfortable lifestyle today.');
      push(risks, 'risk', 'savings_rate', m.savingsRate, null, 'A low savings rate may slow long-term wealth accumulation relative to your income.');
      push(risks, 'risk', 'emergency_fund_months', m.emergencyFundMonths, null, 'Limited emergency reserves increase reliance on continued high income.');
      actions.push({ code: 'automatic_savings', title: 'Establish a minimum automatic savings rate', explanation: 'Consider setting an automatic transfer to savings or investments before discretionary spending each pay cycle.', priority: 'high', relatedModule: 'income', relatedMetric: 'savings_rate', estimatedEffect: 'A steadily growing savings base independent of spending decisions.' });
      actions.push({ code: 'build_buffer', title: 'Build emergency reserves', explanation: 'Consider building liquid reserves toward a target number of months of essential expenses.', priority: 'medium', relatedModule: 'assets', relatedMetric: 'emergency_fund_months', estimatedEffect: 'More resilience if income is interrupted.' });
      break;

    case 'property_focused_investor':
      push(drivers, 'classification', 'property_concentration', m.propertyConcentration, 0.6, `Property represents ${fmtPct(m.propertyConcentration)} of your total assets.`);
      // Real purpose signal (owner-occupied + investment-property balance,
      // from master_item_key) rather than a blended debtToIncome guess —
      // see propertyPurposeDebtRatio's definition and the PROFILE_DEFINITIONS
      // comment above for why this replaced the old debt_to_income driver.
      push(drivers, 'classification', 'property_purpose_debt_ratio', m.propertyPurposeDebtRatio, 0.5, `${fmtPct(m.propertyPurposeDebtRatio)} of your total debt is owner-occupied or investment-property debt, consistent with a leveraged property pattern.`);
      push(drivers, 'classification', 'liquid_asset_ratio', m.liquidAssetRatio, 0.2, `Liquid assets represent only ${fmtPct(m.liquidAssetRatio)} of your total assets.`);
      push(strengths, 'strength', 'property_concentration', m.propertyConcentration, null, 'A tangible, substantial asset base with long-term growth potential.');
      push(risks, 'risk', 'property_concentration', m.propertyConcentration, null, 'High property concentration increases exposure to property-cycle and interest-rate movements.');
      push(risks, 'risk', 'liquid_asset_ratio', m.liquidAssetRatio, null, 'Limited liquidity may make it harder to respond to unexpected costs without borrowing.');
      actions.push({ code: 'build_liquidity', title: 'Build liquid reserves', explanation: 'Consider building liquid reserves alongside your property holdings to improve flexibility.', priority: 'high', relatedModule: 'assets', relatedMetric: 'liquid_asset_ratio', estimatedEffect: 'Reduced reliance on refinancing or borrowing for short-term needs.' });
      actions.push({ code: 'diversify_outside_property', title: 'Gradually diversify outside property', explanation: 'Consider whether directing some future surplus outside property would improve diversification over time.', priority: 'medium', relatedModule: 'investments', relatedMetric: 'property_concentration', estimatedEffect: 'A more balanced asset mix over time.' });
      break;

    case 'debt_constrained_builder':
      // Consumer/other debt specifically, not a blend that good investment
      // or owner-occupied debt could inflate or offset (App Review Spec 1
      // §26 / DNA-05) — see consumerOrOtherDebtServiceRatio's definition.
      push(drivers, 'classification', 'consumer_or_other_debt_service_ratio', m.consumerOrOtherDebtServiceRatio, 0.35, `Consumer and other debt repayments currently represent ${fmtPct(m.consumerOrOtherDebtServiceRatio)} of your income.`);
      push(drivers, 'classification', 'emergency_fund_months', m.emergencyFundMonths, 2, `Liquid reserves cover ${m.emergencyFundMonths?.toFixed(1) ?? 'a limited number of'} months of essential expenses.`);
      push(strengths, 'strength', 'income_source_count', m.incomeSourceCount, null, 'Existing income capacity provides a base to accelerate improvement once debt reduces.');
      push(risks, 'risk', 'consumer_or_other_debt_service_ratio', m.consumerOrOtherDebtServiceRatio, null, 'A high consumer-debt burden leaves little monthly flexibility for saving or unexpected costs.');
      push(risks, 'risk', 'emergency_fund_months', m.emergencyFundMonths, null, 'Limited emergency capacity increases reliance on further borrowing if a shock occurs.');
      actions.push({ code: 'prioritise_high_cost_debt', title: 'Prioritise your highest-cost debt', explanation: 'Consider directing available surplus toward your highest-interest debt first.', priority: 'high', relatedModule: 'liabilities', relatedMetric: 'debt_service_ratio', estimatedEffect: 'Faster reduction in the debt costing you the most.' });
      actions.push({ code: 'avoid_new_debt', title: 'Avoid adding new consumer debt', explanation: 'Consider avoiding new short-term or consumer borrowing while repayments remain high relative to income.', priority: 'high', relatedModule: 'liabilities', relatedMetric: 'debt_to_income', estimatedEffect: 'Prevents the repayment burden from increasing further.' });
      break;

    case 'future_ready_professional':
      push(drivers, 'classification', 'age', m.age, 40, `Your career stage and income capacity suggest significant future wealth-building potential.`);
      push(drivers, 'classification', 'savings_rate', m.savingsRate, 0.12, `Your current savings rate is ${fmtPct(m.savingsRate)}.`);
      push(strengths, 'strength', 'age', m.age, null, 'Time available for compounding is one of your biggest financial advantages right now.');
      push(strengths, 'strength', 'debt_service_ratio', m.debtServiceRatio, null, 'Manageable debt levels leave room to direct more income toward long-term goals.');
      push(risks, 'risk', 'retirement_contribution_rate', m.retirementContributionRate, null, 'Delaying investment action reduces the benefit of long-term compounding.');
      actions.push({ code: 'automate_contributions', title: 'Automate wealth-building contributions', explanation: 'Consider automating regular contributions to investments or retirement accounts to capture time in the market.', priority: 'high', relatedModule: 'investments', relatedMetric: 'investment_contribution_rate', estimatedEffect: 'More consistent long-term wealth accumulation.' });
      actions.push({ code: 'protect_income', title: 'Establish protection for your income', explanation: 'Consider reviewing income protection cover, since your future earning capacity is a major financial asset.', priority: 'medium', relatedModule: 'insurance', relatedMetric: 'has_income_protection', estimatedEffect: 'Reduced risk to your long-term plans from an income interruption.' });
      break;

    case 'financial_stabiliser':
      push(drivers, 'classification', 'savings_rate', m.savingsRate, 0.05, `Your current savings rate is ${fmtPct(m.savingsRate)}.`);
      push(drivers, 'classification', 'emergency_fund_months', m.emergencyFundMonths, 1, `Liquid reserves currently cover ${m.emergencyFundMonths?.toFixed(1) ?? 'a limited number of'} months of essential expenses.`);
      push(strengths, 'strength', 'essential_expense_ratio', m.essentialExpenseRatio, null, 'Clear opportunities exist to strengthen your financial foundation quickly.');
      push(risks, 'risk', 'emergency_fund_months', m.emergencyFundMonths, null, 'Very limited reserves mean an unexpected cost could be difficult to absorb without borrowing.');
      push(risks, 'risk', 'essential_expense_ratio', m.essentialExpenseRatio, null, 'Essential expenses currently absorb a large share of income, limiting flexibility.');
      actions.push({ code: 'stabilise_cash_flow', title: 'Stabilise your monthly cash flow', explanation: 'Consider reviewing essential expenses for opportunities to free up monthly cash flow.', priority: 'high', relatedModule: 'expenses', relatedMetric: 'essential_expense_ratio', estimatedEffect: 'A more predictable and manageable monthly position.' });
      actions.push({ code: 'starter_emergency_fund', title: 'Build a starter emergency fund', explanation: 'Consider building a small emergency fund, even a modest amount, as a first step toward stability.', priority: 'high', relatedModule: 'assets', relatedMetric: 'emergency_fund_months', estimatedEffect: 'A basic buffer against unexpected costs.' });
      break;

    case 'retirement_focused_preserver':
      push(drivers, 'classification', 'passive_income_ratio', m.passiveIncomeRatio, 0.4, `Passive and retirement income represents ${fmtPct(m.passiveIncomeRatio)} of your total income.`);
      push(drivers, 'classification', 'debt_to_income', m.debtToIncome, 2, `Your debt level relative to income is low, consistent with a preservation-focused stage.`);
      push(strengths, 'strength', 'debt_to_income', m.debtToIncome, null, 'Low debt exposure reduces financial pressure in retirement.');
      push(strengths, 'strength', 'passive_income_ratio', m.passiveIncomeRatio, null, 'An established, income-producing asset base supports your current stage.');
      push(risks, 'risk', 'liquid_asset_ratio', m.liquidAssetRatio, null, 'Inflation and healthcare costs remain key risks to monitor over a long retirement.');
      actions.push({ code: 'review_withdrawal_sustainability', title: 'Review income sustainability', explanation: 'Consider reviewing whether your current withdrawal pattern is likely to be sustainable over your expected retirement.', priority: 'medium', relatedModule: 'retirement', relatedMetric: 'passive_income_ratio', estimatedEffect: 'Greater confidence in long-term income sustainability.' });
      actions.push({ code: 'review_inflation_exposure', title: 'Review inflation and healthcare exposure', explanation: 'Consider reviewing whether your asset mix provides some protection against inflation and rising healthcare costs.', priority: 'medium', relatedModule: 'assets', relatedMetric: 'liquid_asset_ratio', estimatedEffect: 'Better resilience against long-term cost increases.' });
      break;
  }

  return { drivers, strengths, risks, actions };
}
