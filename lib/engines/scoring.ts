// Small generic scoring helpers shared across every weighted-component engine
// (Health Score, Resilience, and any future one) so the same bracket/banding
// math isn't redefined per engine.

export interface ScoreBand {
  min: number;
  band: string;
  label: string;
}

export function clamp(v: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, v));
}

export function scoreFromBrackets(value: number, brackets: { min: number; score: number }[]): number {
  const sorted = [...brackets].sort((a, b) => b.min - a.min);
  for (const b of sorted) if (value >= b.min) return b.score;
  return sorted[sorted.length - 1].score;
}

export function bandFor(score: number, bands: ScoreBand[]): { band: string; label: string } {
  const sorted = [...bands].sort((a, b) => b.min - a.min);
  for (const b of sorted) if (score >= b.min) return { band: b.band, label: b.label };
  const last = sorted[sorted.length - 1];
  return { band: last.band, label: last.label };
}
