// NAV 1 — daily reconciliation sweep (PO decision #1, 27 Sep 2026).
//
// WHAT THIS IS. A second, SHORTER job that runs later in the day than the
// main collection window (0187/0188, budgeted by 0204/0205) and fetches ONLY
// what is missing or incomplete for the CURRENT publication date -- never a
// full-universe rewrite. It is also the mechanism the one-off backfill
// (docs/nav1/po_run_2026-09-27b/) reuses for the weekend and late-published
// gaps, by pointing it at the AMFI history endpoint for a past date instead
// of "today".
//
// WHY A SEPARATE MODULE, NOT A CHANGE TO referenceIngestJob.ts. That file is
// the live, proven, currently-scheduled daily-NAV code path (0204/0205's exact
// 18s-budget/PARTIAL_BATCH_CONTINUING design). This mission is explicitly
// production-read-only and additive; touching the critical path to shave a
// few duplicated lines is a worse trade than a small amount of duplication.
// Where duplication exists (the instrument-resolution read, the insert/
// correction write loop) it deliberately mirrors referenceIngestJob.ts's
// already-proven shape and comments cross-reference it rather than re-deriving
// the reasoning.
//
// TWO NOTIONS OF "DONE", KEPT DELIBERATELY SEPARATE:
//   - the collection WINDOW succeeds when it finishes processing whatever the
//     source handed it that call (referenceIngestJob.ts's own status);
//   - the publication DATE is "complete" only once THIS sweep confirms zero
//     gap against what the source itself published for that date
//     (ii_reference_publication_coverage.complete). A window can succeed on a
//     day the source later republishes more schemes (F-18) -- window success
//     never implies date completeness.
//
// "AGAINST THE ACTIVE SCHEME UNIVERSE." The "expected" set for a date is
// derived from the SOURCE'S OWN published records for that exact date, not a
// static "every AMFI-mapped instrument" set. The latter is permanently ~40%
// short (measured 2026-09-24: 8,662 of 14,357) because most mapped instruments
// are dormant/matured and never publish again (F-7: lifecycle_status is never
// maintained) -- treating that as "missing" would make the sweep try to
// re-fetch a permanent, un-fixable gap every single day. Deriving "expected"
// from the source's own file for that date sidesteps this correctly, at the
// cost of one small fetch even on a day with nothing to fix (see FETCH BEFORE
// GAP IS KNOWN below).
//
// FETCH BEFORE THE GAP IS KNOWN. Unlike the main job's unchanged-source skip
// (which can tell "nothing to do" from a checksum before fetching -- it isn't
// possible to know here either, since AMFI has no "what changed" endpoint),
// this sweep must fetch+parse once per invocation to learn what the source
// published for the date, even on a day that turns out fully covered. That
// fetch is cheap (a few seconds; the main job's own measurements: 3.9s for
// NAVAll.txt). The fetched bytes are reused for the whole invocation -- there
// is never a second fetch to fill a gap the same call already found.
//
// NEVER REWRITES THE WHOLE UNIVERSE (write sense). planImport() sees every
// resolved record for this exact publication date -- it has to, in order to
// tell "missing" and "incomplete" (a value that no longer matches the source)
// apart from "already correct" -- but only its 'insert' and 'supersede'
// entries are ever sent to the database (step 7). An 'unchanged'/'skip'
// entry never generates a write of any kind, so a day where nothing changed
// costs one exact-pair lookup and zero writes, and a day with a handful of
// gaps costs a write for exactly that handful, never the rest of the file.
//
// IDEMPOTENT AND CORRECTION-SAFE BY CONSTRUCTION, because it reuses the exact
// pure decision functions the daily job already proved this on:
// referenceImportRunner.decideStart/reconcileStaleRunningBatches/planImport
// and referenceDataQuality.decideUpsert. A rerun with unchanged source data
// plans zero writes (decideUpsert 'skip'); a later different NAV for an
// already-recorded date plans exactly one 'supersede' (in-place update + a
// ii_reference_corrections audit row), never a duplicate-key insert -- the
// same invariant referenceIngestJob.ts's own corrections loop already proves
// live (see that file's long comment on the 0033 unique constraint).

import { createAdminClient } from '@/lib/supabase/admin';
import { parseNavAll, parseNavHistory, type AmfiParseResult } from './amfiParser';
import {
  classifyFetch,
  decideStart,
  nextAttemptAfter,
  planImport,
  reconcileStaleRunningBatches,
  settleBatch,
  MIN_PLAUSIBLE_FULL_UNIVERSE_BYTES,
  type ChunkOutcome,
  type InstrumentResolutionIndex,
  type JobControlRow,
} from './referenceImportRunner';
import { buildUrl, getReferenceSource } from '@/lib/config/investment-intelligence/pc6ReferenceSources';
import { fetchAllRows } from '../pagination';
import { createWriteBudget, resolveBudgetMs, type WriteBudget } from './ingestBudget';
import { loadExistingObservations, type NavPair } from './exactPairLookup';
import { decideCoverageComplete, evaluateCoverageAlert, COVERAGE_MATERIAL_DROP_RATIO, COVERAGE_MIN_BASELINE_SAMPLES } from './navCoverage';

export const NAV_RECONCILIATION_BATCH_KIND = 'nav_reconciliation';

/** How many trailing coverage rows to read for the baseline. */
export const COVERAGE_BASELINE_LOOKBACK_ROWS = 14;

export interface ReconciliationSweepArgs {
  /** Its own ii_reference_job_control row -- a separate kill switch/backoff/last_success_at from the main daily job. */
  jobKey: string;
  /** 'amfi_nav_daily' for the ordinary "today" sweep; 'amfi_nav_history' for a past-date backfill (see PROD_BACKFILL). */
  sourceConfigId: string;
  /** ISO yyyy-mm-dd. The exact date being reconciled. Never defaulted to the machine clock by this function. */
  publicationDate: string;
  budgetMs?: number;
  startedAtMs?: number;
  now?: () => number;
  chunkSize?: number;
  dryRun?: boolean;
}

export interface ReconciliationSweepResult {
  jobKey: string;
  status:
    | 'complete_no_gap'
    | 'succeeded'
    | 'partial'
    | 'failed'
    | 'skipped_kill_switch'
    | 'skipped_backoff'
    | 'skipped_already_running'
    | 'skipped_source_outage';
  detail: string;
  batchId: string | null;
  publicationDate: string;
  sourceConfigId: string;
  coverage: {
    expectedCount: number;
    presentCountBefore: number;
    presentCountAfter: number;
    missingCountAfter: number;
    complete: boolean;
  } | null;
  alert: { fired: boolean; detail: string; coverageRatio: number | null; baselineUsed: number | null } | null;
  counts: { inserted: number; superseded: number; remainingInserts: number; remainingCorrections: number };
}

const EMPTY_RESULT_COUNTS = { inserted: 0, superseded: 0, remainingInserts: 0, remainingCorrections: 0 };

/** Same shape as selectiveHistoricalHydrationJob.ts's planHydrationJobControlUpdate (F-14 fix) -- deliberately duplicated rather than imported from a "hydration"-named module for an unrelated job; the logic is generic and this keeps that naming boundary clean. */
export function planReconciliationJobControlUpdate(
  outcome: { status: 'succeeded' | 'partial' | 'failed'; finishedAt: string; batchId: string | null },
  priorConsecutiveFailures: number
): { column: 'last_success_at' | 'last_failure_at'; onlyIfOlderThan: string; set: Record<string, string | number | null> } | null {
  if (outcome.status === 'succeeded') {
    return {
      column: 'last_success_at',
      onlyIfOlderThan: outcome.finishedAt,
      set: { last_success_at: outcome.finishedAt, last_success_batch_id: outcome.batchId, consecutive_failures: 0, updated_at: outcome.finishedAt },
    };
  }
  if (outcome.status === 'failed') {
    return {
      column: 'last_failure_at',
      onlyIfOlderThan: outcome.finishedAt,
      set: { last_failure_at: outcome.finishedAt, consecutive_failures: Math.max(0, priorConsecutiveFailures) + 1, updated_at: outcome.finishedAt },
    };
  }
  return null; // partial: neither a success nor a failure -- see module header.
}

/**
 * Idempotent job-control write, same shape as
 * selectiveHistoricalHydrationJobLive.ts's recordJobControlOutcome (F-14):
 * applies only while the stored column is NULL or older than the new value,
 * so recording the same run twice never double-counts and a late/out-of-order
 * call never moves the timestamp backwards. Zero rows updated means "a newer
 * outcome is already recorded", not an error.
 */
async function applyJobControlPlan(
  db: ReturnType<typeof createAdminClient>,
  jobKey: string,
  plan: { column: 'last_success_at' | 'last_failure_at'; onlyIfOlderThan: string; set: Record<string, string | number | null> }
): Promise<void> {
  await db
    .from('ii_reference_job_control')
    .update(plan.set)
    .eq('job_key', jobKey)
    .or(`${plan.column}.is.null,${plan.column}.lt."${plan.onlyIfOlderThan}"`);
}

export async function runNavReconciliationSweep(args: ReconciliationSweepArgs): Promise<ReconciliationSweepResult> {
  const clock = args.now ?? Date.now;
  const startedAtMs = args.startedAtMs ?? clock();
  const budgetMs = resolveBudgetMs(args.budgetMs);
  const budget: WriteBudget = createWriteBudget({ startedAtMs, budgetMs, clock });
  const chunkSize = args.chunkSize ?? 500;
  const db = createAdminClient();
  const source = getReferenceSource(args.sourceConfigId);
  const nowIso = new Date().toISOString();

  const base = { jobKey: args.jobKey, publicationDate: args.publicationDate, sourceConfigId: args.sourceConfigId, batchId: null as string | null, coverage: null, alert: null, counts: { ...EMPTY_RESULT_COUNTS } };

  // --- 1. Kill switch and backoff -------------------------------------------
  const { data: controlRow } = await db
    .from('ii_reference_job_control')
    .select('job_key, enabled, disabled_reason, consecutive_failures, next_attempt_not_before, last_success_at')
    .eq('job_key', args.jobKey)
    .maybeSingle();
  const control: JobControlRow | null = controlRow
    ? {
        jobKey: controlRow.job_key,
        enabled: controlRow.enabled,
        disabledReason: controlRow.disabled_reason,
        consecutiveFailures: controlRow.consecutive_failures,
        nextAttemptNotBefore: controlRow.next_attempt_not_before,
        lastSuccessAt: controlRow.last_success_at,
      }
    : null;
  const start = decideStart(control, args.jobKey, nowIso);
  if (!start.start) {
    return { ...base, status: start.status, detail: start.detail };
  }

  // --- 2. Stale-batch reconciliation (same guard as the daily job) ---------
  const { data: runningRows } = await db
    .from('ii_reference_import_batches')
    .select('id, started_at')
    .eq('source_key', source.sourceKey)
    .eq('batch_kind', NAV_RECONCILIATION_BATCH_KIND)
    .eq('status', 'running');
  const reconciliation = reconcileStaleRunningBatches((runningRows ?? []).map((r) => ({ id: r.id, started_at: r.started_at })), nowIso, 15);
  if (reconciliation.reconciledIds.length > 0) {
    await db
      .from('ii_reference_import_batches')
      .update({ status: 'failed', finished_at: nowIso, error_code: 'STALE_RUNNING_RECONCILED', error_detail: reconciliation.detail })
      .in('id', reconciliation.reconciledIds);
  }
  if (reconciliation.stillRunning) {
    return { ...base, status: 'skipped_already_running', detail: reconciliation.detail };
  }

  // --- 3. Fetch + parse the source for THIS date ----------------------------
  // For 'amfi_nav_daily' (no {frmdt}/{todt} placeholders) buildUrl() ignores
  // the window and always returns today's file, so this mode is only
  // meaningful for a publicationDate that IS today (the ordinary sweep). For
  // 'amfi_nav_history' the window is exactly [publicationDate, publicationDate]
  // -- a single-day history report, which genuinely serves any past date (the
  // backfill's whole reason for existing; see NAV1_Production_Final_Certification
  // 2026-09-26 report, "one premise corrected": amfi_nav_history is a real
  // date-range report, not merely "today").
  const needsWindow = source.urlTemplate?.includes('{frmdt}') ?? false;
  const url = buildUrl(args.sourceConfigId, needsWindow ? { fromDate: args.publicationDate, toDate: args.publicationDate } : {});
  let bytes: Uint8Array | null = null;
  let httpStatus: number | null = null;
  let networkError: string | undefined;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'FHIP-PC6/1.0' } });
    httpStatus = r.status;
    bytes = new Uint8Array(await r.arrayBuffer());
  } catch (e) {
    networkError = e instanceof Error ? e.message : String(e);
  }
  const retrievedAt = new Date().toISOString();
  // A single-day history report is legitimately much smaller than the full
  // NAVAll.txt plausibility floor, so only apply that floor to the daily feed.
  const minBytes = source.format === 'amfi_navhistory_txt' ? 1_000 : MIN_PLAUSIBLE_FULL_UNIVERSE_BYTES;
  const fetched = classifyFetch(httpStatus, bytes, minBytes, retrievedAt, networkError);
  if (!fetched.ok) {
    const failures = (control?.consecutiveFailures ?? 0) + 1;
    await db.from('ii_reference_job_control').update({
      last_failure_at: nowIso, consecutive_failures: failures, next_attempt_not_before: nextAttemptAfter(nowIso, failures), updated_at: nowIso,
    }).eq('job_key', args.jobKey);
    return { ...base, status: 'skipped_source_outage', detail: fetched.detail };
  }

  let parsed: AmfiParseResult;
  try {
    parsed = source.format === 'amfi_navhistory_txt'
      ? parseNavHistory(fetched.bytes, { asOfDate: args.publicationDate, retrievedAt })
      : parseNavAll(fetched.bytes, { asOfDate: args.publicationDate, retrievedAt });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const failures = (control?.consecutiveFailures ?? 0) + 1;
    await db.from('ii_reference_job_control').update({
      last_failure_at: nowIso, consecutive_failures: failures, next_attempt_not_before: nextAttemptAfter(nowIso, failures), updated_at: nowIso,
    }).eq('job_key', args.jobKey);
    return { ...base, status: 'failed', detail: `Parse failed: ${detail}` };
  }

  // --- 4. Resolve, scoped to exactly this publication date ------------------
  // Deliberately duplicates referenceIngestJob.ts's startResolutionReads()
  // rather than sharing it -- see module header.
  const [idRowsRes, instRowsRes] = await Promise.all([
    fetchAllRows<{ identifier_value: string; instrument_id: string }>(() =>
      db.from('ii_instrument_identifiers').select('identifier_value, instrument_id')
        .eq('identifier_scheme', 'amfi_scheme_code').eq('country_code', source.countryCode).eq('is_active', true).order('id')
    ),
    fetchAllRows<{ id: string; isin: string | null }>(() =>
      db.from('ii_instruments').select('id, isin').eq('instrument_class', 'mutual_fund').not('isin', 'is', null).order('id')
    ),
  ]);

  const index: InstrumentResolutionIndex = {
    byAmfiCode: new Map(idRowsRes.map((r) => [r.identifier_value, r.instrument_id])),
    byIsin: new Map(instRowsRes.filter((r) => r.isin).map((r) => [r.isin as string, r.id])),
  };

  const dayRecords = parsed.records.filter((r) => r.navDate === args.publicationDate);
  const resolvedDayRecords = dayRecords
    .map((r) => ({ record: r, instrumentId: index.byAmfiCode.get(r.amfiSchemeCode) ?? (r.isinGrowthOrPayout ? index.byIsin.get(r.isinGrowthOrPayout) : undefined) }))
    .filter((x): x is { record: (typeof dayRecords)[number]; instrumentId: string } => !!x.instrumentId);

  // --- 5. What does the day's plan look like RIGHT NOW? ---------------------
  // The exact-pair lookup here is scoped to exactly this date's resolved
  // records (typically ~8,700-9,400 pairs on a weekday, far fewer on a
  // reconciliation day where the main window already collected most of it) --
  // NOT the "instrument x 831 distinct dates" cross product 0204 replaced.
  // ~9-10 RPC calls at ~0.9s each (exactPairLookup.ts's own measurement),
  // well inside the 28s platform limit even before any write, and it runs
  // every reconciliation call (there is no cheaper way to learn "is anything
  // incomplete", not just "missing", without asking about every pair). This
  // single planImport() call is where BOTH halves of "missing or incomplete"
  // come from: decideUpsert's 'insert' (missing) and 'supersede' (incomplete
  // -- an existing row whose checksum no longer matches the source, i.e. a
  // correction) actions. 'skip' is "present and confirmed correct" -- the
  // ONLY thing this sweep is allowed to call covered.
  const allPairs: NavPair[] = resolvedDayRecords.map((x) => ({ instrumentId: x.instrumentId, priceDate: x.record.navDate }));
  let existingAll;
  try {
    existingAll = await loadExistingObservations(db, allPairs);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const failures = (control?.consecutiveFailures ?? 0) + 1;
    await db.from('ii_reference_job_control').update({
      last_failure_at: nowIso, consecutive_failures: failures, next_attempt_not_before: nextAttemptAfter(nowIso, failures), updated_at: nowIso,
    }).eq('job_key', args.jobKey);
    return { ...base, status: 'failed', detail };
  }
  const scopedParsedAll: AmfiParseResult = { ...parsed, records: resolvedDayRecords.map((x) => x.record), rejections: [] };
  const planAll = planImport({ parsed: scopedParsedAll, index, existing: existingAll, currencyCode: source.currencyCode });
  const expectedCount = resolvedDayRecords.length;
  const missingOrIncompleteCount = planAll.counts.toInsert + planAll.counts.toSupersede;
  const gapBefore = { expectedCount, presentCount: planAll.counts.unchanged, missingCount: missingOrIncompleteCount };

  const finishNoBatch = async (
    status: 'complete_no_gap' | 'succeeded' | 'failed',
    detail: string,
    presentCountAfter: number,
    missingCountAfter: number
  ): Promise<ReconciliationSweepResult> => {
    const complete = decideCoverageComplete(missingCountAfter);
    const alert = await recordCoverageAndAlert(db, {
      sourceConfigId: args.sourceConfigId,
      publicationDate: args.publicationDate,
      expectedCount: gapBefore.expectedCount,
      presentCount: presentCountAfter,
      missingCount: missingCountAfter,
      complete,
      batchId: null,
      now: nowIso,
    });
    const plan = planReconciliationJobControlUpdate({ status: status === 'failed' ? 'failed' : 'succeeded', finishedAt: nowIso, batchId: null }, control?.consecutiveFailures ?? 0);
    if (plan) await applyJobControlPlan(db, args.jobKey, plan);
    return {
      ...base,
      status,
      detail,
      coverage: { expectedCount: gapBefore.expectedCount, presentCountBefore: gapBefore.presentCount, presentCountAfter, missingCountAfter, complete },
      alert,
    };
  };

  if (gapBefore.missingCount === 0) {
    return finishNoBatch('complete_no_gap', `Publication date ${args.publicationDate}: ${gapBefore.presentCount}/${gapBefore.expectedCount} already present. No gap; nothing fetched to fill, nothing written.`, gapBefore.presentCount, 0);
  }

  if (args.dryRun) {
    return {
      ...base,
      status: 'succeeded',
      detail: `Dry run: ${gapBefore.missingCount} missing/incomplete pair(s) would be reconciled. Nothing written.`,
      coverage: { expectedCount: gapBefore.expectedCount, presentCountBefore: gapBefore.presentCount, presentCountAfter: gapBefore.presentCount, missingCountAfter: gapBefore.missingCount, complete: false },
    };
  }

  // --- 6. Open a batch. planAll.writes already names exactly the
  // missing/incomplete entries (action 'insert' or 'supersede') -- an
  // 'unchanged'/'skip' record is never planned, never sent to the database,
  // never touched. No second fetch, no second parse, no second lookup: the
  // plan computed in step 5 is reused as-is. ---------------------------------
  const { data: batch, error: batchErr } = await db
    .from('ii_reference_import_batches')
    .insert({
      source_key: source.sourceKey,
      source_config_id: args.sourceConfigId,
      batch_kind: NAV_RECONCILIATION_BATCH_KIND,
      as_of_date: args.publicationDate,
      window_from: args.publicationDate,
      window_to: args.publicationDate,
      source_url: url,
      status: 'running',
      attempt: (control?.consecutiveFailures ?? 0) + 1,
      parser_version: parsed.parserVersion,
      source_retrieved_at: retrievedAt,
      source_sha256: parsed.fingerprint.sha256,
      source_byte_length: parsed.fingerprint.byteLength,
    })
    .select('id')
    .single();
  if (batchErr || !batch) {
    return { ...base, status: 'failed', detail: `Could not open a reconciliation batch row: ${batchErr?.message ?? 'unknown'}` };
  }
  const batchId = batch.id as string;

  // --- 7. Write, budgeted -- identical shape to referenceIngestJob.ts's own
  // insert/correction loop (see that file for the full 0033-constraint
  // rationale); duplicated deliberately, see module header. ------------------
  const inserts = planAll.writes.filter((w) => w.action === 'insert');
  const supersedes = planAll.writes.filter((w) => w.action === 'supersede');
  const chunks: ChunkOutcome[] = [];
  const dataVersion = `${parsed.parserVersion}:${parsed.fingerprint.sha256.slice(0, 12)}`;
  let inserted = 0;
  let superseded = 0;

  let insertsAttempted = 0;
  for (let i = 0; i < inserts.length; i += chunkSize) {
    if (!budget.canStart('insert_chunk')) break;
    const slice = inserts.slice(i, i + chunkSize);
    insertsAttempted = i + slice.length;
    const { error } = await budget.time('insert_chunk', async () =>
      db.from('ii_prices_nav').upsert(
        slice.map((w) => ({
          instrument_id: w.instrumentId, currency_code: w.currencyCode, price_date: w.priceDate, price: w.price,
          source_timestamp: retrievedAt, data_version: dataVersion, record_checksum: w.recordChecksum, import_batch_id: batchId, quality_status: 'ok',
        })),
        { onConflict: 'instrument_id,price_date', ignoreDuplicates: true }
      )
    );
    chunks.push({ chunkIndex: chunks.length, attempted: slice.length, succeeded: error ? 0 : slice.length, error: error?.message ?? null });
    if (!error) inserted += slice.length;
  }
  const remainingInserts = inserts.length - insertsAttempted;

  let correctionsAttempted = 0;
  if (remainingInserts === 0) {
    for (const w of supersedes) {
      if (!budget.canStart('correction')) break;
      correctionsAttempted++;
      await budget.time('correction', async () => {
        const { data: prior } = await db.from('ii_prices_nav').select('id, price').eq('instrument_id', w.instrumentId).eq('price_date', w.priceDate).maybeSingle();
        if (!prior) return;
        const { error } = await db.from('ii_prices_nav').update({
          price: w.price, source_timestamp: retrievedAt, data_version: dataVersion, record_checksum: w.recordChecksum, import_batch_id: batchId, quality_status: 'ok',
        }).eq('id', prior.id);
        if (error) { chunks.push({ chunkIndex: chunks.length, attempted: 1, succeeded: 0, error: error.message }); return; }
        await db.from('ii_reference_corrections').insert({
          target_table: 'ii_prices_nav', target_row_id: prior.id, correction_kind: 'source_correction',
          previous_value: { price: prior.price }, new_value: { price: w.price }, actor_kind: 'system_import',
          reason: `Reconciliation sweep: source ${source.sourceKey} republished a different NAV for ${w.priceDate}; the prior value is preserved in previous_value (ii_prices_nav's unique (instrument_id, price_date) key forbids a second physical row -- see referenceIngestJob.ts's corrections loop for the full rationale).`,
          batch_id: batchId,
        });
        superseded += 1;
        chunks.push({ chunkIndex: chunks.length, attempted: 1, succeeded: 1, error: null });
      });
    }
  }
  const remainingCorrections = supersedes.length - correctionsAttempted;

  // --- 8. Recompute coverage AFTER the write, close the batch, mark control -
  // Anything not successfully inserted/superseded this pass is still
  // incomplete, whether it was never attempted (budget) or attempted and
  // failed (a chunk error) -- both leave the (instrument, date) pair without
  // a correct row, so both must still count as missing.
  const missingAfterCount = Math.max(0, gapBefore.missingCount - inserted - superseded);
  const presentAfterCount = gapBefore.presentCount + inserted + superseded;
  const gapAfter = { expectedCount: gapBefore.expectedCount, presentCount: presentAfterCount, missingCount: missingAfterCount };

  const hadErrors = chunks.some((c) => c.error !== null);
  const stillWorkRemaining = !hadErrors && remainingInserts + remainingCorrections > 0;
  const settlement = settleBatch(chunks.length ? chunks : [{ chunkIndex: 0, attempted: 0, succeeded: 0, error: null }], 'commit_chunks');

  let finalStatus: 'succeeded' | 'partial' | 'failed';
  let finalDetail: string;
  if (stillWorkRemaining) {
    finalStatus = 'partial';
    finalDetail = `Stopped at the ${budgetMs} ms budget with ${remainingInserts} insert(s) and ${remainingCorrections} correction(s) remaining; the next invocation continues (idempotent).`;
  } else if (hadErrors) {
    finalStatus = 'failed';
    finalDetail = settlement.detail;
  } else if (!decideCoverageComplete(gapAfter.missingCount)) {
    // Every planned write succeeded, but the source itself still does not
    // carry a NAV for some expected instrument (e.g. AMFI has not republished
    // it yet even in this pass) -- not a failure of this job, not a success
    // either (the date is still incomplete). Mirrors hydration's "partial ->
    // neither" job-control semantics (F-14).
    finalStatus = 'partial';
    finalDetail = `${inserted} inserted, ${superseded} corrected; ${gapAfter.missingCount} instrument(s) the source published for ${args.publicationDate} still have no row (source has not (re)published them in this fetch). Will retry on the next tick.`;
  } else {
    finalStatus = 'succeeded';
    finalDetail = `${inserted} inserted, ${superseded} corrected; publication date ${args.publicationDate} confirmed complete (${gapAfter.presentCount}/${gapAfter.expectedCount}).`;
  }

  await db.from('ii_reference_import_batches').update({
    status: finalStatus === 'partial' ? 'failed' : finalStatus,
    finished_at: nowIso,
    rows_read: inserts.length + supersedes.length,
    rows_accepted: inserts.length + supersedes.length,
    rows_rejected: 0,
    rows_inserted: inserted,
    rows_unchanged: planAll.counts.unchanged,
    rows_superseded: superseded,
    error_code: finalStatus === 'partial' ? 'RECONCILIATION_INCOMPLETE_CONTINUING' : finalStatus === 'failed' ? (hadErrors ? 'BATCH_FAILED' : 'RECONCILIATION_FAILED') : null,
    error_detail: finalStatus === 'succeeded' ? null : finalDetail,
    notes: { coverage: { expected: gapAfter.expectedCount, presentBefore: gapBefore.presentCount, presentAfter: gapAfter.presentCount, missingAfter: gapAfter.missingCount } },
  }).eq('id', batchId);

  const complete = decideCoverageComplete(gapAfter.missingCount);
  const alert = await recordCoverageAndAlert(db, {
    sourceConfigId: args.sourceConfigId,
    publicationDate: args.publicationDate,
    expectedCount: gapAfter.expectedCount,
    presentCount: gapAfter.presentCount,
    missingCount: gapAfter.missingCount,
    complete,
    batchId,
    now: nowIso,
  });

  const jcOutcome = planReconciliationJobControlUpdate({ status: finalStatus, finishedAt: nowIso, batchId }, control?.consecutiveFailures ?? 0);
  if (jcOutcome) await applyJobControlPlan(db, args.jobKey, jcOutcome);

  return {
    ...base,
    batchId,
    status: finalStatus,
    detail: finalDetail,
    coverage: { expectedCount: gapAfter.expectedCount, presentCountBefore: gapBefore.presentCount, presentCountAfter: gapAfter.presentCount, missingCountAfter: gapAfter.missingCount, complete },
    alert,
    counts: { inserted, superseded, remainingInserts, remainingCorrections },
  };
}

/**
 * Upsert the coverage row for (sourceConfigId, publicationDate) and evaluate
 * the material-drop alert against the trailing baseline, resolving any
 * previously-open alert once coverage recovers. Best effort: a failure here
 * is reported in the returned detail but never throws (a lost coverage row
 * must not undo a successful write).
 */
async function recordCoverageAndAlert(
  db: ReturnType<typeof createAdminClient>,
  input: {
    sourceConfigId: string; publicationDate: string; expectedCount: number; presentCount: number; missingCount: number;
    complete: boolean; batchId: string | null; now: string;
  }
): Promise<ReconciliationSweepResult['alert']> {
  await db.from('ii_reference_publication_coverage').upsert(
    {
      source_config_id: input.sourceConfigId,
      publication_date: input.publicationDate,
      expected_count: input.expectedCount,
      present_count: input.presentCount,
      missing_count: input.missingCount,
      complete: input.complete,
      last_checked_at: input.now,
      last_sweep_batch_id: input.batchId,
      updated_at: input.now,
    },
    { onConflict: 'source_config_id,publication_date' }
  );

  const { data: history } = await db
    .from('ii_reference_publication_coverage')
    .select('present_count, publication_date')
    .eq('source_config_id', input.sourceConfigId)
    .lt('publication_date', input.publicationDate)
    .order('publication_date', { ascending: false })
    .limit(COVERAGE_BASELINE_LOOKBACK_ROWS);
  const recentPresentCounts = (history ?? []).map((r) => r.present_count as number);

  const decision = evaluateCoverageAlert({ presentCount: input.presentCount, recentPresentCounts });

  const { data: openAlert } = await db
    .from('ii_reference_coverage_alerts')
    .select('id')
    .eq('source_config_id', input.sourceConfigId)
    .eq('publication_date', input.publicationDate)
    .is('resolved_at', null)
    .maybeSingle();

  if (decision.shouldAlert) {
    if (!openAlert) {
      await db.from('ii_reference_coverage_alerts').insert({
        source_config_id: input.sourceConfigId,
        publication_date: input.publicationDate,
        expected_count: input.expectedCount,
        present_count: input.presentCount,
        coverage_ratio: decision.coverageRatio,
        baseline_present_count: decision.baselineUsed,
        baseline_ratio_threshold: COVERAGE_MATERIAL_DROP_RATIO,
        detail: decision.detail,
      });
    } else {
      await db.from('ii_reference_coverage_alerts').update({
        present_count: input.presentCount, coverage_ratio: decision.coverageRatio, baseline_present_count: decision.baselineUsed, detail: decision.detail,
      }).eq('id', openAlert.id);
    }
  } else if (openAlert) {
    await db.from('ii_reference_coverage_alerts').update({ resolved_at: input.now, resolved_detail: `Recovered: ${decision.detail}` }).eq('id', openAlert.id);
  }

  return { fired: decision.shouldAlert, detail: decision.detail, coverageRatio: decision.coverageRatio, baselineUsed: decision.baselineUsed };
}

export { COVERAGE_MATERIAL_DROP_RATIO, COVERAGE_MIN_BASELINE_SAMPLES };
