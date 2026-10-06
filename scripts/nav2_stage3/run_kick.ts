// DEV only: run exactly what the post-response kick runs (runUserNavHistoryForKick, planner path) for one user, in-process, and print the result.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const env: Record<string, string> = {};
for (const line of readFileSync(join(__dirname, '..', '..', '.env.local'), 'utf8').split(/\r?\n/)) { const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim()); if (m) { env[m[1]] = m[2].replace(/^["']|["']$/g, ''); process.env[m[1]] ??= env[m[1]]; } }
if (new URL(env.NEXT_PUBLIC_SUPABASE_URL).host.split('.')[0] !== 'vqycarelcoijzwlpkpcz') throw new Error('not DEV');
async function main() {
  const { runUserNavHistoryForKick } = await import('../../lib/services/investment-intelligence/nav2/nav2TriggerRunner');
  const res = await runUserNavHistoryForKick(process.argv[2], { isPlannerOn: async () => true }, { kind: 'report_period_requested' }, 'since_first_held');
  console.log(JSON.stringify(res, (k, v) => (v instanceof Map ? [...v.entries()] : v)).slice(0, 4000));
}
main().catch((e) => { console.error('ERR', e instanceof Error ? e.stack : e); process.exit(1); });
