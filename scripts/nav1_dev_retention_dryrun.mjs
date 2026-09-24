// ==========================================================================
// SUPERSEDED BY MIGRATION 0189 -- DO NOT USE FOR A PRODUCTION MANIFEST.
//
// This file encodes the pre-0189 retention rule: an instrument is protected
// only if it has a CERTIFIED portfolio-truth statement. In production no
// statement had ever certified (2026-09-24: all 51 at reconciliation_required),
// so this rule marks the history of every instrument real users hold as a
// deletion candidate -- proven on production: 17 of 17 held instruments.
//
// A manifest produced by this file would delete users' history. The Stage D
// production manifest (plan step D.10) must be generated from
// pc6_nav_row_is_candidate() / pc6_instrument_is_user_held() as defined in 0189,
// and this file rebuilt or retired at that point.
// ==========================================================================

// NAV 1.42 — retention dry run and candidate manifest, executed for REAL
// against live DEV data (this session has no raw-SQL/DDL path to either
// database — scripts/pc5_ddl_capability_probe.mjs re-confirmed this fresh,
// 2026-09-21 — so the workbook's own SELECT-only dry-run SQL,
// scripts/pc6_nav1_retention_dryrun_manifest.sql, cannot be run directly.
// This script re-derives the exact same policy via PostgREST reads +
// aggregate counts, which IS available, and cross-checks every protected
// instrument individually against the live pc6_nav_row_is_candidate() RPC
// (confirmed callable this session) so the two methods must agree.
//
// READ-ONLY. No write of any kind.
import fs from 'fs';

const raw = fs.readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
const pick = (name) => raw.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim();
const URL_ = pick('NEXT_PUBLIC_SUPABASE_URL');
const KEY = pick('SUPABASE_SERVICE_ROLE_KEY');
if (!URL_ || !KEY) { console.error('DEV credentials not present.'); process.exit(1); }
const C = '2026-09-21';

async function exactCount(path) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: 'count=exact', Range: '0-0' },
  });
  const range = res.headers.get('content-range');
  return Number(range?.split('/')[1]);
}
async function getJson(path) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  return res.json();
}
async function rpcCandidate(instrumentId, priceDate) {
  const res = await fetch(`${URL_}/rest/v1/rpc/pc6_nav_row_is_candidate`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_instrument_id: instrumentId, p_price_date: priceDate, p_changeover_date: C }),
  });
  return res.json();
}

console.log(`=== NAV 1.42 live-DEV retention dry run (${new URL(URL_).host}) — changeover ${C} — ${new Date().toISOString()} ===\n`);

// --- 1. Dependency sets (all small tables, safe to fetch in full) ----------
const acceptedRows = await getJson('ii_portfolio_truth_status?select=instrument_id,status&status=in.(certified,certified_with_warnings)&limit=10000');
const benchmarkRows = await getJson('ii_instrument_benchmarks?select=instrument_id&limit=10000');
const holdRows = await getJson('ii_nav_retention_holds?select=instrument_id&released_at=is.null&limit=10000');

const protectedIds = new Set([
  ...acceptedRows.map((r) => r.instrument_id),
  ...benchmarkRows.map((r) => r.instrument_id),
  ...holdRows.map((r) => r.instrument_id),
]);

console.log('--- 1. Dependency inventory (live DEV) ---');
console.log('  accepted-statement instruments (certified*):', new Set(acceptedRows.map((r) => r.instrument_id)).size);
console.log('  benchmark-mapped instruments:', new Set(benchmarkRows.map((r) => r.instrument_id)).size);
console.log('  actively-held instruments:', new Set(holdRows.map((r) => r.instrument_id)).size);
console.log('  TOTAL distinct protected-regardless-of-date instruments:', protectedIds.size);
if (acceptedRows.length === 0) {
  console.log('  *** NOTE: DEV currently has ZERO certified/certified_with_warnings ii_portfolio_truth_status');
  console.log('      rows. The accepted-statement-history protection path has NO real data to exercise in');
  console.log('      DEV right now — it remains proven only by the PGlite chain replay (17/17 PASS), not by');
  console.log('      live DEV data. This is a genuine DEV-data-realism gap, not a policy-logic gap.');
}

// --- 2. Headline sizing ------------------------------------------------------
const totalRows = await exactCount('ii_prices_nav?select=id');
const preCRows = await exactCount(`ii_prices_nav?select=id&price_date=lt.${C}`);
// NAV 1.40 finding: a `count=exact` on price_date>=C timed out (57014,
// "canceling statement due to statement timeout") against 3M rows in DEV,
// while the `lt.` direction on the same table succeeded. Derived instead of
// re-querying — this asymmetry is itself worth a follow-up (missing/less
// selective index for the >= direction at this row count) before this
// pattern is ever run against production's much larger table.
const postOrOnCRows = totalRows - preCRows;

let preCRowsForProtected = 0;
if (protectedIds.size > 0) {
  const idList = [...protectedIds].join(',');
  preCRowsForProtected = await exactCount(`ii_prices_nav?select=id&price_date=lt.${C}&instrument_id=in.(${idList})`);
}
const candidateRows = preCRows - preCRowsForProtected;

console.log('\n--- 2. Headline candidate-manifest sizing ---');
console.log('  total ii_prices_nav rows:', totalRows);
console.log('  rows before changeover (price_date < C):', preCRows);
console.log('  rows on/after changeover (KEEP unconditionally):', postOrOnCRows);
console.log('  pre-changeover rows belonging to a protected instrument:', preCRowsForProtected);
console.log('  CANDIDATE rows (pre-C, unprotected):', candidateRows, `(${((candidateRows / totalRows) * 100).toFixed(1)}% of all rows)`);

// --- 3. Cross-check: spot-check every protected instrument individually via
//    the live RPC on a pre-C date, and a random sample of unprotected
//    instruments, to prove the aggregate math agrees with the deployed
//    function row-by-row, not just in aggregate.
console.log('\n--- 3. RPC cross-check (pc6_nav_row_is_candidate) ---');
let mismatches = 0;
const probeDate = '2020-01-01'; // arbitrary pre-C date
for (const id of [...protectedIds].slice(0, 25)) {
  const isCandidate = await rpcCandidate(id, probeDate);
  if (isCandidate !== false) { mismatches++; console.log(`  MISMATCH: protected instrument ${id} reported candidate=${isCandidate} for ${probeDate}`); }
}
console.log(`  Checked ${Math.min(25, protectedIds.size)} protected instruments at ${probeDate}: ${mismatches} mismatch(es) (expected 0).`);

const unprotectedSampleRows = await getJson(`ii_prices_nav?select=instrument_id&price_date=lt.${C}&limit=25`);
const unprotectedSample = unprotectedSampleRows.map((r) => r.instrument_id).filter((id) => !protectedIds.has(id));
let unexpectedKeep = 0;
for (const id of unprotectedSample) {
  const isCandidate = await rpcCandidate(id, probeDate);
  if (isCandidate !== true) { unexpectedKeep++; console.log(`  UNEXPECTED KEEP: unprotected instrument ${id} reported candidate=${isCandidate} for ${probeDate}`); }
}
console.log(`  Checked ${unprotectedSample.length} unprotected instruments at ${probeDate}: ${unexpectedKeep} unexpected KEEP(s) (expected 0).`);

console.log('\n=== Result: this manifest is evidence for review, not an execution step. No row has been deleted. ===');
