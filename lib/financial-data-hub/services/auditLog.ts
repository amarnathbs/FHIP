/**
 * Financial Data Hub — FDH-3 document-lifecycle audit trail.
 *
 * `fdh_document_audit_events` (migration 0058) has an owner-read RLS policy
 * and NO insert policy for the authenticated role at all — every insert here
 * goes through the service-role client, identical precedent to
 * `ii_audit_events` (0036). This is the SECOND (and last) file in this
 * module allowed to use the service-role client — see
 * `repositories/base.ts` and `services/storage.ts` for the same discipline.
 *
 * `metadata` must never carry document content, a signed URL, a password, a
 * raw filename or a stack trace (spec sections 53-54) — every call site in
 * this module passes only controlled, structured fields.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import type { FdhDocumentAuditActorType, FdhDocumentAuditEventType } from '../constants/enums';

export async function recordDocumentAuditEvent(event: {
  userId: string | null;
  documentId: string | null;
  eventType: FdhDocumentAuditEventType;
  actorType: FdhDocumentAuditActorType;
  actorId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from('fdh_document_audit_events').insert({
    user_id: event.userId,
    document_id: event.documentId,
    event_type: event.eventType,
    actor_type: event.actorType,
    actor_id: event.actorId ?? null,
    metadata: event.metadata ?? null,
  });
  // Audit logging must never be allowed to take down the primary operation
  // it is describing (e.g. a successful upload must not fail the request
  // because the audit insert had a transient error) — but it must not be
  // silently invisible either.
  if (error) {
    console.error(`fdh_document_audit_events insert failed for event_type=${event.eventType}: ${error.message}`);
  }
}
