import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { searchLinkablePosts } from '@/lib/resources/faq/queries';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';

// GET /api/admin/resources/faqs/search-posts?q=... — the FAQ-to-post linking
// picker's search (spec §36: "Support linking an FAQ to existing Resources
// posts... Article, Guide, FHIP Explainer, Video, Glossary, Money Update").
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return countryBlock;

  const { searchParams } = new URL(request.url);
  const q = (searchParams.get('q') ?? '').slice(0, 200);

  try {
    const results = await searchLinkablePosts(supabase, q);
    return ok(results);
  } catch (err) {
    console.error('Resources FAQ post-search error:', err);
    return bad('Could not search content.', 500);
  }
}
