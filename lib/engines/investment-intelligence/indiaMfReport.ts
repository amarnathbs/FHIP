// India Mutual Fund Investment Report — PURE calculation module (no DB, no
// clock reads, no I/O). One table-style section added into the existing
// Monthly Report (see lib/engines/reportSectionsPremium.ts), modelled on the
// Product Owner's sample "Investment Summary".
//
// CLASSIFICATION: OBSERVATION (docs/investment-intelligence/
// R10_COMPLIANCE_AND_LANGUAGE.md). Every figure is a record of what the
// household's own uploaded statements and published NAVs show. Nothing here
// recommends, projects, or computes tax.
//
// ---------------------------------------------------------------------------
// DEFINITIONS (the same text is repeated in
// docs/investment-intelligence/INDIA_MF_INVESTMENT_REPORT_REPORT.md)
// ---------------------------------------------------------------------------
// Scope. Mutual-fund positions only (ii_instruments.instrument_class =
// 'mutual_fund') held in an INR account. A position is one (folio account,
// scheme) pair. Non-INR mutual funds and non-mutual-fund instruments are NOT
// shown here; they are counted in `excluded` and disclosed. Statuses
// 'reversed' and 'review_required' transactions are excluded exactly as R4/R6
// exclude them and counted in the footnote.
//
// Tile / column arithmetic (all INR, all as recorded, transaction_date <=
// valuation date):
//   A  Purchase       = sum |gross_amount| of purchase + sip
//   B  Switch In      = sum |gross_amount| of switch_in + stp_in
//   C  Switch Out     = sum |gross_amount| of switch_out + stp_out
//   D  Red/SWP        = sum |gross_amount| of redemption + swp
//   E  Dividend payout= sum |gross_amount| of dividend (cash IDCW payout)
//   F  Net Investment = A + B - C - D - E            (never stored independently)
//   G  Current Value  = units held x latest NAV on or before the valuation date
//   H  Overall Gain   = G - F                         (never stored independently)
//   XIRR%             = see below
// Dividend REINVESTMENT, bonus units and splits are non-cash: they add units
// (and, for reinvestment, cost) but are NOT in A..E, so a reinvested
// distribution appears in H as value rather than as cash. STP legs are
// treated as switch in / switch out. SWP is part of D. transfer_in/out,
// merger, segregation and unlabelled adjustments move units without cash;
// they are applied to the unit balance and FLAGGED as unmodelled in the
// position's basis rather than guessed at.
//
// Units held. The replayed ledger balance (reconciliation.ts
// unitDeltaForTransaction, the same signed rule the certified reconciliation
// engine uses). If a holding snapshot exists and the ledger disagrees with it
// by more than UNIT_TOLERANCE the STATEMENT's units (plus later transactions)
// win, and the position is flagged `ledgerDiffersFromStatement`.
//
// Cost basis and Avg NAV. costBasis.ts computeCostValue (average cost),
// restricted to units with a RECORDED cost (lots opened by transactions in the
// uploaded history). Avg NAV = cost value / units with recorded cost.
//
// Unrealised gain = (units with recorded cost x latest NAV) - cost value.
// Units that were already held before the earliest uploaded transaction have
// no recorded cost; they are valued in G but excluded from the unrealised
// gain, and the position carries a visible partial-history marker.
//
// Realised gain. R6's FIFO lot functions (taxLotEngine.ts buildTaxLots /
// consumeLotsFifo) applied per (account, scheme), with this report's disposal
// set: redemption, swp, switch_out, stp_out (R6 itself does not process swp
// or stp). Gain = proceeds apportioned to lots with a recorded cost - those
// lots' cost. Disposals that consume units with no recorded cost contribute
// nothing and are marked partial. NOT a tax computation: no holding-period
// classification, no grandfathering, no indexation. The certified R4/R6
// engines and their persisted results are not read or modified.
//
// Avg Days. Cost-weighted age, in days at the valuation date, of the units
// still held in lots with a recorded acquisition date (FIFO remaining lots).
// Bonus/split lots have zero cost weight. 'n/a' when no lot carries cost.
//
// Start Dt. Earliest unit-acquiring transaction (purchase, sip, switch_in,
// stp_in, reinvestment, bonus, transfer_in). `historyStartDate` is the
// earliest recorded transaction of any kind.
//
// XIRR. R4's xirr() engine on the position's own cash flows: purchase/sip/
// switch_in/stp_in/fee/tax are outflows; redemption/swp/switch_out/stp_out/
// dividend are inflows; reinvestment/bonus/split/transfer are not cash flows.
// Terminal flow = units with recorded cost x latest NAV on the NAV date.
// Measured on the recorded history only; a partial-history position carries
// the basis marker. Owner-level / portfolio-level XIRR pools the owner's
// flows EXCLUDING switch/STP legs (R4's PORTFOLIO_INTERNAL_TRANSFER rule:
// a switch moves money between two of the owner's own schemes).
// 'n/a' (with the engine's own reason) ONLY when the figure is mathematically
// undefined (no sign change, no flows, multiple roots, no valuation).
//
// Owner break-up. See resolveOwners(): active ii_ownership_allocation rows
// (basis points, exactly summing to 10000) win; else ii_accounts.
// owner_member_id at 100%; else the 'Unallocated / owner not set' section.
// Each owner's units and amounts are the position's x basis points / 10000;
// prices, Avg Days and XIRR are share-invariant. Sections are never summed
// across owners or entities (entity data separation ruling, PO 2026-09-21).
//
// NEVER INVENTED: a missing NAV falls back to the latest holding-snapshot
// price (labelled 'statement value'); with neither, current value is n/a. A
// missing index close is reported 'not_available'.
import { xirr, type CashFlow, type XirrUnavailableReason } from './xirr';
import { unitDeltaForTransaction } from '@/lib/services/investment-intelligence/reconciliation';
import { computeCostValue, type CostBasisTransaction } from '@/lib/services/investment-intelligence/costBasis';
import { buildTaxLots, consumeLotsFifo, type AcquisitionEvent, type TaxLot } from './tax/taxLotEngine';
import type { IiTransactionType } from '@/lib/services/investment-intelligence/types';

export const INDIA_MF_REPORT_VERSION = 'india-mf-report-v1';
/** Units are printed to 3-4 dp on a real statement; below this is rounding noise. */
export const UNIT_TOLERANCE = 0.001;
const OPENING_REFERENCE = 'OPENING_BALANCE';
const OPENING_LOT_ID_PREFIX = 'OPENING:';
const OPENING_LOT_DATE = '1900-01-01';
/** A NAV older than this many days at the valuation date is disclosed as stale. */
export const NAV_STALE_AFTER_DAYS = 10;
/** CAS guidance sentence requested by the PO for every partial-history marker. */
export const PARTIAL_HISTORY_GUIDANCE =
  'Older history is not in the uploaded statements. Until MFCentral integration is available, you can request a full Consolidated Account Statement (CAS) from CAMS or KFintech and upload it here.';

// ---------------------------------------------------------------------------
// Input contract
// ---------------------------------------------------------------------------
export interface MfAccount {
  id: string;
  folioNumber: string | null;
  ownerMemberId: string | null;
  currencyCode: string;
  countryCode: string | null;
  institutionName?: string | null;
}
export interface MfInstrument {
  id: string;
  name: string;
  isin: string | null;
  instrumentClass: string;
}
export interface MfTransaction {
  id: string;
  accountId: string;
  instrumentId: string;
  type: string;
  date: string; // YYYY-MM-DD
  units: number | null;
  amount: number;
  pricePerUnit: number | null;
  status: string;
  sourceReference: string | null;
}
export interface MfSnapshot {
  accountId: string;
  instrumentId: string;
  asOfDate: string;
  units: number;
  value: number;
}
export interface MfNav {
  instrumentId: string;
  date: string;
  price: number;
}
export type MfHistoryCompleteness = 'complete_from_inception' | 'complete_from_known_opening_balance' | 'partial_history' | 'holdings_only';
export interface MfTruth {
  accountId: string;
  instrumentId: string;
  status: string;
  historyCompleteness: MfHistoryCompleteness | null;
  unitVarianceWithinTolerance: boolean | null;
}
export interface MfAllocation {
  accountId: string;
  instrumentId: string | null;
  ownerMemberId: string | null;
  ownerEntityId: string | null;
  basisPoints: number;
  groupId: string;
  status: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}
export interface MfMember {
  id: string;
  fullName: string;
  relationship: string;
}
export interface MfEntity {
  id: string;
  name: string;
  entityType: string;
}
export interface MfIndexClose {
  date: string;
  value: number;
}
export interface IndiaMfReportInput {
  valuationDate: string;
  reportDate: string;
  accounts: MfAccount[];
  instruments: MfInstrument[];
  transactions: MfTransaction[];
  snapshots: MfSnapshot[];
  navs: MfNav[];
  truth: MfTruth[];
  allocations: MfAllocation[];
  members: MfMember[];
  entities: MfEntity[];
  sensex: MfIndexClose | null;
  nifty: MfIndexClose | null;
}

// ---------------------------------------------------------------------------
// Output contract
// ---------------------------------------------------------------------------
export type XirrOutcome =
  | { status: 'ok'; rate: number }
  | { status: 'na'; reason: string; detail: string };

export interface PositionBasis {
  /** True when the figures rest on recorded history that starts after the true inception, or on unmodelled events. */
  partial: boolean;
  historyStartDate: string | null;
  unitsWithoutRecordedCost: number;
  /** Units disposed that were held before the uploaded history began. */
  preHistoryUnitsDisposed: number;
  reasons: string[];
  /** The visible marker text, e.g. 'from 12-Dec-2022; earlier history not uploaded'. Null when the basis is complete. */
  label: string | null;
}

export interface PositionFlags {
  hasSwp: boolean;
  hasStp: boolean;
  hasBonusOrSplit: boolean;
  hasReinvestment: boolean;
  hasTransfer: boolean;
  hasUnmodelled: boolean;
  reviewExcludedCount: number;
  redeemed: boolean;
  noTransactions: boolean;
  ledgerDiffersFromStatement: boolean;
  navStale: boolean;
}

export interface MfPositionMetrics {
  accountId: string;
  instrumentId: string;
  folio: string | null;
  schemeName: string;
  isin: string | null;
  startDate: string | null;
  units: number;
  avgNav: number | null;
  latestNav: number | null;
  latestNavDate: string | null;
  navSource: 'market_nav' | 'statement_value' | 'none';
  purchase: number; // A
  switchIn: number; // B
  switchOut: number; // C
  redemptionSwp: number; // D
  dividend: number; // E
  netInvestment: number; // F
  currentValue: number | null; // G
  overallGain: number | null; // H
  unrealisedGain: number | null;
  realisedGain: number | null;
  avgDays: number | null;
  /** Internal pooling weights for Avg Days (cost-weighted). */
  ageWeightedSum: number;
  ageWeightSum: number;
  costValue: number | null;
  xirr: XirrOutcome;
  basis: PositionBasis;
  flags: PositionFlags;
  /** Dated flows used for pooled owner XIRR (investor sign; switch/STP legs tagged `internal`). */
  flows: PooledFlow[];
  terminal: { date: string; amount: number } | null;
}

export interface PooledFlow {
  date: string;
  amount: number;
  internal: boolean;
}

export interface OwnerRow extends Omit<MfPositionMetrics, 'flows' | 'terminal'> {
  /** The owner's share of this position, in basis points out of 10000. */
  shareBasisPoints: number;
  /** True when the folio is split between more than one owner. */
  jointFolio: boolean;
  flows: PooledFlow[];
  terminal: { date: string; amount: number } | null;
}

export interface OwnerTiles {
  purchase: number;
  switchIn: number;
  switchOut: number;
  redemptionSwp: number;
  dividend: number;
  netInvestment: number;
  currentValue: number;
  overallGain: number;
  /** Number of positions with no valuation (excluded from G). */
  unvaluedPositions: number;
  unrealisedGain: number;
  realisedGain: number;
  xirr: XirrOutcome;
  partialPositions: number;
  positionCount: number;
}

export type OwnerKind = 'personal' | 'entity' | 'unallocated';

export interface OwnerSection {
  key: string;
  kind: OwnerKind;
  label: string;
  /** 'Self', 'Spouse', ... for members; 'HUF', 'Family Trust', 'Company' for entities. */
  roleLabel: string | null;
  rows: OwnerRow[];
  tiles: OwnerTiles;
  totalAvgDays: number | null;
  notes: string[];
}

export interface IndexQuote {
  status: 'ok' | 'not_available';
  value: number | null;
  date: string | null;
  ageDays: number | null;
  reason: string | null;
}

export interface ReportFootnote {
  code: string;
  text: string;
  /** Scheme names (folio) the note applies to, when it is about specific funds. */
  affected: string[];
}

export interface IndiaMfReport {
  version: typeof INDIA_MF_REPORT_VERSION;
  valuationDate: string;
  reportDate: string;
  currency: 'INR';
  indices: { sensex: IndexQuote; nifty: IndexQuote };
  sections: OwnerSection[];
  footnotes: ReportFootnote[];
  excluded: { nonInrMutualFundPositions: number; nonMutualFundPositions: number };
  notSummedNote: string;
  /** Earliest date each fund's NAV history matters for (first recorded transaction), for NAV pinning. */
  earliestTransactionDateByInstrument: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const EPS = 1e-9;

function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00.000Z`);
  const b = Date.parse(`${toIso}T00:00:00.000Z`);
  return Math.round((b - a) / 86_400_000);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function formatIsoDateDMY(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return `${String(d).padStart(2, '0')}-${MONTHS[m - 1]}-${y}`;
}

const XIRR_REASON_TEXT: Record<string, string> = {
  ALL_SAME_SIGN: 'no sign change: money only went in or only came out',
  NO_TERMINAL_VALUE: 'no valuation dated on or after the last transaction',
  INVALID_DATES: 'a cash-flow date or amount was invalid',
  INSUFFICIENT_HISTORY: 'fewer than two cash flows',
  NOT_BRACKETED: 'no rate found that balances the cash flows',
  NO_CONVERGENCE: 'the calculation did not converge',
  MULTIPLE_ROOTS_AMBIGUOUS: 'more than one mathematically valid rate',
  NO_VALUATION: 'no NAV or statement value is available to value the holding',
};

function toXirrOutcome(flows: CashFlow[]): XirrOutcome {
  const r = xirr(flows);
  if (r.status === 'ok' && typeof r.rate === 'number') return { status: 'ok', rate: r.rate };
  const reason = (r.reason ?? 'NOT_BRACKETED') as XirrUnavailableReason | 'NO_VALUATION';
  return { status: 'na', reason, detail: XIRR_REASON_TEXT[reason] ?? r.detail ?? 'not calculable' };
}

function isoToDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

// ---------------------------------------------------------------------------
// Transaction classification
// ---------------------------------------------------------------------------
const A_TYPES = new Set(['purchase', 'sip']);
const B_TYPES = new Set(['switch_in', 'stp_in']);
const C_TYPES = new Set(['switch_out', 'stp_out']);
const D_TYPES = new Set(['redemption', 'swp']);
const INTERNAL_TYPES = new Set(['switch_in', 'switch_out', 'stp_in', 'stp_out']);
const COST_FLOW_TYPES = new Set(['fee', 'tax']);
const UNIMODELLED_UNIT_TYPES = new Set(['merger', 'segregation', 'adjustment', 'transfer', 'unclassified', 'reversal', 'split']);

interface LotEvent {
  id: string;
  date: string;
  kind: 'acquire' | 'dispose';
  units: number;
  cashAmount: number; // acquisitions: cost; disposals: proceeds (0 for non-cash)
  cash: boolean; // false for transfer_out / non-cash
  costPerUnit: number;
  acqKind: AcquisitionEvent['kind'];
  type: string;
}

function isOpeningMarker(t: MfTransaction): boolean {
  return t.type === 'adjustment' && t.sourceReference === OPENING_REFERENCE;
}

function usable(t: MfTransaction, valuationDate: string): boolean {
  return t.status !== 'reversed' && t.status !== 'review_required' && t.date <= valuationDate;
}

function acquisitionKindFor(type: string): AcquisitionEvent['kind'] {
  switch (type) {
    case 'sip':
      return 'sip';
    case 'switch_in':
    case 'stp_in':
    case 'transfer_in':
      return 'switch_in';
    case 'reinvestment':
      return 'dividend_reinvestment';
    case 'bonus':
      return 'bonus';
    case 'split':
      return 'split_in';
    default:
      return 'purchase';
  }
}

// ---------------------------------------------------------------------------
// One position
// ---------------------------------------------------------------------------
export interface PositionInputs {
  account: MfAccount;
  instrument: MfInstrument;
  transactions: MfTransaction[]; // all rows for this (account, instrument), any status/date
  snapshot: MfSnapshot | null; // latest snapshot on or before valuationDate
  nav: MfNav | null; // latest NAV on or before valuationDate
  truth: MfTruth | null;
  valuationDate: string;
}

export function computePosition(input: PositionInputs): MfPositionMetrics {
  const { account, instrument, snapshot, nav, truth, valuationDate } = input;
  const all = [...input.transactions].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
  const txns = all.filter((t) => usable(t, valuationDate));
  const reviewExcludedCount = all.filter((t) => t.status === 'review_required' && t.date <= valuationDate).length;

  // --- tiles A..E and the flags -------------------------------------------
  let purchase = 0;
  let switchIn = 0;
  let switchOut = 0;
  let redemptionSwp = 0;
  let dividend = 0;
  const flags: PositionFlags = {
    hasSwp: false,
    hasStp: false,
    hasBonusOrSplit: false,
    hasReinvestment: false,
    hasTransfer: false,
    hasUnmodelled: false,
    reviewExcludedCount,
    redeemed: false,
    noTransactions: txns.length === 0,
    ledgerDiffersFromStatement: false,
    navStale: false,
  };
  for (const t of txns) {
    const amt = Math.abs(t.amount);
    if (A_TYPES.has(t.type)) purchase += amt;
    else if (B_TYPES.has(t.type)) switchIn += amt;
    else if (C_TYPES.has(t.type)) switchOut += amt;
    else if (D_TYPES.has(t.type)) redemptionSwp += amt;
    else if (t.type === 'dividend') dividend += amt;
    if (t.type === 'swp') flags.hasSwp = true;
    if (t.type === 'stp_in' || t.type === 'stp_out') flags.hasStp = true;
    if (t.type === 'bonus' || t.type === 'split') flags.hasBonusOrSplit = true;
    if (t.type === 'reinvestment') flags.hasReinvestment = true;
    if (t.type === 'transfer_in' || t.type === 'transfer_out') flags.hasTransfer = true;
    if (UNIMODELLED_UNIT_TYPES.has(t.type) && !isOpeningMarker(t) && t.type !== 'split') flags.hasUnmodelled = true;
  }

  // --- unit balance ---------------------------------------------------------
  let ledgerUnits = 0;
  for (const t of txns) {
    ledgerUnits += Number(
      unitDeltaForTransaction({
        canonicalType: t.type as IiTransactionType,
        unitsScaled: t.units === null ? null : BigInt(Math.round(t.units * 1_000_000)),
      })
    ) / 1_000_000;
  }
  let unitsHeld = ledgerUnits;
  if (snapshot) {
    const laterDelta = txns
      .filter((t) => t.date > snapshot.asOfDate)
      .reduce(
        (sum, t) =>
          sum +
          Number(
            unitDeltaForTransaction({
              canonicalType: t.type as IiTransactionType,
              unitsScaled: t.units === null ? null : BigInt(Math.round(t.units * 1_000_000)),
            })
          ) / 1_000_000,
        0
      );
    const statementUnits = snapshot.units + laterDelta;
    if (Math.abs(statementUnits - ledgerUnits) > UNIT_TOLERANCE) {
      flags.ledgerDiffersFromStatement = true;
      unitsHeld = statementUnits;
    }
  }
  if (Math.abs(unitsHeld) <= UNIT_TOLERANCE) unitsHeld = 0;
  if (unitsHeld < 0) unitsHeld = 0; // a negative balance means missing history; never display negative units
  flags.redeemed = unitsHeld === 0 && txns.length > 0;

  // --- FIFO lots (R6 engine functions) --------------------------------------
  const lotEvents: LotEvent[] = [];
  let openingUnits = 0;
  let openingDate: string | null = null;
  for (const t of txns) {
    const units = t.units === null ? 0 : Math.abs(t.units);
    if (isOpeningMarker(t)) {
      const signed = Number(
        unitDeltaForTransaction({
          canonicalType: 'adjustment',
          unitsScaled: t.units === null ? null : BigInt(Math.round(t.units * 1_000_000)),
        })
      ) / 1_000_000;
      if (signed > 0) {
        openingUnits += signed;
        if (!openingDate || t.date < openingDate) openingDate = t.date;
      }
      continue;
    }
    if (units <= EPS) continue;
    const amt = Math.abs(t.amount);
    if (A_TYPES.has(t.type) || B_TYPES.has(t.type)) {
      lotEvents.push({ id: t.id, date: t.date, kind: 'acquire', units, cashAmount: amt, cash: true, costPerUnit: amt / units, acqKind: acquisitionKindFor(t.type), type: t.type });
    } else if (t.type === 'reinvestment') {
      lotEvents.push({ id: t.id, date: t.date, kind: 'acquire', units, cashAmount: amt, cash: false, costPerUnit: amt / units, acqKind: 'dividend_reinvestment', type: t.type });
    } else if (t.type === 'bonus') {
      lotEvents.push({ id: t.id, date: t.date, kind: 'acquire', units, cashAmount: 0, cash: false, costPerUnit: 0, acqKind: 'bonus', type: t.type });
    } else if (t.type === 'transfer_in') {
      lotEvents.push({ id: t.id, date: t.date, kind: 'acquire', units, cashAmount: amt, cash: false, costPerUnit: amt / units, acqKind: 'switch_in', type: t.type });
    } else if (t.type === 'split' && (t.units ?? 0) > 0) {
      lotEvents.push({ id: t.id, date: t.date, kind: 'acquire', units, cashAmount: 0, cash: false, costPerUnit: 0, acqKind: 'split_in', type: t.type });
    } else if (C_TYPES.has(t.type) || D_TYPES.has(t.type)) {
      lotEvents.push({ id: t.id, date: t.date, kind: 'dispose', units, cashAmount: amt, cash: true, costPerUnit: 0, acqKind: 'purchase', type: t.type });
    } else if (t.type === 'transfer_out') {
      lotEvents.push({ id: t.id, date: t.date, kind: 'dispose', units, cashAmount: 0, cash: false, costPerUnit: 0, acqKind: 'purchase', type: t.type });
    }
  }
  // Same-day ordering: acquisitions before disposals.
  lotEvents.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind === b.kind ? 0 : a.kind === 'acquire' ? -1 : 1));

  const acquisitions: AcquisitionEvent[] = [];
  if (openingUnits > EPS) {
    acquisitions.push({ sourceEventId: `${OPENING_LOT_ID_PREFIX}${account.id}:${instrument.id}`, accountKey: account.id, instrumentKey: instrument.id, kind: 'purchase', acquisitionDate: OPENING_LOT_DATE, units: openingUnits, costPerUnit: 0 });
  }
  const lots: TaxLot[] = buildTaxLots(acquisitions);
  const flowsRaw: Array<{ date: string; amount: number; type: string }> = [];
  const avgCostFeed: CostBasisTransaction[] = [];
  let realisedGain = 0;
  let realisedAny = false;
  let preHistoryUnitsDisposed = 0;
  let disposalsConsumedUnknownCost = false;

  for (const ev of lotEvents) {
    if (ev.kind === 'acquire') {
      const newLots = buildTaxLots([{ sourceEventId: ev.id, accountKey: account.id, instrumentKey: instrument.id, kind: ev.acqKind, acquisitionDate: ev.date, units: ev.units, costPerUnit: ev.costPerUnit }]);
      lots.push(...newLots);
      avgCostFeed.push({ grossAmount: ev.cashAmount, unitDelta: ev.units });
      continue;
    }
    // disposal: tolerant FIFO (cap at what is available; the rest pre-dates history)
    const available = lots.filter((l) => l.accountKey === account.id && l.instrumentKey === instrument.id).reduce((s, l) => s + l.unitsRemaining, 0);
    const coveredUnits = Math.min(ev.units, available);
    const uncoveredUnits = Math.max(0, ev.units - available);
    if (uncoveredUnits > UNIT_TOLERANCE) {
      preHistoryUnitsDisposed += uncoveredUnits;
      disposalsConsumedUnknownCost = true;
    }
    if (coveredUnits <= EPS) continue;
    const consumptions = consumeLotsFifo(lots, {
      sourceEventId: ev.id,
      accountKey: account.id,
      instrumentKey: instrument.id,
      disposalDate: ev.date,
      units: coveredUnits,
      saleValue: ev.cash ? ev.cashAmount * (coveredUnits / ev.units) : 0,
    });
    let knownUnits = 0;
    let knownProceeds = 0;
    for (const c of consumptions) {
      const unknownCostLot = c.lotId.startsWith(`lot:${OPENING_LOT_ID_PREFIX}`);
      if (unknownCostLot) {
        disposalsConsumedUnknownCost = true;
        preHistoryUnitsDisposed += c.unitsConsumed;
        continue;
      }
      knownUnits += c.unitsConsumed;
      knownProceeds += c.saleValueApportioned;
      if (ev.cash) {
        realisedGain += c.saleValueApportioned - c.costBasis;
        realisedAny = true;
      }
    }
    if (knownUnits > EPS) avgCostFeed.push({ grossAmount: 0, unitDelta: -knownUnits });
    if (ev.cash && knownProceeds > EPS) flowsRaw.push({ date: ev.date, amount: knownProceeds, type: ev.type });
  }

  // Outflows and non-lot flows, taken from the transaction list directly.
  for (const t of txns) {
    const amt = Math.abs(t.amount);
    if (A_TYPES.has(t.type) || B_TYPES.has(t.type) || COST_FLOW_TYPES.has(t.type)) {
      if (amt > 0) flowsRaw.push({ date: t.date, amount: -amt, type: t.type });
    } else if (t.type === 'dividend') {
      if (amt > 0) flowsRaw.push({ date: t.date, amount: amt, type: t.type });
    }
  }

  const { costValue, unitsAtCost } = computeCostValue(avgCostFeed);
  const unitsWithCost = Math.max(0, unitsAtCost);
  const unitsWithoutRecordedCost = Math.max(0, unitsHeld - unitsWithCost);

  // --- valuation ------------------------------------------------------------
  let latestNav: number | null = null;
  let latestNavDate: string | null = null;
  let navSource: MfPositionMetrics['navSource'] = 'none';
  if (nav && Number.isFinite(nav.price) && nav.price > 0 && nav.date <= valuationDate) {
    latestNav = nav.price;
    latestNavDate = nav.date;
    navSource = 'market_nav';
  } else if (snapshot && snapshot.units > EPS && snapshot.value > 0) {
    latestNav = snapshot.value / snapshot.units;
    latestNavDate = snapshot.asOfDate;
    navSource = 'statement_value';
  }
  if (latestNavDate && daysBetween(latestNavDate, valuationDate) > NAV_STALE_AFTER_DAYS) flags.navStale = true;

  const currentValue = unitsHeld === 0 ? 0 : latestNav === null ? null : unitsHeld * latestNav;
  const avgNav = unitsWithCost > EPS && costValue !== null ? costValue / unitsWithCost : null;
  const unrealisedGain = unitsWithCost <= EPS ? (unitsHeld === 0 ? 0 : null) : latestNav === null || costValue === null ? null : unitsWithCost * latestNav - costValue;

  // --- remaining lots: start date, avg days ---------------------------------
  const remainingKnown = lots.filter((l) => !l.lotId.startsWith(`lot:${OPENING_LOT_ID_PREFIX}`) && l.unitsRemaining > EPS);
  let ageWeightedSum = 0;
  let ageWeightSum = 0;
  for (const l of remainingKnown) {
    const weight = l.unitsRemaining * l.costPerUnit;
    if (weight <= EPS) continue;
    ageWeightedSum += weight * daysBetween(l.acquisitionDate, valuationDate);
    ageWeightSum += weight;
  }
  const avgDays = ageWeightSum > EPS ? ageWeightedSum / ageWeightSum : null;

  const acquiringTypes = new Set(['purchase', 'sip', 'switch_in', 'stp_in', 'reinvestment', 'bonus', 'transfer_in']);
  const startDate = txns.filter((t) => acquiringTypes.has(t.type)).map((t) => t.date).sort()[0] ?? null;
  const historyStartDate = txns.map((t) => t.date).sort()[0] ?? null;

  // --- basis marker ---------------------------------------------------------
  const reasons: string[] = [];
  if (flags.noTransactions) reasons.push('no_transactions_uploaded');
  if (unitsWithoutRecordedCost > UNIT_TOLERANCE) reasons.push('units_held_before_uploaded_history');
  if (preHistoryUnitsDisposed > UNIT_TOLERANCE || disposalsConsumedUnknownCost) reasons.push('disposal_of_units_before_uploaded_history');
  if (flags.hasUnmodelled || flags.hasTransfer) reasons.push('unit_adjustment_not_modelled');
  if (truth && (truth.historyCompleteness === 'partial_history' || truth.historyCompleteness === 'holdings_only') && !reasons.includes('units_held_before_uploaded_history') && !flags.noTransactions) {
    reasons.push('history_flagged_partial_by_reconciliation');
  }
  if (flags.ledgerDiffersFromStatement) reasons.push('ledger_differs_from_statement');
  const partial = reasons.length > 0;
  const startForLabel = openingDate ?? historyStartDate;
  let label: string | null = null;
  if (flags.noTransactions) {
    label = 'holding only; no transactions uploaded';
  } else if (partial) {
    label = startForLabel ? `from ${formatIsoDateDMY(startForLabel)}; earlier history not uploaded` : 'earlier history not uploaded';
    if (reasons.includes('unit_adjustment_not_modelled') && reasons.length === 1) label = 'includes a unit adjustment not modelled in cost';
    if (reasons.includes('ledger_differs_from_statement') && reasons.length === 1) label = 'transaction history does not match the statement units';
  }

  // --- XIRR (recorded history, units with recorded cost) --------------------
  let terminal: { date: string; amount: number } | null = null;
  if (unitsWithCost > EPS && latestNav !== null && latestNavDate) {
    terminal = { date: latestNavDate, amount: unitsWithCost * latestNav };
  }
  let xirrOutcome: XirrOutcome;
  if (flags.noTransactions) {
    xirrOutcome = { status: 'na', reason: 'INSUFFICIENT_HISTORY', detail: 'no transactions uploaded for this holding' };
  } else if (unitsWithCost > EPS && !terminal) {
    xirrOutcome = { status: 'na', reason: 'NO_VALUATION', detail: XIRR_REASON_TEXT.NO_VALUATION };
  } else {
    const cfs: CashFlow[] = flowsRaw.map((f) => ({ date: isoToDate(f.date), amount: f.amount }));
    if (terminal) cfs.push({ date: isoToDate(terminal.date), amount: terminal.amount });
    xirrOutcome = toXirrOutcome(cfs);
  }

  const flows: PooledFlow[] = flowsRaw.map((f) => ({ date: f.date, amount: f.amount, internal: INTERNAL_TYPES.has(f.type) }));

  const netInvestment = purchase + switchIn - switchOut - redemptionSwp - dividend;
  const overallGain = currentValue === null ? null : currentValue - netInvestment;

  return {
    accountId: account.id,
    instrumentId: instrument.id,
    folio: account.folioNumber,
    schemeName: instrument.name,
    isin: instrument.isin,
    startDate,
    units: unitsHeld,
    avgNav,
    latestNav,
    latestNavDate,
    navSource,
    purchase,
    switchIn,
    switchOut,
    redemptionSwp,
    dividend,
    netInvestment,
    currentValue,
    overallGain,
    unrealisedGain,
    realisedGain: realisedAny ? realisedGain : disposalsConsumedUnknownCost ? null : 0,
    avgDays,
    ageWeightedSum,
    ageWeightSum,
    costValue,
    xirr: xirrOutcome,
    basis: { partial, historyStartDate, unitsWithoutRecordedCost, preHistoryUnitsDisposed, reasons, label },
    flags,
    flows,
    terminal,
  };
}

// ---------------------------------------------------------------------------
// Owner resolution
// ---------------------------------------------------------------------------
export interface OwnerShare {
  ownerKey: string; // 'member:<id>' | 'entity:<id>' | 'unallocated'
  basisPoints: number;
}

export interface OwnerResolution {
  shares: OwnerShare[];
  /** Why the position is unallocated, when it is. */
  unallocatedReason: string | null;
}

function allocationActive(a: MfAllocation, valuationDate: string): boolean {
  if (a.status !== 'active') return false;
  if (a.effectiveFrom && a.effectiveFrom > valuationDate) return false;
  if (a.effectiveTo && a.effectiveTo < valuationDate) return false;
  return true;
}

/**
 * Who owns a position, and in what share.
 *
 * 1. Active ii_ownership_allocation rows narrowed to this (account, scheme)
 *    win over account-level rows (instrument null). Rows are grouped by
 *    allocation_group_id; the group MUST sum to exactly 10000 bp or it is
 *    ignored and the reason reported (never normalised or guessed).
 * 2. Otherwise ii_accounts.owner_member_id at 100%.
 * 3. Otherwise 'unallocated'.
 * Reads exactly what exists today; ownership chosen at upload time later
 * will arrive in the same two places and needs no change here.
 */
export function resolveOwners(account: MfAccount, instrumentId: string, allocations: MfAllocation[], valuationDate: string): OwnerResolution {
  const forAccount = allocations.filter((a) => a.accountId === account.id && allocationActive(a, valuationDate));
  const narrowed = forAccount.filter((a) => a.instrumentId === instrumentId);
  const candidate = narrowed.length > 0 ? narrowed : forAccount.filter((a) => a.instrumentId === null);
  let incompleteReason: string | null = null;
  if (candidate.length > 0) {
    const byGroup = new Map<string, MfAllocation[]>();
    for (const a of candidate) byGroup.set(a.groupId, [...(byGroup.get(a.groupId) ?? []), a]);
    for (const [, rows] of byGroup) {
      const sum = rows.reduce((s, r) => s + r.basisPoints, 0);
      const valid = rows.every((r) => (r.ownerMemberId !== null) !== (r.ownerEntityId !== null));
      if (sum === 10000 && valid) {
        const merged = new Map<string, number>();
        for (const r of rows) {
          const key = r.ownerMemberId ? `member:${r.ownerMemberId}` : `entity:${r.ownerEntityId}`;
          merged.set(key, (merged.get(key) ?? 0) + r.basisPoints);
        }
        return { shares: [...merged.entries()].map(([ownerKey, basisPoints]) => ({ ownerKey, basisPoints })), unallocatedReason: null };
      }
      incompleteReason = `ownership split does not total 100% (${(sum / 100).toFixed(2)}%)`;
    }
  }
  if (account.ownerMemberId) {
    return { shares: [{ ownerKey: `member:${account.ownerMemberId}`, basisPoints: 10000 }], unallocatedReason: null };
  }
  return { shares: [{ ownerKey: 'unallocated', basisPoints: 10000 }], unallocatedReason: incompleteReason ?? 'owner not set' };
}

const RELATIONSHIP_LABEL: Record<string, string> = {
  self: 'Self',
  spouse: 'Spouse',
  partner: 'Partner',
  child: 'Child',
  parent: 'Parent',
  other_dependant: 'Other dependant',
  other: 'Other member',
};
const ENTITY_LABEL: Record<string, string> = { huf: 'HUF', family_trust: 'Family Trust', company: 'Company' };
const MEMBER_ORDER: Record<string, number> = { self: 0, spouse: 1, partner: 2, child: 3, parent: 4, other_dependant: 5, other: 6 };

// ---------------------------------------------------------------------------
// Scaling and pooling
// ---------------------------------------------------------------------------
function scaleNullable(v: number | null, f: number): number | null {
  return v === null ? null : v * f;
}

export function scalePosition(p: MfPositionMetrics, shareBasisPoints: number, jointFolio: boolean): OwnerRow {
  const f = shareBasisPoints / 10000;
  return {
    ...p,
    units: p.units * f,
    purchase: p.purchase * f,
    switchIn: p.switchIn * f,
    switchOut: p.switchOut * f,
    redemptionSwp: p.redemptionSwp * f,
    dividend: p.dividend * f,
    netInvestment: p.netInvestment * f,
    currentValue: scaleNullable(p.currentValue, f),
    overallGain: scaleNullable(p.overallGain, f),
    unrealisedGain: scaleNullable(p.unrealisedGain, f),
    realisedGain: scaleNullable(p.realisedGain, f),
    costValue: scaleNullable(p.costValue, f),
    ageWeightedSum: p.ageWeightedSum * f,
    ageWeightSum: p.ageWeightSum * f,
    flows: p.flows.map((x) => ({ ...x, amount: x.amount * f })),
    terminal: p.terminal ? { date: p.terminal.date, amount: p.terminal.amount * f } : null,
    shareBasisPoints,
    jointFolio,
  };
}

function pooledXirr(rows: OwnerRow[]): XirrOutcome {
  const cfs: CashFlow[] = [];
  for (const r of rows) {
    for (const f of r.flows) if (!f.internal) cfs.push({ date: isoToDate(f.date), amount: f.amount });
    if (r.terminal && r.terminal.amount > EPS) cfs.push({ date: isoToDate(r.terminal.date), amount: r.terminal.amount });
  }
  // Positions with units but no valuation cannot contribute a terminal flow.
  if (rows.some((r) => r.units > EPS && r.currentValue === null)) {
    return { status: 'na', reason: 'NO_VALUATION', detail: XIRR_REASON_TEXT.NO_VALUATION };
  }
  if (cfs.length === 0) return { status: 'na', reason: 'INSUFFICIENT_HISTORY', detail: XIRR_REASON_TEXT.INSUFFICIENT_HISTORY };
  return toXirrOutcome(cfs);
}

export function buildOwnerTiles(rows: OwnerRow[]): OwnerTiles {
  const sum = (pick: (r: OwnerRow) => number) => rows.reduce((s, r) => s + pick(r), 0);
  const purchase = sum((r) => r.purchase);
  const switchIn = sum((r) => r.switchIn);
  const switchOut = sum((r) => r.switchOut);
  const redemptionSwp = sum((r) => r.redemptionSwp);
  const dividend = sum((r) => r.dividend);
  const netInvestment = purchase + switchIn - switchOut - redemptionSwp - dividend;
  const currentValue = sum((r) => r.currentValue ?? 0);
  return {
    purchase,
    switchIn,
    switchOut,
    redemptionSwp,
    dividend,
    netInvestment,
    currentValue,
    overallGain: currentValue - netInvestment,
    unvaluedPositions: rows.filter((r) => r.currentValue === null).length,
    unrealisedGain: sum((r) => r.unrealisedGain ?? 0),
    realisedGain: sum((r) => r.realisedGain ?? 0),
    xirr: pooledXirr(rows),
    partialPositions: rows.filter((r) => r.basis.partial).length,
    positionCount: rows.length,
  };
}

function totalAvgDays(rows: OwnerRow[]): number | null {
  const w = rows.reduce((s, r) => s + r.ageWeightSum, 0);
  if (w <= EPS) return null;
  return rows.reduce((s, r) => s + r.ageWeightedSum, 0) / w;
}

// ---------------------------------------------------------------------------
// Index header
// ---------------------------------------------------------------------------
export function resolveIndexQuote(close: MfIndexClose | null, valuationDate: string, label: string): IndexQuote {
  if (!close || !Number.isFinite(close.value) || close.value <= 0 || close.date > valuationDate) {
    return { status: 'not_available', value: null, date: null, ageDays: null, reason: `${label} closing values have not been loaded for this period.` };
  }
  return { status: 'ok', value: close.value, date: close.date, ageDays: daysBetween(close.date, valuationDate), reason: null };
}

// ---------------------------------------------------------------------------
// The whole report
// ---------------------------------------------------------------------------
function isIndiaMfAccount(a: MfAccount): boolean {
  return a.currencyCode === 'INR';
}

/** Gate: the section exists only for a user who actually holds an INR mutual fund. */
export function hasIndiaMfHoldings(input: Pick<IndiaMfReportInput, 'accounts' | 'instruments' | 'transactions' | 'snapshots'>): boolean {
  const accountById = new Map(input.accounts.map((a) => [a.id, a]));
  const instrumentById = new Map(input.instruments.map((i) => [i.id, i]));
  const hasRows = (accountId: string, instrumentId: string) => {
    const a = accountById.get(accountId);
    const i = instrumentById.get(instrumentId);
    return Boolean(a && i && i.instrumentClass === 'mutual_fund' && isIndiaMfAccount(a));
  };
  return input.transactions.some((t) => hasRows(t.accountId, t.instrumentId)) || input.snapshots.some((s) => hasRows(s.accountId, s.instrumentId));
}

export function buildIndiaMfReport(input: IndiaMfReportInput): IndiaMfReport | null {
  if (!hasIndiaMfHoldings(input)) return null;
  const { valuationDate } = input;
  const accountById = new Map(input.accounts.map((a) => [a.id, a]));
  const instrumentById = new Map(input.instruments.map((i) => [i.id, i]));
  const truthByKey = new Map(input.truth.map((t) => [`${t.accountId}:${t.instrumentId}`, t]));
  const navByInstrument = new Map<string, MfNav>();
  for (const n of input.navs) {
    if (n.date > valuationDate) continue;
    const cur = navByInstrument.get(n.instrumentId);
    if (!cur || n.date > cur.date) navByInstrument.set(n.instrumentId, n);
  }
  const snapshotByKey = new Map<string, MfSnapshot>();
  for (const s of input.snapshots) {
    if (s.asOfDate > valuationDate) continue;
    const key = `${s.accountId}:${s.instrumentId}`;
    const cur = snapshotByKey.get(key);
    if (!cur || s.asOfDate > cur.asOfDate) snapshotByKey.set(key, s);
  }
  const txByKey = new Map<string, MfTransaction[]>();
  for (const t of input.transactions) {
    const key = `${t.accountId}:${t.instrumentId}`;
    txByKey.set(key, [...(txByKey.get(key) ?? []), t]);
  }
  const keys = new Set<string>([...txByKey.keys(), ...snapshotByKey.keys()]);

  let nonInr = 0;
  let nonMf = 0;
  const positions: MfPositionMetrics[] = [];
  const positionOwners = new Map<string, OwnerResolution>();
  const earliestTransactionDateByInstrument: Record<string, string> = {};
  for (const key of [...keys].sort()) {
    const [accountId, instrumentId] = key.split(':');
    const account = accountById.get(accountId);
    const instrument = instrumentById.get(instrumentId);
    if (!account || !instrument) continue;
    if (instrument.instrumentClass !== 'mutual_fund') {
      nonMf += 1;
      continue;
    }
    if (!isIndiaMfAccount(account)) {
      nonInr += 1;
      continue;
    }
    const txns = txByKey.get(key) ?? [];
    const metrics = computePosition({
      account,
      instrument,
      transactions: txns,
      snapshot: snapshotByKey.get(key) ?? null,
      nav: navByInstrument.get(instrumentId) ?? null,
      truth: truthByKey.get(key) ?? null,
      valuationDate,
    });
    // A position with neither a usable transaction nor a snapshot has nothing to show.
    if (metrics.flags.noTransactions && !snapshotByKey.has(key)) continue;
    positions.push(metrics);
    positionOwners.set(key, resolveOwners(account, instrumentId, input.allocations, valuationDate));
    // Earliest date this fund's NAV history matters for (NAV pinning): the
    // first recorded transaction; for a holding with no transactions, the
    // earlier of its statement date and the NAV date actually used.
    let earliest: string | undefined = txns.filter((t) => t.status !== 'reversed' && t.status !== 'review_required').map((t) => t.date).sort()[0];
    if (!earliest) {
      const snap = snapshotByKey.get(key);
      const candidates = [snap?.asOfDate, metrics.latestNavDate].filter((d): d is string => Boolean(d));
      earliest = candidates.sort()[0];
    }
    if (earliest) {
      const cur = earliestTransactionDateByInstrument[instrumentId];
      if (!cur || earliest < cur) earliestTransactionDateByInstrument[instrumentId] = earliest;
    }
  }

  const memberById = new Map(input.members.map((m) => [m.id, m]));
  const entityById = new Map(input.entities.map((e) => [e.id, e]));
  const rowsByOwner = new Map<string, OwnerRow[]>();
  const ownerNotes = new Map<string, string[]>();
  for (const p of positions) {
    const resolution = positionOwners.get(`${p.accountId}:${p.instrumentId}`)!;
    const joint = resolution.shares.length > 1;
    for (const share of resolution.shares) {
      // An owner id with no matching member/entity row falls to Unallocated, never dropped.
      const known = share.ownerKey === 'unallocated' || memberById.has(share.ownerKey.slice(7)) || entityById.has(share.ownerKey.slice(7));
      const ownerKey = known ? share.ownerKey : 'unallocated';
      rowsByOwner.set(ownerKey, [...(rowsByOwner.get(ownerKey) ?? []), scalePosition(p, share.basisPoints, joint)]);
      if (ownerKey === 'unallocated' && resolution.unallocatedReason) {
        ownerNotes.set(ownerKey, [...new Set([...(ownerNotes.get(ownerKey) ?? []), resolution.unallocatedReason])]);
      }
    }
  }

  const sections: OwnerSection[] = [];
  const sortRows = (rows: OwnerRow[]) => [...rows].sort((a, b) => a.schemeName.localeCompare(b.schemeName) || (a.folio ?? '').localeCompare(b.folio ?? ''));
  const personalKeys = [...rowsByOwner.keys()].filter((k) => k.startsWith('member:'));
  personalKeys.sort((a, b) => {
    const ma = memberById.get(a.slice(7));
    const mb = memberById.get(b.slice(7));
    return (MEMBER_ORDER[ma?.relationship ?? 'other'] ?? 9) - (MEMBER_ORDER[mb?.relationship ?? 'other'] ?? 9) || (ma?.fullName ?? '').localeCompare(mb?.fullName ?? '');
  });
  const entityKeys = [...rowsByOwner.keys()].filter((k) => k.startsWith('entity:'));
  entityKeys.sort((a, b) => (entityById.get(a.slice(7))?.name ?? '').localeCompare(entityById.get(b.slice(7))?.name ?? ''));
  for (const key of personalKeys) {
    const m = memberById.get(key.slice(7))!;
    const rows = sortRows(rowsByOwner.get(key)!);
    sections.push({ key, kind: 'personal', label: m.fullName, roleLabel: RELATIONSHIP_LABEL[m.relationship] ?? m.relationship, rows, tiles: buildOwnerTiles(rows), totalAvgDays: totalAvgDays(rows), notes: [] });
  }
  for (const key of entityKeys) {
    const e = entityById.get(key.slice(7))!;
    const rows = sortRows(rowsByOwner.get(key)!);
    sections.push({ key, kind: 'entity', label: e.name, roleLabel: ENTITY_LABEL[e.entityType] ?? e.entityType, rows, tiles: buildOwnerTiles(rows), totalAvgDays: totalAvgDays(rows), notes: [] });
  }
  if (rowsByOwner.has('unallocated')) {
    const rows = sortRows(rowsByOwner.get('unallocated')!);
    sections.push({ key: 'unallocated', kind: 'unallocated', label: 'Unallocated / owner not set', roleLabel: null, rows, tiles: buildOwnerTiles(rows), totalAvgDays: totalAvgDays(rows), notes: ownerNotes.get('unallocated') ?? [] });
  }

  return {
    version: INDIA_MF_REPORT_VERSION,
    valuationDate,
    reportDate: input.reportDate,
    currency: 'INR',
    indices: { sensex: resolveIndexQuote(input.sensex, valuationDate, 'BSE Sensex'), nifty: resolveIndexQuote(input.nifty, valuationDate, 'Nifty 50') },
    sections,
    footnotes: buildFootnotes(positions, sections),
    excluded: { nonInrMutualFundPositions: nonInr, nonMutualFundPositions: nonMf },
    notSummedNote:
      'Each owner section is complete on its own. Sections are not added together: entity holdings (HUF, trust, company) are kept apart from personal holdings, and a joint folio is shown once per owner at that owner\'s share.',
    earliestTransactionDateByInstrument,
  };
}

function label(p: MfPositionMetrics): string {
  return p.folio ? `${p.schemeName} (folio ${p.folio})` : p.schemeName;
}

function buildFootnotes(positions: MfPositionMetrics[], sections: OwnerSection[]): ReportFootnote[] {
  const notes: ReportFootnote[] = [];
  const affected = (pick: (p: MfPositionMetrics) => boolean) => [...new Set(positions.filter(pick).map(label))];
  const add = (code: string, text: string, list: string[]) => {
    if (list.length > 0) notes.push({ code, text, affected: list });
  };
  add(
    'SWP',
    'Systematic withdrawals (SWP) are included in the Red/SWP column. The platform\'s performance (R4) and tax (R6) engines do not process SWP, so for these funds the report works from the recorded transactions itself and its figures can differ from those engines\' output.',
    affected((p) => p.flags.hasSwp)
  );
  add(
    'STP',
    'Systematic transfer plan (STP) legs are shown as switch in / switch out. The platform\'s R4 and R6 engines do not process STP legs separately, so these funds\' figures are calculated within this report only.',
    affected((p) => p.flags.hasStp)
  );
  add(
    'BONUS_SPLIT',
    'Bonus units are added at nil cost and unit splits change the unit count only; neither is a cash flow, so neither appears in the purchase or dividend columns.',
    affected((p) => p.flags.hasBonusOrSplit)
  );
  add(
    'REINVESTMENT',
    'Dividend reinvestment adds units (at the reinvestment NAV) but is not a cash flow. It is therefore shown within the current value and overall gain rather than as a dividend payout.',
    affected((p) => p.flags.hasReinvestment)
  );
  add(
    'UNMODELLED_UNITS',
    'These funds include unit movements (transfer, merger, segregation or adjustment) that carry no cash amount. They are applied to the unit balance but not to cost, so their cost basis is shown as partial.',
    affected((p) => p.flags.hasTransfer || p.flags.hasUnmodelled)
  );
  add(
    'PARTIAL_HISTORY',
    `Where a figure carries a "from ..." marker it is calculated from the transactions in your uploaded statements only. Average NAV, unrealised gain, XIRR and realised gain cover units whose purchase is recorded; units bought before the earliest uploaded transaction are included in current value but not in those figures. ${PARTIAL_HISTORY_GUIDANCE}`,
    affected((p) => p.basis.partial && !p.flags.noTransactions)
  );
  add(
    'NO_TRANSACTIONS',
    'These holdings come from a statement closing balance with no transactions uploaded. Current value is shown; cost-based figures and XIRR are not available because no purchases are recorded.',
    affected((p) => p.flags.noTransactions)
  );
  add(
    'REVIEW_EXCLUDED',
    'Transactions awaiting review are left out of every figure until they are resolved.',
    affected((p) => p.flags.reviewExcludedCount > 0)
  );
  add(
    'STATEMENT_UNITS',
    'For these funds the transaction history does not add up to the statement\'s units. The statement\'s units are used for current value.',
    affected((p) => p.flags.ledgerDiffersFromStatement)
  );
  add(
    'NAV_FROM_STATEMENT',
    'No published NAV is stored for these funds; current value uses the latest statement value per unit.',
    affected((p) => p.navSource === 'statement_value')
  );
  add(
    'NAV_STALE',
    `The latest available NAV for these funds is more than ${NAV_STALE_AFTER_DAYS} days before the valuation date.`,
    affected((p) => p.flags.navStale && p.latestNavDate !== null)
  );
  add(
    'NO_VALUATION',
    'No NAV or statement value is available for these funds, so their current value and gain are not shown and are left out of the tiles.',
    affected((p) => p.currentValue === null)
  );
  if (sections.some((s) => s.rows.some((r) => r.jointFolio))) {
    notes.push({
      code: 'JOINT',
      text: 'A joint folio appears in each owner\'s section at that owner\'s ownership share (units and amounts scaled by the share; NAV, average days and XIRR are the same for every owner).',
      affected: [...new Set(sections.flatMap((s) => s.rows.filter((r) => r.jointFolio).map((r) => label(r))))],
    });
  }
  notes.push({
    code: 'METHOD',
    text: 'Realised gain uses first-in-first-out lot matching (the same lot functions as the Tax & Cost chapter, applied here to redemptions, SWP and switch/STP-out). It is not a tax computation. Average NAV is average cost. Because these two cost methods attribute cost differently, unrealised + realised + dividends will not always equal the overall gain.',
    affected: [],
  });
  return notes;
}
