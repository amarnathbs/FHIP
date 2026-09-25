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
import { fetchAllRows } from '../pagination';
import { mapWithConcurrency, type WriteBudget } from './ingestBudget';

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
  /**
   * Resolved schemes whose identity change was planned but NOT written in
   * this invocation because the time budget ran out (2026-09-25; see
   * ingestBudget.ts). 0 means the run is complete. A rerun re-reads current
   * state, so the written ones are then 'unchanged' and only these remain.
   */
  remaining: number;
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
  chunkSize: number,
  /**
   * Optional wall-clock budget (2026-09-25). Without one the writer runs to
   * completion, exactly as before. With one, it stops starting new write
   * chunks once the budget is used and reports what is left in `remaining`.
   */
  budget?: WriteBudget
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

  if (resolvedEntries.length === 0) return { counts, errors, remaining: 0 };

  // Chunked on the request side (an .in() filter with the full ~14,358-code
  // AMFI universe in one call risks the request URL itself, not just the
  // response, hitting a length limit) and fetchAllRows()'d on the response
  // side -- the exact same silent-truncation defect class R4/R5/PC6's own
  // referenceIngestJob.ts already hit: with the full universe resolved,
  // most of it now has a "current" row on every subsequent run, and an
  // unpaged select would only ever see the first page of it.
  //
  // Up to 4 chunks in flight (2026-09-25): 29 sequential reads took 5.8 s
  // against production, a fifth of the 28 s request limit.
  const allCodes = resolvedEntries.map((e) => e.record.amfiSchemeCode);
  const codeSlices: string[][] = [];
  for (let i = 0; i < allCodes.length; i += chunkSize) codeSlices.push(allCodes.slice(i, i + chunkSize));
  let currentRows: { id: string; amfi_scheme_code: string; record_checksum: string }[];
  try {
    const pages = await mapWithConcurrency(codeSlices, 4, (codeSlice) =>
      fetchAllRows<{ id: string; amfi_scheme_code: string; record_checksum: string }>(() =>
        db
          .from('ii_scheme_master')
          .select('id, amfi_scheme_code, record_checksum')
          .eq('country_code', opts.countryCode)
          .is('effective_to', null)
          .in('amfi_scheme_code', codeSlice)
          .order('id')
      )
    );
    currentRows = pages.flat();
  } catch (e) {
    errors.push(e instanceof Error ? e.message : 'Could not read current scheme-master state.');
    return { counts, errors, remaining: 0 };
  }
  const currentByCode = new Map<string, CurrentRow>(currentRows.map((r) => [r.amfi_scheme_code, { id: r.id, record_checksum: r.record_checksum }]));

  // One planned change per scheme whose identity is new or different;
  // `closeId` is the current row it replaces, if any.
  const changes: { closeId: string | null; row: Record<string, unknown> }[] = [];

  for (const { instrumentId, record } of resolvedEntries) {
    const checksum = identityChecksum(record);
    const current = currentByCode.get(record.amfiSchemeCode);
    if (current && current.record_checksum === checksum) {
      counts.unchanged += 1;
      continue;
    }
    changes.push({ closeId: current ? current.id : null, row: {
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
    } });
  }

  // Written chunk by chunk (2026-09-25; previously every close, then every
  // insert), so a budget can stop BETWEEN chunks without leaving a scheme
  // closed-but-not-replaced. Within a chunk the superseded "current" rows are
  // closed FIRST -- the unique index (country_code, amfi_scheme_code) where
  // effective_to is null allows only one open row at a time, so the old one
  // must stop being open before the new one can become it. A chunk whose
  // close fails is not inserted (the insert could only violate that index).
  let processed = 0;
  for (let i = 0; i < changes.length; i += chunkSize) {
    if (budget && !budget.canStart('scheme_master_chunk')) break;
    const slice = changes.slice(i, i + chunkSize);
    processed = i + slice.length;
    const writeChunk = async () => {
      const closeIds = slice.map((c) => c.closeId).filter((x): x is string => x !== null);
      if (closeIds.length > 0) {
        const { error } = await db.from('ii_scheme_master').update({ effective_to: opts.asOfDate }).in('id', closeIds);
        if (error) {
          errors.push(error.message);
          return;
        }
        counts.superseded += closeIds.length;
      }
      const { error } = await db.from('ii_scheme_master').insert(slice.map((c) => c.row));
      if (error) {
        errors.push(error.message);
        return;
      }
      counts.inserted += slice.length;
    };
    if (budget) await budget.time('scheme_master_chunk', writeChunk);
    else await writeChunk();
  }

  return { counts, errors, remaining: changes.length - processed };
}
