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
  | 'run_failed'
  // AIE-1.5 additions — additive only, no existing event type's meaning
  // changes. 'evidence_revealed' carries a mask TOKEN in metadata, never a
  // plaintext value (P10) — see lib/aie/review/reveal.ts.
  | 'evidence_revealed'
  // M3 (Phase 4) — the Product Owner's one-way-HMAC decision removed the
  // reveal capability entirely. 'evidence_revealed' can no longer be
  // emitted by any code path and is kept only so an existing historical row
  // still has a name; every reveal request now records this refusal
  // instead. Metadata carries the opaque token and whether it was a one-way
  // pseudonym — never a value, because none is recoverable.
  | 'evidence_reveal_refused_one_way_masking'
  // M3 (Phase 4) — the fixed, lifecycle-independent mask-token-map TTL. A
  // time-driven retention event with no subject: metadata carries the row
  // COUNT and the policy identity, never an intake, run or user.
  | 'mask_token_map_ttl_purged'
  // M3 (Phase 4) — one PDF password attempt occurred for this intake.
  // Recorded on EVERY attempt, right or wrong, BEFORE the decrypt is tried,
  // which is what makes rate limiting possible. Carries no metadata about
  // the password whatsoever — per FDH-5's own established distinction, "an
  // audit event recording that an attempt occurred is not the password".
  | 'aie_pdf_password_attempt'
  // M3 (Phase 4) — a further password attempt was refused because the
  // per-document hourly bound was already reached.
  | 'aie_pdf_password_rate_limited'
  // AIE-1 closure mission additions (section 4/9 — temporary document
  // lifecycle). `event_type` has no DB CHECK constraint (confirmed:
  // migration 0140 declares it plain `text not null`), so these new values
  // need no migration of their own. Mirrors FDH's own purge event naming
  // (`document_purge_scheduled`/`document_purged`/`document_purge_failed`)
  // for a reader who already knows that vocabulary; `document_deleted_
  // immediate` is AIE-specific — it fires on the PRIMARY deletion path
  // (right after a pipeline run concludes), distinct from the scheduled
  // sweep's backstop path.
  | 'document_deleted_immediate'
  | 'document_purge_scheduled'
  | 'document_purged'
  | 'document_purge_failed'
  // AIE-1 closure mission (section 8) — atomic cost admission refused the
  // reservation; the provider was never called, same category as the
  // existing kill_switch/PII blocks above.
  | 'ai_fallback_budget_exhausted';

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
