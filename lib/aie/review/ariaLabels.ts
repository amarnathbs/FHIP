/**
 * AIE-1.5 — pure accessible-label builders (AIE15-A11Y-03/06/09).
 *
 * Split out from the React components as plain functions specifically so
 * they are unit-testable in this repository's `node`-environment Vitest
 * setup (no jsdom/@testing-library is configured anywhere in this repo —
 * confirmed via `vitest.config.ts`, `environment: 'node'`), giving AIE-1.5
 * at least one REAL, executable accessibility assertion per AIE-1.5's
 * mandatory-testing requirement ("at least one accessibility assertion
 * where the harness supports it") rather than an unverifiable claim about
 * rendered DOM this harness cannot check. Full component-level a11y
 * verification (focus trapping, live-region timing, screen-reader output)
 * is recorded as manual/documented certification in
 * AIE_1_5_IMPLEMENTATION.md, matching this repo's own established
 * convention (`FDH8_ACCESSIBILITY_CERTIFICATION.md`,
 * `LR2_ACCESSIBILITY_CLOSURE.md` — no automated a11y tooling exists here to
 * assert against instead).
 */

import type { AieReasonCodeMeta } from './types';

/** A11Y-07: "status is not communicated by colour alone" — every status
 * chip must always carry a REAL, distinct text label, never just a colour
 * class. This function is the single source of that text so a component
 * cannot render a colour-only chip by forgetting to call it. */
export function ariaLabelForUserState(userState: string): string {
  const labels: Record<string, string> = {
    processing: 'Status: processing',
    ready_to_accept: 'Status: ready to accept',
    needs_your_review: 'Status: needs your review',
    unable_to_process_safely: 'Status: unable to process safely',
    accepted_importing: 'Status: accepted, importing',
    import_failed: 'Status: import failed',
    completed: 'Status: completed',
  };
  return labels[userState] ?? `Status: ${userState}`;
}

/** A11Y-03: every correction input gets a real accessible name built from
 * the item's own plain-language question — never the raw field name or
 * reason code alone. */
export function ariaLabelForCorrectionInput(meta: AieReasonCodeMeta, fieldLabel: string): string {
  return `${fieldLabel} — correcting: ${meta.humanQuestion}`;
}

/** A11Y-06: text an `aria-live="polite"` region should announce after a
 * revalidation completes — always non-empty, always plain language, never
 * a raw backend state name (IA-07). */
export function ariaLiveAnnouncementForRevalidation(input: { openBlockingItemCount: number; runStatus: 'unresolved' | 'awaiting_acceptance' }): string {
  if (input.runStatus === 'awaiting_acceptance') return 'All issues resolved. This document is ready to accept.';
  const count = input.openBlockingItemCount;
  return count === 1 ? 'Rechecked. One issue still needs your review.' : `Rechecked. ${count} issues still need your review.`;
}

/** A11Y-09: evidence highlights need a text equivalent, not just a visual
 * box drawn over a page image. */
export function textEquivalentForEvidenceRef(evidenceRef: Record<string, unknown> | null): string {
  if (!evidenceRef) return 'No source location recorded for this item.';
  const ruleId = typeof evidenceRef.ruleId === 'string' ? evidenceRef.ruleId : null;
  const delta = typeof evidenceRef.delta === 'number' ? evidenceRef.delta : null;
  if (ruleId && delta !== null) return `Automated check "${ruleId}" found a difference of ${delta}.`;
  if (ruleId) return `Automated check "${ruleId}" flagged this item.`;
  return 'This item was flagged by an automated check on the document.';
}
