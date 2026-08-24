// R1.3 editor query layer — same convention as lib/resources/admin/queries.ts
// (spec §70/§71): every function takes the caller's own request-scoped,
// RLS-authenticated Supabase client, never service-role. Kept in its own
// file rather than growing admin/queries.ts because these queries are
// editor-specific (they fetch content_blocks, which the R1.2 list/dashboard
// queries deliberately never do — see that file's header comment).

import type { SupabaseClient } from '@supabase/supabase-js';
import type { EditorPost, RelatedOption, EditorReferenceData, PostVersionSummary } from './types';
import { AUTHOR_ELIGIBLE_ROLES, REVIEWER_ELIGIBLE_ROLES, COMPLIANCE_REVIEWER_ELIGIBLE_ROLES, getEligibleUserIdSet } from '@/lib/resources/admin/userRoles';
import type { ResourceRole } from '@/lib/resources/types';

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

// Loads the full editor-shape post, including content_blocks (spec §129:
// "Editor query should fetch one post plus required metadata" — not the
// entire Resources table, not audit history). RLS ("staff read all posts" /
// "public read published posts") decides whether this returns a row at all;
// a null return here means "not found or not visible to this caller" —
// callers must render the same generic not-found state either way (spec §96).
export async function getResourceEditorPost(supabase: SupabaseClient, id: string): Promise<EditorPost | null> {
  const { data: post, error } = await supabase.from('resource_posts').select(EDITOR_POST_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  if (!post) return null;

  const [{ data: categoryLinks }, { data: tagLinks }] = await Promise.all([
    supabase.from('resource_post_categories').select('category:resource_categories!category_id(id,name)').eq('post_id', id).eq('is_primary', false),
    supabase.from('resource_post_tags').select('tag:resource_tags!tag_id(id,name)').eq('post_id', id),
  ]);

  return {
    ...(post as unknown as EditorPost),
    categories: ((categoryLinks ?? []) as unknown as { category: RelatedOption }[]).map((r) => r.category).filter(Boolean),
    tags: ((tagLinks ?? []) as unknown as { tag: RelatedOption }[]).map((r) => r.tag).filter(Boolean),
  };
}

// Retained for backward compatibility (still used by GET
// /api/admin/resources/authors) — every *active* resource_authors row,
// undifferentiated by role. Prefer getEligibleResourcePeople() below for any
// new caller that needs role-correct Author/Reviewer/Compliance Reviewer
// eligibility (hotfix, see FHIP_RESOURCES_ADMIN_ROLE_CTA_MANAGEMENT_HOTFIX_
// REPORT.md section D).
export async function getResourceActiveAuthors(supabase: SupabaseClient): Promise<RelatedOption[]> {
  const { data, error } = await supabase.from('resource_authors').select('id, name:display_name').eq('is_active', true).order('display_name', { ascending: true });
  if (error) throw error;
  return (data ?? []) as RelatedOption[];
}

export async function getResourceActiveTags(supabase: SupabaseClient): Promise<RelatedOption[]> {
  const { data, error } = await supabase.from('resource_tags').select('id, name').eq('is_active', true).order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []) as RelatedOption[];
}

export async function getResourceActiveCTAs(supabase: SupabaseClient): Promise<RelatedOption[]> {
  const { data, error } = await supabase.from('resource_ctas').select('id, name:label').eq('is_active', true).order('label', { ascending: true });
  if (error) throw error;
  return (data ?? []) as RelatedOption[];
}

// Hotfix — root cause fix for the empty/unusable Author, Reviewer, and
// Compliance Reviewer dropdowns (see the completion report sections D/J-L).
// resource_posts.author_id / reviewer_id / compliance_reviewer_id all
// reference resource_authors(id), never auth.users(id) directly, so
// eligibility has to be computed by cross-referencing the *current* holders
// of the right Resources role (resource_user_roles, service-role only —
// self-read RLS blocks the ordinary client from seeing other users' rows)
// against the resource_authors rows those users have been auto-provisioned
// (lib/resources/admin/userRoles.ts's ensureResourceAuthorForUser(), called
// from role assignment). `adminClient` must be the service-role client
// (lib/supabase/admin.ts's createAdminClient()) — never exposed to a Client
// Component; every caller of this function is a Server Component or a
// server-side route handler.
async function getEligiblePeopleFor(supabase: SupabaseClient, adminClient: SupabaseClient, roles: ResourceRole[]): Promise<RelatedOption[]> {
  const eligibleIds = await getEligibleUserIdSet(adminClient, roles);
  if (eligibleIds.size === 0) return [];
  const { data, error } = await supabase.from('resource_authors').select('id, user_id, display_name').eq('is_active', true).in('user_id', Array.from(eligibleIds));
  if (error) throw error;
  return ((data ?? []) as { id: string; user_id: string | null; display_name: string }[]).map((row) => ({ id: row.id, name: row.display_name }));
}

export async function getEligibleResourceAuthors(supabase: SupabaseClient, adminClient: SupabaseClient): Promise<RelatedOption[]> {
  return getEligiblePeopleFor(supabase, adminClient, AUTHOR_ELIGIBLE_ROLES);
}

export async function getEligibleResourceReviewers(supabase: SupabaseClient, adminClient: SupabaseClient): Promise<RelatedOption[]> {
  return getEligiblePeopleFor(supabase, adminClient, REVIEWER_ELIGIBLE_ROLES);
}

export async function getEligibleResourceComplianceReviewers(supabase: SupabaseClient, adminClient: SupabaseClient): Promise<RelatedOption[]> {
  return getEligiblePeopleFor(supabase, adminClient, COMPLIANCE_REVIEWER_ELIGIBLE_ROLES);
}

// All active-record pickers in one round trip for the editor's initial load
// (spec §48/§57/§61: "Only select from existing active records"). Takes both
// the caller's request-scoped client (RLS-authenticated — used for the
// publicly-readable reference tables) and the service-role admin client
// (used only for the cross-user role lookups the three eligibility pickers
// need — see getEligiblePeopleFor above).
export async function getEditorReferenceData(supabase: SupabaseClient, adminClient: SupabaseClient): Promise<EditorReferenceData> {
  const [categoriesRes, tags, authors, reviewers, complianceReviewers, ctas] = await Promise.all([
    supabase.from('resource_categories').select('id, name').eq('is_active', true).order('sort_order', { ascending: true }),
    getResourceActiveTags(supabase),
    getEligibleResourceAuthors(supabase, adminClient),
    getEligibleResourceReviewers(supabase, adminClient),
    getEligibleResourceComplianceReviewers(supabase, adminClient),
    getResourceActiveCTAs(supabase),
  ]);
  if (categoriesRes.error) throw categoriesRes.error;
  return { categories: (categoriesRes.data ?? []) as RelatedOption[], tags, authors, reviewers, complianceReviewers, ctas };
}

export async function getResourcePostVersions(supabase: SupabaseClient, postId: string): Promise<PostVersionSummary[]> {
  const { data, error } = await supabase
    .from('resource_post_versions')
    .select('id, version_number, change_summary, created_by, created_at')
    .eq('post_id', postId)
    .order('version_number', { ascending: false });
  if (error) throw error;
  return (data ?? []) as PostVersionSummary[];
}

// Uniqueness must never be trusted client-side only (spec §20). `excludeId`
// lets an in-progress edit check its own current slug without false-positive
// colliding with itself.
export async function isSlugAvailable(supabase: SupabaseClient, slug: string, excludeId?: string): Promise<boolean> {
  let query = supabase.from('resource_posts').select('id').eq('slug', slug).limit(1);
  if (excludeId) query = query.neq('id', excludeId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).length === 0;
}

export async function isContentIdAvailable(supabase: SupabaseClient, contentId: string, excludeId?: string): Promise<boolean> {
  let query = supabase.from('resource_posts').select('id').eq('content_id', contentId).limit(1);
  if (excludeId) query = query.neq('id', excludeId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).length === 0;
}
