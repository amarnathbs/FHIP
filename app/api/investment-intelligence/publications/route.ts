import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';

// R3 spec section 61 — provenance/status listing. Read-only, RLS-scoped.
// Powers the "Review in Investment Intelligence" surface and the FHIP grid's
// source badge lookups.
export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('ii_fhip_publications')
    .select(
      'id, account_id, instrument_id, canonical_position_id, publication_target, published_row_id, status, published_owner, source_currency, source_country, published_value, cost_base_status, target_master_item_key, published_at, last_republished_at, linkage_type, supersedes_publication_id, superseded_by_publication_id'
    )
    .eq('user_id', user.id)
    .order('published_at', { ascending: false });
  if (error) return bad(error.message);
  return ok(data);
}
