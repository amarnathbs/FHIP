// POST /api/user/billing-country/confirm — spec section 6.7/17. Not called
// from anywhere in this codebase's UI yet — no checkout exists (see this
// task's G0-D3 finding). Exists so G5's future checkout has a single,
// already-tested confirmation entry point (confirm_billing_country RPC,
// migration 0122) rather than writing billing_country directly.
import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';

const schema = z.object({ billing_country: z.string().length(2) });

export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return bad('INVALID_REQUEST', 422);

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('confirm_billing_country', {
    p_billing_country: parsed.data.billing_country.trim().toUpperCase(),
  });

  if (error) {
    const message = error.message ?? '';
    if (message.includes('BILLING_COUNTRY_NOT_SELECTABLE')) return bad('BILLING_COUNTRY_NOT_SELECTABLE', 422);
    if (message.includes('UNAUTHENTICATED')) return bad('UNAUTHENTICATED', 401);
    return bad('OPERATIONAL_ERROR', 500);
  }

  return ok(data);
}
