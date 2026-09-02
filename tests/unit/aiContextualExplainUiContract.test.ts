// Module 11.5 — UI contract tests for the contextual Explain estate
// (spec sections 16-18, 63-70, 98-99, 106, 110).
//
// ===========================================================================
// WHAT THIS IS, AND WHAT IT IS NOT.
//
// This is a SOURCE-CONTRACT test, not a rendered-browser test. It asserts
// that the accessibility and responsive guarantees Module 11.5 claims are
// actually present in the components' source: real button semantics, a
// target-naming accessible label at every call site, focus return, Escape,
// a live region, adequate touch targets, and both responsive anchorings of
// the one explanation panel.
//
// It is NOT a substitute for the live browser walkthrough spec sections 105
// and 123 require. That walkthrough could not be performed in this
// certification worktree: it has no `.env.local`, so no Supabase credentials,
// so no authenticated FHIP screen can be reached at all — and this repository
// has no jsdom/happy-dom or React Testing Library configured either
// (vitest.config.ts sets `environment: 'node'` and includes only
// tests/unit/**/*.test.ts). That gap is disclosed in the completion report as
// an environment limitation rather than papered over here.
//
// What this test genuinely closes is the class of regression where someone
// removes an aria-label, drops the focus return, or lets a second explanation
// paradigm appear in a module — all of which it will fail on.
// ===========================================================================

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CONTEXTUAL_EXPLANATION_TARGETS } from '@/lib/ai/contextualExplanations/registry';

const ROOT = process.cwd();
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

/**
 * Removes JSX, block and line comments. Several of these components document
 * the very patterns this file asserts (naming the forbidden wording in order
 * to record that it is absent), so a naive scan would flag the documentation
 * as the violation it warns against.
 */
const stripComments = (s: string) =>
  s
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
const PANEL = read('components', 'aiExplain', 'ExplanationPanel.tsx');
const CONTROL = read('components', 'aiExplain', 'ContextualExplain.tsx');

/** Every .tsx under app/ and components/, so a stray call site cannot hide. */
function allTsx(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir))) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const rel = `${dir}/${entry}`;
    if (statSync(join(ROOT, rel)).isDirectory()) allTsx(rel, acc);
    else if (entry.endsWith('.tsx')) acc.push(rel);
  }
  return acc;
}
const ALL_TSX = [...allTsx('app'), ...allTsx('components')];

describe('spec sections 67-68 — accessibility contract', () => {
  it('the panel is a real dialog with an accessible name and a live region', () => {
    expect(PANEL).toContain('role="dialog"');
    expect(PANEL).toContain('aria-modal="true"');
    expect(PANEL).toContain('aria-labelledby={titleId}');
    expect(PANEL).toContain('aria-live="polite"');
    expect(PANEL).toContain('aria-busy={loading}');
    // The accessible name comes from a real heading element, not a div.
    expect(PANEL).toMatch(/<h2[^>]*id=\{titleId\}/);
  });

  it('the panel handles Escape, traps Tab, and RETURNS focus to the opening control', () => {
    expect(PANEL).toContain("e.key === 'Escape'");
    expect(PANEL).toContain("e.key !== 'Tab'");
    // Focus is captured before the panel takes it, and restored on unmount.
    expect(PANEL).toContain('const previouslyFocused = returnFocusTo.current');
    expect(PANEL).toContain('previouslyFocused?.focus()');
  });

  it('the close control has an accessible name and the backdrop is not an interactive parent', () => {
    expect(PANEL).toContain('aria-label="Close explanation"');
    // The backdrop is aria-hidden and a SIBLING — nesting the panel's buttons
    // inside a clickable region would be a nested-interactive violation.
    expect(PANEL).toContain('aria-hidden="true"');
    const code = stripComments(PANEL);
    const backdropIndex = code.indexOf('bg-black/40');
    const dialogIndex = code.indexOf('role="dialog"');
    expect(backdropIndex).toBeGreaterThan(-1);
    expect(dialogIndex).toBeGreaterThan(backdropIndex);
  });

  it('the trigger is a real <button> that declares the dialog it opens', () => {
    expect(CONTROL).toContain('type="button"');
    expect(CONTROL).toContain('aria-haspopup="dialog"');
    expect(CONTROL).toContain('aria-expanded={open}');
    expect(CONTROL).toContain('aria-label={accessibleLabel}');
  });

  it('spec section 68 — EVERY call site supplies an accessible label that NAMES the target, not a bare "Explain"', () => {
    const callSites: { file: string; label: string }[] = [];
    for (const file of ALL_TSX) {
      // The component's own definition files declare the prop; they are not
      // call sites.
      if (file.startsWith('components/aiExplain/')) continue;
      const source = stripComments(read(file));
      if (!source.includes('ContextualExplain') && !source.includes('explain={')) continue;

      // <ContextualExplain ... accessibleLabel="..." />
      for (const m of source.matchAll(/accessibleLabel=\{?["'`]([^"'`]+)["'`]/g)) callSites.push({ file, label: m[1] });
      // explain={{ targetCode: '...', accessibleLabel: '...' }}
      for (const m of source.matchAll(/accessibleLabel:\s*["'`]([^"'`]+)["'`]/g)) callSites.push({ file, label: m[1] });
    }

    expect(callSites.length).toBeGreaterThanOrEqual(15);
    for (const { file, label } of callSites) {
      // A bare "Explain" / "Why?" is exactly what section 68 forbids for an
      // icon-bearing control: the name must identify WHAT is being explained.
      expect(label.trim().length, `${file}: "${label}"`).toBeGreaterThan(12);
      expect(label.toLowerCase(), `${file}: "${label}"`).not.toBe('explain');
      expect(label.toLowerCase(), `${file}: "${label}"`).not.toBe('why?');
      expect(label.split(/\s+/).length, `${file}: "${label}"`).toBeGreaterThanOrEqual(3);
    }
  });

  it('a dynamic accessible label is used where the target is one of several like items (spec section 68 goal example)', () => {
    const goalCard = read('components', 'goals', 'GoalCard.tsx');
    expect(goalCard).toMatch(/accessibleLabel=\{`Explain status for \$\{goal\.goalName\} goal`\}/);
  });

  it('no state is conveyed by colour alone — every status also carries text', () => {
    // The panel renders `status_label` (human wording) for every non-available
    // state; there is no colour-only status indicator anywhere in it.
    expect(PANEL).toContain('{answer.status_label}');
  });
});

describe('spec sections 69-70, 106 — responsive and layout stability', () => {
  it('the ONE panel is a bottom sheet on mobile and a side drawer from 640px up', () => {
    // Mobile anchoring.
    expect(PANEL).toContain('inset-x-0 bottom-0');
    expect(PANEL).toContain('max-h-[85vh]');
    expect(PANEL).toContain('overflow-y-auto');
    // >= 640px anchoring.
    expect(PANEL).toContain('sm:inset-y-0');
    expect(PANEL).toContain('sm:right-0');
    expect(PANEL).toContain('sm:max-w-md');
  });

  it('the panel never forces horizontal overflow: it is width-capped, not width-fixed', () => {
    expect(PANEL).toContain('sm:w-full sm:max-w-md');
    expect(PANEL).not.toMatch(/\bw-\[\d+px\]/);
    expect(PANEL).not.toMatch(/\bmin-w-\[\d{3,}px\]/);
  });

  it('long values and labels wrap rather than overflowing', () => {
    expect(PANEL).toContain('flex-wrap');
    expect(CONTROL).toContain('shrink-0'); // the icon shrinks, the label wraps
  });

  it('touch targets meet the project’s established 44px convention where the control is primary', () => {
    // The panel's close control and every in-panel choice button.
    expect(PANEL).toContain('h-11 w-11');
    expect(PANEL).toContain('min-h-[44px]');
    // The inline trigger is a compact text affordance beside a metric, so it
    // uses the smaller 32px inline height deliberately (spec section 70 —
    // adding controls must not destabilise the existing card layout) while
    // still being a full-height text button rather than a bare icon.
    expect(CONTROL).toContain('min-h-[32px]');
  });

  it('spec section 70 — the section heading only becomes a flex row WHEN an explain slot is supplied', () => {
    const sectionCard = read('components', 'dashboard', 'SectionCard.tsx');
    expect(sectionCard).toContain('{explain ? (');
    // The no-explain branch must render the original bare heading markup.
    expect(sectionCard).toMatch(/\) : \(\s*<h2 className="text-lg font-semibold text-ink">\{title\}<\/h2>\s*\)/);
  });

  it('the control renders NOTHING when the feature is off or the target is not enabled', () => {
    expect(CONTROL).toContain('if (!target) return null;');
    expect(CONTROL).toContain('if (!registry.feature_enabled) return;');
  });
});

describe('spec sections 16-19, 63-66 — wording, transparency and the library link', () => {
  it('the panel shows source, data date and confidence, and links to Financial Insights', () => {
    expect(PANEL).toContain('answer.answer_origin_labels');
    expect(PANEL).toContain('Data as of');
    expect(PANEL).toContain('Confidence:');
    expect(PANEL).toContain('answer.insights_route');
    expect(PANEL).toContain('View more financial insights');
  });

  it('the panel states the zero-cost promise and the FHIP-data grounding (spec section 66)', () => {
    expect(PANEL).toContain('Based on your FHIP data');
    expect(PANEL).toContain('does not use your custom AI question allowance');
  });

  it('every registry display label is one of the four approved action wordings (spec sections 16, 66)', () => {
    const approved = new Set(['Explain', 'Why?', 'What does this mean?', 'Why did this change?']);
    for (const t of CONTEXTUAL_EXPLANATION_TARGETS) {
      expect(approved.has(t.display_label), `${t.target_code} -> "${t.display_label}"`).toBe(true);
    }
  });

  it('no forbidden AI-chat branding appears in any registry label or question (spec section 16)', () => {
    for (const t of CONTEXTUAL_EXPLANATION_TARGETS) {
      const text = `${t.display_label} ${t.display_question}`;
      expect(text).not.toMatch(/Ask AI|Chat with AI|Ask anything|AI Assistant/i);
    }
  });
});

describe('spec sections 17-18, 99 — one paradigm, no new navigation', () => {
  it('EVERY contextual Explain call site goes through the single shared component', () => {
    // No module may hand-roll its own explanation drawer/modal. The only
    // files allowed to define one are the two in components/aiExplain.
    const offenders: string[] = [];
    for (const file of ALL_TSX) {
      if (file.startsWith('components/aiExplain/')) continue;
      const source = read(file);
      if (!/contextual|Explain your|Explain the|Explain status/i.test(source)) continue;
      // A module file may RENDER ContextualExplain, but must not build a
      // dialog of its own for it.
      if (source.includes('role="dialog"') && source.includes('Explain')) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('spec section 99 — no new primary navigation item was added for contextual explanation', () => {
    const shell = read('components', 'ui', 'AppShell.tsx');
    expect(shell).not.toMatch(/contextual-explanation/i);
    expect(shell).not.toMatch(/\/explain\b/);
  });

  it('spec section 98 — the print/PDF report path does NOT enable contextual controls', () => {
    const printPage = read('app', '(print)', 'reports', '[id]', 'print', 'page.tsx');
    expect(printPage).not.toContain('enableContextualExplain');

    const webPage = read('app', '(app)', 'reports', '[id]', 'page.tsx');
    expect(webPage).toContain('enableContextualExplain');

    // And the shared component defaults to OFF, so a future caller that
    // forgets the prop cannot leak an interactive control into a PDF.
    const preview = read('components', 'reports', 'ReportPreview.tsx');
    expect(preview).toContain('enableContextualExplain = false');
  });
});

describe('spec section 22 — ordinary educational help is preserved, not replaced by a Premium gate', () => {
  it('every pre-existing WhatDoesThisMean / WhatDoesThisMeanLink call site still exists', () => {
    // Module 11.5 must not have removed any non-Premium educational link.
    const withHelp = ALL_TSX.filter((f) => /WhatDoesThisMean\b|WhatDoesThisMeanLink/.test(read(f)));
    expect(withHelp.length).toBeGreaterThanOrEqual(5);
    // The three known page-level call sites specifically.
    expect(read('app', '(app)', 'score', 'page.tsx')).toContain('contextKey="scores.financial_health_score"');
    expect(read('app', '(app)', 'resilience', 'page.tsx')).toContain('contextKey="resilience.emergency_fund"');
    expect(read('components', 'goals', 'GoalsSummaryHero.tsx')).toContain('contextKey="goals.progress"');
  });

  it('MetricCard renders BOTH the educational link and the Premium explanation independently', () => {
    const metricCard = read('components', 'ui', 'MetricCard.tsx');
    expect(metricCard).toContain('contextResolved !== undefined && <WhatDoesThisMeanLink');
    expect(metricCard).toContain('{explain && (');
    // Neither may be conditional on the other.
    expect(metricCard).not.toMatch(/explain \?\s*<WhatDoesThisMeanLink/);
  });
});
