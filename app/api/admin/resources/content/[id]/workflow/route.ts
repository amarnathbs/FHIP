import { createClient } from '@/lib/supabase/server';
import { bad } from '@/lib/api';
import { transitionResourcePostStatus } from '@/lib/resources/workflow';
import { getResourceEditorPost } from '@/lib/resources/editor/queries';
import { validateForReview, validateForPublish } from '@/lib/resources/editor/validation';
import { validateScheduledTransition, schedulingErrorResponse } from '@/lib/resources/scheduling';
import { createResourceVersion, deriveSeoFallback } from '@/lib/resources/editor/mutations';
import type { ResourceStatus } from '@/lib/resources/types';
import type { PostVersionSnapshot } from '@/lib/resources/editor/types';
import type { AnyBlock } from '@/lib/resources/editor/blocks';

const VALID_TARGETS: ResourceStatus[] = ['idea', 'draft', 'editorial_review', 'compliance_review', 'approved', 'scheduled', 'published', 'review_due', 'archived'];

// Transitions that get an application-level completeness re-check *before*
// calling the RPC (spec §35-37: review/publish need stronger validation
// than a draft save; §65: the RPC itself is still the actual security/
// workflow-integrity boundary — this is a friendlier, field-level error
// ahead of it, spec §74/§83, not a replacement for it).
const REVIEW_GATE: ResourceStatus[] = ['editorial_review'];
const PUBLISH_GATE: ResourceStatus[] = ['scheduled', 'published'];

// Transitions meaningful enough to snapshot a revision for (spec §43:
// "first saved draft; manual Save; workflow submission; pre-publish save" —
// NOT every transition, e.g. archiving doesn't need a content snapshot).
const SNAPSHOT_ON: ResourceStatus[] = ['editorial_review', 'approved', 'scheduled', 'published'];

function toSnapshot(post: Awaited<ReturnType<typeof getResourceEditorPost>>): PostVersionSnapshot {
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

// POST /api/admin/resources/content/[id]/workflow
// Body: { toStatus: ResourceStatus, reason?: string, notes?: string }
//
// Thin wrapper around the R1.1 transition RPC (spec §65 — "never bypass the
// RPC"). All actual permission/compliance enforcement lives in
// public.transition_resource_post_status; this route's own job is (a) the
// stage-appropriate pre-check so the UI gets a field-level error instead of
// a raw exception, and (b) the revision snapshot on a meaningful transition.
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

    const post = await getResourceEditorPost(supabase, id);
    if (!post) return bad('Resource not found.', 404);

    if (REVIEW_GATE.includes(toStatus as ResourceStatus)) {
      const check = validateForReview({ ...post, content_blocks: post.content_blocks as AnyBlock[] });
      if (!check.valid) return Response.json({ error: 'This draft is not ready for editorial review yet.', fields: check.errors }, { status: 422 });
    }
    if (PUBLISH_GATE.includes(toStatus as ResourceStatus)) {
      const fallback = deriveSeoFallback(post.title, post.excerpt);
      const check = validateForPublish({
        ...post,
        content_blocks: post.content_blocks as AnyBlock[],
        seo_title: post.seo_title || fallback.seoTitle,
        seo_description: post.seo_description || fallback.seoDescription,
      });
      if (!check.valid) return Response.json({ error: 'This content is not ready to publish yet.', fields: check.errors }, { status: 422 });
    }

    // Admin A0.2 Wave 2 (Scope B). Canonical scheduling pre-check, shared
    // verbatim with the Glossary, Money Update and Video routes. This
    // REPLACES the previous `!body?.scheduledAt` test, which read a
    // client-supplied property that was never persisted, never forwarded to
    // the RPC and never compared — so any truthy value satisfied it. The
    // authoritative, non-bypassable rule is the identical check inside
    // public.transition_resource_post_status (migration 0116); this one only
    // gives the administrator a clean field-level error first.
    const scheduling = validateScheduledTransition(toStatus, post.scheduled_at);
    if (scheduling) return schedulingErrorResponse(scheduling);

    const response = await transitionResourcePostStatus(id, toStatus as ResourceStatus, { reason, notes });
    if (!response.ok) return response; // transitionResourcePostStatus already shapes the RPC's error message safely (spec §74)

    if (SNAPSHOT_ON.includes(toStatus as ResourceStatus)) {
      try {
        await createResourceVersion(supabase, id, toSnapshot(post), user.id, reason ? `Workflow: ${reason}` : `Workflow transition to ${toStatus}`);
      } catch (versionErr) {
        // A snapshot failure must never be reported as if the whole
        // transition failed — the status change already committed inside
        // the RPC's own transaction. Log and continue.
        console.error('Resources workflow version snapshot error:', versionErr);
      }
    }

    return response;
  } catch (err) {
    console.error('Resources workflow transition error:', err);
    return bad('Could not perform this workflow action.', 500);
  }
}
