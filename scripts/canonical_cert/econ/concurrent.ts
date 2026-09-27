/* eslint-disable @typescript-eslint/no-explicit-any -- certification harness: untyped JSON route responses */
/**
 * TRUE concurrency probe: fire N identical app calls at once (each its own HTTP request -> its own
 * route invocation -> its own PostgREST request / DB transaction), record start/end timestamps so the
 * overlap is PROVEN (every call started before any call finished), and print every response.
 *
 *   npx tsx scripts/canonical_cert/econ/concurrent.ts --email E --route api/... --json '{...}' [--n 2] [--tag name]
 */
import { call, saveEvidence } from './lib';

export interface TimedResult { i: number; startedAt: number; endedAt: number; status: number; json: any }

export async function fireConcurrently(n: number, fn: (i: number) => Promise<{ status: number; json: any }>): Promise<{ results: TimedResult[]; overlapped: boolean }> {
  const gate: { open?: () => void } = {};
  const opened = new Promise<void>((r) => { gate.open = r; });
  const runs = Array.from({ length: n }, async (_, i) => {
    await opened;
    const startedAt = performance.now();
    const r = await fn(i);
    return { i, startedAt, endedAt: performance.now(), status: r.status, json: r.json };
  });
  gate.open!();
  const results = await Promise.all(runs);
  const lastStart = Math.max(...results.map((r) => r.startedAt));
  const firstEnd = Math.min(...results.map((r) => r.endedAt));
  return { results, overlapped: lastStart < firstEnd };
}

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
async function main() {
  const email = arg('--email')!;
  const route = arg('--route')!.replace(/^.*?(api\/)/, '/$1');
  const json = arg('--json') ? JSON.parse(arg('--json')!) : undefined;
  const n = Number(arg('--n') ?? 2);
  const out = await fireConcurrently(n, () => call(email, arg('--method') ?? 'POST', route, json === undefined ? {} : { json }));
  const summary = { route, n, overlapped: out.overlapped, results: out.results.map((r) => ({ i: r.i, startMs: Math.round(r.startedAt), endMs: Math.round(r.endedAt), status: r.status, json: r.json })) };
  console.log(JSON.stringify(summary, null, 1).slice(0, 12000));
  if (arg('--tag')) saveEvidence(`concurrent-${arg('--tag')}`, summary);
}
if (process.argv[1]?.includes('concurrent')) main().catch((e) => { console.error(e); process.exitCode = 1; });
