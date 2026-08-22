// Spec §12/§47: expired time-sensitive content stays published (workflow
// state is never silently altered) but must show a visible freshness
// warning plus the last-reviewed/current-as-of date — never silently
// presented as current.

import { formatPublicDate } from '@/lib/resources/public/metadata';

export function FreshnessWarning({ expiresAt, lastReviewedAt }: { expiresAt: string | null; lastReviewedAt: string | null }) {
  const expiredLabel = formatPublicDate(expiresAt);
  const reviewedLabel = formatPublicDate(lastReviewedAt);

  return (
    <div role="note" className="rounded-card border border-attention/30 bg-attention/5 p-4 text-sm text-attention">
      <p className="font-semibold">This information may no longer be current.</p>
      <p className="mt-1">
        {expiredLabel && <>This content was marked current until {expiredLabel}. </>}
        {reviewedLabel && <>Last reviewed {reviewedLabel}.</>}
      </p>
    </div>
  );
}

export function LastReviewedNote({ lastReviewedAt }: { lastReviewedAt: string | null }) {
  const label = formatPublicDate(lastReviewedAt);
  if (!label) return null;
  return <p className="text-xs text-muted">Last reviewed {label}</p>;
}
