import { requireUser, ok, bad } from '@/lib/api';
import { generateFinancialTwin } from '@/lib/services/financialTwinService';

export async function POST() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const result = await generateFinancialTwin(user.id);
    return ok(result);
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not generate Financial Twin');
  }
}
