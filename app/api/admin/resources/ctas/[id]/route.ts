import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles, canManageDiscovery, isResourceStaff } from '@/lib/resources/permissions';
import { getCtaById, findDuplicateCta, countCtaUsage } from '@/lib/resources/cta/queries';
import { updateCta } from '@/lib/resources/cta/mutations';
import { validateCta } from '@/lib/resources/cta/validation';
import { logResourceAudit } from '@/lib/resources/admin/auditLog';
import type { CtaSavePatch, CtaDestinationType } from '@/lib/resources/cta/types';
import { CTA_DESTINATION_TYPES } from '@/lib/resources/cta/types';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return countryBlock;

  const current = await getCurrentResourceRoles();
  if (!isResourceStaff(current)) return bad("You don't have permission to access Resources administration.", 403);

  try {
    const cta = await getCtaById(supabase, id);
    if (!cta) return bad('CTA not found.', 404);
    const usageCount = await countCtaUsage(supabase, id);
    return ok({ cta, usageCount, canManage: canManageDiscovery(current) });
  } catch (err) {
    console.error('Resources CTA get error:', err);
    return bad('Could not load this CTA.', 500);
  }
}

// PATCH /api/admin/resources/ctas/[id] — spec §42/§48/§52. Used both for a
// full edit and for the quick Active/Inactive toggle (spec §48's "should
// disappear without editing every linked Resource" — deactivating here is
// the whole mechanism, no per-Resource edit required).
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return countryBlock;

  const current = await getCurrentResourceRoles();
  if (!canManageDiscovery(current)) return bad("You don't have permission to manage the CTA Library.", 403);

  const existing = await getCtaById(supabase, id);
  if (!existing) return bad('CTA not found.', 404);

  try {
    const body = await request.json().catch(() => ({}));
    const destinationType = CTA_DESTINATION_TYPES.includes(body?.destination_type) ? (body.destination_type as CtaDestinationType) : existing.destination_type;
    const patch: CtaSavePatch = {
      name: typeof body?.name === 'string' ? body.name : existing.name,
      label: typeof body?.label === 'string' ? body.label : existing.label,
      description: typeof body?.description === 'string' ? body.description : (existing.description ?? ''),
      destination_type: destinationType,
      destination_url: typeof body?.destination_url === 'string' ? body.destination_url : existing.destination_url,
      is_active: typeof body?.is_active === 'boolean' ? body.is_active : existing.is_active,
    };

    const check = validateCta(patch);
    if (!check.valid) return Response.json({ error: 'Validation failed.', fields: check.errors }, { status: 422 });

    if (await findDuplicateCta(supabase, patch.label, patch.destination_type, patch.destination_url, id)) {
      return Response.json({ error: 'Validation failed.', fields: { label: 'A CTA with this exact label and destination already exists.' } }, { status: 422 });
    }

    await updateCta(supabase, id, patch);
    const action = existing.is_active !== patch.is_active ? (patch.is_active ? 'CTA_ACTIVATED' : 'CTA_DEACTIVATED') : 'CTA_UPDATED';
    await logResourceAudit(createAdminClient(), { entity_type: 'resource_cta', entity_id: id, action, actor_user_id: user.id, before_state: existing, after_state: patch });
    return ok({ id });
  } catch (err) {
    console.error('Resources CTA update error:', err);
    return bad('Could not update this CTA.', 500);
  }
}
