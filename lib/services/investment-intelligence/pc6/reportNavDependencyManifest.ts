// NAV 1 — R1: report pinning / reproducibility manifest computation.
//
// SCOPE OF THIS FILE, STATED PLAINLY (do not read more into it than this):
// this is the PURE, unit-testable computation of "what NAV date range does
// a given report-section calculation kind require to be reproducible",
// reusing this programme's own already-grounded constants
// (BENCHMARK_LOOKBACK_DAYS) rather than inventing new numbers. It does NOT
// itself write to the database, and it is NOT YET wired into
// lib/services/reportsData.ts's live report-finalization path — that
// integration is the disclosed next step (see
// docs/investment-intelligence/NAV1_PROGRESS_LEDGER.md, NAV 1 R1), left
// undone this dispatch because reportsData.ts is a security-hardened,
// live, already-certified financial-reporting code path (see its own
// "II-R10 security hardening" comment) that deserves a dedicated,
// carefully-tested integration pass with Module 9 context, not a rushed
// edit at the tail end of an unrelated dispatch with no remaining budget to
// prove it end-to-end.
//
// WHAT THIS CLOSES TODAY: migration 0172 gives `ii_report_nav_dependencies`
// a real schema and rewires `pc6_nav_row_is_candidate()`'s
// `pinned_by_report_or_revision` predicate to a real, narrow EXISTS check
// against it (replacing 0171's interim `or true` fail-closed placeholder).
// Until the write-path integration below is wired, that table will simply
// stay empty in every real environment — exactly the same honest,
// ships-empty pattern this programme already uses for
// ii_nav_retention_policy (0166) and ii_nav_retention_holds before any
// hold is ever registered. An empty table is NOT a false "protected"
// claim: `pc6_nav_row_is_candidate()`'s OTHER predicates
// (accepted-statement history, benchmark dependency, active holds) remain
// fully live and unaffected by this file.
//
// GROUNDING: every NAV-consuming report section this programme has found
// (NAV 1.06 inventory; reportsData.ts's real `ii_performance`/`ii_sip`/
// `ii_xray`/`ii_tax` snapshot_type writes) reads from
// lib/services/investment-intelligence/{analyticsRepository,r5Repository,
// taxRepository}.ts, all of which operate over an instrument's
// TRANSACTION history (XIRR/TWR since real cash flows) or, for a
// benchmark/rolling-return comparison, the SAME grounded lookback window
// navRetentionPolicy.ts's BENCHMARK_LOOKBACK_DAYS already derives from
// rollingReturnService.ts/rollingReturns.ts. This file reuses that
// constant rather than deriving a second, possibly-inconsistent one.

import { BENCHMARK_LOOKBACK_DAYS } from './navRetentionPolicy';

/**
 * Mirrors navRetentionPolicy.ts's own (private, unexported) `subtractDays`
 * exactly -- duplicated rather than imported to avoid widening that
 * already-tested file's export surface for a one-line date helper.
 */
function subtractDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * The report-section calculation kinds this programme has actually found
 * reading ii_prices_nav-derived data (see reportsData.ts's real
 * snapshot_type writes: 'ii_performance', 'ii_sip', 'ii_xray', 'ii_tax').
 * 'other' is the deliberate fail-closed default for any kind this module
 * does not yet recognise -- it must NEVER be silently treated as "no
 * dependency".
 */
export type ReportNavDependencyBasis =
  | 'xirr_since_inception'
  | 'twr_since_opening_balance'
  | 'rolling_return_window'
  | 'sip_xray_transaction_history'
  | 'tax_lot_fifo'
  | 'other';

export interface ReportNavDependencyInput {
  instrumentId: string;
  basis: ReportNavDependencyBasis;
  /** ISO date. The report's own as-of date / period end -- a report can never need NAV data after this. */
  reportAsOfDate: string;
  /**
   * ISO date of the earliest non-reversed transaction this instrument's
   * holding has, if known. Required for a correct (non-maximally-
   * conservative) answer for every basis except 'rolling_return_window'.
   */
  earliestTransactionDate?: string | null;
}

export interface ReportNavDependencyRange {
  instrumentId: string;
  basis: ReportNavDependencyBasis;
  /** ISO date, inclusive. NULL means "no lower bound -- protect from true inception", the same idiom ii_nav_retention_holds.expires_at already uses for "no upper bound". */
  navDateFrom: string | null;
  /** ISO date, inclusive. */
  navDateTo: string;
}

/**
 * Computes the protective NAV date range a single report-section
 * calculation is known to require for one instrument. Pure, no I/O.
 *
 * This is deliberately a RANGE, not an exact (instrument_id, price_date,
 * revision) manifest (workbook Option A's full ambition) -- see this
 * file's header for why the narrower, safer Option is what ships this
 * dispatch. A range-based pin is still a genuine, real KEEP predicate: it
 * is sufficient to make NAV 1's own Stage-E candidate selection correctly
 * exclude every row a report is known to depend on, which is the specific,
 * narrower requirement THIS program (not all of Module 9) actually needs
 * closed. It does not, by itself, guarantee byte-identical reproduction
 * after an NAV *value* correction (that would need the fuller Option A
 * manifest) -- disclosed explicitly, not implied.
 */
export function computeReportNavDependencyRange(input: ReportNavDependencyInput): ReportNavDependencyRange {
  const { instrumentId, basis, reportAsOfDate, earliestTransactionDate } = input;

  switch (basis) {
    case 'xirr_since_inception':
    case 'twr_since_opening_balance':
    case 'sip_xray_transaction_history':
    case 'tax_lot_fifo':
      // All four read the holding's real transaction history (XIRR/TWR
      // since actual cash flows, SIP/X-Ray and FIFO cost-basis over every
      // lot) -- grounded in NAV 1.06's own consumer inventory
      // (analyticsRepository.ts / r5Repository.ts / taxRepository.ts).
      // Known earliest transaction date -> bound there. Unknown -> fail
      // closed (unbounded), never silently assume "not needed before
      // today".
      return {
        instrumentId,
        basis,
        navDateFrom: earliestTransactionDate ?? null,
        navDateTo: reportAsOfDate,
      };

    case 'rolling_return_window':
      // Grounded in the SAME rollingReturnSeries()-derived lookback
      // navRetentionPolicy.ts's benchmark-only hydration case already
      // uses (NAV 1.12) -- a report's rolling-return section cannot need
      // materially more history than a live rolling-return computation
      // for the same instrument would, since it is the identical engine.
      return {
        instrumentId,
        basis,
        navDateFrom: subtractDays(reportAsOfDate, BENCHMARK_LOOKBACK_DAYS),
        navDateTo: reportAsOfDate,
      };

    case 'other':
    default:
      // Deliberate fail-closed default for any calculation kind this
      // module does not yet recognise -- unbounded, never "no dependency".
      return {
        instrumentId,
        basis: 'other',
        navDateFrom: null,
        navDateTo: reportAsOfDate,
      };
  }
}

/** Convenience: compute ranges for every instrument a report section touched, in one call. */
export function computeReportNavDependencyManifest(inputs: ReportNavDependencyInput[]): ReportNavDependencyRange[] {
  return inputs.map(computeReportNavDependencyRange);
}
