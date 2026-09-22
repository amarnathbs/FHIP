'use client';

import { useEffect, useId, useRef, useState } from 'react';

// Investment Intelligence — AI-fallback document extraction: explicit
// accept/reject UI (2026-09-17 Product Owner addendum).
//
// Shown when the deterministic parser could not recognize a document's
// format (or its own validation rejected the result) but the AI-fallback
// mechanism produced usable data. HARD REQUIREMENT: nothing here is written
// to the user's holdings until they click Accept — this panel's entire
// purpose is to show both cost value (purchase price) and market value per
// holding clearly, so the user can make an informed decision, never to
// auto-apply anything.
//
// Follows the same accessibility conventions as TransactionDetailModal.tsx/
// components/ui/ConfirmDialog.tsx (focus trap, Escape to close, focus
// restored to the opener, aria-modal + labelled title) — this codebase's
// one prior review-and-decide concept close to what the PO asked to reuse
// (AIE's own accept endpoint / the PC5 review-and-decide flow) does not
// exist on this branch (see aiFallbackDocumentExtraction.ts's header for
// the full finding), so this is a genuine, first-built implementation of
// that pattern here, deliberately matching this codebase's OWN existing
// modal conventions rather than inventing a new visual language.

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ExtractedTransactionView {
  dateIso: string;
  description: string;
  amount: number;
  units: number | null;
  navPrice: number | null;
  canonicalType: string;
}

interface ExtractedHoldingView {
  schemeName: string;
  isin: string | null;
  amcName: string | null;
  folioNumber: string | null;
  costValue: number;
  marketValue: number;
  units: number;
  asOfDateIso: string;
  transactions: ExtractedTransactionView[];
}

interface ReviewView {
  id: string;
  trigger_reason: 'format_unrecognized' | 'parse_failed';
  status: 'pending_review' | 'accepted' | 'rejected';
  extracted_holdings: ExtractedHoldingView[];
  provider_confidence: number | null;
}

function money(v: number): string {
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(v);
  } catch {
    return `₹${v.toFixed(2)}`;
  }
}

const TRIGGER_REASON_LABEL: Record<ReviewView['trigger_reason'], string> = {
  format_unrecognized: 'The deterministic parser could not recognize this document’s format at all.',
  parse_failed: 'A parser was identified, but it could not fully validate the extracted data.',
};

export function AiExtractionReviewPanel({
  reviewId,
  onClose,
  onDecided,
}: {
  reviewId: string | null;
  onClose: () => void;
  onDecided: () => void | Promise<void>;
}) {
  const [review, setReview] = useState<ReviewView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const instanceId = useId();
  const titleId = `ai-review-title-${instanceId}`;

  const open = reviewId !== null;

  useEffect(() => {
    if (!reviewId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(`/api/investment-intelligence/ai-extraction-reviews/${reviewId}`);
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) setError(json.error ?? 'Could not load the AI-extracted data.');
        else setReview(json.data as ReviewView);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load the AI-extracted data.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reviewId]);

  useEffect(() => {
    if (!open) {
      setReview(null);
      setError(null);
      return;
    }
    const opener = document.activeElement;
    returnFocusRef.current = opener instanceof HTMLElement ? opener : null;
    closeRef.current?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!panel.contains(active instanceof Node ? active : null)) {
        e.preventDefault();
        first.focus();
        return;
      }
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const opener2 = returnFocusRef.current;
      if (opener2 && document.contains(opener2)) opener2.focus();
    };
  }, [open, onClose]);

  async function handleAccept() {
    if (!reviewId) return;
    setDeciding(true);
    setError(null);
    try {
      const res = await fetch(`/api/investment-intelligence/ai-extraction-reviews/${reviewId}/accept`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not accept this AI-extracted data.');
      await onDecided();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not accept this AI-extracted data.');
    } finally {
      setDeciding(false);
    }
  }

  async function handleReject() {
    if (!reviewId) return;
    setDeciding(true);
    setError(null);
    try {
      const res = await fetch(`/api/investment-intelligence/ai-extraction-reviews/${reviewId}/reject`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not decline this AI-extracted data.');
      await onDecided();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not decline this AI-extracted data.');
    } finally {
      setDeciding(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:items-center">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="relative w-full max-w-3xl rounded-card bg-white p-5 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <h2 id={titleId} className="text-lg font-semibold text-ink">
            Review AI-extracted holdings
          </h2>
          <button ref={closeRef} type="button" onClick={onClose} className="min-h-11 rounded border border-line px-3 py-2 text-sm text-ink hover:bg-gray-50">
            Close
          </button>
        </div>

        <div className="mt-4 max-h-[70vh] overflow-y-auto">
          {loading && <p className="text-sm text-muted">Loading…</p>}
          {/* NAV1 UI-journey audit, 2026-09-22: matching the same fix applied to
              InvestmentIntelligenceClient.tsx's error banner -- this had no
              `role="alert"`, so a screen-reader user reviewing AI-extracted
              data was never told a load/accept/decline failure occurred. */}
          {error && (
            <p role="alert" aria-live="assertive" className="rounded-card border border-risk bg-white p-4 text-sm text-risk">
              {error}
            </p>
          )}
          {review && !loading && (
            <>
              <p className="rounded-card border border-line bg-gray-50 p-3 text-sm text-ink">
                {TRIGGER_REASON_LABEL[review.trigger_reason]} An AI-assisted re-extraction produced the data below. <strong>Nothing has been added to your
                holdings yet</strong> — review each scheme&apos;s purchase (cost) value and current market value, then Accept to record it, or Decline if
                it looks wrong.
                {review.provider_confidence !== null && <span className="text-muted"> Extraction confidence: {(review.provider_confidence * 100).toFixed(0)}%.</span>}
              </p>

              <div className="mt-4 space-y-4">
                {review.extracted_holdings.map((h, i) => (
                  <div key={i} className="rounded-card border border-line p-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="font-medium text-ink">{h.schemeName}</p>
                      <p className="text-xs text-muted">
                        {h.folioNumber ? `Folio ${h.folioNumber}` : null}
                        {h.isin ? ` · ${h.isin}` : null}
                      </p>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <div>
                        <p className="text-xs text-muted">Purchase (cost) value</p>
                        <p className="tabular-nums font-medium text-ink">{money(h.costValue)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted">Market value</p>
                        <p className="tabular-nums font-medium text-ink">{money(h.marketValue)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted">Units</p>
                        <p className="tabular-nums text-ink">{h.units.toFixed(3)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted">As of</p>
                        <p className="text-ink">{h.asOfDateIso}</p>
                      </div>
                    </div>
                    {h.transactions.length > 0 ? (
                      <table className="mt-3 w-full text-left text-xs">
                        <thead>
                          <tr className="border-b border-line uppercase tracking-wide text-muted">
                            <th className="py-1 pr-2 font-medium">Date</th>
                            <th className="py-1 pr-2 font-medium">Description</th>
                            <th className="py-1 pr-2 font-medium text-right">Amount</th>
                            <th className="py-1 pr-2 font-medium text-right">Units</th>
                          </tr>
                        </thead>
                        <tbody>
                          {h.transactions.map((t, j) => (
                            <tr key={j} className="border-b border-line">
                              <td className="py-1 pr-2 tabular-nums text-ink">{t.dateIso}</td>
                              <td className="py-1 pr-2 text-ink">{t.description}</td>
                              <td className="py-1 pr-2 text-right tabular-nums text-ink">{money(t.amount)}</td>
                              <td className="py-1 pr-2 text-right tabular-nums text-muted">{t.units === null ? '—' : t.units.toFixed(3)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <p className="mt-2 text-xs text-muted">No individual transaction lines were extracted for this holding — only its valuation.</p>
                    )}
                  </div>
                ))}
              </div>

              <div className="mt-5 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={handleReject}
                  disabled={deciding}
                  className="min-h-11 rounded border border-line px-3 py-2 text-sm text-ink hover:bg-gray-50 disabled:opacity-50"
                >
                  {deciding ? 'Working…' : 'Decline'}
                </button>
                <button
                  type="button"
                  onClick={handleAccept}
                  disabled={deciding}
                  className="min-h-11 rounded bg-trust px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
                >
                  {deciding ? 'Working…' : 'Accept & add to my holdings'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
