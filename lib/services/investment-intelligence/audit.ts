import { createAdminClient } from '@/lib/supabase/admin';
import type { IiActorType, IiAuditEventTypeR9 } from './types';

// R0_AUDIT_REQUIREMENTS.md section 3: ii_audit_events has NO insert policy
// for the authenticated role at all — every insert happens through the
// service-role client from trusted server-side code, mirroring how
// adminRoute() wraps admin handlers today (R1_IMPLEMENTATION_SPEC.md
// section 6). This is the single call site every Investment Intelligence
// mutation should go through so the audit trail can never be forgotten by
// a future call site copy-pasting an insert.
export interface AuditEventInput {
  userId: string | null;
  eventType: IiAuditEventTypeR9;
  subjectType: string;
  subjectId?: string | null;
  actorType: IiActorType;
  actorId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function emitAuditEvent(input: AuditEventInput): Promise<{ error: string | null }> {
  const admin = createAdminClient();
  const { error } = await admin.from('ii_audit_events').insert({
    user_id: input.userId,
    event_type: input.eventType,
    subject_type: input.subjectType,
    subject_id: input.subjectId ?? null,
    actor_type: input.actorType,
    actor_id: input.actorId ?? null,
    // Metadata must never carry raw document contents, full PAN, full
    // account/folio numbers, tokens or secrets (spec section 32) — callers
    // are responsible for passing already-masked/safe values; this helper
    // does not attempt to scrub content it doesn't understand, so every
    // call site is reviewed against that rule explicitly (see
    // R1_RLS_SECURITY_REPORT.md's privacy/logging section).
    metadata: input.metadata ?? null,
  });
  return { error: error?.message ?? null };
}
