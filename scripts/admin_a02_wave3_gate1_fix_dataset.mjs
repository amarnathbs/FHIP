// One-off addendum: completes the Gate 1 fixture dataset's missing fields so
// the live Validate action can be exercised on its "ready to activate"
// branch too (the initial fixture was deliberately incomplete to exercise
// the "not ready" branch first).
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

const datasetId = process.argv[2];
if (!datasetId) {
  console.error('Usage: node scripts/admin_a02_wave3_gate1_fix_dataset.mjs <datasetId>');
  process.exit(1);
}
const { error } = await admin
  .from('benchmark_datasets')
  .update({ source_period: '2026', geography_level: 'country', statistic_coverage: 'mean' })
  .eq('id', datasetId);
if (error) {
  console.error('FAILED', error.message);
  process.exit(1);
}
console.log('OK — dataset', datasetId, 'now has source_period/geography_level/statistic_coverage set');
