// PC7 (M7) — the wealth-safety invariant (O.7, global D.2).
//
// THE INVARIANT, stated once and precisely:
//
//   A user's fund position is counted ONCE, via its own canonical register
//   value. Look-through constituents DECOMPOSE that already-counted number
//   into underlying exposures. They never re-derive it, never add to it, and
//   never contribute a second time to household net worth.
//
// This is PC7's single most important boundary, so it is defended three ways
// rather than one — because any one of the three can be true while the system
// is still wrong:
//
//   1. STRUCTURAL. No look-through table is ever read by a net-worth code
//      path, and no PC7 writer ever writes to a register table.
//      `NET_WORTH_INPUT_TABLES` / `LOOKTHROUGH_TABLES` below make that
//      checkable mechanically instead of by reading and hoping.
//      -> assertNoLookthroughInNetWorthInputs()
//
//   2. ARITHMETIC. Decomposition is closed: every weight the look-through
//      produces is a fraction of the SAME portfolio value, and the parts sum
//      back to exactly the whole. If they summed to more than the whole, the
//      decomposition itself would be creating wealth even with the structural
//      separation intact.
//      -> assertDecompositionIsClosed()
//
//   3. OBSERVED. Household net worth measured before and after ingesting a
//      full look-through disclosure is IDENTICAL, to the exact minor unit.
//      -> assertNetWorthUnchanged(), driven live in
//         scripts/pc7_networth_safety_live_dev.mjs
//
// A structural check alone would pass a system that double-counted inside the
// engine. An arithmetic check alone would pass a system whose engine was
// perfect and whose repository quietly inserted an extra asset row. Only all
// three together say what O.7 actually claims.

/**
 * Every table whose rows contribute to household net worth.
 *
 * Derived by reading `lib/services/dashboardData.ts` (the net-worth input
 * loader) and `lib/engines/dashboard.ts` (the `netWorth` computation) on
 * 2026-09-15, not from memory. `business_entities` is included because the
 * dashboard adds `businessEntityOwnershipValue` into `netWorth`.
 */
export const NET_WORTH_INPUT_TABLES = [
  'assets',
  'investments',
  'retirement_accounts',
  'liabilities',
  'business_entities',
  'financial_snapshots',
] as const;

/** Every table PC7 look-through data lives in. */
export const LOOKTHROUGH_TABLES = [
  'ii_fund_holdings',
  'ii_fund_holdings_snapshots',
  'ii_fund_holdings_lines',
] as const;

export type NetWorthInputTable = (typeof NET_WORTH_INPUT_TABLES)[number];
export type LookthroughTable = (typeof LOOKTHROUGH_TABLES)[number];

export interface SafetyViolation {
  code: 'LOOKTHROUGH_IN_NETWORTH_INPUT' | 'PC7_WRITES_REGISTER_TABLE' | 'DECOMPOSITION_EXCEEDS_WHOLE' | 'NET_WORTH_CHANGED';
  detail: string;
}

export interface SafetyCheckResult {
  ok: boolean;
  violations: SafetyViolation[];
  /** What was actually examined, so a vacuous pass is visible as vacuous. */
  examined: string[];
}

// ---------------------------------------------------------------------------
// 1. Structural
// ---------------------------------------------------------------------------

/**
 * Assert that no net-worth input table is a look-through table, and that the
 * two sets are genuinely disjoint.
 *
 * `netWorthTablesRead` is the list of tables a net-worth code path was
 * OBSERVED to read (supplied by the caller from a real inspection — the live
 * script passes the table list it extracted from `dashboardData.ts`). Passing
 * an empty list is reported as a violation rather than a pass, because "we
 * checked nothing and found nothing" is the vacuous-suite failure this
 * repository has been burned by before.
 */
export function assertNoLookthroughInNetWorthInputs(netWorthTablesRead: string[]): SafetyCheckResult {
  const violations: SafetyViolation[] = [];
  if (netWorthTablesRead.length === 0) {
    violations.push({
      code: 'LOOKTHROUGH_IN_NETWORTH_INPUT',
      detail: 'No net-worth input tables were supplied to check. An empty check is not a passing check.',
    });
    return { ok: false, violations, examined: [] };
  }
  const look = new Set<string>(LOOKTHROUGH_TABLES);
  for (const t of netWorthTablesRead) {
    if (look.has(t)) {
      violations.push({
        code: 'LOOKTHROUGH_IN_NETWORTH_INPUT',
        detail: `Net-worth computation reads '${t}', which is a look-through table. Look-through data would then contribute a SECOND time to net worth on top of the fund position it decomposes.`,
      });
    }
  }
  return { ok: violations.length === 0, violations, examined: netWorthTablesRead };
}

/**
 * Assert that a PC7 writer touches no register table.
 *
 * `tablesWritten` is the set of tables a PC7 code path writes, supplied from
 * real inspection of the module's write calls.
 */
export function assertPc7WritesNoRegisterTable(tablesWritten: string[]): SafetyCheckResult {
  const violations: SafetyViolation[] = [];
  const register = new Set<string>(NET_WORTH_INPUT_TABLES);
  for (const t of tablesWritten) {
    if (register.has(t)) {
      violations.push({
        code: 'PC7_WRITES_REGISTER_TABLE',
        detail: `A PC7 import path writes to '${t}', a net-worth input table. PC7 is reference data and must never write to the financial register.`,
      });
    }
  }
  return { ok: violations.length === 0, violations, examined: tablesWritten };
}

// ---------------------------------------------------------------------------
// 2. Arithmetic
// ---------------------------------------------------------------------------

export interface DecompositionParts {
  /** Σ effective weights of resolved underlying securities, fraction 0..1. */
  exposureWeight: number;
  cashWeight: number;
  derivativeWeight: number;
  otherWeight: number;
  unresolvedWeight: number;
  undisclosedRemainderWeight: number;
  noSnapshotWeight: number;
  /** The portfolio value being decomposed. */
  totalPortfolioValue: number;
}

/**
 * Decomposition must be CLOSED: the parts sum to 1, and the value they
 * describe is the same value that was already counted.
 *
 * The tolerance is for IEEE-754 accumulation over hundreds of lines, nothing
 * else. It is one part in 10^9 — far tighter than any rounding a currency
 * could introduce, so a genuine double-count of even the smallest holding
 * fails this, while summing 5,000 floats does not.
 */
export const DECOMPOSITION_TOLERANCE = 1e-9;

export function assertDecompositionIsClosed(parts: DecompositionParts): SafetyCheckResult {
  const sum =
    parts.exposureWeight +
    parts.cashWeight +
    parts.derivativeWeight +
    parts.otherWeight +
    parts.unresolvedWeight +
    parts.undisclosedRemainderWeight +
    parts.noSnapshotWeight;

  const violations: SafetyViolation[] = [];
  if (sum - 1 > DECOMPOSITION_TOLERANCE) {
    violations.push({
      code: 'DECOMPOSITION_EXCEEDS_WHOLE',
      detail:
        `Look-through parts sum to ${sum.toFixed(12)} of the portfolio, which is MORE than the whole. ` +
        `The decomposition is creating exposure that the underlying position does not contain — a within-portfolio double count. ` +
        `(exposure ${parts.exposureWeight}, cash ${parts.cashWeight}, derivative ${parts.derivativeWeight}, other ${parts.otherWeight}, ` +
        `unresolved ${parts.unresolvedWeight}, undisclosed ${parts.undisclosedRemainderWeight}, no-snapshot ${parts.noSnapshotWeight})`,
    });
  }
  if (1 - sum > DECOMPOSITION_TOLERANCE) {
    // A SHORTFALL is not a safety violation — it is under-disclosure, which is
    // honest and already surfaced as coverage. It is reported as examined
    // context, not as a violation, because clamping it would be the rescaling
    // O.4/O.8 forbid.
    return {
      ok: true,
      violations: [],
      examined: [`parts sum to ${sum.toFixed(12)} (< 1): a genuine disclosure shortfall, reported as coverage, never rescaled`],
    };
  }
  return {
    ok: violations.length === 0,
    violations,
    examined: [`parts sum to ${sum.toFixed(12)} against a whole of 1 (tolerance ${DECOMPOSITION_TOLERANCE})`],
  };
}

// ---------------------------------------------------------------------------
// 3. Observed
// ---------------------------------------------------------------------------

export interface NetWorthObservation {
  label: string;
  totalAssets: number;
  totalInvestments: number;
  totalRetirement: number;
  totalLiabilities: number;
  netWorth: number;
}

/**
 * Assert that ingesting look-through data changed nothing about net worth.
 *
 * Compared EXACTLY, not within a tolerance. There is no legitimate reason for
 * a look-through import to move net worth by a single paisa, so any tolerance
 * at all would only serve to hide a real defect.
 */
export function assertNetWorthUnchanged(before: NetWorthObservation, after: NetWorthObservation): SafetyCheckResult {
  const fields: Array<keyof NetWorthObservation> = ['totalAssets', 'totalInvestments', 'totalRetirement', 'totalLiabilities', 'netWorth'];
  const violations: SafetyViolation[] = [];
  const examined: string[] = [];
  for (const f of fields) {
    const b = before[f] as number;
    const a = after[f] as number;
    examined.push(`${f}: ${b} -> ${a}`);
    if (b !== a) {
      violations.push({
        code: 'NET_WORTH_CHANGED',
        detail: `${f} changed from ${b} to ${a} across a look-through ingestion (${before.label} -> ${after.label}). Look-through is analytical decomposition and must leave the register bit-identical.`,
      });
    }
  }
  return { ok: violations.length === 0, violations, examined };
}

/** Combine several checks into one verdict. */
export function combineSafetyChecks(results: SafetyCheckResult[]): SafetyCheckResult {
  return {
    ok: results.every((r) => r.ok),
    violations: results.flatMap((r) => r.violations),
    examined: results.flatMap((r) => r.examined),
  };
}
