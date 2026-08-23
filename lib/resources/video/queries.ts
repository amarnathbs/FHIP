// R1.4 Video query layer — same convention as lib/resources/editor/queries.ts
// and lib/resources/admin/queries.ts (spec §70/§71 of R1.1, carried forward):
// every function takes the caller's own request-scoped, RLS-authenticated
// Supabase client, never service-role.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ContentListFilters } from '@/lib/resources/admin/filters';
import type { RelatedOption } from '@/lib/resources/editor/types';
import type { VideoEditorPost, VideoRow } from './types';

export interface VideoListItem {
  id: string;
  title: string;
  jurisdiction: string;
  status: string;
  compliance_classification: string;
  published_at: string | null;
  updated_at: string;
  primary_category: RelatedOption | null;
  youtube_video_id: string;
  duration_seconds: number | null;
  thumbnail_url: string | null;
}

export interface VideoListResult {
  items: VideoListItem[];
  total: number;
  page: number;
  pageSize: number;
}

function sanitizeSearchTerm(raw: string): string {
  return raw.replace(/[%,()*]/g, '').trim();
}

// List pages request metadata only (spec §124: "Do not fetch transcripts /
// chapters ... for list pages unnecessarily") — transcript/chapters are
// never selected here.
const LIST_COLUMNS =
  'id, title, jurisdiction, status, compliance_classification, published_at, updated_at, ' +
  'primary_category:resource_categories!primary_category_id(id,name), ' +
  'video:resource_videos!resource_post_id(youtube_video_id, duration_seconds, thumbnail_url)';

export async function getVideoList(
  supabase: SupabaseClient,
  filters: Pick<ContentListFilters, 'search' | 'status' | 'jurisdiction' | 'compliance' | 'sort' | 'page' | 'pageSize'>
): Promise<VideoListResult> {
  let query = supabase.from('resource_posts').select(LIST_COLUMNS, { count: 'exact' }).eq('content_type', 'video');

  if (filters.status !== 'all') query = query.eq('status', filters.status);
  if (filters.jurisdiction !== 'all') query = query.eq('jurisdiction', filters.jurisdiction);
  if (filters.compliance !== 'all') query = query.eq('compliance_classification', filters.compliance);

  const q = sanitizeSearchTerm(filters.search);
  if (q) query = query.ilike('title', `%${q}%`);

  const sortMap: Record<string, { column: string; ascending: boolean }> = {
    updated_desc: { column: 'updated_at', ascending: false },
    updated_asc: { column: 'updated_at', ascending: true },
    title_asc: { column: 'title', ascending: true },
    published_desc: { column: 'published_at', ascending: false },
  };
  const { column, ascending } = sortMap[filters.sort] ?? sortMap.updated_desc;
  query = query.order(column, { ascending, nullsFirst: false });

  const from = (filters.page - 1) * filters.pageSize;
  const to = from + filters.pageSize - 1;
  query = query.range(from, to);

  const { data, error, count } = await query;
  if (error) throw error;

  const items = ((data ?? []) as unknown as Record<string, unknown>[]).map((row) => {
    const video = (Array.isArray(row.video) ? row.video[0] : row.video) as { youtube_video_id?: string; duration_seconds?: number | null; thumbnail_url?: string | null } | null;
    return {
      id: row.id,
      title: row.title,
      jurisdiction: row.jurisdiction,
      status: row.status,
      compliance_classification: row.compliance_classification,
      published_at: row.published_at,
      updated_at: row.updated_at,
      primary_category: row.primary_category ?? null,
      youtube_video_id: video?.youtube_video_id ?? '',
      duration_seconds: video?.duration_seconds ?? null,
      thumbnail_url: video?.thumbnail_url ?? null,
    } as VideoListItem;
  });

  return { items, total: count ?? 0, page: filters.page, pageSize: filters.pageSize };
}

const EDITOR_POST_COLUMNS = [
  'id',
  'content_id',
  'title',
  'slug',
  'excerpt',
  'content_blocks',
  'content_type',
  'jurisdiction',
  'difficulty',
  'freshness_type',
  'visibility',
  'primary_category_id',
  'featured_image_id',
  'author_id',
  'reviewer_id',
  'compliance_reviewer_id',
  'status',
  'compliance_classification',
  'scheduled_at',
  'published_at',
  'expires_at',
  'last_reviewed_at',
  'next_review_at',
  'seo_title',
  'seo_description',
  'canonical_url',
  'social_image_id',
  'is_indexable',
  'primary_cta_id',
  'secondary_cta_id',
  'is_featured',
  'featured_priority',
  'editorial_approved_by',
  'editorial_approved_at',
  'compliance_approved_by',
  'compliance_approved_at',
  'created_by',
  'created_at',
  'updated_by',
  'updated_at',
].join(', ');

export async function getVideoEditorPost(supabase: SupabaseClient, id: string): Promise<VideoEditorPost | null> {
  const { data: post, error } = await supabase.from('resource_posts').select(EDITOR_POST_COLUMNS).eq('id', id).eq('content_type', 'video').maybeSingle();
  if (error) throw error;
  if (!post) return null;

  const [{ data: categoryLinks }, { data: tagLinks }, { data: video }] = await Promise.all([
    supabase.from('resource_post_categories').select('category:resource_categories!category_id(id,name)').eq('post_id', id).eq('is_primary', false),
    supabase.from('resource_post_tags').select('tag:resource_tags!tag_id(id,name)').eq('post_id', id),
    supabase.from('resource_videos').select('*').eq('resource_post_id', id).maybeSingle(),
  ]);

  return {
    ...(post as unknown as VideoEditorPost),
    categories: ((categoryLinks ?? []) as unknown as { category: RelatedOption }[]).map((r) => r.category).filter(Boolean),
    tags: ((tagLinks ?? []) as unknown as { tag: RelatedOption }[]).map((r) => r.tag).filter(Boolean),
    video: (video as VideoRow | null) ?? null,
  };
}
