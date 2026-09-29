// Statements & data list — "Previously processed" grouping, UI wiring
// (2026-09-29 fix). The grouping RULE itself is unit tested directly against
// pure functions in tests/unit/iiSourceDocumentGrouping.test.ts. This suite
// covers what that one cannot: that the component actually wires the rule
// into the list, keeps the section collapsed by default, and never deletes
// or permanently hides a processed document.
//
// Structural (reads source, does not render) for the same reason as
// tests/unit/iiPc2WorkspaceUiContract.test.ts: this repo's vitest baseline is
// node-environment only, with no jsdom/testing-library (see that file's own
// header).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const src = read('components/investment-intelligence/InvestmentIntelligenceClient.tsx');

describe('Previously processed statements section', () => {
  it('partitions the fetched documents via the shared, unit-tested grouping helper', () => {
    // Guards against the rule being re-implemented inline (and drifting from
    // the tested version) instead of imported.
    expect(src).toContain("import { partitionSourceDocumentsByProcessedState } from '@/lib/investment-intelligence/sourceDocumentGrouping'");
    expect(src).toContain('partitionSourceDocumentsByProcessedState(documents ?? [])');
  });

  it('renders only the active documents in the primary working list', () => {
    const listSection = src.slice(src.indexOf('{/* Document list */}'), src.indexOf('{/* 2026-09-29 fix: a fully processed'));
    expect(listSection).toContain('activeDocuments.map((doc) => renderDocumentRow(doc))');
    // The primary list must never map over the full unfiltered array.
    expect(listSection).not.toMatch(/\bdocuments\.map\(/);
  });

  it('is collapsed by default', () => {
    expect(src).toMatch(/const \[showProcessed, setShowProcessed\] = useState\(false\)/);
  });

  it('exposes an accessible expand/collapse toggle showing the count, not a bare link', () => {
    const section = src.slice(src.indexOf('previouslyProcessedDocuments.length > 0'), src.indexOf('previouslyProcessedDocuments.length > 0') + 1200);
    expect(section).toContain('aria-expanded={showProcessed}');
    expect(section).toMatch(/previously processed statements \(\{previouslyProcessedDocuments\.length\}\)/);
  });

  it('never deletes or unconditionally hides a processed document — it renders behind the same row renderer, only gated on showProcessed', () => {
    const section = src.slice(src.indexOf('previouslyProcessedDocuments.length > 0'), src.indexOf('previouslyProcessedDocuments.length > 0') + 1200);
    expect(section).toContain('previouslyProcessedDocuments.map((doc) => renderDocumentRow(doc))');
    // Reachable state, not a dead branch: the list appears once showProcessed
    // is true, it is not `return null` or otherwise permanently suppressed.
    expect(section).toMatch(/\{showProcessed && \(/);
  });

  it('reuses the exact same row renderer for both lists, so clicking into a processed document is unchanged', () => {
    // Both lists must call the identical function reference so any future
    // change to a row (buttons, badges, click-through to the detail panel)
    // automatically applies to both, and the two can never drift apart.
    // (.map((doc) => renderDocumentRow(doc)), not a bare comment mention.)
    const occurrences = src.match(/\.map\(\(doc\) => renderDocumentRow\(doc\)\)/g) ?? [];
    expect(occurrences.length).toBe(2);
  });

  it('does not add a second detail/summary code path for a processed document', () => {
    // Scope guard: clicking into a "previously processed" document must use
    // the exact same selectDocument()/detail-panel flow as any other row.
    expect(src.match(/function selectDocument/g) ?? []).toHaveLength(1);
  });
});
