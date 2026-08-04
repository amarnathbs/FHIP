// Deterministic monthly calculation primitives shared by every forecast
// calculator (net worth, retirement, goal, debt, investment, etc). Explicitly
// NOT Monte Carlo — spec section 3 requires the first release to be
// transparent/deterministic while leaving room for simulation to be added
// later without a schema change (forecast_results already stores one row per
// period per entity, which a simulation engine could just write more of).
//
// Note this module uses true geometric monthly-equivalent compounding
// ((1+annual)^(1/12)-1), per spec section 21's explicit formulas — a
// different convention from goalMath.ts's simpler nominal annualRate/12
// used by the existing Goal Planning module. Kept separate deliberately:
// this is a new module with its own spec-mandated formulas, not a shared
// primitive to be reconciled with the older module.

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// (1 + annualRatePct/100) ^ (1/12) - 1
export function monthlyCompoundRate(annualRatePercent: number): number {
  return Math.pow(1 + annualRatePercent / 100, 1 / 12) - 1;
}

export interface InvestmentMonthInput {
  openingValue: number;
  contributions: number;
  withdrawals: number;
  annualReturnPercent: number;
  fees?: number;
}

export interface InvestmentMonthResult {
  openingValue: number;
  contributions: number;
  withdrawals: number;
  investmentReturn: number;
  fees: number;
  closingValue: number;
}

// Closing Value = (Opening + Contributions - Withdrawals) x (1 + MonthlyReturn) - Fees
export function projectInvestmentMonth(input: InvestmentMonthInput): InvestmentMonthResult {
  const fees = input.fees ?? 0;
  const monthlyRate = monthlyCompoundRate(input.annualReturnPercent);
  const base = input.openingValue + input.contributions - input.withdrawals;
  const grown = base * (1 + monthlyRate);
  const investmentReturn = grown - base;
  const closingValue = round2(grown - fees);
  return {
    openingValue: round2(input.openingValue),
    contributions: round2(input.contributions),
    withdrawals: round2(input.withdrawals),
    investmentReturn: round2(investmentReturn),
    fees: round2(fees),
    closingValue,
  };
}

export interface LoanMonthInput {
  openingBalance: number;
  annualInterestRatePercent: number;
  repayment: number;
  fees?: number;
  additionalBorrowing?: number;
}

export interface LoanMonthResult {
  openingBalance: number;
  interest: number;
  principalReduction: number;
  repayment: number;
  fees: number;
  additionalBorrowing: number;
  closingBalance: number;
}

// Monthly Interest = Opening Balance x Annual Interest Rate / 12
// Principal Reduction = Repayment - Monthly Interest - Fees
export function projectLoanMonth(input: LoanMonthInput): LoanMonthResult {
  const fees = input.fees ?? 0;
  const additionalBorrowing = input.additionalBorrowing ?? 0;
  const interest = input.openingBalance * (input.annualInterestRatePercent / 100) / 12;
  const principalReduction = input.repayment - interest - fees;
  const closingBalance = round2(Math.max(0, input.openingBalance - principalReduction + additionalBorrowing));
  return {
    openingBalance: round2(input.openingBalance),
    interest: round2(interest),
    principalReduction: round2(principalReduction),
    repayment: round2(input.repayment),
    fees: round2(fees),
    additionalBorrowing: round2(additionalBorrowing),
    closingBalance,
  };
}

export function addMonthsToDateString(isoDate: string, months: number): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

export function firstOfMonth(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
}
