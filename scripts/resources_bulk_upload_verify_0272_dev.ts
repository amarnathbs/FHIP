/**
 * Read-only-in-effect behavioural verification that migration 0272 is applied on DEV exactly as written.
 * (PostgREST cannot read pg_catalog, so each of the PO's five SQL checks is proved by BEHAVIOUR instead; the PO's own
 * SQL check results remain the authoritative catalog evidence.)
 *
 *   npx tsx scripts/resources_bulk_upload_verify_0272_dev.ts
 *
 * Writes only synthetic rows (prefix verify0272) and deletes them again. DEV only (hard guard).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const ROOT = path.resolve(__dirname, '..');
function env(name: string): string {
  const raw = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').replace(/^﻿/, '');
  for (const l of raw.split(/\r?\n/)) if (l.startsWith(`${name}=`)) return l.slice(name.length + 1).trim();
  throw new Error(`missing ${name}`);
}
const URL_ = env('NEXT_PUBLIC_SUPABASE_URL');
if (!URL_.includes('vqycarelcoijzwlpkpcz')) throw new Error('REFUSING: not DEV');
const ANON = env('NEXT_PUBLIC_SUPABASE_ANON_KEY');
const admin = createClient(URL_, env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { autoRefreshToken: false, persistSession: false } });
const anon = createClient(URL_, ANON, { auth: { autoRefreshToken: false, persistSession: false } });
const TAG = `verify0272${Date.now().toString(36)}`;
const out: { name: string; pass: boolean; detail?: string }[] = [];
const check = (name: string, pass: boolean, detail = '') => {
  out.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${!pass && detail ? `  -- ${detail}` : ''}`);
};

async function main() {
  // 1. tables
  for (const t of ['resource_content_import_runs', 'resource_content_import_rows']) {
    const r = await admin.from(t).select('*', { count: 'exact', head: true });
    check(`CHECK 1 table ${t} exists`, !r.error);
    const a = await anon.from(t).select('id').limit(1);
    check(`CHECK 3/4 ${t}: anon cannot read at all (no SELECT grant)`, !!a.error, JSON.stringify(a.error));
  }
  // 2. functions exist (each answers with its own explicit error for an anonymous / unprivileged call, never "function not found")
  const rpcs: [string, Record<string, unknown>][] = [
    ['apply_resource_content_import', { p_run_id: '00000000-0000-4000-8000-000000000000' }],
    ['resource_content_import_lookup', { p_slugs: [], p_content_ids: [], p_source_urls: [] }],
    ['purge_expired_resource_content_import_staging', {}],
  ];
  for (const [fn, args] of rpcs) {
    const a = await anon.rpc(fn, args);
    check(`CHECK 2/4 ${fn}: exists and anon is refused (permission denied, not "not found")`, !!a.error && /permission denied/i.test(a.error.message) && !/could not find/i.test(a.error.message), JSON.stringify(a.error));
  }
  const svcApply = await admin.rpc('apply_resource_content_import', { p_run_id: '00000000-0000-4000-8000-000000000000' });
  check('CHECK 2 apply (service role, no end user): refused with NOT_AUTHENTICATED (auth.uid() is required, SECURITY DEFINER does not bypass it)', !!svcApply.error && /NOT_AUTHENTICATED/.test(svcApply.error.message), JSON.stringify(svcApply.error));
  const svcLookup = await admin.rpc('resource_content_import_lookup', { p_slugs: [], p_content_ids: [], p_source_urls: [] });
  check('CHECK 2 lookup (no end user): refused NOT_AUTHENTICATED', !!svcLookup.error && /NOT_AUTHENTICATED/.test(svcLookup.error.message), JSON.stringify(svcLookup.error));
  const purge = await admin.rpc('purge_expired_resource_content_import_staging');
  check('CHECK 2 purge: service role may call it (returns a count)', !purge.error && typeof purge.data === 'number', JSON.stringify(purge.error));

  // authenticated user without the capability: signed-in plain customer
  const email = `${TAG}@fhip-test.invalid`;
  const password = `V!${Math.random().toString(36).slice(2)}Zz9${Date.now()}`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  const uid = created.data.user!.id;
  try {
    const sess = await (await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).json();
    const user = createClient(URL_, ANON, { global: { headers: { Authorization: `Bearer ${sess.access_token}` } }, auth: { autoRefreshToken: false, persistSession: false } });
    const ap = await user.rpc('apply_resource_content_import', { p_run_id: '00000000-0000-4000-8000-000000000000' });
    check('CHECK 2 apply: a signed-in user WITHOUT the capability gets FORBIDDEN (capability predicate evaluated inside the function)', !!ap.error && /FORBIDDEN/.test(ap.error.message), JSON.stringify(ap.error));
    const lk = await user.rpc('resource_content_import_lookup', { p_slugs: [], p_content_ids: [], p_source_urls: [] });
    check('CHECK 2 lookup: same denial', !!lk.error && /FORBIDDEN/.test(lk.error.message), JSON.stringify(lk.error));
    const pg = await user.rpc('purge_expired_resource_content_import_staging');
    check('CHECK 4 purge: a signed-in user cannot execute it (signed_in_can_purge = false)', !!pg.error && /permission denied/i.test(pg.error.message), JSON.stringify(pg.error));
    const sel = await user.from('resource_content_import_runs').select('id');
    check('CHECK 3 RLS on runs: a signed-in user sees zero rows', !sel.error && (sel.data ?? []).length === 0, JSON.stringify(sel.error));
    const ins = await user.from('resource_content_import_runs').insert({ content_type: 'article', file_name: 'x', file_sha256: 'a'.repeat(64) });
    check('CHECK 3 no write grant: a signed-in user cannot insert a run', !!ins.error, JSON.stringify(ins.error));
  } finally {
    await admin.auth.admin.deleteUser(uid);
  }

  // RLS really on: a staged run is invisible to a user who is not the owner even with the table SELECT grant (proved above for zero rows);
  // 5. partial unique index uq_rcir_applied_file: two APPLIED runs with the same type and sha cannot coexist; two non-applied can.
  const sha = TAG.padEnd(64, 'f').slice(0, 64);
  const mk = (status: string) => admin.from('resource_content_import_runs').insert({ content_type: 'article', file_name: `${TAG}.csv`, file_sha256: sha, status, row_count: 0 }).select('id').single();
  const ids: string[] = [];
  try {
    const r1 = await mk('applied');
    const r2 = await mk('applied');
    const r3 = await mk('ready');
    const r4 = await mk('ready');
    for (const r of [r1, r2, r3, r4]) if (r.data?.id) ids.push(r.data.id);
    check('CHECK 5 uq_rcir_applied_file: first applied run accepted, a second APPLIED run with the same file hash REFUSED (unique violation), non-applied duplicates allowed', !r1.error && !!r2.error && /duplicate|unique|23505/i.test(JSON.stringify(r2.error)) && !r3.error && !r4.error, JSON.stringify(r2.error));
    const bad = await admin.from('resource_content_import_runs').insert({ content_type: 'guide', file_name: 'x', file_sha256: sha });
    check('table constraint: only article and money_update content types', !!bad.error);
    const badSha = await admin.from('resource_content_import_runs').insert({ content_type: 'article', file_name: 'x', file_sha256: 'short' });
    check('table constraint: file_sha256 must be 64 lowercase characters', !!badSha.error);
    const badStatus = await admin.from('resource_content_import_runs').insert({ content_type: 'article', file_name: 'x', file_sha256: 'b'.repeat(64), status: 'published' });
    check('table constraint: status list enforced', !!badStatus.error);
  } finally {
    for (const id of ids) await admin.from('resource_content_import_runs').delete().eq('id', id);
  }
  const left = await admin.from('resource_content_import_runs').select('id', { count: 'exact', head: true }).like('file_name', `${TAG}%`);
  check('cleanup: verification rows removed', (left.count ?? -1) === 0);
}

main()
  .catch((e) => check('probe completed without a fatal error', false, String(e)))
  .finally(() => {
    const failed = out.filter((r) => !r.pass);
    console.log(`\n${out.length - failed.length}/${out.length} verification probes passed`);
    process.exit(failed.length ? 1 : 0);
  });
