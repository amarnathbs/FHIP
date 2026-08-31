import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { loadFinancialDna } from '@/lib/services/financialDnaData';

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const payload = await loadFinancialDna(user.id);
    return ok(payload);
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not load Financial DNA');
  }
}
