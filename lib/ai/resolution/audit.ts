// Module 11.2 — resolution audit event writer (spec section 60).
//
// Best-effort, append-only, never blocks or fails the request whose
// answer was already produced (same convention as
// lib/ai/cache/answerCache.ts's storeCachedAnswer()). Deliberately stores a
// HASH of the normalised question, never the raw text (spec section 60:
// "do not unnecessarily store full user free-text questions if privacy
// policy can instead store a normalised hash/intent").

import { createHash } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import type { ResolutionResult } from '@/lib/ai/resolution/types';
import { getIntentDefinition } from '@/lib/ai/resolution/intentTaxonomy';

export function hashNormalisedQuestion(normalisedText: string): string {
  return createHash('sha256').update(normalisedText).digest('hex');
}

export interface RecordResolutionAuditInput {
  userId: string;
  householdId: string | null;
  normalisedQuestionHash: string | null;
  result: ResolutionResult;
}

export async function recordResolutionAudit(input: RecordResolutionAuditInput): Promise<void> {
  try {
    const admin = createAdminClient();
    const def = input.result.intent_code ? getIntentDefinition(input.result.intent_code) : null;
    await admin.from('ai_resolution_audit').insert({
      user_id: input.userId,
      household_id: input.householdId,
      request_id: input.result.request_id,
      intent_code: input.result.intent_code,
      intent_version: def?.intent_version ?? null,
      intent_family: def?.intent_family ?? null,
      normalised_question_hash: input.normalisedQuestionHash,
      resolution_type: input.result.resolution,
      completeness: input.result.completeness,
      certification_status: input.result.certification_status,
      premium_required: input.result.premium_required,
      premium_satisfied: input.result.premium_satisfied,
      provider_called: false,
      // Always false in Module 11.2: no admission RPC is ever called by the
      // router (spec section 53) — even a LIVE_AI_REQUIRED result records
      // that a future admission WOULD be required, not that one occurred.
      quota_consumed: false,
      source_reference_ids: input.result.source_refs.map((r) => r.source_id),
      template_version: input.result.response?.template_version ?? null,
      latency_ms: input.result.latency_ms,
    });
  } catch {
    // Audit failure must never fail or alter the already-produced answer.
  }
}
