// R10 — live-DEV reproduction of a pre-existing same-user authoritative-write
// gap on the `reports` / `report_sections` / `report_snapshots` /
// `report_exports` family. RLS on these tables (migration 0010) has never
// been hardened since: every policy is a single
//   for all using (auth.uid() = user_id) with check (auth.uid() = user_id)
// which enforces row ownership but not column/transition authority — the
// exact defect class this project has already found and fixed repeatedly
// (ii_review_items 0069, ii_tax_lots 0062, fdh_statement_uploads 0065).
//
// This script creates ONE disposable test user, has them create a genuine
// report via a direct table insert exactly as generateReport() does (same
// RLS-scoped path), then — authenticated as that SAME real user via a real
// JWT (not anon, not service-role) — attempts direct REST forgery:
//   1. PATCH reports.status: 'ready' -> 'published' WITHOUT going through
//      publishReport()'s guarded update (also forges data_completeness_pct
//      and financial_snapshot_id in the same request).
//   2. PATCH report_sections.section_data_json / narrative_text on an owned
//      section row — i.e. rewrite the displayed financial numbers/narrative
//      directly.
//   3. INSERT a brand new report_snapshots row with a fabricated
//      source_version, unrelated to anything the report engine produced.
// All three are expected to currently SUCCEED (RED / vulnerable). The
// script also positively confirms it is really writing as the authenticated
// user, not service-role, by using the anon key + user JWT for every
// mutating call.
//
// Cleans up the disposable auth user (and its cascade-deleted rows) at the
// end regardless of outcome.
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;

const admin = createClient(URL, SERVICE, { auth: { autoRefreshToken: false, persistSession: false } });

const results = [];
function record(name, expected, actual, detail) {
  results.push({ name, expected, actual, verdict: actual === expected ? 'MATCHES-EXPECTED' : 'UNEXPECTED', detail });
  console.log(`[${actual === expected ? 'OK' : '!!'}] ${name} -> ${actual} (expected ${expected}) ${detail ?? ''}`);
}

const testEmail = `r10-repro-${Date.now()}@fhip-test.invalid`;
const testPassword = `Test-${Math.random().toString(36).slice(2)}-Aa1!`;
let userId;

try {
  console.log('--- creating disposable test user ---');
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: testEmail,
    password: testPassword,
    email_confirm: true,
  });
  if (createErr) throw new Error(`create user failed: ${createErr.message}`);
  userId = created.user.id;
  console.log('userId:', userId);

  await admin.from('user_entitlements').update({ plan_tier: 'free' }).eq('user_id', userId);

  console.log('--- signing in as that user (anon key, real session, real JWT) ---');
  const userClient = createClient(URL, ANON, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error: signInErr } = await userClient.auth.signInWithPassword({ email: testEmail, password: testPassword });
  if (signInErr) throw new Error(`sign-in failed: ${signInErr.message}`);
  console.log('session acquired, role should be authenticated');

  console.log('--- creating one genuine report row as this user (their own legitimate RLS-scoped insert) ---');
  const { data: report, error: reportErr } = await userClient
    .from('reports')
    .insert({
      user_id: userId,
      report_type_code: 'net_worth',
      report_period_start: '2026-08-01',
      report_period_end: '2026-08-31',
      report_month: '2026-08-01',
      as_of_date: '2026-08-24',
      title: 'R10 repro test report',
      status: 'ready',
      reporting_currency: 'AUD',
      data_completeness_pct: 40,
    })
    .select('*')
    .single();
  if (reportErr) throw new Error(`legit report insert failed unexpectedly: ${reportErr.message}`);
  console.log('report id:', report.id, 'status:', report.status);

  const { data: section, error: sectionErr } = await userClient
    .from('report_sections')
    .insert({
      report_id: report.id,
      user_id: userId,
      section_code: 'net_worth_summary',
      section_title: 'Net Worth Summary',
      display_order: 1,
      section_status: 'included',
      section_data_json: { netWorth: 100000, currency: 'AUD' },
      narrative_text: 'Your net worth is a genuine, engine-computed figure.',
    })
    .select('*')
    .single();
  if (sectionErr) throw new Error(`legit section insert failed unexpectedly: ${sectionErr.message}`);
  console.log('section id:', section.id);

  console.log('\n=== ATTACK 1: forge reports.status ready -> published, bypassing publishReport() guard, plus forge data_completeness_pct ===');
  const { data: attack1, error: attack1Err } = await userClient
    .from('reports')
    .update({ status: 'published', published_at: new Date().toISOString(), data_completeness_pct: 100, financial_snapshot_id: '00000000-0000-0000-0000-000000000000' })
    .eq('id', report.id)
    .select('*')
    .maybeSingle();
  record(
    'ATTACK-1 forge report status/completeness/snapshot ref',
    'BLOCKED-BY-RLS',
    attack1Err ? 'BLOCKED-BY-RLS' : (attack1 && attack1.status === 'published' ? 'FORGERY-SUCCEEDED' : 'BLOCKED-BY-RLS'),
    attack1Err ? attack1Err.message : JSON.stringify(attack1)
  );

  console.log('\n=== ATTACK 2: forge report_sections.section_data_json / narrative_text directly (rewrite displayed financial numbers) ===');
  const { data: attack2, error: attack2Err } = await userClient
    .from('report_sections')
    .update({ section_data_json: { netWorth: 99999999, currency: 'AUD', forged: true }, narrative_text: 'FORGED: you are a billionaire.' })
    .eq('id', section.id)
    .select('*')
    .maybeSingle();
  record(
    'ATTACK-2 forge report_sections financial numbers/narrative',
    'BLOCKED-BY-RLS',
    attack2Err ? 'BLOCKED-BY-RLS' : (attack2 && attack2.section_data_json?.forged === true ? 'FORGERY-SUCCEEDED' : 'BLOCKED-BY-RLS'),
    attack2Err ? attack2Err.message : JSON.stringify(attack2)
  );

  console.log('\n=== ATTACK 3: insert a fabricated report_snapshots row with fake provenance ===');
  const { data: attack3, error: attack3Err } = await userClient
    .from('report_snapshots')
    .insert({
      report_id: report.id,
      user_id: userId,
      snapshot_type: 'financial',
      source_version: 'forged-engine-9.9.9',
      snapshot_metadata_json: { forged: true },
    })
    .select('*')
    .maybeSingle();
  record(
    'ATTACK-3 forge report_snapshots provenance row',
    'BLOCKED-BY-RLS',
    attack3Err ? 'BLOCKED-BY-RLS' : (attack3 ? 'FORGERY-SUCCEEDED' : 'BLOCKED-BY-RLS'),
    attack3Err ? attack3Err.message : JSON.stringify(attack3)
  );

  console.log('\n=== ATTACK 4: insert a fabricated report_exports row claiming a ready PDF with an arbitrary storage_path (no real render) ===');
  const { data: attack4, error: attack4Err } = await userClient
    .from('report_exports')
    .insert({
      report_id: report.id,
      requested_by_user_id: userId,
      export_format: 'pdf',
      status: 'ready',
      storage_path: `${userId}/${report.id}/forged-not-a-real-render.pdf`,
      file_name: 'forged.pdf',
    })
    .select('*')
    .maybeSingle();
  record(
    'ATTACK-4 forge report_exports ready status + arbitrary storage_path',
    'BLOCKED-BY-RLS',
    attack4Err ? 'BLOCKED-BY-RLS' : (attack4 && attack4.status === 'ready' ? 'FORGERY-SUCCEEDED' : 'BLOCKED-BY-RLS'),
    attack4Err ? attack4Err.message : JSON.stringify(attack4)
  );

  console.log('\n=== ATTACK 5: forge report_generation_runs.output_status (audit trail) ===');
  const { data: runRow } = await admin.from('report_generation_runs').insert({ user_id: userId, trigger_type: 'manual', output_status: 'started' }).select('id').single();
  const { data: attack5, error: attack5Err } = await userClient
    .from('report_generation_runs')
    .update({ output_status: 'succeeded', failure_details: null })
    .eq('id', runRow.id)
    .select('*')
    .maybeSingle();
  record(
    'ATTACK-5 forge report_generation_runs audit outcome',
    'BLOCKED-BY-RLS',
    attack5Err ? 'BLOCKED-BY-RLS' : (attack5 && attack5.output_status === 'succeeded' ? 'FORGERY-SUCCEEDED' : 'BLOCKED-BY-RLS'),
    attack5Err ? attack5Err.message : JSON.stringify(attack5)
  );

  console.log('\n=== summary ===');
  const succeeded = results.filter((r) => r.actual === 'FORGERY-SUCCEEDED');
  console.log(`${succeeded.length}/${results.length} forgery attacks succeeded (pre-fix baseline).`);
  fs.writeFileSync(path.join(ROOT, 'scripts', 'r10-repro-reports-forgery-results.json'), JSON.stringify({ userId, results }, null, 2));
} finally {
  if (userId) {
    console.log('\n--- cleaning up disposable test user (cascades all rows) ---');
    await admin.auth.admin.deleteUser(userId).catch((e) => console.error('cleanup failed:', e.message));
  }
}
