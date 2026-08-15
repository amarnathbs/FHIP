import { ResilienceGauge } from './ResilienceGauge';
import type { ResilienceEligibility } from '@/lib/engines/resilienceEligibility';

// Phase 0C.1 §24-27: closes the same presentation gap Phase 0C fixed for
// the Health Score, but for Resilience — the gauge previously always
// rendered a number, even when almost nothing about the household's
// resilience was actually known yet. No new Resilience methodology here,
// only whether/how confidently to present the number computeResilience()
// already calculated.
export function ResilienceStateCard({
  score,
  statusLabel,
  statusBand,
  confidence,
  eligibility,
  compact = false,
}: {
  score: number;
  statusLabel: string;
  statusBand: string;
  confidence: number;
  eligibility: ResilienceEligibility;
  compact?: boolean;
}) {
  if (eligibility.state === 'not_yet_available') {
    return (
      <div
        className={`flex flex-col items-center rounded-hero border border-dashed border-line bg-white text-center ${compact ? 'p-4' : 'p-8'}`}
      >
        <p className="text-sm font-medium uppercase tracking-wide text-muted">Financial Resilience Score</p>
        <p className={`mt-3 font-semibold text-ink ${compact ? 'text-base' : 'text-xl'}`}>
          Your Financial Resilience assessment is not ready yet
        </p>
        <p className="mt-1 max-w-sm text-sm text-muted">
          Complete more of your Financial Picture to assess how well your finances could absorb an unexpected shock.
        </p>
        <p className="mt-4 text-sm font-medium text-ink">
          {eligibility.scoredComponents} of {eligibility.totalComponents} resilience components calculated
        </p>
      </div>
    );
  }

  const isPreliminary = eligibility.state === 'preliminary';

  return (
    <div>
      <ResilienceGauge
        score={score}
        statusLabel={isPreliminary ? `${statusLabel} — preliminary` : statusLabel}
        statusBand={statusBand}
        compact={compact}
      />
      {isPreliminary ? (
        <div className="mt-3 rounded-card border border-dashed bg-gray-50 p-4 text-sm text-gray-600">
          <p>
            <span className="font-medium text-ink">
              Based on {eligibility.scoredComponents} of {eligibility.totalComponents} resilience components.
            </span>{' '}
            This is an early assessment. Complete the remaining sections to improve its reliability.
          </p>
          {eligibility.missingComponentLabels.length > 0 && (
            <p className="mt-2">Still to calculate: {eligibility.missingComponentLabels.join(', ')}.</p>
          )}
        </div>
      ) : (
        <p className="mt-3 text-center text-sm text-muted">
          {/* Phase 0C §18: distinct label from the canonical Financial Data
              Confidence — this is Resilience's own specialised formula. */}
          Resilience calculation confidence: <span className="font-medium text-ink">{confidence.toFixed(0)}%</span>
        </p>
      )}
    </div>
  );
}
