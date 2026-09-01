// Admin A0.2 Wave 3 — Gate 1/Gate 3 live-DEV verification: FIXTURE CLEANUP.
//
// Removes every synthetic fixture created by admin_a02_wave3_gate1_setup.mjs
// and admin_a02_wave3_gate3_setup.mjs, and reconciles benchmark_sources /
// benchmark_datasets counts before and after so any unrelated variance is
// caught rather than assumed absent.
//
// Usage: node scripts/admin_a02_wave3_gate1_cleanup.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
function loadEnv() {
  const env = {};
  for (const line of fs.readFileSync(path.join(repoRoot, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnv();
if (!/vqycarelcoijzwlpkpcz/.test(env.NEXT_PUBLIC_SUPABASE_URL)) {
  console.error('REFUSING TO RUN: not the certified DEV project.');
  process.exit(2);
}
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

async function count(table) {
  const { count: n, error } = await admin.from(table).select('*', { count: 'exact', head: true });
  if (error) throw error;
  return n;
}

async function main() {
  const before = {
    sources: await count('benchmark_sources'),
    datasets: await count('benchmark_datasets'),
  };

  // Sweep by the shared `a02w3`/`a02w3g3` prefix rather than trusting a
  // hand-maintained id list, so a fixture from an earlier, interrupted run
  // is caught too.
  const { data: fixtureSources } = await admin.from('benchmark_sources').select('id').ilike('source_name', 'a02w3%');
  const { data: fixtureDatasets } = await admin.from('benchmark_datasets').select('id').ilike('dataset_name', 'a02w3%');

  for (const d of fixtureDatasets ?? []) {
    const { error } = await admin.from('benchmark_datasets').delete().eq('id', d.id);
    if (error) throw new Error(`delete dataset ${d.id}: ${error.message}`);
  }
  for (const s of fixtureSources ?? []) {
    const { error } = await admin.from('benchmark_sources').delete().eq('id', s.id);
    if (error) throw new Error(`delete source ${s.id}: ${error.message}`);
  }

  // Synthetic users: list and delete every auth user whose email matches the
  // Gate 1/Gate 3 prefixes, cleaning up user_profiles/admin_users/
  // resource_user_roles via the same id (FK cascade covers most of this, but
  // deleted explicitly first for a clean, auditable log either way).
  const { data: userList, error: listErr } = await admin.auth.admin.listUsers({ perPage: 200 });
  if (listErr) throw listErr;
  const fixtureUsers = (userList?.users ?? []).filter((u) => /^a02w3g?3?-.*@test\.fhip\.invalid$/.test(u.email ?? '') || /^a02w3-.*@test\.fhip\.invalid$/.test(u.email ?? ''));

  for (const u of fixtureUsers) {
    await admin.from('admin_users').delete().eq('user_id', u.id);
    await admin.from('resource_user_roles').delete().eq('user_id', u.id);
    await admin.from('user_profiles').delete().eq('user_id', u.id);
    const { error } = await admin.auth.admin.deleteUser(u.id);
    if (error) throw new Error(`delete user ${u.id} (${u.email}): ${error.message}`);
  }

  const after = {
    sources: await count('benchmark_sources'),
    datasets: await count('benchmark_datasets'),
  };

  // Re-sweep to prove zero residue, not just trust the delete calls above.
  const { data: residualSources } = await admin.from('benchmark_sources').select('id').ilike('source_name', 'a02w3%');
  const { data: residualDatasets } = await admin.from('benchmark_datasets').select('id').ilike('dataset_name', 'a02w3%');
  const { data: residualUserList } = await admin.auth.admin.listUsers({ perPage: 200 });
  const residualUsers = (residualUserList?.users ?? []).filter((u) => (u.email ?? '').includes('a02w3') && u.email.endsWith('@test.fhip.invalid'));

  console.log(
    JSON.stringify(
      {
        before,
        after,
        fixturesRemoved: { sources: fixtureSources?.length ?? 0, datasets: fixtureDatasets?.length ?? 0, users: fixtureUsers.length },
        residualCheck: { sources: residualSources?.length ?? 0, datasets: residualDatasets?.length ?? 0, users: residualUsers.length },
        clean: (residualSources?.length ?? 0) === 0 && (residualDatasets?.length ?? 0) === 0 && residualUsers.length === 0,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error('CLEANUP FAILED:', err.message);
  process.exit(1);
});
