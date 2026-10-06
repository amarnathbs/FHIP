// Resources Bulk Upload -- API access guards. Every import route calls ONE of these first, so the
// order is identical everywhere: 401 (not signed in) -> country gate -> 403 (capability) -> work.
// A denied caller always gets an explicit 401/403, never an empty 200 (Standard section 4).

import type { SupabaseClient, User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { bad } from '@/lib/api';
import { canBulkImportResources, canCreateSpecialistContent, getCurrentResourceRoles, type CurrentResourceRoles } from '@/lib/resources/permissions';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';

export type GuardResult = { ok: true; supabase: SupabaseClient; user: User; current: CurrentResourceRoles } | { ok: false; response: Response };

async function base(): Promise<{ ok: true; supabase: SupabaseClient; user: User } | { ok: false; response: Response }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, response: bad('unauthenticated', 401) };
  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return { ok: false, response: countryBlock };
  return { ok: true, supabase, user };
}

/** Upload, preview, history, results download, apply: capability resources.content.bulk_import. */
export async function guardBulkImport(): Promise<GuardResult> {
  const b = await base();
  if (!b.ok) return b;
  const current = await getCurrentResourceRoles();
  if (!canBulkImportResources(current)) return { ok: false, response: bad("You don't have permission to bulk upload Resources content.", 403) };
  return { ...b, current };
}

/** Template download: anyone who can create Resources content by hand (Apply is tighter). */
export async function guardTemplateDownload(): Promise<GuardResult> {
  const b = await base();
  if (!b.ok) return b;
  const current = await getCurrentResourceRoles();
  if (!canCreateSpecialistContent(current) && !canBulkImportResources(current)) return { ok: false, response: bad("You don't have permission to download Resources upload templates.", 403) };
  return { ...b, current };
}
