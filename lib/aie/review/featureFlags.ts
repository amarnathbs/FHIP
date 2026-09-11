/**
 * AIE-1.5 — review-layer feature flags (AIE15-ENTRY-10: "create feature
 * flags for summary, review, evidence reveal, bulk actions, PC5 projection
 * and canonical acceptance"). Same convention as every other AIE flag in
 * this codebase (`lib/aie/featureFlags.ts`,
 * `lib/aie/adapters/insurance/featureFlags.ts`): an env var must equal the
 * literal string 'true'; anything else leaves the gate OFF. All default
 * OFF — this phase grants no production authority (section 4 / P9).
 */

/** Whether the review inbox/detail READ routes are reachable at all. */
export function isAieReviewUiEnabled(): boolean {
  return process.env.AIE_REVIEW_UI_ENABLED === 'true';
}

/** EVID-06: "require deliberate reveal" — a SEPARATE gate from the read
 * routes above, since reveal is a materially higher-risk action than
 * viewing a masked summary. */
export function isAieEvidenceRevealEnabled(): boolean {
  return process.env.AIE_REVIEW_EVIDENCE_REVEAL_ENABLED === 'true';
}

/** BULK-01..12 — bulk review actions are NOT implemented this pass (see
 * AIE_1_5_IMPLEMENTATION.md's deferred-work section). This flag exists per
 * ENTRY-10's explicit instruction and is checked by nothing yet — reserved
 * so a future pass adds the real gate here rather than inventing a new
 * name. Always OFF; there is no code path that could turn it on today. */
export function isAieBulkReviewActionsEnabled(): boolean {
  return process.env.AIE_REVIEW_BULK_ACTIONS_ENABLED === 'true';
}

/** PC5-01..12 — a governed AIE query/view for PC5 is NOT built this pass
 * (see AIE_1_5_IMPLEMENTATION.md). Reserved flag, same reasoning as bulk
 * actions above. */
export function isAiePc5ProjectionEnabled(): boolean {
  return process.env.AIE_REVIEW_PC5_PROJECTION_ENABLED === 'true';
}

/** The final canonical-acceptance gate at the REVIEW layer — checked
 * FIRST, before any of `acceptRun`'s own database-derived gates, so
 * acceptance can be switched off independently of read access to the
 * review UI (matching the layered on/off convention every other AIE
 * kill switch in this codebase already uses: intake enabled, AI fallback
 * enabled, and now review-acceptance enabled, are three independently
 * toggleable gates rather than one all-or-nothing flag). This is ADDITIVE
 * to (never a replacement for) the underlying adapter's own canonical
 * write flag (e.g. `AIE_INSURANCE_ADAPTER_CANONICAL_WRITE_ENABLED`) — both
 * must be 'true' for a real write to happen.
 */
export function isAieCanonicalAcceptanceEnabled(): boolean {
  return process.env.AIE_REVIEW_CANONICAL_ACCEPTANCE_ENABLED === 'true';
}
