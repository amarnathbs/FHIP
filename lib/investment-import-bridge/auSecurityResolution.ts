/**
 * FDH-11 bridge — AU security resolution against canonical Investment
 * Intelligence (spec sections 39-42, 90, 104).
 *
 * This file is OUTSIDE `lib/financial-data-hub/` and is therefore allowed
 * to import Investment Intelligence code directly (unlike the Hub itself).
 * It fetches candidate `ii_instrument_identifiers` rows and delegates the
 * actual matching decision to the Hub's own PURE matcher
 * (`lib/financial-data-hub/investment/securityMatching.ts`) — the decision
 * logic is not duplicated here, only the DB access this bridge alone is
 * allowed to perform.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { resolveOrCreateInstrument } from '@/lib/services/investment-intelligence/identifiers';
import {
  matchAuSecurity,
  type AuSecurityCandidateIdentifier,
  type AuSecurityMatchQuery,
  type AuSecurityMatchResult,
} from '@/lib/financial-data-hub/investment/securityMatching';

export async function fetchAuSecurityCandidates(): Promise<{ candidates: AuSecurityCandidateIdentifier[]; error: string | null }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('ii_instrument_identifiers')
    .select('instrument_id, identifier_scheme, identifier_value, country_code')
    .in('identifier_scheme', ['isin', 'asx_ticker'])
    .eq('is_active', true);
  if (error) return { candidates: [], error: error.message };
  const candidates: AuSecurityCandidateIdentifier[] = (data ?? [])
    .filter((r) => r.identifier_scheme === 'isin' || r.country_code === 'AU')
    .map((r) => ({
      instrumentId: r.instrument_id as string,
      scheme: r.identifier_scheme as 'isin' | 'asx_ticker',
      value: r.identifier_value as string,
    }));
  return { candidates, error: null };
}

export async function resolveAuSecurity(query: AuSecurityMatchQuery): Promise<AuSecurityMatchResult & { error: string | null }> {
  const { candidates, error } = await fetchAuSecurityCandidates();
  if (error) return { outcome: 'unresolved', matchedInstrumentId: null, candidateInstrumentIds: [], matchedVia: null, error };
  return { ...matchAuSecurity(query, candidates), error: null };
}

export type AuSecurityEvidenceTable = 'fdh_investment_statement_positions' | 'fdh_investment_statement_activities';

/**
 * Resolve AND persist the outcome onto one evidence row's
 * `security_match_status`/`matched_instrument_id` (spec sections 39-42,
 * 90, 104). `matched` writes the instrument id; `ambiguous`/`unresolved`
 * write only the status, never a guessed instrument id.
 */
export async function resolveAndPersistAuSecurityMatch(
  userId: string,
  table: AuSecurityEvidenceTable,
  rowId: string,
  query: AuSecurityMatchQuery,
): Promise<AuSecurityMatchResult & { error: string | null }> {
  const admin = createAdminClient();
  const { data: row, error: rowErr } = await admin.from(table).select('id, user_id').eq('id', rowId).eq('user_id', userId).maybeSingle();
  if (rowErr || !row) return { outcome: 'unresolved', matchedInstrumentId: null, candidateInstrumentIds: [], matchedVia: null, error: rowErr?.message ?? 'Evidence row not found.' };

  const result = await resolveAuSecurity(query);
  await admin
    .from(table)
    .update({
      security_match_status: result.outcome === 'matched' ? 'matched' : result.outcome,
      matched_instrument_id: result.outcome === 'matched' ? result.matchedInstrumentId : null,
    })
    .eq('id', rowId);
  return result;
}

/**
 * Create a new provisional `ii_instruments` row for an AU security with no
 * existing match, ONLY on explicit user confirmation at review time (spec
 * section 42: "route through the existing security-resolution process. Do
 * not globally create a security from one user's free-text statement
 * without governance") — reuses `resolveOrCreateInstrument`, II's own
 * existing governance mechanism (the same function R2/R12 already use for
 * every other jurisdiction), rather than inventing a second creation path.
 */
export async function createProvisionalAuSecurity(input: {
  instrumentName: string;
  instrumentClass: 'equity' | 'etf' | 'mutual_fund';
  isin?: string;
  asxTicker?: string;
}): Promise<{ instrumentId: string | null; created: boolean; error: string | null }> {
  const candidates: { scheme: 'isin' | 'asx_ticker'; value: string; countryCode?: string | null }[] = [];
  if (input.isin) candidates.push({ scheme: 'isin', value: input.isin });
  if (input.asxTicker) candidates.push({ scheme: 'asx_ticker', value: input.asxTicker, countryCode: 'AU' });
  return resolveOrCreateInstrument({
    candidates,
    instrumentName: input.instrumentName,
    instrumentClass: input.instrumentClass,
    countryOfDomicile: 'AU',
    baseCurrency: 'AUD',
  });
}
