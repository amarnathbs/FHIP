// PO review F3 (06/10/2026) — delete a NEVER-PUBLISHED draft.
//
// One shared function used by the All Content list, every content editor
// (Article, Guide, FHIP Explainer, Money Update, Glossary, Video) and the
// DELETE route. Rules, all enforced here so no caller can skip one:
//
//  1. Only status 'idea' or 'draft' with published_at null. Published,
//     scheduled, in review, approved and archived content is never
//     hard-deleted: it follows the existing workflow (archive / unpublish).
//  2. A draft whose workflow history ever reached 'published' or 'scheduled'
//     (for example a published item later moved back to draft) is treated as
//     published content and is refused.
//  3. The DELETE statement itself repeats the status/published_at predicate,
//     so a concurrent publish between the check and the delete cannot be
//     deleted by mistake (the database decides, not the earlier read).
//  4. The caller's own request-scoped client performs the delete, so the
//     database's own policy ("managers delete posts") is the real boundary;
//     the route's capability check is the early, clear denial.
//  5. Child rows (versions, taxonomy links, related links, context links,
//     sources, FAQs links, workflow history, the video row) are removed by
//     the existing ON DELETE CASCADE foreign keys; counts are captured first
//     and written to the audit record.
//  6. An audit row (same resource_audit_log table and shape the shared
//     logResourceAudit writer uses) is written with the service-role client,
//     because that table has no authenticated INSERT policy. A failed audit
//     write cannot undo the delete, so it is reported back (auditWritten)
//     and the caller says so honestly.

import type { SupabaseClient } from '@supabase/supabase-js';

export const DELETABLE_DRAFT_STATUSES = ['idea', 'draft'] as const;

export function isNeverPublishedDraft(post: { status: string; published_at: string | null }): boolean {
  return (DELETABLE_DRAFT_STATUSES as readonly string[]).includes(post.status) && !post.published_at;
}

export const DELETE_REFUSED_MESSAGE = 'Only never-published drafts can be deleted. Published, scheduled, in-review and archived content follows the existing workflow (archive or unpublish) and is never deleted.';

export type DeleteDraftOutcome =
  | { status: 'deleted'; auditWritten: boolean; removed: Record<string, number> }
  | { status: 'not_found' }
  | { status: 'not_deletable'; reason: string }
  | { status: 'failed' };

const CHILD_TABLES: { table: string; column: string; label: string }[] = [
  { table: 'resource_post_versions', column: 'post_id', label: 'versions' },
  { table: 'resource_post_categories', column: 'post_id', label: 'categories' },
  { table: 'resource_post_tags', column: 'post_id', label: 'tags' },
  { table: 'resource_post_sources', column: 'post_id', label: 'sources' },
  { table: 'resource_post_faqs', column: 'post_id', label: 'faq_links' },
  { table: 'resource_related_content', column: 'source_post_id', label: 'related_links_out' },
  { table: 'resource_related_content', column: 'related_post_id', label: 'related_links_in' },
  { table: 'resource_context_links', column: 'resource_post_id', label: 'context_links' },
  { table: 'resource_videos', column: 'resource_post_id', label: 'video_rows' },
  { table: 'resource_workflow_history', column: 'post_id', label: 'workflow_history_rows' },
];

async function countChildren(supabase: SupabaseClient, postId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const c of CHILD_TABLES) {
    const { count } = await supabase.from(c.table).select('*', { count: 'exact', head: true }).eq(c.column, postId);
    out[c.label] = (out[c.label] ?? 0) + (count ?? 0);
  }
  return out;
}

export async function deleteNeverPublishedDraft(supabase: SupabaseClient, admin: SupabaseClient, postId: string, actorUserId: string): Promise<DeleteDraftOutcome> {
  const { data: post, error: readErr } = await supabase.from('resource_posts').select('id, title, content_type, status, published_at, created_by, slug, content_id').eq('id', postId).maybeSingle();
  if (readErr) return { status: 'failed' };
  if (!post) return { status: 'not_found' };

  if (!isNeverPublishedDraft(post as { status: string; published_at: string | null })) {
    return { status: 'not_deletable', reason: DELETE_REFUSED_MESSAGE };
  }

  // A draft that was ever published or scheduled is published content.
  const { data: everLive, error: histErr } = await supabase.from('resource_workflow_history').select('id').eq('post_id', postId).in('to_status', ['published', 'scheduled']).limit(1);
  if (histErr) return { status: 'failed' };
  if ((everLive ?? []).length > 0) return { status: 'not_deletable', reason: DELETE_REFUSED_MESSAGE };

  const removed = await countChildren(supabase, postId);

  const { data: deleted, error: delErr } = await supabase
    .from('resource_posts')
    .delete()
    .eq('id', postId)
    .in('status', DELETABLE_DRAFT_STATUSES as unknown as string[])
    .is('published_at', null)
    .select('id');
  if (delErr) return { status: 'failed' };
  if (!deleted || deleted.length === 0) {
    // The row changed state (or the database policy denied it) between the
    // read and the delete. Nothing was removed.
    return { status: 'not_deletable', reason: DELETE_REFUSED_MESSAGE };
  }

  let auditWritten = true;
  try {
    const { error: auditErr } = await admin.from('resource_audit_log').insert({
      entity_type: 'resource_post',
      entity_id: postId,
      action: 'RESOURCE_DRAFT_DELETED',
      actor_user_id: actorUserId,
      before_state: { title: post.title, content_type: post.content_type, status: post.status, slug: post.slug, content_id: post.content_id, created_by: post.created_by },
      after_state: null,
      metadata: { removed_relationships: removed, reason: 'never_published_draft_deleted_by_authorised_admin' },
    });
    if (auditErr) auditWritten = false;
  } catch {
    auditWritten = false;
  }
  return { status: 'deleted', auditWritten, removed };
}
