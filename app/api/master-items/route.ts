import { ok, bad, requireUser } from '@/lib/api';
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
