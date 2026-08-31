// Module 11.1 — test doubles for the AIModelGateway entitlement seam.
//
// The gateway's entitlement gate defaults to the REAL DB-backed one, so a
// test that wants to exercise provider/schema behaviour without enforcement
// must say so explicitly. That is deliberate: a bypass is always visible at
// the construction site, and no test can accidentally pass because
// enforcement silently defaulted to off.

import type {
  AdmissionRequest,
  AdmissionResult,
  AdmissionDenyReason,
  EntitlementGate,
} from '@/lib/ai/entitlement/types';

export interface RecordingGate extends EntitlementGate {
  admissions: AdmissionRequest[];
  refunds: string[];
  /** Spec section 14 — records which admissions the gateway closed as successful. */
  finalisations: string[];
}

function baseAllowed(admissionId: string, quotaConsumed: boolean): AdmissionResult {
  return {
    allowed: true,
    denyReason: null,
    admissionId,
    billingPeriod: '2026-08',
    planTier: 'premium',
    quotaConsumed,
    quotaAllowance: 10,
    quotaUsed: 1,
    quotaRemaining: 9,
    rateLimitUsed: 0,
    rateLimitMax: 12,
    rateLimitWindowSeconds: 3600,
    userCostUsedUsd: 0,
    userCostCeilingUsd: 5,
    platformCostUsedUsd: 0,
    platformCostCeilingUsd: 500,
    estimatedCostUsd: 0,
    usageOutcome: 'LIVE_AI',
    executionState: 'reserved',
    idempotencyReuse: false,
    concurrencyActive: 0,
    concurrencyMax: 1,
    softThresholdsCrossed: [],
    enforcementError: null,
  };
}

function recorders() {
  return { admissions: [] as AdmissionRequest[], refunds: [] as string[], finalisations: [] as string[] };
}

/** Allows everything and records what it was asked. Used where the test is about provider/schema behaviour, not entitlement. */
export function allowAllGate(quotaConsumed = true): RecordingGate {
  const gate: RecordingGate = {
    ...recorders(),
    async admit(request: AdmissionRequest): Promise<AdmissionResult> {
      gate.admissions.push(request);
      return baseAllowed('admission-stub-id', quotaConsumed);
    },
    async refund(admissionId: string): Promise<boolean> {
      gate.refunds.push(admissionId);
      return true;
    },
    async finalise(admissionId: string): Promise<boolean> {
      gate.finalisations.push(admissionId);
      return true;
    },
  };
  return gate;
}

/**
 * Spec section 15 — a gate that replays an earlier verdict. The gateway must
 * treat a replayed allow as "do NOT execute again", so this double exists to
 * prove that rather than to assume it.
 */
export function idempotencyReplayGate(): RecordingGate {
  const gate: RecordingGate = {
    ...recorders(),
    async admit(request: AdmissionRequest): Promise<AdmissionResult> {
      gate.admissions.push(request);
      return { ...baseAllowed('admission-stub-id', true), idempotencyReuse: true, executionState: 'finalised' };
    },
    async refund(admissionId: string): Promise<boolean> {
      gate.refunds.push(admissionId);
      return true;
    },
    async finalise(admissionId: string): Promise<boolean> {
      gate.finalisations.push(admissionId);
      return true;
    },
  };
  return gate;
}

/** Denies everything with a specific reason. */
export function denyGate(reason: AdmissionDenyReason): RecordingGate {
  const gate: RecordingGate = {
    ...recorders(),
    async admit(request: AdmissionRequest): Promise<AdmissionResult> {
      gate.admissions.push(request);
      return {
        allowed: false,
        denyReason: reason,
        admissionId: null,
        billingPeriod: null,
        planTier: null,
        quotaConsumed: false,
        quotaAllowance: null,
        quotaUsed: null,
        quotaRemaining: null,
        rateLimitUsed: null,
        rateLimitMax: null,
        rateLimitWindowSeconds: null,
        userCostUsedUsd: null,
        userCostCeilingUsd: null,
        platformCostUsedUsd: null,
        platformCostCeilingUsd: null,
        estimatedCostUsd: null,
        usageOutcome: null,
        executionState: null,
        idempotencyReuse: false,
        concurrencyActive: null,
        concurrencyMax: null,
        softThresholdsCrossed: [],
        enforcementError: null,
      };
    },
    async refund(admissionId: string): Promise<boolean> {
      gate.refunds.push(admissionId);
      return true;
    },
    async finalise(admissionId: string): Promise<boolean> {
      gate.finalisations.push(admissionId);
      return true;
    },
  };
  return gate;
}
