// "Kick, then return": start the user's missing-NAV-history fetch AFTER the HTTP
// response has been sent, so an upload or confirm never waits on a data source
// (PO decision 2026-10-03: no long fetch inside the confirm request).
//
// Uses Next's `after()`. It is best effort by design:
//   * outside a request scope (a unit test, a script) `after()` throws; that is
//     caught and reported as "not kicked";
//   * on a host that ends the process when the response is sent, the work may
//     not complete. That is acceptable: the Investment page's status panel
//     keeps calling the batch endpoint while there is work, and the scheduled
//     hydration job (migration 0193) is the fallback.
// Nothing here ever throws into the caller, and a failure of the kicked work is
// logged, never surfaced to the confirm.

import { after } from 'next/server';

export type UserNavHistoryRunner = (userId: string) => Promise<unknown>;

async function defaultRunner(userId: string): Promise<unknown> {
  // Loaded only when the kick actually runs, so the confirm route does not import the adapters.
  const { runLiveUserNavHistoryBatch } = await import('./userNavHistoryLive');
  return runLiveUserNavHistoryBatch(userId);
}

/** Returns true when the work was scheduled, false when it could not be. Never throws, never waits. */
export function kickUserNavHistory(userId: string, run: UserNavHistoryRunner = defaultRunner): boolean {
  try {
    after(async () => {
      try {
        await run(userId);
      } catch (e) {
        console.error('[investment-intelligence] kicked NAV history fetch failed', e instanceof Error ? e.message : e);
      }
    });
    return true;
  } catch {
    return false;
  }
}
