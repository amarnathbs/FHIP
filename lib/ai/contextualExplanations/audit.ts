// Module 11.5 — contextual explanation audit/analytics writer (spec sections
// 60-62, 102-103).
//
// Reuses the EXISTING `ai_resolution_audit` table (Module 11.2, migration
// 0117; extended additively by 11.4's 0124 and 11.5's 0126) rather than
// creating a parallel audit store (spec section 102: "Reuse existing
// resolution audit. Add contextual metadata if needed").
//
// That table's own CHECK constraints already make it structurally impossible
// for any row written here to claim a provider call or quota consumption:
//   chk_ai_resolution_audit_no_provider_calls  (provider_called = false)
//   chk_ai_resolution_audit_zero_cost_no_quota (zero-cost => quota_consumed=false)
// Spec section 103 requires those be PRESERVED, not relaxed — migration 0126
// leaves both untouched and this writer inherits them for free.
//
// PRIVACY (spec section 102: "Do not log unnecessary financial values"). This
// writer records the target code, module, availability, answer origins and
// the data-as-of date. It never records a financial figure, never records
// answer prose, and records an owned entity id ONLY as a salted-free SHA-256
// hash prefix — enough to prove two requests addressed the same entity
// without persisting which goal or report a user asked about.
//
// Best-effort, same convention as lib/ai/resolution/audit.ts and
// lib/ai/standardQuestions/audit.ts: a failed audit write must never fail or
// alter an already-produced answer.

import { createHash } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import type { AnswerOrigin } from '@/lib/ai/standardQuestions/types';
import type { ContextualAvailability, ContextualModule } from '@/lib/ai/contextualExplanations/types';

/** Spec section 102 — "target_entity_id or safe hash/reference". This is the safe hash. */
export function hashTargetEntityId(entityId: string): string {
  return createHash('sha256').update(entityId).digest('hex').slice(0, 32);
}

export interface RecordContextualAuditInput {
  userId: string;
  householdId: string | null;
  targetCode: string;
  moduleCode: ContextualModule;
  intentCode: string;
  standardQuestionCode: string | null;
  targetEntityId: string | null;
  historicalContext: boolean;
  status: ContextualAvailability;
  answerOrigins: AnswerOrigin[];
  dataAsOf?: string | null;
  latencyMs?: number | null;
}

export async function recordContextualExplanationAudit(input: RecordContextualAuditInput): Promise<void> {
  try {
    const admin = createAdminClient();
    await admin.from('ai_resolution_audit').insert({
      user_id: input.userId,
      household_id: input.householdId,
      request_id: `ctx:${input.targetCode}:${Date.now()}`,
      intent_code: null,
      resolution_type: mapAvailabilityToResolutionType(input.status),
      completeness: input.status === 'AVAILABLE' ? 'FULLY_RESOLVED' : 'UNRESOLVED',
      premium_required: true,
      premium_satisfied: input.status !== 'PREMIUM_REQUIRED',
      // Hard-coded false, twice-guaranteed by the table's own CHECKs. Module
      // 11.5 has no code path that could set either of these true.
      provider_called: false,
      quota_consumed: false,
      source_reference_ids: [],
      standard_question_code: input.standardQuestionCode,
      standard_question_version: null,
      answer_origins: input.answerOrigins,
      // Module 11.5 columns (migration 0126).
      contextual_target_code: input.targetCode,
      contextual_module_code: input.moduleCode,
      contextual_intent_code: input.intentCode,
      contextual_target_entity_hash: input.targetEntityId ? hashTargetEntityId(input.targetEntityId) : null,
      contextual_historical_context: input.historicalContext,
      contextual_data_as_of: input.dataAsOf ?? null,
      latency_ms: input.latencyMs ?? null,
    });
  } catch {
    // Audit failure must never fail or alter the already-produced answer.
  }
}

// `ai_resolution_audit.resolution_type` has a fixed CHECK vocabulary
// (migration 0117). A contextual-only availability is mapped onto the closest
// existing value rather than widening that constraint, keeping migration 0126
// additive-only (spec section 103).
function mapAvailabilityToResolutionType(status: ContextualAvailability): string {
  switch (status) {
    case 'AVAILABLE':
      return 'DETERMINISTIC';
    case 'PREMIUM_REQUIRED':
      return 'BLOCKED';
    case 'FEATURE_DISABLED':
      return 'UNSUPPORTED';
    case 'INSUFFICIENT_DATA':
    case 'DOMAIN_UNAVAILABLE':
    case 'STALE':
    case 'NOT_APPLICABLE':
    case 'INSIGHT_PREPARING':
    case 'HISTORICAL_EXPLANATION_UNAVAILABLE':
    case 'TARGET_REQUIRED':
    case 'TARGET_NOT_FOUND':
    default:
      return 'UNAVAILABLE';
  }
}
