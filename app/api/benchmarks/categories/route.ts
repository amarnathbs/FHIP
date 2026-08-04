import { requireUser, ok } from '@/lib/api';
import { METRIC_CATALOGUE } from '@/lib/engines/twin/metricCatalogue';
import { METRIC_CATEGORY_LABEL, type MetricCategory } from '@/lib/engines/twin/taxonomy';

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const categories = (Object.keys(METRIC_CATEGORY_LABEL) as MetricCategory[]).map((code) => ({
    code,
    label: METRIC_CATEGORY_LABEL[code],
    metricCount: METRIC_CATALOGUE.filter((m) => m.category === code).length,
  }));
  return ok(categories);
}
