// PC6 (M6) — the reference-market-data quality surface (N.11).
//
// N.11 requires operator visibility for: scheme mapping gaps; benchmark
// mapping gaps; NAV freshness; failed import batches; unusual jumps/outliers;
// source corrections; risk-free freshness; last successful job.
//
// GET is read-only. POST (added 2026-09-20, PO instruction) is NOT "correct
// reference data" -- it never touches ii_reference_corrections or writes a
// value an admin chose. It re-runs the EXACT SAME deterministic ingest job
// the nightly cron calls, through the same runReferenceIngest() and the same
// kill switch (a disabled job still refuses to run, even from this button),
// for the case the cron run failed and an admin wants to retry the tail
// without a terminal. Gated on the identical PC6_ADMIN_CAPABILITY as GET --
// no new capability, no new privilege.
//
// ADMIN STANDARD §9 (personal/financial data boundary) — ANALYSIS.
// Every table this route reads is GLOBAL REFERENCE DATA with no tenancy
// column at all (proved structurally by scripts/pc6_0155_pglite_verification.mjs).
// No user_id, no household, no names, no emails, no financial record, no
// free text a user authored. Nothing here is derived from any user's holdings,
// and no row count varies with how many users hold a scheme. The §7 privacy
// suppression model (min cell count, complementary suppression, differencing)
// therefore has nothing to bite on: there is no cohort to reconstruct, because
// there is no person in the data. This is stated as an explicit finding rather
// than an omission — see the PC6 certification's Admin Standard section.
//
// §8 RESULT-STATE SEMANTICS. Every panel returns one of `ok` / `unavailable`,
// never a bare 0 standing in for "we do not know". A feed that has never been
// ingested reports `never_ingested`, which is a different state from `stale`.
//
// §13 SAFE FAILURE. A missing table (0155 not yet applied) is reported as
// `unavailable` with the reason, not as an empty healthy dashboard.

import { z } from 'zod';
import { adminRoute, adminClient, safeDbError } from '@/lib/services/adminAuth';
import { requireReferenceDataAdmin } from '@/lib/services/investment-intelligence/pc6/referenceDataAdmin';
import { ok, bad, badValidation } from '@/lib/api';
import { assessFreshness } from '@/lib/services/investment-intelligence/pc6/referenceDataQuality';
import { classifyRiskFree, riskFreeFreshness } from '@/lib/services/investment-intelligence/pc6/riskFreeSeries';
import { PC6_REFERENCE_SOURCES, blockedSources } from '@/lib/config/investment-intelligence/pc6ReferenceSources';
import { runReferenceIngest } from '@/lib/services/investment-intelligence/pc6/referenceIngestJob';

export const dynamic = 'force-dynamic';

type PanelState = 'ok' | 'unavailable';
interface Panel<T> {
  state: PanelState;
  /** Present only when state === 'ok'. */
  data?: T;
  /** Present only when state === 'unavailable'. Never a silent empty list. */
  reason?: string;
}

const UNAVAILABLE_0155 =
  'Migration 0155 has not been applied to this database, so PC6 operational tables do not exist yet. ' +
  'This is reported as unavailable rather than as a healthy empty dashboard.';

const PANELS = [
  'nav_freshness',
  'scheme_mapping_gaps',
  'benchmark_mapping_gaps',
  'import_batches',
  'outliers',
  'corrections',
  'risk_free',
  'job_control',
  'blocked_sources',
] as const;
type PanelKey = (typeof PANELS)[number];

export const GET = adminRoute(async (req: Request) => {
  const { forbidden } = await requireReferenceDataAdmin();
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
  const out: Record<string, unknown> = { asOfDate, generatedAt: new Date().toISOString() };

  /** Run a query, turning a missing-relation error into an honest `unavailable`. */
  async function panel<T>(fn: () => Promise<{ data: T | null; error: { code?: string; message?: string } | null }>): Promise<Panel<T> | Response> {
    const { data, error } = await fn();
    if (error) {
      // PGRST205 / 42P01 — the relation does not exist yet.
      if (error.code === 'PGRST205' || error.code === '42P01' || /does not exist/i.test(error.message ?? '')) {
        return { state: 'unavailable', reason: UNAVAILABLE_0155 };
      }
      return safeDbError(error, 'pc6 reference-data quality');
    }
    return { state: 'ok', data: (data ?? []) as T };
  }

  // --- NAV freshness, judged PER SERIES ------------------------------------
  if (wanted.includes('nav_freshness')) {
    const { data, error } = await db
      .from('ii_prices_nav')
      .select('instrument_id, price_date')
      .order('price_date', { ascending: false })
      .limit(5000);
    if (error) return safeDbError(error, 'pc6 nav freshness');
    const latestByInstrument = new Map<string, string>();
    for (const r of data ?? []) {
      const prev = latestByInstrument.get(r.instrument_id);
      if (!prev || r.price_date > prev) latestByInstrument.set(r.instrument_id, r.price_date);
    }
    const threshold = PC6_REFERENCE_SOURCES.amfi_nav_daily.staleAfterDays;
    const verdicts = [...latestByInstrument.entries()].map(([instrumentId, latest]) => ({
      instrumentId,
      ...assessFreshness(latest, asOfDate, threshold),
    }));
    out.nav_freshness = {
      state: 'ok',
      data: {
        thresholdDays: threshold,
        seriesCount: verdicts.length,
        fresh: verdicts.filter((v) => v.state === 'fresh').length,
        stale: verdicts.filter((v) => v.state === 'stale').length,
        // The stalest first — that is what an operator needs to look at.
        stalest: verdicts.filter((v) => v.state === 'stale').sort((a, b) => (b.ageDays ?? 0) - (a.ageDays ?? 0)).slice(0, 50),
      },
    };
  }

  // --- Scheme mapping gaps -------------------------------------------------
  if (wanted.includes('scheme_mapping_gaps')) {
    out.scheme_mapping_gaps = await panel(async () =>
      db.from('ii_scheme_master').select('id, amfi_scheme_code, scheme_name, instrument_id, category_header_raw').is('instrument_id', null).limit(200)
    );
  }

  // --- Benchmark mapping gaps ---------------------------------------------
  if (wanted.includes('benchmark_mapping_gaps')) {
    const { data: mapped, error: mErr } = await db.from('ii_instrument_benchmarks').select('instrument_id').eq('relationship_type', 'primary');
    if (mErr) return safeDbError(mErr, 'pc6 benchmark mappings');
    const mappedIds = new Set((mapped ?? []).map((m) => m.instrument_id));
    const { data: funds, error: fErr } = await db.from('ii_instruments').select('id, instrument_name').eq('instrument_class', 'mutual_fund').eq('is_active', true).limit(1000);
    if (fErr) return safeDbError(fErr, 'pc6 instruments');
    const unmapped = (funds ?? []).filter((f) => !mappedIds.has(f.id));
    out.benchmark_mapping_gaps = {
      state: 'ok',
      data: {
        totalFunds: funds?.length ?? 0,
        mapped: (funds ?? []).length - unmapped.length,
        unmapped: unmapped.length,
        // N.8: "unmapped" is an HONEST state. It is reported as a count and a
        // list, never as a zero active return or a defaulted index.
        sample: unmapped.slice(0, 50),
        note: 'An unmapped scheme reduces benchmark coverage in the certified engine rather than contributing a 0% benchmark return. No index is ever guessed to fill a blank (N.8).',
      },
    };
  }

  // --- Import batches (includes "failed batches" and "last successful job") -
  if (wanted.includes('import_batches')) {
    out.import_batches = await panel(async () =>
      db.from('ii_reference_import_batches')
        .select('id, source_key, source_config_id, batch_kind, as_of_date, status, attempt, started_at, finished_at, rows_read, rows_accepted, rows_rejected, rows_inserted, rows_unchanged, rows_superseded, error_code, error_detail, source_sha256, source_byte_length')
        .order('started_at', { ascending: false })
        .limit(100)
    );
  }

  // --- Outliers / unusual jumps -------------------------------------------
  if (wanted.includes('outliers')) {
    const { data, error } = await db
      .from('ii_prices_nav')
      .select('id, instrument_id, price_date, price, quality_status')
      .neq('quality_status', 'ok')
      .order('price_date', { ascending: false })
      .limit(200);
    if (error) return safeDbError(error, 'pc6 outliers');
    out.outliers = { state: 'ok', data: data ?? [] };
  }

  // --- Source corrections --------------------------------------------------
  if (wanted.includes('corrections')) {
    out.corrections = await panel(async () =>
      db.from('ii_reference_corrections')
        .select('id, target_table, target_row_id, correction_kind, actor_kind, actor_admin_id, reason, created_at')
        .order('created_at', { ascending: false })
        .limit(100)
    );
  }

  // --- Risk-free freshness and governance ---------------------------------
  if (wanted.includes('risk_free')) {
    const { data: rates, error: rErr } = await db.from('ii_risk_free_rates').select('country_code, period_start, period_end, annualised_rate, source, version');
    if (rErr) return safeDbError(rErr, 'pc6 risk free');
    const { data: methodologies } = await db.from('ii_risk_free_methodology').select('country_code, source_key, tenor, method, gap_rule, version, reference, approved_by_admin_id, approved_at');
    const periods = (rates ?? []).map((r) => ({
      countryCode: r.country_code, periodStart: r.period_start, periodEnd: r.period_end,
      annualisedRate: Number(r.annualised_rate), version: r.version, source: r.source,
    }));
    const byCountry: Record<string, unknown> = {};
    for (const cc of [...new Set(periods.map((p) => p.countryCode))]) {
      const status = classifyRiskFree(
        cc,
        (methodologies ?? []).map((m) => ({
          countryCode: m.country_code, sourceKey: m.source_key, tenor: m.tenor, method: m.method,
          gapRule: m.gap_rule, version: m.version, reference: m.reference,
          approvedByActorId: m.approved_by_admin_id, approvedAt: m.approved_at,
        })),
        periods.filter((p) => p.countryCode === cc).map((p) => p.source)
      );
      byCountry[cc] = { status: status.state, detail: 'detail' in status ? status.detail : undefined, freshness: riskFreeFreshness(periods, cc, asOfDate) };
    }
    out.risk_free = { state: 'ok', data: byCountry };
  }

  // --- Job control / kill switch -------------------------------------------
  if (wanted.includes('job_control')) {
    out.job_control = await panel(async () =>
      db.from('ii_reference_job_control')
        .select('job_key, enabled, disabled_reason, last_success_at, last_failure_at, consecutive_failures, next_attempt_not_before, updated_at')
        .order('job_key')
    );
  }

  // --- Blocked sources (the honest gaps) -----------------------------------
  if (wanted.includes('blocked_sources')) {
    out.blocked_sources = {
      state: 'ok',
      data: blockedSources().map((s) => ({
        sourceKey: s.sourceKey, label: s.label, kind: s.kind, licence: s.licence, termsUrl: s.termsUrl, reason: s.notes,
      })),
    };
  }

  return ok(out);
});

// --- POST: manual re-run (2026-09-20 PO instruction) -----------------------
const rerunSchema = z.object({
  sourceConfigId: z.string(),
  jobKey: z.string(),
  dryRun: z.boolean().optional(),
});

export const POST = adminRoute(async (req: Request) => {
  const { forbidden } = await requireReferenceDataAdmin();
  if (forbidden) return forbidden;

  const parsed = rerunSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badValidation(parsed.error, 422);
  if (!(parsed.data.sourceConfigId in PC6_REFERENCE_SOURCES)) {
    return bad(`Unknown PC6 source '${parsed.data.sourceConfigId}'. Allowed: ${Object.keys(PC6_REFERENCE_SOURCES).join(', ')}`, 422);
  }

  try {
    const result = await runReferenceIngest({
      jobKey: parsed.data.jobKey,
      sourceConfigId: parsed.data.sourceConfigId,
      asOfDate: new Date().toISOString().slice(0, 10),
      dryRun: parsed.data.dryRun === true,
    });
    // Same sanitised-output discipline as the cron route: counts and alert
    // codes only, never a source URL or credential.
    return ok({
      jobKey: result.jobKey,
      status: result.status,
      batchId: result.batchId,
      detail: result.detail,
      counts: result.counts,
      alerts: result.alerts.map((a) => ({ severity: a.severity, code: a.code })),
    });
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Unexpected ingest error', 500);
  }
});
