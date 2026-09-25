// PC6 — "which of these NAV rows already exist?" by EXACT (instrument, date)
// pair (2026-09-25).
//
// THE DEFECT THIS REPLACES. referenceIngestJob.ts asked PostgREST for
//   instrument_id IN (100 ids) AND price_date IN (every NAV date in the file)
// AMFI's NAVAll.txt carries 831 distinct NAV dates (2008-2026), because
// dormant schemes keep their last, years-old NAV in the file. With full
// history stored (~22.4M rows) that cross product returned 50,000-69,000
// rows per batch of 100 instruments (51-69 pages, 20-23 s per batch,
// measured read-only against production 2026-09-25) for ~144 batches. The
// production run took 1,212 s against a 28 s platform limit.
//
// THE FIX. Migration 0204's public.ii_prices_nav_existing_pairs(uuid[],
// date[]) joins the two parallel arrays against the unique (instrument_id,
// price_date) key, so it returns exactly the rows for the pairs asked about
// and nothing else. Each pair matches at most one row, so a call with at
// most 1000 pairs can never be truncated by PostgREST's 1000-row cap -- no
// paging, no silent truncation.
//
// SAME OUTPUT, SAME KEYING. The map is keyed `${instrument_id}|${price_date}`
// with the same ExistingObservation values the old lookup produced, so
// planImport() is untouched. tests/unit/pc6IngestExactPairLookup.test.ts
// compares the two lookups on one fixture.

import type { ExistingObservation, NavQualityStatus } from './referenceDataQuality';
import { mapWithConcurrency } from './ingestBudget';

export const EXACT_PAIR_LOOKUP_RPC = 'ii_prices_nav_existing_pairs';
/** PostgREST's db-max-rows. One pair matches at most one row, so this many pairs is always complete. */
export const EXACT_PAIR_MAX_PER_CALL = 1000;
/** 15 calls for a full NAVAll file; 8 in flight = 2 rounds (~0.9 s each, projected from a read-only production index-probe measurement, 2026-09-25). */
export const EXACT_PAIR_DEFAULT_CONCURRENCY = 8;

export interface NavPair {
  instrumentId: string;
  priceDate: string;
}

interface PairRow {
  instrument_id: string;
  price_date: string;
  price: number | string;
  record_checksum: string | null;
  quality_status: NavQualityStatus;
}

/** The minimal client surface used here (supabase-js's `rpc`). */
export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
}

export type ExistingStateLookupErrorCode = 'EXACT_PAIR_LOOKUP_UNAVAILABLE' | 'EXISTING_STATE_LOOKUP_FAILED';

export class ExistingStateLookupError extends Error {
  constructor(public readonly code: ExistingStateLookupErrorCode, message: string) {
    super(message);
    this.name = 'ExistingStateLookupError';
  }
}

export const pairKey = (instrumentId: string, priceDate: string) => `${instrumentId}|${priceDate}`;

/**
 * Load the stored observation for every given pair that exists.
 *
 * Duplicate pairs are asked about once. Chunks never exceed 1000 pairs
 * (a larger `chunkSize` is clamped). A chunk that returns more rows than it
 * asked about is a contract violation and throws rather than being trusted.
 */
export async function loadExistingObservations(
  db: RpcClient,
  pairs: NavPair[],
  opts: { chunkSize?: number; concurrency?: number } = {}
): Promise<Map<string, ExistingObservation>> {
  const chunkSize = Math.max(1, Math.min(opts.chunkSize ?? EXACT_PAIR_MAX_PER_CALL, EXACT_PAIR_MAX_PER_CALL));
  const unique = new Map<string, NavPair>();
  for (const p of pairs) unique.set(pairKey(p.instrumentId, p.priceDate), p);
  const list = [...unique.values()];

  const chunks: NavPair[][] = [];
  for (let i = 0; i < list.length; i += chunkSize) chunks.push(list.slice(i, i + chunkSize));

  const results = await mapWithConcurrency(chunks, opts.concurrency ?? EXACT_PAIR_DEFAULT_CONCURRENCY, async (chunk) => {
    const { data, error } = await db.rpc(EXACT_PAIR_LOOKUP_RPC, {
      p_instrument_ids: chunk.map((p) => p.instrumentId),
      p_price_dates: chunk.map((p) => p.priceDate),
    });
    if (error) {
      const missing = error.code === 'PGRST202' || /could not find the function/i.test(error.message);
      throw new ExistingStateLookupError(
        missing ? 'EXACT_PAIR_LOOKUP_UNAVAILABLE' : 'EXISTING_STATE_LOOKUP_FAILED',
        missing
          ? `The exact-pair lookup function ${EXACT_PAIR_LOOKUP_RPC} is not available (apply migration 0204): ${error.message}`
          : `Existing-state lookup failed: ${error.message}`
      );
    }
    const rows = (Array.isArray(data) ? data : []) as PairRow[];
    if (rows.length > chunk.length) {
      throw new ExistingStateLookupError(
        'EXISTING_STATE_LOOKUP_FAILED',
        `Existing-state lookup returned ${rows.length} rows for ${chunk.length} pairs; at most one row per pair is possible.`
      );
    }
    return rows;
  });

  const existing = new Map<string, ExistingObservation>();
  for (const rows of results) {
    for (const r of rows) {
      existing.set(pairKey(r.instrument_id, r.price_date), {
        value: String(r.price),
        recordChecksum: r.record_checksum ?? '',
        quality_status: r.quality_status,
      });
    }
  }
  return existing;
}
