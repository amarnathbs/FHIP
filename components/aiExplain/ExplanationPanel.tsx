'use client';

// Module 11.5 — the ONE explanation surface (spec sections 17-18, 67-71).
//
// UI PATTERN (spec section 17: "Choose one consistent pattern... Avoid
// creating different explanation UI paradigms for every module"). Exactly one
// component renders every contextual explanation in FHIP:
//   - >= 640px : a right-hand side drawer
//   - <  640px : a bottom sheet
// Both are the same element with the same content, the same accessibility
// contract and the same close behaviour — the responsive difference is purely
// where it is anchored, so the experience reads as one product capability.
//
// ACCESSIBILITY (spec sections 67-68, 107):
//   - role="dialog" + aria-modal="true" + aria-labelledby on a real <h2>
//   - focus moves to the panel heading on open
//   - Tab/Shift+Tab are trapped inside the panel while it is open
//   - Escape closes
//   - focus RETURNS to the control that opened it
//   - the answer region is aria-live="polite" so a screen reader announces it
//   - no colour-only state: every status also has text
//   - no nested interactive controls (the backdrop is a sibling, not a parent)
//
// SPEC SECTION 71: the loading copy is "Loading explanation…" and never
// "AI is thinking" — no provider call is occurring.
//
// SPEC SECTION 96: there is no textbox, no follow-up input, no "ask another
// question" control and no conversation pane anywhere in this file.

import { useCallback, useEffect, useRef } from 'react';
import { Lock, X } from 'lucide-react';
import type { ContextualAnswerPayload } from '@/components/aiExplain/contextualExplainClient';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export function ExplanationPanel({
  open,
  titleId,
  question,
  loading,
  answer,
  onClose,
  onSelectTarget,
  returnFocusTo,
}: {
  open: boolean;
  titleId: string;
  question: string;
  loading: boolean;
  answer: ContextualAnswerPayload | null;
  onClose: () => void;
  onSelectTarget?: (id: string) => void;
  returnFocusTo: React.RefObject<HTMLButtonElement | null>;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Focus in on open, focus back on close (spec section 67).
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = returnFocusTo.current;
    headingRef.current?.focus();
    return () => {
      previouslyFocused?.focus();
    };
  }, [open, returnFocusTo]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const nodes = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      // Trap: the heading itself is focusable (tabIndex -1) but not tabbable,
      // so wrapping is decided purely by the real controls.
      if (e.shiftKey && (active === first || active === headingRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose]
  );

  if (!open) return null;

  const isPremiumBlocked = answer?.status === 'PREMIUM_REQUIRED';
  const hasAnswer = Boolean(answer?.answer);

  return (
    <div className="fixed inset-0 z-50" onKeyDown={onKeyDown}>
      {/* Backdrop is a SIBLING of the panel, never a parent — so the panel's
          controls are not nested inside a clickable region (spec section 67). */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={[
          'absolute bg-white shadow-xl',
          // Mobile: bottom sheet, capped so it never covers the whole screen.
          'inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-hero',
          // >= 640px: right-hand side drawer, full height.
          'sm:inset-y-0 sm:left-auto sm:right-0 sm:bottom-auto sm:max-h-none sm:h-full sm:w-full sm:max-w-md sm:rounded-none sm:rounded-l-hero',
        ].join(' ')}
      >
        <div className="flex items-start justify-between gap-3 border-b border-line p-5">
          <h2 id={titleId} ref={headingRef} tabIndex={-1} className="text-base font-semibold text-ink outline-none">
            {question}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close explanation"
            className="-m-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-compact text-muted hover:bg-gray-50 hover:text-ink"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <div className="space-y-4 p-5" aria-live="polite" aria-busy={loading}>
          {loading && (
            <p className="text-sm text-muted" role="status">
              Loading explanation…
            </p>
          )}

          {!loading && !answer && (
            <p className="text-sm text-muted" role="status">
              This explanation could not be loaded right now.
            </p>
          )}

          {!loading && isPremiumBlocked && (
            <div className="flex items-start gap-3 rounded-card border border-dashed bg-gray-50 p-4">
              <Lock className="mt-0.5 h-5 w-5 shrink-0 text-gray-400" aria-hidden="true" />
              <div>
                <p className="font-medium text-gray-700">Personalised explanations are a Premium feature</p>
                <p className="mt-1 text-sm text-gray-500">
                  Upgrade to Premium to see personalised explanations of your own FHIP figures. Everything already shown on this
                  page stays exactly as it is.
                </p>
              </div>
            </div>
          )}

          {/* Spec section 64 — a historical report explanation says so, up front. */}
          {!loading && answer?.source_context_label && (
            <p className="rounded-compact bg-gray-50 px-3 py-2 text-xs text-muted">{answer.source_context_label}</p>
          )}

          {!loading && answer && !isPremiumBlocked && !hasAnswer && !answer.eligible_targets?.length && (
            <p className="text-sm text-muted">{answer.status_label}</p>
          )}

          {!loading && answer?.eligible_targets && answer.eligible_targets.length > 0 && onSelectTarget && (
            <div>
              <p className="text-sm text-muted">Which goal would you like explained?</p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {answer.eligible_targets.map((target) => (
                  <li key={target.id}>
                    <button
                      type="button"
                      onClick={() => onSelectTarget(target.id)}
                      className="min-h-[44px] rounded-card border border-line bg-white px-3 py-2 text-sm text-ink hover:bg-gray-50"
                    >
                      {target.label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!loading && answer?.answer && (
            <div className="space-y-3">
              <p className="font-medium text-ink">{answer.answer.headline}</p>
              {answer.answer.summary && <p className="text-sm text-muted">{answer.answer.summary}</p>}

              {answer.answer.key_points.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
                  {answer.answer.key_points.map((point, i) => (
                    <li key={i}>{point}</li>
                  ))}
                </ul>
              )}

              {answer.answer.limitations.length > 0 && (
                <ul className="space-y-1 text-xs text-gray-500">
                  {answer.answer.limitations.map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
              )}

              {/* Spec sections 63, 65 — source, date and confidence, with the
                  origin shown using Module 11.4's approved user-safe labels so
                  deterministic data is never presented as AI-generated. */}
              <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3 text-xs text-gray-500">
                {answer.answer_origin_labels.map((label, i) => (
                  <span key={i} className="rounded-full bg-gray-100 px-2 py-0.5">
                    {label}
                  </span>
                ))}
                {answer.data_as_of && <span>Data as of {answer.data_as_of}</span>}
                {answer.confidence && <span>Confidence: {answer.confidence.toLowerCase()}</span>}
              </div>
            </div>
          )}

          {!loading && answer && (
            <div className="flex flex-col gap-2 border-t border-line pt-3">
              <a href={answer.action_route} className="text-sm font-medium text-trust hover:underline">
                Go to {answer.related_module.replace(/_/g, ' ')} →
              </a>
              {/* Spec section 19 — the path from a contextual Explain into the
                  wider Module 11.4 library. Not a chat entry point. */}
              <a href={answer.insights_route} className="text-sm font-medium text-trust hover:underline">
                View more financial insights →
              </a>
            </div>
          )}

          <p className="text-xs text-gray-400">
            Based on your FHIP data. This does not use your custom AI question allowance.
          </p>
        </div>
      </div>
    </div>
  );
}
