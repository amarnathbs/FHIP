/**
 * Behavioural verification that migration 0273 is applied on DEV as written (PostgREST cannot read pg_catalog; the PO's
 * own check output remains the catalog-level proof). Writes only a synthetic user, removed again. DEV only.
 *
 *   npx tsx scripts/resources_bulk_upload_verify_0273_dev.ts
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
const RUN0 = '00000000-0000-4000-8000-000000000000';
const out: { name: string; pass: boolean; detail?: string }[] = [];
const check = (name: string, pass: boolean, detail = '') => {
  out.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${!pass && detail ? `  -- ${detail}` : ''}`);
};

async function main() {
  const t = await admin.rpc('apply_resource_content_import_as_actor', { p_run_id: RUN0, p_actor: null });
  check('0273 twin exists and answers the service role (null actor refused: NOT_AUTHENTICATED)', !!t.error && /NOT_AUTHENTICATED/.test(t.error.message), JSON.stringify(t.error));
  const u = await admin.rpc('apply_resource_content_import_as_actor', { p_run_id: RUN0, p_actor: '99999999-9999-4999-8999-999999999999' });
  check('twin: an unknown actor is refused FORBIDDEN by the database re-check (capability) even from the service role', !!u.error && /FORBIDDEN/.test(u.error.message), JSON.stringify(u.error));
  const a = await anon.rpc('apply_resource_content_import_as_actor', { p_run_id: RUN0, p_actor: '99999999-9999-4999-8999-999999999999' });
  check('twin: anon is refused (permission denied): a browser cannot name an actor', !!a.error && /permission denied/i.test(a.error.message), JSON.stringify(a.error));

  const email = `verify0273${Date.now().toString(36)}@fhip-test.invalid`;
  const password = `V!${Math.random().toString(36).slice(2)}Zz9${Date.now()}`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  const uid = created.data.user!.id;
  try {
    const sess = await (await fetch(`${URL_}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).json();
    const user = createClient(URL_, ANON, { global: { headers: { Authorization: `Bearer ${sess.access_token}` } }, auth: { autoRefreshToken: false, persistSession: false } });
    const own = await user.rpc('apply_resource_content_import_as_actor', { p_run_id: RUN0, p_actor: uid });
    check('twin: a SIGNED-IN person naming THEMSELVES is still refused (permission denied): only the server can call it', !!own.error && /permission denied/i.test(own.error.message), JSON.stringify(own.error));
    const normal = await user.rpc('apply_resource_content_import', { p_run_id: RUN0 });
    check('the normal signed-in function still answers (no capability: FORBIDDEN)', !!normal.error && /FORBIDDEN/.test(normal.error.message), JSON.stringify(normal.error));
    const asUser = await admin.rpc('apply_resource_content_import_as_actor', { p_run_id: RUN0, p_actor: uid });
    check('twin: a real user WITHOUT the capability named by the server is refused FORBIDDEN', !!asUser.error && /FORBIDDEN/.test(asUser.error.message), JSON.stringify(asUser.error));
  } finally {
    await admin.auth.admin.deleteUser(uid);
  }
  const priv = await fetch(`${URL_}/rest/v1/rpc/apply_resource_content_import_core`, { method: 'POST', headers: { apikey: ANON, 'content-type': 'application/json', 'Content-Profile': 'private' }, body: JSON.stringify({ p_run_id: RUN0, p_actor: RUN0 }) });
  check('the private core is not reachable through the API at all', priv.status >= 400, `${priv.status}`);
}

main()
  .catch((e) => check('probe completed without a fatal error', false, String(e)))
  .finally(() => {
    const failed = out.filter((r) => !r.pass);
    console.log(`\n${out.length - failed.length}/${out.length} probes passed`);
    process.exit(failed.length ? 1 : 0);
  });
