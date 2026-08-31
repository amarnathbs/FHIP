import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { getForecastRunDetail } from '@/lib/services/forecastData';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  try {
    const detail = await getForecastRunDetail(user.id, id);
    return ok(detail);
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not load forecast run');
  }
}
