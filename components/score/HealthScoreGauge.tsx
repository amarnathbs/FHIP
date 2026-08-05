// Anchored to the design system's positive (#198754) / attention (#B7791F) /
// risk (#C7362F) tokens, with two interpolated mid-bands for a smooth ramp.
const BAND_COLORS: Record<string, string> = {
  excellent: '#198754',
  good: '#4CA555',
  fair: '#B7791F',
  needs_attention: '#C25A24',
  critical: '#C7362F',
  unknown: '#9CA3AF',
};

export function HealthScoreGauge({ score, statusLabel, statusBand }: { score: number; statusLabel: string; statusBand: string }) {
  const color = BAND_COLORS[statusBand] ?? BAND_COLORS.unknown;
  return (
    <div className="flex flex-col items-center rounded-hero border border-line bg-white p-8">
      <p className="text-sm font-medium uppercase tracking-wide text-muted">Financial Health Score</p>
      <div className="mt-2 text-6xl font-bold tabular-nums" style={{ color }}>
        {Math.round(score)}
        <span className="text-2xl text-muted">/100</span>
      </div>
      <p className="mt-2 text-lg font-semibold" style={{ color }}>
        {statusLabel}
      </p>
      <div className="mt-4 h-2 w-full max-w-xs rounded-full bg-gray-100">
        <div className="h-2 rounded-full" style={{ width: `${Math.max(0, Math.min(100, score))}%`, background: color }} />
      </div>
    </div>
  );
}

export function bandStatus(band: string): 'good' | 'caution' | 'risk' | 'neutral' {
  if (band === 'excellent' || band === 'good') return 'good';
  if (band === 'fair') return 'caution';
  if (band === 'needs_attention' || band === 'critical') return 'risk';
  return 'neutral';
}
