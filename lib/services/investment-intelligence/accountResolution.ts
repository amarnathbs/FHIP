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
import type { ParsedAccountRecord, ParsedTransactionRecord, ParsedHoldingRecord } from './parsers/types';

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

// ---------------------------------------------------------------------------
// PC1-D1 — folio/AMC identity resolution (pure, DB-free — unit-testable
// without a live Supabase client).
//
// Original defect: documentProcessing.ts resolved a folio's institution as
// `acc.amcName || parsed.transactions[0]?.scheme.amcName` — the SECOND
// operand is the first transaction of the ENTIRE uploaded document, with
// no relationship to whichever folio a given loop iteration is resolving.
// Both real parsers (camsParser.ts, kfintechParser.ts) always emit
// `ParsedAccountRecord.amcName === ''` (institution is a per-scheme fact in
// their statement layout, not a per-folio-shell fact), so that fallback was
// UNCONDITIONALLY reached for every real folio, attributing every folio in
// a multi-AMC document to whichever AMC happened to own the document's
// very first transaction.
//
// Fix: derive institution attribution for each transaction/holding from
// THAT row's own `scheme.amcName` (each parser already tracks this
// correctly-scoped — `lastKnownAmcName` is updated positionally as the
// statement is walked, so a scheme's amcName reflects the AMC block that
// scheme literally appeared under), and resolve/create accounts per
// DISTINCT (folio, amcName) pair actually observed in that folio's own
// evidence — never by folio number alone. This matches the (user,
// institution_name, folio) identity model already enforced by
// resolveOrCreateAccount/findOrCreateIiAccountServiceRole above: two
// folios that happen to share a printed folio number under two different
// AMCs are, per that identity model, genuinely DISTINCT accounts, so they
// resolve to two assignments here rather than being silently collapsed
// under whichever AMC name won a guess (the mandatory
// same-folio-number/different-AMC negative control).
export interface FolioAmcAssignment {
  key: string; // accountResolutionKey(folioNumber, amcName) — stable identity for this run
  folioNumber: string | null;
  amcName: string;
  accountNumberMasked: string | null;
}

export function accountResolutionKey(folioNumber: string | null, amcName: string): string {
  return `${folioNumber ?? '__no_folio__'}::${amcName}`;
}

export interface FolioAccountResolutionPlan {
  /** Every DISTINCT (folio, amcName) account that must be resolved/created for this document. */
  assignments: FolioAmcAssignment[];
  /** Given a transaction/holding's own folioNumber + scheme.amcName, returns the assignment key it belongs to (same keys as `assignments`). */
  resolveRowKey: (folioNumber: string | null, schemeAmcName: string) => string;
}

export function planFolioAccountResolution(input: {
  accounts: ParsedAccountRecord[];
  transactions: ParsedTransactionRecord[];
  holdings: ParsedHoldingRecord[];
}): FolioAccountResolutionPlan {
  // acc-level AMC evidence, when a parser DOES supply it reliably per folio
  // (spec section 4: "if a parser already contains sufficient per-folio
  // AMC evidence" — neither camsParser nor kfintechParser does today, but
  // this keeps the resolver correct if one ever does).
  const accAmcNameByFolio = new Map<string, string>();
  for (const acc of input.accounts) {
    if (acc.amcName) accAmcNameByFolio.set(acc.folioNumber ?? '__no_folio__', acc.amcName);
  }

  // Folio-scoped evidence index: folio -> distinct AMC names seen across
  // THAT folio's own transactions/holdings only (never the whole document,
  // and never dependent on array order — a Set, built by scanning every
  // row, is used precisely so reordering the input arrays cannot change
  // the result — D1-R2's invariant).
  const amcNamesByFolio = new Map<string, Set<string>>();
  for (const t of input.transactions) {
    if (!t.scheme.amcName) continue;
    const key = t.folioNumber ?? '__no_folio__';
    if (!amcNamesByFolio.has(key)) amcNamesByFolio.set(key, new Set());
    amcNamesByFolio.get(key)!.add(t.scheme.amcName);
  }
  for (const h of input.holdings) {
    if (!h.scheme.amcName) continue;
    const key = h.folioNumber ?? '__no_folio__';
    if (!amcNamesByFolio.has(key)) amcNamesByFolio.set(key, new Set());
    amcNamesByFolio.get(key)!.add(h.scheme.amcName);
  }

  const assignments: FolioAmcAssignment[] = [];
  const seenKeys = new Set<string>();
  for (const acc of input.accounts) {
    const folioKey = acc.folioNumber ?? '__no_folio__';
    const accLevelAmc = accAmcNameByFolio.get(folioKey);
    const amcCandidates = accLevelAmc ? [accLevelAmc] : Array.from(amcNamesByFolio.get(folioKey) ?? []);
    const resolvedAmcNames = amcCandidates.length > 0 ? amcCandidates : ['Unknown AMC'];
    for (const amcName of resolvedAmcNames) {
      const key = accountResolutionKey(acc.folioNumber, amcName);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      assignments.push({ key, folioNumber: acc.folioNumber, amcName, accountNumberMasked: acc.accountNumberMasked });
    }
  }

  function resolveRowKey(folioNumber: string | null, schemeAmcName: string): string {
    const folioKey = folioNumber ?? '__no_folio__';
    const amcName = accAmcNameByFolio.get(folioKey) || schemeAmcName || 'Unknown AMC';
    return accountResolutionKey(folioNumber, amcName);
  }

  return { assignments, resolveRowKey };
}
