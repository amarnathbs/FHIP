// READ-TIME lookup of "declared records the data we hold cannot represent" for a set of instruments (see
// declaredRecordStatus.ts for the rule and why). READ ONLY: one SECURITY DEFINER read function (migration 0252),
// public fund facts only, no user data.
//
// FAIL CLOSED: if the lookup fails for any reason other than "migration 0252 is not applied yet", the caller must
// show "no benchmark comparison" for the affected funds rather than guess they have no declared record (a guess
// could put a category index against a fund whose own documents say it does not follow that index).
import type { SupabaseClient } from '@supabase/supabase-js';
import { declaredRecordsFromRpc, isDeclaredRecordsUnavailable, type DeclaredRecord } from './declaredRecordStatus';

const CHUNK = 400;

export type DeclaredRecordLookup = { ok: true; records: Map<string, DeclaredRecord> } | { ok: false };

export async function loadDeclaredRecords(supabase: SupabaseClient, instrumentIds: readonly string[]): Promise<DeclaredRecordLookup> {
  const records = new Map<string, DeclaredRecord>();
  const ids = [...new Set(instrumentIds)];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await supabase.rpc('declared_benchmark_records_for', { p_instrument_ids: ids.slice(i, i + CHUNK) });
    if (error) {
      if (isDeclaredRecordsUnavailable(error)) return { ok: true, records: new Map() }; // 0252 not applied: nothing is declared
      return { ok: false };
    }
    for (const [k, v] of declaredRecordsFromRpc(data)) records.set(k, v);
  }
  return { ok: true, records };
}
