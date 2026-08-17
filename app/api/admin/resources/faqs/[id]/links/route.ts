import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles, canManageFaqs } from '@/lib/resources/permissions';
import { getFaqLinkedPosts } from '@/lib/resources/faq/queries';
import { linkFaqToPost, unlinkFaqFromPost } from '@/lib/resources/faq/mutations';

// GET /api/admin/resources/faqs/[id]/links — linked-post list (spec §36-37).
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const { id } = await params;
  try {
    const links = await getFaqLinkedPosts(supabase, id);
    return ok(links);
  } catch (err) {
    console.error('Resources FAQ links load error:', err);
    return bad('Could not load linked content.', 500);
  }
}

// POST { postId } — link this FAQ to a Resources post (spec §36).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const current = await getCurrentResourceRoles();
  if (!canManageFaqs(current)) return bad("You don't have permission to link FAQs.", 403);

  const { id } = await params;
  try {
    const body = await request.json().catch(() => ({}));
    const postId = typeof body?.postId === 'string' ? body.postId : '';
    if (!postId) return bad('A content item is required.', 400);
    const result = await linkFaqToPost(supabase, id, postId);
    if (!result.ok) return bad(result.error, 409);
    return ok({ linked: true });
  } catch (err) {
    console.error('Resources FAQ link error:', err);
    return bad('Could not link this FAQ.', 500);
  }
}

// DELETE ?postId=... — unlink (spec §36).
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const current = await getCurrentResourceRoles();
  if (!canManageFaqs(current)) return bad("You don't have permission to unlink FAQs.", 403);

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const postId = searchParams.get('postId') ?? '';
  if (!postId) return bad('A content item is required.', 400);

  try {
    await unlinkFaqFromPost(supabase, id, postId);
    return ok({ unlinked: true });
  } catch (err) {
    console.error('Resources FAQ unlink error:', err);
    return bad('Could not unlink this FAQ.', 500);
  }
}
