// R4 — Money-weighted return (XIRR). Investor-perspective sign convention:
// purchases / SIP instalments / cost = negative; redemptions, distributions
// received in cash, and the current ending value (as a synthetic terminal
// flow on the as-of date) = positive.
//
// Formula (spec sections 12-15):
//   Σ CF_i / (1 + r)^((date_i - date_0) / 365) = 0
// solved for r using ACTUAL calendar dates (never monthly-approximated
// periods). date_0 is the chronologically earliest cash-flow date in the
// series.
//
// Method: safeguarded Newton-Raphson bracketed by bisection (a Newton step
// that would leave the current bracket is replaced by a bisection step —
// this is the production algorithm). The independent oracle
// (scripts/ii_r4_independent_reconciliation.py) deliberately uses a
// DIFFERENT algorithm (pure high-precision bisection with no Newton step)
// so the two implementations are numerically independent, not the same
// algorithm copy-pasted into two files.
//
// Multiple-root handling: the valid search domain r ∈ (-1, RATE_DOMAIN_MAX]
// is scanned on a fixed grid for sign changes of NPV(r). Exactly one sign
// change → solve normally. Zero → NOT_BRACKETED. More than one *distinct*
// root → MULTIPLE_ROOTS_AMBIGUOUS (never silently pick one, per spec
// section 15). This is a real, if imperfect, degree-of-freedom-bounded
// search — not a heuristic guess.
//
// XIRR_METHOD_VERSION must be bumped whenever the algorithm, domain,
// tolerance, or bracket grid changes, so persisted ii_analytics_results
// rows can be identified as stale (spec sections 55-57).

export const XIRR_METHOD_VERSION = 'xirr-newton-bisection-v1';

export interface CashFlow {
  date: Date;
  amount: number; // investor-perspective sign convention (see file header)
}

export type XirrUnavailableReason =
  | 'ALL_SAME_SIGN'
  | 'NO_TERMINAL_VALUE'
  | 'INVALID_DATES'
  | 'INSUFFICIENT_HISTORY'
  | 'NOT_BRACKETED'
  | 'NO_CONVERGENCE'
  | 'MULTIPLE_ROOTS_AMBIGUOUS';

export interface XirrResult {
  status: 'ok' | 'unavailable';
  /** Annualised rate, e.g. 0.124 = 12.4%. Internal precision; round only for display. */
  rate?: number;
  iterations?: number;
  method?: typeof XIRR_METHOD_VERSION;
  reason?: XirrUnavailableReason;
  detail?: string;
}

// Internal precision far exceeds display precision (spec section 15).
const RATE_TOLERANCE = 1e-9; // convergence criterion on r between iterations
const NPV_RELATIVE_TOLERANCE = 1e-7; // |NPV(r)| / scale must fall below this
const MAX_ITERATIONS = 100;
const RATE_DOMAIN_FLOOR = -0.999999; // r > -1 strictly; guards 1/(1+r) blow-up
const RATE_DOMAIN_MAX = 100; // 10,000% annualised — generous upper bound for real-world data
// Display rounding convention: UI shows 2 decimal places of a percentage
// (e.g. 12.43%), i.e. 4 decimal places of the rate. Calculation precision
// (RATE_TOLERANCE = 1e-9) exceeds that by five orders of magnitude.
export const XIRR_DISPLAY_DECIMALS = 4;

// Bracket-search grid: dense near -100%..+300% (the range essentially all
// real fund/portfolio annualised returns fall in), sparse further out so
// pathological large-magnitude cash flows are still bracketable.
function buildSearchGrid(): number[] {
  const grid: number[] = [];
  for (const r of [-0.999999, -0.9999, -0.999, -0.995, -0.99, -0.98, -0.95, -0.9]) grid.push(r);
  for (let r = -0.8; r < 3; r += 0.02) grid.push(Number(r.toFixed(6)));
  for (let r = 3; r <= 10; r += 0.25) grid.push(r);
  for (let r = 10; r <= RATE_DOMAIN_MAX; r += 5) grid.push(r);
  return grid;
}
const SEARCH_GRID = buildSearchGrid();

function daysBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 86_400_000;
}

function npv(cashFlows: CashFlow[], date0: Date, r: number): number {
  if (r <= RATE_DOMAIN_FLOOR) return NaN;
  let total = 0;
  for (const cf of cashFlows) {
    const years = daysBetween(date0, cf.date) / 365;
    total += cf.amount / Math.pow(1 + r, years);
  }
  return total;
}

function dnpv(cashFlows: CashFlow[], date0: Date, r: number): number {
  if (r <= RATE_DOMAIN_FLOOR) return NaN;
  let total = 0;
  for (const cf of cashFlows) {
    const years = daysBetween(date0, cf.date) / 365;
    if (years === 0) continue;
    total += (-years * cf.amount) / Math.pow(1 + r, years + 1);
  }
  return total;
}

function scaleOf(cashFlows: CashFlow[]): number {
  const maxAbs = Math.max(...cashFlows.map((c) => Math.abs(c.amount)));
  return maxAbs > 0 ? maxAbs : 1;
}

/** Safeguarded Newton-Raphson, bisection fallback whenever a Newton step
 *  would leave [lo, hi] or fails to make progress. */
function solveInBracket(
  cashFlows: CashFlow[],
  date0: Date,
  lo: number,
  hi: number,
  scale: number
): { rate: number; iterations: number } | null {
  let a = lo;
  let b = hi;
  let fa = npv(cashFlows, date0, a);
  if (!Number.isFinite(fa)) return null;
  let x = (a + b) / 2;

  for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
    const fx = npv(cashFlows, date0, x);
    if (!Number.isFinite(fx)) return null;
    if (Math.abs(fx) / scale < NPV_RELATIVE_TOLERANCE) {
      return { rate: x, iterations: iter };
    }
    const dfx = dnpv(cashFlows, date0, x);
    let xNext = Number.isFinite(dfx) && dfx !== 0 ? x - fx / dfx : NaN;
    if (!Number.isFinite(xNext) || xNext <= a || xNext >= b) {
      // Newton produced no usable step, or left the bracket — bisect instead.
      xNext = (a + b) / 2;
    }
    const fNext = npv(cashFlows, date0, xNext);
    if (!Number.isFinite(fNext)) return null;
    if (Math.abs(fNext) / scale < NPV_RELATIVE_TOLERANCE) {
      return { rate: xNext, iterations: iter };
    }
    // Narrow the bracket so it strictly shrinks every iteration, guaranteeing
    // eventual convergence (bisection worst case) even when Newton stalls.
    if ((fa < 0 && fNext < 0) || (fa > 0 && fNext > 0)) {
      a = xNext;
      fa = fNext;
    } else {
      b = xNext;
    }
    if (Math.abs(b - a) < RATE_TOLERANCE) {
      return { rate: (a + b) / 2, iterations: iter };
    }
    x = xNext;
  }
  return null; // NO_CONVERGENCE
}

export function xirr(cashFlowsInput: CashFlow[]): XirrResult {
  if (!cashFlowsInput || cashFlowsInput.length < 2) {
    return { status: 'unavailable', reason: 'INSUFFICIENT_HISTORY', detail: 'Fewer than 2 cash flows supplied.' };
  }
  for (const cf of cashFlowsInput) {
    if (!(cf.date instanceof Date) || Number.isNaN(cf.date.getTime())) {
      return { status: 'unavailable', reason: 'INVALID_DATES', detail: 'One or more cash-flow dates are invalid.' };
    }
    if (!Number.isFinite(cf.amount)) {
      return { status: 'unavailable', reason: 'INVALID_DATES', detail: 'Non-finite cash-flow amount supplied.' };
    }
  }
  const cashFlows = [...cashFlowsInput].sort((a, b) => a.date.getTime() - b.date.getTime());
  const hasPositive = cashFlows.some((c) => c.amount > 0);
  const hasNegative = cashFlows.some((c) => c.amount < 0);
  if (!hasPositive || !hasNegative) {
    return { status: 'unavailable', reason: 'ALL_SAME_SIGN', detail: 'Cash flows must include at least one inflow and one outflow.' };
  }
  // The terminal flow (current value, if the position is still held) must
  // be present and positive, OR the series must end in a real redemption —
  // either way this is already covered by the sign check above; callers
  // are responsible for appending the ending-value terminal flow before
  // calling xirr() when the position is still open (see PerformanceEngine).

  const date0 = cashFlows[0].date;
  const scale = scaleOf(cashFlows);

  // Bracket search over the fixed grid.
  const brackets: Array<[number, number]> = [];
  let prevR = SEARCH_GRID[0];
  let prevF = npv(cashFlows, date0, prevR);
  for (let i = 1; i < SEARCH_GRID.length; i++) {
    const r = SEARCH_GRID[i];
    const f = npv(cashFlows, date0, r);
    if (Number.isFinite(prevF) && Number.isFinite(f)) {
      if (prevF === 0) {
        brackets.push([prevR, prevR]);
      } else if ((prevF < 0 && f > 0) || (prevF > 0 && f < 0)) {
        brackets.push([prevR, r]);
      }
    }
    prevR = r;
    prevF = f;
  }

  if (brackets.length === 0) {
    return { status: 'unavailable', reason: 'NOT_BRACKETED', detail: 'No sign change found for NPV(r) across the search domain.' };
  }

  // Solve within each bracket and de-duplicate roots that coincide within tolerance.
  const roots: number[] = [];
  for (const [lo, hi] of brackets) {
    const solved = lo === hi ? { rate: lo, iterations: 0 } : solveInBracket(cashFlows, date0, lo, hi, scale);
    if (!solved) {
      return { status: 'unavailable', reason: 'NO_CONVERGENCE', detail: `Failed to converge within bracket [${lo}, ${hi}].` };
    }
    if (!roots.some((r) => Math.abs(r - solved.rate) < 1e-6)) {
      roots.push(solved.rate);
    }
  }

  if (roots.length > 1) {
    return {
      status: 'unavailable',
      reason: 'MULTIPLE_ROOTS_AMBIGUOUS',
      detail: `${roots.length} distinct mathematically valid roots found: ${roots.map((r) => r.toFixed(6)).join(', ')}.`,
    };
  }

  const [lo, hi] = brackets[0];
  const solved = lo === hi ? { rate: lo, iterations: 0 } : solveInBracket(cashFlows, date0, lo, hi, scale);
  if (!solved) {
    return { status: 'unavailable', reason: 'NO_CONVERGENCE' };
  }
  return {
    status: 'ok',
    rate: solved.rate,
    iterations: solved.iterations,
    method: XIRR_METHOD_VERSION,
  };
}
