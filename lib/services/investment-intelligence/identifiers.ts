import { createAdminClient } from '@/lib/supabase/admin';
import type { IiIdentifierScheme, IiInstrumentClass } from './types';

// ADR-002: a source-provider identifier never becomes the sole primary
// identifier. This module is the alias-resolution step ADR-002's
// "consequences" section calls out as "a real implementation cost in R1,
// not free" — given one or more candidate (scheme, value) identifiers
// observed on an incoming record, find the existing canonical
// ii_instruments.id they already resolve to, or signal that a new
// provisional instrument is needed.

export interface CandidateIdentifier {
  scheme: IiIdentifierScheme;
  value: string;
  countryCode?: string | null;
}

export interface ExistingIdentifierRow {
  instrumentId: string;
  scheme: IiIdentifierScheme;
  value: string;
  countryCode: string | null;
}

// Pure resolution logic — unit-testable without a live Supabase client
// (R1_IMPLEMENTATION_SPEC.md section 13: "identifier alias resolution").
// Country-scoped schemes (amfi_scheme_code/nse_symbol/bse_code/
// internal_provisional) match only within the same country; globally-unique
// schemes (isin/sedol) match regardless of country, mirroring the two
// partial unique indexes the migration enforces at the database level.
const GLOBAL_SCHEMES: IiIdentifierScheme[] = ['isin', 'sedol'];

export function resolveInstrumentIdFromIdentifiers(
  candidates: CandidateIdentifier[],
  existing: ExistingIdentifierRow[]
): string | null {
  for (const candidate of candidates) {
    const isGlobal = GLOBAL_SCHEMES.includes(candidate.scheme);
    const match = existing.find((row) => {
      if (row.scheme !== candidate.scheme || row.value !== candidate.value) return false;
      if (isGlobal) return true;
      return row.countryCode === (candidate.countryCode ?? null);
    });
    if (match) return match.instrumentId;
  }
  return null;
}

// DB-backed wrapper: looks up every candidate identifier at once, resolves
// to an existing ii_instruments row if any alias already matches (this is
// what proves ADR-002's requirement that the SAME instrument, first seen
// via one provider and later confirmed via a second provider with a
// different identifier scheme, resolves to the same ii_instruments.id
// rather than duplicating), otherwise creates a new provisional instrument
// plus its identifier rows.
export interface ResolveOrCreateInstrumentInput {
  candidates: CandidateIdentifier[];
  instrumentName: string;
  instrumentClass: IiInstrumentClass;
  countryOfDomicile: string;
  baseCurrency: string;
  sourceId?: string | null;
}

export async function resolveOrCreateInstrument(
  input: ResolveOrCreateInstrumentInput
): Promise<{ instrumentId: string | null; created: boolean; error: string | null }> {
  const admin = createAdminClient();

  if (input.candidates.length > 0) {
    const schemes = [...new Set(input.candidates.map((c) => c.scheme))];
    const { data: rows, error } = await admin
      .from('ii_instrument_identifiers')
      .select('instrument_id, identifier_scheme, identifier_value, country_code')
      .in('identifier_scheme', schemes)
      .eq('is_active', true);
    if (error) return { instrumentId: null, created: false, error: error.message };

    const existing: ExistingIdentifierRow[] = (rows ?? []).map((r) => ({
      instrumentId: r.instrument_id as string,
      scheme: r.identifier_scheme as IiIdentifierScheme,
      value: r.identifier_value as string,
      countryCode: (r.country_code as string) ?? null,
    }));
    const resolved = resolveInstrumentIdFromIdentifiers(input.candidates, existing);
    if (resolved) return { instrumentId: resolved, created: false, error: null };
  }

  // No existing alias matched — create a new provisional instrument
  // (ADR-002: a provisional instrument gets a real ii_instruments.id
  // immediately so transactions/snapshots don't wait on enrichment).
  const { data: instrument, error: insertErr } = await admin
    .from('ii_instruments')
    .insert({
      instrument_name: input.instrumentName,
      instrument_class: input.instrumentClass,
      country_of_domicile: input.countryOfDomicile,
      base_currency: input.baseCurrency,
      status: 'provisional',
      source_id: input.sourceId ?? null,
    })
    .select('id')
    .single();
  if (insertErr || !instrument) return { instrumentId: null, created: false, error: insertErr?.message ?? 'Instrument creation failed' };

  if (input.candidates.length > 0) {
    const { error: identErr } = await admin.from('ii_instrument_identifiers').insert(
      input.candidates.map((c) => ({
        instrument_id: instrument.id,
        identifier_scheme: c.scheme,
        identifier_value: c.value,
        country_code: c.countryCode ?? null,
      }))
    );
    if (identErr) return { instrumentId: instrument.id as string, created: true, error: identErr.message };
  }

  return { instrumentId: instrument.id as string, created: true, error: null };
}
