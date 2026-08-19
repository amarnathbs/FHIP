// Investment Intelligence R2 — account/folio resolution for real parser
// output (spec section 15). Builds on, rather than replaces, R1's
// findOrCreateIiAccountServiceRole (accounts.ts) — R2 adds normalised
// folio matching (statements sometimes print the same folio with
// different whitespace/leading-zero formatting across RTAs or refreshed
// statements) so "repeated statements for the same folio... resolve to
// the same canonical account" (spec section 15) even when the raw string
// isn't byte-identical.

export function normaliseFolioNumber(raw: string | null): string | null {
  if (!raw) return null;
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

import { createAdminClient } from '@/lib/supabase/admin';
import type { IiAccountType } from './types';

export interface ResolveAccountInput {
  accountType: IiAccountType;
  institutionName: string;
  countryCode: string;
  currencyCode: string;
  folioNumber: string | null;
  accountNumberMasked?: string | null;
  ownerMemberId?: string | null;
  sourceDocumentId?: string | null;
}

export interface ResolveAccountResult {
  accountId: string | null;
  created: boolean;
  error: string | null;
}

/**
 * Find-or-create an ii_accounts row for a PARSED account record. Matching
 * order: (a) same user + institution + NORMALISED folio number, active
 * status; (b) if no folio was parsed, same user + institution with no
 * folio (rare — e.g. a demat account rather than an mf_folio). Never
 * creates a second account for a folio already on file (spec section 15:
 * "Do not create a new account for every uploaded statement.").
 */
export async function resolveOrCreateAccount(userId: string, input: ResolveAccountInput): Promise<ResolveAccountResult> {
  const admin = createAdminClient();
  const normalisedFolio = normaliseFolioNumber(input.folioNumber);

  const { data: candidates, error: fetchErr } = await admin
    .from('ii_accounts')
    .select('id, folio_number')
    .eq('user_id', userId)
    .eq('institution_name', input.institutionName)
    .eq('status', 'active');
  if (fetchErr) return { accountId: null, created: false, error: fetchErr.message };

  const match = (candidates ?? []).find((c) => normaliseFolioNumber(c.folio_number as string | null) === normalisedFolio);
  if (match) return { accountId: match.id as string, created: false, error: null };

  const { data: created, error: insertErr } = await admin
    .from('ii_accounts')
    .insert({
      user_id: userId,
      account_type: input.accountType,
      institution_name: input.institutionName,
      country_code: input.countryCode,
      currency_code: input.currencyCode,
      folio_number: input.folioNumber,
      account_number_masked: input.accountNumberMasked ?? null,
      owner_member_id: input.ownerMemberId ?? null,
      source_document_id: input.sourceDocumentId ?? null,
      status: 'active',
    })
    .select('id')
    .single();
  if (insertErr || !created) return { accountId: null, created: false, error: insertErr?.message ?? 'Account creation failed' };
  return { accountId: created.id as string, created: true, error: null };
}
