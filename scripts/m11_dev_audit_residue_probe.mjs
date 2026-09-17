/**
 * M11 — follow-up read-only probe of the 48 `aie_audit_event` rows the DEV
 * residue probe found, against live-DEV harnesses that all report ZERO residue.
 *
 * READ-ONLY. GET only.
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
if (BASE === env.PRODUCTION_SUPABASE_URL.replace(/\/$/, '')) throw new Error('SAFETY: dev == production');

const get = async (q) => {
  const r = await fetch(`${BASE}/rest/v1/${q}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) { let b = null; try { b = await r.json(); } catch { /* ignore */ } return { ok: false, code: b?.code ?? r.status, message: b?.message }; }
  return { ok: true, data: await r.json() };
};

const rows = await get('aie_audit_event?select=*&order=created_at.asc&limit=500');
if (!rows.ok) { console.log('ERR', rows.code, rows.message); process.exit(1); }
console.log(`aie_audit_event rows on DEV: ${rows.data.length}\n`);
const byType = {}, byDay = {};
for (const r of rows.data) {
  byType[r.event_type ?? r.type ?? '(unknown)'] = (byType[r.event_type ?? r.type ?? '(unknown)'] ?? 0) + 1;
  const d = String(r.created_at ?? '').slice(0, 10);
  byDay[d] = (byDay[d] ?? 0) + 1;
}
console.log('by event type :', JSON.stringify(byType));
console.log('by day        :', JSON.stringify(byDay));
console.log('\ncolumns       :', Object.keys(rows.data[0] ?? {}).join(', '));
console.log('\noldest row    :', JSON.stringify(rows.data[0]).slice(0, 400));
console.log('newest row    :', JSON.stringify(rows.data[rows.data.length - 1]).slice(0, 400));

// Are these orphans (their intake/run already deleted)?
const intakeIds = [...new Set(rows.data.map((r) => r.intake_id).filter(Boolean))];
const runIds = [...new Set(rows.data.map((r) => r.run_id).filter(Boolean))];
console.log(`\ndistinct intake_id referenced: ${intakeIds.length}   distinct run_id referenced: ${runIds.length}`);
if (intakeIds.length) {
  const live = await get(`aie_document_intake?select=id&id=in.(${intakeIds.slice(0, 50).join(',')})`);
  console.log(`  of the first ${Math.min(50, intakeIds.length)} intake ids, still present in aie_document_intake: ${live.ok ? live.data.length : `ERR ${live.code}`}`);
}
const systemRows = rows.data.filter((r) => !r.user_id);
const userRows = rows.data.filter((r) => r.user_id);
console.log(`\nrows with NO user_id (system sweep events, unattributable to any tenant): ${systemRows.length}`);
console.log(`rows WITH a user_id (orphans — their parent intake row is gone)          : ${userRows.length}`);
const today = rows.data.filter((r) => String(r.created_at).startsWith('2026-09-15'));
console.log(`rows created 2026-09-15 (this mission's own live-DEV runs)               : ${today.length}`);
console.log(`rows created before 2026-09-15 (pre-existing, AIE closure mission era)   : ${rows.data.length - today.length}`);
console.log('\nwrites performed: 0');
