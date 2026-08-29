import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { isSlugAvailable, isContentIdAvailable } from '@/lib/resources/editor/queries';
import { isValidSlugFormat } from '@/lib/resources/editor/slug';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';

// GET /api/admin/resources/content/[id]/slug-check?slug=...&contentId=...
//
// Uniqueness must never be trusted client-side only (spec §20) — this is
// the live server check the editor calls on blur/before-submit; the actual
// backstop is still the DB `unique` constraint on resource_posts.slug /
// content_id (migration 0033), which the PATCH route also re-checks
// immediately before writing (belt and braces, not "check-then-trust").
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return countryBlock;

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const slug = searchParams.get('slug') ?? '';

  try {
    if (!slug) return ok({ slugAvailable: null, validFormat: null });
    const validFormat = isValidSlugFormat(slug);
    const slugAvailable = validFormat ? await isSlugAvailable(supabase, slug, id) : false;
    return ok({ slugAvailable, validFormat });
  } catch (err) {
    console.error('Resources slug check error:', err);
    return bad('Could not check slug availability.', 500);
  }
}

// content_id uniqueness re-uses the same route, distinguished by a
// different query param, to avoid a fourth near-identical endpoint.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return countryBlock;

  const { id } = await params;
  try {
    const body = await request.json().catch(() => ({}));
    const contentId = typeof body?.contentId === 'string' ? body.contentId : '';
    if (!contentId) return ok({ contentIdAvailable: null });
    const contentIdAvailable = await isContentIdAvailable(supabase, contentId, id);
    return ok({ contentIdAvailable });
  } catch (err) {
    console.error('Resources content-id check error:', err);
    return bad('Could not check content ID availability.', 500);
  }
}
