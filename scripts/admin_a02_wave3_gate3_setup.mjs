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
if (!/vqycarelcoijzwlpkpcz/.test(env.NEXT_PUBLIC_SUPABASE_URL)) { console.error('not DEV'); process.exit(2); }
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const RUN = `a02w3g3-${Date.now().toString(36)}`;
const PASSWORD = 'Wave3-Gate3-Synthetic-2026!';
const email = `${RUN}-analyst@test.fhip.invalid`;
const { data: created, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
if (error) { console.error(error.message); process.exit(1); }
const userId = created.user.id;
await admin.from('user_profiles').upsert({ user_id: userId, country_of_residence: 'AU', country_confirmed_at: new Date().toISOString(), onboarding_completed: true, full_name: 'Wave 3 Gate 3 Synthetic' }, { onConflict: 'user_id' });
const { error: rErr } = await admin.from('resource_user_roles').insert({ user_id: userId, role: 'analyst' });
if (rErr) { console.error('role', rErr.message); process.exit(1); }
console.log(JSON.stringify({ email, password: PASSWORD, userId }, null, 2));
