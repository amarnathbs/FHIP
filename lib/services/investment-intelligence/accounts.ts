import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { IiAccountType } from './types';

// ii_accounts uses status (active|closed|archived), not the generic
// is_active boolean lib/services/registry.ts's makeRegistry() assumes — so
// Investment Intelligence gets its own small, owner-scoped service rather
// than forcing an incompatible shape onto the shared registry helper. This
// is intentionally NOT a generic CRUD-over-ii_* exposer (spec section 30) —
// only the operations R1 actually needs.
export interface IiAccountInput {
  accountType: IiAccountType;
  institutionName: string;
  countryCode: string;
  currencyCode: string;
  folioNumber?: string | null;
  accountNumberMasked?: string | null;
  ownerMemberId?: string | null;
  sourceDocumentId?: string | null;
}

export async function listIiAccounts(userId: string) {
  const supabase = await createClient();
  return supabase.from('ii_accounts').select('*').eq('user_id', userId).neq('status', 'archived').order('created_at', { ascending: false });
}

export async function createIiAccount(userId: string, input: IiAccountInput) {
  const supabase = await createClient();
  return supabase
    .from('ii_accounts')
    .insert({
      user_id: userId,
      account_type: input.accountType,
      institution_name: input.institutionName,
      country_code: input.countryCode,
      currency_code: input.currencyCode,
      folio_number: input.folioNumber ?? null,
      account_number_masked: input.accountNumberMasked ?? null,
      owner_member_id: input.ownerMemberId ?? null,
      source_document_id: input.sourceDocumentId ?? null,
      status: 'active',
    })
    .select()
    .single();
}

export async function archiveIiAccount(userId: string, id: string) {
  const supabase = await createClient();
  return supabase.from('ii_accounts').update({ status: 'archived' }).eq('id', id).eq('user_id', userId).select().single();
}

// find-or-create, used by the manual test importer — the service-role
// variant since the importer runs as a trusted server-side flow, not a
// direct user request path (R1_IMPLEMENTATION_SPEC.md section 8).
export async function findOrCreateIiAccountServiceRole(
  userId: string,
  input: IiAccountInput
): Promise<{ accountId: string | null; created: boolean; error: string | null }> {
  const admin = createAdminClient();
  let query = admin.from('ii_accounts').select('id').eq('user_id', userId).eq('institution_name', input.institutionName).eq('status', 'active');
  query = input.folioNumber ? query.eq('folio_number', input.folioNumber) : query.is('folio_number', null);
  const { data: existing } = await query.maybeSingle();
  if (existing) return { accountId: existing.id as string, created: false, error: null };

  const { data: created, error } = await admin
    .from('ii_accounts')
    .insert({
      user_id: userId,
      account_type: input.accountType,
      institution_name: input.institutionName,
      country_code: input.countryCode,
      currency_code: input.currencyCode,
      folio_number: input.folioNumber ?? null,
      account_number_masked: input.accountNumberMasked ?? null,
      owner_member_id: input.ownerMemberId ?? null,
      source_document_id: input.sourceDocumentId ?? null,
      status: 'active',
    })
    .select('id')
    .single();
  if (error || !created) return { accountId: null, created: false, error: error?.message ?? 'Account creation failed' };
  return { accountId: created.id as string, created: true, error: null };
}
