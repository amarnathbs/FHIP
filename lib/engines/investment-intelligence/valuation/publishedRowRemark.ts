// Investment Intelligence — Net Worth "current NAV" re-mark (PO decision
// 2026-10-01). Pure functions, no I/O.
//
// WHAT THIS DECIDES
// -----------------
// A published Investment Intelligence mutual-fund position reaches the
// canonical `investments` register EXACTLY ONCE (ii_fhip_publications' unique
// active-position index, migration 0042). That row's `current_value` used to be
// frozen at the certified statement value. The Product Owner decided Net Worth
// must follow the latest eligible NAV instead (the same rule as the Holdings
// table). This module is the decision half of the mechanism that does it:
//
//   current_value = units x latest eligible NAV, where
//     * units come from the position's OWN certified snapshot (the one the
//       active publication points at) -- never from a later unpublished
//       statement, never from the register row;
//     * "latest eligible NAV" and its fallback to the statement value are
//       decided by valueHoldingAsOf() in ./currentHoldingValuation.ts -- the
//       ONE rule shared with Holdings / X-Ray / Overview / Performance. This
//       module re-implements none of it.
//
// WHAT IT NEVER DOES
// ------------------
//   * It never creates a row. It only plans an in-place change to the single
//     register row a publication already owns, so a re-mark can never add a
//     second contribution to Net Worth.
//   * It never touches a manual row (the caller supplies only II-published
//     rows; this module additionally refuses a row with no publication).
//   * It never plans a change for an entity-owned account (Trust / HUF /
//     Company): those stay out of personal Net Worth (PO ruling 2026-09-21).
//   * It never "fixes" a missing NAV by inventing one: no eligible NAV newer
//     than the statement => the statement value, labelled as a statement.
//
// IDEMPOTENCY
// -----------
// Every plan carries a deterministic `fingerprint` of the inputs that produced
// the value. Re-planning the same inputs yields `unchanged`, so repeated reads
// perform no writes and no new revision rows.

import {
  NAV_STALE_AFTER_DAYS,
  valueHoldingAsOf,
  type HoldingValuation,
  type NavObservationRow,
  type ValuationBasis,
} from './currentHoldingValuation';

export const REMARK_RULE_VERSION = 'nav-remark-v1';

/** Register amounts are numeric(18,2): the stored value is rounded to 2 places. */
export function roundRegisterAmount(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export type RemarkSkipReason =
  | 'not_mutual_fund' // only NAV-priced (mutual fund) positions are re-marked; equity/ETF keep their certified value
  | 'entity_owned' // Trust / HUF / Company: not personal Net Worth
  | 'no_certified_position' // the publication's snapshot could not be read: leave the value alone
  | 'currency_mismatch' // register row and certified snapshot disagree on currency: never guess
  | 'no_valuation'; // the shared rule produced no value

/** Everything the planner needs about ONE published register row. */
export interface RemarkRowInput {
  investmentId: string;
  publicationId: string;
  instrumentId: string;
  accountId: string;
  /** ii_instruments.instrument_class; null/unknown => not re-marked. */
  instrumentClass: string | null;
  /** investments.currency_code */
  rowCurrency: string;
  /** investments.current_value as stored now */
  rowCurrentValue: number;
  /** What the previous re-mark stored on the row (all null before the first one). */
  previous: {
    fingerprint: string | null;
    basis: string | null;
    units: number | null;
    nav: number | null;
    asOf: string | null;
  };
  /** True when an active ownership allocation gives a business entity a share of the account. */
  entityOwned: boolean;
  /** The position's own certified snapshot (ii_holding_snapshots row the active publication names). */
  certified: { asOfDate: string; units: number; value: number; currencyCode: string } | null;
}

export type RemarkUpdateReason = 'baseline' | 'nav_update' | 'nav_correction' | 'units_changed' | 'drift_correction';

export interface RemarkColumns {
  current_value: number;
  ii_value_as_of: string | null;
  ii_valuation_basis: Exclude<ValuationBasis, 'unavailable'>;
  ii_valuation_units: number;
  ii_valuation_nav: number | null;
  ii_valuation_fingerprint: string;
}

export type RemarkPlan =
  | { action: 'skip'; reason: RemarkSkipReason }
  | { action: 'unchanged'; fingerprint: string }
  | {
      action: 'update';
      reason: RemarkUpdateReason;
      newValue: number;
      previousValue: number;
      fingerprint: string;
      valuation: HoldingValuation;
      columns: RemarkColumns;
    };

function priceKey(n: number | null): string {
  return n === null || !Number.isFinite(n) ? 'none' : n.toFixed(6);
}

/** Deterministic identity of the inputs behind a re-marked value. */
export function remarkFingerprint(parts: {
  publicationId: string;
  statementAsOf: string;
  units: number;
  basis: string;
  navDate: string | null;
  nav: number | null;
  value: number;
}): string {
  return [
    REMARK_RULE_VERSION,
    parts.publicationId,
    parts.statementAsOf,
    parts.units.toFixed(6),
    parts.basis,
    parts.navDate ?? 'none',
    priceKey(parts.nav),
    parts.value.toFixed(2),
  ].join('|');
}

function classifyUpdate(row: RemarkRowInput, valuation: HoldingValuation): RemarkUpdateReason {
  if (row.previous.fingerprint === null) return 'baseline';
  if (row.previous.units !== null && Math.abs(row.previous.units - (valuation.units ?? 0)) > 1e-6) return 'units_changed';
  if (valuation.basis === 'market_nav' && row.previous.basis === 'market_nav' && row.previous.asOf === valuation.navDate) return 'nav_correction';
  if (row.previous.basis !== valuation.basis || row.previous.asOf !== valuation.valuationDate) return 'nav_update';
  return 'drift_correction';
}

/**
 * Plans the re-mark of ONE published row against the NAV candidates for its
 * instrument. `asOfDate` is the valuation date ("today", ISO yyyy-mm-dd).
 */
export function planRowRemark(row: RemarkRowInput, navs: readonly NavObservationRow[], asOfDate: string): RemarkPlan {
  if (row.entityOwned) return { action: 'skip', reason: 'entity_owned' };
  if (row.instrumentClass !== 'mutual_fund') return { action: 'skip', reason: 'not_mutual_fund' };
  if (!row.certified) return { action: 'skip', reason: 'no_certified_position' };
  if (row.certified.currencyCode.toUpperCase() !== row.rowCurrency.toUpperCase()) return { action: 'skip', reason: 'currency_mismatch' };

  // THE shared rule, fed ONLY the position's own certified snapshot as its
  // statement: units can therefore never come from a later, unpublished one.
  const valuation = valueHoldingAsOf({
    statements: [{ asOfDate: row.certified.asOfDate, units: row.certified.units, value: row.certified.value, currencyCode: row.certified.currencyCode }],
    navs,
    asOfDate,
    currencyCode: row.rowCurrency,
    pointInTime: false,
  });
  if (valuation.basis === 'unavailable' || valuation.marketValue === null) return { action: 'skip', reason: 'no_valuation' };

  const newValue = roundRegisterAmount(valuation.marketValue);
  const fingerprint = remarkFingerprint({
    publicationId: row.publicationId,
    statementAsOf: row.certified.asOfDate.slice(0, 10),
    units: row.certified.units,
    basis: valuation.basis,
    navDate: valuation.navDate,
    nav: valuation.navSource === 'market' ? valuation.nav : null,
    value: newValue,
  });

  if (row.previous.fingerprint === fingerprint && roundRegisterAmount(row.rowCurrentValue) === newValue) {
    return { action: 'unchanged', fingerprint };
  }

  return {
    action: 'update',
    reason: classifyUpdate(row, valuation),
    newValue,
    previousValue: row.rowCurrentValue,
    fingerprint,
    valuation,
    columns: {
      current_value: newValue,
      ii_value_as_of: valuation.valuationDate,
      ii_valuation_basis: valuation.basis,
      ii_valuation_units: row.certified.units,
      // The stored NAV is the one that PRODUCED the value: the market NAV, or
      // the statement-implied NAV for a statement-basis row (units > 0).
      ii_valuation_nav: valuation.nav,
      ii_valuation_fingerprint: fingerprint,
    },
  };
}

// ---------------------------------------------------------------------------
// Presentation helpers (no I/O): what a stored valuation means TODAY.
// ---------------------------------------------------------------------------

export type StoredValuationTag = 'latest_nav' | 'statement_value' | 'stale_nav' | 'redeemed';

export interface StoredValuation {
  basis: string | null;
  asOf: string | null;
  units: number | null;
  nav: number | null;
}

function dayNumber(iso: string): number {
  return Math.round(Date.parse(`${iso.slice(0, 10)}T00:00:00.000Z`) / 86_400_000);
}

/**
 * How a stored valuation must be labelled today. The tag is derived from the
 * stored basis and as-of date plus today's date: staleness is a property of
 * time, so it is never persisted. Returns null for a row that has never been
 * re-marked (a manual row, or a published row not yet evaluated): no label is
 * invented for it.
 */
export function describeStoredValuation(v: StoredValuation, today: string): { tag: StoredValuationTag; ageDays: number | null; stale: boolean; label: string } | null {
  if (!v.basis) return null;
  if (v.basis === 'redeemed') return { tag: 'redeemed', ageDays: null, stale: false, label: 'Redeemed' };
  const ageDays = v.asOf ? Math.max(0, dayNumber(today) - dayNumber(v.asOf)) : null;
  const stale = ageDays !== null && ageDays > NAV_STALE_AFTER_DAYS;
  if (v.basis === 'market_nav') {
    return stale ? { tag: 'stale_nav', ageDays, stale, label: 'Stale NAV' } : { tag: 'latest_nav', ageDays, stale, label: 'Latest NAV' };
  }
  // 'statement': a statement value is never presented as a market NAV, stale or not.
  return { tag: 'statement_value', ageDays, stale, label: stale ? 'Statement value (stale)' : 'Statement value' };
}

export interface PublishedValuationSummary {
  /** Published, re-marked mutual-fund rows. */
  count: number;
  marketNavCount: number;
  statementCount: number;
  redeemedCount: number;
  staleCount: number;
  /** Oldest / newest valuation date across the NAV- or statement-priced rows. */
  oldestAsOf: string | null;
  latestAsOf: string | null;
}

export function summarisePublishedValuations(rows: readonly StoredValuation[], today: string): PublishedValuationSummary {
  const out: PublishedValuationSummary = { count: 0, marketNavCount: 0, statementCount: 0, redeemedCount: 0, staleCount: 0, oldestAsOf: null, latestAsOf: null };
  for (const row of rows) {
    const d = describeStoredValuation(row, today);
    if (!d) continue;
    out.count += 1;
    if (d.tag === 'redeemed') {
      out.redeemedCount += 1;
      continue;
    }
    if (d.tag === 'statement_value') out.statementCount += 1;
    else out.marketNavCount += 1;
    if (d.stale) out.staleCount += 1;
    if (row.asOf) {
      if (out.oldestAsOf === null || row.asOf < out.oldestAsOf) out.oldestAsOf = row.asOf;
      if (out.latestAsOf === null || row.asOf > out.latestAsOf) out.latestAsOf = row.asOf;
    }
  }
  return out;
}
