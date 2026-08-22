import { SectionCard } from './SectionCard';
import { confidenceExplanation } from '@/lib/engines/reportCopy';
import { DATA_QUALITY_STATUS_LABELS, type DataQualityStatus } from '@/lib/engines/reportSections';
import type { BuiltSection } from '@/lib/engines/reportSections';

const STATUS_COLOR: Record<DataQualityStatus, string> = {
  complete: '#198754',
  confirmed_zero: '#0D6EFD',
  not_applicable: '#6C757D',
  stale: '#B7791F',
  missing: '#C7362F',
};

export function DataQualityPanel({ dataQuality, dataConfidencePct }: { dataQuality: BuiltSection; dataConfidencePct: number }) {
  const rows = dataQuality.sectionData.rows as { area: string; status: DataQualityStatus; lastUpdated: string | null }[];
  // Only genuinely outstanding sections (stale data, or never reviewed at
  // all) should drive the confidence explanation's "which area is holding
  // this back" sentence — a confirmed-zero or not-applicable section has
  // already been resolved by the user, so it shouldn't read as a limiting
  // factor (Phase 0C follow-up).
  const limitingArea = rows.find((r) => r.status === 'stale' || r.status === 'missing')?.area ?? null;
  const confidenceTier: 'high' | 'medium' | 'low' = dataConfidencePct >= 80 ? 'high' : dataConfidencePct >= 50 ? 'medium' : 'low';

  return (
    <SectionCard title="Data Quality" description={confidenceExplanation(confidenceTier, limitingArea)}>
      <ul className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        {rows.map((row) => (
          <li key={row.area} className="flex items-center justify-between gap-2 text-sm">
            <span className="text-muted">{row.area}</span>
            <span className="font-medium" style={{ color: STATUS_COLOR[row.status] }}>
              {DATA_QUALITY_STATUS_LABELS[row.status]}
            </span>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
