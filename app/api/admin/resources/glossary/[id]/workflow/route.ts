import { createClient } from '@/lib/supabase/server';
import { bad } from '@/lib/api';
import { transitionResourcePostStatus } from '@/lib/resources/workflow';
import { getGlossaryEditorPost } from '@/lib/resources/glossary/queries';
import { validateGlossaryForReview } from '@/lib/resources/glossary/validation';
import { createResourceVersion, deriveSeoFallback } from '@/lib/resources/editor/mutations';
import { validateForPublish } from '@/lib/resources/editor/validation';
import type { ResourceStatus } from '@/lib/resources/types';
import type { PostVersionSnapshot } from '@/lib/resources/editor/types';
import type { AnyBlock } from '@/lib/resources/editor/blocks';

// Glossary workflow — spec §93: "Verify a Glossary definition can move
// Draft -> Editorial Review -> Approved -> Published through the same post
// workflow." Uses validateGlossaryForReview() (not R1.3's validateForReview)
// specifically because detailed explanation/content_blocks is optional for
// Glossary (spec §28) — every other check is the shared publish-gate check.
const VALID_TARGETS: ResourceStatus[] = ['idea', 'draft', 'editorial_review', 'compliance_review', 'approved', 'scheduled', 'published', 'review_due', 'archived'];
const REVIEW_GATE: ResourceStatus[] = ['editorial_review'];
const PUBLISH_GATE: ResourceStatus[] = ['scheduled', 'published'];
const SNAPSHOT_ON: ResourceStatus[] = ['editorial_review', 'approved', 'scheduled', 'published'];

function toSnapshot(post: Awaited<ReturnType<typeof getGlossaryEditorPost>>): PostVersionSnapshot {
  if (!post) throw new Error('post missing for snapshot');
  return {
    title: post.title,
    slug: post.slug,
    excerpt: post.excerpt,
    content_type: post.content_type,
    content_blocks: post.content_blocks,
    jurisdiction: post.jurisdiction,
    difficulty: post.difficulty,
    freshness_type: post.freshness_type,
    visibility: post.visibility,
    compliance_classification: post.compliance_classification,
    primary_category_id: post.primary_category_id,
    category_ids: post.categories.map((c) => c.id),
    tag_ids: post.tags.map((t) => t.id),
    author_id: post.author_id,
    reviewer_id: post.reviewer_id,
    compliance_reviewer_id: post.compliance_reviewer_id,
    seo_title: post.seo_title,
    seo_description: post.seo_description,
    canonical_url: post.canonical_url,
    is_indexable: post.is_indexable,
    primary_cta_id: post.primary_cta_id,
    secondary_cta_id: post.secondary_cta_id,
  };
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const { id } = await params;
  try {
    const body = await request.json().catch(() => ({}));
    const toStatus = body?.toStatus as string;
    const reason = typeof body?.reason === 'string' ? body.reason : undefined;
    const notes = typeof body?.notes === 'string' ? body.notes : undefined;

    if (!VALID_TARGETS.includes(toStatus as ResourceStatus)) return bad('Invalid target status.', 400);

    const post = await getGlossaryEditorPost(supabase, id);
    if (!post) return bad('Glossary definition not found.', 404);

    if (REVIEW_GATE.includes(toStatus as ResourceStatus)) {
      const check = validateGlossaryForReview(post);
      if (!check.valid) return Response.json({ error: 'This glossary definition is not ready for editorial review yet.', fields: check.errors }, { status: 422 });
    }
    if (PUBLISH_GATE.includes(toStatus as ResourceStatus)) {
      const fallback = deriveSeoFallback(post.title, post.excerpt);
      const check = validateForPublish({ ...post, content_blocks: post.content_blocks as AnyBlock[], seo_title: post.seo_title || fallback.seoTitle, seo_description: post.seo_description || fallback.seoDescription });
      if (!check.valid) return Response.json({ error: 'This glossary definition is not ready to publish yet.', fields: check.errors }, { status: 422 });
    }

    const response = await transitionResourcePostStatus(id, toStatus as ResourceStatus, { reason, notes });
    if (!response.ok) return response;

    if (SNAPSHOT_ON.includes(toStatus as ResourceStatus)) {
      try {
        await createResourceVersion(supabase, id, toSnapshot(post), user.id, reason ? `Workflow: ${reason}` : `Workflow transition to ${toStatus}`);
      } catch (versionErr) {
        console.error('Resources glossary workflow version snapshot error:', versionErr);
      }
    }

    return response;
  } catch (err) {
    console.error('Resources glossary workflow transition error:', err);
    return bad('Could not perform this workflow action.', 500);
  }
}
