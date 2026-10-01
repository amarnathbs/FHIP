// Investment Intelligence — Document2 Finding #5 (2026-10-01). Shared read
// helper for every consumer that needs "the NAV candidates newer than a
// position's statement". Read-only. The SELECTION rule itself lives in
// lib/engines/investment-intelligence/valuation/currentHoldingValuation.ts;
// this file only fetches the candidate rows, so no consumer re-implements
// the eligibility rule.
//
// Only rows dated on or after `sinceIso` are fetched: a NAV older than the
// oldest statement being valued can never supersede a statement, so reading a
// fund's whole multi-year NAV history just to pick the latest point would be
// pure waste. Paged with the module's single pagination helper (PostgREST's
// 1000-row cap silently truncates a plain select — see pagination.ts), with a
// unique tie-breaker so page boundaries are deterministic.

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './pagination';
import type { NavObservationRow } from '@/lib/engines/investment-intelligence/valuation/currentHoldingValuation';

interface NavDbRow {
  instrument_id: string;
  price_date: string;
  price: number | string;
  currency_code: string | null;
  quality_status: string | null;
}

export async function loadNavCandidatesSince(
  supabase: SupabaseClient,
  instrumentIds: readonly string[],
  sinceIso: string | null
): Promise<Map<string, NavObservationRow[]>> {
  const byInstrument = new Map<string, NavObservationRow[]>();
  if (instrumentIds.length === 0) return byInstrument;

  const rows = await fetchAllRows<NavDbRow>(() => {
    let q = supabase
      .from('ii_prices_nav')
      .select('instrument_id, price_date, price, currency_code, quality_status')
      .in('instrument_id', [...instrumentIds]);
    if (sinceIso) q = q.gte('price_date', sinceIso);
    return q.order('price_date', { ascending: true }).order('id', { ascending: true });
  });

  for (const r of rows) {
    const list = byInstrument.get(r.instrument_id) ?? [];
    list.push({
      date: String(r.price_date).slice(0, 10),
      price: Number(r.price),
      currencyCode: r.currency_code,
      qualityStatus: r.quality_status,
    });
    byInstrument.set(r.instrument_id, list);
  }
  return byInstrument;
}

/** Today's UTC calendar date, ISO yyyy-mm-dd. Injectable for tests via callers' `asOfDate`. */
export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}
