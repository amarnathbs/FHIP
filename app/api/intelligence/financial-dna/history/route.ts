import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('financial_dna_profiles')
    .select('profile_month, primary_profile_code, secondary_profile_code, confidence_score, profile_changed')
    .eq('user_id', user.id)
    .order('profile_month', { ascending: true })
    .limit(36);
  return error ? bad(error.message) : ok(data);
}
