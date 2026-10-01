import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { selectInvestments } from '@/lib/read-models';
import { ensurePublishedValuesCurrent } from '@/lib/services/investment-intelligence/publishedValueRemark';

// GET /api/investments/published-valuations
// 2026-10-01 (PO): the Investments tab shows, for every Investment Intelligence
// mutual fund counted in Net Worth, the value, units, NAV, the NAV's own date and
// a tag ('Latest NAV' | 'Statement value' | 'Stale NAV' | 'Redeemed'). The figures
// come from the SAME canonical Investments read model Net Worth uses, after the
// same fail-soft re-mark, so this list can never disagree with the Net Worth total.
export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  try {
    const supabase = await createClient();
    await ensurePublishedValuesCurrent(user.id, supabase, 'investments_read');
    const investments = await selectInvestments(user.id, { client: supabase });
    if (investments.status !== 'ok') return ok({ lines: [], unavailable: true, summary: null });
    const lines = investments.lines
      .filter((l) => l.provenance.kind === 'investment_intelligence' && l.valuation)
      .map((l) => ({
        id: l.id,
        name: l.name,
        owner: l.owner,
        currency: l.value.currency,
        value: l.value.amountNative,
        valuation: l.valuation,
      }));
    return ok({ lines, unavailable: false, summary: investments.valuationSummary });
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not load published fund valuations.', 500);
  }
}
