import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { listBusinessEntities, createBusinessEntity } from '@/lib/services/businessEntityData';
import { businessEntityCreateInputSchema } from '@/lib/validation/businessEntity';

// LR-11 (Company / Family Trust Entity Architecture). Unlike SMSF's POST
// route, there is no jurisdiction gate here at all — WP-09's own lesson is
// that Company/Trust must NOT copy SMSF's AU-only assumption without actual
// evidence a restriction is warranted; country_code on the entity is purely
// informational (nullable = no restriction), never enforced by a trigger.
export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await listBusinessEntities(user.id, supabase);
  return error ? bad(error.message) : ok(data);
}

export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = businessEntityCreateInputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return bad(parsed.error.message, 422);

  const supabase = await createClient();
  const { data, error } = await createBusinessEntity(user.id, parsed.data, supabase);
  return error ? bad(error.message) : ok(data);
}
