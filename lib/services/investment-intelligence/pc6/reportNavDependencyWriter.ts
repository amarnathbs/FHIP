// NAV 1 — R1: report-pinning WRITE-PATH integration.
//
// This is the piece reportNavDependencyManifest.ts's own header explicitly
// left undone ("that integration is the disclosed next step") and migration
// 0172's header calls "the single most important open item": actually
// calling computeReportNavDependencyRange() for every real NAV-dependent
// calculation a finalized report performed, and writing the result into
// ii_report_nav_dependencies. Until this file existed and was wired into
// lib/services/reportsData.ts, that table shipped permanently empty in
// every real environment.
//
// SPLIT, mirroring this programme's own established pattern
// (selectiveHistoricalHydrationJob.ts = pure orchestration vs.
// selectiveHistoricalHydrationJobLive.ts = live DB wiring; referenceIngestJob.ts
// vs. referenceImportRunner.ts):
//   - deriveReportNavDependencyInputs()  — PURE, no I/O, unit-tested.
//   - writeReportNavDependencyManifest() — the one, small, real DB write
//     (a single upsert statement), given an already-authenticated
//     service-role client and a report's already-resolved premium source
//     data. Not split into its own "Live" file because it is a single
//     upsert call, not a multi-step job orchestration — splitting it further
//     would add indirection without adding testability.
//
// GROUNDING FOR WHICH (instrument, basis) PAIRS ARE WRITTEN — every one
// below is cited to the real code path that actually reads ii_prices_nav for
// that chapter, not guessed:
//   - investmentPerformance (R4, analyticsRepository.ts/PerformanceEngine):
//     every scheme in results.schemes had its investorXirr computed from
//     real cash flows since the household's own first real cash flow for
//     that instrument (xirr_since_inception), and its navReturns/
//     activeReturn/benchmark comparison computed over the SAME grounded
//     BENCHMARK_LOOKBACK_DAYS window navRetentionPolicy.ts's own
//     benchmark-dependency hydration already uses (rolling_return_window).
//     Portfolio-level TWRR (PortfolioCurrencyAnalytics.portfolioTwrr) is an
//     aggregate OVER these same per-scheme series from the same real
//     inception point, so twr_since_opening_balance reuses the identical
//     earliest-cash-flow bound rather than inventing a second, possibly
//     inconsistent one — computeReportNavDependencyRange() itself treats
//     these two bases identically (same switch-case branch), so this is not
//     a redundant guess, it is the documented, shared formula for both.
//   - sip (R5, r5Repository.ts's loadSipDataset — the ONLY r5Repository
//     dataset that reads ii_prices_nav at all; loadXrayDataset does not,
//     confirmed by reading it in full, so X-Ray deliberately gets NO
//     dependency row here): sip_xray_transaction_history, bounded at the
//     instrument's earliest real transaction date.
//   - taxAndCost (R6, taxRepository.ts): tax_lot_fifo, bounded at the
//     instrument's earliest real acquisition (lot) date — see
//     investmentIntelligenceReportData.ts's own comment for why this also
//     safely covers the 31-Jan-2018 grandfathering FMV lookup.
//   - reviewItems: R9's Review Centre reads persisted ii_review_items, never
//     ii_prices_nav directly (confirmed: reviewCentreData.ts's listReviewItems
//     is a straight table read) — no dependency row for it either.
//
// WHAT THIS DOES NOT DO: reproduce a report byte-for-byte after a NAV
// *value* correction (Option A's fuller ambition, explicitly declined — see
// reportNavDependencyManifest.ts's header). It only guarantees NAV 1's own
// Stage-E candidate selection will not treat a row a real finalized report
// depends on as safe to delete.

import type { PremiumSourceData } from '@/lib/services/reportSnapshotResolver';
import { computeReportNavDependencyRange, type ReportNavDependencyBasis, type ReportNavDependencyInput, type ReportNavDependencyRange } from './reportNavDependencyManifest';

/**
 * PURE. Turns one report's already-resolved premium source data into the
 * flat list of (instrument, basis) dependency inputs this report is known
 * to have. No I/O, no Supabase client — fully unit-testable with a plain
 * object literal, exactly like reportNavDependencyManifest.ts's own
 * computeReportNavDependencyRange().
 *
 * `premium` is null for free-tier reports (Premium-only queries are skipped
 * entirely upstream — see reportSnapshotResolver.ts) — correctly returns an
 * empty list, since a free-tier report never reads ii_prices_nav at all.
 */
export function deriveReportNavDependencyInputs(
  premium: PremiumSourceData | null,
  reportAsOfDate: string
): ReportNavDependencyInput[] {
  if (!premium) return [];

  const inputs: ReportNavDependencyInput[] = [];
  // One row per (instrumentId, basis) — mirrors the DB's own unique index
  // (report_id, instrument_id, basis) exactly, so a scheme that somehow
  // appears twice in the same chapter's results (should not happen, but
  // defended against rather than assumed) can never produce a duplicate
  // input the upsert would otherwise silently collapse in an unpredictable
  // order.
  const seen = new Set<string>();
  const push = (instrumentId: string, basis: ReportNavDependencyBasis, earliestTransactionDate?: string | null) => {
    const key = `${instrumentId}|${basis}`;
    if (seen.has(key)) return;
    seen.add(key);
    inputs.push({ instrumentId, basis, reportAsOfDate, earliestTransactionDate });
  };

  if (premium.investmentPerformance) {
    const { results, earliestCashFlowDateByInstrument } = premium.investmentPerformance;
    for (const scheme of results.schemes) {
      const earliest = earliestCashFlowDateByInstrument[scheme.instrumentId] ?? null;
      push(scheme.instrumentId, 'xirr_since_inception', earliest);
      push(scheme.instrumentId, 'twr_since_opening_balance', earliest);
      push(scheme.instrumentId, 'rolling_return_window');
    }
  }

  if (premium.sip) {
    for (const [instrumentId, date] of Object.entries(premium.sip.earliestTransactionDateByInstrument)) {
      push(instrumentId, 'sip_xray_transaction_history', date);
    }
  }

  if (premium.taxAndCost) {
    for (const [instrumentId, date] of Object.entries(premium.taxAndCost.earliestAcquisitionDateByInstrument)) {
      push(instrumentId, 'tax_lot_fifo', date);
    }
  }

  return inputs;
}

/**
 * Minimal shape this file needs from a Supabase client — avoids a hard
 * dependency on a specific client package version, a `table: string` param
 * (not a literal) so any real Supabase client's own wider
 * `.from(table: string)` signature is structurally assignable here, and a
 * `PromiseLike` (not `Promise`) return type, because supabase-js's real
 * `.upsert(...)` returns a `PostgrestFilterBuilder` — a thenable, not a full
 * ES `Promise` (it has no `.catch`/`.finally`/`Symbol.toStringTag`) — which
 * `await` handles identically either way.
 */
export interface ReportNavDependencyWriteClient {
  from(table: string): {
    upsert(
      rows: Array<{ report_id: string; instrument_id: string; basis: ReportNavDependencyBasis; nav_date_from: string | null; nav_date_to: string }>,
      options: { onConflict: string }
    ): PromiseLike<{ error: { message: string } | null }>;
  };
}

export interface WriteReportNavDependencyManifestResult {
  rowsWritten: number;
  ranges: ReportNavDependencyRange[];
}

/**
 * The one real DB write. Computes every dependency range for this report
 * (pure, via computeReportNavDependencyRange) and upserts them in a SINGLE
 * insert statement, scoped to (report_id, instrument_id, basis) — the exact
 * unique index migration 0172 created for this purpose (workbook 4.7 test 3:
 * "the same report finalization request is idempotent"). A single Postgres
 * statement inserting N rows is atomic: this call either records every
 * dependency for this report or none of them — it can never leave a
 * partially-written, misleading manifest for one report.
 *
 * DELIBERATELY THROWS on a write error rather than swallowing it (unlike
 * this file's neighbouring report_sections/report_snapshots inserts in
 * reportsData.ts, which do not check their own error — a pre-existing
 * pattern this integration does not repeat here on purpose): this table's
 * only reason to exist is to protect real NAV rows from a future Stage-E
 * cleanup, so a caller MUST know if that protection failed to write, rather
 * than have generateReport() report success while the manifest silently
 * stayed empty for this report. Propagating the error surfaces as
 * report_generation_runs.output_status='failed' via generateReport()'s own
 * existing try/catch — the SAME failure-visibility path every other
 * genuine finalization failure in that function already uses. This is the
 * "recoverable outbox" decision recorded in NAV1_PROGRESS_LEDGER.md: not a
 * literal outbox table, but a fail-loud write whose failure is recoverable
 * via the report's own EXISTING failed-report retry path
 * (app/api/reports/[id]/retry/route.ts calls generateReport() again, which
 * creates a fresh report row and therefore a fresh, independent manifest
 * write attempt) rather than a second bespoke retry queue. A full
 * cross-table DB transaction spanning reports/report_sections/
 * report_snapshots/ii_report_nav_dependencies was considered and rejected
 * for this dispatch: it would require a new plpgsql RPC wrapping a code
 * path reportsData.ts's own "II-R10 security hardening" comment already
 * calls out as security-hardened and already-certified, which is exactly
 * the kind of edit that file's header says deserves its own dedicated,
 * live-verified pass — not a same-dispatch, unreviewed schema-authority
 * change with no DDL application access to prove it against a real
 * database this dispatch.
 *
 * `reportId` must already be a real, committed `reports` row — this
 * function is only ever called from generateReport()'s real finalization
 * branch, AFTER that insert has succeeded, never from a preview/draft path
 * (this codebase has no separate preview/draft report-generation code path
 * at all today — every generateReport() call that reaches this point
 * creates a real, persisted report row; the "not_eligible" early-return
 * branch returns a `status: 'failed'` report with empty sections BEFORE
 * `resolveReportSourceData`/`premium` is ever computed, and therefore never
 * reaches this function at all — verified by reading generateReport()'s own
 * control flow, not assumed).
 */
export async function writeReportNavDependencyManifest(
  client: ReportNavDependencyWriteClient,
  reportId: string,
  premium: PremiumSourceData | null,
  reportAsOfDate: string
): Promise<WriteReportNavDependencyManifestResult> {
  const inputs = deriveReportNavDependencyInputs(premium, reportAsOfDate);
  if (inputs.length === 0) return { rowsWritten: 0, ranges: [] };

  const ranges = inputs.map(computeReportNavDependencyRange);
  const rows = ranges.map((r) => ({
    report_id: reportId,
    instrument_id: r.instrumentId,
    basis: r.basis,
    nav_date_from: r.navDateFrom,
    nav_date_to: r.navDateTo,
  }));

  const { error } = await client.from('ii_report_nav_dependencies').upsert(rows, { onConflict: 'report_id,instrument_id,basis' });
  if (error) {
    throw new Error(`Failed to write report NAV dependency manifest for report ${reportId}: ${error.message}`);
  }
  return { rowsWritten: rows.length, ranges };
}
