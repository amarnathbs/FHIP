// PC7 (M7) — the Underlying Fund Holdings quality surface (O.9).
//
// O.9 requires operator visibility for: missing scheme disclosures; stale
// snapshots; unmapped securities; coverage gaps; parser/import failures;
// source changes. One panel each, plus the O.7 safety assertion and the
// blocked-source list, because a surface that shows only what IS ingested
// hides the fact that nothing is.
//
// READ-ONLY. There is no POST/PATCH/DELETE here. A surface that lets an admin
// CORRECT look-through data is a different, separately-named capability
// (Admin Standard §5/§14); when it is built, its writes belong in
// ii_reference_corrections, which migration 0157 already admits
// ii_fund_holdings_snapshots / _lines as targets for.
//
// ADMIN STANDARD §9 (personal/financial data boundary) — ANALYSIS.
// Every table this route reads is GLOBAL reference data about a SCHEME, with
// no tenancy column at all — a fact migration 0157's
// ii_pc7_networth_safety_violations() asserts structurally rather than by
// assertion. The one place user data could enter is the "held by any user"
// flag on the missing-disclosure panel, and that is deliberately reduced to a
// BOOLEAN plus a COUNT: an operator learns that a scheme is held and therefore
// worth prioritising, and learns nothing about who holds it or how much. No
// per-user row, no identifier, no value ever leaves this route.
//
// §8 RESULT-STATE SEMANTICS. Every panel returns `ok` / `never_ingested` /
// `unavailable`, never a bare 0 standing in for "we do not know". A corpus
// that has never been ingested reports `never_ingested`, which is a different
// state from "no gaps found".
//
// §13 SAFE FAILURE. A missing table (0155/0157 not yet applied) is reported as
// `unavailable` with the reason, not as an empty healthy dashboard.

import { adminRoute, adminClient, safeDbError } from '@/lib/services/adminAuth';
import { requireLookthroughDataAdmin } from '@/lib/services/investment-intelligence/pc7/lookthroughDataAdmin';
import { ok, bad } from '@/lib/api';
import {
  findMissingDisclosures,
  assessSnapshotStaleness,
  findUnmappedSecurities,
  findCoverageGaps,
  summariseImportFailures,
  detectSourceChanges,
  PC7_QUALITY_VERSION,
  type SchemeRef,
  type SnapshotRef,
  type HoldingLineRef,
  type BatchRef,
  type LayoutObservation,
} from '@/lib/services/investment-intelligence/pc7/lookthroughDataQuality';
import { blockedDisclosureSources, anyDisclosureSourceEnabled } from '@/lib/config/investment-intelligence/pc7DisclosureSources';

export const dynamic = 'force-dynamic';

const UNAVAILABLE_MIGRATION =
  'Migrations 0155 (PC6) and/or 0157 (PC7) have not been applied to this database, so the objects this ' +
  'panel reads do not exist yet. Reported as unavailable rather than as a healthy empty dashboard.';

const PANELS = [
  'missing_disclosures',
  'stale_snapshots',
  'unmapped_securities',
  'coverage_gaps',
  'import_failures',
  'source_changes',
  'networth_safety',
  'blocked_sources',
] as const;
type PanelKey = (typeof PANELS)[number];

function isMissingRelation(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === 'PGRST205' || error.code === '42P01' || error.code === '42703' || /does not exist/i.test(error.message ?? '');
}

export const GET = adminRoute(async (req: Request) => {
  const { forbidden } = await requireLookthroughDataAdmin();
  if (forbidden) return forbidden;

  const url = new URL(req.url);
  const requested = url.searchParams.get('panel');
  // §13: an unexpected filter value fails closed with an explicit 422, never
  // by silently returning everything.
  if (requested && !PANELS.includes(requested as PanelKey)) {
    return bad(`Unknown panel '${requested}'. Allowed: ${PANELS.join(', ')}`, 422);
  }
  const wanted: readonly PanelKey[] = requested ? [requested as PanelKey] : PANELS;

  const db = adminClient();
  const asOfDate = new Date().toISOString().slice(0, 10);
  const out: Record<string, unknown> = {
    asOfDate,
    generatedAt: new Date().toISOString(),
    qualityVersion: PC7_QUALITY_VERSION,
    ingestionActive: anyDisclosureSourceEnabled(),
  };

  // ---- shared reads -------------------------------------------------------
  // Loaded once and shared across panels, because four of the six O.9 signals
  // are different questions about the same two tables.
  const needsSnapshots = wanted.some((w) => ['missing_disclosures', 'stale_snapshots', 'coverage_gaps', 'unmapped_securities'].includes(w));
  let snapshots: SnapshotRef[] | null = null;
  let lines: HoldingLineRef[] | null = null;
  let snapshotsUnavailable: string | null = null;

  if (needsSnapshots) {
    const { data: snapRows, error: snapErr } = await db
      .from('ii_fund_holdings_snapshots')
      .select('id, fund_instrument_id, holdings_as_of_date, source_id, disclosed_weight_total_pct, quality_status')
      .neq('quality_status', 'superseded')
      .order('holdings_as_of_date', { ascending: false })
      .limit(5000);
    if (snapErr) {
      if (isMissingRelation(snapErr)) snapshotsUnavailable = UNAVAILABLE_MIGRATION;
      else return safeDbError(snapErr, 'pc7 snapshots');
    } else {
      const snapIds = (snapRows ?? []).map((s) => s.id);
      const { data: lineRows, error: lineErr } = snapIds.length
        ? await db
            .from('ii_fund_holdings_lines')
            .select('snapshot_id, holding_name, isin, asset_kind, weight_pct, underlying_instrument_id')
            .in('snapshot_id', snapIds)
            .limit(50000)
        : { data: [], error: null };
      if (lineErr) return safeDbError(lineErr, 'pc7 holdings lines');
      lines = (lineRows ?? []).map((l) => ({
        snapshotId: l.snapshot_id as string,
        holdingName: l.holding_name as string,
        isin: (l.isin as string | null) ?? null,
        assetKind: l.asset_kind as string,
        weightPct: Number(l.weight_pct),
        underlyingInstrumentId: (l.underlying_instrument_id as string | null) ?? null,
      }));
      const lineCounts = new Map<string, number>();
      for (const l of lines) lineCounts.set(l.snapshotId, (lineCounts.get(l.snapshotId) ?? 0) + 1);
      snapshots = (snapRows ?? []).map((s) => ({
        snapshotId: s.id as string,
        fundInstrumentId: s.fund_instrument_id as string,
        holdingsAsOfDate: s.holdings_as_of_date as string,
        sourceKey: (s.source_id as string | null) ?? null,
        disclosedWeightTotalPct: s.disclosed_weight_total_pct === null ? null : Number(s.disclosed_weight_total_pct),
        qualityStatus: (s.quality_status as string) ?? 'ok',
        lineCount: lineCounts.get(s.id as string) ?? 0,
      }));
    }
  }

  // ---- O.9 (a) missing scheme disclosures ---------------------------------
  if (wanted.includes('missing_disclosures')) {
    if (snapshotsUnavailable) {
      out.missing_disclosures = { state: 'unavailable', reason: snapshotsUnavailable };
    } else {
      const { data: funds, error: fErr } = await db
        .from('ii_instruments')
        .select('id, instrument_name')
        .eq('instrument_class', 'mutual_fund')
        .eq('is_active', true)
        .limit(5000);
      if (fErr) return safeDbError(fErr, 'pc7 instruments');

      // §9: the ONLY user-derived input, reduced to a set of instrument ids.
      // No user id, no value, no row count per user leaves this route.
      const { data: held, error: hErr } = await db
        .from('ii_holdings')
        .select('instrument_id')
        .limit(20000);
      const heldIds = new Set<string>(hErr ? [] : (held ?? []).map((h) => h.instrument_id as string));

      const schemes: SchemeRef[] = (funds ?? []).map((f) => ({
        instrumentId: f.id as string,
        schemeName: (f.instrument_name as string) ?? '(unnamed)',
        heldByAnyUser: heldIds.has(f.id as string),
      }));
      const withSnapshot = new Set((snapshots ?? []).map((s) => s.fundInstrumentId));
      const report = findMissingDisclosures(schemes, withSnapshot);
      out.missing_disclosures = {
        state: report.withDisclosure === 0 ? 'never_ingested' : 'ok',
        data: { ...report, missing: report.missing.slice(0, 200) },
        reason:
          report.withDisclosure === 0
            ? 'No scheme in the instrument master has ANY usable holdings disclosure. This is "never ingested", not "no gaps" — every X-Ray look-through is currently unavailable rather than zero.'
            : undefined,
      };
    }
  }

  // ---- O.9 (b) stale snapshots --------------------------------------------
  if (wanted.includes('stale_snapshots')) {
    if (snapshotsUnavailable) out.stale_snapshots = { state: 'unavailable', reason: snapshotsUnavailable };
    else if ((snapshots ?? []).length === 0) out.stale_snapshots = { state: 'never_ingested', reason: 'No holdings snapshots exist, so there is nothing whose freshness could be judged.' };
    else out.stale_snapshots = { state: 'ok', data: assessSnapshotStaleness(snapshots ?? [], asOfDate) };
  }

  // ---- O.9 (c) unmapped securities ----------------------------------------
  if (wanted.includes('unmapped_securities')) {
    if (snapshotsUnavailable) out.unmapped_securities = { state: 'unavailable', reason: snapshotsUnavailable };
    else if ((lines ?? []).length === 0) out.unmapped_securities = { state: 'never_ingested', reason: 'No holdings lines exist. Zero unmapped securities here means nothing has been ingested, not that every constituent resolved.' };
    else out.unmapped_securities = { state: 'ok', data: findUnmappedSecurities(lines ?? []) };
  }

  // ---- O.9 (d) coverage gaps ----------------------------------------------
  if (wanted.includes('coverage_gaps')) {
    if (snapshotsUnavailable) out.coverage_gaps = { state: 'unavailable', reason: snapshotsUnavailable };
    else if ((snapshots ?? []).length === 0) out.coverage_gaps = { state: 'never_ingested', reason: 'No holdings snapshots exist.' };
    else out.coverage_gaps = { state: 'ok', data: findCoverageGaps(snapshots ?? []) };
  }

  // ---- O.9 (e) parser / import failures -----------------------------------
  if (wanted.includes('import_failures')) {
    const { data, error } = await db
      .from('ii_reference_import_batches')
      .select('id, batch_kind, status, started_at, finished_at, rows_read, rows_accepted, rows_rejected, error_code')
      .eq('batch_kind', 'fund_holdings_disclosure')
      .order('started_at', { ascending: false })
      .limit(200);
    if (error) {
      out.import_failures = isMissingRelation(error) ? { state: 'unavailable', reason: UNAVAILABLE_MIGRATION } : undefined;
      if (!out.import_failures) return safeDbError(error, 'pc7 import batches');
    } else {
      const batches: BatchRef[] = (data ?? []).map((b) => ({
        id: b.id as string,
        batchKind: b.batch_kind as string,
        status: b.status as string,
        startedAt: b.started_at as string,
        finishedAt: (b.finished_at as string | null) ?? null,
        rowsRead: b.rows_read === null ? null : Number(b.rows_read),
        rowsAccepted: b.rows_accepted === null ? null : Number(b.rows_accepted),
        rowsRejected: b.rows_rejected === null ? null : Number(b.rows_rejected),
        errorCode: (b.error_code as string | null) ?? null,
      }));
      out.import_failures =
        batches.length === 0
          ? { state: 'never_ingested', reason: 'No PC7 disclosure import has ever run. Zero failures here is not a health signal.' }
          : { state: 'ok', data: summariseImportFailures(batches) };
    }
  }

  // ---- O.9 (f) source changes ---------------------------------------------
  if (wanted.includes('source_changes')) {
    const { data, error } = await db
      .from('ii_reference_import_batches')
      .select('id, started_at, source_column_signature, source_sections_seen, rows_read, rows_rejected')
      .eq('batch_kind', 'fund_holdings_disclosure')
      .not('source_column_signature', 'is', null)
      .order('started_at', { ascending: true })
      .limit(200);
    if (error) {
      out.source_changes = isMissingRelation(error) ? { state: 'unavailable', reason: UNAVAILABLE_MIGRATION } : undefined;
      if (!out.source_changes) return safeDbError(error, 'pc7 source changes');
    } else {
      const observations: LayoutObservation[] = (data ?? []).map((b) => {
        const read = b.rows_read === null ? 0 : Number(b.rows_read);
        return {
          batchId: b.id as string,
          observedAt: b.started_at as string,
          columnSignature: (b.source_column_signature as string) ?? '',
          sectionsSeen: (b.source_sections_seen as string[] | null) ?? [],
          rejectionRate: read > 0 ? Number(b.rows_rejected ?? 0) / read : null,
        };
      });
      out.source_changes =
        observations.length < 2
          ? { state: 'never_ingested', reason: `Source-change detection needs at least two observed imports of the same source; ${observations.length} recorded.` }
          : { state: 'ok', data: { observationCount: observations.length, changes: detectSourceChanges(observations) } };
    }
  }

  // ---- O.7 net-worth safety, asserted by the database ---------------------
  if (wanted.includes('networth_safety')) {
    const { data, error } = await db.rpc('ii_pc7_networth_safety_violations');
    if (error) {
      out.networth_safety = isMissingRelation(error)
        ? { state: 'unavailable', reason: UNAVAILABLE_MIGRATION }
        : { state: 'unavailable', reason: `The O.7 safety assertion could not be evaluated: ${error.message ?? 'unknown error'}. An unevaluated invariant is reported as unavailable, never as satisfied.` };
    } else {
      const violations = (data ?? []) as Array<{ violation_code: string; object_name: string; detail: string }>;
      out.networth_safety = {
        state: 'ok',
        data: {
          satisfied: violations.length === 0,
          violationCount: violations.length,
          violations,
          note: 'O.7/D.2: look-through constituents are analytical decomposition only and must never create a second net-worth contribution. An EMPTY violation list is the passing state.',
        },
      };
    }
  }

  // ---- blocked sources (the honest gap) ------------------------------------
  if (wanted.includes('blocked_sources')) {
    out.blocked_sources = {
      state: 'ok',
      data: blockedDisclosureSources().map((s) => ({
        sourceKey: s.sourceKey,
        label: s.label,
        kind: s.kind,
        format: s.format,
        licence: s.licence,
        termsUrl: s.termsUrl,
        reason: s.notes,
      })),
    };
  }

  return ok(out);
});
