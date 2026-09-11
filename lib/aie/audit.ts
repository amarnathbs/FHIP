/**
 * AIE-1.1 — audit trail (OBS-01..12). Mirrors
 * `lib/financial-data-hub/services/auditLog.ts`'s discipline exactly: only
 * the service-role client writes here, `metadata` is a closed, structured
 * object that must never carry document content, prompts, provider output,
 * or PII (P10), and a failed audit write never takes down the primary
 * operation it describes.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import type { AieActorType } from './types';

export type AieAuditEventType =
  | 'intake_created'
  | 'intake_rejected_admission'
  | 'intake_quarantined'
  | 'run_started'
  | 'run_transition'
  | 'parser_attempt_recorded'
  | 'masking_completed'
  | 'masking_below_policy'
  | 'ai_fallback_kill_switch_blocked'
  | 'ai_fallback_unmasked_pii_blocked'
  | 'ai_completion_attempt'
  | 'schema_validation_result'
  | 'reconciliation_run_recorded'
  | 'unresolved_item_created'
  | 'review_decision_recorded'
  | 'run_completed'
  | 'run_failed';

export async function recordAieAuditEvent(event: {
  intakeId: string | null;
  runId: string | null;
  userId: string | null;
  eventType: AieAuditEventType;
  actorType: AieActorType;
  actorId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from('aie_audit_event').insert({
    intake_id: event.intakeId,
    run_id: event.runId,
    user_id: event.userId,
    event_type: event.eventType,
    actor_type: event.actorType,
    actor_id: event.actorId ?? null,
    metadata: event.metadata ?? null,
  });
  if (error) {
    console.error(`aie_audit_event insert failed for event_type=${event.eventType}: ${error.message}`);
  }
}
