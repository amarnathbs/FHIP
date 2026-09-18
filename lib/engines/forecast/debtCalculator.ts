// Phase 3 — Debt Reduction Forecasting (spec section 10). "Current Behaviour
// Forecast" (10.3) using the existing repayment amount is the stored monthly
// trajectory; "Additional repayment analysis" and "Interest scenarios"
// (10.5) are computed as side comparisons surfaced only in the explanation,
// not as extra stored rows — mirroring how goalCalculator.ts surfaces
// required-contribution-gap analysis without persisting a second scenario's
// full monthly history. "Liability snapshots" / "Actual-versus-plan
// tracking" / retaining the original plan (10.1-10.2) are already covered
// generically by forecast_runs never being overwritten — the earliest
// completed run for a liability IS the retained original plan, the same
// mechanism goal and net-worth forecasts already rely on.
import { buildExplanation } from './explain';
import {
  addMonthsToDateString,
  derivePayoffTerm,
  firstOfMonth,
  formatTerm,
  interestOnlyPayment,
  levelPaymentForPayoff,
  projectLoanMonth,
  round2,
} from './monthlyPrimitives';
import type { ForecastExplanationRow, ForecastResultRow, ResolvedAssumptionSet } from './types';
import { formatMoneyNarrative } from '../money';

export type DebtRiskLevel = 'high' | 'medium' | 'low';

export interface DebtCalculatorInputEntry {
  id: string;
  name: string;
  currentBalance: number;
  annualInterestRatePercent: number;
  monthlyRepayment: number;
  debtType: string;
  currency: string;
  // Added for FHIP-FC-DEBT-001/002/003's risk ranking — all three are
  // already on the liabilities table, this calculator just didn't read them
  // before. All optional/nullable since older rows may not have them set.
  // App Review 2026-09-15 item 8: false when liabilities.interest_rate is
  // null, i.e. the user never entered a rate and the projection is running
  // interest-free. Optional so existing callers/tests stay valid; treated as
  // "provided" when absent, which is what every pre-existing caller meant.
  interestRateProvided?: boolean;
  interestRateType?: 'fixed' | 'variable' | null;
  fixedRateExpiry?: string | null; // ISO date
  creditLimit?: number | null; // relevant for revolving debt types (credit cards, BNPL)
}

export interface DebtCalculatorInput {
  baselineDate: string;
  months: number;
  assumptions: ResolvedAssumptionSet;
  additionalMonthlyRepayment: number;
  liabilities: DebtCalculatorInputEntry[];
}

interface PayoffSummary {
  payoffMonth: number | null; // null = not paid off within the horizon
  totalInterest: number;
}

// Runs a standalone (unstored) payoff projection for comparison scenarios —
// same formula as the stored loop below, just not persisted per-period.
function projectPayoff(openingBalance: number, annualRatePercent: number, repayment: number, months: number): PayoffSummary {
  let balance = openingBalance;
  let totalInterest = 0;
  let payoffMonth: number | null = balance <= 0 ? 0 : null;
  for (let m = 1; m <= months && balance > 0; m++) {
    const month = projectLoanMonth({ openingBalance: balance, annualInterestRatePercent: annualRatePercent, repayment });
    totalInterest += month.interest;
    balance = month.closingBalance;
    if (payoffMonth === null && balance <= 0) payoffMonth = m;
  }
  return { payoffMonth, totalInterest: round2(totalInterest) };
}

function monthsUntil(baselineDate: string, targetDate: string): number {
  const base = new Date(baselineDate + 'T00:00:00Z');
  const target = new Date(targetDate + 'T00:00:00Z');
  return (target.getUTCFullYear() - base.getUTCFullYear()) * 12 + (target.getUTCMonth() - base.getUTCMonth());
}

// FHIP-FC-DEBT-003 — deterministic risk ranking. "High" covers the cases
// where the current trajectory or a known upcoming change could materially
// worsen the debt (balance actually growing, a fixed rate about to reset, or
// a revolving balance close to its limit); "Medium" flags a variable rate
// with none of the above triggers (exposed to rate rises but no imminent
// known event); everything else is "Low".
function assessDebtRisk(liability: DebtCalculatorInputEntry, baselineDate: string, isNegativeAmortization: boolean): DebtRiskLevel {
  if (isNegativeAmortization) return 'high';
  if (liability.fixedRateExpiry) {
    const monthsToExpiry = monthsUntil(baselineDate, liability.fixedRateExpiry);
    if (monthsToExpiry >= 0 && monthsToExpiry <= 12) return 'high';
  }
  if (liability.creditLimit && liability.creditLimit > 0 && liability.currentBalance / liability.creditLimit > 0.8) return 'high';
  if (liability.interestRateType === 'variable') return 'medium';
  return 'low';
}

export function runDebtForecast(input: DebtCalculatorInput): { results: ForecastResultRow[]; explanations: ForecastExplanationRow[] } {
  const results: ForecastResultRow[] = [];
  const explanations: ForecastExplanationRow[] = [];
  const baseline = firstOfMonth(input.baselineDate);

  for (const liability of input.liabilities) {
    let balance = liability.currentBalance;
    let totalInterest = 0;
    let payoffMonth: number | null = balance <= 0 ? 0 : null;

    for (let m = 1; m <= input.months && balance > 0; m++) {
      const periodDate = addMonthsToDateString(baseline, m);
      const month = projectLoanMonth({
        openingBalance: balance,
        annualInterestRatePercent: liability.annualInterestRatePercent,
        repayment: liability.monthlyRepayment,
      });
      totalInterest += month.interest;
      balance = month.closingBalance;
      if (payoffMonth === null && balance <= 0) payoffMonth = m;

      results.push({
        forecastType: 'debt',
        entityType: 'liability',
        entityId: liability.id,
        periodDate,
        periodNumber: m,
        openingValue: month.openingBalance,
        contributions: 0,
        withdrawals: month.principalReduction,
        income: 0,
        expenses: 0,
        interest: month.interest,
        investmentReturn: 0,
        fees: month.fees,
        fxGainLoss: 0,
        otherMovement: 0,
        closingValue: balance,
        targetValue: 0,
        varianceValue: round2(balance - 0),
        variancePercentage: null,
        currency: liability.currency,
        baseCurrencyValue: null,
        metadata: { liabilityName: liability.name, debtType: liability.debtType },
      });
    }

    const accelerated =
      input.additionalMonthlyRepayment > 0
        ? projectPayoff(liability.currentBalance, liability.annualInterestRatePercent, liability.monthlyRepayment + input.additionalMonthlyRepayment, input.months)
        : null;
    const higherRate = projectPayoff(liability.currentBalance, liability.annualInterestRatePercent + 1, liability.monthlyRepayment, input.months);
    const lowerRate = projectPayoff(liability.currentBalance, Math.max(0, liability.annualInterestRatePercent - 1), liability.monthlyRepayment, input.months);

    // App Review 2026-09-15, items 8 + 9 + G1.
    //
    // Item 9 — the payoff term is now DERIVED from the amortisation formula
    // (derivePayoffTerm, same reducing-balance step and rounding as the
    // stored loop above) instead of being clipped to the forecast window.
    // Before this change every card, whatever its balance or repayment, ended
    // with the identical "within the 120-month forecast horizon" clause, which
    // carried no information about the loan and read — as the reviewer read
    // it — as if 120 months were this loan's term. The forecast window is now
    // presented only as a window ("beyond the 120-month forecast window.
    // Balance after 120 months: …"), never as the payoff statement.
    //
    // Item 8 — wording. The old sentence was literally true (not paid off
    // within the horizon) but was misread as claiming the loan IS tied to 120
    // months, because it never said what the real term was. Each branch below
    // now states the derived term, or says explicitly that there isn't one.
    //
    // G1 — every amount in these sentences goes through the shared whole-unit
    // formatter with this liability's own currency (previously raw floats:
    // "2500/month", "53471.34", "333.95", "1240.3").
    const money = (n: number) => formatMoneyNarrative(n, liability.currency);
    const derived = derivePayoffTerm(liability.currentBalance, liability.annualInterestRatePercent, liability.monthlyRepayment);
    const balanceAtHorizon = balance; // the loop above leaves this at period `input.months` when not paid off
    // The minimum payment that stops the balance growing, and the payment
    // that clears it in 3 years — both already computed below for the
    // negative-amortisation case; hoisted so the narrative can use them.
    const curePaymentForNarrative = liability.currentBalance > 0 ? interestOnlyPayment(liability.currentBalance, liability.annualInterestRatePercent) : 0;
    const clearIn3yrPayment = levelPaymentForPayoff(liability.currentBalance, liability.annualInterestRatePercent, 36);

    let payoffNarrative: string;
    if (payoffMonth === 0) {
      payoffNarrative = 'This debt is already paid off.';
    } else if (payoffMonth !== null) {
      // Paid off inside the forecast window — the derived term and the
      // in-window month agree by construction (same step, same rounding).
      payoffNarrative =
        `At the current repayment of ${money(liability.monthlyRepayment)}/month, this debt is projected to be paid off in ` +
        `${formatTerm(payoffMonth)} (${payoffMonth} months), with ${money(round2(totalInterest))} in total interest.`;
    } else if (derived.balanceGrowing) {
      payoffNarrative =
        `At the current repayment of ${money(liability.monthlyRepayment)}/month, this debt is not reducing — the repayment does not cover the interest accruing on it, ` +
        `so the balance grows to ${money(balanceAtHorizon)} in ${formatTerm(input.months)}. ` +
        `A minimum of ${money(curePaymentForNarrative)}/month stops it growing; ${money(clearIn3yrPayment)}/month clears it in 3 years.`;
    } else if (derived.months !== null) {
      payoffNarrative =
        `At the current repayment of ${money(liability.monthlyRepayment)}/month, this debt is projected to be paid off in ` +
        `${formatTerm(derived.months)} (${derived.months} months) — beyond the ${input.months}-month forecast window. ` +
        `Balance after ${formatTerm(input.months)}: ${money(balanceAtHorizon)}.`;
    } else {
      // Reduces, but not to zero inside the 100-year search cap.
      payoffNarrative =
        `At the current repayment of ${money(liability.monthlyRepayment)}/month, this debt reduces so slowly that it is not projected to be paid off within 100 years. ` +
        `Balance after ${formatTerm(input.months)}: ${money(balanceAtHorizon)}. ` +
        `${money(clearIn3yrPayment)}/month would clear it in 3 years.`;
    }

    const acceleratedNarrative =
      accelerated && accelerated.payoffMonth !== null
        ? payoffMonth !== null
          ? ` Adding ${money(input.additionalMonthlyRepayment)}/month would bring the payoff forward to ${formatTerm(accelerated.payoffMonth)} (${payoffMonth - accelerated.payoffMonth} months sooner) and save approximately ${money(round2(totalInterest - accelerated.totalInterest))} in interest.`
          : ` Adding ${money(input.additionalMonthlyRepayment)}/month would bring this debt within the forecast window, paid off in ${formatTerm(accelerated.payoffMonth)} instead of remaining outstanding — saving approximately ${money(round2(totalInterest - accelerated.totalInterest))} in interest over the ${input.months}-month window.`
        : accelerated && input.additionalMonthlyRepayment > 0
          ? ` Even with an extra ${money(input.additionalMonthlyRepayment)}/month, this debt is still not projected to be paid off within the ${input.months}-month forecast window.`
          : '';

    const rateNarrative = ` A 1% rate rise would add approximately ${money(round2(higherRate.totalInterest - totalInterest))} in total interest; a 1% rate cut would save approximately ${money(round2(totalInterest - lowerRate.totalInterest))}.`;

    // FHIP-FC-DEBT-001/002/003 — negative amortisation, risk ranking, and
    // payoff alternatives. isNegativeAmortization checks the FIRST month's
    // repayment against that month's accruing interest+fees (the balance's
    // own trajectory over the loop above already reflects this correctly —
    // see monthlyPrimitives.ts's projectLoanMonth — this is purely about
    // detecting/flagging it, not fixing broken math).
    const firstMonthInterestFees = liability.currentBalance > 0 ? interestOnlyPayment(liability.currentBalance, liability.annualInterestRatePercent) : 0;
    const isNegativeAmortization = liability.currentBalance > 0 && liability.monthlyRepayment < firstMonthInterestFees;
    const riskLevel = assessDebtRisk(liability, input.baselineDate, isNegativeAmortization);
    const curePayment = liability.currentBalance > 0 ? interestOnlyPayment(liability.currentBalance, liability.annualInterestRatePercent) : 0;
    const payoffPayment3yr = levelPaymentForPayoff(liability.currentBalance, liability.annualInterestRatePercent, 36);
    const payoffPayment5yr = levelPaymentForPayoff(liability.currentBalance, liability.annualInterestRatePercent, 60);

    // The "balance is growing", cure-payment and clear-in-3-years facts moved
    // into payoffNarrative above (item 9's third template), so this clause
    // adds only what is not already stated, rather than repeating it.
    const riskNarrative = isNegativeAmortization ? ` ${money(payoffPayment5yr)}/month would clear it in 5 years.` : '';

    // App Review 2026-09-15 item 8 requirement 2 — a projection run at 0%
    // because no rate was ever entered must say so, rather than presenting an
    // interest-free amortisation as if it were this loan's real trajectory.
    const rateSourceNarrative =
      liability.interestRateProvided === false
        ? ' No interest rate is recorded for this debt, so it is projected interest-free. Add the rate to get an accurate payoff term.'
        : '';

    explanations.push(
      buildExplanation({
        entityType: 'liability',
        entityId: liability.id,
        explanationType: 'debt_payoff_forecast',
        title: `${liability.name} — payoff forecast`,
        narrative: payoffNarrative + rateSourceNarrative + acceleratedNarrative + rateNarrative + riskNarrative,
        inputs: {
          currentBalance: liability.currentBalance,
          annualInterestRatePercent: liability.annualInterestRatePercent,
          interestRateSource: liability.interestRateProvided === false ? 'not_recorded_projected_interest_free' : 'user_entered',
          monthlyRepayment: liability.monthlyRepayment,
          payoffMonth,
          // App Review 2026-09-15 item 9 — the DERIVED term, unclipped by the
          // forecast window, alongside the in-window month. Persisted on the
          // explanation row so the figure in the sentence is auditable.
          derivedPayoffMonths: derived.months,
          derivedPayoffBalanceGrowing: derived.balanceGrowing,
          derivedPayoffBeyondSearchCap: derived.beyondSearchCap,
          balanceAtForecastHorizon: round2(balanceAtHorizon),
          forecastHorizonMonths: input.months,
          totalInterest: round2(totalInterest),
          isNegativeAmortization,
          riskLevel,
          curePayment,
          payoffPayment3yr,
          payoffPayment5yr,
          additionalMonthlyRepayment: input.additionalMonthlyRepayment || null,
          acceleratedPayoffMonth: accelerated?.payoffMonth ?? null,
          acceleratedTotalInterest: accelerated?.totalInterest ?? null,
          higherRateTotalInterest: higherRate.totalInterest,
          lowerRateTotalInterest: lowerRate.totalInterest,
        },
        formula:
          'Monthly Interest = Opening x Annual Rate / 12; Principal Reduction = Repayment - Interest - Fees; Closing = max(0, Opening - Principal Reduction). ' +
          'Payoff term = the smallest n for which Closing(n) <= 0 under that same recurrence, searched to 1200 months and NOT clipped to the forecast window.',
        priority: 10,
      })
    );
  }

  return { results, explanations };
}
