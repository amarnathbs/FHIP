/**
 * Resources Bulk Upload -- READ-ONLY DEV inventory (re-certification pre-flight, 14-10-2026).
 *
 * Answers, without writing anything and without creating any user: which of migrations 0272 / 0273 (and, behaviourally,
 * 0274) are present on DEV, whether the tables the importer relies on exist, whether the DEV database still holds any
 * synthetic residue, and which EXISTING fixture users hold Resources roles (counts and masked addresses only).
 *
 *   npx tsx scripts/resources_bulk_upload_dev_inventory.ts
 *
 * DEV only (refuses any other project). PostgREST cannot read pg_catalog, so the function checks are behavioural: a
 * missing function is PGRST202 / 404, a present one answers with its own business error. 0274 has no behavioural
 * signature until a real apply returns db_ms; its catalog proof is the one query in the 0274 README that the PO runs.
 * Secrets are never printed.
 */
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const raw = fs.readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
const get = (k: string) => {
  const l = raw.split(/\r?\n/).find((x) => x.startsWith(`${k}=`));
  if (!l) throw new Error(`missing ${k}`);
  return l.slice(k.length + 1).trim();
};
const url = get('NEXT_PUBLIC_SUPABASE_URL');
if (!url.includes('vqycarelcoijzwlpkpcz') || url.includes('twwpnltizhtjxhamyoxt')) throw new Error('REFUSING: not the DEV project');
const admin = createClient(url, get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(url, get('NEXT_PUBLIC_SUPABASE_ANON_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
const Z = '00000000-0000-4000-8000-000000000000';
const U = '99999999-9999-4999-8999-999999999999';

const mask = (e: string | undefined) => (e ? e.replace(/^(.{2}).*(@.*)$/, '$1***$2') : '(none)');
const msg = (e: { message?: string; code?: string } | null) => (e ? `${e.code ?? ''} ${e.message ?? ''}`.trim() : 'ok');

async function exists(table: string): Promise<string> {
  const r = await admin.from(table).select('*', { count: 'exact', head: true });
  return r.error ? `MISSING/ERR ${msg(r.error)}` : `present (${r.count ?? 0} rows)`;
}

async function main() {
  console.log('--- tables the importer relies on (service role, head only) ---');
  for (const t of [
    'resource_content_import_runs',
    'resource_content_import_rows',
    'resource_posts',
    'resource_categories',
    'resource_tags',
    'resource_authors',
    'resource_sources',
    'resource_post_sources',
    'resource_ctas',
    'resource_post_versions',
    'resource_workflow_history',
    'resource_audit_log',
    'resource_user_roles',
  ]) console.log(`${t}: ${await exists(t)}`);

  console.log('--- 0272 functions / grants (behavioural) ---');
  const anonApply = await anon.rpc('apply_resource_content_import', { p_run_id: Z });
  console.log(`anon apply_resource_content_import: ${msg(anonApply.error)}  (permission denied = present and locked down)`);
  const lookup = await admin.rpc('resource_content_import_lookup', { p_slugs: [], p_content_ids: [], p_source_urls: [] });
  console.log(`service resource_content_import_lookup: ${msg(lookup.error)}`);
  const anonPurge = await anon.rpc('purge_expired_resource_content_import_staging');
  console.log(`anon purge_expired_resource_content_import_staging: ${msg(anonPurge.error)}  (permission denied = present and locked down)`);
  const anonRuns = await anon.from('resource_content_import_runs').select('id').limit(1);
  console.log(`anon select staging runs: ${anonRuns.error ? msg(anonRuns.error) : `${anonRuns.data?.length ?? 0} rows (RLS)`}`);

  console.log('--- 0273 twin (behavioural; refused before any write) ---');
  const t1 = await admin.rpc('apply_resource_content_import_as_actor', { p_run_id: Z, p_actor: null });
  console.log(`service as_actor, null actor: ${msg(t1.error)}  (NOT_AUTHENTICATED = present)`);
  const t2 = await anon.rpc('apply_resource_content_import_as_actor', { p_run_id: Z, p_actor: U });
  console.log(`anon as_actor: ${msg(t2.error)}  (permission denied = present, not callable by a browser)`);

  console.log('--- synthetic residue (read-only) ---');
  const runs = await admin.from('resource_content_import_runs').select('*', { count: 'exact', head: true });
  const rows = await admin.from('resource_content_import_rows').select('*', { count: 'exact', head: true });
  console.log(`import runs: ${runs.count ?? 'err'}, import rows: ${rows.count ?? 'err'}`);
  for (const tag of ['bulkcert', 'bulkbrw', 'bulkrecert', 'verify0272', 'verify0273', 'probe', 'timing']) {
    const p = await admin.from('resource_posts').select('*', { count: 'exact', head: true }).like('slug', `${tag}%`);
    const s = await admin.from('resource_sources').select('*', { count: 'exact', head: true }).like('source_name', `${tag}%`);
    console.log(`${tag}: posts ${p.count ?? 'err'}, sources ${s.count ?? 'err'}`);
  }

  console.log('--- existing fixture users with Resources roles (no writes; masked) ---');
  const roles = await admin.from('resource_user_roles').select('user_id, role, is_active').eq('is_active', true);
  if (roles.error) console.log(`roles: ${msg(roles.error)}`);
  const users = (await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })).data?.users ?? [];
  const byId = new Map(users.map((u) => [u.id, u]));
  const summary: Record<string, string[]> = {};
  for (const r of roles.data ?? []) {
    const u = byId.get(r.user_id as string);
    (summary[r.role as string] ??= []).push(mask(u?.email));
  }
  for (const [role, list] of Object.entries(summary)) console.log(`${role}: ${list.length} -> ${list.slice(0, 8).join(', ')}${list.length > 8 ? ' ...' : ''}`);
  const adminsRes = await admin.from('admin_users').select('user_id');
  console.log(`admin_users (super admins): ${adminsRes.data?.length ?? 'err'} -> ${(adminsRes.data ?? []).slice(0, 6).map((a) => mask(byId.get(a.user_id as string)?.email)).join(', ')}`);
  const fixtureDomain = users.filter((u) => /@fhip-test\.invalid$/.test(u.email ?? ''));
  console.log(`auth users on the reserved test domain @fhip-test.invalid: ${fixtureDomain.length}`);
  console.log(`total auth users: ${users.length}`);
}

void main();
