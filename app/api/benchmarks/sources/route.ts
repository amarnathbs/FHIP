import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('benchmark_sources')
    .select('id, source_name, source_type, publisher, source_title, country_code, publication_date, reference_period_start, reference_period_end, citation_text, methodology_notes, quality_rating, status')
    .eq('status', 'active')
    .order('publisher');
  return error ? bad(error.message) : ok(data);
}
