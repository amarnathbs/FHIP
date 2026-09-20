// PC6 (M6) — the scheduled reference-ingest job (N.15).
//
// The whole job in one function, built out of the pure pieces in
// referenceImportRunner.ts. The HTTP route is a thin wrapper around this so
// the job can also be invoked from a script or a test without a server.
//
// BINDING OVERRIDE. This job is built and proven in DEV ONLY. Migration 0155
// deliberately registers no pg_cron schedule, and both job-control rows ship
// with enabled = false, so even a correctly-authenticated call returns
// `skipped_kill_switch` until a human turns it on. Activating the production
// schedule is a deferred human-present step, written up in
// docs/investment-intelligence/PC6_OPERATOR_RUNBOOK.md.

import { createAdminClient } from '@/lib/supabase/admin';
import { parseNavAll, parseNavHistory, type AmfiParseResult } from './amfiParser';
import {
  classifyFetch,
  decideStart,
  nextAttemptAfter,
  planImport,
  settleBatch,
  buildAlerts,
  MIN_PLAUSIBLE_FULL_UNIVERSE_BYTES,
  PC6_RUNNER_VERSION,
  type Alert,
  type ChunkOutcome,
  type InstrumentResolutionIndex,
  type JobControlRow,
} from './referenceImportRunner';
import type { ExistingObservation, NavQualityStatus } from './referenceDataQuality';
import { buildUrl, getReferenceSource } from '@/lib/config/investment-intelligence/pc6ReferenceSources';
import { writeSchemeMasterRows } from './schemeMasterWriter';
import { fetchAllRows } from '../pagination';

export interface IngestJobArgs {
  jobKey: string;
  /** A key in PC6_REFERENCE_SOURCES. */
  sourceConfigId: string;
  /** ISO yyyy-mm-dd. Required — never defaulted to the machine clock. */
  asOfDate: string;
  /** For backfill windows (N.4). */
  fromDate?: string;
  toDate?: string;
  /** Rows per committed chunk. Keeps a failure's blast radius bounded. */
  chunkSize?: number;
  /** When true, plan and report but write nothing. */
  dryRun?: boolean;
}

export interface IngestJobResult {
  jobKey: string;
  status: 'succeeded' | 'failed' | 'rolled_back' | 'skipped_kill_switch' | 'skipped_backoff' | 'skipped_source_outage';
  batchId: string | null;
  detail: string;
  runnerVersion: string;
  counts: {
    sourceBytes: number;
    parsedAccepted: number;
    parsedRejected: number;
    resolved: number;
    unresolved: number;
    inserted: number;
    unchanged: number;
    superseded: number;
  };
  sourceSha256: string | null;
  alerts: Alert[];
}

const EMPTY_COUNTS = {
  sourceBytes: 0, parsedAccepted: 0, parsedRejected: 0, resolved: 0,
  unresolved: 0, inserted: 0, unchanged: 0, superseded: 0,
};

export async function runReferenceIngest(args: IngestJobArgs): Promise<IngestJobResult> {
  const db = createAdminClient();
  const nowIso = new Date().toISOString();
  const source = getReferenceSource(args.sourceConfigId);
  const chunkSize = args.chunkSize ?? 500;

  const base = { jobKey: args.jobKey, batchId: null as string | null, runnerVersion: PC6_RUNNER_VERSION, counts: { ...EMPTY_COUNTS }, sourceSha256: null as string | null, alerts: [] as Alert[] };

  // --- 1. Kill switch and backoff, BEFORE anything else --------------------
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

  // --- 2. Open the batch ledger row ----------------------------------------
  const url = buildUrl(args.sourceConfigId, { fromDate: args.fromDate, toDate: args.toDate });
  const { data: batch, error: batchErr } = await db
    .from('ii_reference_import_batches')
    .insert({
      source_key: source.sourceKey,
      source_config_id: args.sourceConfigId,
      batch_kind: source.kind,
      window_from: args.fromDate ?? null,
      window_to: args.toDate ?? null,
      as_of_date: args.asOfDate,
      source_url: url,
      status: 'running',
      attempt: (control?.consecutiveFailures ?? 0) + 1,
    })
    .select('id')
    .single();
  if (batchErr || !batch) {
    return { ...base, status: 'failed', detail: `Could not open a batch ledger row: ${batchErr?.message ?? 'unknown'}` };
  }
  const batchId = batch.id as string;

  const finish = async (
    status: IngestJobResult['status'],
    detail: string,
    counts: IngestJobResult['counts'],
    sha: string | null,
    alerts: Alert[],
    extra: Record<string, unknown> = {}
  ): Promise<IngestJobResult> => {
    await db.from('ii_reference_import_batches').update({
      status: status === 'skipped_backoff' ? 'failed' : status,
      finished_at: new Date().toISOString(),
      rows_read: counts.parsedAccepted + counts.parsedRejected,
      rows_accepted: counts.parsedAccepted,
      rows_rejected: counts.parsedRejected,
      rows_inserted: counts.inserted,
      rows_unchanged: counts.unchanged,
      rows_superseded: counts.superseded,
      source_sha256: sha,
      source_byte_length: counts.sourceBytes || null,
      ...extra,
    }).eq('id', batchId);

    // Job-control bookkeeping: success clears the failure streak, failure
    // extends the bounded backoff.
    if (status === 'succeeded') {
      await db.from('ii_reference_job_control').update({
        last_success_at: new Date().toISOString(),
        last_success_batch_id: batchId,
        consecutive_failures: 0,
        next_attempt_not_before: null,
        updated_at: new Date().toISOString(),
      }).eq('job_key', args.jobKey);
    } else {
      const failures = (control?.consecutiveFailures ?? 0) + 1;
      await db.from('ii_reference_job_control').update({
        last_failure_at: new Date().toISOString(),
        consecutive_failures: failures,
        next_attempt_not_before: nextAttemptAfter(new Date().toISOString(), failures),
        updated_at: new Date().toISOString(),
      }).eq('job_key', args.jobKey);
    }

    return { ...base, batchId, status, detail, counts, sourceSha256: sha, alerts };
  };

  // --- 3. Fetch, with outage classification --------------------------------
  const retrievedAt = new Date().toISOString();
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

  const fetched = classifyFetch(httpStatus, bytes, MIN_PLAUSIBLE_FULL_UNIVERSE_BYTES, retrievedAt, networkError);
  if (!fetched.ok) {
    const alerts = buildAlerts({ jobKey: args.jobKey, settlement: null, fetchOutcome: fetched, consecutiveFailures: control?.consecutiveFailures ?? 0, parsedAccepted: 0, parsedRejected: 0, unresolvedCount: 0 });
    return finish('skipped_source_outage', fetched.detail, { ...EMPTY_COUNTS }, null, alerts, {
      error_code: `SOURCE_${fetched.kind.toUpperCase()}`,
      error_detail: fetched.detail,
      source_retrieved_at: retrievedAt,
    });
  }

  // --- 4. Parse ------------------------------------------------------------
  let parsed: AmfiParseResult;
  try {
    parsed = source.format === 'amfi_navhistory_txt'
      ? parseNavHistory(fetched.bytes, { asOfDate: args.asOfDate, retrievedAt })
      : parseNavAll(fetched.bytes, { asOfDate: args.asOfDate, retrievedAt });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return finish('failed', `Parse failed: ${detail}`, { ...EMPTY_COUNTS, sourceBytes: fetched.bytes.byteLength }, null, [], {
      error_code: 'PARSE_FAILED', error_detail: detail, source_retrieved_at: retrievedAt,
    });
  }

  await db.from('ii_reference_import_batches').update({
    parser_version: parsed.parserVersion,
    source_retrieved_at: retrievedAt,
    source_sha256: parsed.fingerprint.sha256,
    source_byte_length: parsed.fingerprint.byteLength,
  }).eq('id', batchId);

  // Every rejection is persisted, not merely counted (N.4).
  if (parsed.rejections.length > 0) {
    const rows = parsed.rejections.slice(0, 5000).map((r) => ({
      batch_id: batchId, source_line: r.sourceLine, reason: r.reason, detail: r.detail, raw_excerpt: r.rawExcerpt,
    }));
    for (let i = 0; i < rows.length; i += chunkSize) {
      await db.from('ii_reference_import_rejections').insert(rows.slice(i, i + chunkSize));
    }
  }

  // --- 5. Resolve and plan --------------------------------------------------
  // fetchAllRows(): a plain, unbounded select silently caps at PostgREST's
  // db-max-rows (1000) -- the exact same defect class R4/R5 already found
  // and built this helper for. Found here the same way: the full AMFI
  // universe now has 14,358 resolvable instruments, and an unpaged select
  // only ever resolved the first ~1,000-2,000 of them, silently leaving
  // most of a genuinely-complete instrument universe unresolved.
  const idRows = await fetchAllRows<{ identifier_value: string; instrument_id: string }>(() =>
    db
      .from('ii_instrument_identifiers')
      .select('identifier_value, instrument_id')
      .eq('identifier_scheme', 'amfi_scheme_code')
      .eq('country_code', source.countryCode)
      .eq('is_active', true)
      .order('id')
  );
  const instRows = await fetchAllRows<{ id: string; isin: string | null }>(() =>
    db.from('ii_instruments').select('id, isin').eq('instrument_class', 'mutual_fund').not('isin', 'is', null).order('id')
  );

  const index: InstrumentResolutionIndex = {
    byAmfiCode: new Map(idRows.map((r) => [r.identifier_value, r.instrument_id])),
    byIsin: new Map(instRows.filter((r) => r.isin).map((r) => [r.isin as string, r.id])),
  };

  // Scheme identity (a dimension table) and NAV price (a time series) have
  // genuinely different write shapes -- dispatched separately here rather
  // than forced through the NAV-shaped plan/write path below, which this
  // source kind was never actually compatible with (see schemeMasterWriter.ts
  // header for the real incident this fixes).
  if (source.kind === 'scheme_master') {
    const schemeWrite = args.dryRun
      ? { counts: { resolved: 0, unresolved: 0, inserted: 0, unchanged: 0, superseded: 0 }, errors: [] }
      : await writeSchemeMasterRows(
          db,
          parsed.records,
          index,
          { countryCode: source.countryCode, currencyCode: source.currencyCode, sourceId: null, importBatchId: batchId, asOfDate: args.asOfDate },
          chunkSize
        );
    // A dry run still needs an honest resolved/unresolved count without
    // actually writing -- computed the same way writeSchemeMasterRows()
    // would resolve, just without the DB round trip for current rows.
    const dryResolved = args.dryRun
      ? [...new Set(parsed.records.map((r) => r.amfiSchemeCode))].filter((code) => {
          const r = parsed.records.find((x) => x.amfiSchemeCode === code)!;
          return index.byAmfiCode.has(code) || (r.isinGrowthOrPayout ? index.byIsin.has(r.isinGrowthOrPayout) : false);
        }).length
      : schemeWrite.counts.resolved;
    const schemeCounts: IngestJobResult['counts'] = {
      sourceBytes: parsed.fingerprint.byteLength,
      parsedAccepted: parsed.counts.accepted,
      parsedRejected: parsed.counts.rejected,
      resolved: dryResolved,
      unresolved: new Set(parsed.records.map((r) => r.amfiSchemeCode)).size - dryResolved,
      inserted: schemeWrite.counts.inserted,
      unchanged: schemeWrite.counts.unchanged,
      superseded: schemeWrite.counts.superseded,
    };
    if (args.dryRun) {
      return finish('succeeded', `Dry run: ${dryResolved} scheme(s) resolved to an existing instrument. Nothing written.`, schemeCounts, parsed.fingerprint.sha256, []);
    }
    if (schemeWrite.errors.length > 0) {
      return finish('failed', `Scheme-master write failed: ${schemeWrite.errors[0]}`, schemeCounts, parsed.fingerprint.sha256, [], { error_code: 'SCHEME_MASTER_WRITE_FAILED', error_detail: schemeWrite.errors.join('; ') });
    }
    return finish(
      'succeeded',
      `${schemeCounts.inserted} scheme-master row(s) written (${schemeCounts.superseded} superseding a prior identity), ${schemeCounts.unchanged} unchanged.`,
      schemeCounts,
      parsed.fingerprint.sha256,
      []
    );
  }

  // Existing state for exactly the instruments AND DATES this run could
  // touch, so idempotency is decided against the database rather than
  // assumed. Scoped to price_date (not just instrument_id): with the full
  // AMFI universe resolved and years of backfilled history per instrument,
  // an unscoped-by-date query here would need to fetch every historical row
  // for 200 instruments just to check "does today's row already exist" --
  // both needlessly expensive and, per fetchAllRows's own header, exactly
  // the silent-truncation risk it exists to remove. fetchAllRows() is kept
  // as defense in depth regardless (a NAV-history backfill window can still
  // span enough dates to exceed one page even after this narrowing).
  const candidateIds = [...new Set(parsed.records.map((r) => index.byAmfiCode.get(r.amfiSchemeCode) ?? (r.isinGrowthOrPayout ? index.byIsin.get(r.isinGrowthOrPayout) : undefined)).filter(Boolean) as string[])];
  const candidateDates = [...new Set(parsed.records.map((r) => r.navDate))];
  const existing = new Map<string, ExistingObservation>();
  const RESOLUTION_BATCH = 100; // 200 UUIDs in one .in() filter produced a request the network layer itself rejected ("fetch failed", not an HTTP error) against the full AMFI universe -- halved for headroom
  for (let i = 0; i < candidateIds.length; i += RESOLUTION_BATCH) {
    const idSlice = candidateIds.slice(i, i + RESOLUTION_BATCH);
    const rows = await fetchAllRows<{ instrument_id: string; price_date: string; price: number; record_checksum: string | null; quality_status: NavQualityStatus }>(() =>
      db
        .from('ii_prices_nav')
        .select('instrument_id, price_date, price, record_checksum, quality_status')
        .in('instrument_id', idSlice)
        .in('price_date', candidateDates)
        .order('instrument_id')
        .order('price_date')
    );
    for (const r of rows) {
      existing.set(`${r.instrument_id}|${r.price_date}`, {
        value: String(r.price),
        recordChecksum: r.record_checksum ?? '',
        quality_status: r.quality_status,
      });
    }
  }

  const plan = planImport({ parsed, index, existing, currencyCode: source.currencyCode });

  const counts: IngestJobResult['counts'] = {
    sourceBytes: parsed.fingerprint.byteLength,
    parsedAccepted: parsed.counts.accepted,
    parsedRejected: parsed.counts.rejected,
    resolved: plan.counts.resolved,
    unresolved: plan.counts.unresolved,
    inserted: 0,
    unchanged: plan.counts.unchanged,
    superseded: 0,
  };

  if (args.dryRun) {
    return finish('succeeded', `Dry run: ${plan.counts.toInsert} insert(s), ${plan.counts.unchanged} unchanged, ${plan.counts.toSupersede} correction(s) planned. Nothing written.`, counts, parsed.fingerprint.sha256, [], { notes: { dry_run: true, planned: plan.counts } });
  }

  // --- 6. Write, in bounded chunks -----------------------------------------
  const inserts = plan.writes.filter((w) => w.action === 'insert');
  const supersedes = plan.writes.filter((w) => w.action === 'supersede');
  const chunks: ChunkOutcome[] = [];

  for (let i = 0; i < inserts.length; i += chunkSize) {
    const slice = inserts.slice(i, i + chunkSize);
    // ignoreDuplicates: defense in depth alongside the existing-state check
    // above -- with the full AMFI universe resolved, a row this plan
    // believes is new but that in fact already exists (however that
    // divergence arises) now skips silently instead of failing the WHOLE
    // chunk and losing every other genuinely-new row alongside it. Never
    // masks a genuine correction: a row with DIFFERENT data for the same
    // (instrument, price_date) is planImport's 'supersede' action, a
    // completely separate code path below that this ignoreDuplicates never
    // touches.
    const { error } = await db.from('ii_prices_nav').upsert(
      slice.map((w) => ({
        instrument_id: w.instrumentId,
        currency_code: w.currencyCode,
        price_date: w.priceDate,
        price: w.price,
        source_timestamp: retrievedAt,
        data_version: `${parsed.parserVersion}:${parsed.fingerprint.sha256.slice(0, 12)}`,
        record_checksum: w.recordChecksum,
        import_batch_id: batchId,
        quality_status: 'ok',
      })),
      { onConflict: 'instrument_id,price_date', ignoreDuplicates: true }
    );
    chunks.push({ chunkIndex: chunks.length, attempted: slice.length, succeeded: error ? 0 : slice.length, error: error?.message ?? null });
    if (!error) counts.inserted += slice.length;
  }

  // Corrections: the prior row is marked superseded and the new value is
  // inserted alongside it. Never an in-place overwrite (D.3).
  for (const w of supersedes) {
    const { data: prior } = await db
      .from('ii_prices_nav')
      .select('id, price')
      .eq('instrument_id', w.instrumentId)
      .eq('price_date', w.priceDate)
      .maybeSingle();
    if (!prior) continue;
    const { data: fresh, error } = await db.from('ii_prices_nav').insert({
      instrument_id: w.instrumentId,
      currency_code: w.currencyCode,
      price_date: w.priceDate,
      price: w.price,
      source_timestamp: retrievedAt,
      data_version: `${parsed.parserVersion}:${parsed.fingerprint.sha256.slice(0, 12)}`,
      record_checksum: w.recordChecksum,
      import_batch_id: batchId,
      quality_status: 'ok',
      correction_of_id: prior.id,
    }).select('id').single();
    if (error || !fresh) {
      chunks.push({ chunkIndex: chunks.length, attempted: 1, succeeded: 0, error: error?.message ?? 'correction insert failed' });
      continue;
    }
    await db.from('ii_prices_nav').update({ quality_status: 'superseded', superseded_by_id: fresh.id }).eq('id', prior.id);
    await db.from('ii_reference_corrections').insert({
      target_table: 'ii_prices_nav',
      target_row_id: prior.id,
      correction_kind: 'source_correction',
      previous_value: { price: prior.price },
      new_value: { price: w.price },
      actor_kind: 'system_import',
      reason: `Source ${source.sourceKey} republished a different NAV for ${w.priceDate}; the prior row is retained and marked superseded.`,
      batch_id: batchId,
    });
    counts.superseded += 1;
    chunks.push({ chunkIndex: chunks.length, attempted: 1, succeeded: 1, error: null });
  }

  // --- 7. Settle -----------------------------------------------------------
  const settlement = settleBatch(chunks.length ? chunks : [{ chunkIndex: 0, attempted: 0, succeeded: 0, error: null }], 'commit_chunks');
  const alerts = buildAlerts({
    jobKey: args.jobKey,
    settlement,
    fetchOutcome: fetched,
    consecutiveFailures: control?.consecutiveFailures ?? 0,
    parsedAccepted: counts.parsedAccepted,
    parsedRejected: counts.parsedRejected,
    unresolvedCount: counts.unresolved,
  });

  return finish(
    settlement.status,
    settlement.detail,
    counts,
    parsed.fingerprint.sha256,
    alerts,
    settlement.status === 'succeeded' ? {} : { error_code: settlement.partial ? 'PARTIAL_BATCH' : 'BATCH_FAILED', error_detail: settlement.detail }
  );
}
