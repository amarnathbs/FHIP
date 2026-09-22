// NAV 1.18/1.28 — real cross-source reconciliation sample: compare AMFI-
// sourced NAV already on file in DEV (written by the live pc6_amfi_daily_nav
// job) against TIGZIG's candidate data for the SAME instrument and SAME
// dates. This is the accuracy-sampling qualification the workbook asks for
// (NAV 1.18) and doubles as a real reconciliation sweep (NAV 1.28) — and it
// needs no fabricated dependency data, since it reads real AMFI schemes DEV
// already has real daily NAV for.
//
// READ-ONLY: no write anywhere in this script.
import { createAdminClient } from '@/lib/supabase/admin';
import { TigzigHistoricalAdapter } from '@/lib/services/investment-intelligence/pc6/adapters/tigzigHistoricalAdapter';

async function main() {
  const db = createAdminClient();
  const adapter = new TigzigHistoricalAdapter();

  // A handful of real, well-known schemes likely to have a stable TIGZIG
  // identifier and at least one real AMFI-sourced DEV row.
  const { data: schemes } = await db
    .from('ii_scheme_master')
    .select('instrument_id, amfi_scheme_code, scheme_name')
    .in('scheme_name', ['HDFC Flexi Cap Fund', 'SBI Bluechip Fund', 'ICICI Prudential Nifty 50 Index Fund', 'ICICI Prudential Corporate Bond Fund'])
    .is('effective_to', null)
    .limit(20);

  console.log(`Candidate real schemes found: ${schemes?.length ?? 0}\n`);
  let compared = 0, matched = 0, mismatched = 0, noOverlap = 0, fetchFailed = 0;
  const mismatchDetail: string[] = [];

  for (const s of schemes ?? []) {
    const { data: devRows } = await db
      .from('ii_prices_nav')
      .select('price_date, price')
      .eq('instrument_id', s.instrument_id)
      .order('price_date', { ascending: false })
      .limit(5);
    if (!devRows || devRows.length === 0) { noOverlap++; continue; }

    const fromDate = devRows[devRows.length - 1].price_date;
    const toDate = devRows[0].price_date;
    const result = await adapter.fetchHistory({ schemeIdentifier: s.amfi_scheme_code, fromDate, toDate });
    if (!result.ok) { fetchFailed++; console.log(`  ${s.scheme_name} (${s.amfi_scheme_code}): TIGZIG fetch failed — ${result.kind}: ${result.detail}`); continue; }

    const tigzigByDate = new Map(result.observations.map((o) => [o.date, o.nav]));
    for (const row of devRows) {
      const tigzigValue = tigzigByDate.get(row.price_date);
      if (tigzigValue === undefined) { noOverlap++; continue; }
      compared++;
      const devValue = Number(row.price);
      const tzValue = Number(tigzigValue);
      const diff = Math.abs(devValue - tzValue);
      if (diff < 0.0001) {
        matched++;
      } else {
        mismatched++;
        mismatchDetail.push(`${s.scheme_name} (${s.amfi_scheme_code}) ${row.price_date}: DEV(AMFI)=${devValue} vs TIGZIG=${tzValue} (diff ${diff.toFixed(6)})`);
      }
    }
    console.log(`  ${s.scheme_name} (${s.amfi_scheme_code}): ${devRows.length} DEV row(s) checked against TIGZIG.`);
  }

  console.log(`\n=== Cross-source reconciliation result ===`);
  console.log(`compared: ${compared}, exact match: ${matched}, mismatched: ${mismatched}, no overlapping date: ${noOverlap}, fetch failed: ${fetchFailed}`);
  if (mismatchDetail.length > 0) {
    console.log('\nMismatches:');
    for (const d of mismatchDetail) console.log('  ' + d);
  }
}

main();
