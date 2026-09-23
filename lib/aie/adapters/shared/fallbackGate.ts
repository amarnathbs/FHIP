/**
 * AIE document-fallback adapters — SHARED pre-egress gate.
 *
 * Everything that must be true before one byte of a user's document may leave
 * this process, in the order it must be checked, in one place that four
 * native processing services call.
 *
 * THE ORDER IS LOAD-BEARING AND IS COPIED FROM THE PROVEN PAYSLIP CALL SITE
 * (`payslipProcessingService.ts`'s `attemptAiPayslipFallback`):
 *
 *   1. the ADAPTER's own kill switch — the cheapest check, and the one an
 *      operator flips per document type;
 *   2. the SHARED global `AIE_AI_FALLBACK_ENABLED` kill switch every AI call
 *      in this codebase already shares — so one switch still stops
 *      everything, for every type, at once;
 *   3. the SHARED AIE-1 pilot-cohort allowlist
 *      (`isAiePilotCohortEnforced`/`isUserInAiePilotCohort`), NOT a
 *      per-adapter clone. The design document is explicit that cloning the
 *      cohort — which the Investment Intelligence mechanism did — must not be
 *      repeated: one allowlist and one operator surface for every document
 *      type is a first-class part of "the same path", not just the AI-calling
 *      mechanics;
 *   4. MASKING, which fails CLOSED. `maskText` throws when
 *      `AIE_MASK_TOKEN_ENCRYPTION_KEY` is unset, and that throw is caught
 *      here and converted into a refusal — never into an unmasked call.
 *
 * Checking the flags BEFORE masking is not merely an optimisation: masking
 * derives per-tenant tokens from a secret, and a disabled adapter should not
 * be exercising that path at all.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not record audit events. The
 * four callers each have their own `fdh_document_audit_events` vocabulary
 * (`<type>_ai_fallback_*`), constrained by a DB CHECK constraint, so the
 * event names cannot be centralised without inventing a fifth vocabulary. The
 * caller records; this returns a typed reason for it to record.
 */

import { isAieAiFallbackEnabled, isUserInAiePilotCohort } from '@/lib/aie/featureFlags';
import { maskText, isBelowMaskingPolicy } from '@/lib/aie/masking/piiMasking';

export type AieFallbackGateRefusalReason =
  | 'adapter_disabled'
  | 'global_kill_switch_disabled'
  | 'cohort_denied'
  | 'no_extracted_text'
  | 'masking_unavailable'
  | 'masking_below_policy';

export type AieFallbackGateResult =
  | { ok: true; maskedText: string; coverageByType: Record<string, number>; totalMatches: number }
  | { ok: false; reason: AieFallbackGateRefusalReason };

/** Below this, there is not enough text for an extraction to be anything but
 * a guess, and calling the provider is pure spend. Chosen to be permissive —
 * the point is to refuse an empty or near-empty page, not to second-guess a
 * short statement. */
const MIN_EXTRACTED_TEXT_CHARS = 40;

/**
 * Evaluates every gate and, if they all pass, returns the MASKED text — the
 * only form of the document any caller of this function is ever handed. A
 * caller cannot accidentally send the raw text to the provider, because a
 * successful result does not contain it.
 */
export function evaluateAiFallbackGate(params: { userId: string; adapterEnabled: boolean; extractedText: string }): AieFallbackGateResult {
  if (!params.adapterEnabled) return { ok: false, reason: 'adapter_disabled' };
  if (!isAieAiFallbackEnabled()) return { ok: false, reason: 'global_kill_switch_disabled' };
  if (!isUserInAiePilotCohort({ userId: params.userId })) return { ok: false, reason: 'cohort_denied' };

  if (params.extractedText.trim().length < MIN_EXTRACTED_TEXT_CHARS) {
    return { ok: false, reason: 'no_extracted_text' };
  }

  let masking: ReturnType<typeof maskText>;
  try {
    masking = maskText(params.extractedText, { tenantKey: params.userId });
  } catch {
    // FAIL CLOSED. `maskText` throws when the masking key is unset. The only
    // correct response is to not make the call — never to fall back to
    // sending the raw text, and never to swallow this into a generic
    // "provider error" that would read as a transient fault.
    return { ok: false, reason: 'masking_unavailable' };
  }

  // Carries forward the payslip call site's own disclosed open item: this
  // check is invoked with `labelsSeenRaw: []` because no caller in this
  // codebase tracks the raw labels seen, so in practice it is currently a
  // no-op. It is kept, and kept in the same position, so that when
  // `labelsSeenRaw` is one day populated every adapter inherits the
  // protection at once rather than three of five being retrofitted.
  if (isBelowMaskingPolicy({ maskedText: masking.maskedText, labelsSeenRaw: [] })) {
    return { ok: false, reason: 'masking_below_policy' };
  }

  return {
    ok: true,
    maskedText: masking.maskedText,
    coverageByType: masking.coverageByType as unknown as Record<string, number>,
    totalMatches: masking.totalMatches,
  };
}
