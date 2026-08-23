import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles, canManageDiscovery, isResourceStaff } from '@/lib/resources/permissions';
import { listRelatedContentForSource, addRelatedContent, RELATIONSHIP_TYPES } from '@/lib/resources/discovery/relatedAdmin';
import type { RelationshipType } from '@/lib/resources/discovery/relatedAdmin';

// GET /api/admin/resources/related?postId=... — spec §39/§77.
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const current = await getCurrentResourceRoles();
  if (!isResourceStaff(current)) return bad("You don't have permission to access Resources administration.", 403);

  const { searchParams } = new URL(request.url);
  const postId = searchParams.get('postId');
  if (!postId) return bad('postId is required.', 400);

  try {
    const items = await listRelatedContentForSource(supabase, postId);
    return ok({ items, canManage: canManageDiscovery(current) });
  } catch (err) {
    console.error('Resources related-content list error:', err);
    return bad('Could not load related content.', 500);
  }
}

// POST /api/admin/resources/related — spec §39: add a manual relation.
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const current = await getCurrentResourceRoles();
  if (!canManageDiscovery(current)) return bad("You don't have permission to manage Related Content.", 403);

  const body = await request.json().catch(() => ({}));
  const sourcePostId = typeof body?.source_post_id === 'string' ? body.source_post_id : '';
  const relatedPostId = typeof body?.related_post_id === 'string' ? body.related_post_id : '';
  const relationshipType: RelationshipType = (RELATIONSHIP_TYPES as readonly string[]).includes(body?.relationship_type) ? body.relationship_type : 'related';

  if (!sourcePostId || !relatedPostId) return bad('source_post_id and related_post_id are required.', 400);

  try {
    const result = await addRelatedContent(supabase, sourcePostId, relatedPostId, relationshipType);
    if (!result.ok) return Response.json({ error: result.error }, { status: 422 });
    return ok({ id: result.id });
  } catch (err) {
    console.error('Resources related-content create error:', err);
    return bad('Could not create this relationship.', 500);
  }
}
