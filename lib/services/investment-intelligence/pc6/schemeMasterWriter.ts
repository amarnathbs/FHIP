// PC6 (M6) — the actual ii_scheme_master write path.
//
// Found missing 2026-09-20: the PC6 certification report (N.3) recorded
// ii_scheme_master as certified and proven ("11 written -> 11 read back"),
// but no code anywhere ever wrote to this table — referenceIngestJob.ts's
// write step is unconditionally shaped for ii_prices_nav (price/priceDate),
// so an `amfi_scheme_master`-sourced run silently inserted NAV-price rows
// for the resolved instruments and never touched scheme identity at all.
// This module is the missing piece, dispatched from referenceIngestJob.ts
// when the source's kind is 'scheme_master' instead of the NAV-price path.
//
// EFFECTIVE-DATED, NEVER OVERWRITTEN (matching the table's own schema,
// migration 0155): a scheme's identity fields (name, AMC, ISINs, plan/
// option, category) can genuinely change over time (a fund rename, an AMC
// merger) -- each change closes the current row (`effective_to`) and opens
// a new one, rather than mutating history in place. Unchanged identity
// produces zero writes, checked via a stored content checksum so this
// never re-diffs every field on every run.

import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AmfiSchemeNavRecord } from './amfiParser';
import type { InstrumentResolutionIndex } from './referenceImportRunner';

export interface SchemeMasterWriteCounts {
  resolved: number;
  unresolved: number;
  inserted: number;
  unchanged: number;
  superseded: number;
}

export interface SchemeMasterWriteResult {
  counts: SchemeMasterWriteCounts;
  errors: string[];
}

function identityChecksum(r: AmfiSchemeNavRecord): string {
  // Deliberately excludes nav/navDate/navRaw/sourceLine/recordChecksum -- an
  // AmfiSchemeNavRecord's own recordChecksum bakes in the daily NAV value,
  // which changes every run even when the scheme's IDENTITY has not, and
  // would otherwise open a new effective-dated row every single day.
  const parts = [
    r.schemeName, r.amcName ?? '', r.schemeStructure, r.categoryHeaderRaw,
    r.categoryGroup ?? '', r.subCategory, r.planRaw, r.planType ?? '',
    r.optionRaw, r.optionType ?? '', r.isinGrowthOrPayout ?? '', r.isinReinvestment ?? '',
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

interface CurrentRow {
  id: string;
  record_checksum: string;
}

export async function writeSchemeMasterRows(
  db: SupabaseClient,
  records: AmfiSchemeNavRecord[],
  index: InstrumentResolutionIndex,
  opts: { countryCode: string; currencyCode: string; sourceId: string | null; importBatchId: string; asOfDate: string },
  chunkSize: number
): Promise<SchemeMasterWriteResult> {
  const counts: SchemeMasterWriteCounts = { resolved: 0, unresolved: 0, inserted: 0, unchanged: 0, superseded: 0 };
  const errors: string[] = [];

  // One record per AMFI scheme code per run -- AMFI's own file has exactly
  // that shape, but de-duplicate defensively (last one wins) rather than
  // trust it blindly.
  const byCode = new Map<string, AmfiSchemeNavRecord>();
  for (const r of records) byCode.set(r.amfiSchemeCode, r);

  const resolvedEntries: { instrumentId: string; record: AmfiSchemeNavRecord }[] = [];
  for (const record of byCode.values()) {
    const instrumentId = index.byAmfiCode.get(record.amfiSchemeCode) ?? (record.isinGrowthOrPayout ? index.byIsin.get(record.isinGrowthOrPayout) : undefined);
    if (!instrumentId) {
      counts.unresolved += 1;
      continue;
    }
    counts.resolved += 1;
    resolvedEntries.push({ instrumentId, record });
  }

  if (resolvedEntries.length === 0) return { counts, errors };

  const { data: currentRows, error: currentErr } = await db
    .from('ii_scheme_master')
    .select('id, amfi_scheme_code, record_checksum')
    .eq('country_code', opts.countryCode)
    .is('effective_to', null)
    .in('amfi_scheme_code', resolvedEntries.map((e) => e.record.amfiSchemeCode));
  if (currentErr) {
    errors.push(currentErr.message);
    return { counts, errors };
  }
  const currentByCode = new Map<string, CurrentRow>((currentRows ?? []).map((r) => [r.amfi_scheme_code as string, { id: r.id as string, record_checksum: r.record_checksum as string }]));

  const toClose: string[] = []; // ii_scheme_master.id
  const toInsert: Record<string, unknown>[] = [];

  for (const { instrumentId, record } of resolvedEntries) {
    const checksum = identityChecksum(record);
    const current = currentByCode.get(record.amfiSchemeCode);
    if (current) {
      if (current.record_checksum === checksum) {
        counts.unchanged += 1;
        continue;
      }
      toClose.push(current.id);
      counts.superseded += 1;
    }
    toInsert.push({
      instrument_id: instrumentId,
      amfi_scheme_code: record.amfiSchemeCode,
      scheme_name: record.schemeName,
      amc_name: record.amcName,
      isin_growth_or_payout: record.isinGrowthOrPayout,
      isin_reinvestment: record.isinReinvestment,
      plan_raw: record.planRaw || null,
      plan_type: record.planType,
      option_raw: record.optionRaw || null,
      option_type: record.optionType,
      scheme_structure: record.schemeStructure,
      category_header_raw: record.categoryHeaderRaw,
      category_group: record.categoryGroup,
      sub_category: record.subCategory,
      country_code: opts.countryCode,
      currency_code: opts.currencyCode,
      source_id: opts.sourceId,
      import_batch_id: opts.importBatchId,
      record_checksum: checksum,
      effective_from: opts.asOfDate,
      effective_to: null,
    });
  }

  // Close out superseded "current" rows FIRST -- the unique index
  // (country_code, amfi_scheme_code) where effective_to is null allows only
  // one open row at a time, so the old one must stop being open before the
  // new one can become it.
  for (let i = 0; i < toClose.length; i += chunkSize) {
    const slice = toClose.slice(i, i + chunkSize);
    const { error } = await db.from('ii_scheme_master').update({ effective_to: opts.asOfDate }).in('id', slice);
    if (error) errors.push(error.message);
  }

  for (let i = 0; i < toInsert.length; i += chunkSize) {
    const slice = toInsert.slice(i, i + chunkSize);
    const { error } = await db.from('ii_scheme_master').insert(slice);
    if (error) {
      errors.push(error.message);
      continue;
    }
    counts.inserted += slice.length;
  }

  return { counts, errors };
}
