import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles, isResourceStaff } from '@/lib/resources/permissions';
import { searchRelatableContent, listRelatableContent } from '@/lib/resources/discovery/relatedAdmin';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';

// GET /api/admin/resources/related/search-posts?q=&type=&jurisdiction=&exclude= — spec §77's Related Content picker.
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return countryBlock;

  const current = await getCurrentResourceRoles();
  if (!isResourceStaff(current)) return bad("You don't have permission to access Resources administration.", 403);

  const { searchParams } = new URL(request.url);
  const q = (searchParams.get('q') ?? '').slice(0, 200);
  const contentType = searchParams.get('type') ?? 'all';
  const jurisdiction = searchParams.get('jurisdiction') ?? 'all';
  const excludePostId = searchParams.get('exclude') ?? undefined;

  try {
    // PO review F11: `?all=1` returns the capped full list (the dropdown's
    // data source) instead of the 25-row search. Same gate as above.
    if (searchParams.get('all') === '1') {
      const list = await listRelatableContent(supabase, { search: q, contentType, excludePostId });
      return ok(list);
    }
    const results = await searchRelatableContent(supabase, q, { contentType, jurisdiction, excludePostId });
    return ok(results);
  } catch (err) {
    console.error('Resources related-content post-search error:', err);
    return bad('Could not search content.', 500);
  }
}
