// Country-confirmation audit trail — reuses the EXISTING audit_events table
// (0001_foundation.sql) rather than introducing a new one, per spec section
// 4's "existing audit-event infrastructure" instruction. audit_events has
// only an owner-read RLS policy (no authenticated-insert policy), matching
// the established precedent in
// the Financial Data Hub module's own document-audit-event helper (fdh_document_audit_events) —
// every insert here goes through the service-role client.
import { createAdminClient } from '@/lib/supabase/admin';

export type CountryAuditEventType =
  | 'country_confirmed'
  | 'country_change_pending_reconfirmation'
  | 'country_admin_corrected';

export interface CountryAuditEvent {
  userId: string;
  eventType: CountryAuditEventType;
  previousCountry: string | null;
  newCountry: string | null;
  actor: 'self' | 'admin';
  actorId?: string | null;
}

export async function recordCountryAuditEvent(event: CountryAuditEvent): Promise<void> {
  try {
    const admin = createAdminClient();
    const { error } = await admin.from('audit_events').insert({
      user_id: event.userId,
      event_type: event.eventType,
      entity: 'user_profiles.country_of_residence',
      entity_id: event.userId,
      metadata: {
        previous_country: event.previousCountry,
        new_country: event.newCountry,
        actor: event.actor,
        actor_id: event.actorId ?? null,
      },
    });
    // Audit logging must never take down the primary operation it describes
    // (a successful confirmation must not fail because the audit insert had
    // a transient error) but must not be silently invisible either — same
    // discipline as the Financial Data Hub module's own document-audit-event helper.
    if (error) {
      console.error(`audit_events insert failed for event_type=${event.eventType}: ${error.message}`);
    }
  } catch (err) {
    console.error('recordCountryAuditEvent failed:', err instanceof Error ? err.message : err);
  }
}
