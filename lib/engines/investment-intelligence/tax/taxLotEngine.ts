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
//
// ---------------------------------------------------------------------------
// LOT SCOPE — (user, ACCOUNT, instrument). II-PC1-F1, 2026-09-02.
// ---------------------------------------------------------------------------
// FIFO candidacy is scoped to the DISPOSING ACCOUNT as well as the
// instrument. A redemption booked against one folio/demat account may only
// consume lots opened in THAT SAME account — never a lot opened in another
// folio, even when both folios hold the identical scheme/ISIN.
//
// This engine previously matched on `instrumentKey` alone, which let a
// Folio B redemption consume a chronologically older Folio A lot whenever a
// user held the same scheme in two folios (the dataset is already
// user-scoped, so contamination was never cross-user — but it was
// cross-account). II-PC1 disclosed this as a known, unfixed architectural
// characteristic; II-PC1-F1 established the correct rule and repaired it.
//
// Authority for the rule (see docs/investment-intelligence/
// II_PC1_F1_FIFO_SCOPE_DECISION.md for the full evidence chain):
//   * CBDT Circular No. 768 dated 24-6-1998, interpreting s.45(2A) of the
//     Income-tax Act 1961: "where an investor has more than one security
//     account, FIFO method will be applied accountwise", because
//     "securities lying in his other account cannot be construed to have
//     been sold as they continue to remain in that account".
//   * For non-demat (folio-mode) mutual-fund units the same result follows
//     directly from s.45 itself: a redemption instruction names one folio
//     and transfers only the units standing to that folio's credit, so
//     units in another folio are not transferred at all and no charge can
//     attach to them.
//   * CAMS/KFintech realised-capital-gains statements — the documents the
//     taxpayer actually files from — apply FIFO within a folio.
//
// `accountKey` is a REQUIRED field, deliberately not optional: making it
// optional would let a caller silently fall back to the old, incorrect
// instrument-wide behaviour by omission. It carries the canonical
// `ii_accounts.id` — never an institution name, folio-number string, AMC
// name, source-document id, or display label.
// ---------------------------------------------------------------------------

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
  /** Canonical `ii_accounts.id` (folio / demat account) this acquisition was
   * booked under. Half of the lot-scope key — see the LOT SCOPE header. */
  accountKey: string;
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
  /** Canonical `ii_accounts.id` the redemption/switch-out/sale was booked
   * against. FIFO may only consume lots carrying this same accountKey. */
  accountKey: string;
  instrumentKey: string;
  disposalDate: IsoDate;
  units: number;
  /** Total proceeds for the whole disposal — apportioned pro-rata per unit
   * across the lots FIFO consumes. */
  saleValue: number;
}

export interface TaxLot {
  lotId: string; // derived deterministically from sourceEventId, stable across recomputation
  /** Canonical `ii_accounts.id` this lot belongs to — persisted verbatim to
   * `ii_tax_lots.account_id`, which R3 publication reads back when it
   * computes a position's cost basis per (account_id, instrument_id). */
  accountKey: string;
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
  /** The account both sides of this consumption belong to. By construction
   * (see consumeLotsFifo) the consumed lot's account and the disposal's
   * account are always identical — a differing pair is unrepresentable. */
  accountKey: string;
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
 * of acquisition events. Callers may safely pass every acquisition the user
 * has, across all accounts and instruments, in one array: consumption below
 * partitions by (accountKey, instrumentKey), so a mixed pool cannot leak
 * units between folios or between schemes.
 */
export function buildTaxLots(events: readonly AcquisitionEvent[]): TaxLot[] {
  return events.map((e) => {
    // II-PC1-F1 RUNTIME GUARD. The TypeScript `accountKey: string` is the
    // first line of defence, but it is not the last: data deserialised from
    // JSON (certification case packs, cached payloads, API bodies) is cast
    // to these interfaces without the compiler ever seeing the real shape.
    // An `undefined` accountKey on BOTH sides of the candidacy comparison in
    // consumeLotsFifo would compare EQUAL and silently restore the exact
    // instrument-wide behaviour this dispatch removed — a silent wrong tax
    // answer. Fail loudly instead.
    if (!e.accountKey) throw new Error(`buildTaxLots: acquisition event ${e.sourceEventId} has no accountKey — FIFO is account-scoped and cannot place a lot without its canonical account`);
    if (e.units < 0) throw new Error(`buildTaxLots: negative units in acquisition event ${e.sourceEventId}`);
    if (e.costPerUnit < 0) throw new Error(`buildTaxLots: negative costPerUnit in acquisition event ${e.sourceEventId}`);
    return {
      lotId: `lot:${e.sourceEventId}`,
      accountKey: e.accountKey,
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
 * sort key — `loadTaxDataset` orders by transaction_date then transaction
 * id, and Array.prototype.sort is stable per ES2019, so equal-dated lots
 * resolve by ascending transaction id) for a single disposal event.
 *
 * Candidate lots are restricted to the DISPOSING ACCOUNT and instrument.
 * Mutates `lots` in place
 * (decrementing `unitsRemaining`) and returns the per-lot consumption
 * records. Supports partial-lot consumption — a disposal can consume the
 * remainder of one lot plus part of the next — and never consumes more
 * units than a lot actually holds (enforced by the running-balance loop,
 * not by trusting the caller).
 */
export function consumeLotsFifo(lots: TaxLot[], disposal: DisposalEvent): LotConsumption[] {
  // Same runtime guard as buildTaxLots — see there for why the type alone is
  // not sufficient. Without this, a disposal deserialised from JSON with no
  // accountKey would match `undefined === undefined` against JSON-built lots
  // and silently revert to instrument-wide FIFO.
  if (!disposal.accountKey) {
    throw new Error(`consumeLotsFifo: disposal ${disposal.sourceEventId} has no accountKey — FIFO is account-scoped and cannot resolve candidate lots without the disposing account`);
  }

  // LOT CANDIDACY — (account, instrument), not instrument alone. See this
  // module's LOT SCOPE header for the legal and canonical-model authority.
  // The account predicate is deliberately FIRST: it is the constraint that
  // was missing, and reading it first makes the scope self-documenting at
  // the single point where it is enforced.
  const candidateLots = lots
    .filter((l) => l.accountKey === disposal.accountKey && l.instrumentKey === disposal.instrumentKey && l.unitsRemaining > EPSILON)
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
      accountKey: lot.accountKey, // === disposal.accountKey by the candidacy filter above
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
    // The account is named explicitly: under account-scoped FIFO this is the
    // honest diagnosis of "this folio does not hold enough units", which the
    // previous instrument-wide matching would have silently masked by
    // borrowing units from a DIFFERENT folio and reporting a confident but
    // wrong cost basis, holding period and gain.
    throw new Error(
      `consumeLotsFifo: disposal ${disposal.sourceEventId} for ${disposal.units} units of ` +
        `${disposal.instrumentKey} in account ${disposal.accountKey} exceeds that account's ` +
        `available open-lot balance by ${remainingToConsume}`
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
