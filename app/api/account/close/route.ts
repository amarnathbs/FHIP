import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';

// LR-9 WP-06/WP-07 — the user-facing side of account closure. Creating a
// request here NEVER deletes anything itself — it only queues a request an
// authorised Admin must separately review and execute
// (app/api/admin/account-deletions/[id]/execute/route.ts). WP-06's own
// lock: "Do not immediately hard-delete on accidental click."

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('account_deletion_requests')
    .select('*')
    .eq('user_id', user.id)
    .order('requested_at', { ascending: false });
  return error ? bad(error.message) : ok(data);
}

const closeRequestSchema = z.object({ reason: z.string().max(2000).nullable().optional() });

export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = closeRequestSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return bad(parsed.error.message, 422);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('account_deletion_requests')
    .insert({ user_id: user.id, reason: parsed.data.reason ?? null, status: 'pending' })
    .select()
    .single();
  if (error) {
    // uq_account_deletion_requests_one_active_per_user (migration 0132) —
    // WP-07's idempotency requirement: a user cannot forge a second
    // concurrent active request even via a direct API race.
    if (error.code === '23505') {
      return bad('You already have a pending account-closure request.', 409);
    }
    return bad(error.message);
  }
  return ok(data);
}
