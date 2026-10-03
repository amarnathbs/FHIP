import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { createAdminClient } from '@/lib/supabase/admin';
import { getUserNavHistoryStatus } from '@/lib/services/investment-intelligence/pc6/userNavHistory';
import { runLiveUserNavHistoryBatch } from '@/lib/services/investment-intelligence/pc6/userNavHistoryLive';
import { applyPendingInvestmentDates } from '@/lib/services/investment-intelligence/investmentDateService';

// The user's OWN missing NAV history (PO decision 2026-10-03).
//
// GET   where each of the caller's funds stands ('loaded' | 'pending' |
//       'loading' | 'waiting') with a plain headline. Read-only: never fetches.
// POST  "check now": one small, time-boxed slice of the caller's missing
//       history (a few funds, bounded concurrency, a deadline well inside the
//       platform limit), against the real NAV 1 adapters. The page calls it
//       after an upload is confirmed and keeps calling it while the answer
//       says there is more to do; the scheduled job (migration 0193) is the
//       fallback. Saved investment dates that were waiting for this history are
//       applied in the same call, and the affected positions re-evaluated.
//
// Everything is scoped to the caller: the funds are the caller's own
// (user_id = caller), the body is ignored, and there is no way to name another
// user's fund or the wider fund universe from here.
export const maxDuration = 60;

const today = () => new Date().toISOString().slice(0, 10);

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const status = await getUserNavHistoryStatus(createAdminClient(), user.id, today());
    return ok({ summary: status.summary, schemes: status.schemes.map(({ instrumentId, schemeName, state, loadingFrom }) => ({ instrumentId, schemeName, state, loadingFrom })) });
  } catch (err) {
    console.error('[investment-intelligence] nav-history status failed', err instanceof Error ? err.message : err);
    return bad('Could not check the price history of your funds.', 500);
  }
}

export async function POST() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const batch = await runLiveUserNavHistoryBatch(user.id);

    // Dates the user saved while the history was missing: apply them now that more of it has arrived.
    let appliedDates = 0;
    try {
      const pending = await applyPendingInvestmentDates(user.id, createAdminClient());
      appliedDates = pending.applied;
      if (pending.appliedPositions.length > 0) {
        const { recertifyPosition } = await import('@/lib/services/investment-intelligence/documentProcessing');
        for (const p of pending.appliedPositions) await recertifyPosition(user.id, p.accountId, p.instrumentId);
      }
    } catch (err) {
      console.error('[investment-intelligence] applying saved investment dates after a NAV fetch failed', err instanceof Error ? err.message : err);
    }

    return ok({
      summary: batch.status.summary,
      schemes: batch.status.schemes.map(({ instrumentId, schemeName, state, loadingFrom }) => ({ instrumentId, schemeName, state, loadingFrom })),
      attempted: batch.attempted.length,
      remaining: batch.remaining,
      rateLimited: batch.rateLimited,
      appliedDates,
    });
  } catch (err) {
    console.error('[investment-intelligence] nav-history run failed', err instanceof Error ? err.message : err);
    return bad('Could not check the price history of your funds just now. We will keep trying.', 500);
  }
}
