// NAV 1 — independent live-DEV functional verification that migration
// 0167_nav1_prices_nav_date_index.sql (idx_ii_prices_nav_price_date) is
// actually live and doing its job, run AFTER the PO reported applying
// 0167/0168 to DEV with "no error". Does not trust that report on its own.
//
// There is no raw-SQL/DDL/catalog-query path from this environment to DEV
// (re-confirmed: pg_indexes/pg_trigger/pg_proc are not exposed via
// PostgREST -- "PGRST205 Could not find the table"; PostgREST's own
// EXPLAIN-plan media type, application/vnd.pgrst.plan+json, is not enabled
// on this project either -- 406 PGRST107). So this verifies BEHAVIOUR
// instead of the catalog entry directly: migration 0167's own header
// documents that a `price_date >= X` count and a paginated high-OFFSET
// `price_date` range read both previously failed with 57014 (statement
// timeout) on this exact 3.06M-row table. This script reproduces both
// exact query shapes live. If the index is truly in place, both now
// succeed quickly; if it were missing, the `gte` direction in particular
// (the one degrades without the index, per 0167's own analysis) would be
// expected to time out again.
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const raw = fs.readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
const pick = (name) => raw.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim();
const url = pick('NEXT_PUBLIC_SUPABASE_URL');
const key = pick('SUPABASE_SERVICE_ROLE_KEY');
if (!url || !key) { console.log('NO CREDS'); process.exit(1); }
console.log('DEV host:', new URL(url).host);

const client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

// Step 1: functional test of the index -- reproduce the exact query shape that
// previously timed out (57014) per migration 0167's own header.
console.log('\n--- Test A: price_date-only filter, ascending direction (previously timed out) ---');
let t0 = Date.now();
{
  const { count, error } = await client
    .from('ii_prices_nav')
    .select('*', { count: 'exact', head: true })
    .gte('price_date', '2026-09-21');
  console.log('gte 2026-09-21:', { count, error: error?.message, code: error?.code, ms: Date.now() - t0 });
}

t0 = Date.now();
{
  const { count, error } = await client
    .from('ii_prices_nav')
    .select('*', { count: 'exact', head: true })
    .lt('price_date', '2026-09-21');
  console.log('lt 2026-09-21:', { count, error: error?.message, code: error?.code, ms: Date.now() - t0 });
}

// Step 2: try to get a real EXPLAIN plan via PostgREST's plan header, if enabled.
console.log('\n--- Test B: PostgREST EXPLAIN plan header (best-evidence path) ---');
const restUrl = `${url}/rest/v1/ii_prices_nav?select=price_date&price_date=gte.2026-09-21&limit=1`;
try {
  const res = await fetch(restUrl, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: 'application/vnd.pgrst.plan+json',
    },
  });
  const text = await res.text();
  console.log('status:', res.status);
  console.log('body (first 2000 chars):', text.slice(0, 2000));
} catch (e) {
  console.log('EXPLAIN header attempt failed:', e.message);
}

// Step 3: total row count for context
console.log('\n--- Test C: table size context ---');
t0 = Date.now();
{
  const { count, error } = await client
    .from('ii_prices_nav')
    .select('*', { count: 'exact', head: true });
  console.log('total count:', { count, error: error?.message, ms: Date.now() - t0 });
}

// Step 4: paginated read with high offset (the other query shape that timed out per 0167 header)
console.log('\n--- Test D: paginated date-range read with high offset ---');
t0 = Date.now();
{
  const { data, error } = await client
    .from('ii_prices_nav')
    .select('instrument_id, price_date')
    .gte('price_date', '2026-01-01')
    .lte('price_date', '2026-09-21')
    .range(50000, 50010);
  console.log('paginated range read:', { rows: data?.length, error: error?.message, code: error?.code, ms: Date.now() - t0 });
}

// Extra: confirm system catalogs are NOT exposed via PostgREST (expected, for
// completeness/documentation of why the functional-behaviour test above is
// the best available evidence rather than a catalog-name lookup).
console.log('\n--- Test E: attempt catalog access via PostgREST (expected to fail) ---');
for (const tbl of ['pg_indexes', 'pg_trigger', 'pg_proc']) {
  const { error } = await client.from(tbl).select('*').limit(1);
  console.log(`${tbl}:`, error ? `${error.code} ${error.message}` : 'unexpectedly accessible');
}
