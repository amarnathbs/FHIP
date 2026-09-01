// POST /api/user/primary-country/confirm — spec section 14.2. The ONLY
// route that ever calls confirm_primary_country_change() (migration 0122,
// SECURITY DEFINER). Requires a preview_id from ../preview/route.ts and a
// client-supplied idempotency key (spec: "Idempotency key" is a required
// confirmation input — the client generates and retries with the same key
// on network failure; the server treats a repeat as a no-op replay rather
// than a second application, see the RPC's own idempotent-replay branch).
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';

const confirmSchema = z.object({
  preview_id: z.string().uuid(),
  idempotency_key: z.string().min(1).max(200).optional(),
});

export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const parsed = confirmSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return bad('INVALID_REQUEST', 422);

  const supabase = await createClient();
  const idempotencyKey = parsed.data.idempotency_key ?? randomUUID();

  const { data, error } = await supabase.rpc('confirm_primary_country_change', {
    p_preview_id: parsed.data.preview_id,
    p_idempotency_key: idempotencyKey,
  });

  if (error) {
    const message = error.message ?? '';
    if (message.includes('PREVIEW_NOT_FOUND')) return bad('PREVIEW_NOT_FOUND', 404);
    if (message.includes('PREVIEW_ALREADY_CONSUMED')) return bad('PREVIEW_ALREADY_CONSUMED', 409);
    if (message.includes('PREVIEW_EXPIRED')) return bad('PREVIEW_EXPIRED', 410);
    if (message.includes('PREVIEW_STALE')) return bad('PREVIEW_STALE', 409);
    if (message.includes('COUNTRY_NOT_SELECTABLE')) return bad('COUNTRY_NOT_SELECTABLE', 422);
    if (message.includes('UNAUTHENTICATED')) return bad('UNAUTHENTICATED', 401);
    return bad('OPERATIONAL_ERROR', 500);
  }

  return ok(data);
}
