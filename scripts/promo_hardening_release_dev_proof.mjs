// Promo / Premium hardening: the DEV PROOF against the real DEV Supabase project (real connections, real concurrency).
//
//   1. node scripts/promo_hardening_dev_fixtures.mjs create --out <file outside the repository>
//   2. node scripts/promo_hardening_release_dev_proof.mjs --confirm-dev --fixtures <that file>
//   3. node scripts/promo_hardening_dev_fixtures.mjs cleanup --out <that file>
//
// The checks themselves live in scripts/lib/promoHardeningProofCore.mjs and are ALSO run, with named negative controls, against a PGlite replay
// (tests/unit/promoHardeningProofCorePglite.test.ts), so this script is not run blind.
//
// SAFETY
//   * refuses unless --confirm-dev is given AND NEXT_PUBLIC_SUPABASE_URL is the DEV project (an allow list of exactly one ref);
//   * the digest and address secrets are read from the environment (.env.local) and used ONLY to compute keyed digests locally, as the
//     application does; they are never printed;
//   * it sends NO e-mail and changes no feature switch;
//   * it creates disposable users (promo-proof.invalid) and codes, disables every code it made (a code cannot be deleted by design) and deletes
//     its users. Append-only audit rows remain by design and are counted at the end.
//   * it prints only PASS / FAIL lines: never a code, a protected copy, a password or a secret.
//   * LIMIT: the e-mail request limits are per admin per hour and per day, and 300 recipients across ALL admins per day. One run uses about 100.
//     Run it at most twice on the same day on DEV.

import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { runProofs } from './lib/promoHardeningProofCore.mjs';

const DEV_REF = 'vqycarelcoijzwlpkpcz';

function loadEnv() {
  const env = { ...process.env };
  try {
    for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const i = line.indexOf('=');
      const k = line.slice(0, i);
      if (env[k] === undefined) env[k] = line.slice(i + 1).trim();
    }
  } catch {
    /* optional */
  }
  return env;
}

export function refusal(argv, env) {
  if (!argv.includes('--confirm-dev')) return 'Add --confirm-dev to confirm this runs against the DEV project.';
  const m = /^https:\/\/([a-z0-9]+)\.supabase\.co/i.exec(String(env.NEXT_PUBLIC_SUPABASE_URL ?? ''));
  if ((m ? m[1].toLowerCase() : null) !== DEV_REF) return 'NEXT_PUBLIC_SUPABASE_URL is not the DEV project. This script runs only against DEV.';
  for (const k of ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) if (!env[k]) return `${k} is missing.`;
  for (const k of ['PROMO_CODE_DIGEST_SECRET', 'PREMIUM_PROMO_EMAIL_BIND_SECRET']) if (!env[k] || env[k].length < 32) return `${k} is missing or shorter than 32 characters (the proof computes keyed values the way the application does).`;
  if (!argv.includes('--fixtures')) return 'Give --fixtures <the file written by promo_hardening_dev_fixtures.mjs create>.';
  return null;
}

function wrap(supabase) {
  return {
    async rpc(name, args) {
      const { data, error } = await supabase.rpc(name, args ?? {});
      return { data, error: error ? { message: error.message, code: error.code } : null };
    },
    async select(table, columns, match = {}) {
      let q = supabase.from(table).select(columns);
      for (const [k, v] of Object.entries(match)) q = q.eq(k, v);
      const { data, error } = await q;
      return { data, error: error ? { message: error.message, code: error.code } : null };
    },
    async tryWrite(kind, table, match, values = {}) {
      let q = kind === 'delete' ? supabase.from(table).delete() : supabase.from(table).update(values);
      for (const [k, v] of Object.entries(match)) q = q.eq(k, v);
      const { error } = await q;
      return { error: error ? { message: error.message } : null };
    },
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const env = loadEnv();
  const why = refusal(argv, env);
  if (why) {
    console.error(`REFUSED: ${why}`);
    process.exit(2);
  }
  const fixtures = JSON.parse(fs.readFileSync(argv[argv.indexOf('--fixtures') + 1], 'utf8'));
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };
  const serviceRaw = createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, opts);
  const anonRaw = createClient(url, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);

  const users = Object.fromEntries(fixtures.users.map((u) => [u.label, { id: u.id, email: u.email }]));
  const sessions = {};
  const asClient = (label) => {
    if (!sessions[label]) {
      const u = fixtures.users.find((x) => x.label === label);
      if (!u) throw new Error(`fixture ${label} is not in the fixtures file`);
      sessions[label] = (async () => {
        const probe = createClient(url, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, opts);
        const { data, error } = await probe.auth.signInWithPassword({ email: u.email, password: u.password });
        if (error) throw new Error(`sign in as ${label} failed`);
        return wrap(createClient(url, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { ...opts, global: { headers: { Authorization: `Bearer ${data.session.access_token}` } } }));
      })();
    }
    return sessions[label];
  };
  // The core calls ctx.as(label).rpc(...) synchronously, so give it a lazy client that signs in on first use.
  const lazy = (label) => ({
    rpc: async (...a) => (await asClient(label)).rpc(...a),
    select: async (...a) => (await asClient(label)).select(...a),
    tryWrite: async (...a) => (await asClient(label)).tryWrite(...a),
  });

  let pass = 0;
  let fail = 0;
  const record = (name, ok, detail = '') => {
    if (ok) pass += 1;
    else fail += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  [${detail}]`}`);
  };

  const ctx = {
    service: wrap(serviceRaw),
    anon: wrap(anonRaw),
    as: lazy,
    users,
    secrets: { digest: env.PROMO_CODE_DIGEST_SECRET, bind: env.PREMIUM_PROMO_EMAIL_BIND_SECRET },
    record,
    async newUser({ confirmed = true, email } = {}) {
      const address = email ?? `proof-${randomBytes(6).toString('hex')}@promo-proof.invalid`;
      const { data, error } = await serviceRaw.auth.admin.createUser({ email: address, email_confirm: confirmed, password: randomBytes(24).toString('base64url') });
      if (error || !data.user) throw new Error(`could not create a disposable user: ${error?.message}`);
      return { id: data.user.id, email: address };
    },
    async verifyUser(id) {
      const { error } = await serviceRaw.auth.admin.updateUserById(id, { email_confirm: true });
      if (error) throw new Error('could not verify the disposable user');
    },
  };

  let made = { codeIds: [], userIds: [] };
  try {
    const out = await runProofs(ctx);
    made = out.created;
    console.log(`\nstage: ${out.stage}`);
  } catch (e) {
    fail += 1;
    console.log(`FAIL  unexpected error: ${e instanceof Error ? e.message : 'error'}`);
  } finally {
    console.log('\n=== cleanup ===');
    for (const id of made.codeIds) {
      const r = await (await asClient('promo')).rpc('admin_disable_promo_code', { p_id: id, p_reason: 'promo hardening DEV proof finished, disabling the probe code' });
      if (r.error && !/already|not active|PROMO_NOT_FOUND/i.test(r.error.message)) console.log(`  note: could not disable one probe code (${r.error.message})`);
    }
    let deleted = 0;
    for (const id of made.userIds) {
      const { error } = await serviceRaw.auth.admin.deleteUser(id);
      if (!error) deleted += 1;
    }
    console.log(`  disposable users deleted: ${deleted} of ${made.userIds.length}; probe codes disabled: ${made.codeIds.length} (a code cannot be deleted by design)`);
    const events = await serviceRaw.from('admin_monitoring_events').select('id', { count: 'exact', head: true });
    console.log(`  append-only rows remain by design: admin_monitoring_events=${events.count ?? '?'} (alerts), plus the audit rows of the grants and codes this run made`);
  }
  console.log(`\nPROMO HARDENING DEV PROOF: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

if (process.argv[1] && process.argv[1].endsWith('promo_hardening_release_dev_proof.mjs')) {
  main().catch((e) => {
    console.error(`failed: ${e instanceof Error ? e.message : 'error'}`);
    process.exit(1);
  });
}
