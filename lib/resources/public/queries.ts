// Resources / Financial Knowledge & Insights — R1.5 public query layer.
// Spec §13: "Every public query must use the normal anonymous/authenticated
// Supabase client under RLS. Do not use createAdminClient() or service-role
// to retrieve public content." Every function below takes a plain
// SupabaseClient (the caller's request-scoped anon/authenticated client from
// lib/supabase/server.ts) — nothing here imports lib/supabase/admin.ts.
//
// Spec §74/§75: list queries select metadata columns only (no
// content_blocks/transcript/workflow history) and batch joins (primary
// category, author, video thumbnail) in the same query rather than a
// per-card round trip. Detail queries (getPublicResourceBySlug) load the
// full block/video/FAQ/source payload a single reader needs, still nothing
// CMS-audit-only (no resource_workflow_history, no resource_post_versions).

import type { SupabaseClient } from '@supabase/supabase-js';
import { applyPublicPostVisibility, PUBLIC_STATUSES, type PublicContentType } from './visibility';
import { DEFAULT_RESOURCE_DISCLAIMER } from './metadata';

export interface PublicCategory {
  id: string;
  name: string;
  slug: string;
  description: string | null;
}

export interface PublicCategoryWithCount extends PublicCategory {
  publicCount: number;
}

export interface PublicCardVideo {
  thumbnail_url: string | null;
  duration_seconds: number | null;
}

export interface PublicResourceCard {
  id: string;
  slug: string | null;
  title: string;
  excerpt: string | null;
  content_type: PublicContentType;
  jurisdiction: string;
  difficulty: string | null;
  published_at: string | null;
  updated_at: string;
  event_date: string | null; // money_update only
  is_featured: boolean;
  featured_priority: number | null;
  primary_category: { id: string; name: string; slug: string } | null;
  video: PublicCardVideo | null;
}

const CARD_COLUMNS = [
  'id',
  'slug',
  'title',
  'excerpt',
  'content_type',
  'jurisdiction',
  'difficulty',
  'published_at',
  'updated_at',
  'event_date',
  'is_featured',
  'featured_priority',
  'primary_category:resource_categories!primary_category_id(id,name,slug)',
  'video:resource_videos(thumbnail_url,duration_seconds)',
].join(', ');

// Raw select shape before the single-video-row normalisation below —
// PostgREST returns the reverse resource_videos relationship as an array
// even though resource_videos.resource_post_id is unique (one video per
// post, migration 0033 §11), so every card query normalises it to a single
// object-or-null immediately after the fetch rather than repeating that
// unwrap at every render call site.
interface RawCardRow {
  id: string;
  slug: string | null;
  title: string;
  excerpt: string | null;
  content_type: string;
  jurisdiction: string;
  difficulty: string | null;
  published_at: string | null;
  updated_at: string;
  event_date: string | null;
  is_featured: boolean;
  featured_priority: number | null;
  primary_category: { id: string; name: string; slug: string } | null;
  video: PublicCardVideo[] | PublicCardVideo | null;
}

function normalizeCard(row: RawCardRow): PublicResourceCard {
  return {
    ...row,
    content_type: row.content_type as PublicContentType,
    video: Array.isArray(row.video) ? row.video[0] ?? null : row.video,
  };
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function paginate<T>(items: T[], total: number, page: number, pageSize: number): PaginatedResult<T> {
  return { items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

export type PublicJurisdictionFilter = 'all' | 'global' | 'australia' | 'india' | 'australia_india_cross_border';
export type PublicTypeFilter = 'all' | PublicContentType;

// Spec §87: "Document whether jurisdiction-specific filters show: exact
// jurisdiction only; or selected jurisdiction + Global." Decision (no R0
// text available to override the spec's own stated preference): the
// friendlier "selected jurisdiction + Global" behaviour. Selecting
// "Global" itself shows only Global (there is no broader tier above it).
function applyJurisdictionFilter<T extends { in: (col: string, vals: string[]) => T; eq: (col: string, val: string) => T }>(query: T, jurisdiction: PublicJurisdictionFilter): T {
  if (jurisdiction === 'all') return query;
  if (jurisdiction === 'global') return query.eq('jurisdiction', 'global');
  return query.in('jurisdiction', [jurisdiction, 'global']);
}

// -----------------------------------------------------------------------------
// Topic browsing (spec §21-26)
// -----------------------------------------------------------------------------

export async function getPublicCategories(supabase: SupabaseClient): Promise<PublicCategoryWithCount[]> {
  const { data: categories, error } = await supabase
    .from('resource_categories')
    .select('id, name, slug, description')
    .eq('is_active', true)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  if (!categories || categories.length === 0) return [];

  // Spec §22: "public Resource count if inexpensive/safe." The foundation
  // taxonomy is a handful of rows (5 seeded in R1.1, R1.7's full import
  // caps out at the approved ~14-category R0 taxonomy — spec §21) — one
  // small count query per category, run in parallel, is the inexpensive
  // case the spec allows; this does not scale per-card the way §74
  // prohibits for Resource cards themselves.
  // Queried FROM resource_posts (with an !inner join to
  // resource_post_categories) rather than the reverse, so
  // applyPublicPostVisibility's bare column names (status/visibility/etc.)
  // resolve against the primary table exactly as every other list query in
  // this file expects — see getPublicResourcesByTopic's header comment for
  // why the join-table-rooted form doesn't work with that shared helper.
  const counts = await Promise.all(
    categories.map(async (c) => {
      let q = supabase
        .from('resource_posts')
        .select('id, resource_post_categories!inner(category_id)', { count: 'exact', head: true })
        .eq('resource_post_categories.category_id', c.id);
      q = applyPublicPostVisibility(q as unknown as Parameters<typeof applyPublicPostVisibility>[0]) as unknown as typeof q;
      const { count, error: countErr } = await q;
      if (countErr) throw countErr;
      return count ?? 0;
    })
  );

  return categories.map((c, i) => ({ ...c, publicCount: counts[i] }));
}

export async function getPublicCategoryBySlug(supabase: SupabaseClient, slug: string): Promise<PublicCategory | null> {
  const { data, error } = await supabase.from('resource_categories').select('id, name, slug, description').eq('slug', slug).eq('is_active', true).maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export interface TopicFilters {
  jurisdiction: PublicJurisdictionFilter;
  type: PublicTypeFilter;
  page: number;
  pageSize?: number;
}

export async function getPublicResourcesByTopic(supabase: SupabaseClient, categoryId: string, filters: TopicFilters): Promise<PaginatedResult<PublicResourceCard>> {
  const pageSize = filters.pageSize ?? 12;
  const from = (filters.page - 1) * pageSize;
  const to = from + pageSize - 1;

  // Query FROM resource_posts (the primary/ordered table) with an !inner
  // join to resource_post_categories to filter by category — not the
  // reverse (querying FROM the join table and embedding resource_posts),
  // which would require ordering/pagination by an embedded relation's
  // column, a PostgREST embedded-resource order path this project's
  // supabase-js version does not support cleanly. Keeping resource_posts as
  // the primary table also means applyPublicPostVisibility's helper works
  // completely unchanged here, same as every other list query in this file.
  let query = supabase
    .from('resource_posts')
    .select(`${CARD_COLUMNS}, resource_post_categories!inner(category_id)`, { count: 'exact' })
    .eq('resource_post_categories.category_id', categoryId);
  query = applyPublicPostVisibility(query as unknown as Parameters<typeof applyPublicPostVisibility>[0]) as unknown as typeof query;

  if (filters.type !== 'all') query = query.eq('content_type', filters.type);
  query = applyJurisdictionFilter(query as unknown as Parameters<typeof applyJurisdictionFilter>[0], filters.jurisdiction) as unknown as typeof query;

  query = query.order('published_at', { ascending: false }).range(from, to);

  const { data, error, count } = await query;
  if (error) throw error;
  const items = ((data ?? []) as unknown as RawCardRow[]).map(normalizeCard);
  return paginate(items, count ?? 0, filters.page, pageSize);
}

// -----------------------------------------------------------------------------
// Landing page (spec §17-20)
// -----------------------------------------------------------------------------

export interface ResourcesLandingData {
  startHere: PublicResourceCard[];
  topics: PublicCategoryWithCount[];
  explainers: PublicResourceCard[];
  latestMoneyUpdates: PublicResourceCard[];
  latestVideos: PublicResourceCard[];
  glossaryPreview: { id: string; slug: string | null; title: string; excerpt: string | null }[];
}

// Spec §20: "Preferred signals: approved Start Here category; featured
// status; beginner difficulty; featured priority. Do not hard-code specific
// article IDs." Tries an actual "Start Here"-slugged category first (if
// R1.7 or a CMS editor has created one); falls back to the featured+beginner
// signal combination so the section still has something to show against the
// small R1.1 foundation taxonomy, which has no such category yet.
async function getStartHereCards(supabase: SupabaseClient): Promise<PublicResourceCard[]> {
  const { data: startHereCategory } = await supabase.from('resource_categories').select('id').eq('slug', 'start-here').eq('is_active', true).maybeSingle();

  if (startHereCategory) {
    let query = supabase
      .from('resource_posts')
      .select(`${CARD_COLUMNS}, resource_post_categories!inner(category_id)`)
      .eq('resource_post_categories.category_id', startHereCategory.id);
    query = applyPublicPostVisibility(query as unknown as Parameters<typeof applyPublicPostVisibility>[0]) as unknown as typeof query;
    const { data, error } = await query.order('featured_priority', { ascending: true, nullsFirst: false }).limit(6);
    if (error) throw error;
    const items = ((data ?? []) as unknown as RawCardRow[]).map(normalizeCard);
    if (items.length > 0) return items;
  }

  let query = supabase.from('resource_posts').select(CARD_COLUMNS).eq('is_featured', true).eq('difficulty', 'beginner');
  query = applyPublicPostVisibility(query as unknown as Parameters<typeof applyPublicPostVisibility>[0]) as unknown as typeof query;
  const { data, error } = await query.order('featured_priority', { ascending: true, nullsFirst: false }).limit(6);
  if (error) throw error;
  return ((data ?? []) as unknown as RawCardRow[]).map(normalizeCard);
}

export async function getResourcesLandingData(supabase: SupabaseClient): Promise<ResourcesLandingData> {
  const explainerCategoryQuery = supabase.from('resource_categories').select('id').eq('slug', 'fhip-explained').eq('is_active', true).maybeSingle();

  const [startHere, topics, explainerCategory, moneyUpdates, videos, glossary] = await Promise.all([
    getStartHereCards(supabase),
    getPublicCategories(supabase),
    explainerCategoryQuery,
    getPublicMoneyUpdates(supabase, { page: 1, pageSize: 3 }),
    getPublicVideos(supabase, { page: 1, pageSize: 3 }),
    supabase
      .from('resource_posts')
      .select('id, slug, title, excerpt')
      .eq('content_type', 'glossary')
      .in('status', PUBLIC_STATUSES as unknown as string[])
      .in('visibility', ['public', 'unlisted'])
      .not('published_at', 'is', null)
      .lte('published_at', new Date().toISOString())
      .order('title', { ascending: true })
      .limit(6),
  ]);

  let explainers: PublicResourceCard[] = [];
  if (explainerCategory.data) {
    let query = supabase
      .from('resource_posts')
      .select(`${CARD_COLUMNS}, resource_post_categories!inner(category_id)`)
      .eq('resource_post_categories.category_id', explainerCategory.data.id)
      .eq('content_type', 'fhip_explainer');
    query = applyPublicPostVisibility(query as unknown as Parameters<typeof applyPublicPostVisibility>[0]) as unknown as typeof query;
    const { data, error } = await query.order('published_at', { ascending: false }).limit(3);
    if (error) throw error;
    explainers = ((data ?? []) as unknown as RawCardRow[]).map(normalizeCard);
  }

  if (glossary.error) throw glossary.error;

  return {
    startHere,
    topics,
    explainers,
    latestMoneyUpdates: moneyUpdates.items,
    latestVideos: videos.items,
    glossaryPreview: glossary.data ?? [],
  };
}

// -----------------------------------------------------------------------------
// Videos (spec §33-39)
// -----------------------------------------------------------------------------

export async function getPublicVideos(supabase: SupabaseClient, opts: { page: number; pageSize?: number }): Promise<PaginatedResult<PublicResourceCard>> {
  const pageSize = opts.pageSize ?? 12;
  const from = (opts.page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = supabase.from('resource_posts').select(CARD_COLUMNS, { count: 'exact' }).eq('content_type', 'video');
  query = applyPublicPostVisibility(query as unknown as Parameters<typeof applyPublicPostVisibility>[0]) as unknown as typeof query;
  const { data, error, count } = await query.order('published_at', { ascending: false }).range(from, to);
  if (error) throw error;
  return paginate(((data ?? []) as unknown as RawCardRow[]).map(normalizeCard), count ?? 0, opts.page, pageSize);
}

// -----------------------------------------------------------------------------
// Glossary (spec §40-43)
// -----------------------------------------------------------------------------

export interface PublicGlossaryTerm {
  id: string;
  slug: string | null;
  title: string;
  excerpt: string | null;
  jurisdiction: string;
}

export async function getPublicGlossaryTerms(supabase: SupabaseClient): Promise<PublicGlossaryTerm[]> {
  let query = supabase.from('resource_posts').select('id, slug, title, excerpt, jurisdiction').eq('content_type', 'glossary');
  query = applyPublicPostVisibility(query as unknown as Parameters<typeof applyPublicPostVisibility>[0]) as unknown as typeof query;
  const { data, error } = await query.order('title', { ascending: true });
  if (error) throw error;
  return (data ?? []) as PublicGlossaryTerm[];
}

// -----------------------------------------------------------------------------
// Money Updates (spec §44-47)
// -----------------------------------------------------------------------------

export async function getPublicMoneyUpdates(supabase: SupabaseClient, opts: { page: number; pageSize?: number }): Promise<PaginatedResult<PublicResourceCard>> {
  const pageSize = opts.pageSize ?? 12;
  const from = (opts.page - 1) * pageSize;
  const to = from + pageSize - 1;

  // content_type = 'money_update' only — 'money_update_template' is not in
  // PUBLIC_CONTENT_TYPES at all, so applyPublicPostVisibility's own allowlist
  // would already exclude it even without this .eq, but being explicit here
  // means this function reads correctly on its own without relying on the
  // reader to know that upstream detail (spec §45: "Do not show templates").
  let query = supabase.from('resource_posts').select(CARD_COLUMNS, { count: 'exact' }).eq('content_type', 'money_update');
  query = applyPublicPostVisibility(query as unknown as Parameters<typeof applyPublicPostVisibility>[0]) as unknown as typeof query;
  // Sort primarily by event_date (spec §45's "appropriate approved
  // currentness field" — the real-world date the development occurred),
  // falling back to published_at for rows without one.
  const { data, error, count } = await query.order('event_date', { ascending: false, nullsFirst: false }).order('published_at', { ascending: false }).range(from, to);
  if (error) throw error;
  return paginate(((data ?? []) as unknown as RawCardRow[]).map(normalizeCard), count ?? 0, opts.page, pageSize);
}

// -----------------------------------------------------------------------------
// FAQs / Sources for a post (spec §50-52, §48-49)
// -----------------------------------------------------------------------------

export interface PublicFaq {
  id: string;
  question: string;
  short_answer: string | null;
  answer_blocks: unknown[];
  sort_order: number;
}

export async function getPublicFaqsForPost(supabase: SupabaseClient, postId: string): Promise<PublicFaq[]> {
  const { data, error } = await supabase
    .from('resource_post_faqs')
    .select('sort_order, faq:resource_faqs!inner(id,question,short_answer,answer_blocks,is_active)')
    .eq('post_id', postId)
    .eq('faq.is_active', true)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as unknown as { sort_order: number; faq: { id: string; question: string; short_answer: string | null; answer_blocks: unknown[] } }[]).map((r) => ({
    id: r.faq.id,
    question: r.faq.question,
    short_answer: r.faq.short_answer,
    answer_blocks: r.faq.answer_blocks ?? [],
    sort_order: r.sort_order,
  }));
}

export interface PublicSource {
  id: string;
  source_name: string;
  document_title: string | null;
  url: string | null;
  publication_date: string | null;
  sort_order: number;
}

export async function getPublicSourcesForPost(supabase: SupabaseClient, postId: string): Promise<PublicSource[]> {
  const { data, error } = await supabase
    .from('resource_post_sources')
    .select('sort_order, source:resource_sources!inner(id,source_name,document_title,url,publication_date,is_public)')
    .eq('post_id', postId)
    .eq('source.is_public', true)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as unknown as { sort_order: number; source: { id: string; source_name: string; document_title: string | null; url: string | null; publication_date: string | null } }[]).map((r) => ({
    id: r.source.id,
    source_name: r.source.source_name,
    document_title: r.source.document_title,
    url: r.source.url,
    publication_date: r.source.publication_date,
    sort_order: r.sort_order,
  }));
}

// -----------------------------------------------------------------------------
// Canonical detail dispatcher (spec §14, §29-32, §35, §42)
// -----------------------------------------------------------------------------

const DETAIL_COLUMNS = [
  'id',
  'title',
  'slug',
  'excerpt',
  'content_blocks',
  'content_type',
  'jurisdiction',
  'difficulty',
  'freshness_type',
  'visibility',
  'status',
  'published_at',
  'updated_at',
  'expires_at',
  'last_reviewed_at',
  'next_review_at',
  'seo_title',
  'seo_description',
  'canonical_url',
  'is_indexable',
  'event_date',
  'affected_audience',
  'aliases',
  'primary_category:resource_categories!primary_category_id(id,name,slug)',
  'author:resource_authors!author_id(id,display_name,role_title,bio,is_active)',
].join(', ');

export interface PublicResourceDetail {
  id: string;
  title: string;
  slug: string | null;
  excerpt: string | null;
  content_blocks: unknown[];
  content_type: PublicContentType;
  jurisdiction: string;
  difficulty: string | null;
  freshness_type: string;
  visibility: string;
  status: string;
  published_at: string | null;
  updated_at: string;
  expires_at: string | null;
  last_reviewed_at: string | null;
  next_review_at: string | null;
  seo_title: string | null;
  seo_description: string | null;
  canonical_url: string | null;
  is_indexable: boolean;
  event_date: string | null;
  affected_audience: string | null;
  aliases: string[] | null;
  primary_category: { id: string; name: string; slug: string } | null;
  author: { id: string; display_name: string; role_title: string | null; bio: string | null } | null;
  video: {
    youtube_video_id: string;
    youtube_url: string;
    youtube_channel_handle: string;
    youtube_channel_url: string | null;
    duration_seconds: number | null;
    thumbnail_url: string | null;
    youtube_published_at: string | null;
    transcript: string | null;
    chapters: { id: string; timestamp: string; title: string }[];
    embed_enabled: boolean;
  } | null;
  relatedGlossaryTerms: { id: string; slug: string | null; title: string }[];
  faqs: PublicFaq[];
  sources: PublicSource[];
}

/**
 * The single canonical public detail fetch (spec §14). Returns null for
 * anything not currently public — an unpublished draft, a scheduled post,
 * an archived post, a private/unlisted-elsewhere row, or a nonexistent slug
 * — with no distinction between those cases in the return value, which is
 * exactly what spec §71/§86 requires ("do not reveal 'this article exists
 * but hasn't been published'"). The caller (app/(marketing)/resources/[slug]/page.tsx)
 * turns a null result into an ordinary 404 via notFound().
 */
export async function getPublicResourceBySlug(supabase: SupabaseClient, slug: string): Promise<PublicResourceDetail | null> {
  let query = supabase.from('resource_posts').select(DETAIL_COLUMNS).eq('slug', slug);
  query = applyPublicPostVisibility(query as unknown as Parameters<typeof applyPublicPostVisibility>[0]) as unknown as typeof query;
  const { data: post, error } = await query.maybeSingle();
  if (error) throw error;
  if (!post) return null;

  const p = post as unknown as Record<string, unknown>;
  const id = p.id as string;
  const contentType = p.content_type as string;

  const [videoResult, relatedResult, faqs, sources] = await Promise.all([
    contentType === 'video'
      ? supabase
          .from('resource_videos')
          .select('youtube_video_id,youtube_url,youtube_channel_handle,youtube_channel_url,duration_seconds,thumbnail_url,youtube_published_at,transcript,chapters,embed_enabled')
          .eq('resource_post_id', id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    contentType === 'glossary'
      ? supabase.from('resource_related_content').select('related:resource_posts!related_post_id(id,slug,title)').eq('source_post_id', id).eq('relationship_type', 'related')
      : Promise.resolve({ data: [], error: null }),
    getPublicFaqsForPost(supabase, id),
    getPublicSourcesForPost(supabase, id),
  ]);

  if (videoResult.error) throw videoResult.error;
  if (relatedResult.error) throw relatedResult.error;

  const author = p.author as { id: string; display_name: string; role_title: string | null; bio: string | null; is_active: boolean } | null;

  return {
    id,
    title: p.title as string,
    slug: p.slug as string | null,
    excerpt: p.excerpt as string | null,
    content_blocks: (p.content_blocks as unknown[]) ?? [],
    content_type: contentType as PublicContentType,
    jurisdiction: p.jurisdiction as string,
    difficulty: p.difficulty as string | null,
    freshness_type: p.freshness_type as string,
    visibility: p.visibility as string,
    status: p.status as string,
    published_at: p.published_at as string | null,
    updated_at: p.updated_at as string,
    expires_at: p.expires_at as string | null,
    last_reviewed_at: p.last_reviewed_at as string | null,
    next_review_at: p.next_review_at as string | null,
    seo_title: p.seo_title as string | null,
    seo_description: p.seo_description as string | null,
    canonical_url: p.canonical_url as string | null,
    is_indexable: p.is_indexable as boolean,
    event_date: p.event_date as string | null,
    affected_audience: p.affected_audience as string | null,
    aliases: (p.aliases as string[] | null) ?? [],
    primary_category: p.primary_category as { id: string; name: string; slug: string } | null,
    // Spec §54: never expose auth IDs/email/private admin metadata — this
    // selection never includes resource_authors.user_id, and an inactive
    // author record (author.is_active === false) is treated as "no public
    // author" rather than showing a retired/removed staff member's name.
    author: author && author.is_active ? { id: author.id, display_name: author.display_name, role_title: author.role_title, bio: author.bio } : null,
    video: videoResult.data ? (videoResult.data as unknown as NonNullable<PublicResourceDetail['video']>) : null,
    relatedGlossaryTerms: ((relatedResult.data ?? []) as unknown as { related: { id: string; slug: string | null; title: string } }[]).map((r) => r.related).filter(Boolean),
    faqs,
    sources,
  };
}

// -----------------------------------------------------------------------------
// Sitemap (spec §69, §107-108) — metadata only, no content_blocks.
// -----------------------------------------------------------------------------

export interface SitemapEntry {
  slug: string;
  updated_at: string;
}

export async function getPublicResourceSitemapEntries(supabase: SupabaseClient): Promise<SitemapEntry[]> {
  let query = supabase.from('resource_posts').select('slug, updated_at').eq('is_indexable', true).not('slug', 'is', null);
  query = applyPublicPostVisibility(query as unknown as Parameters<typeof applyPublicPostVisibility>[0]) as unknown as typeof query;
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as SitemapEntry[];
}

// -----------------------------------------------------------------------------
// Central disclaimer (spec §57)
// -----------------------------------------------------------------------------

// Reads the live DB value first (migration 0039's narrow public read
// policy — see that file's header for why the RLS policy didn't already
// permit this) and falls back to the identical hardcoded default if the
// read returns nothing, which covers both "migration not yet applied in
// this environment" and "row not seeded" without ever showing a blank
// disclaimer. Called once per page render from a single shared component
// (components/resources/public/CentralDisclaimer.tsx), not re-implemented
// per content type.
export async function getCentralDisclaimer(supabase: SupabaseClient, key: 'default_disclaimer' = 'default_disclaimer'): Promise<string> {
  try {
    const { data, error } = await supabase.from('resource_settings').select('value').eq('key', key).maybeSingle();
    if (error || !data) return DEFAULT_RESOURCE_DISCLAIMER;
    const value = data.value;
    return typeof value === 'string' ? value : DEFAULT_RESOURCE_DISCLAIMER;
  } catch {
    return DEFAULT_RESOURCE_DISCLAIMER;
  }
}
