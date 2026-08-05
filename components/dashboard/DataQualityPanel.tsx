import { SectionCard } from './SectionCard';
import { confidenceExplanation } from '@/lib/engines/reportCopy';
import type { BuiltSection } from '@/lib/engines/reportSections';

const STATUS_LABEL: Record<string, string> = {
  complete: 'Complete',
  stale: 'Stale',
  missing: 'Missing',
};

const STATUS_COLOR: Record<string, string> = {
  complete: '#198754',
  stale: '#B7791F',
  missing: '#C7362F',
};

export function DataQualityPanel({ dataQuality, dataConfidencePct }: { dataQuality: BuiltSection; dataConfidencePct: number }) {
  const rows = dataQuality.sectionData.rows as { area: string; status: 'complete' | 'stale' | 'missing'; lastUpdated: string | null }[];
  const limitingArea = rows.find((r) => r.status !== 'complete')?.area ?? null;
  const confidenceTier: 'high' | 'medium' | 'low' = dataConfidencePct >= 80 ? 'high' : dataConfidencePct >= 50 ? 'medium' : 'low';

  return (
    <SectionCard title="Data Quality" description={confidenceExplanation(confidenceTier, limitingArea)}>
      <ul className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        {rows.map((row) => (
          <li key={row.area} className="flex items-center justify-between gap-2 text-sm">
            <span className="text-muted">{row.area}</span>
            <span className="font-medium" style={{ color: STATUS_COLOR[row.status] }}>
              {STATUS_LABEL[row.status]}
            </span>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
