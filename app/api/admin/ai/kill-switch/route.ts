// Module 11.1 — POST /api/admin/ai/kill-switch  (spec sections 29, 30, 40).
//
// Section 40: "Prefer specific actions over broad generic mutation APIs."
// The generic PUT /api/admin/ai/config already exists (the controls route) and
// can flip any field. This endpoint exists because an emergency stop should
// not require constructing a correct partial-update body under pressure: it
// takes a switch name and a state, and nothing else can be changed through it.
//
// A REASON IS MANDATORY when stopping. An unexplained platform-wide AI stop is
// an incident nobody can reconstruct afterwards, and both ai_config_audit
// (trigger-written, per field) and ai_operational_events carry the reason
// forward.

import { requireAdmin, adminRoute } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';
import { getPlatformControls, updatePlatformControls, type PlatformControlsPatch } from '@/lib/ai/entitlement/platformControls';
import { recordKillSwitchActivation } from '@/lib/ai/observability/operationalEvents';

/**
 * The five switches spec section 29 names, mapped to the columns that
 * implement them. A name not on this list is rejected — this endpoint cannot
 * be used to set an arbitrary column.
 */
const SWITCHES: Record<string, keyof PlatformControlsPatch> = {
  AI_GLOBAL_ENABLED: 'ai_globally_enabled',
  AI_CUSTOM_QUESTIONS_ENABLED: 'custom_ai_enabled',
  AI_LIVE_PROVIDER_ENABLED: 'live_provider_enabled',
  AI_BATCH_GENERATION_ENABLED: 'batch_generation_enabled',
  AI_SCENARIO_ENABLED: 'scenario_ai_enabled',
};

export const POST = adminRoute(async (req: Request) => {
  const { user, forbidden } = await requireAdmin();
  if (forbidden) return forbidden;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return bad('A JSON body is required', 422);
  const raw = body as Record<string, unknown>;

  const name = typeof raw.switch === 'string' ? raw.switch : null;
  if (!name || !(name in SWITCHES)) {
    return bad(`switch must be one of: ${Object.keys(SWITCHES).join(', ')}`, 422);
  }
  if (typeof raw.enabled !== 'boolean') return bad('enabled must be a boolean', 422);

  const reason = typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim() : null;
  if (!raw.enabled && !reason) {
    return bad('reason is required when disabling an AI switch', 422);
  }

  const current = await getPlatformControls();
  if (!current) return bad('AI platform controls are not configured; migration 0115 may not be applied.', 503);

  const patch: PlatformControlsPatch = { [SWITCHES[name]]: raw.enabled } as PlatformControlsPatch;
  // Clear the stored reason on re-enable, so a stale explanation from a
  // previous incident cannot be mistaken for a current one.
  patch.kill_switch_reason = raw.enabled ? null : reason;

  const updated = await updatePlatformControls(patch, user!.id);
  if (!raw.enabled) {
    await recordKillSwitchActivation(patch, reason, user!.id);
  }

  return ok({
    switch: name,
    enabled: raw.enabled,
    reason: updated.kill_switch_reason,
    // Echoed so an operator can confirm the resulting posture in one response
    // rather than issuing a second read under incident conditions.
    effective_state: {
      ai_globally_enabled: updated.ai_globally_enabled,
      custom_ai_enabled: updated.custom_ai_enabled,
      live_provider_enabled: updated.live_provider_enabled,
      batch_generation_enabled: updated.batch_generation_enabled,
      scenario_ai_enabled: updated.scenario_ai_enabled,
    },
  });
});
