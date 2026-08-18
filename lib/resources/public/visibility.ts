// Resources / Financial Knowledge & Insights — R1.5 public visibility rule.
//
// This is the single place that encodes "what is a member of the public
// allowed to see" (spec §8/§9/§13). Every public query in
// lib/resources/public/queries.ts routes through the helpers here rather
// than re-deriving the predicate ad hoc, so the rule can never drift between
// the landing page, topic page, and detail dispatcher.
//
// --- What the actual R1.1 RLS policy allows (audited, not assumed) --------
// migration 0033's "public read published posts" policy (the DB-level
// backstop every anon/authenticated read of resource_posts and everything
// joined to it goes through) is:
//
//   status in ('published', 'review_due', 'archived')
//   and visibility in ('public', 'unlisted')
//   and published_at is not null
//   and published_at <= now()
//
// --- R1.5's product-level policy is intentionally NARROWER than that ------
// RLS is a security ceiling/backstop (defense in depth), not automatically
// the UX policy this phase should present. R1.5 spec §10/§11 requires this
// project to make its own explicit, documented decision rather than assume
// the RLS predicate is the intended public-facing behaviour:
//
//   review_due (spec §10): audited via docs/resources/R1.1-completion-report
//   and the transition RPC (migration 0033 §920 —
//   `elsif p_to_status = 'review_due' or p_to_status = 'archived'`, reachable
//   only from a Publisher/Manager, with no separate "unpublish" semantics
//   anywhere in the workflow). review_due is a post that was already
//   published and simply has an internal review flag raised — nothing in
//   the workflow removes it from public view when this happens. Decision:
//   review_due content REMAINS PUBLIC. It is included below.
//
//   archived (spec §11): the RLS policy technically permits reading it, but
//   no R0/R0-B document exists anywhere in this repository defining an
//   approved public archive experience (checked — no R0-B file exists in
//   this codebase at all; it is an external document R1.5 was not given
//   direct access to). Per spec §11's explicit default ("Preferred public
//   behaviour: 404 for archived content unless the approved specification
//   explicitly requires an archive... do not expose internal archive status
//   to visitors"), archived content is EXCLUDED from every public query and
//   list below, and a direct-URL request for one 404s exactly like a
//   nonexistent slug (spec §71/§86) — this file's exclusion is what makes
//   that true, not a second check in the route.
//
// money_update_template (spec §9): the RLS predicate is keyed on
// status/visibility/published_at, not content_type — so a template that
// somehow reached status='published' would pass RLS. The application layer
// is the only thing standing between that and public exposure, so every
// query below excludes content_type = 'money_update_template' explicitly
// and unconditionally, never relying on the template's status alone.
//
// expires_at (spec §12): expired time-sensitive content is NOT hidden or
// unpublished automatically — it stays visible with a freshness warning
// (components/resources/public/FreshnessWarning.tsx) rather than a second,
// undocumented visibility rule invented here.

import type { SupabaseClient } from '@supabase/supabase-js';

// The exact set of resource_posts.status values R1.5 treats as publicly
// readable. Deliberately does NOT include 'archived' — see header above.
export const PUBLIC_STATUSES = ['published', 'review_due'] as const;

// Content types that must never render on a public page, regardless of
// status — money_update_template is CMS-internal scaffolding (spec §9/§25).
export const PUBLIC_EXCLUDED_CONTENT_TYPES = ['money_update_template'] as const;

// Content types the public frontend actually renders (used to build the
// dispatcher's switch and the type filter — spec §25 also excludes
// money_update_template from the filter's own option list).
export const PUBLIC_CONTENT_TYPES = ['article', 'guide', 'fhip_explainer', 'video', 'glossary', 'money_update'] as const;
export type PublicContentType = (typeof PUBLIC_CONTENT_TYPES)[number];

/**
 * Applies the R1.5 public visibility predicate to a resource_posts query
 * (or any query builder chained from `.from('resource_posts')`). Every
 * list/detail query in queries.ts must call this — it is the one place the
 * status/visibility/published_at/content_type rule is expressed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- PostgrestFilterBuilder's generic signature is not exported in a way that stays stable across supabase-js versions; every call site below immediately re-narrows the return type via its own .select()/.eq() chain.
export function applyPublicPostVisibility<T extends { in: any; not: any; lte: any }>(query: T): T {
  return query
    .in('status', PUBLIC_STATUSES as unknown as string[])
    .in('visibility', ['public', 'unlisted'])
    .not('published_at', 'is', null)
    .lte('published_at', new Date().toISOString())
    // Positive allowlist rather than a NOT-IN negation on content_type — an
    // allowlist fails safe (a brand-new content_type this file doesn't know
    // about is excluded by default) where a negation would fail open.
    .in('content_type', PUBLIC_CONTENT_TYPES as unknown as string[]);
}

/** True if a given status/content_type/visibility/published_at combination would be publicly visible. Used by defensive checks (e.g. a detail page confirming its own fetched row) rather than trusting the query filter alone. */
export function isPubliclyVisible(post: {
  status: string;
  visibility: string;
  published_at: string | null;
  content_type: string;
}): boolean {
  if (!(PUBLIC_STATUSES as readonly string[]).includes(post.status)) return false;
  if (!['public', 'unlisted'].includes(post.visibility)) return false;
  if (!post.published_at) return false;
  if (new Date(post.published_at).getTime() > Date.now()) return false;
  if ((PUBLIC_EXCLUDED_CONTENT_TYPES as readonly string[]).includes(post.content_type)) return false;
  return true;
}

export function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() < Date.now();
}

// Type helper only, no runtime behaviour — documents that this module never
// imports lib/supabase/admin.ts. Referencing SupabaseClient here (rather
// than `any`) is itself part of spec §13/§118's enforcement: every function
// in queries.ts is typed to take the ordinary anon/authenticated client.
export type PublicSupabaseClient = SupabaseClient;
