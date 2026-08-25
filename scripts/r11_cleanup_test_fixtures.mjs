// Deletes only R11 synthetic test fixtures (users whose email matches the
// R11 live-test naming convention). Cascades handle household/ii_*/
// professional_* rows automatically (all FK'd to auth.users ON DELETE
// CASCADE, verified in migrations 0032/0033/0083 etc). Never touches
// unrelated users from other concurrent workstreams in this shared DEV DB.
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const env = Object.fromEntries(fs.readFileSync('.env.local', 'utf8').split('\n').filter(l => l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const PATTERNS = ['r11-live-', 'r11-prof-'];

async function main() {
  let page = 1;
  const toDelete = [];
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    if (!data.users.length) break;
    for (const u of data.users) {
      if (u.email && PATTERNS.some((p) => u.email.includes(p))) toDelete.push(u);
    }
    if (data.users.length < 200) break;
    page += 1;
  }
  console.log(`Found ${toDelete.length} R11 synthetic test users to delete.`);
  let deleted = 0;
  let failed = 0;
  for (const u of toDelete) {
    const { error } = await admin.auth.admin.deleteUser(u.id);
    if (error) {
      failed += 1;
      console.log(`FAILED to delete ${u.email} (${u.id}): ${error.message}`);
    } else {
      deleted += 1;
    }
  }
  console.log(`Deleted ${deleted}/${toDelete.length} R11 synthetic test users (${failed} failed).`);

  // Independently verify zero remaining rows in every R11-owned table scoped
  // to synthetic data (spec section 56's explicit checklist).
  const checks = [
    ['professional_profiles', 'professional test users'],
    ['professional_relationships', 'professional relationships'],
    ['professional_permission_scopes', 'permission scope grants'],
    ['professional_consent_audit', 'consent fixtures'],
    ['professional_notes', 'professional notes'],
    ['professional_report_access_log', 'report access log rows'],
  ];
  for (const [table] of checks) {
    const { count, error } = await admin.from(table).select('id', { count: 'exact', head: true });
    console.log(`${table}: ${error ? `ERROR ${error.message}` : count} rows remaining (includes non-R11 rows if any exist)`);
  }

  const { count: remainingUsers } = await (async () => {
    let p = 1;
    let n = 0;
    for (;;) {
      const { data } = await admin.auth.admin.listUsers({ page: p, perPage: 200 });
      if (!data || !data.users.length) break;
      n += data.users.filter((u) => u.email && PATTERNS.some((pat) => u.email.includes(pat))).length;
      if (data.users.length < 200) break;
      p += 1;
    }
    return { count: n };
  })();
  console.log(`Remaining R11 synthetic test users (should be 0): ${remainingUsers}`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
