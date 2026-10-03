// Presentational: the holding-period benchmark comparison (money-weighted).
// All numbers, dates and wording come from the engine (holdingBenchmarkComparison.ts);
// this component only lays them out. It never computes a return and never shows a
// number when the engine says the comparison is unavailable.
//
// Dates are not formatted here: the engine already produced the day-first period
// label ("Since 12-03-2025, 1 year 6 months"). No ISO date is rendered.
import type { HoldingBenchmarkComparison } from '@/lib/engines/investment-intelligence/holdingBenchmarkComparison';

function pct(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

function points(v: number): string {
  const n = v * 100;
  return `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(2)} pts`;
}

export default function BenchmarkComparisonView({ comparison }: { comparison: HoldingBenchmarkComparison | null | undefined }) {
  if (!comparison) {
    return <span className="text-xs text-muted">Benchmark data not available</span>;
  }
  if (comparison.status === 'unavailable') {
    return (
      <div className="text-xs text-muted" title={comparison.detail}>
        <p className="font-medium">{comparison.title}</p>
        <p className="mt-0.5 max-w-xs whitespace-normal font-normal">{comparison.detail}</p>
        {comparison.periodLabel ? <p className="mt-0.5 font-normal">{comparison.periodLabel}</p> : null}
      </div>
    );
  }
  const annualised = comparison.basis === 'annualised_xirr';
  return (
    <div className="text-xs" data-testid="benchmark-comparison">
      <p className="text-ink">
        <span className="font-medium">{comparison.benchmarkKey}</span>{' '}
        <span className="tabular-nums">{pct(comparison.benchmarkReturn)}</span>
        {annualised ? <span className="text-muted"> a year</span> : <span className="text-muted"> (not annualised)</span>}
      </p>
      <p className="text-ink">
        You <span className="tabular-nums">{pct(comparison.holdingReturn)}</span>{' '}
        <span className="tabular-nums text-muted">({points(comparison.difference)})</span>
      </p>
      <p className="mt-0.5 whitespace-normal text-muted">{comparison.periodLabel}</p>
      <p className="whitespace-normal text-muted">{comparison.basisLabel}</p>
      {comparison.notes.map((n) => (
        <p key={n} className="mt-0.5 max-w-xs whitespace-normal text-muted">
          {n}
        </p>
      ))}
    </div>
  );
}
