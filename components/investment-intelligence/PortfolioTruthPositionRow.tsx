'use client';

import { formatMoneyCode } from '@/lib/engines/money';
import { fmtDate } from './dateDisplay';
import { describeTruthBlocker } from '@/lib/services/investment-intelligence/caseLifecycle';
import { describeUnitVariance } from '@/lib/investment-intelligence/unitVarianceGuidance';
import type { PublicationState } from '@/lib/investment-intelligence/publicationState';
import type { ReevaluationCard } from '@/lib/investment-intelligence/reevaluationResult';

// Document2 (4) WP-B2 (25-10-2026): one row of the Portfolio Truth list, as a presentational component so it can be rendered and tested
// on its own. It shows, for ONE position, (1) its certification status, (2) its publication state (Published / Refresh / Unpublish, or
// Publish to FHIP only when it is not published) and (3) the result of the last Re-evaluate as a card that cannot be missed.

export interface TruthRowStatus {
  account_id: string;
  instrument_id: string;
  status: string;
  blocking_reasons: { code: string; message: string }[] | null;
  warning_reasons: { code: string; message: string }[] | null;
  reconciled_closing_units?: number | string | null;
  statement_closing_units?: number | string | null;
  unit_variance?: number | string | null;
}

export interface TruthRowPosition {
  latestSnapshotId: string | null;
  latestAsOf: string | null;
  latestStatementValue: number | null;
  currency: string | null;
  earliestTransactionDate: string | null;
  publication: PublicationState;
}

export interface TruthRowBusy {
  /** This row is being re-evaluated. */
  certifyingThis: boolean;
  /** Any re-evaluation / bulk re-evaluation is running (one at a time). */
  certifyingAny: boolean;
  publishBusy: boolean;
  unpublishBusy: boolean;
  refreshBusy: boolean;
}

export interface TruthRowProps {
  status: TruthRowStatus;
  position: TruthRowPosition | undefined;
  label: string;
  /** Currency for dates and amounts when the position does not carry one. */
  fallbackCurrency: string;
  busy: TruthRowBusy;
  result: ReevaluationCard | null;
  /** The plain failure of the last Re-evaluate request (network / server), shown instead of a result. */
  resultError: string | null;
  incompleteHistoryNote: boolean;
  onReevaluate: () => void;
  onPublish: (snapshotId: string) => void;
  onRefresh: (snapshotId: string) => void;
  onUnpublish: (publicationId: string) => void;
  onUpload: () => void;
  onGoToAnchor: (targetId: string) => void;
}

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  parsed: 'Parsed',
  reconciliation_required: 'Needs review',
  certified_with_warnings: 'Certified (with warnings)',
  certified: 'Certified',
  failed: 'Failed',
  superseded: 'Superseded',
  archived: 'Archived',
};
const STATUS_CLASS: Record<string, string> = {
  certified: 'bg-green-100 text-green-700',
  certified_with_warnings: 'bg-green-100 text-green-700',
  reconciliation_required: 'bg-amber-100 text-amber-700',
  failed: 'bg-red-100 text-red-700',
};

export const READY_STATUSES = new Set(['certified', 'certified_with_warnings']);

export function PortfolioTruthPositionRow(p: TruthRowProps) {
  const { status: s, position, busy } = p;
  const ready = READY_STATUSES.has(s.status);
  const currency = position?.currency ?? p.fallbackCurrency;
  const money = (n: number) => formatMoneyCode(n, currency);
  const date = (iso: string) => fmtDate(iso, currency);
  const pub: PublicationState = position?.publication ?? { kind: 'not_published' };
  const published = pub.kind !== 'not_published';
  const target = position?.latestSnapshotId ?? null;
  const anyBusy = busy.certifyingAny || busy.publishBusy || busy.unpublishBusy || busy.refreshBusy;

  return (
    <li id={`ii-position-${s.account_id}-${s.instrument_id}`} className="rounded border border-gray-100 px-2 py-1.5 text-sm" data-testid="truth-row" data-publication-state={pub.kind}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-gray-600">{p.label}</span>
        <span className="flex flex-wrap items-center gap-2">
          <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[s.status] ?? 'bg-gray-100 text-gray-700'}`}>{STATUS_LABEL[s.status] ?? s.status}</span>
          {published && (
            <span className="inline-block rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800" data-testid="published-pill">
              Published
            </span>
          )}
          <button
            type="button"
            onClick={p.onReevaluate}
            disabled={anyBusy}
            className="rounded bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-200 disabled:opacity-50"
          >
            {busy.certifyingThis ? 'Re-evaluating…' : 'Re-evaluate'}
          </button>
          {/* Publish ONLY for a position that is not published yet (and is ready). A published position gets Refresh / Unpublish. */}
          {!published && ready && target && (
            <button
              type="button"
              onClick={() => p.onPublish(target)}
              disabled={anyBusy}
              className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Publish to FHIP
            </button>
          )}
          {pub.kind === 'published_refresh_available' && ready && (
            <button
              type="button"
              onClick={() => p.onRefresh(pub.refreshFromPositionId)}
              disabled={anyBusy}
              className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy.refreshBusy ? 'Refreshing…' : 'Refresh'}
            </button>
          )}
          {published && (
            <button
              type="button"
              onClick={() => p.onUnpublish(pub.publicationId)}
              disabled={anyBusy}
              className="rounded border border-amber-400 bg-white px-2 py-1 text-xs font-medium text-amber-900 hover:bg-amber-50 disabled:opacity-50"
            >
              {busy.unpublishBusy ? 'Unpublishing…' : 'Unpublish'}
            </button>
          )}
        </span>
      </div>

      {published && (
        <p className="mt-1 text-xs text-gray-700" data-testid="published-detail">
          {pub.countedValue !== null ? `Counted in net worth: ${money(pub.countedValue)}` : 'Counted in net worth'}
          {pub.publishedAsOf ? ` · from the statement dated ${date(pub.publishedAsOf)}` : ''}.{' '}
          {pub.kind === 'published_refresh_available' ? (
            <span className="text-amber-800" data-testid="stale-note">
              A newer certified statement is available ({date(pub.latestAsOf)}, statement value {money(pub.latestStatementValue)}). Refresh to bring net worth up to date.
            </span>
          ) : (
            <span className="text-green-700">Up to date: no newer certified statement.</span>
          )}
        </p>
      )}

      {/* The result of the last Re-evaluate: always visible, with the time, the figures and what to do. */}
      {busy.certifyingThis && (
        <p role="status" className="mt-1.5 rounded bg-gray-50 px-2 py-1.5 text-xs text-gray-700">
          Re-evaluating this position…
        </p>
      )}
      {p.resultError && (
        <div role="alert" className="mt-1.5 rounded border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-800" data-testid="reevaluate-error">
          Re-evaluate did not complete: {p.resultError} Nothing was changed. Try again; if it keeps failing, reload the page.
        </div>
      )}
      {p.result && !busy.certifyingThis && (
        <div
          role="status"
          aria-live="polite"
          data-testid="reevaluate-result"
          data-tone={p.result.tone}
          className={`mt-1.5 rounded border px-2 py-2 text-xs ${p.result.tone === 'ready' ? 'border-green-200 bg-green-50 text-green-900' : 'border-amber-300 bg-amber-50 text-amber-950'}`}
        >
          <p className="text-sm font-semibold">{p.result.headline}</p>
          <p className="mt-0.5 text-[11px] opacity-80">{p.result.checkedLine}</p>
          {p.result.lines.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {p.result.lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          )}
          {p.result.cta && (
            <div className="mt-1.5">
              {p.result.cta.kind === 'upload' && (
                <button type="button" onClick={p.onUpload} className="rounded bg-gray-900 px-3 py-1 text-xs font-medium text-white">
                  {p.result.cta.label}
                </button>
              )}
              {p.result.cta.kind === 'link' && (
                <a href={p.result.cta.href} className="font-medium text-primary hover:underline">
                  {p.result.cta.label}
                </a>
              )}
              {p.result.cta.kind === 'anchor' && (
                <button type="button" onClick={() => p.onGoToAnchor((p.result!.cta as { targetId: string }).targetId)} className="font-medium text-primary hover:underline">
                  {p.result.cta.label}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* The standing explanation of why it needs review (what / why / how), with the figures for a unit mismatch. */}
      {!ready &&
        !p.result &&
        (s.blocking_reasons ?? []).map((b) => {
          const g = describeTruthBlocker(b.code, b.message);
          const variance = b.code === 'unit_variance_exceeds_tolerance' ? describeUnitVariance({ rebuiltUnits: s.reconciled_closing_units ?? null, statementUnits: s.statement_closing_units ?? null, variance: s.unit_variance ?? null, earliestTransactionDate: position?.earliestTransactionDate ?? null }, date) : null;
          return (
            <div key={b.code} className="mt-1.5 rounded bg-amber-50 px-2 py-1.5 text-xs text-amber-900" data-testid="truth-blocker">
              <p className="font-medium">{variance ? variance.headline.replace(/^Still needs review: /, '') : g.what}</p>
              {variance ? (
                variance.lines.map((l) => <p key={l}>{l}</p>)
              ) : (
                <>
                  <p>{g.why}</p>
                  <p>{g.how}</p>
                </>
              )}
              {variance && (
                <button type="button" onClick={p.onUpload} className="mt-1 rounded bg-gray-900 px-3 py-1 text-xs font-medium text-white">
                  {variance.cta.label}
                </button>
              )}
              {!variance && g.cta.kind === 'link' && (
                <a href={g.cta.href} className="mt-0.5 inline-block font-medium text-primary hover:underline">
                  {g.cta.label}
                </a>
              )}
              {!variance && g.cta.kind === 'anchor' && (
                <button type="button" onClick={() => p.onGoToAnchor(g.cta.kind === 'anchor' ? g.cta.targetId : '')} className="mt-0.5 font-medium text-primary hover:underline">
                  {g.cta.label}
                </button>
              )}
            </div>
          );
        })}

      {p.incompleteHistoryNote && (
        <p className="mt-1.5 rounded bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
          Current holdings were imported successfully. This statement does not contain the complete acquisition history, so some performance and tax calculations may remain unavailable
          until fuller transaction history or a consolidated statement is provided. Uploading a CAMS/KFintech consolidated account statement for this folio can fill in that history.
        </p>
      )}
    </li>
  );
}
