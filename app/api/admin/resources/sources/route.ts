import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles, isResourceStaff } from '@/lib/resources/permissions';
import { searchSources } from '@/lib/resources/sources/queries';
import { createSource } from '@/lib/resources/sources/mutations';
import type { CreateSourceInput } from '@/lib/resources/sources/types';

// GET /api/admin/resources/sources?q=... — minimal source picker (spec §50).
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const { searchParams } = new URL(request.url);
  const q = (searchParams.get('q') ?? '').slice(0, 200);

  try {
    const sources = await searchSources(supabase, q);
    return ok(sources);
  } catch (err) {
    console.error('Resources sources search error:', err);
    return bad('Could not load sources.', 500);
  }
}

// POST — minimal source creation (spec §50-51): title/publisher, URL,
// publication date, source type, public flag. URL validated https()-only.
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const current = await getCurrentResourceRoles();
  if (!isResourceStaff(current)) return bad("You don't have permission to add a source.", 403);

  try {
    const body = await request.json().catch(() => ({}));
    const input: CreateSourceInput = {
      source_name: typeof body?.source_name === 'string' ? body.source_name : '',
      document_title: typeof body?.document_title === 'string' ? body.document_title : '',
      url: typeof body?.url === 'string' ? body.url : '',
      source_type: typeof body?.source_type === 'string' ? body.source_type : '',
      publication_date: typeof body?.publication_date === 'string' ? body.publication_date : '',
      is_public: typeof body?.is_public === 'boolean' ? body.is_public : true,
    };
    const result = await createSource(supabase, input, user.id);
    if (!result.ok) return bad(result.error, 422);
    return ok({ id: result.id });
  } catch (err) {
    console.error('Resources source create error:', err);
    return bad('Could not create this source.', 500);
  }
}
