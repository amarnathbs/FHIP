// Planning Benchmarks upload preview: the currency and unit of every figure the preview shows, so the screen can format
// each figure by its OWN currency (figureFormat.ts) instead of one locale for all.
//
// The database function get_planning_benchmark_upload (migration 0275, applied on DEV and immutable) returns the unit of an
// observed value but not its currency, and no unit at all for a band. Rather than re-emit that long function, this reads
// the same facts with the caller's own session (the staged rows and the live reference tables are readable by a viewer
// under the existing row level security) and adds them to the reply:
//   rows[].currency        original_currency of the staged value
//   rows[].live_currency   original_currency of the live value it replaces
//   rows[].metric_unit     the metric's unit, for a band (bands carry the country, not a currency)
//   removed[].metric_unit  the same for a band that would be taken out of service
// It never throws: if a read fails the reply is returned unchanged and the screen says "currency not stated" next to a
// currency figure it cannot place, which is the safe fallback.
import type { SupabaseClient } from '@supabase/supabase-js';

type Json = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export async function addFigureContext(supabase: SupabaseClient, reply: Json): Promise<Json> {
  try {
    const batch = reply.batch as Json | undefined;
    const kind = batch?.kind;
    const batchId = str(batch?.id);
    const rows = Array.isArray(reply.rows) ? (reply.rows as Json[]) : [];
    const removed = Array.isArray(reply.removed) ? (reply.removed as Json[]) : [];
    if (!batchId || (kind !== 'values' && kind !== 'target_ranges')) return reply;

    if (kind === 'values') {
      const { data: staged, error } = await supabase.from('benchmark_upload_rows').select('row_no, payload, live_ids').eq('batch_id', batchId).order('row_no').limit(1000);
      if (error || !Array.isArray(staged)) return reply;
      const liveIds = new Set<string>();
      for (const s of staged as Json[]) {
        const first = Array.isArray(s.live_ids) ? str((s.live_ids as unknown[])[0]) : null;
        if (first) liveIds.add(first);
      }
      const liveCurrency = new Map<string, string | null>();
      if (liveIds.size > 0) {
        const { data: live } = await supabase.from('benchmark_values').select('id, original_currency').in('id', [...liveIds]);
        if (Array.isArray(live)) for (const l of live as Json[]) liveCurrency.set(String(l.id), str(l.original_currency));
      }
      const byRow = new Map<number, Json>();
      for (const s of staged as Json[]) byRow.set(Number(s.row_no), s);
      return {
        ...reply,
        rows: rows.map((r) => {
          const s = byRow.get(Number(r.row_no));
          if (!s) return r;
          const payload = (s.payload ?? {}) as Json;
          const first = Array.isArray(s.live_ids) ? str((s.live_ids as unknown[])[0]) : null;
          return { ...r, currency: str(payload.original_currency), live_currency: first ? (liveCurrency.get(first) ?? null) : null };
        }),
      };
    }

    // target ranges: the unit comes from the metric
    const codes = [...new Set([...rows, ...removed].map((r) => str(r.metric_code)).filter((c): c is string => c !== null))];
    if (codes.length === 0) return reply;
    const { data: defs, error } = await supabase.from('benchmark_metric_definitions').select('metric_code, unit').in('metric_code', codes);
    if (error || !Array.isArray(defs)) return reply;
    const unit = new Map((defs as Json[]).map((d) => [String(d.metric_code), str(d.unit)]));
    const withUnit = (r: Json): Json => ({ ...r, metric_unit: unit.get(String(r.metric_code)) ?? null });
    return { ...reply, rows: rows.map(withUnit), removed: removed.map(withUnit) };
  } catch {
    return reply;
  }
}
