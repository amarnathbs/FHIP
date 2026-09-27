/** Upload a card/loan CSV through the Liabilities import panel's route, then load the review. Prints responses. */
import { call } from './lib';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };

export async function uploadLiability(email: string, csv: string, query: Record<string, string>, filename: string) {
  const qs = new URLSearchParams({ ...query, filename });
  const up = await call(email, 'POST', `/api/financial-data-hub/liability-statement/upload?${qs}`, { body: new TextEncoder().encode(csv), contentType: 'text/csv' });
  return up;
}

async function main() {
  const email = arg('--email')!;
  const kind = arg('--kind') ?? 'card';
  const salt = arg('--salt') ?? 'B';
  const csv = JSON.parse(arg('--csv-json')!) as string[];
  const query = JSON.parse(arg('--query')!) as Record<string, string>;
  const up = await uploadLiability(email, csv.join('\n') + '\n', query, `fhip-test-${kind}-${salt}.csv`);
  console.log('upload', up.status, JSON.stringify(up.json, null, 1).slice(0, 2500));
  const docId = up.json?.data?.document_id;
  if (docId) {
    const rv = await call(email, 'GET', `/api/financial-data-hub/liability-statement/${docId}`);
    console.log('review', rv.status, JSON.stringify(rv.json, null, 1).slice(0, 8000));
  }
}
if (process.argv[1]?.includes('upload_liability')) main().catch((e) => { console.error(e); process.exitCode = 1; });
