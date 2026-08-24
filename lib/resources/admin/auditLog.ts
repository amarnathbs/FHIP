// Shared resource_audit_log writer (spec §27: "CTA changes should also use
// the existing audit convention where available. Do not invent a parallel
// audit system.") resource_audit_log grants zero authenticated INSERT (see
// supabase/migrations/0049 §18's RLS section: "No INSERT policy — audit rows
// are written exclusively by the transition RPC and by service-role code
// paths"), so every caller here must pass the service-role admin client
// (lib/supabase/admin.ts's createAdminClient()), never the request-scoped
// client. This is a best-effort side write: a failure here must never fail
// the caller's actual mutation (the CTA/role change itself already
// succeeded) — callers should call this after the primary write commits and
// swallow any error from it, same as every other non-critical side-effect
// write in this codebase.

import type { SupabaseClient } from '@supabase/supabase-js';

export async function logResourceAudit(
  admin: SupabaseClient,
  entry: {
    entity_type: string;
    entity_id: string | null;
    action: string;
    actor_user_id: string;
    before_state?: unknown;
    after_state?: unknown;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  try {
    await admin.from('resource_audit_log').insert({
      entity_type: entry.entity_type,
      entity_id: entry.entity_id,
      action: entry.action,
      actor_user_id: entry.actor_user_id,
      before_state: entry.before_state ?? null,
      after_state: entry.after_state ?? null,
      metadata: entry.metadata ?? {},
    });
  } catch (err) {
    console.error('resource_audit_log write failed (non-fatal):', err);
  }
}
