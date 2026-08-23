// Resources Admin query layer — spec §65-71.
//
// Every function here takes the caller's own request-scoped, RLS-authenticated
// Supabase client (never the service-role client — spec §70/§71: "the whole
// purpose of R1.1 RLS is to enforce role-appropriate access... the Admin UI
// must demonstrate that the R1.1 RLS model works in real application usage").
// A caller with no Resources role sees exactly what `staff read all posts` /
// `public read published posts` in supabase/migrations/0033 allow — nothing
// here widens that.
//
// List/dashboard queries never select `content_blocks` (spec §34/§91) — that
// JSON body is only needed once a real editor exists (R1.3+).

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ContentListFilters } from './filters';
import type { ResourceStatus } from '@/lib/resources/types';

export interface RelatedRef {
  id: string;
  name: string;
}

export interface ContentListItem {
  id: string;
  content_id: string | null;
  title: string;
  slug: string | null;
  content_type: string;
  jurisdiction: string;
  status: string;
  compliance_classification: string;
  updated_at: string;
  next_review_at: string | null;
  published_at: string | null;
  scheduled_at: string | null;
  primary_category: RelatedRef | null;
  author: RelatedRef | null;
}

export interface ContentListResult {
  items: ContentListItem[];
  total: number;
  page: number;
  pageSize: number;
}

// Author is aliased `name:display_name` so the embedded object matches the
// { id, name } RelatedRef shape shared with categories/tags — the
// underlying resource_authors column is display_name, not name.
const LIST_COLUMNS =
  'id, content_id, title, slug, content_type, jurisdiction, status, compliance_classification, updated_at, next_review_at, published_at, scheduled_at, ' +
  'primary_category:resource_categories!primary_category_id(id,name), author:resource_authors!author_id(id,name:display_name)';

const SORT_MAP: Record<ContentListFilters['sort'], { column: string; ascending: boolean }> = {
  updated_desc: { column: 'updated_at', ascending: false },
  updated_asc: { column: 'updated_at', ascending: true },
  title_asc: { column: 'title', ascending: true },
  published_desc: { column: 'published_at', ascending: false },
  review_asc: { column: 'next_review_at', ascending: true },
};

// PostgREST's `.or()` filter syntax uses `,` and `()` as structural
// characters and `%`/`_` are ilike wildcards — strip them from user search
// input rather than trying to escape them, so a search containing any of
// these characters degrades to a slightly-broader-than-literal match
// instead of breaking the filter expression or letting a user inject extra
// OR clauses.
function sanitizeSearchTerm(raw: string): string {
  return raw.replace(/[%,()*]/g, '').trim();
}

export async function getResourceContentList(
  supabase: SupabaseClient,
  filters: ContentListFilters,
  presetStatuses?: ResourceStatus[]
): Promise<ContentListResult> {
  let query = supabase.from('resource_posts').select(LIST_COLUMNS, { count: 'exact' });

  if (presetStatuses && presetStatuses.length > 0) {
    query = query.in('status', presetStatuses);
  } else if (filters.status !== 'all') {
    query = query.eq('status', filters.status);
  }
  if (filters.contentType !== 'all') query = query.eq('content_type', filters.contentType);
  if (filters.jurisdiction !== 'all') query = query.eq('jurisdiction', filters.jurisdiction);
  if (filters.compliance !== 'all') query = query.eq('compliance_classification', filters.compliance);
  if (filters.categoryId !== 'all') query = query.eq('primary_category_id', filters.categoryId);

  const q = sanitizeSearchTerm(filters.search);
  if (q) query = query.or(`title.ilike.%${q}%,content_id.ilike.%${q}%,slug.ilike.%${q}%`);

  const { column, ascending } = SORT_MAP[filters.sort] ?? SORT_MAP.updated_desc;
  query = query.order(column, { ascending, nullsFirst: false });

  const from = (filters.page - 1) * filters.pageSize;
  const to = from + filters.pageSize - 1;
  query = query.range(from, to);

  const { data, error, count } = await query;
  if (error) throw error;
  return {
    items: (data ?? []) as unknown as ContentListItem[],
    total: count ?? 0,
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

export interface ContentDetail {
  id: string;
  content_id: string | null;
  title: string;
  slug: string | null;
  excerpt: string | null;
  content_type: string;
  jurisdiction: string;
  difficulty: string | null;
  freshness_type: string;
  visibility: string;
  status: string;
  compliance_classification: string;
  primary_category: RelatedRef | null;
  author: RelatedRef | null;
  reviewer: RelatedRef | null;
  compliance_reviewer: RelatedRef | null;
  scheduled_at: string | null;
  published_at: string | null;
  expires_at: string | null;
  last_reviewed_at: string | null;
  next_review_at: string | null;
  seo_title: string | null;
  seo_description: string | null;
  canonical_url: string | null;
  is_indexable: boolean;
  primary_cta: { id: string; label: string } | null;
  secondary_cta: { id: string; label: string } | null;
  is_featured: boolean;
  featured_priority: number | null;
  editorial_approved_at: string | null;
  compliance_approved_at: string | null;
  created_at: string;
  updated_at: string;
  categories: RelatedRef[];
  tags: RelatedRef[];
  video: { youtube_video_id: string; youtube_url: string; youtube_channel_handle: string; embed_enabled: boolean } | null;
}

const DETAIL_COLUMNS =
  'id, content_id, title, slug, excerpt, content_type, jurisdiction, difficulty, freshness_type, visibility, status, compliance_classification, ' +
  'scheduled_at, published_at, expires_at, last_reviewed_at, next_review_at, seo_title, seo_description, canonical_url, is_indexable, ' +
  'is_featured, featured_priority, editorial_approved_at, compliance_approved_at, created_at, updated_at, ' +
  'primary_category:resource_categories!primary_category_id(id,name), ' +
  'author:resource_authors!author_id(id,name:display_name), reviewer:resource_authors!reviewer_id(id,name:display_name), compliance_reviewer:resource_authors!compliance_reviewer_id(id,name:display_name), ' +
  'primary_cta:resource_ctas!primary_cta_id(id,label), secondary_cta:resource_ctas!secondary_cta_id(id,label)';

export async function getResourceContentById(supabase: SupabaseClient, id: string): Promise<ContentDetail | null> {
  const { data: post, error } = await supabase.from('resource_posts').select(DETAIL_COLUMNS).eq('id', id).maybeSingle();
  // A denied-by-RLS row and a genuinely-nonexistent row both come back as
  // "no row" from PostgREST (RLS filters it out before it ever reaches the
  // client) — maybeSingle() returning null covers both, and the caller
  // renders the same generic "not found" state either way (spec §96: never
  // reveal "this draft exists but you don't have permission").
  if (error) throw error;
  if (!post) return null;

  const [{ data: categoryLinks }, { data: tagLinks }, { data: video }] = await Promise.all([
    supabase.from('resource_post_categories').select('category:resource_categories!category_id(id,name)').eq('post_id', id),
    supabase.from('resource_post_tags').select('tag:resource_tags!tag_id(id,name)').eq('post_id', id),
    supabase.from('resource_videos').select('youtube_video_id, youtube_url, youtube_channel_handle, embed_enabled').eq('resource_post_id', id).maybeSingle(),
  ]);

  type Row = Record<string, unknown>;
  const p = post as unknown as Row;
  return {
    ...(p as unknown as ContentDetail),
    categories: ((categoryLinks ?? []) as unknown as { category: RelatedRef }[]).map((r) => r.category).filter(Boolean),
    tags: ((tagLinks ?? []) as unknown as { tag: RelatedRef }[]).map((r) => r.tag).filter(Boolean),
    video: (video as ContentDetail['video']) ?? null,
  };
}

export interface WorkflowHistoryEntry {
  id: string;
  from_status: string | null;
  to_status: string;
  actor_role: string | null;
  action: string;
  reason: string | null;
  created_at: string;
}

// Read-only workflow history (spec §62) — never displays the raw `metadata`
// JSONB column, and never an actor's name (the RLS policy on
// resource_workflow_history has no join path to a display name for an
// arbitrary auth.users id; role is the meaningful, safe-to-show identity
// here — matches the spec's own worked example: "Published ... by Publisher").
export async function getResourceWorkflowHistory(supabase: SupabaseClient, postId: string): Promise<WorkflowHistoryEntry[]> {
  const { data, error } = await supabase
    .from('resource_workflow_history')
    .select('id, from_status, to_status, actor_role, action, reason, created_at')
    .eq('post_id', postId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as WorkflowHistoryEntry[];
}

export async function getResourceCategoriesForFilter(supabase: SupabaseClient): Promise<RelatedRef[]> {
  const { data, error } = await supabase.from('resource_categories').select('id, name').eq('is_active', true).order('sort_order', { ascending: true });
  if (error) throw error;
  return (data ?? []) as RelatedRef[];
}

export interface DashboardSummary {
  counts: {
    published: number;
    drafts: number;
    inReview: number;
    approved: number;
    scheduled: number;
    reviewDue: number;
    archived: number;
  };
  needsAttention: {
    editorialReview: { count: number; items: ContentListItem[] };
    complianceReview: { count: number; items: ContentListItem[] };
    reviewDue: { count: number; items: ContentListItem[] };
    scheduledSoon: { count: number; items: ContentListItem[] };
  };
  recent: ContentListItem[];
}

async function countByStatus(supabase: SupabaseClient, statuses: ResourceStatus[]): Promise<number> {
  const { count, error } = await supabase.from('resource_posts').select('id', { count: 'exact', head: true }).in('status', statuses);
  if (error) throw error;
  return count ?? 0;
}

async function listByStatus(supabase: SupabaseClient, statuses: ResourceStatus[], orderColumn: string, ascending: boolean, limit: number): Promise<ContentListItem[]> {
  const { data, error } = await supabase
    .from('resource_posts')
    .select(LIST_COLUMNS)
    .in('status', statuses)
    .order(orderColumn, { ascending, nullsFirst: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as unknown as ContentListItem[];
}

// Dashboard counts/queues derive from live, RLS-scoped queries only — spec
// §15: "Counts must be derived server-side from actual accessible Resources
// records... A user should see counts consistent with their permitted
// access." No number here is hard-coded, and no service-role client is used
// (the caller passes its own request-scoped client, same as every other
// function in this file).
export async function getResourceDashboardSummary(supabase: SupabaseClient): Promise<DashboardSummary> {
  const nowIso = new Date().toISOString();
  const sevenDaysIso = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const [published, drafts, inReview, approved, scheduled, reviewDue, archived, editorialReviewCount, complianceReviewCount, reviewDueItems, scheduledSoonItems, recent] =
    await Promise.all([
      countByStatus(supabase, ['published']),
      countByStatus(supabase, ['idea', 'draft']),
      countByStatus(supabase, ['editorial_review', 'compliance_review']),
      // 'approved' is a real, reachable workflow state (content that has
      // completed editorial and, for AMBER, compliance review but has not
      // been published). It previously had no tile at all, so approved
      // content was absent from every Content Overview count while still
      // being listed and filterable under All Content. Added in R1.7D-FINAL,
      // the first pass in which P0 content actually reached this state.
      countByStatus(supabase, ['approved']),
      countByStatus(supabase, ['scheduled']),
      countByStatus(supabase, ['review_due']),
      countByStatus(supabase, ['archived']),
      countByStatus(supabase, ['editorial_review']),
      countByStatus(supabase, ['compliance_review']),
      listByStatus(supabase, ['review_due'], 'next_review_at', true, 5),
      supabase
        .from('resource_posts')
        .select(LIST_COLUMNS)
        .eq('status', 'scheduled')
        .lte('scheduled_at', sevenDaysIso)
        .order('scheduled_at', { ascending: true })
        .limit(5)
        .then(({ data, error }) => {
          if (error) throw error;
          return (data ?? []) as unknown as ContentListItem[];
        }),
      listByStatus(supabase, ['idea', 'draft', 'editorial_review', 'compliance_review', 'approved', 'scheduled', 'published', 'review_due'], 'updated_at', false, 8),
    ]);

  const editorialReviewItems = await listByStatus(supabase, ['editorial_review'], 'updated_at', false, 5);
  const complianceReviewItems = await listByStatus(supabase, ['compliance_review'], 'updated_at', false, 5);

  void nowIso; // reserved for a future "review date passed" informational badge — see §59, deliberately not automating any status change here.

  return {
    counts: { published, drafts, inReview, approved, scheduled, reviewDue, archived },
    needsAttention: {
      editorialReview: { count: editorialReviewCount, items: editorialReviewItems },
      complianceReview: { count: complianceReviewCount, items: complianceReviewItems },
      reviewDue: { count: reviewDue, items: reviewDueItems },
      scheduledSoon: { count: scheduledSoonItems.length, items: scheduledSoonItems },
    },
    recent,
  };
}
