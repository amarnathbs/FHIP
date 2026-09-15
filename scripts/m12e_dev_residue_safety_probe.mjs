/**
 * M12E — section 19, PART 1: the SAFETY VERIFICATION, read-only.
 *
 * Before anything is deleted, this proves row-by-row that the two named DEV
 * residue sets are genuinely synthetic/orphan test residue and NOT real user
 * evidence:
 *
 *   OPS-PC7-2 — 19 `ii_fund_holdings_snapshots` headers
 *   OPS-M11-1 — 48 `aie_audit_event` rows
 *
 * The standard applied here is deliberately stricter than "it is on DEV":
 * every row must be shown to be (a) structurally inert — it can carry no
 * economic meaning — AND (b) unreferenced by anything that survives. Rows that
 * fail either test are reported as NOT SAFE and are left alone.
 *
 * READ-ONLY. GET only. No DELETE, no writes, no RPC, no DDL.
 */
import fs from 'node:fs';

const p = ['.env.local', 'D:/FHIP/.env.local'].find((x) => fs.existsSync(x));
const env = {};
for (const raw of fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
  const l = raw.trim();
  if (!l || l.startsWith('#')) continue;
  const i = l.indexOf('=');
  if (i > 0) env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
}
const BASE = env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, '');
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const PROD = (env.PRODUCTION_SUPABASE_URL || '').replace(/\/$/, '');
if (PROD && BASE === PROD) throw new Error('SAFETY: dev url == production url');

async function get(path) {
  const r = await fetch(`${BASE}/rest/v1/${path}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  if (!r.ok) return { error: `HTTP ${r.status}`, rows: [] };
  return { rows: await r.json() };
}

const out = { generatedAt: new Date().toISOString(), target: BASE.replace(/https:\/\/([a-z]+)\..*/, 'https://$1.supabase.co') };
let notSafe = 0;

console.log('=== M12E section 19 — DEV residue SAFETY VERIFICATION (READ-ONLY) ===\n');

/* ---------------- OPS-PC7-2 ---------------- */
console.log('--- OPS-PC7-2: ii_fund_holdings_snapshots ---');
const snaps = (await get('ii_fund_holdings_snapshots?select=*')).rows;
console.log(`  total rows: ${snaps.length}`);

const lines = (await get('ii_fund_holdings_lines?select=snapshot_id')).rows;
const lineCountBySnap = {};
for (const l of lines) lineCountBySnap[l.snapshot_id] = (lineCountBySnap[l.snapshot_id] ?? 0) + 1;
console.log(`  total ii_fund_holdings_lines rows in the whole table: ${lines.length}`);

const snapSafe = [];
const snapUnsafe = [];
for (const s of snaps) {
  const reasons = [];
  if ((lineCountBySnap[s.id] ?? 0) !== 0) reasons.push(`HAS ${lineCountBySnap[s.id]} constituent lines`);
  if (s.source_id !== null && s.source_id !== undefined) reasons.push(`source_id is NOT null (${s.source_id})`);
  if (s.scheme_master_id) reasons.push('linked to a PC6 scheme_master row');
  if (s.batch_id) reasons.push('linked to a reference import batch');
  if (s.source_url || s.source_sha256) reasons.push('carries a real disclosure source URL/checksum');
  (reasons.length ? snapUnsafe : snapSafe).push({ id: s.id, version: s.source_document_version, reasons });
}
console.log(`\n  distinct source_document_version values: ${JSON.stringify([...new Set(snaps.map((s) => s.source_document_version))])}`);
console.log(`  rows with ZERO constituent lines          : ${snaps.filter((s) => (lineCountBySnap[s.id] ?? 0) === 0).length}/${snaps.length}`);
console.log(`  rows with source_id NULL                  : ${snaps.filter((s) => s.source_id == null).length}/${snaps.length}`);
console.log(`  rows with scheme_master_id NULL           : ${snaps.filter((s) => s.scheme_master_id == null).length}/${snaps.length}`);
console.log(`  rows with batch_id NULL                   : ${snaps.filter((s) => s.batch_id == null).length}/${snaps.length}`);
console.log(`  rows with NO source_url and NO sha256     : ${snaps.filter((s) => !s.source_url && !s.source_sha256).length}/${snaps.length}`);
console.log(`\n  ==> SAFE TO DELETE: ${snapSafe.length}    NOT SAFE: ${snapUnsafe.length}`);
for (const u of snapUnsafe) console.log(`      NOT SAFE ${u.id}: ${u.reasons.join('; ')}`);
notSafe += snapUnsafe.length;
out.ops_pc7_2 = { total: snaps.length, safe: snapSafe.map((s) => s.id), unsafe: snapUnsafe };

/* ---------------- OPS-M11-1 ---------------- */
console.log('\n--- OPS-M11-1: aie_audit_event ---');
const events = (await get('aie_audit_event?select=*')).rows;
console.log(`  total rows: ${events.length}`);

const intakes = (await get('aie_document_intake?select=id')).rows;
const liveIntakeIds = new Set(intakes.map((i) => i.id));
console.log(`  live aie_document_intake rows: ${intakes.length}`);

const runs = (await get('aie_extraction_run?select=id')).rows;
const liveRunIds = new Set(runs.map((r) => r.id));
console.log(`  live aie_extraction_run rows : ${runs.length}`);

const evSafe = [];
const evUnsafe = [];
for (const e of events) {
  const reasons = [];
  if (e.intake_id && liveIntakeIds.has(e.intake_id)) reasons.push(`parent intake ${e.intake_id} STILL EXISTS`);
  if (e.run_id && liveRunIds.has(e.run_id)) reasons.push(`parent run ${e.run_id} STILL EXISTS`);
  (reasons.length ? evUnsafe : evSafe).push({ id: e.id, event_type: e.event_type, user_id: e.user_id, intake_id: e.intake_id, created_at: e.created_at, reasons });
}
const byType = {};
for (const e of events) byType[e.event_type] = (byType[e.event_type] ?? 0) + 1;
console.log(`\n  by event_type: ${JSON.stringify(byType, null, 0)}`);
console.log(`  rows with NO user_id (system sweep events): ${events.filter((e) => !e.user_id).length}`);
console.log(`  rows WITH a user_id                       : ${events.filter((e) => e.user_id).length}`);
const refIntakes = [...new Set(events.map((e) => e.intake_id).filter(Boolean))];
console.log(`  distinct intake_id referenced             : ${refIntakes.length}`);
console.log(`  ...of those, still present in aie_document_intake: ${refIntakes.filter((i) => liveIntakeIds.has(i)).length}`);
const dates = events.map((e) => (e.created_at ?? '').slice(0, 10)).sort();
console.log(`  created_at range                          : ${dates[0]} .. ${dates[dates.length - 1]}`);
const byDate = {};
for (const d of dates) byDate[d] = (byDate[d] ?? 0) + 1;
console.log(`  by date: ${JSON.stringify(byDate)}`);
console.log(`\n  ==> SAFE TO DELETE: ${evSafe.length}    NOT SAFE: ${evUnsafe.length}`);
for (const u of evUnsafe) console.log(`      NOT SAFE ${u.id}: ${u.reasons.join('; ')}`);
notSafe += evUnsafe.length;
out.ops_m11_1 = { total: events.length, safe: evSafe.map((e) => e.id), unsafe: evUnsafe, byType, byDate };

/* ---------------- production negative control ---------------- */
console.log('\n--- CONTROL: does PRODUCTION hold any equivalent rows? (must be 0 — proves this is DEV-only residue) ---');
if (env.PRODUCTION_SUPABASE_URL && env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY) {
  const pbase = env.PRODUCTION_SUPABASE_URL.replace(/\/$/, '');
  const pkey = env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY;
  for (const t of ['ii_fund_holdings_snapshots', 'aie_audit_event']) {
    const r = await fetch(`${pbase}/rest/v1/${t}?select=*&limit=1`, {
      headers: { apikey: pkey, Authorization: `Bearer ${pkey}`, Prefer: 'count=exact', Range: '0-0' },
    });
    const cr = r.headers.get('content-range');
    console.log(`  PRODUCTION ${t.padEnd(30)}: ${cr ? cr.split('/')[1] : `ERR ${r.status}`} rows   (READ-ONLY GET)`);
  }
} else {
  console.log('  production credentials not available — control skipped, NOT claimed as passed');
}

fs.writeFileSync('scripts/m12e-dev-residue/safety_verification.json', JSON.stringify(out, null, 2));
console.log(`\n=== VERDICT: ${notSafe === 0 ? 'every row in both sets is SAFE to delete' : `${notSafe} row(s) are NOT SAFE and must be left alone`} ===`);
console.log('writes performed: 0   rows deleted: 0   RPC: 0   DDL: 0');
