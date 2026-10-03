// NAV2 -- INVESTOR-EXPERIENCE results (spec 2.2, 9.1, 9.2). Family:
// investor_experience. Pure.
//
// These describe the user's OWN money: the dated cash flows of their canonical
// transactions, the units they hold and the value of those units. They are the
// only place a personal return exists, and the only personal return is XIRR (PO
// decision 2026-10-03: no time-based or chain-linked alternative). It is solved by
// the certified R4 engine (xirr.ts); nothing here re-implements it. The value of the
// holding comes from the certified valueHoldingAsOf rule (units x latest ELIGIBLE NAV,
// the NAV's own date, statement value kept separately), which the caller runs and
// passes in.
//
// The two families never mix: this module never reads a scheme CAGR, and
// schemeReturns.ts never reads a cash flow. The labels below are what a screen or
// report must put next to each family, and EXPLANATION is the plain-language
// difference (spec 2.2: "explain the difference in plain language").

import { xirr, XIRR_METHOD_VERSION, type CashFlow, type XirrUnavailableReason } from '@/lib/engines/investment-intelligence/xirr';
import type { HoldingValuation } from '@/lib/engines/investment-intelligence/valuation/currentHoldingValuation';
import { available, makeProvenance, showDate, unavailable, type Disclosure, type Nav2Context, type Nav2Result, type Nav2UnavailableState } from './types';

export const SCHEME_CAGR_LABEL = "Scheme CAGR (the fund's own growth, not your personal return)";
export const INVESTOR_XIRR_LABEL = 'Your return (XIRR, based on when your own money went in and came out)';
export const SCHEME_VS_INVESTOR_EXPLANATION =
  "The fund's own growth figures (such as CAGR, rolling returns, volatility and drawdown) show how the scheme performed whatever day anyone invested. " +
  'Your return (XIRR) shows what you actually earned, because it follows the dates and amounts of your own investments and withdrawals. ' +
  'The two usually differ, and a difference does not mean either is wrong.';

export interface InvestorExperienceInput {
  instrumentId: string;
  /** Investor-perspective cash flows EXCLUDING the terminal value: purchases negative, redemptions and cash distributions positive. */
  flows: readonly CashFlow[];
  /** The holding's value from valueHoldingAsOf (the one valuation rule). */
  valuation: HoldingValuation;
  /** Calculation date, ISO. */
  asOfDate: string;
}

export interface XirrValue {
  rate: number;
  periodStart: string;
  periodEnd: string;
  cashFlowCount: number;
  terminalValue: number;
  /** The date of the NAV (or statement) the terminal value rests on. */
  terminalValueDate: string | null;
  terminalBasis: HoldingValuation['basis'];
  solver: typeof XIRR_METHOD_VERSION;
  label: typeof INVESTOR_XIRR_LABEL;
}

export interface CurrentValueValue {
  /** units x latest eligible NAV (basis 'market_nav'), or the statement's own value (basis 'statement'), or 0 when redeemed. */
  value: number;
  basis: 'market_nav' | 'statement' | 'redeemed';
  units: number | null;
  nav: number | null;
  /** That NAV's own date. */
  navDate: string | null;
  /** Kept separately, always labelled as the statement's value. */
  statementValue: number | null;
  statementAsOfDate: string | null;
  statementSuperseded: boolean;
  stale: boolean;
}

export interface InvestedAmountValue {
  invested: number;
  received: number;
  firstInvestmentDate: string | null;
}

export interface GainLossValue {
  /** current value + amounts received - amounts invested. Absolute, not annualised. */
  gainLoss: number;
  currentValue: number;
  invested: number;
  received: number;
}

export interface InvestorExperience {
  family: 'investor_experience';
  instrumentId: string;
  asOfDate: string;
  xirr: Nav2Result<XirrValue>;
  currentValue: Nav2Result<CurrentValueValue>;
  investedAmount: Nav2Result<InvestedAmountValue>;
  gainLoss: Nav2Result<GainLossValue>;
  label: typeof INVESTOR_XIRR_LABEL;
}

const iso = (d: Date): string => d.toISOString().slice(0, 10);

/** Engine reason -> NAV2 state. Stated here once; the detail text is the engine's own, in plain words. */
function xirrState(reason: XirrUnavailableReason | undefined): { state: Nav2UnavailableState; reason: 'no_terminal_value' | 'xirr_unavailable' } {
  switch (reason) {
    case 'NO_TERMINAL_VALUE':
    case 'INSUFFICIENT_HISTORY':
      return { state: 'insufficient_history', reason: 'no_terminal_value' };
    case 'ALL_SAME_SIGN':
      return { state: 'not_applicable', reason: 'xirr_unavailable' };
    case 'INVALID_DATES':
      return { state: 'data_quality_hold', reason: 'xirr_unavailable' };
    default:
      // NOT_BRACKETED, NO_CONVERGENCE, MULTIPLE_ROOTS_AMBIGUOUS: honest "cannot be solved", never a guessed rate.
      return { state: 'not_applicable', reason: 'xirr_unavailable' };
  }
}

export function computeInvestorExperience(input: InvestorExperienceInput, ctx: Nav2Context): InvestorExperience {
  const v = input.valuation;
  const flows = input.flows.filter((f) => Number.isFinite(f.amount) && f.amount !== 0);
  const base = { instrumentId: input.instrumentId, convention: { family: 'investor_experience', dayCount: 'actual_365', solver: XIRR_METHOD_VERSION } as Record<string, string> };

  // ---- current value -------------------------------------------------------
  let currentValue: Nav2Result<CurrentValueValue>;
  if (v.basis === 'unavailable' || v.marketValue === null) {
    currentValue = unavailable('insufficient_history', 'no_valuation', 'There is no statement or price to value this holding yet.', makeProvenance(ctx, 'current_value', base));
  } else {
    const disclosures: Disclosure[] = [];
    if (v.basis === 'statement') {
      disclosures.push({ code: 'statement_value', detail: `Statement value as at ${showDate(ctx, v.statementAsOfDate)}; no newer published price was used.` });
    }
    if (v.stale) {
      disclosures.push({ code: 'stale_nav', detail: `The price used is dated ${showDate(ctx, v.valuationDate)}, which is not recent.` });
    }
    currentValue = available(
      {
        value: v.marketValue,
        basis: v.basis,
        units: v.units,
        nav: v.nav,
        navDate: v.navDate,
        statementValue: v.statementValue,
        statementAsOfDate: v.statementAsOfDate,
        statementSuperseded: v.statementSuperseded,
        stale: v.stale,
      },
      makeProvenance(ctx, 'current_value', { ...base, actual: { start: null, end: v.valuationDate } }),
      disclosures
    );
  }

  // ---- invested amount -----------------------------------------------------
  const purchases = flows.filter((f) => f.amount < 0);
  let investedAmount: Nav2Result<InvestedAmountValue>;
  if (purchases.length === 0) {
    investedAmount = unavailable('insufficient_history', 'no_terminal_value', 'No purchase is recorded for this holding, so an invested amount cannot be shown.', makeProvenance(ctx, 'invested_amount', base));
  } else {
    const first = [...purchases].sort((a, b) => a.date.getTime() - b.date.getTime())[0];
    investedAmount = available(
      {
        invested: purchases.reduce((s, f) => s - f.amount, 0),
        received: flows.filter((f) => f.amount > 0).reduce((s, f) => s + f.amount, 0),
        firstInvestmentDate: iso(first.date),
      },
      makeProvenance(ctx, 'invested_amount', { ...base, observationCount: purchases.length })
    );
  }

  // ---- gain / loss -----------------------------------------------------------
  let gainLoss: Nav2Result<GainLossValue>;
  if (currentValue.state === 'available' && investedAmount.state === 'available') {
    const g = currentValue.value.value + investedAmount.value.received - investedAmount.value.invested;
    gainLoss = available({ gainLoss: g, currentValue: currentValue.value.value, invested: investedAmount.value.invested, received: investedAmount.value.received }, makeProvenance(ctx, 'gain_loss', base));
  } else {
    gainLoss = unavailable('insufficient_history', 'no_valuation', 'A gain or loss needs both a recorded investment and a current value, and one of them is missing.', makeProvenance(ctx, 'gain_loss', base));
  }

  // ---- XIRR ------------------------------------------------------------------
  let xirrResult: Nav2Result<XirrValue>;
  const terminalDate = v.valuationDate ?? input.asOfDate;
  const cashFlows: CashFlow[] = [...flows];
  if (v.marketValue !== null && v.marketValue > 0) cashFlows.push({ date: new Date(`${terminalDate}T00:00:00.000Z`), amount: v.marketValue });
  if (v.basis === 'unavailable' || v.marketValue === null) {
    xirrResult = unavailable('insufficient_history', 'no_valuation', 'There is no statement or price to value this holding yet, so your return cannot be calculated.', makeProvenance(ctx, 'xirr', base));
  } else {
    const r = xirr(cashFlows);
    if (r.status === 'ok' && r.rate !== undefined) {
      const sorted = [...cashFlows].sort((a, b) => a.date.getTime() - b.date.getTime());
      const disclosures: Disclosure[] = [];
      if (v.basis === 'statement') {
        disclosures.push({ code: 'statement_value', detail: `The current value is the statement value as at ${showDate(ctx, v.statementAsOfDate)}, not a market price, so this return is measured to that date.` });
      }
      xirrResult = available(
        {
          rate: r.rate,
          periodStart: iso(sorted[0].date),
          periodEnd: iso(sorted[sorted.length - 1].date),
          cashFlowCount: cashFlows.length,
          terminalValue: v.marketValue,
          terminalValueDate: v.valuationDate,
          terminalBasis: v.basis,
          solver: XIRR_METHOD_VERSION,
          label: INVESTOR_XIRR_LABEL,
        },
        makeProvenance(ctx, 'xirr', { ...base, actual: { start: iso(sorted[0].date), end: iso(sorted[sorted.length - 1].date) }, observationCount: cashFlows.length }),
        disclosures
      );
    } else {
      const m = xirrState(r.reason);
      xirrResult = unavailable(m.state, m.reason, r.detail ?? 'A return could not be calculated for this holding.', makeProvenance(ctx, 'xirr', { ...base, observationCount: cashFlows.length }));
    }
  }

  return {
    family: 'investor_experience',
    instrumentId: input.instrumentId,
    asOfDate: input.asOfDate,
    xirr: xirrResult,
    currentValue,
    investedAmount,
    gainLoss,
    label: INVESTOR_XIRR_LABEL,
  };
}
