// R1.7C closure §22 — creates (or tears down) a disposable resource_admin
// auth user for real, authenticated browser-based Admin CMS QA. Mirrors the
// same-origin auth-bootstrap technique already proven in this project
// (tests/unit/resourcesR1_4LiveDev.test.ts), but grants a real password so
// the real /login form can be used in an actual browser session instead of
// a magic-link/token exchange, which better exercises the real UI.
//
//   npx tsx --env-file=.env.local scripts/resources/p0-content/admin-qa-bootstrap.ts create
//   npx tsx --env-file=.env.local scripts/resources/p0-content/admin-qa-bootstrap.ts destroy <user_id>

import { createClient } from '@supabase/supabase-js';
import { assertDevProject } from '../lib/env';

async function main() {
  const creds = assertDevProject();
  const supa = createClient(creds.url, creds.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const [cmd, arg] = process.argv.slice(2);

  if (cmd === 'create') {
    const email = `r17c-admin-qa-${Date.now()}@example.invalid`;
    const password = `R17c-QA-${Math.random().toString(36).slice(2, 10)}!Aa1`;
    const { data: created, error } = await supa.auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !created.user) { console.error('FATAL', error); process.exit(1); }
    const userId = created.user.id;

    const { error: roleErr } = await supa.from('resource_user_roles').insert({ user_id: userId, role: 'resource_admin', is_active: true });
    if (roleErr) { console.error('FATAL: could not grant resource_admin role', roleErr); process.exit(1); }

    console.log(JSON.stringify({ user_id: userId, email, password, role: 'resource_admin' }, null, 2));
  } else if (cmd === 'destroy' && arg) {
    await supa.from('resource_user_roles').delete().eq('user_id', arg);
    const { error } = await supa.auth.admin.deleteUser(arg);
    if (error) { console.error('WARNING: user delete failed', error); process.exit(1); }
    console.log(`Deleted disposable QA user ${arg} and its resource_user_roles row.`);
  } else {
    console.error('Usage: admin-qa-bootstrap.ts create | destroy <user_id>');
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
