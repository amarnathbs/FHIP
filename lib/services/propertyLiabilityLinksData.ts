import { createClient } from '@/lib/supabase/server';
import { CONSUMER_DEBT_MASTER_ITEMS, type PropertyLiabilityLinkInput } from '@/lib/validation/propertyLiabilityLink';

export interface PropertyLiabilityLinkRow {
  id: string;
  user_id: string;
  linked_asset_id: string | null;
  linked_investment_id: string | null;
  linked_retirement_id: string | null;
  liability_id: string;
  link_type: string;
  allocation_percent: number;
  allocation_amount: number | null;
  is_primary: boolean;
  source: string;
  confidence: string | null;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// list() intentionally does NOT filter on is_active=true (unlike
// lib/services/registry.ts's generic list()) -- the UI needs to be able to
// show a property's link history (spec s.19-24: refinance/unlink should be
// historically visible, not just the currently-active state), and totals
// callers (dashboard/DNA/forecasting) explicitly filter for is_active=true
// themselves so a stale/deactivated link can never silently re-enter a
// total.
export async function listPropertyLiabilityLinks(userId: string) {
  const supabase = await createClient();
  return supabase
    .from('property_liability_links')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
}

export async function listLinksForLiability(userId: string, liabilityId: string) {
  const supabase = await createClient();
  return supabase
    .from('property_liability_links')
    .select('*')
    .eq('user_id', userId)
    .eq('liability_id', liabilityId)
    .eq('is_active', true);
}

export async function listLinksForProperty(
  userId: string,
  side: 'asset' | 'investment' | 'retirement',
  propertyId: string
) {
  const supabase = await createClient();
  const column = side === 'asset' ? 'linked_asset_id' : side === 'investment' ? 'linked_investment_id' : 'linked_retirement_id';
  return supabase
    .from('property_liability_links')
    .select('*')
    .eq('user_id', userId)
    .eq(column, propertyId)
    .eq('is_active', true);
}

// Eligible liabilities for a "link existing liability" picker (spec s.14):
// only this user's own, active, non-consumer-debt liabilities. Server-side
// filter -- never trusts a client-supplied list. Excludes liabilities that
// already carry an active link when `unlinkedOnly` is set (used by the
// picker; not used by read views that need every candidate).
export async function listEligibleLiabilities(userId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('liabilities')
    .select('id, liability_name, debt_type, master_item_key, balance, lender, currency_code, country_code, owner, is_active')
    .eq('user_id', userId)
    .eq('is_active', true);
  if (error || !data) return { data: null, error };
  const eligible = data.filter((l) => !l.master_item_key || !CONSUMER_DEBT_MASTER_ITEMS.has(l.master_item_key));
  return { data: eligible, error: null };
}

interface CreateResult {
  data: PropertyLiabilityLinkRow | null;
  error: { message: string } | null;
}

// Ownership + eligibility validated server-side before the insert is even
// attempted (spec s.53-55) -- defence-in-depth ahead of the DB's own RLS
// WITH CHECK and the pll_validate_liability_eligibility trigger, so a
// rejected request gets a clean, specific 4xx instead of a raw Postgres
// error surfacing to the client.
export async function createPropertyLiabilityLink(userId: string, input: PropertyLiabilityLinkInput): Promise<CreateResult> {
  const supabase = await createClient();

  const { data: liability, error: liabErr } = await supabase
    .from('liabilities')
    .select('id, user_id, master_item_key, is_active')
    .eq('id', input.liability_id)
    .eq('user_id', userId)
    .maybeSingle();
  if (liabErr) return { data: null, error: liabErr };
  if (!liability) return { data: null, error: { message: 'Liability not found or not owned by this user.' } };
  if (!liability.is_active) return { data: null, error: { message: 'Cannot link an archived liability.' } };
  if (liability.master_item_key && CONSUMER_DEBT_MASTER_ITEMS.has(liability.master_item_key)) {
    return { data: null, error: { message: 'This liability type is consumer debt and cannot be linked as property finance.' } };
  }

  const propertySide: { column: 'linked_asset_id' | 'linked_investment_id' | 'linked_retirement_id'; table: 'assets' | 'investments' | 'retirement_accounts'; id: string } | null =
    input.linked_asset_id
      ? { column: 'linked_asset_id', table: 'assets', id: input.linked_asset_id }
      : input.linked_investment_id
        ? { column: 'linked_investment_id', table: 'investments', id: input.linked_investment_id }
        : input.linked_retirement_id
          ? { column: 'linked_retirement_id', table: 'retirement_accounts', id: input.linked_retirement_id }
          : null;
  if (!propertySide) return { data: null, error: { message: 'A property must be specified.' } };

  const { data: property, error: propErr } = await supabase
    .from(propertySide.table)
    .select('id, user_id, is_active')
    .eq('id', propertySide.id)
    .eq('user_id', userId)
    .maybeSingle();
  if (propErr) return { data: null, error: propErr };
  if (!property) return { data: null, error: { message: 'Property not found or not owned by this user.' } };
  if (!property.is_active) return { data: null, error: { message: 'Cannot link an archived property.' } };

  const row: Record<string, unknown> = {
    user_id: userId,
    liability_id: input.liability_id,
    link_type: input.link_type,
    allocation_percent: input.allocation_percent,
    allocation_amount: input.allocation_amount ?? null,
    is_primary: input.is_primary,
    notes: input.notes ?? null,
    source: 'manual',
    confidence: 'user_confirmed',
  };
  row[propertySide.column] = propertySide.id;

  const { data, error } = await supabase.from('property_liability_links').insert(row).select().single();
  return { data: data as PropertyLiabilityLinkRow | null, error };
}

// Unlink removes only the relationship -- never touches either record's
// balance/value (spec s.19). Soft-delete (is_active=false) so history is
// preserved for refinance/audit purposes (spec s.21-24), matching the
// is_active convention every other user table in this app already uses.
export async function unlinkPropertyLiabilityLink(userId: string, id: string) {
  const supabase = await createClient();
  return supabase
    .from('property_liability_links')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .single();
}

export async function updatePropertyLiabilityLink(
  userId: string,
  id: string,
  patch: Partial<Pick<PropertyLiabilityLinkInput, 'link_type' | 'allocation_percent' | 'allocation_amount' | 'is_primary' | 'notes'>>
) {
  const supabase = await createClient();
  return supabase
    .from('property_liability_links')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .single();
}
