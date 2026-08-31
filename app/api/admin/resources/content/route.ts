import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles, isResourceStaff, canCreateResource } from '@/lib/resources/permissions';
import { parseContentListFilters, QUEUE_STATUS_GROUPS, type QueuePreset } from '@/lib/resources/admin/filters';
import { getResourceContentList } from '@/lib/resources/admin/queries';
import { createResourceDraft } from '@/lib/resources/editor/mutations';
import { isEditableContentType } from '@/lib/resources/editor/types';

const QUEUE_PRESETS = new Set(['drafts', 'review', 'scheduled', 'published', 'review-due', 'archived']);

// GET /api/admin/resources/content?[q, status, type, jurisdiction, compliance,
// category, sort, page, pageSize, queue]
//
// `queue` (optional) selects one of the fixed workflow-queue status groups
// (spec §35) — when present it overrides the `status` filter entirely,
// letting /admin/resources/content/drafts etc. reuse this exact same route
// and query function instead of a duplicated implementation.
//
// Uses the caller's own RLS-scoped Supabase client throughout (spec §70/§71)
// — never service-role. A customer or unauthenticated caller is rejected
// before any Resources table is even queried; a Resources-role caller sees
// exactly what RLS allows their role to see.
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const current = await getCurrentResourceRoles();
  // Phase A Wave 1: narrowed from the former coarse `!current.isSuperAdmin &&
  // current.roles.length === 0` check, which any single Resources role
  // cleared — including Analyst, who then received a misleading RLS-filtered
  // 200 instead of an honest denial (Admin Architecture Standard §4). Same
  // message and status code; only the predicate narrows.
  if (!isResourceStaff(current)) return bad("You don't have permission to access Resources administration.", 403);

  try {
    const { searchParams } = new URL(request.url);
    const filters = parseContentListFilters(searchParams);
    const queueParam = searchParams.get('queue');
    const preset = queueParam && QUEUE_PRESETS.has(queueParam) ? (queueParam as QueuePreset) : null;
    const presetStatuses = preset ? QUEUE_STATUS_GROUPS[preset] : undefined;

    const result = await getResourceContentList(supabase, filters, presetStatuses);
    return ok(result);
  } catch (err) {
    console.error('Resources content list error:', err);
    return bad('Could not load Resources content.', 500);
  }
}

// POST /api/admin/resources/content { contentType: 'article'|'guide'|'fhip_explainer' }
//
// Draft creation (spec §10-13). Role gate is checked twice — here (an early,
// clear 403 with the exact reason, spec §96) and again by RLS itself
// ("authors insert own drafts" requires private.is_resource_staff() AND
// created_by = auth.uid()) — this route never trusts the client-supplied
// role, it re-resolves it server-side via getCurrentResourceRoles() (spec §96).
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const current = await getCurrentResourceRoles();
  // Spec §11: create-draft is Super Admin / Resource Administrator / Author
  // / Editor only — Publisher/Compliance Reviewer/Analyst are NOT granted
  // draft creation "unless R1.1/R0-B explicitly permits it". canCreateResource()
  // mirrors isResourceStaff() (resource_admin/author/editor/compliance_reviewer/publisher),
  // which is broader than spec §11's literal list; the stricter rule
  // (spec §11's own instruction: "follow the stricter existing RBAC rule
  // where ambiguity exists") is enforced here explicitly rather than relying
  // on the broader helper alone.
  const CREATE_ROLES = ['resource_admin', 'author', 'editor'];
  const canCreate = current.isSuperAdmin || current.roles.some((r) => CREATE_ROLES.includes(r));
  if (!canCreate || !canCreateResource(current)) return bad("You don't have permission to create Resources content.", 403);

  try {
    const body = await request.json().catch(() => ({}));
    const contentType = typeof body?.contentType === 'string' ? body.contentType : '';
    if (!isEditableContentType(contentType)) return bad('Invalid content type. Must be one of: article, guide, fhip_explainer.', 400);

    const { id } = await createResourceDraft(supabase, contentType, user.id);
    return ok({ id });
  } catch (err) {
    console.error('Resources create draft error:', err);
    return bad('Could not create the new draft.', 500);
  }
}
