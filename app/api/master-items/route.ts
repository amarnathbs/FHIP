import { ok, bad, requireCountryConfirmedUserAllowingGeneric as requireUser } from '@/lib/api';
import { listMasterItems, type MasterItemCategory } from '@/lib/services/masterItems';
import { getUserHomeCountry } from '@/lib/services/jurisdiction';
import { createClient } from '@/lib/supabase/server';

const VALID_CATEGORIES: MasterItemCategory[] = [
  'income',
  'expense',
  'asset',
  'liability',
  'investment',
  'retirement',
  'insurance',
];

// GEO-1/GEO-2: this is the single endpoint every catalogue-driven grid
// (FinancialDataGrid) reads its item list from, so filtering here is what
// actually keeps SMSF (and any future jurisdiction-restricted item) out of
// a non-AU resident's UI without any per-component "if country === ..."
// check (spec s.13-17). Requires auth (every real caller is already inside
// an authenticated app page, same as its sibling /api/{resource} calls) so
// the country used for filtering is always the caller's own, never
// client-suppliable.
//
// G4 closure item 4 (Product Owner, 2026-09-05, found via live browser
// certification): this used to require requireCountryConfirmedUser() — the
// STRICT gate that refuses every GENERIC-experience caller — even though
// this is the one shared dependency EVERY grid module reads its item list
// from, including the three newly-certified-universal ones (Income/
// Expenses/Insurance). A GENERIC user landing on any of those pages hit an
// unhandled GENERIC_EXPERIENCE_RESTRICTED runtime error on this call before
// their own page ever finished loading — the module-level ENABLED decision
// on /api/income etc. was real, but unreachable in practice because this
// upstream dependency was never migrated alongside it. Fixed by admitting
// GENERIC the same way its sibling /api/{resource} routes already do; the
// filtering below already handles a GENERIC country value correctly
// (listMasterItems() only ever narrows the result set for a non-null
// country — it excludes AU/IN-restricted items like age_pension for a GB
// caller and returns every globally-applicable item unchanged, so this
// never widens what a GENERIC user's own already-enabled module surfaces).
export async function GET(req: Request) {
  const category = new URL(req.url).searchParams.get('category') as MasterItemCategory | null;
  if (!category || !VALID_CATEGORIES.includes(category)) return bad('invalid category', 422);

  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const supabase = await createClient();
  const country = await getUserHomeCountry(user.id, supabase);

  const { data, error } = await listMasterItems(category, country);
  return error ? bad(error.message) : ok(data);
}
