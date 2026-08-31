// Module 11.1 — admin control plane for the AI kill switch and every ceiling.
//
// This is what makes the kill switch "admin-controllable and faster than a
// code deploy": one PUT flips a row, and the very next AI request reads it
// (ai_admit_request() reads the controls row uncached, inside the request
// transaction). No redeploy, no cache invalidation, no restart.
//
// This route is NOT a user-facing AI surface. It exposes no AI capability —
// only the switches and limits that govern one.

import { requireAdmin, adminRoute } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';
import {
  getPlatformControls,
  updatePlatformControls,
  listTaskCostLimits,
  listProviderControls,
  summariseUsageForPeriod,
  validateControlsPatch,
  type PlatformControlsPatch,
} from '@/lib/ai/entitlement/platformControls';
import { recordKillSwitchActivation, recordConfigValidationRejection } from '@/lib/ai/observability/operationalEvents';
import { currentBillingPeriod } from '@/lib/ai/billingPeriod';

export const GET = adminRoute(async () => {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;

  const billingPeriod = currentBillingPeriod();
  const [controls, taskCostLimits, providerControls, usage] = await Promise.all([
    getPlatformControls(),
    listTaskCostLimits(),
    listProviderControls(),
    summariseUsageForPeriod(billingPeriod),
  ]);

  return ok({
    billing_period: billingPeriod,
    controls,
    task_cost_limits: taskCostLimits,
    provider_controls: providerControls,
    usage_this_period: usage,
    // Surfaced so an operator is never guessing whether enforcement is live.
    enforcement_status: controls
      ? {
          ai_globally_enabled: controls.ai_globally_enabled,
          custom_ai_enabled: controls.custom_ai_enabled,
          // No controls row => ai_admit_request() denies every request.
          effective: controls.ai_globally_enabled ? (controls.custom_ai_enabled ? 'all_enabled' : 'custom_ai_stopped') : 'all_ai_stopped',
        }
      : { ai_globally_enabled: false, custom_ai_enabled: false, effective: 'controls_missing_all_requests_denied' },
  });
});

const BOOLEAN_FIELDS = [
  'ai_globally_enabled', 'custom_ai_enabled', 'standard_requires_premium',
  // Spec section 29 — the remaining three named switches.
  'live_provider_enabled', 'batch_generation_enabled', 'scenario_ai_enabled',
] as const;
const NON_NEGATIVE_INT_FIELDS = ['monthly_custom_question_allowance'] as const;
const POSITIVE_INT_FIELDS = [
  'rate_limit_max_requests', 'rate_limit_window_seconds',
  // Spec section 18.
  'max_concurrent_requests_per_subject', 'concurrency_lease_seconds',
  // Spec sections 20/21.
  'max_context_tokens', 'max_user_input_tokens', 'max_output_tokens',
] as const;
const NON_NEGATIVE_NUMERIC_FIELDS = [
  'per_user_monthly_cost_ceiling_usd',
  'platform_monthly_cost_ceiling_usd',
  'max_cost_per_request_usd',
] as const;
/** Spec sections 26/27 — nullable ceilings, where null genuinely means "not configured". */
const NULLABLE_NUMERIC_FIELDS = [
  'platform_soft_cost_threshold_usd',
  'per_user_soft_cost_threshold_usd',
  'daily_live_ai_cost_limit_usd',
] as const;

export const PUT = adminRoute(async (req: Request) => {
  const { user, forbidden } = await requireAdmin();
  if (forbidden) return forbidden;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return bad('A JSON body is required', 422);

  const patch: PlatformControlsPatch = {};
  const raw = body as Record<string, unknown>;

  for (const field of BOOLEAN_FIELDS) {
    if (raw[field] === undefined) continue;
    if (typeof raw[field] !== 'boolean') return bad(`${field} must be a boolean`, 422);
    patch[field] = raw[field] as boolean;
  }
  for (const field of NON_NEGATIVE_INT_FIELDS) {
    if (raw[field] === undefined) continue;
    const v = raw[field];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return bad(`${field} must be an integer >= 0`, 422);
    patch[field] = v;
  }
  for (const field of POSITIVE_INT_FIELDS) {
    if (raw[field] === undefined) continue;
    const v = raw[field];
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) return bad(`${field} must be an integer > 0`, 422);
    patch[field] = v;
  }
  for (const field of NON_NEGATIVE_NUMERIC_FIELDS) {
    if (raw[field] === undefined) continue;
    const v = raw[field];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return bad(`${field} must be a number >= 0`, 422);
    patch[field] = v;
  }
  for (const field of NULLABLE_NUMERIC_FIELDS) {
    if (raw[field] === undefined) continue;
    const v = raw[field];
    if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
      return bad(`${field} must be a number >= 0 or null`, 422);
    }
    patch[field] = v as number | null;
  }
  if (raw.kill_switch_reason !== undefined) {
    if (raw.kill_switch_reason !== null && typeof raw.kill_switch_reason !== 'string') {
      return bad('kill_switch_reason must be a string or null', 422);
    }
    patch.kill_switch_reason = raw.kill_switch_reason as string | null;
  }

  if (Object.keys(patch).length === 0) return bad('No recognised control fields were supplied', 422);

  // Turning a kill switch OFF should say why — an unexplained platform-wide
  // stop is an incident nobody can reconstruct later.
  const stoppingSomething = patch.ai_globally_enabled === false || patch.custom_ai_enabled === false
    || patch.live_provider_enabled === false || patch.batch_generation_enabled === false;
  if (stoppingSomething && !patch.kill_switch_reason && typeof raw.kill_switch_reason !== 'string') {
    return bad('kill_switch_reason is required when disabling AI, custom AI, the live provider or batch generation', 422);
  }

  // Spec section 58 — validate the MERGED configuration, not the patch. A
  // patch that lowers a hard ceiling below an already-stored soft threshold is
  // exactly as unsafe as one that raises the soft threshold, and only the
  // merged view sees either.
  const current = await getPlatformControls();
  if (!current) return bad('AI platform controls are not configured; migration 0115 may not be applied.', 503);
  const invalid = validateControlsPatch(current, patch);
  if (invalid) {
    await recordConfigValidationRejection(invalid, user!.id);
    return bad(invalid, 422);
  }

  const updated = await updatePlatformControls(patch, user!.id);

  // Spec section 38: a kill-switch activation is an operational event in its
  // own right, distinct from the field-level ai_config_audit row the database
  // trigger writes. HIGH severity — someone stopping AI platform-wide is an
  // incident, not routine configuration.
  if (stoppingSomething) {
    await recordKillSwitchActivation(patch, updated.kill_switch_reason, user!.id);
  }

  return ok(updated);
});
