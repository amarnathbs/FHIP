// Phase 4 — Retirement Forecasting (spec section 9). A single consolidated
// retirement position (entity_type='retirement', no entity_id — mirrors how
// netWorthCalculator.ts treats the whole portfolio as one entity), covering
// both the accumulation phase (9.5: "Closing = Opening + Contributions +
// Return - Fees - Withdrawals") and the decumulation phase after retirement
// age ("Closing = Opening + Return - Withdrawals - Fees"). Retirement assets
// are tracked separately from general investments per 9.1 to avoid double
// counting — this calculator only ever reads retirement_accounts, never
// investments.
import { requiredMonthlyContribution } from '../goalMath';
import { buildExplanation } from './explain';
import { addMonthsToDateString, firstOfMonth, monthlyCompoundRate, projectInvestmentMonth, round2 } from './monthlyPrimitives';
import { getAssumptionValue } from './assumptions';
import { formatMoneyWhole } from '../money';
import type { ForecastExplanationRow, ForecastResultRow, ResolvedAssumptionSet } from './types';

export type RetirementTargetMethod = 'target_corpus' | 'desired_income' | 'expense_replacement';

export interface RetirementCalculatorInput {
  baselineDate: string;
  months: number;
  assumptions: ResolvedAssumptionSet;
  currency: string;
  currentBalance: number;
  monthlyContribution: number;
  currentAge: number | null; // null when date_of_birth isn't recorded or isn't plausible
  retirementAge: number;
  // Forecasting P1 fix FHIP-FC-RET-001 — set by the caller when a higher- or
  // equal-priority timing signal is available: an explicit retirement_date
  // (tier 1, takes priority over the age-based calculation below) or a
  // manual "months until retirement" fallback for when no DOB is on file at
  // all (tier 3/4 collapsed into one field — see migration 0028). Left
  // undefined/null to fall back to the existing currentAge/retirementAge
  // calculation (tier 2).
  monthsUntilRetirementOverride?: number | null;
  targetMethod: RetirementTargetMethod;
  targetCorpus?: number; // target_corpus method
  desiredAnnualIncome?: number; // desired_income method
  currentAnnualEssentialExpenses?: number; // expense_replacement method
  replacementPercentage?: number; // expense_replacement method, e.g. 70 for 70%
  // Retirement Member UI (spec s.29-30) — when the household has both a
  // Self and a Spouse retirement member with genuinely distinct data
  // (their own accounts and/or their own target ages), the caller supplies
  // each member's own currentBalance/monthlyContribution/currentAge/
  // retirementAge here. When present (2 entries), runRetirementForecast
  // ALSO independently projects EACH member's own retirement account
  // balances forward to THEIR OWN target retirement age — "Self accounts
  // use Self's age, Spouse accounts use Spouse's age", never one household
  // age for both — and records that per-member breakdown (age, own
  // balance-at-target, own required corpus, own funding gap, own status)
  // in calculation_inputs.members on the returned explanation. The
  // row-level trajectory (`results`) and every flat summary field
  // (balanceAtRetirement/requiredCorpus/fundingGap/readinessPct/status/…)
  // stay computed exactly as they always were, off the top-level
  // currentBalance/monthlyContribution/currentAge/retirementAge — this
  // deliberately keeps forecast_results' shape and every existing headline
  // number byte-for-byte unchanged (RunSummary, ReportTrendChart, the
  // Premium Report's retirement_readiness section are not entity-id- or
  // multi-row-aware for retirement, unlike goal/debt/investment). When
  // members is omitted (the default), behaviour is identical to before
  // this feature existed (spec s.30: "do not rewrite the retirement engine
  // unnecessarily").
  members?: RetirementMemberLegInput[];
}

export interface RetirementMemberLegInput {
  memberId: string; // retirement_members.id — carried through only for the caller's own bookkeeping; never persisted as a row's entity_id (see members? above)
  label: string; // 'Self' | 'Spouse/Partner' — narrative text only, never used for calculation logic (spec s.5)
  currentBalance: number;
  monthlyContribution: number;
  currentAge: number | null;
  retirementAge: number;
}

export type RetirementStatus = 'fully_funded' | 'on_track' | 'minor_gap' | 'material_gap' | 'high_risk' | 'insufficient_information';

const DEFAULT_RETIREMENT_RETURN = 6.5;

function statusFromReadiness(readinessPct: number | null): RetirementStatus {
  if (readinessPct === null) return 'insufficient_information';
  if (readinessPct >= 100) return 'fully_funded';
  if (readinessPct >= 90) return 'on_track';
  if (readinessPct >= 75) return 'minor_gap';
  if (readinessPct >= 50) return 'material_gap';
  return 'high_risk';
}

// Required Retirement Corpus, per method (spec 9.4). Returns null when the
// method's required inputs weren't supplied — callers must treat that as
// "Insufficient Information", not as a zero target.
function resolveRequiredCorpus(input: RetirementCalculatorInput, withdrawalRatePercent: number, yearsToRetirement: number | null): number | null {
  if (input.targetMethod === 'target_corpus') {
    return input.targetCorpus ?? null;
  }
  if (input.targetMethod === 'desired_income') {
    if (input.desiredAnnualIncome === undefined || withdrawalRatePercent <= 0) return null;
    return round2(input.desiredAnnualIncome / (withdrawalRatePercent / 100));
  }
  // expense_replacement
  if (input.currentAnnualEssentialExpenses === undefined || input.replacementPercentage === undefined || withdrawalRatePercent <= 0) return null;
  const requiredIncomeToday = input.currentAnnualEssentialExpenses * (input.replacementPercentage / 100);
  const inflationPercent = getAssumptionValue(input.assumptions, 'general_inflation', 3);
  const years = yearsToRetirement ?? 0;
  const inflatedIncome = requiredIncomeToday * Math.pow(1 + inflationPercent / 100, years);
  return round2(inflatedIncome / (withdrawalRatePercent / 100));
}

// Public entry point. Legacy/default behaviour (no members[] supplied, or
// fewer than 2) is completely unchanged — delegates straight through to the
// single-entity calculation exactly as it always worked. Only when 2+
// member legs are supplied does this run the per-member split described on
// RetirementCalculatorInput.members above.
export function runRetirementForecast(input: RetirementCalculatorInput): { results: ForecastResultRow[]; explanations: ForecastExplanationRow[] } {
  if (!input.members || input.members.length < 2) {
    return runRetirementForecastForEntity(input, null, null);
  }
  return runRetirementForecastSplitByMember(input, input.members);
}

// IMPORTANT — deliberately conservative design (spec s.30 "do not rewrite
// the retirement engine unnecessarily", s.61 "keep this release narrowly
// scoped"): the row-level trajectory (`results`, exactly one row per
// period, entity_id=null) and every flat summary field on the explanation
// (balanceAtRetirement/requiredCorpus/fundingGap/readinessPct/status/
// contributionGap/monthsUntilRetirement) are computed EXACTLY as they were
// before this feature existed, off the same top-level currentBalance/
// monthlyContribution/currentAge/retirementAge the caller already resolves
// today. This guarantees zero numeric regression for every existing
// consumer (RunSummary's Stat cards, ReportTrendChart, the Premium
// Report's retirement_readiness section — none of which are entity-id- or
// multi-row-aware for forecast_type='retirement', unlike goal/debt/
// investment). What this function ADDS is a genuine, correctly-computed
// per-member breakdown — each member's OWN accounts projected to THEIR OWN
// target age (spec s.29: "Self accounts use Self's age, Spouse accounts
// use Spouse's age") — attached as calculation_inputs.members on that same
// single explanation, so the real per-member funding position is
// available and traceable without touching forecast_results' shape or any
// existing headline number. A future, separately-scoped release can adopt
// per-member trajectories as the primary chart once every downstream
// consumer is confirmed entity-aware.
function runRetirementForecastSplitByMember(
  input: RetirementCalculatorInput,
  members: RetirementMemberLegInput[]
): { results: ForecastResultRow[]; explanations: ForecastExplanationRow[] } {
  const household = runRetirementForecastForEntity({ ...input, members: undefined }, null, null);

  const perMember = members.map((member) => {
    const legInput: RetirementCalculatorInput = {
      ...input,
      currentBalance: member.currentBalance,
      monthlyContribution: member.monthlyContribution,
      currentAge: member.currentAge,
      retirementAge: member.retirementAge,
      members: undefined,
    };
    // entityId/memberLabel passed only to shape this leg's OWN narrative
    // text and calculation_inputs — this leg's rows/explanation are never
    // returned to the caller, only summarised into the household
    // explanation's calculation_inputs.members below.
    const leg = runRetirementForecastForEntity(legInput, null, member.label);
    return {
      label: member.label,
      retirementAge: member.retirementAge,
      currentBalance: member.currentBalance,
      monthlyContribution: member.monthlyContribution,
      ...leg.explanations[0]?.calculationInputs,
    };
  });

  const combinedNarrative = perMember.map((m) => `${m.label}'s target retirement age is ${m.retirementAge}.`).join(' ');
  const baseExplanation = household.explanations[0];
  const householdExplanation: ForecastExplanationRow = {
    ...baseExplanation,
    explanationText: `${baseExplanation.explanationText} This household has more than one retirement member with an independently confirmed target retirement age. ${combinedNarrative} Each member's own accounts and funding position are broken out below.`,
    calculationInputs: { ...baseExplanation.calculationInputs, members: perMember },
  };

  return { results: household.results, explanations: [householdExplanation] };
}

// entityId/memberLabel are null for the legacy single-household-age path
// (identical output to the pre-split calculator); non-null when called as
// one leg of a Self/Spouse split.
function runRetirementForecastForEntity(
  input: RetirementCalculatorInput,
  entityId: string | null,
  memberLabel: string | null
): { results: ForecastResultRow[]; explanations: ForecastExplanationRow[] } {
  const results: ForecastResultRow[] = [];
  const explanations: ForecastExplanationRow[] = [];
  const baseline = firstOfMonth(input.baselineDate);
  const returnRate = getAssumptionValue(input.assumptions, 'retirement', DEFAULT_RETIREMENT_RETURN);
  const withdrawalRate = getAssumptionValue(input.assumptions, 'withdrawal_rate', 4);

  const monthsUntilRetirement =
    input.monthsUntilRetirementOverride ?? (input.currentAge !== null ? Math.max(0, Math.round((input.retirementAge - input.currentAge) * 12)) : null);
  const yearsToRetirement = monthsUntilRetirement !== null ? monthsUntilRetirement / 12 : null;
  const requiredCorpus = resolveRequiredCorpus(input, withdrawalRate, yearsToRetirement);
  const desiredAnnualIncomeAtRetirement =
    input.targetMethod === 'desired_income'
      ? input.desiredAnnualIncome ?? null
      : requiredCorpus !== null
        ? round2(requiredCorpus * (withdrawalRate / 100))
        : null;
  const monthlyWithdrawalPostRetirement = desiredAnnualIncomeAtRetirement !== null ? desiredAnnualIncomeAtRetirement / 12 : 0;

  let balance = input.currentBalance;
  let balanceAtRetirement: number | null = monthsUntilRetirement === 0 ? balance : null;
  let depletionMonth: number | null = null;

  for (let m = 1; m <= input.months; m++) {
    const periodDate = addMonthsToDateString(baseline, m);
    const isPreRetirement = monthsUntilRetirement === null || m <= monthsUntilRetirement;
    const month = projectInvestmentMonth({
      openingValue: balance,
      contributions: isPreRetirement ? input.monthlyContribution : 0,
      withdrawals: isPreRetirement ? 0 : monthlyWithdrawalPostRetirement,
      annualReturnPercent: returnRate,
    });
    balance = month.closingValue;

    if (monthsUntilRetirement !== null && m === monthsUntilRetirement) balanceAtRetirement = balance;
    if (!isPreRetirement && depletionMonth === null && balance <= 0) depletionMonth = m;

    results.push({
      forecastType: 'retirement',
      entityType: 'retirement',
      entityId,
      periodDate,
      periodNumber: m,
      openingValue: month.openingValue,
      contributions: month.contributions,
      withdrawals: month.withdrawals,
      income: 0,
      expenses: 0,
      interest: 0,
      investmentReturn: month.investmentReturn,
      fees: month.fees,
      fxGainLoss: 0,
      otherMovement: 0,
      closingValue: balance,
      targetValue: requiredCorpus,
      varianceValue: requiredCorpus !== null ? round2(balance - requiredCorpus) : null,
      variancePercentage: requiredCorpus !== null && requiredCorpus > 0 ? round2(((balance - requiredCorpus) / requiredCorpus) * 100) : null,
      currency: input.currency,
      baseCurrencyValue: null,
      metadata: memberLabel ? { phase: isPreRetirement ? 'accumulation' : 'decumulation', member: memberLabel } : { phase: isPreRetirement ? 'accumulation' : 'decumulation' },
    });
  }

  if (balanceAtRetirement === null) balanceAtRetirement = balance; // retirement falls beyond the forecast horizon — use the final projected balance as the best available estimate

  const readinessPct = requiredCorpus !== null && requiredCorpus > 0 ? round2((balanceAtRetirement / requiredCorpus) * 100) : null;
  const status = statusFromReadiness(readinessPct);
  const fundingGap = requiredCorpus !== null ? round2(requiredCorpus - balanceAtRetirement) : null;

  const monthlyRate = monthlyCompoundRate(returnRate);
  const requiredContribution =
    requiredCorpus !== null && monthsUntilRetirement !== null && monthsUntilRetirement > 0
      ? requiredMonthlyContribution(requiredCorpus, input.currentBalance, monthlyRate, monthsUntilRetirement)
      : null;
  const contributionGap = requiredContribution !== null ? round2(Math.max(0, requiredContribution - input.monthlyContribution)) : null;

  const currency = input.currency as 'AUD' | 'INR';
  const narrativeParts: string[] = [];
  if (monthsUntilRetirement === null) {
    narrativeParts.push('Retirement age could not be projected because no date of birth is on file — this forecast shows the accumulation trajectory only.');
  } else {
    narrativeParts.push(
      `Projected retirement balance at age ${input.retirementAge} (in ${Math.round(monthsUntilRetirement / 12)} years) is ${formatMoneyWhole(balanceAtRetirement, currency)}.`
    );
  }
  if (requiredCorpus !== null) {
    narrativeParts.push(`Required retirement corpus under the ${input.targetMethod.replace('_', ' ')} method is ${formatMoneyWhole(requiredCorpus, currency)}.`);
    narrativeParts.push(
      fundingGap !== null && fundingGap > 0
        ? `This leaves a funding gap of approximately ${formatMoneyWhole(fundingGap, currency)}.`
        : 'The current trajectory is projected to fully fund this target.'
    );
    if (contributionGap && contributionGap > 0) {
      narrativeParts.push(
        `Closing the gap would require an additional ${formatMoneyWhole(contributionGap, currency)}/month, on top of the current ${formatMoneyWhole(input.monthlyContribution, currency)}/month.`
      );
    }
  } else {
    narrativeParts.push('A funding gap could not be calculated — the selected target method is missing a required input.');
  }
  if (depletionMonth !== null) {
    narrativeParts.push(`At the assumed withdrawal rate, the portfolio is projected to be depleted ${Math.round((depletionMonth - (monthsUntilRetirement ?? 0)) / 12)} years into retirement.`);
  }

  explanations.push(
    buildExplanation({
      entityType: 'retirement',
      entityId,
      explanationType: 'retirement_readiness_forecast',
      title: memberLabel ? `${memberLabel} retirement readiness forecast` : 'Retirement readiness forecast',
      narrative: memberLabel ? `${memberLabel}: ${narrativeParts.join(' ')}` : narrativeParts.join(' '),
      inputs: {
        currentBalance: input.currentBalance,
        monthlyContribution: input.monthlyContribution,
        assumedReturnPercent: returnRate,
        withdrawalRatePercent: withdrawalRate,
        monthsUntilRetirement,
        balanceAtRetirement,
        requiredCorpus,
        fundingGap,
        readinessPct,
        status,
        requiredMonthlyContribution: requiredContribution,
        contributionGap,
        depletionMonth,
      },
      formula:
        'Pre-retirement: Closing = (Opening + Contributions) x (1 + (1+annualReturn)^(1/12) - 1); Post-retirement: Closing = (Opening - Withdrawals) x (1 + (1+annualReturn)^(1/12) - 1); Required Corpus = Annual Income / Withdrawal Rate',
      priority: 10,
    })
  );

  return { results, explanations };
}
