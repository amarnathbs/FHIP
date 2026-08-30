import { createClient } from '@/lib/supabase/server';
import { bad } from '@/lib/api';
import { transitionResourcePostStatus } from '@/lib/resources/workflow';
import { getMoneyUpdateEditorPost } from '@/lib/resources/money-update/queries';
import { validateMoneyUpdateForReview } from '@/lib/resources/money-update/validation';
import { createResourceVersion, deriveSeoFallback } from '@/lib/resources/editor/mutations';
import { validateForPublish } from '@/lib/resources/editor/validation';
import { validateScheduledTransition, schedulingErrorResponse } from '@/lib/resources/scheduling';
import type { ResourceStatus } from '@/lib/resources/types';
import type { PostVersionSnapshot } from '@/lib/resources/editor/types';
import type { AnyBlock } from '@/lib/resources/editor/blocks';

// Money Update workflow — spec §40-49/§89-91. Same R1.1 status workflow/RPC
// as every resource_posts row (spec §53); RED/AMBER restrictions are
// enforced identically by the RPC itself (spec §48: "RED restrictions remain
// identical. No schedule/publish. DB constraints remain authoritative.") —
// this route adds no separate compliance logic of its own.
const VALID_TARGETS: ResourceStatus[] = ['idea', 'draft', 'editorial_review', 'compliance_review', 'approved', 'scheduled', 'published', 'review_due', 'archived'];
const REVIEW_GATE: ResourceStatus[] = ['editorial_review'];
const PUBLISH_GATE: ResourceStatus[] = ['scheduled', 'published'];
const SNAPSHOT_ON: ResourceStatus[] = ['editorial_review', 'approved', 'scheduled', 'published'];

function toSnapshot(post: Awaited<ReturnType<typeof getMoneyUpdateEditorPost>>): PostVersionSnapshot {
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

    const post = await getMoneyUpdateEditorPost(supabase, id);
    if (!post) return bad('Money Update not found.', 404);

    if (REVIEW_GATE.includes(toStatus as ResourceStatus)) {
      const check = validateMoneyUpdateForReview({ ...post, content_blocks: post.content_blocks as AnyBlock[] });
      if (!check.valid) return Response.json({ error: 'This Money Update is not ready for editorial review yet.', fields: check.errors }, { status: 422 });
    }
    if (PUBLISH_GATE.includes(toStatus as ResourceStatus)) {
      const fallback = deriveSeoFallback(post.title, post.excerpt);
      const check = validateForPublish({ ...post, content_blocks: post.content_blocks as AnyBlock[], seo_title: post.seo_title || fallback.seoTitle, seo_description: post.seo_description || fallback.seoDescription });
      if (!check.valid) return Response.json({ error: 'This Money Update is not ready to publish yet.', fields: check.errors }, { status: 422 });
    }

    // Admin A0.2 Wave 2 (Scope B). Canonical scheduling pre-check, shared
    // verbatim with the other three content-type routes. Before Wave 2 this
    // route had no scheduling check at all, so a scheduling attempt fell
    // through to the raw table CHECK constraint and surfaced as HTTP 403 with
    // the internal constraint name in the message. The authoritative rule is
    // the identical check inside public.transition_resource_post_status
    // (migration 0116).
    const scheduling = validateScheduledTransition(toStatus, post.scheduled_at);
    if (scheduling) return schedulingErrorResponse(scheduling);

    const response = await transitionResourcePostStatus(id, toStatus as ResourceStatus, { reason, notes });
    if (!response.ok) return response;

    if (SNAPSHOT_ON.includes(toStatus as ResourceStatus)) {
      try {
        await createResourceVersion(supabase, id, toSnapshot(post), user.id, reason ? `Workflow: ${reason}` : `Workflow transition to ${toStatus}`);
      } catch (versionErr) {
        console.error('Resources money update workflow version snapshot error:', versionErr);
      }
    }

    return response;
  } catch (err) {
    console.error('Resources money update workflow transition error:', err);
    return bad('Could not perform this workflow action.', 500);
  }
}
