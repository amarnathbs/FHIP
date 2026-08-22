// R1.6 — FHIP Contextual Integration query layer (spec Part D).
//
// Two very different audiences read this table, so two very different
// functions exist:
//   - resolveContextResource(): the PUBLIC path. Called from inside
//     authenticated FHIP surfaces (Dashboard, Score, ...) through the plain
//     request-scoped client — same "never service-role, RLS is the
//     backstop" rule as every other public Resources query (spec §63: "Even
//     inside authenticated FHIP: mapped Resources must satisfy normal public
//     visibility... A normal customer must never see Draft Resources").
//   - listContextMappings()/etc: the STAFF admin path, gated by
//     canManageDiscovery() in the API route, reading every mapping
//     (including ones pointing at non-public posts, so an editor can see
//     what they are about to activate).

import type { SupabaseClient } from '@supabase/supabase-js';
import { isPubliclyVisible } from '@/lib/resources/public/visibility';
import { isRegisteredContextKey, getContextDefinition } from './registry';

export interface ResolvedContextResource {
  slug: string;
  title: string;
  contentType: string;
}

interface RawContextRow {
  id: string;
  sort_order: number;
  resource: {
    slug: string | null;
    title: string;
    status: string;
    visibility: string;
    published_at: string | null;
    content_type: string;
  } | null;
}

/**
 * Resolves a context key to the single best publicly-visible Resource, or
 * null if none exists / the mapped Resource(s) are not currently public
 * (spec §62: "If no valid public Resource is mapped: render nothing. Do not
 * display 'No help available'."). Deterministic: lowest sort_order among
 * active mappings that pass isPubliclyVisible() wins (spec §57's
 * "primary/default Resource" — resource_context_links has no separate
 * boolean flag, so sort_order 0 is the documented convention for "the
 * primary/default one", same pattern resource_related_content already uses
 * for its own sort_order column).
 */
export async function resolveContextResource(supabase: SupabaseClient, contextKey: string): Promise<ResolvedContextResource | null> {
  if (!isRegisteredContextKey(contextKey)) return null; // spec §58/§96 — unknown keys never even reach the DB

  const { data, error } = await supabase
    .from('resource_context_links')
    .select('id, sort_order, resource:resource_posts!resource_post_id(slug,title,status,visibility,published_at,content_type)')
    .eq('context_key', contextKey)
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .limit(5);
  if (error) throw error;

  const rows = (data ?? []) as unknown as RawContextRow[];
  for (const row of rows) {
    const r = row.resource;
    // RLS already narrows `resource` to null for a non-public embedded post
    // (the new "public read active context links to public posts" policy
    // requires it, but a staff-scoped caller — e.g. this same function used
    // from a preview context — could still see a non-public one, hence the
    // explicit isPubliclyVisible() re-check here too, exactly mirroring how
    // getPublicResourceBySlug/related content re-verify rather than trusting
    // RLS alone).
    if (!r || !r.slug) continue;
    if (!isPubliclyVisible({ status: r.status, visibility: r.visibility, published_at: r.published_at, content_type: r.content_type })) continue;
    return { slug: r.slug, title: r.title, contentType: r.content_type };
  }
  return null;
}

/**
 * Batch form of resolveContextResource() for a Server Component page that
 * needs several context keys at once (e.g. the Dashboard's vital-sign
 * cards) and cannot mount an async Server Component per-card inside its
 * existing 'use client' tree — see WhatDoesThisMeanLink.tsx's header for why
 * this split exists. Runs the same per-key resolution in parallel; still
 * exactly one round trip per key (small, bounded — the whole registry is a
 * few dozen entries at most), no join query fancier than that is worth the
 * complexity for this data size.
 */
export async function resolveContextResources(supabase: SupabaseClient, contextKeys: string[]): Promise<Record<string, ResolvedContextResource | null>> {
  const entries = await Promise.all(contextKeys.map(async (key) => [key, await resolveContextResource(supabase, key)] as const));
  return Object.fromEntries(entries);
}

// --- Admin management (spec §57/§78) ----------------------------------------

export interface ContextMappingRow {
  id: string;
  context_key: string;
  module: string;
  metric_or_feature: string | null;
  label: string;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  resource: { id: string; title: string; slug: string | null; content_type: string; status: string } | null;
}

export async function listContextMappings(supabase: SupabaseClient, contextKey?: string): Promise<ContextMappingRow[]> {
  let query = supabase
    .from('resource_context_links')
    .select('id, context_key, module, metric_or_feature, label, sort_order, is_active, created_at, updated_at, resource:resource_posts!resource_post_id(id,title,slug,content_type,status)')
    .order('context_key', { ascending: true })
    .order('sort_order', { ascending: true });
  if (contextKey) query = query.eq('context_key', contextKey);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as unknown as ContextMappingRow[];
}

export interface ContextMappingPatch {
  context_key: string;
  resource_post_id: string;
  metric_or_feature: string | null;
  sort_order: number;
  is_active: boolean;
}

export async function createContextMapping(supabase: SupabaseClient, patch: ContextMappingPatch): Promise<{ id: string }> {
  if (!isRegisteredContextKey(patch.context_key)) throw new Error('Unknown context key.');
  const registryEntry = getContextDefinition(patch.context_key)!;
  const { data, error } = await supabase
    .from('resource_context_links')
    .insert({
      context_key: patch.context_key,
      module: registryEntry.module,
      label: registryEntry.label,
      metric_or_feature: patch.metric_or_feature,
      resource_post_id: patch.resource_post_id,
      sort_order: patch.sort_order,
      is_active: patch.is_active,
    })
    .select('id')
    .single();
  if (error) throw error;
  return { id: data.id as string };
}

export async function updateContextMapping(supabase: SupabaseClient, id: string, patch: Partial<Pick<ContextMappingPatch, 'sort_order' | 'is_active' | 'metric_or_feature'>>): Promise<void> {
  const { error } = await supabase
    .from('resource_context_links')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteContextMapping(supabase: SupabaseClient, id: string): Promise<void> {
  const { error } = await supabase.from('resource_context_links').delete().eq('id', id);
  if (error) throw error;
}

// --- Bidirectional: Resource -> FHIP action (spec §64/§100) -----------------

export interface UseInFhipAction {
  label: string;
  route: string;
  module: string;
}

/**
 * The reverse lookup for a Resource detail page's "Use this in FHIP" action
 * (spec §64/§140.Q). Deterministic: any active mapping pointing at this post
 * resolves to that context's registry route — no fuzzy matching (spec §68).
 */
export async function getUseInFhipActionsForPost(supabase: SupabaseClient, postId: string): Promise<UseInFhipAction[]> {
  const { data, error } = await supabase.from('resource_context_links').select('context_key, module, label').eq('resource_post_id', postId).eq('is_active', true).order('sort_order', { ascending: true });
  if (error) throw error;
  const seen = new Set<string>();
  const actions: UseInFhipAction[] = [];
  for (const row of (data ?? []) as { context_key: string; module: string; label: string }[]) {
    const def = getContextDefinition(row.context_key);
    if (!def || seen.has(def.route)) continue; // dedupe by destination route — no reason to show "Open Dashboard" three times
    seen.add(def.route);
    actions.push({ label: `Use this in FHIP: ${row.label}`, route: def.route, module: row.module });
  }
  return actions;
}
