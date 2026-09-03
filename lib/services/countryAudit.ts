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
  /**
   * G3: the experience level the SERVER derived from the registry at the
   * moment of confirmation. Recorded so the audit trail answers "what was
   * this user actually told they were getting?" without having to re-derive
   * it later from a registry that may since have changed.
   */
  experienceLevel?: 'FULL' | 'GENERIC' | 'UNAVAILABLE' | null;
  /**
   * G3 section 7.2: the exact coverage-disclosure version acknowledged, for a
   * GENERIC country. Null for FULL countries (no acknowledgement applies).
   * This is the audit-trail half of the requirement; the durable half is
   * user_profiles.generic_disclosure_version (migration 0127).
   */
  disclosureVersion?: string | null;
}

/**
 * G3 section 8.4 — "Be auditable where existing architecture supports profile
 * -setting audit." Reporting currency is a controlled user setting, so a
 * change to it is recorded on the same `audit_events` table, through the same
 * service-role client, with the same never-break-the-primary-operation
 * discipline as the country events above.
 *
 * Deliberately a SEPARATE function with a SEPARATE entity value
 * ('user_profiles.preferred_currency'). Folding a currency change into
 * recordCountryAuditEvent() would have put currency and country changes in
 * one indistinguishable stream — the precise conflation G3 spends most of its
 * effort keeping apart. An auditor reading this table can tell, without
 * interpretation, that a currency change is not a country change.
 */
export async function recordReportingCurrencyAuditEvent(event: {
  userId: string;
  previousCurrency: string | null;
  newCurrency: string | null;
  actor: 'self' | 'admin';
  actorId?: string | null;
}): Promise<void> {
  try {
    const admin = createAdminClient();
    const { error } = await admin.from('audit_events').insert({
      user_id: event.userId,
      event_type: 'reporting_currency_changed',
      entity: 'user_profiles.preferred_currency',
      entity_id: event.userId,
      metadata: {
        previous_currency: event.previousCurrency,
        new_currency: event.newCurrency,
        actor: event.actor,
        actor_id: event.actorId ?? null,
        // Stated explicitly in the record itself so the audit trail carries
        // the guarantee, not just the code that produced it.
        country_unchanged: true,
      },
    });
    if (error) {
      console.error(`audit_events insert failed for event_type=reporting_currency_changed: ${error.message}`);
    }
  } catch (err) {
    console.error('recordReportingCurrencyAuditEvent failed:', err instanceof Error ? err.message : err);
  }
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
        experience_level: event.experienceLevel ?? null,
        disclosure_version: event.disclosureVersion ?? null,
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
