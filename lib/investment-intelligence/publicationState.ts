// Document2 (4) WP-B2 (25-10-2026) -- what a Portfolio Truth position is, as far as FHIP publication goes, and what the screen may offer.
//
// PURE and DB-free. The PO's production report: a position that ALREADY has an active publication still showed the blue
// "Publish to FHIP" button, the preview panel said "New position adds X to net worth" for a position that was already counted, and
// nothing said whether the published value was out of date. This module is the single decision both the list row and the preview
// panel use, so they cannot disagree.
//
//   not_published                 -> offer Publish (when the position is certified and eligible)
//   published_current             -> "Published", Unpublish; nothing to refresh (no dead Refresh button)
//   published_refresh_available   -> "Published", Refresh (a newer certified statement exists), Unpublish
//
// "Newer" is exactly the rule refreshPosition() applies (decideRefreshSupersession), never a second definition: a snapshot that
// refresh would reject as older is NOT offered as a refresh.

import { decideRefreshSupersession } from '@/lib/services/investment-intelligence/publicationLogic';

export interface ActivePublicationFact {
  publicationId: string;
  /** The holding snapshot this publication was made from. */
  canonicalPositionId: string;
  /** What the register row counts in Net Worth right now (investments.current_value of the published row), when readable. */
  countedValue: number | null;
  /** What was published (frozen at publication time). */
  publishedValue: number | null;
  currency: string;
  /** The statement date of the snapshot that was published. */
  publishedAsOf: string | null;
  publishedCertifiedAt: string | null;
}

export interface LatestSnapshotFact {
  id: string;
  asOfDate: string;
  createdAt: string | null;
  value: number;
}

export type PublicationState =
  | { kind: 'not_published' }
  | {
      kind: 'published_current';
      publicationId: string;
      countedValue: number | null;
      publishedValue: number | null;
      currency: string;
      publishedAsOf: string | null;
    }
  | {
      kind: 'published_refresh_available';
      publicationId: string;
      countedValue: number | null;
      publishedValue: number | null;
      currency: string;
      publishedAsOf: string | null;
      /** The newer certified snapshot a refresh would activate. */
      refreshFromPositionId: string;
      latestAsOf: string;
      latestStatementValue: number;
      /** Why a refresh is offered, in one plain sentence. */
      reason: string;
    };

export function derivePublicationState(active: ActivePublicationFact | null | undefined, latest: LatestSnapshotFact | null | undefined): PublicationState {
  if (!active) return { kind: 'not_published' };
  const base = {
    publicationId: active.publicationId,
    countedValue: active.countedValue,
    publishedValue: active.publishedValue,
    currency: active.currency,
    publishedAsOf: active.publishedAsOf,
  };
  if (!latest || latest.id === active.canonicalPositionId) return { kind: 'published_current', ...base };
  const decision = decideRefreshSupersession({
    activeAsOfDate: active.publishedAsOf ?? '0000-01-01',
    activeCertifiedAt: active.publishedCertifiedAt,
    newAsOfDate: latest.asOfDate,
    newCertifiedAt: latest.createdAt,
  });
  if (decision.action === 'REJECT_OLDER') return { kind: 'published_current', ...base };
  return {
    kind: 'published_refresh_available',
    ...base,
    refreshFromPositionId: latest.id,
    latestAsOf: latest.asOfDate,
    latestStatementValue: latest.value,
    reason: decision.reason,
  };
}

// ---------------------------------------------------------------------------
// The publish / refresh panel: what is true about Net Worth, and which button is valid.
// ---------------------------------------------------------------------------

export type PanelAction = 'publish' | 'refresh' | 'none';

export interface PanelImpact {
  /** The one action the confirm button performs, or none (then there is NO confirm button). */
  action: PanelAction;
  /** A single line stating what is true about Net Worth. */
  headline: string;
  /** What changes, if anything. */
  detail: string | null;
  /** Change in the counted value if the action runs (0 for none). */
  change: number;
  tone: 'info' | 'warn';
  confirmLabel: string | null;
}

const money = (n: number, fmt: (n: number) => string) => fmt(n);

/**
 * `fmt` renders an amount in the position's own currency (the caller's formatMoney). `date` renders a day-first date.
 * `counted` is what Net Worth counts today for an already-published position; `willCount` what the action would make it count.
 */
export function describePanelImpact(input: {
  publication: { kind: 'new' } | { kind: 'same_snapshot'; counted: number | null; asOf: string | null } | { kind: 'newer_snapshot'; counted: number | null; asOf: string | null } | { kind: 'older_snapshot'; counted: number | null; asOf: string | null };
  eligible: boolean;
  willCount: number | null;
  fmt: (n: number) => string;
  date: (iso: string) => string;
}): PanelImpact {
  const { publication, eligible, willCount, fmt, date } = input;
  if (publication.kind === 'new') {
    if (!eligible) return { action: 'none', headline: 'This position cannot be published yet.', detail: null, change: 0, tone: 'warn', confirmLabel: null };
    return {
      action: 'publish',
      headline: willCount === null ? 'Publishing adds this position to net worth.' : `New position: publishing adds ${money(willCount, fmt)} to net worth.`,
      detail: null,
      change: willCount ?? 0,
      tone: 'info',
      confirmLabel: 'Confirm & Publish',
    };
  }
  const asOf = publication.asOf ? ` (statement dated ${date(publication.asOf)})` : '';
  const counted = publication.counted;
  if (publication.kind === 'same_snapshot') {
    return {
      action: 'none',
      headline: counted === null ? `Already counted in net worth${asOf}.` : `Already counted in net worth: ${money(counted, fmt)}${asOf}.`,
      detail: 'Nothing to publish: this is the statement already published. Use Unpublish to remove it from net worth.',
      change: 0,
      tone: 'info',
      confirmLabel: null,
    };
  }
  if (publication.kind === 'older_snapshot') {
    return {
      action: 'none',
      headline: counted === null ? `Already counted in net worth${asOf}.` : `Already counted in net worth: ${money(counted, fmt)}${asOf}.`,
      detail: 'The statement being previewed is older than the one already published, so it cannot replace it. Nothing to publish.',
      change: 0,
      tone: 'info',
      confirmLabel: null,
    };
  }
  // A newer certified statement than the one published.
  if (!eligible || willCount === null) {
    return {
      action: 'none',
      headline: counted === null ? `Already counted in net worth${asOf}.` : `Already counted in net worth: ${money(counted, fmt)}${asOf}.`,
      detail: 'A newer statement exists, but it cannot be used to refresh yet. Resolve what is blocking it first.',
      change: 0,
      tone: 'warn',
      confirmLabel: null,
    };
  }
  const change = counted === null ? 0 : Math.round((willCount - counted) * 100) / 100;
  const countedText = counted === null ? 'its current value' : money(counted, fmt);
  const changeText = counted === null ? '' : change === 0 ? ' (no change)' : ` (change ${change > 0 ? '+' : '-'}${money(Math.abs(change), fmt)})`;
  return {
    action: 'refresh',
    headline: `Already counted in net worth: ${countedText}${asOf}.`,
    detail: `Refresh will update it to ${money(willCount, fmt)}${changeText}.`,
    change,
    tone: 'info',
    confirmLabel: 'Confirm refresh',
  };
}
