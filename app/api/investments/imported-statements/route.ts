import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { selectInvestments } from '@/lib/read-models';
import { listImportedAuStatements } from '@/lib/investment-import-bridge/publishAuPositions';
import { describeInstruments } from '@/lib/investment-import-bridge/auSecurityResolution';

// GET /api/investments/imported-statements
// Canonical-upload WP-12 (INV-G9 / INV-G1, PO D-05). What the Investments tab
// shows about imported broker statements:
//  - `statements`: every AU statement imported, with its dates, what was
//    added, what was skipped and why, unreadable rows, and the broker-cash
//    line (shown, never counted -- D-11);
//  - `unpublished`: the canonical Investments read model's own
//    "Imported, not yet in Net Worth" bucket -- the SAME selector Net Worth
//    uses, so the figure here can never disagree with what is (not) counted.
export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  try {
    const supabase = await createClient();
    const [statements, investments] = await Promise.all([listImportedAuStatements(user.id), selectInvestments(user.id, { client: supabase })]);
    let unpublished: { label: string; count: number; total: number; reporting_currency: string; holdings: { name: string; as_of_date: string; value: number; currency_code: string }[] } | null = null;
    if (investments.status === 'ok') {
      const names = new Map((await describeInstruments([...new Set(investments.unpublished.holdings.map((h) => h.instrumentId))])).map((i) => [i.instrumentId, i.name] as const));
      unpublished = {
        label: investments.unpublished.label,
        count: investments.unpublished.count,
        total: investments.unpublished.total,
        reporting_currency: investments.reportingCurrency,
        holdings: investments.unpublished.holdings.map((h) => ({ name: names.get(h.instrumentId) ?? 'Holding', as_of_date: h.asOfDate, value: h.value.amountNative, currency_code: h.value.currency })),
      };
    }
    return ok({ statements, unpublished, unpublished_unavailable: investments.status !== 'ok' });
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not load imported statements.', 500);
  }
}
