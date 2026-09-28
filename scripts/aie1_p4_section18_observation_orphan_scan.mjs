// Mission part 4, section 18 -- read-only observation scan (no writes) for
// orphaned staging records, unsettled AI-cost reservations, and stuck
// document-lifecycle rows, on BOTH DEV and PRODUCTION. This is a snapshot,
// not a monitoring system -- it establishes the OBSERVATION CRITERIA the
// mission asks for (thresholds below) and reports today's actual counts
// against them, using service-role SELECT only.
//
// Run: npx tsx scripts/aie1_p4_section18_observation_orphan_scan.mjs
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
function loadEnv(file) {
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, '');
  }
  return env;
}
const env = loadEnv('D:/FHIP/.env.local');

const TARGETS = [
  { name: 'DEV', url: env.NEXT_PUBLIC_SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY },
  { name: 'PRODUCTION', url: env.PRODUCTION_SUPABASE_URL, key: env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY },
];

async function restCount(base, key, table, query) {
  const res = await fetch(`${base}/rest/v1/${table}?${query}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact', Range: '0-0' },
  });
  const range = res.headers.get('content-range'); // e.g. "0-0/5"
  const total = range?.split('/')[1];
  return { status: res.status, total: total === undefined ? null : (total === '*' ? '*' : Number(total)) };
}

async function main() {
  for (const t of TARGETS) {
    if (!t.url || !t.key) { console.log(`\n=== ${t.name}: SKIPPED (missing env) ===`); continue; }
    console.log(`\n=== ${t.name} (${new URL(t.url).host}) -- ${new Date().toISOString()} ===`);

    const nowMinus1h = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const nowMinus24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const checks = [
      // Criterion: an AI-cost reservation still unsettled >1h is a candidate
      // stuck reservation (the sweep is supposed to settle/release these).
      { label: 'unsettled AI-cost reservations older than 1h (aie_ai_cost_attempt, settled_at is null)', table: 'aie_ai_cost_attempt', query: `settled_at=is.null&created_at=lt.${nowMinus1h}&select=idempotency_key` },
      { label: 'total unsettled AI-cost reservations (any age)', table: 'aie_ai_cost_attempt', query: `settled_at=is.null&select=idempotency_key` },
      // Criterion: a bank/liability/retirement/investment statement stuck
      // in queued/processing >24h is a candidate orphaned staging record.
      { label: 'fdh_statement_uploads stuck in queued/processing >24h', table: 'fdh_statement_uploads', query: `processing_status=in.(queued,processing)&created_at=lt.${nowMinus24h}&select=id` },
      { label: 'fdh_statement_uploads total queued/processing (any age)', table: 'fdh_statement_uploads', query: `processing_status=in.(queued,processing)&select=id` },
      // Criterion: an aie_document_intake row not reaching a terminal status
      // (ready/rejected/cancelled/deleted) >24h after creation.
      { label: 'aie_document_intake stuck (not ready/rejected/cancelled/deleted) >24h', table: 'aie_document_intake', query: `status=in.(received,quarantined)&created_at=lt.${nowMinus24h}&select=id` },
      { label: 'aie_document_intake total rows (any status)', table: 'aie_document_intake', query: `select=id` },
      // Criterion: an ii_source_documents row with storage still not purged
      // >24h after upload (the hard backstop should have caught it by then).
      { label: 'ii_source_documents storage NOT purged >24h old', table: 'ii_source_documents', query: `storage_purged_at=is.null&created_at=lt.${nowMinus24h}&select=id` },
    ];

    for (const c of checks) {
      try {
        const r = await restCount(t.url, t.key, c.table, c.query);
        const okStatus = r.status === 200 || r.status === 206;
        console.log(`  ${okStatus ? (r.total === 0 ? 'OK  ' : 'FLAG') : 'ERR '} ${c.label}: ${okStatus ? r.total : `HTTP ${r.status}`}`);
      } catch (e) {
        console.log(`  ERR  ${c.label}: ${e.message}`);
      }
    }
  }
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
