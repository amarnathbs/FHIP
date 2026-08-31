// Module 11.1 — PUT /api/admin/ai/providers/{provider}  (spec sections 31, 26, 40).
//
// The provider-level kill switch and the per-provider monthly spend limit.
//
// Section 31: "If Provider A disabled: no new calls to it; model routing may
// use an approved fallback ONLY if explicitly configured; no silent unapproved
// fallback." That is satisfied structurally rather than by a rule this route
// has to remember: disabling a provider here causes ai_admit_request() to
// refuse requests bound to it, and there is no code anywhere in Module 11.1
// that reroutes a refused request to a different provider. A disabled provider
// is a refusal, never a redirect.

import { requireAdmin, adminRoute } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';
import { upsertProviderControl, type ProviderControlPatch } from '@/lib/ai/entitlement/platformControls';
import { recordProviderOrModelDisabled } from '@/lib/ai/observability/operationalEvents';

export const PUT = adminRoute(async (req: Request, { params }: { params: Promise<{ provider: string }> }) => {
  const { user, forbidden } = await requireAdmin();
  if (forbidden) return forbidden;

  const { provider } = await params;
  if (!provider) return bad('A provider is required', 422);

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return bad('A JSON body is required', 422);
  const raw = body as Record<string, unknown>;

  const patch: ProviderControlPatch = {};
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== 'boolean') return bad('enabled must be a boolean', 422);
    patch.enabled = raw.enabled;
  }
  if (raw.monthly_cost_limit_usd !== undefined) {
    const v = raw.monthly_cost_limit_usd;
    if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
      return bad('monthly_cost_limit_usd must be a number >= 0 or null', 422);
    }
    patch.monthly_cost_limit_usd = v as number | null;
  }
  if (raw.disabled_reason !== undefined) {
    if (raw.disabled_reason !== null && typeof raw.disabled_reason !== 'string') {
      return bad('disabled_reason must be a string or null', 422);
    }
    patch.disabled_reason = raw.disabled_reason as string | null;
  }
  if (raw.notes !== undefined) {
    if (raw.notes !== null && typeof raw.notes !== 'string') return bad('notes must be a string or null', 422);
    patch.notes = raw.notes as string | null;
  }

  if (Object.keys(patch).length === 0) return bad('No recognised provider control fields were supplied', 422);

  // Same discipline as the platform kill switch: stopping something must say
  // why, or the outage is unreconstructable later.
  if (patch.enabled === false && !patch.disabled_reason) {
    return bad('disabled_reason is required when disabling a provider', 422);
  }

  const updated = await upsertProviderControl(provider, patch, user!.id);
  if (patch.enabled === false) {
    await recordProviderOrModelDisabled('provider', provider, patch.disabled_reason ?? null, user!.id);
  }
  return ok(updated);
});
