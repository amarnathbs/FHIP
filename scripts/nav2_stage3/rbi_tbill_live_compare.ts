// READ-ONLY. Exercises the part of the RBI weekly job the DEV dry run skipped (the series was already up to date): finding the latest
// "Treasury Bills: Full Auction Result" release through the listing (including the month-archive form request, which had never been run against
// the live site), parsing it with the job's reader, and comparing the 91-day cut-off yield with the value stored on DEV.
// Uses the job's own polite fetcher (descriptive User-Agent, robots.txt first, one request at a time, HTML only). Writes nothing anywhere.
//   npx tsx scripts/nav2_stage3/rbi_tbill_live_compare.ts <expected-auction-date yyyy-mm-dd>
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const env: Record<string, string> = {};
for (const line of readFileSync(join(__dirname, '..', '..', '.env.local'), 'utf8').split(/\r?\n/)) { const m = /^([A-Za-z0-9_]+)=(.*)$/.exec(line.trim()); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
if (new URL(env.NEXT_PUBLIC_SUPABASE_URL).host.split('.')[0] !== 'vqycarelcoijzwlpkpcz') throw new Error('not DEV');

async function main() {
  const expected = process.argv[2];
  const { PoliteRbiFetcher } = await import('../../lib/services/investment-intelligence/nav2/rbiFetcher');
  const { createLiveRbiSource } = await import('../../lib/services/investment-intelligence/nav2/rbiSource');
  const { parseAuctionResultHtml } = await import('../../lib/services/investment-intelligence/nav2/rbiHtml');
  const fetcher = new PoliteRbiFetcher();
  const source = createLiveRbiSource(fetcher);
  const found = await source.findAuctionRelease(expected);
  console.log(`robots.txt: ${fetcher.robotsOutcome}; requests: ${JSON.stringify(source.requestsMade())}`);
  if (!found.found) { console.log('NOT FOUND:', found.reason); process.exitCode = 2; return; }
  console.log(`release found: prid ${found.prid}, dated ${found.releaseDate}`);
  const parsed = parseAuctionResultHtml(found.html);
  console.log('parsed by the job reader:', JSON.stringify({ auctionDate: parsed?.auctionDate, releaseNumber: parsed?.releaseNumber, kind: (parsed as { kind?: string })?.kind, yieldPercent: (parsed as { yieldPercent?: number })?.yieldPercent, parsed }).slice(0, 700));
  const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data } = await db.from('ii_risk_free_observations').select('observation_date, value_percent, source_document').eq('series_id', 'RBI_91D_TBILL_CUTOFF_YIELD').eq('kind', 'value').eq('observation_date', parsed?.auctionDate ?? expected);
  console.log('stored on DEV for that auction date:', JSON.stringify(data));
}
main().catch((e) => { console.error('ERR', e instanceof Error ? `${e.name}: ${e.message}` : e); process.exit(1); });
