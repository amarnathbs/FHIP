import type { SupabaseClient } from '@supabase/supabase-js';
import type { EntityExpenseInput, EntityIncomeInput } from '@/lib/validation/entityCashFlow';
import { smsfRpcError, type SmsfApiError } from '@/lib/services/smsfErrors';

// Entity-level income and expenses (migration 0296) for ONE entity: an SMSF fund or a registered Company, Family Trust or HUF. Thin data access,
// every read and write is scoped by user_id AND the entity, the database repeats the ownership and kind checks (trigger plus row level security).
// Nothing here ever touches the personal income_sources / expense_items registers except the explicit, preview-first move of a legacy SMSF row.

export type EntityScope =
  | { kind: 'smsf'; fundId: string }
  | { kind: 'business'; entityId: string; entityType: 'company' | 'family_trust' | 'huf' };

function scopeColumns(scope: EntityScope): Record<string, string> {
  return scope.kind === 'smsf'
    ? { entity_kind: 'smsf', smsf_fund_id: scope.fundId }
    : { entity_kind: scope.entityType, business_entity_id: scope.entityId };
}

function scopeFilter(scope: EntityScope): [string, string] {
  return scope.kind === 'smsf' ? ['smsf_fund_id', scope.fundId] : ['business_entity_id', scope.entityId];
}

/** The caller's own entity or null: a fund or entity of another household answers exactly like one that does not exist (non-enumerating). */
export async function resolveEntityScope(kind: 'smsf' | 'business', id: string, userId: string, supabase: SupabaseClient): Promise<EntityScope | null> {
  if (kind === 'smsf') {
    const { data } = await supabase.from('smsf_funds').select('id, user_id').eq('id', id).eq('user_id', userId).maybeSingle();
    return data ? { kind: 'smsf', fundId: id } : null;
  }
  const { data } = await supabase.from('business_entities').select('id, entity_type, user_id').eq('id', id).eq('user_id', userId).maybeSingle();
  const type = (data as { entity_type?: string } | null)?.entity_type;
  return type === 'company' || type === 'family_trust' || type === 'huf' ? { kind: 'business', entityId: id, entityType: type } : null;
}

export async function listEntityIncome(scope: EntityScope, userId: string, supabase: SupabaseClient) {
  const [col, val] = scopeFilter(scope);
  return supabase.from('entity_income_items').select('*').eq(col, val).eq('user_id', userId).eq('is_active', true).order('created_at', { ascending: false });
}

export async function createEntityIncome(scope: EntityScope, userId: string, input: EntityIncomeInput, supabase: SupabaseClient) {
  return supabase.from('entity_income_items').insert({ ...input, ...scopeColumns(scope), user_id: userId }).select().single();
}

export async function updateEntityIncome(scope: EntityScope, itemId: string, userId: string, patch: Partial<EntityIncomeInput>, supabase: SupabaseClient) {
  const [col, val] = scopeFilter(scope);
  return supabase.from('entity_income_items').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', itemId).eq(col, val).eq('user_id', userId).select().single();
}

/** Soft retire: a financial record is never hard deleted, the audit trail keeps it. */
export async function retireEntityIncome(scope: EntityScope, itemId: string, userId: string, supabase: SupabaseClient) {
  return updateEntityIncomeActive('entity_income_items', scope, itemId, userId, supabase);
}

export async function listEntityExpenses(scope: EntityScope, userId: string, supabase: SupabaseClient) {
  const [col, val] = scopeFilter(scope);
  return supabase.from('entity_expense_items').select('*').eq(col, val).eq('user_id', userId).eq('is_active', true).order('created_at', { ascending: false });
}

export async function createEntityExpense(scope: EntityScope, userId: string, input: EntityExpenseInput, supabase: SupabaseClient) {
  return supabase.from('entity_expense_items').insert({ ...input, ...scopeColumns(scope), user_id: userId }).select().single();
}

export async function updateEntityExpense(scope: EntityScope, itemId: string, userId: string, patch: Partial<EntityExpenseInput>, supabase: SupabaseClient) {
  const [col, val] = scopeFilter(scope);
  return supabase.from('entity_expense_items').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', itemId).eq(col, val).eq('user_id', userId).select().single();
}

export async function retireEntityExpense(scope: EntityScope, itemId: string, userId: string, supabase: SupabaseClient) {
  return updateEntityIncomeActive('entity_expense_items', scope, itemId, userId, supabase);
}

async function updateEntityIncomeActive(table: 'entity_income_items' | 'entity_expense_items', scope: EntityScope, itemId: string, userId: string, supabase: SupabaseClient) {
  const [col, val] = scopeFilter(scope);
  return supabase.from(table).update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', itemId).eq(col, val).eq('user_id', userId).select().single();
}

/** Legacy personal rows tagged SMSF (income and expenses entered the earlier way), listed so each can be moved into the fund. */
export async function listLegacySmsfCashFlow(userId: string, supabase: SupabaseClient) {
  const [income, expenses] = await Promise.all([
    supabase.from('income_sources').select('id, source_name, amount, frequency, currency_code, master_item_key').eq('user_id', userId).eq('owner', 'smsf').eq('is_active', true),
    supabase.from('expense_items').select('id, expense_name, amount, frequency, currency_code, expense_category').eq('user_id', userId).eq('owner', 'smsf').eq('is_active', true),
  ]);
  return { income, expenses };
}

export async function moveLegacySmsfCashFlow(fundId: string, register: 'income' | 'expenses', rowId: string, confirm: boolean, supabase: SupabaseClient) {
  return supabase.rpc('smsf_entity_move_personal_cash_flow', { p_fund_id: fundId, p_register: register, p_row_id: rowId, p_confirm: confirm });
}

/** Plain wording and a stable code for a database refusal of an entity income or expense write. */
export function entityCashFlowError(error: { message: string; code?: string | null }): SmsfApiError {
  if (/uq_entity_income_rent_per/.test(error.message)) {
    return { status: 409, errorCode: 'ENTITY_RENT_DUPLICATE', message: 'This property already has a rent record. Edit that one instead of adding a second.' };
  }
  if (/chk_entity_income_rent_needs_amount/.test(error.message)) {
    return { status: 422, errorCode: 'ENTITY_RENT_NEEDS_AMOUNT', message: 'Enter the rent amount and how often it is paid.' };
  }
  if (/ENTITY_NOT_YOURS/.test(error.message)) {
    return { status: 404, message: 'Not found' };
  }
  if (/ENTITY_KIND_MISMATCH/.test(error.message)) {
    return { status: 409, errorCode: 'ENTITY_KIND_MISMATCH', message: 'That record belongs to a different kind of entity.' };
  }
  return smsfRpcError(error);
}
