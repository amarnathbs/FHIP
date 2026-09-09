import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { listBusinessEntityAssets, createBusinessEntityAsset } from '@/lib/services/businessEntityData';
import { businessEntityAssetSchema } from '@/lib/validation/businessEntity';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await listBusinessEntityAssets(id, user.id, supabase);
  return error ? bad(error.message) : ok(data);
}

// RLS's cross-referenced WITH CHECK (migration 0134) guarantees
// business_entity_id must be one of the caller's own entities, exactly
// mirroring SMSF holdings' own defence-in-depth (migration 0084).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = businessEntityAssetSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return bad(parsed.error.message, 422);

  const supabase = await createClient();
  const { data, error } = await createBusinessEntityAsset(id, user.id, parsed.data, supabase);
  return error ? bad(error.message) : ok(data);
}
