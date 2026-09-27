/**
 * One request to the LOCALHOST app as the signed-in user; prints status + JSON (truncated).
 *   npx tsx scripts/canonical_cert/golden_pair/call.ts --email e --port 3971 --method DELETE --route /api/liabilities/<id> [--json '{...}']
 */
import { api } from '../lib/session.mjs';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
async function main() {
  const r = await api(arg('--email')!, arg('--method') ?? 'GET', arg('--route')!, { port: Number(arg('--port')), json: arg('--json') ? JSON.parse(arg('--json')!) : undefined });
  console.log(r.status, (r.json ? JSON.stringify(r.json) : r.text).slice(0, Number(arg('--max') ?? 1500)));
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
