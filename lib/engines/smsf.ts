// Chunk 3a items 2-3 (Spec 2 §38-42): SMSF Summary-vs-Detailed mode
// aggregation. Pure, side-effect-free — no DB access — so it is directly
// unit-testable and safe to call from both the eventual UI layer and any
// server-side aggregation (dashboard.ts, forecasting) that later wires SMSF
// accounts through this instead of a raw current_balance read.
//
// The never-both-modes-counted rule (Spec 2 §41) is enforced structurally:
// this is an if/else on `mode`, never a sum of both sources, so a stale
// current_balance left over from before an account switched to Detailed
// mode can never be added on top of the holdings total.

export type SmsfMode = 'summary' | 'detailed' | null | undefined;

export interface SmsfAccountSummary {
  smsf_mode: SmsfMode;
  current_balance: number;
}

export interface SmsfHoldingValue {
  value: number;
  is_active?: boolean;
}

/**
 * The correct current total for an SMSF (or any retirement account carrying
 * an smsf_mode flag) under either mode:
 *  - 'detailed': sum of the account's active smsf_holdings rows ONLY —
 *    current_balance is never read, however stale/large it may be.
 *  - 'summary' or unset (every account created before this migration, or an
 *    account the user has never switched into Detailed mode): the account's
 *    own current_balance, exactly as today.
 */
export function computeSmsfTotal(account: SmsfAccountSummary, holdings: SmsfHoldingValue[]): number {
  if (account.smsf_mode === 'detailed') {
    return holdings.filter((h) => h.is_active !== false).reduce((sum, h) => sum + h.value, 0);
  }
  return account.current_balance;
}

/**
 * Structural guard usable by callers/tests to assert the never-double-count
 * invariant directly: the correct total must never equal the sum of BOTH
 * current_balance and the holdings total (the double-counted figure), unless
 * that sum coincidentally also equals one of the two valid answers.
 */
export function isDoubleCounted(account: SmsfAccountSummary, holdings: SmsfHoldingValue[], reportedTotal: number): boolean {
  const holdingsTotal = holdings.filter((h) => h.is_active !== false).reduce((sum, h) => sum + h.value, 0);
  const bothSummed = account.current_balance + holdingsTotal;
  const correct = computeSmsfTotal(account, holdings);
  return reportedTotal === bothSummed && bothSummed !== correct;
}
