// Investment Intelligence R6-P1 — exit-load computation. Holding-period-
// dependent per lot, exactly like the tax computation, and deliberately
// reuses the SAME FIFO lot-matching output (`LotConsumption[]` from
// taxLotEngine.ts) rather than re-deriving which lots a redemption
// consumed — there is exactly one FIFO matcher in this module, used by both
// the tax engine and the exit-load engine.
//
// TER (Total Expense Ratio) is surfaced separately (see `TerContext` below)
// as pure cost-drag information — it is NEVER combined into the tax
// computation. Conflating a running cost-of-holding percentage with a
// point-in-time tax liability would misrepresent both.

import type { LotConsumption } from './taxLotEngine';

/** One tier of an exit-load schedule: "if redeemed within `uptoDays` days of
 * acquisition, apply `loadPct`". Tiers should be supplied in ascending
 * `uptoDays` order; the first tier whose `uptoDays` >= holding period wins.
 * A scheme with no exit load can pass an empty schedule (treated as 0%). */
export interface ExitLoadTier {
  uptoDays: number;
  loadPct: number;
}

export interface ExitLoadSchedule {
  instrumentKey: string;
  tiers: readonly ExitLoadTier[]; // ascending uptoDays; e.g. [{uptoDays: 365, loadPct: 1}] means 1% within 12 months, 0% after
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface LotExitLoadResult {
  lotId: string;
  disposalEventId: string;
  holdingDays: number;
  applicableLoadPct: number;
  redemptionValueApportioned: number;
  exitLoadAmount: number;
}

function holdingDaysOf(acquisitionDate: string, disposalDate: string): number {
  const [ay, am, ad] = acquisitionDate.split('-').map(Number);
  const [dy, dm, dd] = disposalDate.split('-').map(Number);
  return Math.round((Date.UTC(dy, dm - 1, dd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** Resolve the applicable load% for a given holding-period-in-days against
 * an ascending-tier schedule. No matching tier (holding period beyond the
 * schedule's last uptoDays) means the load has fully decayed to zero. */
export function resolveExitLoadPct(tiers: readonly ExitLoadTier[], holdingDays: number): number {
  const sorted = [...tiers].sort((a, b) => a.uptoDays - b.uptoDays);
  const tier = sorted.find((t) => holdingDays <= t.uptoDays);
  return tier ? tier.loadPct : 0;
}

/**
 * Compute exit load per FIFO-matched lot consumption. Reuses the
 * `LotConsumption[]` produced by `consumeLotsFifo` — does not re-match lots.
 */
export function computeExitLoadForConsumptions(
  consumptions: readonly LotConsumption[],
  schedule: ExitLoadSchedule
): LotExitLoadResult[] {
  return consumptions
    .filter((c) => c.instrumentKey === schedule.instrumentKey)
    .map((c) => {
      const holdingDays = holdingDaysOf(c.acquisitionDate, c.disposalDate);
      const applicableLoadPct = resolveExitLoadPct(schedule.tiers, holdingDays);
      const exitLoadAmount = (c.saleValueApportioned * applicableLoadPct) / 100;
      return {
        lotId: c.lotId,
        disposalEventId: c.disposalEventId,
        holdingDays,
        applicableLoadPct,
        redemptionValueApportioned: c.saleValueApportioned,
        exitLoadAmount,
      };
    });
}

// ---------------------------------------------------------------------------
// TER / cost-drag intelligence — informational only, never a tax figure.
// ---------------------------------------------------------------------------

export interface TerContext {
  instrumentKey: string;
  terPct: number; // annualised, e.g. 1.05 for 1.05%
  asOfDate: string;
  classification: 'informational_cost_intelligence';
  note: string;
}

export function buildTerContext(instrumentKey: string, terPct: number, asOfDate: string): TerContext {
  return {
    instrumentKey,
    terPct,
    asOfDate,
    classification: 'informational_cost_intelligence',
    note:
      `Total Expense Ratio ${terPct}% is a recurring annual cost-drag on returns, disclosed as of ${asOfDate}. ` +
      'This is cost context, not a tax figure, and is never combined with the capital-gains computation.',
  };
}
