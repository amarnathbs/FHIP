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
import type { NavObservationRow, UnitMovementInput } from '@/lib/engines/investment-intelligence/valuation/currentHoldingValuation';
import { unitDeltaForTransaction, type ReconciliationTransactionInput } from './reconciliation';

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

// ---------------------------------------------------------------------------
// Unit movements after a statement (multi-folio fix, 2026-10-01).
// ---------------------------------------------------------------------------

/** The folio ("position") key every per-folio map in this module family uses. */
export function positionKey(accountId: string | null | undefined, instrumentId: string): string {
  return `${accountId ?? ''}:${instrumentId}`;
}

export interface UnitMovementDbRow {
  account_id?: string | null;
  instrument_id: string;
  transaction_type: string;
  transaction_date: string;
  units: number | string | null;
  status?: string | null;
}

/**
 * The signed net unit change of one transaction, using the SAME direction
 * table the certified reconciliation engine uses (reconciliation.ts:
 * unitDeltaForTransaction), so a purchase adds, a redemption subtracts and a
 * cash-only event (fee, tax, non-reinvested dividend) moves nothing - never a
 * second, independently guessed sign rule. Reversed and review_required rows
 * are excluded exactly as Performance excludes them. Returns null when the
 * row moves no units.
 */
export function toUnitMovement(row: UnitMovementDbRow): UnitMovementInput | null {
  if (row.status === 'reversed' || row.status === 'review_required') return null;
  const unitsNum = row.units === null || row.units === undefined ? null : Number(row.units);
  if (unitsNum !== null && !Number.isFinite(unitsNum)) return null;
  const delta =
    Number(
      unitDeltaForTransaction({
        canonicalType: row.transaction_type as ReconciliationTransactionInput['canonicalType'],
        unitsScaled: unitsNum === null ? null : BigInt(Math.round(unitsNum * 1_000_000)),
      })
    ) / 1_000_000;
  if (delta === 0) return null;
  return { date: String(row.transaction_date).slice(0, 10), unitDelta: delta };
}

/** Groups unit movements by folio (account:instrument). */
export function groupUnitMovements(rows: readonly UnitMovementDbRow[]): Map<string, UnitMovementInput[]> {
  const byPosition = new Map<string, UnitMovementInput[]>();
  for (const r of rows) {
    const m = toUnitMovement(r);
    if (!m) continue;
    const key = positionKey(r.account_id, r.instrument_id);
    const list = byPosition.get(key) ?? [];
    list.push(m);
    byPosition.set(key, list);
  }
  return byPosition;
}

/**
 * Per-folio unit movements dated after `sinceIso` (strictly). Only
 * transactions newer than the OLDEST statement being valued can ever matter,
 * so the common case (every statement newer than every transaction) reads zero
 * rows. Callers still apply the exact per-folio cut-off inside
 * valueHoldingAsOf, so a client double that ignores `.gt()` cannot change a
 * number. Read-only; paged with the module's single pagination helper.
 */
export async function loadUnitMovementsSince(
  supabase: SupabaseClient,
  userId: string,
  sinceIso: string | null
): Promise<Map<string, UnitMovementInput[]>> {
  const rows = await fetchAllRows<UnitMovementDbRow>(() => {
    let q = supabase
      .from('ii_transactions')
      .select('account_id, instrument_id, transaction_type, transaction_date, units, status')
      .eq('user_id', userId);
    if (sinceIso) q = q.gt('transaction_date', sinceIso);
    return q.order('transaction_date', { ascending: true }).order('id', { ascending: true });
  });
  return groupUnitMovements(rows);
}
