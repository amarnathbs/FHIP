// Investment Intelligence "Your statements" list + statement detail, PO review of 29-10-2026:
//  (A) a fully published statement is not "N ready to publish"           -> sourceDocumentGrouping / sourceDocumentEnrichment tests, wiring below
//  (B) archived statements are not in the prominent list and carry no issue count -> wiring below
//  (C) Re-evaluate on a PUBLISHED position never says "ready to publish"  -> buildReevaluationCard / describeReevaluationOutcome
//  (D) no ISO date and no bare "?" in the statement components           -> describeStatementPeriod + a source scan
//
// Node-only vitest baseline (no jsdom), so the component is checked structurally, exactly like iiStatementsArchiveProcessedUiContract.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { buildReevaluationCard, type ReevaluationFacts } from '@/lib/investment-intelligence/reevaluationResult';
import { describeReevaluationOutcome } from '@/lib/services/investment-intelligence/caseLifecycle';
import { describeStatementPeriod } from '@/lib/investment-intelligence/statementPeriod';
import { fmtDate } from '@/components/investment-intelligence/dateDisplay';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const client = read('components/investment-intelligence/InvestmentIntelligenceClient.tsx');

const facts = (over: Partial<ReevaluationFacts>): ReevaluationFacts => ({
  before: 'certified',
  after: 'certified',
  blocking: [],
  reconciledClosingUnits: 10,
  statementClosingUnits: 10,
  unitVariance: 0,
  earliestTransactionDate: null,
  previousReasonCodes: [],
  checkedAtLabel: '29-10-2026 10:00',
  ...over,
});
const same = (d: string) => d;

describe('(C) Re-evaluate result on an already published position', () => {
  it('REGRESSION: a published, unchanged position never says "ready to publish"', () => {
    const c = buildReevaluationCard(facts({ publication: 'published_current' }), same);
    expect(c.headline).toBe('Re-evaluated: nothing changed. The published position is still published and up to date.');
    expect(c.headline).not.toMatch(/ready to publish/);
    expect(c.tone).toBe('ready');
  });

  it('a published position whose status changed (but is certified) says the published position is unchanged', () => {
    const c = buildReevaluationCard(facts({ before: 'certified_with_warnings', after: 'certified', publication: 'published_current' }), same);
    expect(c.headline).toBe('Re-evaluated: this position is certified. The published position is unchanged and up to date.');
    expect(c.headline).not.toMatch(/ready to publish/);
  });

  it('a published position with a newer certified statement points at Refresh, still without "ready to publish"', () => {
    const c = buildReevaluationCard(facts({ publication: 'published_refresh_available' }), same);
    expect(c.headline).toMatch(/published, and a newer certified statement is available/);
    expect(c.headline).toMatch(/Refresh/);
    expect(c.headline).not.toMatch(/ready to publish/);
  });

  it('a NOT yet published position still says it is ready to publish (the wording is kept where it is true)', () => {
    expect(buildReevaluationCard(facts({ publication: 'not_published' }), same).headline).toBe('Re-evaluated: nothing changed. This position is still ready to publish.');
    expect(buildReevaluationCard(facts({ before: 'reconciliation_required', publication: 'not_published' }), same).headline).toBe('Re-evaluated: this position is now ready to publish.');
    // omitted means not published (the earlier behaviour)
    expect(buildReevaluationCard(facts({}), same).headline).toBe('Re-evaluated: nothing changed. This position is still ready to publish.');
  });

  it('a published position that now fails a check says so and that it is still published at its last certified value', () => {
    const c = buildReevaluationCard(
      facts({ before: 'certified', after: 'reconciliation_required', blocking: [{ code: 'owner_unmatched', message: 'Owner not set.' }], previousReasonCodes: [], publication: 'published_current' }),
      same,
    );
    expect(c.tone).toBe('blocked');
    expect(c.lines.join(' ')).toMatch(/still published at its last certified value/);
    // and a not-published position gets no such line
    const np = buildReevaluationCard(facts({ before: 'certified', after: 'reconciliation_required', blocking: [{ code: 'owner_unmatched', message: 'Owner not set.' }] }), same);
    expect(np.lines.join(' ')).not.toMatch(/still published/);
  });

  it('the one-line outcome text follows the same rule', () => {
    expect(describeReevaluationOutcome('certified', 'certified', [], true)).not.toMatch(/ready to publish/);
    expect(describeReevaluationOutcome('certified', 'certified', [], true)).toMatch(/still published and up to date/);
    expect(describeReevaluationOutcome('certified', 'certified', [])).toMatch(/still ready to publish/);
  });

  it("the screen hands the position's real publication state to the card", () => {
    expect(client).toMatch(/publication: summary\?\.positions\?\.\[key\]\?\.publication\.kind \?\? 'not_published'/);
  });
});

describe('(D) statement period and dates', () => {
  const inr = (d: string) => fmtDate(d, 'INR');
  const aud = (d: string) => fmtDate(d, 'AUD');

  it('REGRESSION: India shows dd-mm-yyyy and never the ISO date or a bare "?"', () => {
    const t = describeStatementPeriod(null, '2026-10-22', inr);
    expect(t).toBe('Statement period: up to 22-10-2026 (start date not stated)');
    expect(t).not.toMatch(/\?|2026-10-22/);
  });

  it('both dates: dd-mm-yyyy for India, dd/mm/yyyy for Australia', () => {
    expect(describeStatementPeriod('1990-01-01', '2026-09-06', inr)).toBe('Statement period: 01-01-1990 to 06-09-2026');
    expect(describeStatementPeriod('1990-01-01', '2026-09-06', aud)).toBe('Statement period: 01/01/1990 to 06/09/2026');
  });

  it('an unknown end is said in words too, and nothing is drawn when neither is known', () => {
    expect(describeStatementPeriod('2026-01-02', null, inr)).toBe('Statement period: from 02-01-2026 (end date not stated)');
    expect(describeStatementPeriod(null, null, inr)).toBeNull();
    expect(describeStatementPeriod('', undefined, inr)).toBeNull();
  });

  it('the detail header uses the shared formatter, not the stored value', () => {
    expect(client).toContain('describeStatementPeriod(summary.document.statement_period_start, summary.document.statement_period_end');
    expect(client).not.toMatch(/\{summary\.document\.statement_period_(start|end) \?\? '\?'\}/);
  });
});

// A heuristic scan of the statement / portfolio-truth components for a date-like value placed straight into the page. A "date-like value" is a
// reference to a field/variable whose name says it is a date; it is allowed only inside a shared formatter call.
const DATE_NAME = /(statement_period_(start|end)|as_?of_?date|(?<![A-Za-z])asOf|[a-z]Date\b|_date\b|date_?iso|dateIso|DateIso|navDate|periodStart|periodEnd)/i;
const FORMATTER = /\b(fmtDate|fmtDateTime|formatDateShort|formatDateTimeShort|formatDateDMY|formatDateTimeDMY|formatDateInText|date|describeStatementPeriod)\s*\(/;

/** Single-line `{expr}` JSX children and `${expr}` template parts that show a date-like name without a formatter. */
export function findRawDateRenders(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const hits: string[] = [];
  const re = /(?<![=\w$])\$?\{([^{}\n]+)\}/g;
  for (const line of code.split('\n')) {
    // Not rendered: imports and type declarations.
    if (/^\s*(import|export type|export interface|type|interface)\b/.test(line)) continue;
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(line))) {
      const expr = m[1];
      if (!DATE_NAME.test(expr)) continue;
      if (FORMATTER.test(expr)) continue;
      // An object literal or a type body, not a rendered value.
      if (/^\s*[\w$]+\??\s*:/.test(expr)) continue;
      // Not rendered as text: conditions, comparisons, handlers.
      if (/(&&|\|\||===|!==|=>)/.test(expr) && !/\?\?/.test(expr)) continue;
      hits.push(`${expr.trim()}   <-- ${line.trim().slice(0, 120)}`);
    }
  }
  return hits;
}

describe('(D) no raw ISO date rendering in the statement / portfolio-truth components', () => {
  const FILES = [
    'InvestmentIntelligenceClient.tsx',
    'PortfolioTruthPositionRow.tsx',
    'AiExtractionReviewPanel.tsx',
    'HoldingsTable.tsx',
    'OwnerConflictPanel.tsx',
    'OwnerChangeDialog.tsx',
    'ReplacementCopyControl.tsx',
    'ProbableDuplicateReview.tsx',
    'ProbableDuplicateBanner.tsx',
    'ResolutionHistoryClient.tsx',
    'TransactionDetailModal.tsx',
    'SipIntelligenceClient.tsx',
  ];

  it('every file listed exists (the scan cannot silently scan nothing)', () => {
    const present = new Set(readdirSync(path.join(ROOT, 'components/investment-intelligence')));
    for (const f of FILES) expect(present.has(f), f).toBe(true);
  });

  for (const f of FILES) {
    it(`${f}: no date-like value is rendered without the shared formatter`, () => {
      expect(findRawDateRenders(read(`components/investment-intelligence/${f}`))).toEqual([]);
    });
  }

  it('NEGATIVE CONTROL: the scan does flag the exact defects the PO reported', () => {
    const old = "<p>Statement period: {summary.document.statement_period_start ?? '?'} to {summary.document.statement_period_end ?? '?'}</p>";
    expect(findRawDateRenders(old).length).toBe(2);
    expect(findRawDateRenders('<p className="x">{h.asOfDateIso}</p>').length).toBe(1);
    expect(findRawDateRenders('<td>{t.dateIso}</td>').length).toBe(1);
    expect(findRawDateRenders('<li>Period: {a.periodStart} to {a.periodEnd}.</li>').length).toBe(2);
    // and does not flag the fixed forms
    expect(findRawDateRenders("<p>{fmtDate(h.asOfDateIso, 'INR')}</p>")).toEqual([]);
    expect(findRawDateRenders('<p>{date(pub.latestAsOf)}</p>')).toEqual([]);
  });
});

describe('(A)/(B) the list wiring', () => {
  it('the publication pill comes from the shared, unit-tested function, not an inline subtraction', () => {
    expect(client).toContain('statementPublicationPill(doc)');
    expect(client).not.toMatch(/totalHoldingsCount \?\? 0\) - \(doc\.publishedHoldingsCount/);
  });

  it('an archived row draws no issue / attention / publication pill', () => {
    const row = client.slice(client.indexOf('function renderDocumentRow'), client.indexOf("{/* The password box is shown for 'parsed'"));
    expect(row).toMatch(/doc\.status !== 'archived' && !!doc\.openReconciliationCaseCount/);
    expect(row).toMatch(/doc\.status !== 'archived' && !doc\.openReconciliationCaseCount && !!doc\.positionsNeedingAttentionCount/);
    expect(row).toMatch(/doc\.status !== 'archived' &&\s*\(\(\) => \{/);
  });

  it('the list route reads publications per position and excludes archived statements from the "to do" counts', () => {
    const route = read('app/api/investment-intelligence/source-documents/route.ts');
    expect(route).toContain("select('id, canonical_position_id, account_id, instrument_id, status')");
    expect(route).toContain('archivedDocumentIds');
    expect(route).not.toMatch(/\.in\('canonical_position_id', holdingIds\)/);
  });
});
