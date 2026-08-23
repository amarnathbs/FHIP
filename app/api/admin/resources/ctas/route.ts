import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles, canManageDiscovery, isResourceStaff } from '@/lib/resources/permissions';
import { listCtas, findDuplicateCta } from '@/lib/resources/cta/queries';
import { createCta } from '@/lib/resources/cta/mutations';
import { validateCta } from '@/lib/resources/cta/validation';
import type { CtaSavePatch, CtaDestinationType } from '@/lib/resources/cta/types';
import { CTA_DESTINATION_TYPES } from '@/lib/resources/cta/types';

// GET /api/admin/resources/ctas — CTA Library listing (spec §42). Every
// active-Resources-role staff member may view (read-only for anyone who
// isn't a discovery manager — spec §79: "Analyst must remain read-only"),
// same isResourceStaff() gate the rest of the Admin shell uses for viewing.
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const current = await getCurrentResourceRoles();
  if (!isResourceStaff(current)) return bad("You don't have permission to access Resources administration.", 403);

  try {
    const { searchParams } = new URL(request.url);
    const q = (searchParams.get('q') ?? '').slice(0, 200);
    const ctas = await listCtas(supabase, q);
    return ok({ items: ctas, canManage: canManageDiscovery(current) });
  } catch (err) {
    console.error('Resources CTAs list error:', err);
    return bad('Could not load CTAs.', 500);
  }
}

// POST /api/admin/resources/ctas — spec §42/§52. Resource Admin / Editor /
// Super Admin only (spec §79).
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const current = await getCurrentResourceRoles();
  if (!canManageDiscovery(current)) return bad("You don't have permission to manage the CTA Library.", 403);

  try {
    const body = await request.json().catch(() => ({}));
    const destinationType = CTA_DESTINATION_TYPES.includes(body?.destination_type) ? (body.destination_type as CtaDestinationType) : ('internal_resource' as CtaDestinationType);
    const patch: CtaSavePatch = {
      name: typeof body?.name === 'string' ? body.name : '',
      label: typeof body?.label === 'string' ? body.label : '',
      description: typeof body?.description === 'string' ? body.description : '',
      destination_type: destinationType,
      destination_url: typeof body?.destination_url === 'string' ? body.destination_url : '',
      is_active: typeof body?.is_active === 'boolean' ? body.is_active : true,
    };

    const check = validateCta(patch);
    if (!check.valid) return Response.json({ error: 'Validation failed.', fields: check.errors }, { status: 422 });

    if (await findDuplicateCta(supabase, patch.label, patch.destination_type, patch.destination_url)) {
      return Response.json({ error: 'Validation failed.', fields: { label: 'A CTA with this exact label and destination already exists.' } }, { status: 422 });
    }

    const result = await createCta(supabase, patch);
    return ok(result);
  } catch (err) {
    console.error('Resources CTA create error:', err);
    return bad('Could not create this CTA.', 500);
  }
}
