import Link from 'next/link';
import { HealthScoreGauge } from './HealthScoreGauge';
import { SECTION_LABELS, type FinancialSection } from '@/lib/engines/financialSectionStatus';
import type { HealthScoreEligibility } from '@/lib/engines/healthScoreEligibility';

// Phase 0C: the one place Not Yet Scored / Preliminary / Full get rendered.
// Dashboard and /score both use this component with the same eligibility
// object from loadHealthScore(), so they can never show different states
// for the same account at the same time (Phase 0C §46).
const SECTION_ROUTES: Record<FinancialSection, string> = {
  household: '/dashboard',
  income: '/income',
  expenses: '/expenses',
  assets: '/assets',
  liabilities: '/liabilities',
  investments: '/investments',
  retirement: '/retirement',
  insurance: '/insurance',
};

export function HealthScoreStateCard({
  score,
  statusLabel,
  statusBand,
  eligibility,
  compact = false,
}: {
  score: number;
  statusLabel: string;
  statusBand: string;
  eligibility: HealthScoreEligibility;
  compact?: boolean;
}) {
  if (eligibility.state === 'not_yet_scored') {
    const nextSection = eligibility.missingSections[0];
    const progressPct =
      eligibility.totalRelevantSections > 0 ? (eligibility.reviewedSections / eligibility.totalRelevantSections) * 100 : 0;
    return (
      <div
        className={`flex flex-col items-center rounded-hero border border-dashed border-line bg-white text-center ${compact ? 'p-4' : 'p-8'}`}
      >
        <p className="text-sm font-medium uppercase tracking-wide text-muted">Financial Health Score</p>
        <p className={`mt-3 font-semibold text-ink ${compact ? 'text-base' : 'text-xl'}`}>
          Your Financial Health Score is not ready yet
        </p>
        <p className="mt-1 max-w-sm text-sm text-muted">Complete your core Financial Picture to receive your first assessment.</p>
        <p className="mt-4 text-sm font-medium text-ink">
          {eligibility.reviewedSections} of {eligibility.totalRelevantSections} core sections reviewed
        </p>
        <div className="mt-2 h-2 w-full max-w-xs rounded-full bg-gray-100">
          <div className="h-full rounded-full bg-primary" style={{ width: `${progressPct}%` }} />
        </div>
        {nextSection && (
          <Link
            href={SECTION_ROUTES[nextSection]}
            className="mt-5 rounded-full bg-primary px-5 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            Continue my Financial Picture
          </Link>
        )}
      </div>
    );
  }

  const isPreliminary = eligibility.state === 'preliminary';
  const nextMissingSection = eligibility.missingSections[0];

  return (
    <div>
      <HealthScoreGauge
        score={score}
        statusLabel={isPreliminary ? `${statusLabel} — preliminary` : statusLabel}
        statusBand={statusBand}
        compact={compact}
      />
      {isPreliminary ? (
        <div className="mt-3 rounded-card border border-dashed bg-gray-50 p-4 text-sm text-gray-600">
          <p>
            <span className="font-medium text-ink">Based on {eligibility.confidencePercent}% of your financial picture.</span>{' '}
            This is an early assessment. Complete the remaining sections to improve the reliability of your score.
          </p>
          {eligibility.missingSections.length > 0 && (
            <p className="mt-2">
              Still to review: {eligibility.missingSections.map((s) => SECTION_LABELS[s]).join(', ')}.
            </p>
          )}
          {nextMissingSection && (
            <Link
              href={SECTION_ROUTES[nextMissingSection]}
              className="mt-3 inline-block rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-white hover:opacity-90"
            >
              Improve my score confidence
            </Link>
          )}
        </div>
      ) : (
        <p className="mt-3 text-center text-sm text-muted">
          Data confidence:{' '}
          <span className="font-medium capitalize text-ink">{eligibility.confidenceTier}</span>
        </p>
      )}
    </div>
  );
}
