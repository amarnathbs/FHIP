import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles, isResourceStaff } from '@/lib/resources/permissions';
import { searchRelatableContent } from '@/lib/resources/discovery/relatedAdmin';

// GET /api/admin/resources/related/search-posts?q=&type=&jurisdiction=&exclude= — spec §77's Related Content picker.
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const current = await getCurrentResourceRoles();
  if (!isResourceStaff(current)) return bad("You don't have permission to access Resources administration.", 403);

  const { searchParams } = new URL(request.url);
  const q = (searchParams.get('q') ?? '').slice(0, 200);
  const contentType = searchParams.get('type') ?? 'all';
  const jurisdiction = searchParams.get('jurisdiction') ?? 'all';
  const excludePostId = searchParams.get('exclude') ?? undefined;

  try {
    const results = await searchRelatableContent(supabase, q, { contentType, jurisdiction, excludePostId });
    return ok(results);
  } catch (err) {
    console.error('Resources related-content post-search error:', err);
    return bad('Could not search content.', 500);
  }
}
