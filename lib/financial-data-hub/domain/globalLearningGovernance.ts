/**
 * Financial Data Hub — the global-learning governance DOMAIN CONTRACT
 * (FDH-2 specification section 55-64, 83-93).
 *
 * SCOPE. This is the data-model/service-layer contract only — NOT the admin
 * review screen (FDH-13 builds that UI). It is deliberately a set of pure,
 * side-effect-free functions: nothing here calls Supabase, nothing here
 * writes fdh_global_learning_candidates, fdh_merchants or
 * fdh_classification_rules. FDH-2 wires up no HTTP route and no server
 * action that calls these functions — they exist so a future phase has a
 * validated contract rather than inventing one, exactly like
 * validation/masterData.ts already does for FDH-13's future write paths.
 *
 * THE WORKFLOW (specification section 55-64):
 *   user correction -> user-specific rule (fdh_user_classification_rules)
 *     -> potential global-learning candidate (evidence aggregated here)
 *     -> PII/personal-payee screening (personalPayeeGuard.ts)
 *     -> admin_review
 *     -> approve / reject / merge
 *     -> (only on approve/merge) a human-operated, separately-authorised
 *        admin action writes the verified fdh_merchants /
 *        fdh_classification_rules row.
 *
 * NO AUTOMATIC PROMOTION, EVER. No function in this module writes global
 * master data, and no function returns a value that, if merely passed to a
 * generic repository save function, would silently become a global row —
 * every transition function below returns a decision object the CALLER must
 * still act on through an explicit, separately-authorised admin write path.
 * `tests/unit/fdh2GlobalLearningGovernance.test.ts` asserts this module
 * exports no function whose name implies automatic promotion.
 */

import type {
  FdhGlobalLearningStatus,
  FdhPiiScreeningStatus,
} from '../constants/enums';

/** Aggregate-only evidence for one candidate. NEVER a raw transaction
 * narrative or any per-user identifier — counts and category identifiers
 * only (specification: "never expose one user's transaction descriptions to
 * another user or ordinary admin unnecessarily"). */
export interface GlobalLearningCandidateEvidence {
  candidateType: 'merchant_alias' | 'merchant_new' | 'classification_rule';
  countryCode: 'AU' | 'IN' | null;
  merchantId: string | null;
  currentCategoryId: string | null;
  proposedCategoryId: string | null;
  proposedSubcategoryId: string | null;
  numberOfIndependentUsers: number;
  numberOfCorrections: number;
  numberOfMatchingAliases: number;
  confidence: number | null;
}

/**
 * Builds the aggregate evidence record for a candidate. Deliberately typed
 * to make it IMPOSSIBLE to carry a raw narrative string or a user
 * identifier — there is no field for either. A caller with per-user
 * transaction text must aggregate it into these counts BEFORE calling this
 * function; this function cannot un-aggregate it back out.
 */
export function buildCandidateEvidence(input: {
  candidateType: GlobalLearningCandidateEvidence['candidateType'];
  countryCode?: 'AU' | 'IN' | null;
  merchantId?: string | null;
  currentCategoryId?: string | null;
  proposedCategoryId?: string | null;
  proposedSubcategoryId?: string | null;
  numberOfIndependentUsers: number;
  numberOfCorrections: number;
  numberOfMatchingAliases: number;
  confidence?: number | null;
}): GlobalLearningCandidateEvidence {
  if (input.numberOfIndependentUsers < 0 || input.numberOfCorrections < 0 || input.numberOfMatchingAliases < 0) {
    throw new Error('evidence counts must be non-negative');
  }
  return {
    candidateType: input.candidateType,
    countryCode: input.countryCode ?? null,
    merchantId: input.merchantId ?? null,
    currentCategoryId: input.currentCategoryId ?? null,
    proposedCategoryId: input.proposedCategoryId ?? null,
    proposedSubcategoryId: input.proposedSubcategoryId ?? null,
    numberOfIndependentUsers: input.numberOfIndependentUsers,
    numberOfCorrections: input.numberOfCorrections,
    numberOfMatchingAliases: input.numberOfMatchingAliases,
    confidence: input.confidence ?? null,
  };
}

export interface TransitionDecision {
  allowed: boolean;
  reason: string;
}

const TERMINAL_STATUSES: readonly FdhGlobalLearningStatus[] = ['approved', 'rejected', 'merged'];

/**
 * Validates a proposed governance-status transition. Pure decision logic —
 * the caller is solely responsible for actually writing the new status
 * (via the service-role client, behind an admin-only route that does not
 * exist in FDH-2).
 *
 * RULES (specification section 55-64):
 *   - `open` may only move to `admin_review`. It can NEVER jump straight to
 *     `approved`/`rejected`/`merged` — every candidate must pass through
 *     admin review.
 *   - `admin_review` may move to `approved`, `rejected` or `merged`.
 *   - `approved`/`merged` additionally REQUIRE `piiScreeningStatus ===
 *     'passed'` — this is the PII gate mirrored by the database constraint
 *     `chk_fdh_glc_pii_gate` in migration 0052, enforced here a second time
 *     so the domain layer can never even construct an invalid decision.
 *   - `approved`, `rejected` and `merged` are terminal: no further
 *     transition is ever allowed out of them.
 *   - A no-op "transition" to the same status is never allowed.
 */
export function decideGovernanceTransition(
  from: FdhGlobalLearningStatus,
  to: FdhGlobalLearningStatus,
  context: { piiScreeningStatus: FdhPiiScreeningStatus },
): TransitionDecision {
  if (from === to) {
    return { allowed: false, reason: 'no-op: from and to are the same status' };
  }
  if (TERMINAL_STATUSES.includes(from)) {
    return { allowed: false, reason: `${from} is a terminal status; no further transition is permitted` };
  }
  if (from === 'open') {
    return to === 'admin_review'
      ? { allowed: true, reason: 'open candidates must pass through admin_review before any decision' }
      : { allowed: false, reason: 'open may only move to admin_review — it can never be approved/rejected/merged directly' };
  }
  // from === 'admin_review'
  if (to === 'rejected') {
    return { allowed: true, reason: 'admin_review may always be rejected' };
  }
  if (to === 'approved' || to === 'merged') {
    return context.piiScreeningStatus === 'passed'
      ? { allowed: true, reason: `${to} permitted: PII screening has passed` }
      : { allowed: false, reason: `${to} blocked: PII screening status is "${context.piiScreeningStatus}", not "passed"` };
  }
  return { allowed: false, reason: `no rule permits admin_review -> ${to}` };
}

/**
 * Documents (does not implement) the boundary between a GLOBAL MERCHANT
 * (this module's subject — a shared, admin-approved fact usable by every
 * household) and a PRIVATE COUNTERPARTY (a personal payee scoped to one
 * user/household — e.g. "my landlord", "my flatmate"). FDH-2 builds no
 * private-counterparty feature; if product requirements introduce one later,
 * it belongs in a user-owned table (like fdh_user_classification_rules),
 * never in fdh_merchants. This constant exists purely so the boundary is a
 * real, importable, documented fact rather than prose alone.
 */
export const GLOBAL_MERCHANT_VS_PRIVATE_COUNTERPARTY_BOUNDARY = {
  globalMerchant: 'fdh_merchants — shared, admin-approved, usable by every household',
  privateCounterparty: 'NOT IMPLEMENTED in any FDH phase through FDH-2. If ever built, must be user/household-scoped (RLS owner-only), never promoted into fdh_merchants automatically.',
} as const;
