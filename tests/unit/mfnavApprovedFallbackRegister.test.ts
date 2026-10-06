// F8 (PO review 2026-10-06): "Why this is blocked I already approved this as a fallback".
// mfnav.in is APPROVED as a fallback but NOT operational. It must not be listed under
// "Blocked sources - awaiting a Product Owner decision", must appear under "Approved fallback
// sources" with the exact wording, and must never be enabled, built into a URL, or called.
// Admin Standard: section 8 (an approved-but-unproven source is not "operational" and not "awaiting")
// and section 13 (fail closed: nothing here can enable a source).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  APPROVED_FALLBACK_STATEMENT,
  PC6_REFERENCE_SOURCES,
  approvedFallbackSources,
  buildUrl,
  getReferenceSource,
  sourcesAwaitingPoDecision,
  type ReferenceSourceDefinition,
} from '@/lib/config/investment-intelligence/pc6ReferenceSources';
import { ApprovedFallbackList, BlockedSourcesList } from '@/components/admin/referenceDataQuality/SourceRegisterPanels';

const EXACT = 'Approved by the Product Owner as a fallback. Not operational until a genuine HTTP 200 is observed from the real FHIP network path.';
const keys = (list: ReferenceSourceDefinition[]) => list.map((s) => s.sourceKey);

/** Comments may talk about mfnav; executable code may not reference its host or its registry key. */
function mentionsMfnavInCode(src: string): boolean {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return /mfnav\.in|mfnav_fallback_history|['"]mfnav['"]/.test(code);
}

describe('mfnav register: approved fallback, not blocked, not operational', () => {
  it('NEGATIVE CONTROL: the scanner really flags a call to the endpoint or a use of the registry key, and ignores comments', () => {
    expect(mentionsMfnavInCode("await fetch('https://mfnav.in/api/nav')")).toBe(true);
    expect(mentionsMfnavInCode("const s = getReferenceSource('mfnav_fallback_history'); // use it")).toBe(true);
    expect(mentionsMfnavInCode('// mfnav.in is only mentioned in a comment\nconst x = 1;')).toBe(false);
  });

  it('uses the exact approved wording', () => {
    expect(APPROVED_FALLBACK_STATEMENT).toBe(EXACT);
  });

  it('is NOT in the "awaiting a Product Owner decision" group', () => {
    expect(keys(sourcesAwaitingPoDecision())).not.toContain('mfnav');
  });

  it('is in the "approved fallback" group with the decision recorded as 06/10/2026 per Product Owner review', () => {
    expect(keys(approvedFallbackSources())).toEqual(['mfnav']);
    const d = getReferenceSource('mfnav_fallback_history').poDecision;
    expect(d).toEqual({ status: 'approved_fallback', decidedOn: '2026-10-06', basis: 'per Product Owner review' });
  });

  it('other genuinely blocked sources stay blocked', () => {
    expect(keys(sourcesAwaitingPoDecision()).sort()).toEqual(['bse_indices', 'nse_indices', 'rbi']);
    for (const id of ['nse_index_tri', 'bse_index', 'india_risk_free']) expect(getReferenceSource(id).enabled).toBe(false);
    expect(getReferenceSource('india_risk_free').licence).toBe('po_decision_required');
  });

  it('is not operational: disabled, no endpoint, and buildUrl refuses', () => {
    const s = getReferenceSource('mfnav_fallback_history');
    expect(s.enabled).toBe(false);
    expect(s.urlTemplate).toBeNull();
    expect(() => buildUrl('mfnav_fallback_history')).toThrow(/disabled/);
  });

  it('no code path calls its endpoint: no non-registry source file in the investment-intelligence service, config, admin API, cron and admin component code mentions an mfnav host or key as a call target', () => {
    // Scoped to where an investment-intelligence fetch could live (a whole-repo walk is too slow on this disk).
    const roots = [
      'lib/services/investment-intelligence',
      'lib/config',
      'app/api/admin/investment-intelligence',
      'app/api/cron',
      'components/admin',
    ].map((r) => path.join(process.cwd(), r));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx|mjs|js)$/.test(name)) continue;
        if (full.endsWith(path.join('config', 'investment-intelligence', 'pc6ReferenceSources.ts'))) continue;
        const src = readFileSync(full, 'utf8');
        if (mentionsMfnavInCode(src)) offenders.push(path.relative(process.cwd(), full));
      }
    };
    roots.filter((r) => { try { return statSync(r).isDirectory(); } catch { return false; } }).forEach(walk);
    expect(offenders).toEqual([]);
  }, 60_000);

  it('NEGATIVE CONTROL: flipping the source to operational removes it from the approved group (the assertions above would fail)', () => {
    const flipped = { ...PC6_REFERENCE_SOURCES, mfnav_fallback_history: { ...PC6_REFERENCE_SOURCES.mfnav_fallback_history, enabled: true } };
    expect(keys(approvedFallbackSources(flipped))).not.toContain('mfnav');
    expect(() => expect(keys(approvedFallbackSources(flipped))).toEqual(['mfnav'])).toThrow();
    expect(() => expect(flipped.mfnav_fallback_history.enabled).toBe(false)).toThrow();
  });

  it('NEGATIVE CONTROL: dropping the recorded decision puts it back under "awaiting" (the not-under-blocked assertion would fail)', () => {
    const { poDecision: _drop, ...bare } = PC6_REFERENCE_SOURCES.mfnav_fallback_history;
    void _drop;
    const undecided = { ...PC6_REFERENCE_SOURCES, mfnav_fallback_history: bare };
    expect(keys(sourcesAwaitingPoDecision(undecided))).toContain('mfnav');
    expect(() => expect(keys(sourcesAwaitingPoDecision(undecided))).not.toContain('mfnav')).toThrow();
  });
});

describe('mfnav on the admin page', () => {
  const approved = approvedFallbackSources().map((s) => ({
    sourceKey: s.sourceKey, label: s.label, licence: s.licence, termsUrl: s.termsUrl, statement: APPROVED_FALLBACK_STATEMENT,
    decidedOn: s.poDecision?.decidedOn ?? '', decisionBasis: s.poDecision?.basis ?? '', technicalNotes: s.notes, operational: s.enabled,
  }));
  const blocked = sourcesAwaitingPoDecision().map((s) => ({ sourceKey: s.sourceKey, label: s.label, licence: s.licence, termsUrl: s.termsUrl, reason: s.notes }));

  it('the blocked list does not mention mfnav at all', () => {
    const html = renderToStaticMarkup(h(BlockedSourcesList, { rows: blocked }));
    expect(html).not.toMatch(/mfnav/i);
    expect(html).toContain('NSE Indices');
    expect(html).toContain('BSE');
    expect(html).toContain('risk-free');
  });

  it('the approved group shows the exact sentence, the day-first decision date and "not operational"', () => {
    const html = renderToStaticMarkup(h(ApprovedFallbackList, { rows: approved }));
    expect(html).toContain('mfnav.in');
    expect(html).toContain(EXACT);
    expect(html).toContain('Decision recorded 06/10/2026 per Product Owner review.');
    expect(html).toContain('Status: not operational.');
    expect(html).not.toMatch(/awaiting a Product Owner decision/i);
    expect(html).not.toMatch(/\b2026-\d\d-\d\d\b/);
  });

  it('the blocked list is day-first too (ISO dates in server notes are rewritten)', () => {
    const html = renderToStaticMarkup(h(BlockedSourcesList, { rows: blocked }));
    expect(html).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
    expect(html).toContain('15/09/2026');
  });
});
