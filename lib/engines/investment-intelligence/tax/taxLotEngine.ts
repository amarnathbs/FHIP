// Investment Intelligence R6-P1 — tax-lot architecture and FIFO matching.
//
// SCOPE BOUNDARY (deliberate, per spec): FIFO (First-In-First-Out) is the
// only lot-matching method this release supports. LIFO and
// specific-identification are explicitly NOT implemented — a future release
// would add them as an alternative `MatchMethod`, but this engine hard-codes
// FIFO consumption order and does not expose a method parameter that could
// silently do the wrong thing if called with anything else.
//
// Every acquisition event (purchase, SIP instalment, switch-in, dividend
// reinvestment, bonus allotment, forward/reverse split) produces its OWN tax
// lot with its own acquisition date — this is what lets bonus units and
// reinvestment units carry their correct (later, separate) acquisition date
// for holding-period purposes, rather than inheriting the original
// investment's date.

import type { IsoDate } from './holdingPeriod';

export type AcquisitionKind =
  | 'purchase'
  | 'sip'
  | 'switch_in'
  | 'dividend_reinvestment'
  | 'bonus'
  | 'split_in';

export interface AcquisitionEvent {
  /** Stable id of the originating transaction/event — carried through onto
   * the lot for traceability, never used for matching logic itself. */
  sourceEventId: string;
  instrumentKey: string; // scheme/instrument identifier lots are scoped to
  kind: AcquisitionKind;
  acquisitionDate: IsoDate;
  units: number;
  /** Cost basis per unit. Bonus units are legally acquired at NIL cost
   * (0), which callers must pass explicitly — this engine does not invent a
   * zero default silently, to make the "why is this lot's cost 0" auditable
   * from the input rather than a hidden engine assumption. */
  costPerUnit: number;
}

export interface DisposalEvent {
  sourceEventId: string;
  instrumentKey: string;
  disposalDate: IsoDate;
  units: number;
  /** Total proceeds for the whole disposal — apportioned pro-rata per unit
   * across the lots FIFO consumes. */
  saleValue: number;
}

export interface TaxLot {
  lotId: string; // derived deterministically from sourceEventId, stable across recomputation
  instrumentKey: string;
  kind: AcquisitionKind;
  acquisitionDate: IsoDate;
  unitsAcquired: number;
  unitsRemaining: number;
  costPerUnit: number;
}

export interface LotConsumption {
  disposalEventId: string;
  lotId: string;
  instrumentKey: string;
  acquisitionDate: IsoDate;
  kind: AcquisitionKind;
  disposalDate: IsoDate;
  unitsConsumed: number;
  costPerUnit: number;
  costBasis: number; // unitsConsumed * costPerUnit (pre-grandfathering)
  saleValueApportioned: number; // unitsConsumed * (saleValue / totalUnitsDisposed)
}

const EPSILON = 1e-9;

/**
 * Build the initial set of open tax lots from a chronologically-ordered list
 * of acquisition events. Lots are built independently per instrument; the
 * caller is expected to have already scoped `events` to one instrument (or
 * this function partitions safely regardless since consumption below is
 * also instrument-scoped).
 */
export function buildTaxLots(events: readonly AcquisitionEvent[]): TaxLot[] {
  return events.map((e) => {
    if (e.units < 0) throw new Error(`buildTaxLots: negative units in acquisition event ${e.sourceEventId}`);
    if (e.costPerUnit < 0) throw new Error(`buildTaxLots: negative costPerUnit in acquisition event ${e.sourceEventId}`);
    return {
      lotId: `lot:${e.sourceEventId}`,
      instrumentKey: e.instrumentKey,
      kind: e.kind,
      acquisitionDate: e.acquisitionDate,
      unitsAcquired: e.units,
      unitsRemaining: e.units,
      costPerUnit: e.costPerUnit,
    };
  });
}

/**
 * Consume open lots FIFO (acquisition-date order, ties broken by input
 * order which callers should make deterministic e.g. via a stable secondary
 * sort key) for a single disposal event. Mutates `lots` in place
 * (decrementing `unitsRemaining`) and returns the per-lot consumption
 * records. Supports partial-lot consumption — a disposal can consume the
 * remainder of one lot plus part of the next — and never consumes more
 * units than a lot actually holds (enforced by the running-balance loop,
 * not by trusting the caller).
 */
export function consumeLotsFifo(lots: TaxLot[], disposal: DisposalEvent): LotConsumption[] {
  const candidateLots = lots
    .filter((l) => l.instrumentKey === disposal.instrumentKey && l.unitsRemaining > EPSILON)
    .sort((a, b) => (a.acquisitionDate < b.acquisitionDate ? -1 : a.acquisitionDate > b.acquisitionDate ? 1 : 0));

  let remainingToConsume = disposal.units;
  const consumptions: LotConsumption[] = [];

  for (const lot of candidateLots) {
    if (remainingToConsume <= EPSILON) break;
    const consumeFromThisLot = Math.min(lot.unitsRemaining, remainingToConsume);
    if (consumeFromThisLot <= EPSILON) continue;

    lot.unitsRemaining -= consumeFromThisLot;
    // Guard against float drift ever pushing units-remaining negative.
    if (lot.unitsRemaining < 0) {
      if (lot.unitsRemaining < -EPSILON) {
        throw new Error(`consumeLotsFifo: lot ${lot.lotId} over-consumed below zero units`);
      }
      lot.unitsRemaining = 0;
    }

    const saleValueApportioned = disposal.saleValue * (consumeFromThisLot / disposal.units);
    consumptions.push({
      disposalEventId: disposal.sourceEventId,
      lotId: lot.lotId,
      instrumentKey: lot.instrumentKey,
      acquisitionDate: lot.acquisitionDate,
      kind: lot.kind,
      disposalDate: disposal.disposalDate,
      unitsConsumed: consumeFromThisLot,
      costPerUnit: lot.costPerUnit,
      costBasis: consumeFromThisLot * lot.costPerUnit,
      saleValueApportioned,
    });

    remainingToConsume -= consumeFromThisLot;
  }

  if (remainingToConsume > EPSILON) {
    throw new Error(
      `consumeLotsFifo: disposal ${disposal.sourceEventId} for ${disposal.units} units of ` +
        `${disposal.instrumentKey} exceeds available open-lot balance by ${remainingToConsume}`
    );
  }

  return consumptions;
}

/**
 * Convenience: build lots and replay a chronological sequence of disposals
 * against them (mutating a fresh copy of the lots), returning both the
 * final lot state and every consumption record in disposal order. Useful
 * for tests/oracles that want the whole lifecycle in one call.
 */
export function replayFifo(
  acquisitions: readonly AcquisitionEvent[],
  disposals: readonly DisposalEvent[]
): { lots: TaxLot[]; consumptions: LotConsumption[] } {
  const lots = buildTaxLots(acquisitions);
  const consumptions: LotConsumption[] = [];
  for (const disposal of disposals) {
    consumptions.push(...consumeLotsFifo(lots, disposal));
  }
  return { lots, consumptions };
}
