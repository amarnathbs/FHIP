// R10 — live-DEV cross-user isolation check on the reports family. Two
// disposable users: A (victim, owns a real report+section+export) and B
// (attacker, real session, real JWT). B attempts to read A's rows directly
// by real (not guessed) id. Cleans up both users afterwards.
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

function mkUser() {
  const email = `r10-xuser-${Date.now()}-${Math.random().toString(36).slice(2)}@fhip-test.invalid`;
  const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`;
  return { email, password };
}

let uidA, uidB;
const results = [];
const check = (name, expected, actual) => { results.push({ name, expected, actual }); console.log(`[${expected === actual ? 'OK' : '!!'}] ${name} -> ${actual} (expected ${expected})`); };

try {
  const credsA = mkUser(); const credsB = mkUser();
  const { data: createdA } = await admin.auth.admin.createUser({ email: credsA.email, password: credsA.password, email_confirm: true });
  const { data: createdB } = await admin.auth.admin.createUser({ email: credsB.email, password: credsB.password, email_confirm: true });
  uidA = createdA.user.id; uidB = createdB.user.id;

  // A's report/section/export, created via admin client (as real generateReport() now does post-fix)
  const { data: report } = await admin.from('reports').insert({
    user_id: uidA, report_type_code: 'net_worth', report_period_start: '2026-08-01', report_period_end: '2026-08-31',
    report_month: '2026-08-01', as_of_date: '2026-08-24', title: 'victim report', status: 'ready', reporting_currency: 'AUD',
  }).select('*').single();
  const { data: section } = await admin.from('report_sections').insert({
    report_id: report.id, user_id: uidA, section_code: 'net_worth_summary', section_title: 'x', display_order: 1,
    section_status: 'included', section_data_json: { netWorth: 123456 },
  }).select('*').single();
  const { data: exportRow } = await admin.from('report_exports').insert({
    report_id: report.id, requested_by_user_id: uidA, export_format: 'pdf', status: 'ready', storage_path: `${uidA}/${report.id}/real.pdf`,
  }).select('*').single();

  console.log('victim report:', report.id, 'section:', section.id, 'export:', exportRow.id);

  const bClient = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  await bClient.auth.signInWithPassword({ email: credsB.email, password: credsB.password });

  const { data: readReport } = await bClient.from('reports').select('*').eq('id', report.id);
  check('B cannot list/read A report row', 0, readReport?.length ?? 0);

  const { data: readSection } = await bClient.from('report_sections').select('*').eq('id', section.id);
  check('B cannot read A report_sections row', 0, readSection?.length ?? 0);

  const { data: readExport } = await bClient.from('report_exports').select('*').eq('id', exportRow.id);
  check('B cannot read A report_exports row', 0, readExport?.length ?? 0);

  // B attempts a direct signed-URL style storage read of A's real object path
  const { data: signedForB, error: signErr } = await bClient.storage.from('report-exports').createSignedUrl(`${uidA}/${report.id}/real.pdf`, 60);
  check('B cannot create a signed URL for A storage object (client-side, non-service key)', true, !!signErr && !signedForB);

  // B attempts A's exports list endpoint semantics directly (report_exports filtered by report_id, not just id)
  const { data: listByReport } = await bClient.from('report_exports').select('*').eq('report_id', report.id);
  check('B cannot list A report_exports by report_id', 0, listByReport?.length ?? 0);

  const succeeded = results.filter((r) => r.expected !== r.actual);
  console.log(`\n${results.length - succeeded.length}/${results.length} checks matched expected (isolation held) — ${succeeded.length} unexpected result(s).`);
} finally {
  if (uidA) await admin.auth.admin.deleteUser(uidA).catch(() => {});
  if (uidB) await admin.auth.admin.deleteUser(uidB).catch(() => {});
  console.log('cleaned up both disposable users');
}
