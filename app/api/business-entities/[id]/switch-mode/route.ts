import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { smsfRpcError } from '@/lib/services/smsfErrors';
import { businessEntityAssetSchema, businessEntityLiabilitySchema } from '@/lib/validation/businessEntity';

// Itemised OR net value only for a Company, Family Trust or HUF (migration 0297). PREVIEW-FIRST: with confirm false (the default) NOTHING changes
// and the response is { status: 'preview', net_before, net_after, variance }; with confirm true the new representation is written and the old one
// retired in one transaction with a history row. The database enforces the rule, a client that skips this route is refused.
const switchSchema = z.discriminatedUnion('to_mode', [
  z.object({
    to_mode: z.literal('detailed'),
    assets: z.array(businessEntityAssetSchema).default([]),
    liabilities: z.array(businessEntityLiabilitySchema).default([]),
    confirm: z.boolean().default(false),
  }),
  z.object({ to_mode: z.literal('summary'), net: z.number(), confirm: z.boolean().default(false) }),
]).superRefine((v, ctx) => {
  if (v.to_mode === 'detailed' && v.assets.length + v.liabilities.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['assets'], message: 'enter at least one asset or liability to record the entity as itemised' });
  }
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = switchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badValidation(parsed.error, 422);
  const supabase = await createClient();
  const v = parsed.data;
  const { data, error } = await supabase.rpc('business_entity_switch_mode', {
    p_entity_id: id,
    p_to_mode: v.to_mode,
    p_assets: v.to_mode === 'detailed' ? v.assets : [],
    p_liabilities: v.to_mode === 'detailed' ? v.liabilities : [],
    p_net: v.to_mode === 'summary' ? v.net : null,
    p_confirm: v.confirm,
  });
  if (error) {
    const e = smsfRpcError(error);
    return bad(e.message, e.status, e.errorCode);
  }
  return ok(data);
}
