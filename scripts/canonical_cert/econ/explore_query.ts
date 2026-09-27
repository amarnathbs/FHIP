/** Exploration helper: read-only service-role select, printed as JSON.  --table T --select cols --eq col=val[,col=val] [--limit N] */
import { select } from './lib';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
async function main() {
  const rows = await select(arg('--table')!, (q) => {
    let x = q.select(arg('--select') ?? '*');
    for (const kv of (arg('--eq') ?? '').split(',').filter(Boolean)) { const [k, v] = kv.split('='); x = x.eq(k, v); }
    for (const kv of (arg('--in') ?? '').split(';').filter(Boolean)) { const [k, v] = kv.split('='); x = x.in(k, v.split('|')); }
    if (arg('--order')) x = x.order(arg('--order')!);
    return x.limit(Number(arg('--limit') ?? 200));
  });
  console.log(args.includes('--compact') ? rows.map((r: unknown) => JSON.stringify(r)).join('\n') : JSON.stringify(rows, null, 1));
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
