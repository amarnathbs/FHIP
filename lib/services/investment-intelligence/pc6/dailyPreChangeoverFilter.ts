// PC6 / NAV 1 -- the daily NAVAll job owns POST-changeover data only.
//
// THE DEFECT THIS CLOSES (found 2026-10-01 after the Stage E cleanup).
// Under the NAV 1 retention policy (navRetentionPolicy.ts) the daily job
// owns data dated on/after the changeover date C; pre-C history belongs to
// the selective hydration job and only for instruments with a real
// dependency (held, benchmarked, ...). NAVAll.txt, however, carries ONE row
// per scheme -- its LATEST NAV -- and a dormant / wound-up scheme keeps a
// years-old final NAV there (dates back to 2014). The daily job wrote every
// parsed record with no date test, so each dormant scheme's single stale row
// was re-inserted whenever it was missing. After Stage E deleted ~22.3M
// orphaned rows, 1,276 such rows (1,270 dated before 2026-09-01, 6 dated
// 2026-09-01..09-20) were re-created on 2026-09-30 and fail the live
// deletion predicate pc6_nav_row_is_candidate(). Deleting them without
// fixing the writer is futile: the next daily run re-creates them.
//
// THE FIX. For the daily NAVAll NAV path ONLY, a record that would be
// written and is dated before C is skipped -- unless its instrument is
// protected by the SAME rules the deletion predicate uses (user-held in any
// user-scoped table, benchmark-mapped, report-NAV-dependent, under an open
// retention hold, or a member of the merge family of one of those). A
// protected instrument's pre-C row is kept because retention would keep it:
// for a held instrument hydration also fetches it, but a benchmark-only
// instrument is hydrated only over a bounded lookback
// (BENCHMARK_LOOKBACK_DAYS), so a dormant benchmarked scheme's final NAV can
// lie outside anything hydration would ever refetch.
//
// FAIL OPEN. If the policy row is absent (DEV, tests, a fresh environment),
// unreadable, or malformed, or if any protection read fails, NO record is
// skipped and the job behaves exactly as before. A missing policy must never
// block daily ingestion, and an unreadable protection set must never cause a
// protected row to be skipped.
//
// NOT touched: the amfi_navhistory_txt path (selective/historical backfill),
// the scheme_master path (NAVAll.txt read as scheme identity, not prices),
// and unresolved records (they never write; skipping them would hide a real
// instrument-master mapping gap from the unresolved count and its alert).

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AmfiSchemeNavRecord } from './amfiParser';
import { resolveScheme, type InstrumentResolutionIndex } from './referenceImportRunner';
import { fetchAllRows } from '../pagination';

/** Merge-family traversal bound; identical to pc6_nav_row_is_candidate (migration 0200). */
export const MERGE_FAMILY_MAX_DEPTH = 8;

export interface PreChangeoverFilterContext {
  /** ISO yyyy-mm-dd, from the active ii_nav_retention_policy row. */
  changeoverDate: string;
  policyVersion: string | null;
  /** Instruments whose pre-C rows retention would keep. */
  protectedInstrumentIds: ReadonlySet<string>;
}

export type PreChangeoverContextLoad =
  | { ok: true; context: PreChangeoverFilterContext }
  | { ok: false; reason: 'no_policy' | 'invalid_policy' | 'policy_read_failed' | 'protection_read_failed'; detail: string };

/** Only the daily NAVAll NAV-price path is subject to the filter. */
export function appliesToSource(source: { kind: string; format: string }): boolean {
  return source.kind === 'daily_nav' && source.format === 'amfi_navall_txt';
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Expand a protected set across scheme-merger links (both directions,
 * transitively, to MERGE_FAMILY_MAX_DEPTH) -- the same family pc6_nav_row_is_candidate
 * follows. Pure.
 */
export function expandMergeFamily(seed: ReadonlySet<string>, links: ReadonlyArray<readonly [string, string]>): Set<string> {
  const adj = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  };
  for (const [a, b] of links) {
    if (!a || !b) continue;
    add(a, b);
    add(b, a);
  }
  const out = new Set(seed);
  let frontier = [...seed];
  for (let depth = 0; depth < MERGE_FAMILY_MAX_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const other of adj.get(id) ?? []) {
        if (!out.has(other)) {
          out.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * Read the active policy's changeover date and the protected-instrument set.
 * Never throws: every failure is returned as { ok: false } and the caller
 * FAILS OPEN (no filtering).
 */
export async function loadPreChangeoverFilterContext(db: SupabaseClient, nowMs: number = Date.now()): Promise<PreChangeoverContextLoad> {
  // --- the policy row (one per environment; each environment is its own database) ---
  let changeoverDate: string;
  let policyVersion: string | null;
  try {
    const { data, error } = await db
      .from('ii_nav_retention_policy')
      .select('policy_version, changeover_date')
      .order('activated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return { ok: false, reason: 'policy_read_failed', detail: error.message };
    if (!data) return { ok: false, reason: 'no_policy', detail: 'No ii_nav_retention_policy row: changeover date unknown, no record skipped.' };
    const cd = (data as { changeover_date: unknown }).changeover_date;
    if (typeof cd !== 'string' || !ISO_DATE.test(cd)) {
      return { ok: false, reason: 'invalid_policy', detail: `ii_nav_retention_policy.changeover_date is not an ISO date (${String(cd)}): no record skipped.` };
    }
    changeoverDate = cd;
    policyVersion = ((data as { policy_version?: unknown }).policy_version as string | undefined) ?? null;
  } catch (e) {
    return { ok: false, reason: 'policy_read_failed', detail: e instanceof Error ? e.message : String(e) };
  }

  // --- the protected set: the same terms as pc6_nav_row_is_candidate (0200) ---
  try {
    type IdRow = { instrument_id: string };
    const [held, benchmarked, reportDeps, holds, instrumentMerges, schemeMerges] = await Promise.all([
      // The one shared definition of "held by a user" (0189) -- paged and
      // ordered by the function's unique output column, as in hydration.
      fetchAllRows<IdRow>(() => ({
        range: (from, to) =>
          db.rpc('pc6_user_held_instrument_ids')
            .select('instrument_id')
            .order('instrument_id')
            .range(from, to)
            .then(({ data, error }) => ({ data: data as IdRow[] | null, error })),
      })),
      fetchAllRows<IdRow & { id: string }>(() => db.from('ii_instrument_benchmarks').select('id, instrument_id').order('id')),
      fetchAllRows<IdRow & { id: string }>(() => db.from('ii_report_nav_dependencies').select('id, instrument_id').order('id')),
      fetchAllRows<IdRow & { id: string; expires_at: string | null }>(() =>
        db.from('ii_nav_retention_holds').select('id, instrument_id, expires_at').is('released_at', null).order('id')
      ),
      fetchAllRows<{ id: string; merged_into_instrument_id: string }>(() =>
        db.from('ii_instruments').select('id, merged_into_instrument_id').not('merged_into_instrument_id', 'is', null).order('id')
      ),
      fetchAllRows<{ id: string; instrument_id: string; merged_into_instrument_id: string }>(() =>
        db.from('ii_scheme_master').select('id, instrument_id, merged_into_instrument_id').not('merged_into_instrument_id', 'is', null).order('id')
      ),
    ]);

    const seed = new Set<string>();
    for (const r of held) seed.add(r.instrument_id);
    for (const r of benchmarked) seed.add(r.instrument_id);
    for (const r of reportDeps) seed.add(r.instrument_id);
    // An open hold is unexpired when expires_at is null or in the future.
    for (const r of holds) if (r.expires_at === null || Date.parse(r.expires_at) > nowMs) seed.add(r.instrument_id);

    const links: Array<readonly [string, string]> = [
      ...instrumentMerges.map((r) => [r.id, r.merged_into_instrument_id] as const),
      ...schemeMerges.map((r) => [r.instrument_id, r.merged_into_instrument_id] as const),
    ];
    return { ok: true, context: { changeoverDate, policyVersion, protectedInstrumentIds: expandMergeFamily(seed, links) } };
  } catch (e) {
    return { ok: false, reason: 'protection_read_failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

export interface PreChangeoverPartition {
  /** Records to plan and write: everything except the skipped ones, original order kept. */
  records: AmfiSchemeNavRecord[];
  /** Resolved, unprotected records dated before C that were NOT planned. */
  skipped: number;
  /** Pre-C records kept because their instrument is protected. */
  keptProtected: number;
  /** Pre-C records kept because they do not resolve (they never write; the unresolved count stays truthful). */
  keptUnresolved: number;
}

/** Pure: split the parsed records by the daily job's ownership rule. */
export function partitionPreChangeover(
  records: readonly AmfiSchemeNavRecord[],
  index: InstrumentResolutionIndex,
  ctx: PreChangeoverFilterContext
): PreChangeoverPartition {
  const kept: AmfiSchemeNavRecord[] = [];
  let skipped = 0;
  let keptProtected = 0;
  let keptUnresolved = 0;
  for (const r of records) {
    if (!(r.navDate < ctx.changeoverDate)) { // ISO dates compare lexicographically == chronologically
      kept.push(r);
      continue;
    }
    const res = resolveScheme(r, index);
    if (res.state === 'unresolved') {
      keptUnresolved++;
      kept.push(r);
    } else if (ctx.protectedInstrumentIds.has(res.instrumentId)) {
      keptProtected++;
      kept.push(r);
    } else {
      skipped++;
    }
  }
  return { records: kept, skipped, keptProtected, keptUnresolved };
}
