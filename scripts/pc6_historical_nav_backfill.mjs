// One-time historical NAV backfill from a user-supplied AMFI full-history
// CSV (scheme_code,date,nav,scheme_name,isin), scoped ONLY to instruments
// this deployment already has resolved (the same instrument universe the
// daily PC6 ingest job resolves against) -- importing NAV history for
// schemes nobody holds would be pointless. Streams the file line-by-line
// (never loads the multi-GB file into memory), resolves by AMFI scheme
// code first then ISIN (same priority as schemeMasterWriter.ts), and skips
// any (instrument, date) pair already on file -- never overwrites.
//
// Usage:
//   node scripts/pc6_historical_nav_backfill.mjs <path-to-csv>               (DEV, default)
//   node scripts/pc6_historical_nav_backfill.mjs <path-to-csv> --production  (production)
//
// Idempotent and safe to re-run: an interrupted or partial run can simply be
// re-invoked with the same file; already-imported rows are skipped, not
// duplicated (both via a pre-fetch pre-check AND an on_conflict/ignore-
// duplicates upsert as defense in depth).
import fs from 'fs';
import readline from 'readline';
import { createHash } from 'node:crypto';

const envPath = new URL('../.env.local', import.meta.url);
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}

const useProduction = process.argv.includes('--production');
const URL_ = useProduction ? process.env.PRODUCTION_SUPABASE_URL : process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = useProduction ? process.env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY : process.env.SUPABASE_SERVICE_ROLE_KEY;
const CSV_PATH = process.argv[2];
const CHUNK_SIZE = 500;
console.log(`Target: ${useProduction ? 'PRODUCTION' : 'DEV'} (${URL_})`);

async function pg(path, init) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

console.log('Loading resolved instrument universe (by AMFI scheme code and by ISIN, same as the PC6 ingest job resolves against)...');
const instruments = await pg('ii_instruments?select=id,isin&instrument_class=eq.mutual_fund&isin=not.is.null');
const isinToInstrument = new Map(instruments.map((i) => [i.isin, i.id]));
const identifierRows = await pg('ii_instrument_identifiers?select=identifier_value,instrument_id&identifier_scheme=eq.amfi_scheme_code&is_active=eq.true');
const codeToInstrument = new Map(identifierRows.map((r) => [r.identifier_value, r.instrument_id]));
console.log(`  ${isinToInstrument.size} instruments resolvable by ISIN, ${codeToInstrument.size} by AMFI scheme code.`);

console.log('Loading already-imported (instrument, date) pairs to avoid duplicates...');
const existingSet = new Set();
const instrumentIds = [...new Set([...isinToInstrument.values(), ...codeToInstrument.values()])];
const PAGE_SIZE = 1000; // PostgREST's own default response cap -- must be paged explicitly, or a heavily-backfilled instrument's rows past the first page are silently missed
for (let i = 0; i < instrumentIds.length; i += 50) {
  const slice = instrumentIds.slice(i, i + 50);
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const rows = await pg(`ii_prices_nav?select=instrument_id,price_date&instrument_id=in.(${slice.join(',')})&limit=${PAGE_SIZE}&offset=${offset}`);
    for (const r of rows) existingSet.add(`${r.instrument_id}|${r.price_date}`);
    if (rows.length < PAGE_SIZE) break;
  }
}
console.log(`  ${existingSet.size} existing rows on file for these instruments.`);

const batchId = crypto.randomUUID();
let buffer = [];
let lineNo = 0;
let matched = 0;
let inserted = 0;
let skippedExisting = 0;
let skippedInvalid = 0;
const perInstrumentCounts = new Map();

async function flush() {
  if (buffer.length === 0) return;
  const slice = buffer;
  buffer = [];
  // on_conflict + resolution=ignore-duplicates: defense in depth alongside
  // the paginated pre-fetch above -- one coincidental collision (however it
  // arises) skips only that one row instead of failing the whole chunk and
  // losing every other legitimate new row in it.
  const res = await fetch(`${URL_}/rest/v1/ii_prices_nav?on_conflict=instrument_id,price_date`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal,resolution=ignore-duplicates' },
    body: JSON.stringify(slice),
  });
  if (!res.ok) {
    console.error(`Chunk insert failed (${slice.length} rows): ${(await res.text()).slice(0, 300)}`);
    return;
  }
  inserted += slice.length;
}

const rl = readline.createInterface({ input: fs.createReadStream(CSV_PATH, { encoding: 'utf8' }), crlfDelay: Infinity });
for await (const line of rl) {
  lineNo++;
  if (lineNo === 1) continue; // header
  const parts = line.split(',');
  if (parts.length < 5) { skippedInvalid++; continue; }
  const [schemeCode, dateStr, navStr, , isin] = parts;
  // Same resolution priority as schemeMasterWriter.ts: AMFI scheme code
  // first, ISIN as fallback -- an instrument's ii_instruments.isin can
  // legitimately differ from (or postdate) the specific ISIN variant AMFI's
  // own historical file carries for it.
  const instrumentId = codeToInstrument.get(schemeCode.trim()) ?? (isin ? isinToInstrument.get(isin.trim()) : undefined);
  if (!instrumentId) continue; // not a scheme this deployment holds
  const dateIso = dateStr.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) { skippedInvalid++; continue; }
  const nav = Number(navStr);
  if (!Number.isFinite(nav) || nav <= 0) { skippedInvalid++; continue; }
  matched++;
  const key = `${instrumentId}|${dateIso}`;
  if (existingSet.has(key)) { skippedExisting++; continue; }
  existingSet.add(key); // guard against duplicate rows within the file itself
  perInstrumentCounts.set(instrumentId, (perInstrumentCounts.get(instrumentId) ?? 0) + 1);
  buffer.push({
    instrument_id: instrumentId,
    currency_code: 'INR',
    price_date: dateIso,
    price: nav,
    source_timestamp: new Date().toISOString(),
    data_version: 'amfi-historical-backfill-2026-09-20',
    record_checksum: createHash('sha256').update(`${instrumentId}|${dateIso}|${navStr.trim()}`).digest('hex').slice(0, 32),
    import_batch_id: batchId,
    quality_status: 'ok',
  });
  if (buffer.length >= CHUNK_SIZE) await flush();
  if (lineNo % 2000000 === 0) console.log(`  ...${lineNo.toLocaleString()} lines read, ${matched} matched, ${inserted} inserted so far`);
}
await flush();

console.log('\n=== AMFI historical NAV backfill complete ===');
console.log('lines read:', lineNo);
console.log('matched to a resolved instrument:', matched);
console.log('inserted:', inserted);
console.log('skipped (already on file):', skippedExisting);
console.log('skipped (invalid row):', skippedInvalid);
console.log('per-instrument new rows:', Object.fromEntries(perInstrumentCounts));
