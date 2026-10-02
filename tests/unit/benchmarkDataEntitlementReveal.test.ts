// Entitlements tab: an opened Propose / Approve / Revoke panel must be scrolled into view and focused, never
// silently appended far below the control (PO feedback on production: "Propose an entitlement does nothing").
// No DOM environment exists in this repository, so: (1) the pure decision helpers are tested exhaustively, and
// (2) a source-contract test proves the refs are attached and the effect performs the scroll and focus.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { entitlementPanelKeys, revealScrollBehavior, shouldRevealPanel } from '@/components/admin/benchmarkData/benchmarkDataUiLogic';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');

describe('pure reveal decisions', () => {
  it('reveals when a panel opens or a different one opens', () => {
    expect(shouldRevealPanel(null, 'propose')).toBe(true);
    expect(shouldRevealPanel(null, 'approve:e1')).toBe(true);
    expect(shouldRevealPanel('approve:e1', 'revoke:e1')).toBe(true);
    expect(shouldRevealPanel('approve:e1', 'approve:e2')).toBe(true);
  });
  it('does NOT reveal on close, re-render or typing (same key), so it never steals focus while the user types', () => {
    expect(shouldRevealPanel('propose', 'propose')).toBe(false);
    expect(shouldRevealPanel('propose', null)).toBe(false);
    expect(shouldRevealPanel(null, null)).toBe(false);
  });
  it('reveals again when the control is PRESSED while its panel is already open, but never for a closed panel', () => {
    expect(shouldRevealPanel('propose', 'propose', true)).toBe(true);
    expect(shouldRevealPanel(null, null, true)).toBe(false);
  });
  it('prefers-reduced-motion gets an instant jump, otherwise smooth scrolling', () => {
    expect(revealScrollBehavior(true)).toBe('auto');
    expect(revealScrollBehavior(false)).toBe('smooth');
  });
  it('panel keys identify the propose form and the approve/revoke action by entitlement id', () => {
    expect(entitlementPanelKeys(null, null)).toEqual({ propose: null, action: null });
    expect(entitlementPanelKeys({}, { kind: 'revoke', e: { entitlementId: 'abc' } })).toEqual({ propose: 'propose', action: 'revoke:abc' });
  });
});

/** The rules the source must satisfy; each returns a NAME when broken (so a control can show a named failure). */
export function revealContractProblems(tabSrc: string, uiSrc: string): string[] {
  const p: string[] = [];
  if (!/headingRef=\{proposeHeading\}/.test(tabSrc)) p.push('REVEAL-1: the Propose panel heading ref is not attached');
  if (!/headingRef=\{actionHeading\}/.test(tabSrc)) p.push('REVEAL-2: the Approve/Revoke panel heading ref is not attached');
  if (!/scrollIntoView\(\{ block: 'start', behavior: revealScrollBehavior\(reduced\) \}\)/.test(tabSrc)) p.push('REVEAL-3: the opened panel is not scrolled into view with the reduced-motion-aware behaviour');
  if (!/el\.focus\(\{ preventScroll: true \}\)/.test(tabSrc)) p.push('REVEAL-4: keyboard focus is not moved to the opened panel');
  if (!/prefers-reduced-motion: reduce/.test(tabSrc)) p.push('REVEAL-5: prefers-reduced-motion is not consulted');
  if ((tabSrc.match(/setPressTick\(/g) ?? []).length < 3) p.push('REVEAL-6: Propose, Approve and Revoke presses do not all trigger the reveal');
  if (!/proposeInline && proposeForm/.test(tabSrc) || !/const proposeInline = groups\.length === 0/.test(tabSrc)) p.push('REVEAL-7: with no records the Propose form is not rendered directly beneath the panel header');
  if (!/tabIndex=\{headingRef \? -1 : undefined\}/.test(uiSrc)) p.push('REVEAL-8: Panel headings are not programmatically focusable (tabIndex -1) when a ref is supplied');
  return p;
}

describe('source contract: the refs are attached and the effect scrolls and focuses', () => {
  const tab = read('components/admin/benchmarkData/EntitlementsTab.tsx');
  const ui = read('components/admin/benchmarkData/ui.tsx');
  it('the real source satisfies every rule', () => {
    expect(revealContractProblems(tab, ui)).toEqual([]);
  });
  it('NEGATIVE CONTROL: removing the ref, the scroll, the focus, the press trigger, the inline form or tabIndex fails BY NAME', () => {
    expect(revealContractProblems(tab.replace('headingRef={proposeHeading}', ''), ui)).toContain('REVEAL-1: the Propose panel heading ref is not attached');
    expect(revealContractProblems(tab.replace('headingRef={actionHeading}', ''), ui)).toContain('REVEAL-2: the Approve/Revoke panel heading ref is not attached');
    expect(revealContractProblems(tab.replace('el.scrollIntoView(', 'el.scrollIntoViewDisabled('), ui).some((m) => m.startsWith('REVEAL-3'))).toBe(true);
    expect(revealContractProblems(tab.replace('el.focus({ preventScroll: true })', ''), ui).some((m) => m.startsWith('REVEAL-4'))).toBe(true);
    expect(revealContractProblems(tab.replace('prefers-reduced-motion: reduce', 'x'), ui).some((m) => m.startsWith('REVEAL-5'))).toBe(true);
    expect(revealContractProblems(tab.replace(/setPressTick\(\(t\) => t \+ 1\);/g, ''), ui).some((m) => m.startsWith('REVEAL-6'))).toBe(true);
    expect(revealContractProblems(tab.replace('proposeInline && proposeForm', 'false'), ui).some((m) => m.startsWith('REVEAL-7'))).toBe(true);
    expect(revealContractProblems(tab, ui.replace('tabIndex={headingRef ? -1 : undefined}', '')).some((m) => m.startsWith('REVEAL-8'))).toBe(true);
  });
  it('validation, capabilities, API paths and copy are unchanged: the Propose button still gates on canProposeEntitlement and posts to the same path', () => {
    expect(tab).toContain('dec.canProposeEntitlement');
    expect(tab).toContain('apiPaths.entitlements()');
    expect(tab).toContain('Propose an entitlement');
    expect(tab).toContain('validateEntitlementForm(form)');
  });
});
