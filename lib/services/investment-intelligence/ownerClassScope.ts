/**
 * Investment Intelligence API routes: optional `?ownerClass=<key>` scope
 * (2026-10-01, PO decision: show everything, in a separate breakup per owner class).
 *
 *   (absent) / "all"  -> the existing consolidated behaviour, unchanged. The UI labels
 *                         it "Consolidated (macro view only)".
 *   "member:<id>" | "joint" | "entity:<id>" | "entity_shared" | "unallocated"
 *                      -> the SAME certified loaders and engines, run on a READ-ONLY
 *                         client narrowed to that class's accounts. No formula changes;
 *                         the engines just receive that class's rows.
 *
 * A scoped run NEVER persists (the routes skip their persistence step when
 * `active`), so a per-class result can never overwrite the consolidated derived rows.
 * The key is validated against the caller's OWN classes (every query is filtered by
 * user_id); an unknown key, or another user's, is a 404 with no existence leak.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { bad } from '@/lib/api';
import { loadOwnerClassContext, scopeClientToAccounts, type OwnerClassInfo } from './ownerClass';

export type OwnerClassScope<C> =
  | { ok: true; active: false; client: C; ownerClass: null }
  | { ok: true; active: true; client: C; ownerClass: OwnerClassInfo }
  | { ok: false; response: Response };

export async function resolveOwnerClassScope<C extends SupabaseClient>(request: Request, supabase: C, userId: string): Promise<OwnerClassScope<C>> {
  const key = new URL(request.url).searchParams.get('ownerClass');
  if (!key || key === 'all') return { ok: true, active: false, client: supabase, ownerClass: null };
  const ctx = await loadOwnerClassContext(supabase, userId);
  const info = ctx.classes.find((c) => c.key === key);
  if (!info) return { ok: false, response: bad('Owner class not found.', 404, 'OWNER_CLASS_NOT_FOUND') };
  return { ok: true, active: true, client: scopeClientToAccounts(supabase, ctx.accountIdsByClass.get(key) ?? []), ownerClass: info };
}

/** The `ownerClass` field every scoped-capable route adds to its response. */
export const ownerClassField = (scope: { active: boolean; ownerClass: OwnerClassInfo | null }) =>
  scope.active && scope.ownerClass ? { key: scope.ownerClass.key, label: scope.ownerClass.label, kind: scope.ownerClass.kind } : { key: 'all', label: 'Consolidated (macro view only)', kind: 'consolidated' as const };
