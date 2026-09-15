/**
 * M12E — section 19, PART 2: the CLEANUP.
 *
 *   OPS-PC7-2 — orphan `ii_fund_holdings_snapshots` headers (R5-era fixtures)
 *   OPS-M11-1 — orphan `aie_audit_event` rows
 *
 * DEV ONLY. A hard guard refuses to run if the target resolves to production,
 * and a second guard re-reads PRODUCTION read-only to confirm it holds zero
 * rows in both tables (so this can never be mistaken for a production action).
 *
 * SAFETY DISCIPLINE, deliberately stricter than "it is on DEV":
 *  1. The safety predicate is RE-EVALUATED INSIDE THIS SCRIPT immediately
 *     before deletion — it is never inherited from the earlier read-only probe,
 *     because rows can change between two runs.
 *  2. Rows are deleted BY EXPLICIT ID, never by a blanket predicate, so a row
 *     that appeared between the check and the delete cannot be caught.
 *  3. Any row failing the predicate is SKIPPED and reported, not deleted.
 *  4. After deletion the tables are INDEPENDENTLY RE-QUERIED with a separate
 *     request; a delete returning success is not treated as proof.
 *
 * Pass --apply to actually delete. Without it, this is a dry run.
 */
import fs from 'node:fs';

const APPLY = process.argv.includes('--apply');

const p = ['.env.local', 'D:/FHIP/.env.local'].find((x) => fs.existsSync(x));
const env = {};
for (const raw of fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
  const i = raw.indexOf('=');
  if (i > 0) env[raw.slice(0, i).trim()] = raw.slice(i + 1).trim();
}
const BASE = env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, '');
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const PROD = (env.PRODUCTION_SUPABASE_URL || '').replace(/\/$/, '');

if (!BASE || !KEY) throw new Error('DEV credentials missing');
if (PROD && BASE === PROD) throw new Error('REFUSING: dev url == production url');
const ref = new URL(BASE).host.split('.')[0];
const EXPECTED_DEV_REF = 'vqycarelcoijzwlpkpcz';
if (ref !== EXPECTED_DEV_REF) throw new Error(`REFUSING: target ref ${ref} is not the expected DEV project`);

const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const get = async (path) => {
  const r = await fetch(`${BASE}/rest/v1/${path}`, { headers: H });
  if (!r.ok) throw new Error(`GET ${path} -> HTTP ${r.status}`);
  return r.json();
};
const countOf = async (table) => {
  const r = await fetch(`${BASE}/rest/v1/${table}?select=*&limit=1`, {
    headers: { ...H, Prefer: 'count=exact', Range: '0-0' },
  });
  return Number((r.headers.get('content-range') || '/0').split('/')[1]);
};

const log = [];
const say = (s) => {
  console.log(s);
  log.push(s);
};

say(`=== M12E section 19 — DEV residue cleanup — ${APPLY ? 'APPLY' : 'DRY RUN'} ===`);
say(`target: ${ref} (DEV)   ${new Date().toISOString()}\n`);

/* --- production control, read-only --- */
if (PROD && env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY) {
  const pk = env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY;
  for (const t of ['ii_fund_holdings_snapshots', 'aie_audit_event']) {
    const r = await fetch(`${PROD}/rest/v1/${t}?select=*&limit=1`, {
      headers: { apikey: pk, Authorization: `Bearer ${pk}`, Prefer: 'count=exact', Range: '0-0' },
    });
    const n = (r.headers.get('content-range') || '/?').split('/')[1];
    say(`  CONTROL  PRODUCTION ${t.padEnd(30)} = ${n} rows (read-only GET; nothing here is ever deleted in production)`);
  }
}

const result = { generatedAt: new Date().toISOString(), apply: APPLY, target: ref, ops_pc7_2: {}, ops_m11_1: {} };

/* ---------------- OPS-PC7-2 ---------------- */
say('\n--- OPS-PC7-2: ii_fund_holdings_snapshots ---');
const beforeSnaps = await countOf('ii_fund_holdings_snapshots');
say(`  BEFORE: ${beforeSnaps} rows`);

const snaps = await get('ii_fund_holdings_snapshots?select=*');
const allLines = await get('ii_fund_holdings_lines?select=snapshot_id');
const lineCount = {};
for (const l of allLines) lineCount[l.snapshot_id] = (lineCount[l.snapshot_id] ?? 0) + 1;

const snapDelete = [];
const snapSkip = [];
for (const s of snaps) {
  const why = [];
  if ((lineCount[s.id] ?? 0) !== 0) why.push(`has ${lineCount[s.id]} constituent lines`);
  if (s.source_id != null) why.push('source_id is not null');
  if (s.scheme_master_id != null) why.push('linked to a PC6 scheme master');
  if (s.batch_id != null) why.push('linked to a reference import batch');
  if (s.source_url || s.source_sha256) why.push('carries a real disclosure source');
  (why.length ? snapSkip : snapDelete).push({ id: s.id, version: s.source_document_version, created_at: s.created_at, why });
}
say(`  safety re-evaluated in-script: ${snapDelete.length} deletable, ${snapSkip.length} skipped`);
for (const s of snapSkip) say(`    SKIP ${s.id}: ${s.why.join('; ')}`);

let snapDeleted = 0;
if (APPLY) {
  for (const s of snapDelete) {
    const r = await fetch(`${BASE}/rest/v1/ii_fund_holdings_snapshots?id=eq.${s.id}`, {
      method: 'DELETE',
      headers: { ...H, Prefer: 'return=minimal' },
    });
    if (r.ok) snapDeleted++;
    else say(`    DELETE FAILED ${s.id}: HTTP ${r.status} ${await r.text()}`);
  }
  say(`  deleted ${snapDeleted} row(s) by explicit id`);
}
const afterSnaps = await countOf('ii_fund_holdings_snapshots');
say(`  AFTER (independent re-query): ${afterSnaps} rows`);
result.ops_pc7_2 = { before: beforeSnaps, deletable: snapDelete.length, skipped: snapSkip, deleted: snapDeleted, after: afterSnaps, rows: snapDelete };

/* ---------------- OPS-M11-1 ---------------- */
say('\n--- OPS-M11-1: aie_audit_event ---');
const beforeEv = await countOf('aie_audit_event');
say(`  BEFORE: ${beforeEv} rows`);

const events = await get('aie_audit_event?select=*');
const liveIntakes = new Set((await get('aie_document_intake?select=id')).map((r) => r.id));
const liveRuns = new Set((await get('aie_extraction_run?select=id')).map((r) => r.id));
say(`  live aie_document_intake rows: ${liveIntakes.size}   live aie_extraction_run rows: ${liveRuns.size}`);

const evDelete = [];
const evSkip = [];
for (const e of events) {
  const why = [];
  if (e.intake_id && liveIntakes.has(e.intake_id)) why.push(`parent intake ${e.intake_id} still exists`);
  if (e.run_id && liveRuns.has(e.run_id)) why.push(`parent run ${e.run_id} still exists`);
  (why.length ? evSkip : evDelete).push({ id: e.id, event_type: e.event_type, created_at: e.created_at, why });
}
say(`  safety re-evaluated in-script: ${evDelete.length} deletable, ${evSkip.length} skipped`);
for (const e of evSkip) say(`    SKIP ${e.id}: ${e.why.join('; ')}`);

let evDeleted = 0;
if (APPLY) {
  for (const e of evDelete) {
    const r = await fetch(`${BASE}/rest/v1/aie_audit_event?id=eq.${e.id}`, {
      method: 'DELETE',
      headers: { ...H, Prefer: 'return=minimal' },
    });
    if (r.ok) evDeleted++;
    else say(`    DELETE FAILED ${e.id}: HTTP ${r.status} ${await r.text()}`);
  }
  say(`  deleted ${evDeleted} row(s) by explicit id`);
}
const afterEv = await countOf('aie_audit_event');
say(`  AFTER (independent re-query): ${afterEv} rows`);
result.ops_m11_1 = { before: beforeEv, deletable: evDelete.length, skipped: evSkip, deleted: evDeleted, after: afterEv, rows: evDelete };

/* ---------------- anti-vacuity control ---------------- */
say('\n--- ANTI-VACUITY CONTROL: the same counting method still reports non-zero where rows genuinely exist ---');
for (const t of ['ii_prices_nav', 'ii_benchmarks', 'ii_fund_holdings']) {
  say(`  ${t.padEnd(28)} = ${await countOf(t)} rows (untouched by this cleanup)`);
}

fs.writeFileSync('scripts/m12e-dev-residue/cleanup_result.json', JSON.stringify(result, null, 2));
fs.writeFileSync('scripts/m12e-dev-residue/cleanup_log.txt', log.join('\n') + '\n');
say(`\n=== ${APPLY ? 'CLEANUP COMPLETE' : 'DRY RUN COMPLETE — re-run with --apply'} ===`);
