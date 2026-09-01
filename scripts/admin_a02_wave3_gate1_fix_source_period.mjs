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
const sourceId = process.argv[2];
const { error } = await admin.from('benchmark_sources').update({ publication_date: '2026-01-01' }).eq('id', sourceId);
if (error) { console.error('FAILED', error.message); process.exit(1); }
console.log('OK');
