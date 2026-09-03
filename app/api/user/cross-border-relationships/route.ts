// GET/POST /api/user/cross-border-relationships — spec section 13. RLS
// (migration 0122) is the real enforcement boundary here; this route adds
// only input validation and the MCC gate, matching the existing pattern of
// every other catalogue-adjacent route in this app.
import { z } from 'zod';
// G3 section 9/10: a GENERIC-experience user (GB/US/SG/AE) may DECLARE
// cross-border relationships — that is one of the few things G3 explicitly
// permits them before G4 — so this route uses the allowing-generic guard.
// The declaration remains non-authoritative: it never changes residence,
// primary country, billing country or currency, and no cross-border
// CALCULATION is performed anywhere in G3 (that is G6).
import { requireCountryConfirmedUserAllowingGeneric as requireUser, ok, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';

const RELATIONSHIP_TYPES = ['ASSET', 'INVESTMENT', 'PROPERTY', 'INCOME', 'LIABILITY', 'RETIREMENT', 'TAX', 'OTHER'] as const;

const createSchema = z.object({
  country_code: z.string().length(2),
  relationship_type: z.enum(RELATIONSHIP_TYPES),
  effective_date: z.string().date().optional(),
});

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const supabase = await createClient();
  // No .eq('user_id', ...) filter needed for correctness (RLS already scopes
  // this to the caller's own rows) — included anyway as defence-in-depth,
  // matching this app's existing convention elsewhere.
  const { data, error } = await supabase
    .from('cross_border_relationships')
    .select('id, country_code, relationship_type, status, source, confirmed_at, effective_date, end_date, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });
  if (error) return bad('OPERATIONAL_ERROR', 500);
  return ok(data);
}

export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return bad('INVALID_REQUEST', 422);

  const supabase = await createClient();
  const countryCode = parsed.data.country_code.trim().toUpperCase();

  const { data: country } = await supabase
    .from('countries')
    .select('country_code, selectable, active')
    .eq('country_code', countryCode)
    .maybeSingle();
  if (!country || !country.selectable || !country.active) return bad('COUNTRY_NOT_SELECTABLE', 422);

  const { data, error } = await supabase
    .from('cross_border_relationships')
    .insert({
      user_id: user.id,
      country_code: countryCode,
      relationship_type: parsed.data.relationship_type,
      source: 'USER_DECLARED',
      confirmed_at: new Date().toISOString(),
      effective_date: parsed.data.effective_date ?? null,
    })
    .select('id, country_code, relationship_type, status, source, confirmed_at, effective_date, created_at')
    .single();

  if (error) {
    // Unique partial index (one ACTIVE relationship per user/country/type)
    if ((error as { code?: string }).code === '23505') return bad('DUPLICATE_ACTIVE_RELATIONSHIP', 409);
    return bad('OPERATIONAL_ERROR', 500);
  }
  return ok(data);
}
