// PO review F3 (06/10/2026) — an in-memory, UNSAVED editor post.
//
// Opening Create Article / Guide / FHIP Explainer must not write anything to
// the database. The editor is handed this blank, never-persisted post (id is
// the empty string) and only creates a record when the author presses Save.
// Defaults match the original draft-creation defaults exactly (see
// createResourceDraft in ./mutations.ts), so a record created on first Save is
// identical to one the old create-on-open flow would have produced, except it
// carries the author's own title and content from the very first write.

import { starterTemplateFor } from './blocks';
import type { EditableContentType, EditorPost } from './types';

export function blankEditorPost(contentType: EditableContentType, userId: string | null): EditorPost {
  const now = new Date(0).toISOString();
  return {
    id: '',
    content_id: null,
    title: '',
    slug: null,
    excerpt: null,
    content_blocks: starterTemplateFor(contentType),
    content_type: contentType,
    jurisdiction: 'global',
    difficulty: null,
    freshness_type: 'evergreen',
    visibility: 'private',
    primary_category_id: null,
    featured_image_id: null,
    author_id: null,
    reviewer_id: null,
    compliance_reviewer_id: null,
    status: 'draft',
    compliance_classification: 'green',
    scheduled_at: null,
    published_at: null,
    expires_at: null,
    last_reviewed_at: null,
    next_review_at: null,
    seo_title: null,
    seo_description: null,
    canonical_url: null,
    social_image_id: null,
    is_indexable: false,
    primary_cta_id: null,
    secondary_cta_id: null,
    is_featured: false,
    featured_priority: null,
    editorial_approved_by: null,
    editorial_approved_at: null,
    compliance_approved_by: null,
    compliance_approved_at: null,
    created_by: userId,
    created_at: now,
    updated_by: userId,
    updated_at: now,
    event_date: null,
    affected_audience: null,
    aliases: null,
    categories: [],
    tags: [],
  };
}

// Client-safe helper shared by every editor: create the record on the first
// explicit Save. Returns the new id and its updated_at (needed for the
// optimistic-concurrency check on the follow-up PATCH).
export type CreateOnSaveResult = { ok: true; id: string; updatedAt: string } | { ok: false; status: number; error: string; fields?: Record<string, string> };

export async function createRecordOnFirstSave(url: string, body: Record<string, unknown>): Promise<CreateOnSaveResult> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, error: json.error ?? 'Could not create this record.', fields: json.fields };
    return { ok: true, id: json.data.id as string, updatedAt: json.data.updated_at as string };
  } catch {
    return { ok: false, status: 0, error: 'Could not reach the server. Nothing was created.' };
  }
}
