import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { loadFinancialDna } from '@/lib/services/financialDnaData';

// Recalculation is deterministic and idempotent: the same underlying data
// always produces the same classification, and repeated calls within the
// same month update (not duplicate) that month's record.
export async function POST() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const payload = await loadFinancialDna(user.id);
    return ok(payload);
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not recalculate Financial DNA');
  }
}
