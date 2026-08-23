import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles, canManageDiscovery, isResourceStaff } from '@/lib/resources/permissions';
import { listContextMappings, createContextMapping } from '@/lib/resources/context/queries';
import { isRegisteredContextKey, FHIP_CONTEXTS } from '@/lib/resources/context/registry';

// GET /api/admin/resources/context?contextKey=... — spec §57/§78. Omit
// contextKey to list every mapping (small dataset, fine to return in full).
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const current = await getCurrentResourceRoles();
  if (!isResourceStaff(current)) return bad("You don't have permission to access Resources administration.", 403);

  const { searchParams } = new URL(request.url);
  const contextKey = searchParams.get('contextKey') ?? undefined;

  try {
    const items = await listContextMappings(supabase, contextKey);
    return ok({ items, canManage: canManageDiscovery(current), registry: FHIP_CONTEXTS });
  } catch (err) {
    console.error('Resources context mapping list error:', err);
    return bad('Could not load context mappings.', 500);
  }
}

// POST /api/admin/resources/context — spec §57/§58/§96: unknown context keys are rejected.
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const current = await getCurrentResourceRoles();
  if (!canManageDiscovery(current)) return bad("You don't have permission to manage Context Mapping.", 403);

  const body = await request.json().catch(() => ({}));
  const contextKey = typeof body?.context_key === 'string' ? body.context_key : '';
  const resourcePostId = typeof body?.resource_post_id === 'string' ? body.resource_post_id : '';

  if (!isRegisteredContextKey(contextKey)) return Response.json({ error: 'Unknown context key.', fields: { context_key: 'Not a registered context key.' } }, { status: 422 });
  if (!resourcePostId) return bad('resource_post_id is required.', 400);

  try {
    const result = await createContextMapping(supabase, {
      context_key: contextKey,
      resource_post_id: resourcePostId,
      metric_or_feature: typeof body?.metric_or_feature === 'string' && body.metric_or_feature ? body.metric_or_feature : null,
      sort_order: typeof body?.sort_order === 'number' ? body.sort_order : 0,
      is_active: typeof body?.is_active === 'boolean' ? body.is_active : true,
    });
    return ok(result);
  } catch (err) {
    console.error('Resources context mapping create error:', err);
    return bad('Could not create this mapping.', 500);
  }
}
