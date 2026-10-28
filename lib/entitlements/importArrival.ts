/**
 * Where a person lands after choosing a locked Import control (PO defect, 28-10-2026).
 *
 * The locked control links to `/profile?from=import-<domain>`. The Billing / plan section is far down a long page,
 * so the profile page moves the person to it. This file is the small browser-side helper for that move. It takes
 * its environment as arguments so it can be proved with plain objects, with no DOM.
 */

import { FINANCIAL_IMPORT_PLAN_SECTION_ID } from './financialDataImportContract';

export interface PlanSectionEnv {
  getElementById(id: string): {
    scrollIntoView(options?: { behavior?: 'auto' | 'smooth'; block?: 'start' | 'center' | 'end' | 'nearest' }): void;
    focus(options?: { preventScroll?: boolean }): void;
  } | null;
  /** `window.matchMedia`, or undefined where it does not exist. */
  matchMedia?: (query: string) => { matches: boolean };
}

/** The real browser environment for `focusPlanSection`. Only call in the browser (an effect or an event handler). */
export function browserPlanSectionEnv(): PlanSectionEnv {
  return {
    getElementById: (id) => document.getElementById(id),
    matchMedia: typeof window.matchMedia === 'function' ? (q) => window.matchMedia(q) : undefined,
  };
}

/** True when the person has asked their system for reduced motion. Unknown means "reduce": never animate by guesswork. */
export function prefersReducedMotion(env: Pick<PlanSectionEnv, 'matchMedia'>): boolean {
  if (typeof env.matchMedia !== 'function') return true;
  try {
    return env.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return true;
  }
}

/**
 * Scrolls the plan section into view and moves keyboard / screen-reader focus to it. Smooth scrolling only when
 * reduced motion is NOT requested. Returns false when the section is not on the page (for example while the
 * profile is still loading), so the caller can try again once it is.
 */
export function focusPlanSection(env: PlanSectionEnv): boolean {
  const el = env.getElementById(FINANCIAL_IMPORT_PLAN_SECTION_ID);
  if (!el) return false;
  el.scrollIntoView({ behavior: prefersReducedMotion(env) ? 'auto' : 'smooth', block: 'start' });
  // Scrolling was done above with the right motion preference; do not let focus() scroll a second time.
  el.focus({ preventScroll: true });
  return true;
}
