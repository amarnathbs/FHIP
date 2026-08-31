// Module 11.1 — writing operational events from application code (spec section 38).
//
// Most operational events are written by ai_admit_request() itself, inside the
// admission transaction, because that is where the fact occurs and where it
// cannot be forgotten. This module covers the events that have NO request
// behind them and therefore cannot be written there:
//
//   * a kill switch being activated by an admin, and
//   * an unsafe configuration being rejected before it was ever written.
//
// Both are best-effort: failing to record an operational event must never turn
// a successful (or a correctly-refused) admin action into an error. The
// authoritative record of the change itself is ai_config_audit, written by a
// database trigger that no application path can skip.

import { createAdminClient } from '@/lib/supabase/admin';

type Severity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

async function record(
  eventType: string,
  severity: Severity,
  detail: string,
  metadata: Record<string, unknown>
): Promise<void> {
  try {
    const admin = createAdminClient();
    await admin.from('ai_operational_events').insert({
      event_type: eventType,
      severity,
      detail,
      metadata,
    });
  } catch {
    // Deliberately swallowed — see the module comment.
  }
}

/**
 * Spec section 38 — "kill switch activated". Severity HIGH: someone stopping
 * AI platform-wide is an incident, not routine configuration.
 *
 * `actorId` is recorded in the metadata rather than in `user_id`, which on
 * this table means "the subject the event is about". An admin flipping a
 * switch is not the subject of a platform-wide stop, and filing them as one
 * would make the per-subject event view misleading.
 */
export async function recordKillSwitchActivation(
  patch: Record<string, unknown>,
  reason: string | null,
  actorId: string
): Promise<void> {
  const switchesTurnedOff = Object.entries(patch)
    .filter(([k, v]) => v === false && k.endsWith('_enabled'))
    .map(([k]) => k);
  await record(
    'kill_switch_activated',
    'HIGH',
    `AI kill switch activated: ${switchesTurnedOff.join(', ') || 'unspecified'}`,
    { switches: switchesTurnedOff, reason, actor_id: actorId }
  );
}

/**
 * Spec section 58 — an admin attempted a configuration that would have created
 * an unsafe state. Recorded because a rejected attempt is itself operationally
 * interesting: repeated attempts to set a nonsensical ceiling are worth seeing.
 */
export async function recordConfigValidationRejection(message: string, actorId: string): Promise<void> {
  await record('config_validation_rejected', 'LOW', message, { actor_id: actorId });
}

/** Spec sections 31/32 — a provider or model being disabled by an admin. */
export async function recordProviderOrModelDisabled(
  kind: 'provider' | 'model',
  identifier: string,
  reason: string | null,
  actorId: string
): Promise<void> {
  await record(
    kind === 'provider' ? 'provider_disabled_blocked' : 'model_disabled_blocked',
    'MEDIUM',
    `${kind} disabled by an administrator: ${identifier}`,
    { [kind]: identifier, reason, actor_id: actorId, source: 'admin_action' }
  );
}
