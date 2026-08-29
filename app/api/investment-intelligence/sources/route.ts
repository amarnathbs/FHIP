import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';

// Reference-data read — every authenticated user may see the source-type
// catalogue (world-readable per R1_IMPLEMENTATION_SPEC.md section 3); write
// access is admin-only and not exposed here (spec section 30: no
// unrestricted generic CRUD over ii_* tables).
export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await supabase.from('ii_sources').select('*').eq('is_active', true).order('source_key');
  return error ? bad(error.message) : ok(data);
}
