// NAV 1 D.11 -- NON-DESTRUCTIVE source-fidelity check (2026-09-25).
//
// Question: if these instruments' pre-changeover history were deleted, would
// selective hydration get back EXACTLY what is on file? Runs the production
// hydration fetch path -- the same 730-day chunking and the same
// FallbackHistoricalAdapter(AMFI -> TIGZIG) -- over each instrument's whole
// stored pre-changeover range, WITHOUT writing anything, and compares every
// date and value with the rows on file.
//
// Database access is GET-only (host asserted); the fund-house resolver reads
// scheme-master reference data from DEV (identical AMFI codes/fund houses).
// AMFI is called sequentially by the adapter, with a pause between chunks.
//
// Usage: npx tsx --env-file=D:/FHIP/.env.local scripts/nav1_d11_source_fidelity_check.ts <prod|dev> <outFile> <instrumentId>...

import fs from 'node:fs';
import { chunkDateWindow, MAX_FETCH_WINDOW_DAYS } from '@/lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJob';
import { createLiveFundHouseResolver } from '@/lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJobLive';
import { AmfiHistoricalAdapter } from '@/lib/services/investment-intelligence/pc6/adapters/amfiHistoricalAdapter';
import { TigzigHistoricalAdapter } from '@/lib/services/investment-intelligence/pc6/adapters/tigzigHistoricalAdapter';
import { FallbackHistoricalAdapter } from '@/lib/services/investment-intelligence/pc6/adapters/fallbackHistoricalAdapter';

const TARGETS: Record<string, { host: string; urlKey: string; keyKey: string }> = {
  prod: { host: 'twwpnltizhtjxhamyoxt.supabase.co', urlKey: 'PRODUCTION_SUPABASE_URL', keyKey: 'PRODUCTION_SUPABASE_SERVICE_ROLE_KEY' },
  dev: { host: 'vqycarelcoijzwlpkpcz.supabase.co', urlKey: 'NEXT_PUBLIC_SUPABASE_URL', keyKey: 'SUPABASE_SERVICE_ROLE_KEY' },
};
const [which, outFile, ...instrumentIds] = process.argv.slice(2);
const T = TARGETS[which];
if (!T || !outFile || instrumentIds.length === 0) { console.error('usage: <prod|dev> <outFile> <instrumentId>...'); process.exit(2); }
const BASE = process.env[T.urlKey]!, KEY = process.env[T.keyKey]!;
const C = '2026-09-21';
async function get<R>(q: string): Promise<R> {
  if (new URL(BASE).host !== T.host) throw new Error('HOST ASSERTION FAILED');
  const r = await fetch(`${BASE}/rest/v1/${q}`, { method: 'GET', headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (r.status >= 400) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json() as Promise<R>;
}
async function pageAll<R>(q: string, order: string): Promise<R[]> {
  const out: R[] = [];
  for (let o = 0; ; o += 1000) { const b = await get<R[]>(`${q}&order=${order}&limit=1000&offset=${o}`); out.push(...b); if (b.length < 1000) return out; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const adapter = new FallbackHistoricalAdapter(new AmfiHistoricalAdapter({ resolveFundHouse: createLiveFundHouseResolver() }), new TigzigHistoricalAdapter());
  const results: unknown[] = [];
  for (const id of instrumentIds) {
    const rows = await pageAll<{ id: string; price_date: string; price: number }>(`ii_prices_nav?select=id,price_date,price&instrument_id=eq.${id}&price_date=lt.${C}`, 'id');
    const onFile = new Map(rows.map((r) => [r.price_date, Number(r.price)]));
    const dates = [...onFile.keys()].sort();
    const code = (await get<{ identifier_value: string }[]>(`ii_instrument_identifiers?select=identifier_value&instrument_id=eq.${id}&identifier_scheme=eq.amfi_scheme_code&is_active=eq.true`))[0]?.identifier_value;
    const sm = code ? (await get<{ scheme_name: string; lifecycle_status: string; closure_date: string | null }[]>(`ii_scheme_master?select=scheme_name,lifecycle_status,closure_date&amfi_scheme_code=eq.${code}&limit=1`))[0] : undefined;
    const r: Record<string, unknown> = { instrument_id: id, amfi_code: code ?? null, scheme: sm?.scheme_name ?? null, lifecycle: sm?.lifecycle_status ?? null, rows_on_file: rows.length, from: dates[0], to: dates.at(-1) };
    if (!code || dates.length === 0) { r.result = 'SKIPPED: no AMFI code or no rows'; results.push(r); continue; }
    const chunks = chunkDateWindow(dates[0], dates.at(-1)!, MAX_FETCH_WINDOW_DAYS);
    const fetched = new Map<string, number>();
    const providers: Record<string, number> = {};
    const failures: string[] = [];
    for (const ch of chunks) {
      const res = await adapter.fetchHistory({ schemeIdentifier: code, fromDate: ch.fromDate, toDate: ch.toDate });
      await sleep(1000);
      if (!res.ok) { failures.push(`[${ch.fromDate}, ${ch.toDate}] ${res.kind}: ${res.detail.slice(0, 160)}`); continue; }
      providers[res.provider.key] = (providers[res.provider.key] ?? 0) + res.observations.length;
      for (const o of res.observations) fetched.set(o.date, Number(o.nav));
    }
    let exact = 0; const mismatches: unknown[] = []; const notReturned: string[] = [];
    for (const [d, v] of onFile) {
      if (!fetched.has(d)) { notReturned.push(d); continue; }
      if (fetched.get(d) === v) exact++; else mismatches.push({ date: d, on_file: v, source: fetched.get(d) });
    }
    const extra = [...fetched.keys()].filter((d) => d >= dates[0] && d <= dates.at(-1)! && !onFile.has(d));
    Object.assign(r, {
      chunks: chunks.length, providers, chunk_failures: failures,
      exact_matches: exact, mismatches: mismatches.length, mismatch_sample: mismatches.slice(0, 5),
      on_file_not_returned_by_source: notReturned.length, not_returned_sample: notReturned.slice(0, 5),
      returned_not_on_file: extra.length, extra_sample: extra.slice(0, 5),
      fully_recoverable_by_source: exact === rows.length && failures.length === 0,
    });
    console.log(JSON.stringify(r));
    results.push(r);
  }
  fs.writeFileSync(outFile, JSON.stringify({ environment: T.host, at: new Date().toISOString(), results }, null, 1));
}
main().catch((e) => { console.error('FAILED', e instanceof Error ? e.message : e); process.exit(1); });
