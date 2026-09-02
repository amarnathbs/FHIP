// R1.6 Related Content — Admin management (spec §39-40, §77).
//
// Standalone management surface at /admin/resources/related (spec §39: "or
// integrate into the content editor if cleaner... Do not require SQL/admin
// scripts for ordinary curation"). Kept standalone rather than a new panel
// inside the certified R1.3 ResourceEditor — spec §76 explicitly allows
// this ("If standalone management screens are safer for R1.6, use them.
// Document the choice.") and it avoids touching the certified core editor's
// autosave/version/workflow wiring at all. Documented choice, not an
// oversight.

import type { SupabaseClient } from '@supabase/supabase-js';
import { STATUS_LABELS, CONTENT_TYPE_LABELS } from '@/lib/resources/admin/labels';
import type { ResourceStatus, ResourceContentType } from '@/lib/resources/types';

export const RELATIONSHIP_TYPES = ['related', 'prerequisite', 'next_step', 'see_also'] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

export const RELATIONSHIP_TYPE_LABELS: Record<RelationshipType, string> = {
  related: 'Related',
  prerequisite: 'Prerequisite',
  next_step: 'Next Step',
  see_also: 'See Also',
};

export interface RelatableSearchResult {
  id: string;
  title: string;
  content_type: string;
  jurisdiction: string;
  status: string;
  slug: string | null;
}

// spec §77: "title search; content type; jurisdiction; status visible to
// staff. But should clearly mark unpublished items if Admin can select
// them." Every row here is staff-visible regardless of publication status
// (RLS "staff read all posts") — the caller's UI is responsible for showing
// the status label so an editor sees exactly what they're about to link;
// the *public renderer* (lib/resources/discovery/related.ts) is what
// actually suppresses non-public targets, unconditionally, independent of
// what an editor picked here (spec §34).
export async function searchRelatableContent(supabase: SupabaseClient, search: string, opts: { contentType?: string; jurisdiction?: string; excludePostId?: string } = {}): Promise<RelatableSearchResult[]> {
  let query = supabase.from('resource_posts').select('id, title, content_type, jurisdiction, status, slug').order('updated_at', { ascending: false }).limit(25);
  const q = search.trim().slice(0, 200).replace(/[%_]/g, '\\$&');
  if (q) query = query.ilike('title', `%${q}%`);
  if (opts.contentType && opts.contentType !== 'all') query = query.eq('content_type', opts.contentType);
  if (opts.jurisdiction && opts.jurisdiction !== 'all') query = query.eq('jurisdiction', opts.jurisdiction);
  if (opts.excludePostId) query = query.neq('id', opts.excludePostId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as RelatableSearchResult[];
}

export interface RelatedContentAdminRow {
  id: string;
  relationship_type: RelationshipType;
  sort_order: number;
  related: { id: string; title: string; content_type: string; status: string; slug: string | null } | null;
}

export async function listRelatedContentForSource(supabase: SupabaseClient, sourcePostId: string): Promise<RelatedContentAdminRow[]> {
  const { data, error } = await supabase
    .from('resource_related_content')
    .select('id, relationship_type, sort_order, related:resource_posts!related_post_id(id,title,content_type,status,slug)')
    .eq('source_post_id', sourcePostId)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as RelatedContentAdminRow[];
}

export async function addRelatedContent(supabase: SupabaseClient, sourcePostId: string, relatedPostId: string, relationshipType: RelationshipType): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (sourcePostId === relatedPostId) return { ok: false, error: 'A Resource cannot be related to itself.' }; // spec §32, defence-in-depth ahead of the DB constraint
  const { data: maxRow } = await supabase.from('resource_related_content').select('sort_order').eq('source_post_id', sourcePostId).order('sort_order', { ascending: false }).limit(1);
  const nextSort = ((maxRow?.[0]?.sort_order as number | undefined) ?? -1) + 1;
  const { data, error } = await supabase
    .from('resource_related_content')
    .insert({ source_post_id: sourcePostId, related_post_id: relatedPostId, relationship_type: relationshipType, sort_order: nextSort })
    .select('id')
    .single();
  if (error) {
    if (error.code === '23505') return { ok: false, error: 'This relationship already exists.' }; // spec §33 dedupe, backed by uq_resource_related_content
    if (error.code === '23514') return { ok: false, error: 'A Resource cannot be related to itself.' };
    throw error;
  }
  return { ok: true, id: data.id as string };
}

// Admin A0.2 Wave 4 (PO4-4 / DEF4-10): a plain `.delete().eq('id', id)` with
// no `.select()` succeeds (error === null) whether zero or one row actually
// matched — PostgREST's DELETE does not error on zero matched rows. That
// made this function report "removed" for an id that never existed. It now
// returns whether a row genuinely existed and was deleted, so the calling
// route can return the canonical zero-row contract: first successful
// deletion -> 200 (existing compatible shape); already-gone/unknown id ->
// 404, not a false 200.
export async function removeRelatedContent(supabase: SupabaseClient, id: string): Promise<{ deleted: boolean }> {
  const { data, error } = await supabase.from('resource_related_content').delete().eq('id', id).select('id');
  if (error) throw error;
  return { deleted: (data ?? []).length > 0 };
}

// spec §39: "reorder if existing schema supports order" — it does
// (resource_related_content.sort_order).
//
// Admin A0.2 Wave 2 (Scope A). This used to be a Promise.all of N
// independent `.update()` calls — each its own PostgREST request and its own
// autocommitted transaction — with no transaction, no validation that the
// payload described the complete set, and no locking. A failure part-way
// through left the already-committed positions committed, so the ordering
// ended up duplicated, gapped, or a blend of two concurrent requests, while
// the caller received a bare HTTP 500. Reproduced against a real database in
// scripts/admin_a02_wave2_certification.mjs (SECTIONS 1-2) before this
// replacement was written.
//
// It is now a single call to public.admin_reorder_related_content (migration
// 0116), which is one transaction: it validates the payload as the COMPLETE
// ordered set for exactly one source, locks that set, writes every position
// in one statement, and returns the committed ordering read back from the
// table. It succeeds completely or changes nothing.
//
// SECURITY — privileged-RPC PATTERN A (caller-context), per the Product
// Owner's governance ruling of 2026-08-31. Reordering Related Content is an
// interactive action by a logged-in Editor / Resource Admin / Super Admin, so
// the caller's context is KEPT: this must be called with the administrator's
// own request-scoped Supabase client, never a service-role client. The RPC's
// EXECUTE is granted to `authenticated` (revoked from public, anon and
// service_role), it takes the actor from auth.uid() — there is no actor
// parameter to spoof — it fails closed on a null auth.uid(), and it rechecks
// private.can_manage_discovery(auth.uid()) against the canonical role tables
// itself. The route's canManageDiscovery() check remains as defence in depth
// and for a friendly error; the database check is the authoritative one.
// (Migrations 0107/0109 stay on Pattern B as documented server-only bulk
// import/upsert exceptions — a different architecture, not a precedent here.)

export const MAX_RELATED_REORDER_ITEMS = 100; // mirrors the RPC's own cap

export type ReorderFailureKind = 'invalid' | 'not_found' | 'conflict' | 'forbidden' | 'error';

export interface ReorderedRelatedContent {
  source_post_id: string;
  count: number;
  ordered: { id: string; sort_order: number }[];
}

export type ReorderResult = { ok: true; data: ReorderedRelatedContent } | { ok: false; kind: ReorderFailureKind; message: string };

// SQLSTATEs raised deliberately by admin_reorder_related_content. Anything
// else is an unexpected server fault and is never surfaced verbatim.
//
// '55000' (object_not_in_prerequisite_state) — NOT '40001' — for the stale/
// incomplete link-set conflict. Migration 0116 originally raised '40001'
// (serialization_failure, Class 40 "Transaction Rollback"); a live-DEV
// investigation (docs/admin/FHIP_A02_Wave2_Residual_Gate_Investigation_Report.md)
// found that specific code path never once delivered its intended response
// live across 13 independent attempts — it either timed out at a strikingly
// consistent ~125.2s or came back with a spurious 42501 — while the RPC's own
// logic proved sound in every other respect. The Product Owner ruled to move
// off Class 40 (which some layer in the stack may treat as automatically
// retryable) to a code with no such conventional retry semantics. Migration
// 0118 (CREATE OR REPLACE, no other change) makes the RPC raise '55000'
// instead — the same code this codebase already uses for analogous
// object-not-in-expected-state conflicts (0084_geo_jurisdiction_smsf.sql,
// 0090_smsf_current_balance_integrity_guard.sql). '40001' is deliberately
// NOT listed here any more: the RPC no longer raises it, and if it were ever
// seen it should fall through to the generic 'error' kind rather than being
// silently treated as a deliberate conflict.
const REORDER_ERROR_KINDS: Record<string, ReorderFailureKind> = {
  '42501': 'forbidden', // insufficient_privilege — see FORBIDDEN_MESSAGE below
  '22023': 'invalid', // invalid_parameter_value — payload shape/content
  P0002: 'not_found', // source Resource does not exist
  '55000': 'conflict', // the link set changed since the client loaded it (was 40001 pre-0118)
};

// 42501 has two possible origins and they must be indistinguishable to the
// client: the RPC's own "not authenticated" / "not permitted" guards, and
// PostgreSQL's own "permission denied for function ..." from a missing
// EXECUTE grant. The second of those names an internal object, so the RPC's
// message is never passed through for this kind — a single fixed sentence is
// returned for both.
const FORBIDDEN_MESSAGE = "You don't have permission to manage Related Content.";

// The RPC's messages are written for administrators and are safe to show, but
// they are prefixed with the function name for server logs. Strip that so the
// UI shows a clean sentence, and never pass through a message we did not
// author (i.e. an unexpected SQLSTATE).
function cleanRpcMessage(message: string): string {
  return message.replace(/^admin_reorder_related_content:\s*/, '').trim();
}

export async function reorderRelatedContent(supabase: SupabaseClient, sourcePostId: string, orderedIds: string[]): Promise<ReorderResult> {
  const { data, error } = await supabase.rpc('admin_reorder_related_content', {
    p_source_post_id: sourcePostId,
    p_ordered_ids: orderedIds,
  });

  if (error) {
    const kind = REORDER_ERROR_KINDS[error.code ?? ''];
    if (!kind) {
      // Unexpected SQLSTATE (or a transport failure). Log the detail
      // server-side; never leak a raw SQL error to the client.
      console.error('Resources related-content reorder RPC error:', error);
      return { ok: false, kind: 'error', message: 'Could not reorder related content.' };
    }
    if (kind === 'forbidden') {
      // Log the distinction server-side (a missing grant is an operational
      // fault worth seeing) but never expose it.
      console.error('Resources related-content reorder denied by the database:', error);
      return { ok: false, kind, message: FORBIDDEN_MESSAGE };
    }
    return { ok: false, kind, message: cleanRpcMessage(error.message ?? '') || 'Could not reorder related content.' };
  }

  return { ok: true, data: data as ReorderedRelatedContent };
}

export function formatStatusForPicker(status: string): string {
  return STATUS_LABELS[status as ResourceStatus] ?? status;
}

export function formatContentTypeForPicker(contentType: string): string {
  return CONTENT_TYPE_LABELS[contentType as ResourceContentType] ?? contentType;
}
