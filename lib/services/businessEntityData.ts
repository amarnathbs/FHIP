import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  BusinessEntityCreateInput,
  BusinessEntityUpdateInput,
  BusinessEntityLineItemInput,
} from '@/lib/validation/businessEntity';

// LR-11 — Company entity data-access layer (migration 0134). Thin,
// self-contained, mirroring lib/services/smsfData.ts's own shape but
// deliberately simpler: no mode-switch RPC ($0-variance gate), no DB-side fx
// function — see migration 0134's own header for why neither is needed
// here.

export async function listBusinessEntities(userId: string, supabase: SupabaseClient) {
  return supabase
    .from('business_entities')
    .select('*')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('created_at', { ascending: false });
}

export async function getBusinessEntity(entityId: string, userId: string, supabase: SupabaseClient) {
  return supabase.from('business_entities').select('*').eq('id', entityId).eq('user_id', userId).single();
}

export async function createBusinessEntity(userId: string, input: BusinessEntityCreateInput, supabase: SupabaseClient) {
  return supabase
    .from('business_entities')
    .insert({ ...input, user_id: userId, entity_type: 'company' })
    .select()
    .single();
}

export async function updateBusinessEntity(
  entityId: string,
  userId: string,
  patch: BusinessEntityUpdateInput,
  supabase: SupabaseClient
) {
  return supabase
    .from('business_entities')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', entityId)
    .eq('user_id', userId)
    .select()
    .single();
}

/** Soft-delete, matching the is_active convention every financial-data-grid register already uses — never a hard delete of a financial record. */
export async function archiveBusinessEntity(entityId: string, userId: string, supabase: SupabaseClient) {
  return supabase
    .from('business_entities')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', entityId)
    .eq('user_id', userId)
    .select()
    .single();
}

export async function listBusinessEntityAssets(entityId: string, userId: string, supabase: SupabaseClient) {
  return supabase
    .from('business_entity_assets')
    .select('*')
    .eq('business_entity_id', entityId)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
}

export async function createBusinessEntityAsset(
  entityId: string,
  userId: string,
  input: BusinessEntityLineItemInput,
  supabase: SupabaseClient
) {
  return supabase
    .from('business_entity_assets')
    .insert({ ...input, business_entity_id: entityId, user_id: userId })
    .select()
    .single();
}

export async function updateBusinessEntityAsset(
  assetId: string,
  userId: string,
  patch: Partial<BusinessEntityLineItemInput>,
  supabase: SupabaseClient
) {
  return supabase
    .from('business_entity_assets')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', assetId)
    .eq('user_id', userId)
    .select()
    .single();
}

export async function deleteBusinessEntityAsset(assetId: string, userId: string, supabase: SupabaseClient) {
  return supabase.from('business_entity_assets').delete().eq('id', assetId).eq('user_id', userId);
}

export async function listBusinessEntityLiabilities(entityId: string, userId: string, supabase: SupabaseClient) {
  return supabase
    .from('business_entity_liabilities')
    .select('*')
    .eq('business_entity_id', entityId)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
}

export async function createBusinessEntityLiability(
  entityId: string,
  userId: string,
  input: BusinessEntityLineItemInput,
  supabase: SupabaseClient
) {
  return supabase
    .from('business_entity_liabilities')
    .insert({ ...input, business_entity_id: entityId, user_id: userId })
    .select()
    .single();
}

export async function updateBusinessEntityLiability(
  liabilityId: string,
  userId: string,
  patch: Partial<BusinessEntityLineItemInput>,
  supabase: SupabaseClient
) {
  return supabase
    .from('business_entity_liabilities')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', liabilityId)
    .eq('user_id', userId)
    .select()
    .single();
}

export async function deleteBusinessEntityLiability(liabilityId: string, userId: string, supabase: SupabaseClient) {
  return supabase.from('business_entity_liabilities').delete().eq('id', liabilityId).eq('user_id', userId);
}

/**
 * Every active entity for this user, together with everything the Net Worth
 * consolidation (lib/engines/businessEntityValuation.ts) needs to compute
 * each one's net asset value: Summary mode's own stored figure, or Detailed
 * mode's raw asset/liability line items (netted, currency-converted, by the
 * caller — this function does no arithmetic, matching this codebase's own
 * split between data-access and calculation layers).
 */
export async function loadBusinessEntitiesForValuation(userId: string, supabase: SupabaseClient) {
  const { data: entities, error: entitiesError } = await listBusinessEntities(userId, supabase);
  if (entitiesError || !entities) return { data: null, error: entitiesError };

  const detailedIds = entities.filter((e) => e.valuation_mode === 'detailed').map((e) => e.id);
  if (detailedIds.length === 0) {
    return { data: entities.map((e) => ({ entity: e, assets: [], liabilities: [] })), error: null };
  }

  const [{ data: assets, error: assetsError }, { data: liabilities, error: liabilitiesError }] = await Promise.all([
    supabase.from('business_entity_assets').select('business_entity_id, value, currency_code').eq('user_id', userId).in('business_entity_id', detailedIds),
    supabase
      .from('business_entity_liabilities')
      .select('business_entity_id, value, currency_code')
      .eq('user_id', userId)
      .in('business_entity_id', detailedIds),
  ]);
  if (assetsError) return { data: null, error: assetsError };
  if (liabilitiesError) return { data: null, error: liabilitiesError };

  return {
    data: entities.map((e) => ({
      entity: e,
      assets: (assets ?? []).filter((a) => a.business_entity_id === e.id),
      liabilities: (liabilities ?? []).filter((l) => l.business_entity_id === e.id),
    })),
    error: null,
  };
}
