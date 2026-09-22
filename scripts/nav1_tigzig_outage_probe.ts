// NAV 1.24 — real live outage-handling probe. Run only when TIGZIG happens
// to be down (observed live 2026-09-21: Cloudflare 522 "Connection timed
// out" from api.tigzig.com's own origin) to see how the real adapter
// behaves against a genuine, not simulated, outage.
import { TigzigHistoricalAdapter } from '@/lib/services/investment-intelligence/pc6/adapters/tigzigHistoricalAdapter';

async function main() {
  const adapter = new TigzigHistoricalAdapter();
  const started = Date.now();
  const result = await adapter.fetchHistory({ schemeIdentifier: '118955', fromDate: '2026-09-15', toDate: '2026-09-19' });
  console.log(`elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(JSON.stringify(result, null, 2));
}
main();
