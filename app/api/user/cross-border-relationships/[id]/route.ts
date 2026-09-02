// PATCH /api/user/cross-border-relationships/[id] — end-date a relationship
// (spec section 13/21.4 "End-dated relationship"). Never allows a client to
// change user_id, country_code or relationship_type on an existing row —
// only status/end_date, and only to end it, never to reactivate (matches
// this app's existing INSERT/reactivation-only gating convention, e.g.
// SMSF's trigger, migration 0084).
import { z } from 'zod';
// G3 section 9/10: generic-experience users may manage their own
// declarations (see ../route.ts).
import { requireCountryConfirmedUserAllowingGeneric as requireUser, ok, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';

const endSchema = z.object({ end_date: z.string().date().optional() });

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const { id } = await params;
  const parsed = endSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return bad('INVALID_REQUEST', 422);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('cross_border_relationships')
    .update({ status: 'ENDED', end_date: parsed.data.end_date ?? new Date().toISOString().slice(0, 10), updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', user.id)
    .eq('status', 'ACTIVE')
    .select('id, country_code, relationship_type, status, end_date')
    .maybeSingle();

  if (error) return bad('OPERATIONAL_ERROR', 500);
  if (!data) return bad('NOT_FOUND_OR_ALREADY_ENDED', 404);
  return ok(data);
}
