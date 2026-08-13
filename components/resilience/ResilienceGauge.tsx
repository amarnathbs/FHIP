// Anchored to the design system's positive (#198754) / attention (#B7791F) /
// risk (#C7362F) tokens, with two interpolated mid-bands for a smooth ramp.
const BAND_COLORS: Record<string, string> = {
  highly_resilient: '#198754',
  resilient: '#4CA555',
  moderately_vulnerable: '#B7791F',
  vulnerable: '#C25A24',
  fragile: '#C7362F',
  unknown: '#9CA3AF',
};

export function resilienceBandStatus(band: string): 'good' | 'caution' | 'risk' | 'neutral' {
  if (band === 'highly_resilient' || band === 'resilient') return 'good';
  if (band === 'moderately_vulnerable') return 'caution';
  if (band === 'vulnerable' || band === 'fragile') return 'risk';
  return 'neutral';
}

// `compact` mirrors HealthScoreGauge's report-only compact variant — same
// rationale (report page has this gauge sharing space with a Key risks
// card; the live Resilience page keeps the default full size).
export function ResilienceGauge({
  score,
  statusLabel,
  statusBand,
  compact = false,
}: {
  score: number;
  statusLabel: string;
  statusBand: string;
  compact?: boolean;
}) {
  const color = BAND_COLORS[statusBand] ?? BAND_COLORS.unknown;
  return (
    <div className={`flex flex-col items-center rounded-hero border border-line bg-white ${compact ? 'p-4' : 'p-8'}`}>
      <p className="text-sm font-medium uppercase tracking-wide text-muted">Financial Resilience Score</p>
      <div className={`mt-2 font-bold tabular-nums ${compact ? 'text-4xl' : 'text-6xl'}`} style={{ color }}>
        {Math.round(score)}
        <span className={compact ? 'text-lg text-muted' : 'text-2xl text-muted'}>/100</span>
      </div>
      <p className={`mt-1 font-semibold ${compact ? 'text-base' : 'mt-2 text-lg'}`} style={{ color }}>
        {statusLabel}
      </p>
      <div className={`w-full max-w-xs rounded-full bg-gray-100 ${compact ? 'mt-2 h-1.5' : 'mt-4 h-2'}`}>
        <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, score))}%`, background: color }} />
      </div>
    </div>
  );
}
