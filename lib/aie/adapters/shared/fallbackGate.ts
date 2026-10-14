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
 *   2b. the REAL malware scan must be switched on for the deployment
 *      (`isAiEgressMalwarePreconditionMet`), so AI egress never rests on the
 *      scan-off structural-validation-only mode;
 *   3. PREMIUM ENTITLEMENT (`resolvePremiumAiAccess`) -- since 14-10-2026 the
 *      only "who" check. It replaced the two-e-mail AIE pilot allowlist: any
 *      signed-in user with an ACTIVE Premium entitlement may have a document
 *      read by the AI fallback, a Free / expired / unreadable entitlement may
 *      not, and a former pilot e-mail changes nothing either way. It is
 *      evaluated here, at the moment a NEW chargeable operation is about to
 *      start, so queued or replayed work re-checks it rather than relying on
 *      what was true at upload time. One shared check for every document type;
 *      no per-adapter clone;
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

import { isAieAiFallbackEnabled } from '@/lib/aie/featureFlags';
import { isAiEgressMalwarePreconditionMet } from '@/lib/aie/malware/aiEgressPrecondition';
import { resolvePremiumAiAccess, type PremiumAiAccessDeps } from '@/lib/ai/access/premiumAiAccess';
import { maskText, isBelowMaskingPolicy } from '@/lib/aie/masking/piiMasking';

export type AieFallbackGateRefusalReason =
  | 'adapter_disabled'
  | 'global_kill_switch_disabled'
  | 'malware_scan_not_enforced'
  | 'premium_required'
  | 'entitlement_unavailable'
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
export async function evaluateAiFallbackGate(params: {
  /** The AUTHENTICATED session user's id -- never a caller-supplied value. */
  userId: string;
  adapterEnabled: boolean;
  extractedText: string;
  /** Test seam for the entitlement read; production never sets it. */
  entitlementDeps?: PremiumAiAccessDeps;
}): Promise<AieFallbackGateResult> {
  if (!params.adapterEnabled) return { ok: false, reason: 'adapter_disabled' };
  if (!isAieAiFallbackEnabled()) return { ok: false, reason: 'global_kill_switch_disabled' };
  // Document content leaves this process only where the REAL malware scan is on (see aiEgressPrecondition.ts).
  if (!isAiEgressMalwarePreconditionMet()) return { ok: false, reason: 'malware_scan_not_enforced' };
  const access = await resolvePremiumAiAccess(params.userId, 'aie_document_fallback', params.entitlementDeps);
  if (!access.allowed) return { ok: false, reason: access.reason };

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
