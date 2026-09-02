'use client';

// Module 11.5 — the ONE Explain / Why? control (spec sections 16-18, 66-70).
//
// Drop `<ContextualExplain targetCode="..." accessibleLabel="..." />` next to
// a metric or section heading and that surface gains contextual explanation.
// Every module uses this same component, so there is exactly one explanation
// paradigm in the product.
//
// LABELS (spec sections 16, 66). The wording comes from the SERVER-SIDE
// registry (`display_label`: Explain / Why? / Why did this change? / What does
// this mean?). "Ask AI", "Chat with AI", "Ask anything" and "AI Assistant"
// appear nowhere — this is contextual explanation, not open chat.
//
// LAYOUT STABILITY (spec section 70). The control is a compact inline text
// button that occupies one short line. It renders NOTHING at all when the
// feature is off or the target is not in the registry, so a disabled feature
// leaves the host module byte-identical to before.
//
// SPEC SECTION 22 — this is deliberately NOT a replacement for the existing
// non-Premium `WhatDoesThisMeanLink` educational help. Both can sit on the
// same card: that one answers "what is net worth?" from the Resources
// glossary for every user; this one answers "why is MY net worth what it is?"
// from the household's own certified data for Premium users. The default
// labels are chosen so the two never read as the same control.

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ExplanationPanel } from '@/components/aiExplain/ExplanationPanel';
import {
  loadContextualRegistry,
  resolveContextualExplanation,
  type ContextualAnswerPayload,
  type ContextualTargetSummary,
} from '@/components/aiExplain/contextualExplainClient';

// ANALYTICS NOTE (spec sections 60-61). This component emits no client-side
// analytics beacon, deliberately: every event section 60 names is already
// exactly observable on the server, and adding a browser beacon would put a
// second FHIP request on the wire for no additional truth (spec section 104
// asks the network tab to show only zero-cost resolution traffic).
//   contextual_explain_impression  -> recorded server-side, once per enabled
//        target returned by GET /api/ai/contextual-explanations, i.e. once per
//        control actually OFFERED on a page load.
//   contextual_explain_selected    -> recorded server-side on entry to
//        AIContextualExplanationService.resolveExplanation, i.e. once per
//        control a user actually CLICKED.
//   resolved / unavailable / premium_blocked -> recorded on the outcome.
// Section 61's rule holds structurally as a result: an impression is counted
// by a different endpoint than a resolution, so rendering a button can never
// increment an avoided call.

export function ContextualExplain({
  targetCode,
  targetId,
  contextId,
  accessibleLabel,
  className,
}: {
  targetCode: string;
  /** The owned entity this control explains (goal id / report id). */
  targetId?: string | null;
  /** The snapshot the surrounding page is displaying; verified server-side. */
  contextId?: string | null;
  /**
   * Spec section 68 — the accessible name MUST name the target, not just say
   * "Explain". e.g. "Explain your Financial Health Score",
   * "Explain status for Home Deposit goal".
   */
  accessibleLabel: string;
  className?: string;
}) {
  const [target, setTarget] = useState<ContextualTargetSummary | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState<ContextualAnswerPayload | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    let cancelled = false;
    loadContextualRegistry().then((registry) => {
      if (cancelled) return;
      if (!registry.feature_enabled) return; // spec section 58 — control disappears
      setTarget(registry.targets.find((t) => t.target_code === targetCode) ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [targetCode]);

  const ask = useCallback(
    async (entityId?: string | null) => {
      setLoading(true);
      setAnswer(null);
      try {
        const result = await resolveContextualExplanation({
          targetCode,
          targetId: entityId ?? targetId ?? null,
          contextId: contextId ?? null,
        });
        setAnswer(result);
      } finally {
        setLoading(false);
      }
    },
    [targetCode, targetId, contextId]
  );

  const onOpen = useCallback(() => {
    setOpen(true);
    void ask();
  }, [ask]);

  const onClose = useCallback(() => {
    setOpen(false);
    setAnswer(null);
  }, []);

  // Feature off, registry unreadable, or target not enabled -> render nothing.
  if (!target) return null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={onOpen}
        aria-label={accessibleLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={
          className ??
          'mt-1 inline-flex min-h-[32px] items-center gap-1 text-xs font-medium text-ai hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ai focus-visible:ring-offset-1'
        }
      >
        <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5 shrink-0">
          <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M6.2 6.2a1.9 1.9 0 1 1 2.3 2.2v1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="8.4" cy="11.4" r="0.85" fill="currentColor" />
        </svg>
        {target.display_label}
      </button>

      <ExplanationPanel
        open={open}
        titleId={titleId}
        question={answer?.question ?? target.display_question}
        loading={loading}
        answer={answer}
        onClose={onClose}
        onSelectTarget={target.target_entity_type === 'goal' ? (id) => void ask(id) : undefined}
        returnFocusTo={buttonRef}
      />
    </>
  );
}
