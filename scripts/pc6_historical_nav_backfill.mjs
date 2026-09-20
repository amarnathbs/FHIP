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
//   node scripts/pc6_historical_nav_backfill.mjs --retry-failed [--production]
//     Re-submits only the rows saved to pc6_failed_chunks_<env>.json by a
//     prior run that hit MAX_ATTEMPTS on some chunks (added 2026-09-20 after
//     a production run hit a CDN/WAF block page returning HTML instead of a
//     JSON error under sustained request volume). Skips re-scanning the
//     multi-GB source file entirely.
//
// Idempotent and safe to re-run: an interrupted or partial run can simply be
// re-invoked with the same file; already-imported rows are skipped, not
// duplicated (both via a pre-fetch pre-check AND an on_conflict/ignore-
// duplicates upsert as defense in depth). Each chunk insert also retries
// with exponential backoff before being given up on (see flush() below).
import fs from 'fs';
import readline from 'readline';
import { createHash } from 'node:crypto';

const envPath = new URL('../.env.local', import.meta.url);
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}

const useProduction = process.argv.includes('--production');
const retryFailedOnly = process.argv.includes('--retry-failed');
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

// PostgREST's own default response cap (1000) truncates a plain select
// silently -- must be paged explicitly everywhere, not just for the
// existing-rows check this was originally written for. Found the hard way:
// the instrument-universe queries below had the exact same unpaged bug,
// silently capping "resolvable instruments" at 1000 each even with the full
// ~14,358-scheme AMFI universe already created.
const PAGE_SIZE = 1000;
async function pgAll(path) {
  const out = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const rows = await pg(`${path}&limit=${PAGE_SIZE}&offset=${offset}`);
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}

let isinToInstrument = new Map();
let codeToInstrument = new Map();
const existingSet = new Set();

if (!retryFailedOnly) {
  console.log('Loading resolved instrument universe (by AMFI scheme code and by ISIN, same as the PC6 ingest job resolves against)...');
  const instruments = await pgAll('ii_instruments?select=id,isin&instrument_class=eq.mutual_fund&isin=not.is.null');
  isinToInstrument = new Map(instruments.map((i) => [i.isin, i.id]));
  const identifierRows = await pgAll('ii_instrument_identifiers?select=identifier_value,instrument_id&identifier_scheme=eq.amfi_scheme_code&is_active=eq.true');
  codeToInstrument = new Map(identifierRows.map((r) => [r.identifier_value, r.instrument_id]));
  console.log(`  ${isinToInstrument.size} instruments resolvable by ISIN, ${codeToInstrument.size} by AMFI scheme code.`);

  console.log('Loading already-imported (instrument, date) pairs to avoid duplicates...');
  const instrumentIds = [...new Set([...isinToInstrument.values(), ...codeToInstrument.values()])];
  for (let i = 0; i < instrumentIds.length; i += 50) {
    const slice = instrumentIds.slice(i, i + 50);
    const rows = await pgAll(`ii_prices_nav?select=instrument_id,price_date&instrument_id=in.(${slice.join(',')})`);
    for (const r of rows) existingSet.add(`${r.instrument_id}|${r.price_date}`);
  }
  console.log(`  ${existingSet.size} existing rows on file for these instruments.`);
}

const batchId = crypto.randomUUID();
let buffer = [];
let lineNo = 0;
let matched = 0;
let inserted = 0;
let skippedExisting = 0;
let skippedInvalid = 0;
let permanentlyFailed = 0;
const perInstrumentCounts = new Map();
// Chunks that failed every retry -- written to disk at the end so a
// follow-up run can be pointed at exactly what's missing instead of
// re-scanning the full multi-GB file.
const failedChunks = [];
const FAILED_CHUNKS_PATH = new URL(`../pc6_failed_chunks_${useProduction ? 'production' : 'dev'}.json`, import.meta.url);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Small pacing delay between every chunk, win or lose. This is a one-time
// bulk-load hitting a gateway/WAF in front of Supabase's REST API that (per
// live evidence 2026-09-20) starts returning HTML block pages -- not a
// PostgREST/JSON error -- once request volume gets high enough. Slowing the
// steady-state rate is cheaper than discovering that threshold by retrying
// past it forever.
const INTER_CHUNK_DELAY_MS = useProduction ? 150 : 0;

const MAX_ATTEMPTS = 6;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;

async function flush() {
  if (buffer.length === 0) return;
  const slice = buffer;
  buffer = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      // on_conflict + resolution=ignore-duplicates: defense in depth alongside
      // the paginated pre-fetch above -- one coincidental collision (however it
      // arises) skips only that one row instead of failing the whole chunk and
      // losing every other legitimate new row in it.
      res = await fetch(`${URL_}/rest/v1/ii_prices_nav?on_conflict=instrument_id,price_date`, {
        method: 'POST',
        headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal,resolution=ignore-duplicates' },
        body: JSON.stringify(slice),
      });
    } catch (networkErr) {
      // fetch() itself threw (DNS/connection reset/etc) -- treat as
      // transient and retry, same as an HTTP-level failure.
      if (attempt === MAX_ATTEMPTS) {
        console.error(`Chunk insert failed after ${MAX_ATTEMPTS} attempts (${slice.length} rows): ${networkErr.message}`);
        permanentlyFailed += slice.length;
        failedChunks.push(slice);
        return;
      }
      const delay = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
      console.warn(`  Chunk fetch threw (${networkErr.message}), retrying in ${delay}ms (attempt ${attempt}/${MAX_ATTEMPTS})...`);
      await sleep(delay);
      continue;
    }

    if (res.ok) {
      inserted += slice.length;
      if (INTER_CHUNK_DELAY_MS > 0) await sleep(INTER_CHUNK_DELAY_MS);
      return;
    }

    const bodyText = await res.text();
    // A CDN/WAF/rate-limit block page comes back as HTML, not PostgREST's
    // own JSON error shape -- this is the exact failure seen live in
    // production 2026-09-20 (`<!DOCTYPE html>...<!--[if lt IE 7]>`). Retry
    // it with backoff; a genuine PostgREST error (bad payload, schema
    // mismatch) is still retried too since it's indistinguishable from a
    // transient 5xx without parsing every known error code, but will simply
    // fail the same way on every attempt and land in failedChunks for
    // inspection rather than being silently dropped.
    const looksLikeBlockPage = bodyText.trim().startsWith('<');
    if (attempt === MAX_ATTEMPTS) {
      console.error(`Chunk insert failed after ${MAX_ATTEMPTS} attempts (${slice.length} rows, status ${res.status}${looksLikeBlockPage ? ', HTML block page' : ''}): ${bodyText.slice(0, 300)}`);
      permanentlyFailed += slice.length;
      failedChunks.push(slice);
      return;
    }
    const delay = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
    console.warn(`  Chunk insert failed (status ${res.status}${looksLikeBlockPage ? ', HTML block page' : ''}), retrying in ${delay}ms (attempt ${attempt}/${MAX_ATTEMPTS})...`);
    await sleep(delay);
  }
}

if (retryFailedOnly) {
  if (!fs.existsSync(FAILED_CHUNKS_PATH)) {
    console.log(`No saved failed-chunks file at ${FAILED_CHUNKS_PATH.pathname} -- nothing to retry.`);
    process.exit(0);
  }
  const rowsToRetry = JSON.parse(fs.readFileSync(FAILED_CHUNKS_PATH, 'utf8'));
  console.log(`Retrying ${rowsToRetry.length} previously-failed row(s) from ${FAILED_CHUNKS_PATH.pathname}...`);
  fs.unlinkSync(FAILED_CHUNKS_PATH); // rewritten below only if some still fail
  for (let i = 0; i < rowsToRetry.length; i += CHUNK_SIZE) {
    buffer = rowsToRetry.slice(i, i + CHUNK_SIZE);
    await flush();
  }
  console.log('\n=== Retry of previously-failed chunks complete ===');
  console.log('rows retried:', rowsToRetry.length);
  console.log('inserted:', inserted);
  console.log('permanently failed again:', permanentlyFailed);
  if (failedChunks.length > 0) {
    fs.writeFileSync(FAILED_CHUNKS_PATH, JSON.stringify(failedChunks.flat()));
    console.log(`${permanentlyFailed} row(s) failed again -- re-saved to ${FAILED_CHUNKS_PATH.pathname}.`);
  }
  process.exit(0);
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

if (failedChunks.length > 0) {
  fs.writeFileSync(FAILED_CHUNKS_PATH, JSON.stringify(failedChunks.flat()));
  console.log(`\n${failedChunks.length} chunk(s) (${permanentlyFailed} rows) failed all ${MAX_ATTEMPTS} attempts -- saved to ${FAILED_CHUNKS_PATH.pathname} for retry via --retry-failed.`);
}

console.log('\n=== AMFI historical NAV backfill complete ===');
console.log('lines read:', lineNo);
console.log('matched to a resolved instrument:', matched);
console.log('inserted:', inserted);
console.log('skipped (already on file):', skippedExisting);
console.log('skipped (invalid row):', skippedInvalid);
console.log('permanently failed (see saved file above):', permanentlyFailed);
console.log('per-instrument new rows:', Object.fromEntries(perInstrumentCounts));
