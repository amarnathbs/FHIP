// Module 11.4 — standard-question audit/analytics writer (spec sections
// 53-61). Reuses the EXISTING `ai_resolution_audit` table (Module 11.2)
// rather than creating a parallel audit store (spec section 61) — migration
// 0124 adds three nullable columns to it (`standard_question_code`,
// `standard_question_version`, `answer_origins`), all additive.
//
// That table's own CHECK constraints (migration 0117) already make it
// structurally impossible for ANY row here to claim a provider call
// (`provider_called` is hard-coded false below and the table's own
// `chk_ai_resolution_audit_no_provider_calls` CHECK enforces it a second
// time at the database layer) — this file inherits that guarantee for free
// rather than re-implementing it.
//
// Best-effort, same convention as lib/ai/resolution/audit.ts: a failed audit
// write must never fail or alter an already-produced answer.

import { createAdminClient } from '@/lib/supabase/admin';
import type { AnswerOrigin } from '@/lib/ai/standardQuestions/types';

export interface RecordStandardQuestionAuditInput {
  userId: string;
  householdId: string | null;
  questionCode: string;
  questionVersion: number | null;
  status: string;
  answerOrigins: AnswerOrigin[];
  dataAsOf?: string | null;
}

export async function recordStandardQuestionAudit(input: RecordStandardQuestionAuditInput): Promise<void> {
  try {
    const admin = createAdminClient();
    await admin.from('ai_resolution_audit').insert({
      user_id: input.userId,
      household_id: input.householdId,
      request_id: `sq:${input.questionCode}:${Date.now()}`,
      intent_code: null,
      resolution_type: mapStatusToResolutionType(input.status),
      completeness: input.status === 'AVAILABLE' ? 'FULLY_RESOLVED' : 'UNRESOLVED',
      premium_required: true,
      premium_satisfied: input.status !== 'PREMIUM_REQUIRED',
      provider_called: false,
      quota_consumed: false,
      source_reference_ids: [],
      standard_question_code: input.questionCode,
      standard_question_version: input.questionVersion,
      answer_origins: input.answerOrigins,
    });
  } catch {
    // Audit failure must never fail or alter the already-produced answer.
  }
}

// `ai_resolution_audit.resolution_type` has a fixed CHECK vocabulary
// (migration 0117) — a standard-question-only status (e.g. PACK_NOT_READY)
// is mapped onto the closest existing value rather than widening that
// constraint, keeping this migration additive-only.
function mapStatusToResolutionType(status: string): string {
  switch (status) {
    case 'AVAILABLE':
      return 'DETERMINISTIC';
    case 'PACK_NOT_READY':
    case 'INSUFFICIENT_DATA':
    case 'STALE':
      return 'UNAVAILABLE';
    case 'PREMIUM_REQUIRED':
      return 'BLOCKED';
    case 'FEATURE_DISABLED':
      return 'UNSUPPORTED';
    case 'NOT_APPLICABLE':
    case 'DOMAIN_UNAVAILABLE':
    case 'COUNTRY_NOT_APPLICABLE':
    case 'DEFERRED_CAPABILITY':
    case 'TARGET_REQUIRED':
    case 'TARGET_NOT_FOUND':
    default:
      return 'UNAVAILABLE';
  }
}
