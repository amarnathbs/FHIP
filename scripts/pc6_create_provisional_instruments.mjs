// PC6 full-universe expansion (PO instruction, 2026-09-20): create a
// provisional ii_instruments row (ADR-002 pattern, same convention
// documentProcessing.ts already uses for a first-seen scheme on a real
// statement) for every AMFI scheme this deployment does not already have
// resolved -- so the scheme-master and NAV ingest jobs, and the historical
// backfill, can cover the full ~14,358-scheme AMFI universe instead of only
// currently-held schemes.
//
// ii_instruments has no user_id (it is a shared, global reference table,
// not user-owned data) -- these rows are as legitimate created by a system
// import as by a real statement upload. status='provisional' is the exact
// same status a real first-seen scheme gets today; nothing about this
// operation is a new kind of row, only a different, larger trigger for it.
//
// TWO-PASS by design (found necessary the hard way): isin is GLOBALLY
// unique across ii_instrument_identifiers (uidx_ii_instrument_identifiers_
// global), and a real AMFI data quirk means the SAME isin genuinely appears
// under more than one scheme code (the same underlying fund tracked twice).
// Deciding "new instrument vs. link to an existing/pending one" chunk by
// chunk missed collisions that only became visible in a LATER chunk, or
// even between two rows of the SAME chunk. Pass 1 makes every decision
// in-memory across the WHOLE list first; pass 2 only ever executes
// decisions that are already known to be collision-free.
//
// Usage: npx tsx scripts/pc6_create_provisional_instruments.mjs [--production] [--dry]
import fs from 'fs';

const envPath = new URL('../.env.local', import.meta.url);
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}

const useProduction = process.argv.includes('--production');
const dryRun = process.argv.includes('--dry');
const URL_ = useProduction ? process.env.PRODUCTION_SUPABASE_URL : process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = useProduction ? process.env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY : process.env.SUPABASE_SERVICE_ROLE_KEY;
console.log(`Target: ${useProduction ? 'PRODUCTION' : 'DEV'} (${URL_})${dryRun ? ' [DRY RUN]' : ''}`);

async function pg(path, init) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null; // return=minimal responds with an empty body -- never valid JSON to parse
}

// PostgREST's own default response cap (1000) truncates a plain select
// silently -- must be paged explicitly.
async function fetchAllPaged(path) {
  const out = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const rows = await pg(`${path}&limit=${PAGE}&offset=${offset}`);
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

const { parseNavAll } = await import('../lib/services/investment-intelligence/pc6/amfiParser.ts');
const { buildUrl } = await import('../lib/config/investment-intelligence/pc6ReferenceSources.ts');

console.log('Fetching and parsing the live AMFI scheme universe (NAVAll.txt)...');
const url = buildUrl('amfi_scheme_master', {});
const fetchRes = await fetch(url, { headers: { 'User-Agent': 'FHIP-PC6/1.0' } });
const bytes = new Uint8Array(await fetchRes.arrayBuffer());
const retrievedAt = new Date().toISOString();
const parsed = parseNavAll(bytes, { asOfDate: retrievedAt.slice(0, 10), retrievedAt });
console.log(`  ${parsed.records.length} accepted records, ${parsed.rejections.length} rejected.`);

const byCode = new Map();
for (const r of parsed.records) byCode.set(r.amfiSchemeCode, r);
console.log(`  ${byCode.size} distinct AMFI scheme codes in the universe.`);

console.log('Loading already-resolved scheme codes and ISINs...');
const existingCodeRows = await fetchAllPaged('ii_instrument_identifiers?select=identifier_value,instrument_id&identifier_scheme=eq.amfi_scheme_code&is_active=eq.true');
const alreadyResolvedCodes = new Set(existingCodeRows.map((r) => r.identifier_value));
const existingIsinRows = await fetchAllPaged('ii_instrument_identifiers?select=identifier_value,instrument_id&identifier_scheme=eq.isin&is_active=eq.true');
const isinToInstrument = new Map(existingIsinRows.map((r) => [r.identifier_value, r.instrument_id]));
console.log(`  ${alreadyResolvedCodes.size} scheme codes already resolved, ${isinToInstrument.size} ISINs already claimed.`);

const toCreate = [...byCode.values()].filter((r) => !alreadyResolvedCodes.has(r.amfiSchemeCode));
console.log(`  ${toCreate.length} schemes need attention (new instrument, or a new identifier on an existing one).`);

// --- Pass 1: decide, entirely in memory, before any write happens --------
const newInstrumentPlans = []; // one per genuinely-new isin (or no isin)
const linkPlans = []; // { amfiSchemeCode, isin } -> resolves to an existing OR just-planned instrument
for (const r of toCreate) {
  if (r.isinGrowthOrPayout && isinToInstrument.has(r.isinGrowthOrPayout)) {
    linkPlans.push(r);
  } else {
    newInstrumentPlans.push(r);
    if (r.isinGrowthOrPayout) isinToInstrument.set(r.isinGrowthOrPayout, null); // reserved -- filled in with a real id once created below
  }
}
console.log(`  Plan: ${newInstrumentPlans.length} new instruments, ${linkPlans.length} scheme codes linking to an existing/planned instrument.`);

if (dryRun) {
  console.log('Dry run -- nothing written.');
  process.exit(0);
}

// --- Pass 2: execute the plan -- new instruments first, so every link ----
// target has a real id by the time identifiers are written.
const CHUNK = 200;
let created = 0;
for (let i = 0; i < newInstrumentPlans.length; i += CHUNK) {
  const slice = newInstrumentPlans.slice(i, i + CHUNK);
  const instrumentRows = slice.map((r) => ({
    instrument_name: r.schemeName,
    instrument_class: 'mutual_fund',
    country_of_domicile: 'IN',
    base_currency: 'INR',
    isin: r.isinGrowthOrPayout,
    status: 'provisional',
    plan_type: r.planType,
    option_type: r.optionType,
    amc_name: r.amcName,
  }));
  const insertedRows = await pg('ii_instruments', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(instrumentRows) });
  const identifierRows = [];
  for (let j = 0; j < insertedRows.length; j++) {
    const instrumentId = insertedRows[j].id;
    const scheme = slice[j];
    if (scheme.isinGrowthOrPayout) {
      identifierRows.push({ instrument_id: instrumentId, identifier_scheme: 'isin', identifier_value: scheme.isinGrowthOrPayout, country_code: 'IN' });
      isinToInstrument.set(scheme.isinGrowthOrPayout, instrumentId);
    }
    identifierRows.push({ instrument_id: instrumentId, identifier_scheme: 'amfi_scheme_code', identifier_value: scheme.amfiSchemeCode, country_code: 'IN' });
  }
  await pg('ii_instrument_identifiers', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(identifierRows) });
  created += insertedRows.length;
  if ((i / CHUNK) % 10 === 0) console.log(`  ...${created}/${newInstrumentPlans.length} new instruments created`);
}

let linked = 0;
for (let i = 0; i < linkPlans.length; i += CHUNK) {
  const slice = linkPlans.slice(i, i + CHUNK);
  const identifierRows = slice.map((r) => ({ instrument_id: isinToInstrument.get(r.isinGrowthOrPayout), identifier_scheme: 'amfi_scheme_code', identifier_value: r.amfiSchemeCode, country_code: 'IN' }));
  await pg('ii_instrument_identifiers', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(identifierRows) });
  linked += identifierRows.length;
}

console.log(`\n=== Provisional instrument creation complete: ${created} new instruments, ${linked} scheme codes linked to an existing instrument ===`);
