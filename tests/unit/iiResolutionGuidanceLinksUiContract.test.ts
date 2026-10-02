// Investment Intelligence — resolution-guidance links (2026-09-29).
//
// PO feedback from reviewing live production screens: wherever an
// unresolved-issue message/count is shown (a red "N issue(s)" badge, a
// "positions need attention" badge, an "Open data issues" stat, a data
// quality badge), it must link the user DIRECTLY to where they can actually
// resolve it, rather than reporting a number and leaving them to hunt for
// the right screen/tab themselves.
//
// Investigation found the "N issue(s)" / "N position(s) need attention"
// badges on Statements & data (InvestmentIntelligenceClient.tsx) already
// select the document and reveal its own real resolution UI (Resolve/Assign
// for reconciliation cases, Re-evaluate/Publish for Portfolio Truth) in the
// same page's "Statement detail" section — redirecting them to the Review
// Centre instead would have been a REGRESSION, since the Review Centre has
// no resolver at all for several discrepancy types and, for the rest, only
// pointed back at this same page's UNSCOPED list. The two real gaps fixed
// here are: (1) that unscoped "Review statement" link in ReviewCentreClient,
// and (2) the Holdings table's "unresolved" data-quality badge, which had no
// resolution path anywhere. The badges' own destination is additionally
// strengthened with an auto-scroll so clicking one visibly lands on the
// resolution UI rather than requiring a manual scroll down a long list.
//
// Structural (reads source, does not render) for the same reason as
// tests/unit/iiPc2WorkspaceUiContract.test.ts: this repo's vitest baseline is
// node-environment only, with no jsdom/testing-library.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

describe('Review Centre "Review statement" link is scoped to the actual statement (2026-09-29)', () => {
  const src = read('components/investment-intelligence/ReviewCentreClient.tsx');

  it('passes the review item\'s own sourceDocumentId as a documentId query param, not a bare unscoped href', () => {
    expect(src).toContain('href={`/investment-intelligence/data?documentId=${encodeURIComponent(sourceDocumentId)}`}');
    // The old, unscoped destination must be gone from this link specifically.
    expect(src).not.toContain('href="/investment-intelligence/data"');
  });

  it('does not touch the per-case action buttons (Acknowledge/Dismiss/owner-assign) — additive only', () => {
    expect(src).toContain("onClick={() => act(item.id, 'acknowledge')}");
    expect(src).toContain("onClick={() => act(item.id, 'dismiss')}");
    // 2026-10-01: the one-click household-member "Assign" was replaced by the
    // owner-change dialog (choose member / trust / HUF / company / joint split,
    // then an explicit confirmation). Still a per-case action button.
    expect(src).toContain('Choose the owner…');
    expect(src).toContain('<OwnerChangeDialog');
  });
});

describe('Statements & data page accepts a documentId deep link (2026-09-29)', () => {
  const src = read('app/(app)/investment-intelligence/data/page.tsx');

  it('reads an optional documentId search param server-side', () => {
    expect(src).toMatch(/searchParams:\s*Promise<\{\s*documentId\?:\s*string\s*\}>/);
    expect(src).toContain('await searchParams');
  });

  it('forwards it to the client component as initialDocumentId', () => {
    expect(src).toContain('<InvestmentIntelligenceClient initialDocumentId={initialDocumentId} />');
  });
});

describe('InvestmentIntelligenceClient honours the deep link and scrolls the resolution UI into view (2026-09-29)', () => {
  const src = read('components/investment-intelligence/InvestmentIntelligenceClient.tsx');

  it('accepts an initialDocumentId prop and selects that document on mount', () => {
    expect(src).toContain('initialDocumentId?: string | null');
    expect(src).toMatch(/if \(initialDocumentId\) selectDocument\(initialDocumentId\)/);
  });

  it('scrolls the Statement detail panel into view whenever a document becomes selected', () => {
    expect(src).toContain('const detailSectionRef = useRef<HTMLElement>(null)');
    expect(src).toMatch(/detailSectionRef\.current\.scrollIntoView\(\{\s*behavior:\s*'smooth',\s*block:\s*'start'\s*\}\)/);
    // The ref must actually be attached to the detail section, not just declared.
    expect(src).toContain('<section ref={detailSectionRef} className="rounded-lg border border-gray-200 bg-white p-4">');
  });

  it('keeps the existing badges wired to selectDocument (same-page resolution UI, not a redirect to Review Centre)', () => {
    const badgesSection = src.slice(src.indexOf('renderDocumentRow(doc: SourceDocument)'), src.indexOf('renderDocumentRow(doc: SourceDocument)') + 3000);
    expect(badgesSection).toContain("{doc.openReconciliationCaseCount} issue{doc.openReconciliationCaseCount === 1 ? '' : 's'}");
    expect(badgesSection).toContain('onClick={() => selectDocument(doc.id)}');
  });
});

describe('Holdings table links an unresolved data-quality issue to its statement (2026-09-29)', () => {
  const repoSrc = read('lib/services/investment-intelligence/holdingsRepository.ts');
  const tableSrc = read('components/investment-intelligence/HoldingsTable.tsx');

  it('carries sourceDocumentId through the repository row shape', () => {
    expect(repoSrc).toMatch(/sourceDocumentId:\s*string \| null;/);
    expect(repoSrc).toContain('sourceDocumentId: truth.latest_source_document_id,');
  });

  it('renders a real "Resolve on statement" link for an unresolved row, not just a tooltip', () => {
    expect(tableSrc).toContain("import Link from 'next/link'");
    expect(tableSrc).toContain("h.dataQuality.status === 'unresolved' && h.sourceDocumentId");
    expect(tableSrc).toContain('href={`/investment-intelligence/data?documentId=${encodeURIComponent(h.sourceDocumentId)}`}');
    expect(tableSrc).toContain('Resolve on statement');
  });

  it('stops the link click from also opening the row\'s read-only ledger modal', () => {
    const linkBlock = tableSrc.slice(tableSrc.indexOf('Resolve on statement') - 300, tableSrc.indexOf('Resolve on statement'));
    expect(linkBlock).toContain('onClick={(e) => e.stopPropagation()}');
  });

  it('does not add the same link for an ai_corrected row (already a resolved outcome, informational only)', () => {
    expect(tableSrc).not.toMatch(/ai_corrected'\s*&&\s*h\.sourceDocumentId/);
  });
});
