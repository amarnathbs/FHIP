// Market-index CSV upload: PREVIEW then COMMIT, stateless.
//
// preview  = parse + validate + compare with what is already published; writes
//            nothing at all.
// commit   = re-runs the SAME analysis server-side on the SAME file text (the
//            client re-submits it; the file hash must match the previewed one)
//            and then makes a single call to the database function
//            commit_market_index_upload(), which re-checks the capability,
//            the attestation and every row inside one transaction.
//
// Nothing is trusted from the client except the file text itself and the
// operator's explicit choices (index, attestation, include-weekend, skip-
// conflicts). IDEMPOTENT: re-uploading an identical file is a no-op, both
// here (every row is "identical") and in the database (same index + file hash).
//
// This module never decides WHO may upload — that is the capability guard in
// marketIndexAdmin.ts (API/page) and the database function itself.
import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from '@/lib/services/investment-intelligence/pagination';
import { MARKET_INDEX_KEYS, type MarketIndexKey } from '@/lib/config/investment-intelligence/marketIndexConfig';
import { INDEX_CSV_MAX_BYTES, parseIndexCsv, type IndexCsvAnalysis, type IndexCsvRow } from './indexCsvParser';

export const UPLOAD_SERVICE_VERSION = 'market-index-upload-v1';

/** The exact statement the operator attests to. Stored verbatim in the append-only ledger. */
export const ATTESTATION_TEXT =
  'I confirm that I hold the right to use this index data in FHIP and to store it in the FHIP database for display, and that uploading it does not breach the terms of the exchange or index provider it came from.';

export interface ExistingConflict {
  date: string;
  existing: number;
  incoming: number;
}

export interface UploadPlan {
  version: typeof UPLOAD_SERVICE_VERSION;
  indexKey: MarketIndexKey;
  fileSha256: string;
  fileBytes: number;
  analysis: IndexCsvAnalysis;
  /** Rows that would be written (new dates only). */
  newRows: IndexCsvRow[];
  identicalExisting: number;
  conflicts: ExistingConflict[];
  /** Why a commit cannot proceed right now (empty = it can, subject to the attestation). */
  blockers: string[];
  /** Advisory notes (weekend rows held back, large moves, boundary jumps). */
  warnings: string[];
  includeWeekendRows: boolean;
  skipConflicts: boolean;
}

export function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface PlanInput {
  indexKey: MarketIndexKey;
  csvText: string;
  todayIso: string;
  includeWeekendRows?: boolean;
  skipConflicts?: boolean;
}

/** Reads what is already published for the incoming date range (read-only; the series is world-readable reference data). */
async function loadExisting(reader: SupabaseClient, indexKey: MarketIndexKey, from: string, to: string): Promise<Map<string, number>> {
  const { data: bench, error } = await reader.from('ii_benchmarks').select('id').eq('benchmark_key', indexKey).maybeSingle();
  if (error) throw new Error(`ii_benchmarks: ${error.message}`);
  if (!bench) throw new Error('The market-index benchmark rows do not exist yet: migration 0232 has not been applied to this database.');
  const rows = await fetchAllRows<{ series_date: string; value: number | string }>(() =>
    reader
      .from('ii_benchmark_series')
      .select('series_date, value')
      .eq('benchmark_id', (bench as { id: string }).id)
      .gte('series_date', from)
      .lte('series_date', to)
      .neq('quality_status', 'superseded')
      .order('series_date', { ascending: true })
  );
  return new Map(rows.map((r) => [r.series_date, Number(r.value)]));
}

export async function planIndexUpload(reader: SupabaseClient, input: PlanInput): Promise<UploadPlan> {
  const includeWeekendRows = input.includeWeekendRows === true;
  const skipConflicts = input.skipConflicts === true;
  const bytes = Buffer.byteLength(input.csvText, 'utf8');
  const fileSha256 = sha256Hex(input.csvText);
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (bytes > INDEX_CSV_MAX_BYTES) {
    blockers.push(`The file is ${(bytes / 1024 / 1024).toFixed(1)} MB; the limit is ${INDEX_CSV_MAX_BYTES / 1024 / 1024} MB.`);
    const empty = parseIndexCsv('', input.indexKey, input.todayIso);
    return { version: UPLOAD_SERVICE_VERSION, indexKey: input.indexKey, fileSha256, fileBytes: bytes, analysis: empty, newRows: [], identicalExisting: 0, conflicts: [], blockers, warnings, includeWeekendRows, skipConflicts };
  }

  const analysis = parseIndexCsv(input.csvText, input.indexKey, input.todayIso);
  if (analysis.fileRejected) blockers.push(analysis.fileRejectionReason ?? 'The file could not be used.');

  const candidates: IndexCsvRow[] = [...analysis.accepted, ...(includeWeekendRows ? analysis.weekendHeldBack : [])].sort((a, b) => (a.date < b.date ? -1 : 1));
  if (analysis.weekendHeldBack.length > 0) {
    warnings.push(
      includeWeekendRows
        ? `${analysis.weekendHeldBack.length} Saturday/Sunday row(s) are included at your request (special sessions such as the Budget or Muhurat session do occur).`
        : `${analysis.weekendHeldBack.length} Saturday/Sunday row(s) are held back and will NOT be written. Tick "include weekend rows" only if these are genuine special sessions.`
    );
  }
  if (analysis.largeMoves.length > 0) warnings.push(`${analysis.largeMoves.length} day-over-day move(s) above 10% are included; please check them in the list below.`);
  if (analysis.rejected.length > 0) warnings.push(`${analysis.rejected.length} row(s) were rejected and will not be written (see the reasons below).`);
  if (analysis.otherIndexRowsIgnored > 0) warnings.push(`${analysis.otherIndexRowsIgnored} row(s) for other indices in the file were ignored.`);

  let newRows: IndexCsvRow[] = [];
  let identicalExisting = 0;
  const conflicts: ExistingConflict[] = [];
  if (candidates.length > 0) {
    let existing: Map<string, number>;
    try {
      existing = await loadExisting(reader, input.indexKey, candidates[0].date, candidates[candidates.length - 1].date);
    } catch (e) {
      blockers.push(e instanceof Error ? e.message : 'Existing values could not be read.');
      return { version: UPLOAD_SERVICE_VERSION, indexKey: input.indexKey, fileSha256, fileBytes: bytes, analysis, newRows: [], identicalExisting: 0, conflicts: [], blockers, warnings, includeWeekendRows, skipConflicts };
    }
    for (const row of candidates) {
      const have = existing.get(row.date);
      if (have === undefined) newRows.push(row);
      else if (Math.abs(have - row.close) <= 1e-6) identicalExisting += 1;
      else conflicts.push({ date: row.date, existing: have, incoming: row.close });
    }
  }
  if (conflicts.length > 0) {
    if (skipConflicts) {
      warnings.push(`${conflicts.length} date(s) already hold a different published value; they are skipped and the existing values are kept. This upload never changes a published value.`);
    } else {
      blockers.push(`${conflicts.length} date(s) already hold a different published value. This upload never changes a published value: tick "skip conflicting dates" to write only the other rows, or correct the file.`);
    }
  }
  if (candidates.length > 0 && newRows.length === 0 && conflicts.length === 0) warnings.push('Every row in the file is already published with the same value: committing is a no-op.');
  if (candidates.length === 0 && !analysis.fileRejected) blockers.push('There is nothing to commit.');
  newRows = newRows.filter((r) => !conflicts.some((c) => c.date === r.date));

  return { version: UPLOAD_SERVICE_VERSION, indexKey: input.indexKey, fileSha256, fileBytes: bytes, analysis, newRows, identicalExisting, conflicts, blockers, warnings, includeWeekendRows, skipConflicts };
}

export type CommitOutcome =
  | { status: 'committed'; batchId: string; inserted: number; identical: number }
  | { status: 'already_committed'; batchId: string; inserted: number; identical: number }
  | { status: 'noop'; identical: number }
  | { status: 'refused'; blockers: string[] };

export interface CommitInput extends PlanInput {
  fileName: string;
  attested: boolean;
  attestationText: string;
  /** The hash the operator saw in the preview. When supplied it must equal the hash of the text being committed. */
  expectedSha256?: string;
}

/**
 * `userClient` MUST be the caller's own session client (never the service-role
 * client): the database function authorises with auth.uid() and refuses a
 * caller without the capability.
 */
export async function commitIndexUpload(userClient: SupabaseClient, input: CommitInput): Promise<CommitOutcome> {
  if (input.attested !== true || input.attestationText.trim() !== ATTESTATION_TEXT) {
    return { status: 'refused', blockers: ['The attestation that you hold the right to use this data is required, and must be the exact statement shown.'] };
  }
  const plan = await planIndexUpload(userClient, input);
  if (input.expectedSha256 && input.expectedSha256 !== plan.fileSha256) {
    return { status: 'refused', blockers: ['The file changed between the preview and the commit. Preview it again.'] };
  }
  if (plan.blockers.length > 0) return { status: 'refused', blockers: plan.blockers };
  if (plan.newRows.length === 0) return { status: 'noop', identical: plan.identicalExisting };

  const { data, error } = await userClient.rpc('commit_market_index_upload', {
    p_benchmark_key: input.indexKey,
    p_file_sha256: plan.fileSha256,
    p_file_name: input.fileName,
    p_rows: plan.newRows.map((r) => ({ date: r.date, close: r.close })),
    p_attested: true,
    p_attestation_text: ATTESTATION_TEXT,
  });
  if (error) throw error;
  const out = data as { already_committed: boolean; batch_id: string; inserted: number; identical: number };
  return out.already_committed
    ? { status: 'already_committed', batchId: out.batch_id, inserted: out.inserted, identical: out.identical }
    : { status: 'committed', batchId: out.batch_id, inserted: out.inserted, identical: out.identical };
}

export { MARKET_INDEX_KEYS };
