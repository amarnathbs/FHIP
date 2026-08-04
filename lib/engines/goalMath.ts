// Shared deterministic math primitives reused by every category-specific goal
// forecaster in goalForecast.ts, so the same annuity/inflation formulas
// aren't redefined per goal type. Nominal-rate convention (annualRate/12)
// throughout, matching the existing estimateMonthsToPayoff() convention in
// lib/engines/dashboard.ts.

export function annualToMonthlyRate(annualRate: number): number {
  return annualRate / 12;
}

// Future value of a lump sum left to compound for `months` at `monthlyRate`.
export function futureValueOfLumpSum(currentAmount: number, monthlyRate: number, months: number): number {
  if (months <= 0) return currentAmount;
  return currentAmount * Math.pow(1 + monthlyRate, months);
}

// Today's-money target grown forward by cost inflation to the completion date.
export function inflationAdjustedTarget(currentCost: number, annualInflationRate: number, yearsRemaining: number): number {
  if (yearsRemaining <= 0) return currentCost;
  return currentCost * Math.pow(1 + annualInflationRate, yearsRemaining);
}

// The level monthly contribution (paid at each month-end) required to close
// the gap between the projected value of the current balance and the target,
// over `months` periods at `monthlyRate`. Falls back to the simple no-growth
// division when the rate is zero. Returns 0 if already fully funded.
export function requiredMonthlyContribution(
  targetFutureAmount: number,
  currentAmount: number,
  monthlyRate: number,
  months: number
): number | null {
  if (months <= 0) return null;
  const fvCurrent = futureValueOfLumpSum(currentAmount, monthlyRate, months);
  const gap = targetFutureAmount - fvCurrent;
  if (gap <= 0) return 0;
  if (monthlyRate === 0) return gap / months;
  return (gap * monthlyRate) / (Math.pow(1 + monthlyRate, months) - 1);
}

export interface ProjectionMonth {
  monthIndex: number;
  contribution: number;
  growth: number;
  closingBalance: number;
}

// Forward-simulates the balance month by month under a (possibly escalating)
// contribution plan plus optional one-off contributions, since a growing
// annuity with irregular lump sums has no simple closed form. Used both to
// project the value at a fixed target date and to solve for a completion
// date given a fixed contribution.
export function projectGoalBalance(params: {
  currentAmount: number;
  monthlyContribution: number;
  monthlyRate: number;
  months: number;
  annualContributionGrowthPct?: number;
  oneOffContributions?: { monthIndex: number; amount: number }[];
}): ProjectionMonth[] {
  const points: ProjectionMonth[] = [];
  let balance = params.currentAmount;
  let contribution = params.monthlyContribution;
  const growthPct = params.annualContributionGrowthPct ?? 0;
  const oneOffs = params.oneOffContributions ?? [];
  for (let m = 1; m <= params.months; m++) {
    if (growthPct > 0 && m > 1 && (m - 1) % 12 === 0) {
      contribution *= 1 + growthPct;
    }
    const oneOff = oneOffs.filter((o) => o.monthIndex === m).reduce((sum, o) => sum + o.amount, 0);
    const growth = balance * params.monthlyRate;
    const closingBalance = balance + growth + contribution + oneOff;
    points.push({ monthIndex: m, contribution: contribution + oneOff, growth, closingBalance });
    balance = closingBalance;
  }
  return points;
}

// Iteratively finds the first month the projected balance reaches
// targetAmount, given a fixed (non-escalating) monthly contribution. Returns
// null if unreachable within maxMonths (e.g. contribution + growth never
// catches up) — the caller should treat that as "beyond forecast horizon",
// not as an error.
export function monthsToTarget(
  currentAmount: number,
  monthlyContribution: number,
  monthlyRate: number,
  targetAmount: number,
  maxMonths = 600
): number | null {
  if (currentAmount >= targetAmount) return 0;
  let balance = currentAmount;
  for (let m = 1; m <= maxMonths; m++) {
    balance = balance * (1 + monthlyRate) + monthlyContribution;
    if (balance >= targetAmount) return m;
  }
  return null;
}

export function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

export function monthsBetween(from: Date, to: Date): number {
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}
