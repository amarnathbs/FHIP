import { SectionCard } from '@/components/dashboard/SectionCard';
import type { ResilienceRisk, RiskSeverity } from '@/lib/engines/resilience';

const SEVERITY_ORDER: Record<RiskSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const SEVERITY_COLOR: Record<RiskSeverity, string> = {
  critical: '#C7362F',
  high: '#C25A24',
  medium: '#B7791F',
  low: '#5B677A',
};
const SEVERITY_LABEL: Record<RiskSeverity, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };

export function RiskRegister({ risks }: { risks: ResilienceRisk[] }) {
  return (
    <SectionCard
      title="Risk Exposure Register"
      description="Identified risks to your household's resilience, ranked by severity."
    >
      {risks.length === 0 ? (
        <p className="text-sm text-gray-500">No significant risks identified from your current data.</p>
      ) : (
        <div className="space-y-3">
          {risks
            .slice()
            .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
            .map((r) => (
              <div key={r.code} className="rounded-card border p-4">
                <div className="flex items-center justify-between">
                  <p className="font-medium text-gray-900">{r.title}</p>
                  <span
                    className="rounded-full px-2 py-0.5 text-xs font-semibold text-white"
                    style={{ background: SEVERITY_COLOR[r.severity] }}
                  >
                    {SEVERITY_LABEL[r.severity]}
                  </span>
                </div>
                <p className="mt-1 text-sm text-gray-600">{r.explanation}</p>
                <p className="mt-1 text-xs uppercase tracking-wide text-gray-400">{r.category}</p>
              </div>
            ))}
        </div>
      )}
    </SectionCard>
  );
}
