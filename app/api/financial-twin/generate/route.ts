import { requireUser, ok, bad } from '@/lib/api';
import { generateFinancialTwin } from '@/lib/services/financialTwinService';

export async function POST() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const outcome = await generateFinancialTwin(user.id);
    if (outcome.status === 'country_unresolved') {
      // G0-JA-1 Wave 1 (JA-D1): distinguishable unavailable-state contract,
      // not an error and not an AU-cohort result — any caller (this app's
      // own UI or a direct API call) can check `data.status`.
      return ok({
        status: 'country_unresolved',
        message: "Country confirmation required — we can't generate this comparison until your country is confirmed.",
      });
    }
    return ok({ status: 'ok', ...outcome.result });
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not generate Financial Twin');
  }
}
