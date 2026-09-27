// NAV 1 -- PO decision #6(d) / #5.5 (2026-09-27): "a controlled restoration
// attempt from AMFI or an approved provenance-tracked source is possible."
//
// Given one instrument and a date range (typically an open
// ii_nav_source_coverage_gaps row, or an ii_report_nav_dependency_alerts
// row), replays the SAME approved fetch path every other NAV1 hydration
// script uses -- AMFI primary, TIGZIG fallback (FallbackHistoricalAdapter)
// -- over that exact range, WITHOUT inventing any new source (per PO
// decision #5.5's own rule: "do not invent a new unapproved source"). It
// NEVER recalculates or edits any report; it only ever attempts to restore
// missing NAV rows to ii_prices_nav.
//
// DEFAULT: --dry-run (no writes anywhere). --apply performs the real
// upsert (ignoreDuplicates -- an existing value is never overwritten by
// this script; see selectiveHistoricalHydrationJobLive.ts's writeRows,
// reused here unchanged) and, only if the ENTIRE requested range is now
// fully covered, marks the matching ii_nav_source_coverage_gaps row
// resolved with a real evidence trail -- never guessed, never partial.
//
// SAFETY, hard-coded and not overridable by a flag: --apply refuses to run
// against anything other than the `dev` target. Applying a restoration to
// PRODUCTION is an operator action for the PO to run once this script has
// been reviewed -- this dispatch's own constraints are production
// READ-ONLY and no production writes of any kind.
//
// Usage:
//   npx tsx --env-file=D:/FHIP/.env.local scripts/nav1_report_dependency_restoration_attempt.ts <prod|dev> <instrumentId> <fromDate> <toDate> [--apply]
//
// Example (the confirmed HSBC Short Term Fund gap, dry run against
// production -- exactly what this dispatch ran for real on 2026-09-27):
//   npx tsx --env-file=D:/FHIP/.env.local scripts/nav1_report_dependency_restoration_attempt.ts prod 003c7324-14e7-47a2-b842-64aeb9cdcbc1 2013-01-28 2022-09-19

import { chunkDateWindow, MAX_FETCH_WINDOW_DAYS } from '@/lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJob';
import { createLiveHydrationDeps, normaliseFundHouseName } from '@/lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJobLive';
import { AmfiHistoricalAdapter, type FundHouseResolver } from '@/lib/services/investment-intelligence/pc6/adapters/amfiHistoricalAdapter';
import { TigzigHistoricalAdapter } from '@/lib/services/investment-intelligence/pc6/adapters/tigzigHistoricalAdapter';
import { FallbackHistoricalAdapter } from '@/lib/services/investment-intelligence/pc6/adapters/fallbackHistoricalAdapter';
import { createAdminClient } from '@/lib/supabase/admin';

const TARGETS: Record<string, { host: string; urlKey: string; keyKey: string }> = {
  prod: { host: 'twwpnltizhtjxhamyoxt.supabase.co', urlKey: 'PRODUCTION_SUPABASE_URL', keyKey: 'PRODUCTION_SUPABASE_SERVICE_ROLE_KEY' },
  dev: { host: 'vqycarelcoijzwlpkpcz.supabase.co', urlKey: 'NEXT_PUBLIC_SUPABASE_URL', keyKey: 'SUPABASE_SERVICE_ROLE_KEY' },
};

/**
 * A target-parameterized, GET-only REST client. `createAdminClient()`
 * (lib/supabase/admin.ts) ALWAYS reads NEXT_PUBLIC_SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY -- i.e. it can only ever reach DEV, regardless
 * of which target this script was asked to run against. Using it (or
 * anything built on it, like createLiveFundHouseResolver()) for a `prod`
 * dry run would silently read DEV data while claiming to check production.
 * This client is what makes the `prod` path genuinely read production.
 */
function makeTargetRestClient(which: string) {
  const t = TARGETS[which];
  const base = process.env[t.urlKey]!;
  const key = process.env[t.keyKey]!;
  if (new URL(base).host !== t.host) throw new Error(`HOST ASSERTION FAILED for ${which}: ${base}`);
  return async function get<T>(path: string): Promise<T> {
    const r = await fetch(`${base}/rest/v1/${path}`, { method: 'GET', headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (r.status >= 400) throw new Error(`${r.status} ${(await r.text()).slice(0, 300)}`);
    return r.json() as Promise<T>;
  };
}

async function main() {
  const [which, instrumentId, fromDate, toDate, ...rest] = process.argv.slice(2);
  const apply = rest.includes('--apply');
  const target = TARGETS[which];
  if (!target || !instrumentId || !fromDate || !toDate) {
    console.error('usage: <prod|dev> <instrumentId> <fromDate> <toDate> [--apply]');
    process.exit(2);
  }
  if (apply && which !== 'dev') {
    console.error('REFUSING: --apply is only permitted against the dev target. Production restoration is a PO-run operator action.');
    process.exit(1);
  }

  const get = makeTargetRestClient(which);

  // Target-parameterized fund-house resolver (mirrors createLiveFundHouseResolver()'s
  // logic exactly, but against the CORRECT environment -- see makeTargetRestClient's header).
  let fundHouseByName: Map<string, number> | null = null;
  const resolveFundHouse: FundHouseResolver = async (schemeCode: string) => {
    if (fundHouseByName === null) {
      const rows = await get<{ fund_house_code: number; amc_name: string }[]>('ii_amfi_fund_houses?select=fund_house_code,amc_name');
      fundHouseByName = new Map(rows.map((r) => [normaliseFundHouseName(r.amc_name), r.fund_house_code]));
    }
    const sm = await get<{ amc_name: string | null }[]>(`ii_scheme_master?select=amc_name&amfi_scheme_code=eq.${schemeCode}&amc_name=not.is.null&limit=1`);
    const name = sm[0]?.amc_name;
    return name ? fundHouseByName.get(normaliseFundHouseName(name)) ?? null : null;
  };
  const adapter = new FallbackHistoricalAdapter(new AmfiHistoricalAdapter({ resolveFundHouse }), new TigzigHistoricalAdapter());

  console.log(`Target: ${which} (${target.host}). Mode: ${apply ? 'APPLY (writes to ii_prices_nav on dev)' : 'DRY RUN (no writes anywhere)'}.`);
  console.log(`Instrument: ${instrumentId}. Range: [${fromDate}, ${toDate}].\n`);

  const idRows = await get<{ identifier_value: string }[]>(
    `ii_instrument_identifiers?select=identifier_value&instrument_id=eq.${instrumentId}&identifier_scheme=eq.amfi_scheme_code&is_active=eq.true`
  );
  const code = idRows[0]?.identifier_value;
  if (!code) {
    console.log('RESULT: cannot attempt restoration -- no active AMFI scheme code is on file for this instrument.');
    process.exit(0);
  }
  const instrumentRows = await get<{ base_currency: string }[]>(`ii_instruments?select=base_currency&id=eq.${instrumentId}`);
  const currencyCode = instrumentRows[0]?.base_currency ?? 'INR';

  const chunks = chunkDateWindow(fromDate, toDate, MAX_FETCH_WINDOW_DAYS);
  const recovered = new Map<string, string>();
  const failures: string[] = [];
  const providerCounts: Record<string, number> = {};
  for (const chunk of chunks) {
    const res = await adapter.fetchHistory({ schemeIdentifier: code, fromDate: chunk.fromDate, toDate: chunk.toDate });
    if (!res.ok) {
      failures.push(`[${chunk.fromDate}, ${chunk.toDate}] ${res.kind}: ${res.detail}`);
      continue;
    }
    providerCounts[res.provider.key] = (providerCounts[res.provider.key] ?? 0) + res.observations.length;
    for (const o of res.observations) recovered.set(o.date, String(o.nav));
    await new Promise((r) => setTimeout(r, 750));
  }

  const fullyRecovered = failures.length === 0 && recovered.size > 0;
  console.log(`Chunks: ${chunks.length}. Recovered ${recovered.size} observation(s) from: ${JSON.stringify(providerCounts)}.`);
  if (failures.length > 0) {
    console.log(`NOT recoverable for ${failures.length} chunk(s):`);
    for (const f of failures) console.log(`  ${f}`);
  }
  console.log(`\nRESULT: ${fullyRecovered ? 'FULLY RECOVERABLE from an approved source' : recovered.size > 0 ? 'PARTIALLY recoverable -- the remaining gap stays unresolved' : 'NOT recoverable from any approved source (AMFI and TIGZIG both failed for the whole range)'}.`);

  if (!apply) {
    console.log('\nDry run -- no rows written, no coverage-gap row touched. Re-run with --apply (dev only) to write recovered rows for real.');
    return;
  }

  if (recovered.size === 0) {
    console.log('\nNothing to write.');
    return;
  }

  const deps = createLiveHydrationDeps();
  const rows = [...recovered.entries()].map(([priceDate, price]) => ({
    instrumentId,
    priceDate,
    price,
    currencyCode,
    recordChecksum: `restoration-attempt:${priceDate}:${price}`,
    dataVersion: `nav1-restoration-attempt-${new Date().toISOString().slice(0, 10)}`,
    importBatchId: crypto.randomUUID(),
  }));
  const writeResult = await deps.writeRows(rows);
  if (writeResult.error) throw new Error(`write failed: ${writeResult.error}`);
  console.log(`\nWrote (upserted, existing values never overwritten) ${writeResult.inserted} row(s).`);

  if (fullyRecovered) {
    // Safe here (unlike the read path above): this line only ever runs
    // under apply && which === 'dev', where createAdminClient()'s
    // hard-coded DEV credentials are the CORRECT target.
    const { error: resolveErr } = await createAdminClient()
      .from('ii_nav_source_coverage_gaps')
      .update({ resolved_at: new Date().toISOString(), resolved_detail: `restored ${recovered.size} rows via ${JSON.stringify(providerCounts)} on ${new Date().toISOString()}` })
      .eq('instrument_id', instrumentId)
      .eq('gap_from', fromDate)
      .eq('gap_to', toDate)
      .is('resolved_at', null);
    if (resolveErr) console.error(`Could not mark the coverage gap resolved (rows were still written): ${resolveErr.message}`);
    else console.log('Marked the matching ii_nav_source_coverage_gaps row resolved.');
  } else {
    console.log('The range is only partially recovered -- the coverage-gap row is left OPEN on purpose.');
  }
}

main().catch((e) => {
  console.error('FAILED', e instanceof Error ? e.message : e);
  process.exit(1);
});
