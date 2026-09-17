/**
 * PC5 (M4) — feature flags.
 *
 * Same convention as every other AIE/adapter flag in this codebase
 * (`lib/aie/featureFlags.ts`, `lib/aie/review/featureFlags.ts`,
 * `lib/aie/adapters/investment-intelligence/featureFlags.ts`): an env var
 * must equal the literal string `'true'`; anything else — unset, `'1'`,
 * `'TRUE'`, `'yes'` — leaves the gate OFF. All default OFF. This phase
 * grants no production authority.
 *
 * WHY PC5 REUSES `AIE_REVIEW_PC5_PROJECTION_ENABLED` RATHER THAN MINTING A
 * NEW NAME. AIE-1.5 reserved that exact variable for exactly this
 * ("PC5-01..12 — a governed AIE query/view for PC5 is NOT built this pass
 * ... Reserved flag") and left it checked by nothing, with the explicit
 * intent that "a future pass adds the real gate here rather than inventing
 * a new name". This is that pass. Inventing `PC5_ENABLED` alongside it
 * would leave an operator with two switches for one capability and no way
 * to tell which one is live.
 */

/** Whether PC5's governed resolution surface (read AND write) is reachable
 * at all. Gates every PC5 route. */
export function isPc5ResolutionEnabled(): boolean {
  return process.env.AIE_REVIEW_PC5_PROJECTION_ENABLED === 'true';
}

/**
 * K.17 — bulk decisions. OFF, and there is no code path that could turn it
 * on, because PC5 deliberately implements no bulk action at all.
 *
 * K.17's own wording is the reason: *"Do not implement blind 'Accept all'
 * across heterogeneous financial exceptions. If bulk action is supported,
 * restrict it to explicitly safe homogeneous items and preserve atomicity/
 * audit."* The "if" is a permission, not a requirement — and the set of
 * exceptions PC5 can actually produce today is irreducibly heterogeneous:
 * an owner mismatch, an ambiguous account, a duplicate-overlap candidate
 * and a statement-period defect need four different decisions, from four
 * different option sets, with four different re-reconciliation
 * consequences. There is no homogeneous subset large enough for a bulk
 * action to be worth the risk of getting it wrong, so PC5 ships none and
 * says so, rather than shipping a narrow one nobody can use and calling
 * K.17 satisfied.
 *
 * `acknowledge` is the one action that is uniform across every item — but
 * acknowledging in bulk is precisely the "seen it all, move on" gesture
 * K.13 warns must never be mistaken for resolution, and bulk-acknowledging
 * a document's exceptions changes nothing about whether it can be accepted.
 * A bulk control whose only effect is to make a blocked document LOOK
 * attended-to is worse than no control.
 *
 * The flag exists so this decision is visible to an operator rather than
 * invisible, and so a future pass that genuinely finds a safe homogeneous
 * set adds the gate here instead of minting another name.
 */
export function isPc5BulkResolutionEnabled(): boolean {
  return process.env.AIE_REVIEW_BULK_ACTIONS_ENABLED === 'true';
}
