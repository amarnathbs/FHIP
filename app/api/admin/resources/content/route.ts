import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles } from '@/lib/resources/permissions';
import { parseContentListFilters, QUEUE_STATUS_GROUPS, type QueuePreset } from '@/lib/resources/admin/filters';
import { getResourceContentList } from '@/lib/resources/admin/queries';

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
  if (!current.isSuperAdmin && current.roles.length === 0) return bad("You don't have permission to access Resources administration.", 403);

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
