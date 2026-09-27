/** Exploration helper: one app call as the signed-in user.  --email E --method M --route R [--json '{...}'] [--csv file --ct text/csv] [--max N] */
import fs from 'node:fs';
import { call, measure } from './lib';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
async function main() {
  const email = arg('--email')!;
  if (args.includes('--measure')) { console.log(JSON.stringify(await measure(email), (k, v) => (k === 'raw' ? undefined : v), 1)); return; }
  const opts: Record<string, unknown> = {};
  if (arg('--json')) opts.json = JSON.parse(arg('--json')!);
  if (arg('--file')) { opts.body = fs.readFileSync(arg('--file')!); opts.contentType = arg('--ct') ?? 'text/csv'; }
  // Routes are passed WITHOUT the leading slash (Git Bash rewrites a leading "/" into a Windows path).
  const route = arg('--route')!.replace(/^.*?(api\/)/, '/$1');
  const r = await call(email, arg('--method') ?? 'GET', route, opts);
  console.log(`HTTP ${r.status}`);
  console.log(r.json ? JSON.stringify(r.json, null, 1).slice(0, Number(arg('--max') ?? 6000)) : r.text.slice(0, 2000));
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
