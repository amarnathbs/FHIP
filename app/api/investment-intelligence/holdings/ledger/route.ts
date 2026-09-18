import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { buildTransactionLedger } from '@/lib/services/investment-intelligence/transactionLedger';

// Investment Intelligence — Performance tab Holdings drilldown (2026-09-17).
//
// Retrieves the full chronological transaction ledger for ONE (account,
// instrument) position, for the TransactionDetailModal. accountId/
// instrumentId are opaque ids the client already received from its own
// /api/investment-intelligence/holdings response for THIS user — but
// ownership is never trusted from that alone: buildTransactionLedger()
// re-verifies both ids against `user.id` via the RLS-respecting request
// client, so a spoofed id from another household simply yields "not found",
// never another user's transactions (same parameter-spoofing defence as
// the /analytics route).
export async function GET(request: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const url = new URL(request.url);
  const accountId = url.searchParams.get('accountId');
  const instrumentId = url.searchParams.get('instrumentId');
  if (!accountId || !instrumentId) {
    return bad('Both accountId and instrumentId query parameters are required.');
  }

  try {
    const supabase = await createClient();
    const ledger = await buildTransactionLedger(supabase, user.id, accountId, instrumentId);
    if (!ledger) return bad('Position not found.', 404);
    return ok(ledger);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    return bad(`Transaction ledger could not be loaded: ${message}`, 500);
  }
}
