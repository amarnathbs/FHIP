// READ-ONLY: the NAV2 required-window plan for one user, exactly as the report path computes it (planForReportPeriod). Prints JSON.
//   npx tsx scripts/nav2_stage3/plan.ts <user-id> [period]            period: since_first_held (default) | all_history | ...
// Nothing is fetched or written. DEV only (the project ref is checked).
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const env: Record<string, string> = {};
for (const line of readFileSync(join(__dirname, '..', '..', '.env.local'), 'utf8').split(/\r?\n/)) { const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim()); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
if (new URL(env.NEXT_PUBLIC_SUPABASE_URL).host.split('.')[0] !== 'vqycarelcoijzwlpkpcz') throw new Error('not DEV');

async function main() {
  const { planForReportPeriod } = await import('../../lib/services/investment-intelligence/nav2/nav2TriggerRunner');
  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const today = new Date().toISOString().slice(0, 10);
  const plan = await planForReportPeriod(admin as never, process.argv[2], (process.argv[3] ?? 'since_first_held') as never, today);
  console.log(JSON.stringify({ today, policyVersion: plan.policyVersion, windows: plan.windows, fetch: plan.fetch, overrides: [...plan.requiredFromOverrides.entries()] }));
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
