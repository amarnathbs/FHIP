import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { createAdminClient } from '@/lib/supabase/admin';
import { listInvestmentDateItems, submitInvestmentDate } from '@/lib/services/investment-intelligence/investmentDateService';
import { z } from 'zod';

// Investment date for a holdings-only position (Document2 D-3, PO decision
// 2026-10-03). See lib/services/investment-intelligence/investmentDateService.ts
// for the full flow.
//
// GET   the user's holdings-only positions and where each stands
//       ('needs_date' | 'awaiting_nav' | 'applied'). Reading also completes any
//       saved date that was only waiting for price history.
// POST  { accountId, instrumentId, date } -- `date` is what the user TYPED
//       (day first, e.g. 01-10-2026); the server parses and validates it, so a
//       client cannot send a date the rules would refuse. The same POST again
//       with a different date is an edit (the old answer is superseded, never
//       overwritten).
//
// Scoped to the caller: the account must belong to them, every read is
// filtered by user_id, and the service-role client is used only because
// ii_transactions / ii_investment_date_inputs have no authenticated write path.
// Ownership allocation is not read or written.
const submitSchema = z.object({
  accountId: z.string().min(1),
  instrumentId: z.string().min(1),
  date: z.string().max(40),
});

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const items = await listInvestmentDateItems(user.id, createAdminClient());
    return ok({ items });
  } catch (err) {
    console.error('[investment-intelligence] investment-dates list failed', err instanceof Error ? err.message : err);
    return bad('Could not load your investments that need a date.', 500);
  }
}

export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad('Send the investment and the date.', 422);
  }
  const parsed = submitSchema.safeParse(body);
  if (!parsed.success) return badValidation(parsed.error, 422);

  const result = await submitInvestmentDate({
    userId: user.id,
    accountId: parsed.data.accountId,
    instrumentId: parsed.data.instrumentId,
    dateText: parsed.data.date,
    todayIso: new Date().toISOString().slice(0, 10),
    db: createAdminClient(),
  });
  if (!result.ok) return bad(result.message, result.status, result.code);

  // Treat it exactly as if the date had come from the statement: re-evaluate
  // the position with the existing "Re-evaluate" function. Best effort -- the
  // saved date stands even if this step fails.
  if (result.state === 'applied' && !result.unchanged) {
    try {
      const { recertifyPosition } = await import('@/lib/services/investment-intelligence/documentProcessing');
      await recertifyPosition(user.id, parsed.data.accountId, parsed.data.instrumentId);
    } catch (err) {
      console.error('[investment-intelligence] re-evaluation after an investment date failed', err instanceof Error ? err.message : err);
    }
  }
  return ok({ state: result.state, inputId: result.inputId, investmentDate: result.investmentDate, unchanged: result.unchanged });
}
