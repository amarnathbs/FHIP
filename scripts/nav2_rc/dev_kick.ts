// DEV only: runs the planned report-period fetch in this process (what the route starts after its response) and prints what it did. For a fixture user and the funds given.
//   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/nav2_rc/dev_kick.ts <user-id> <id>[,<id>...]
import { runUserNavHistoryForKick } from '../../lib/services/investment-intelligence/nav2/nav2TriggerRunner';

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  if (!url.includes('vqycarelcoijzwlpkpcz')) throw new Error('not DEV: refusing');
  if (Object.keys(process.env).some((k) => k.startsWith('PRODUCTION_'))) throw new Error('a PRODUCTION_ variable is present: refusing');
  const [userId, ids] = process.argv.slice(2);
  const t0 = Date.now();
  const out = (await runUserNavHistoryForKick(userId, {}, { kind: 'report_period_requested' }, 'since_first_held', ids.split(','))) as { action?: string; plan?: { fetch: { toFetch: unknown[]; inCooldown: string[]; deferred: string[]; alreadyCovered: string[] } }; executed?: unknown };
  console.log('ms', Date.now() - t0, 'action', out.action);
  console.log('plan toFetch', JSON.stringify(out.plan?.fetch.toFetch), 'inCooldown', out.plan?.fetch.inCooldown?.length, 'deferred', out.plan?.fetch.deferred?.length, 'covered', out.plan?.fetch.alreadyCovered?.length);
  console.log('executed', JSON.stringify(out.executed ?? null).slice(0, 1500));
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(2); });
