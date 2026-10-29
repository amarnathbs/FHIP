/**
 * Bank statement review, 2026-10-29: the bulk "Choose a category" tools, the "Previous page / Next page" wording of the
 * statement-lines table, and the PO standing date rule (never yyyy-mm-dd or month-first on a screen: Australia dd/mm/yyyy,
 * India dd-mm-yyyy).
 *
 *   UI-1  date display: the shared formatter through the null-safe adapter, both styles, no ISO anywhere
 *   UI-2  DATE-SCAN: no bank import / review / statement-details component renders a raw date field (with negative controls)
 *   UI-3  paging: the buttons say "Page", the status line says which lines are shown (with negative controls)
 *   UI-4  bulk selection logic: pages, "like this", suggested coverage, the confirmation states count and category
 *   UI-5  the review component wires the bulk tools to the ONE batch route and never to an approval
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { displayDate, displayPeriod, dateStyleForCurrency } from '@/lib/engines/statementDisplayDate';
import { linesPageSummary } from '@/lib/financial-data-hub/domain/reviewDisplay';
import {
  BULK_CARDS_PER_PAGE,
  BULK_MAX_SELECTION,
  bulkResultText,
  cardPageCount,
  cardPageSummary,
  confirmCategoryText,
  confirmSuggestedText,
  idsLikeThis,
  itemsOnPage,
  likeKey,
  suggestedPlan,
  usableSelection,
  type SelectableItem,
} from '@/lib/financial-data-hub/domain/bulkSelection';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const REVIEW = 'app/(app)/financial-data-hub/review/StatementCategoryReview.tsx';
const DRAWER = 'components/financial-data-hub/StatementDetailsDrawer.tsx';
/** Every component of the bank import / review / statement-details flow that can show a date. */
const DATE_SCANNED = [
  REVIEW,
  DRAWER,
  'app/(app)/financial-data-hub/review/ReviewWorkspace.tsx',
  'app/(app)/financial-data-hub/review/SplitTransactionEditor.tsx',
  'app/(app)/financial-data-hub/activity/transactions/page.tsx',
  'components/financial-data-hub/WaitingImports.tsx',
  'components/expenses/BankStatementImportPanel.tsx',
  'components/expenses/BankCsvMappingStep.tsx',
  'components/expenses/ImportedExpenseActuals.tsx',
];

describe('UI-1 dates are shown day-first in the account style', () => {
  it('Australian accounts dd/mm/yyyy, India dd-mm-yyyy, a timestamp keeps its date part, empty gives the fallback', () => {
    expect(displayDate('2025-08-20', 'AUD')).toBe('20/08/2025');
    expect(displayDate('2026-02-12', 'AUD')).toBe('12/02/2026');
    expect(displayDate('2026-02-12', 'INR')).toBe('12-02-2026');
    expect(displayDate('2026-02-12T23:30:00.000Z', 'AUD')).toBe('12/02/2026');
    expect(displayDate(null, 'AUD', '—')).toBe('—');
    expect(displayDate(undefined, 'AUD')).toBe('');
    expect(displayDate('2026-02-12', null)).toBe('12/02/2026');
    expect(dateStyleForCurrency('USD')).toBe('AUD');
  });

  it('a statement period reads "01/08/2026 to 31/08/2026" (India: with hyphens); none printed gives null', () => {
    expect(displayPeriod('2026-08-01', '2026-08-31', 'AUD')).toBe('01/08/2026 to 31/08/2026');
    expect(displayPeriod('2026-08-01', '2026-08-31', 'INR')).toBe('01-08-2026 to 31-08-2026');
    expect(displayPeriod('2026-08-01', null, 'AUD')).toBe('01/08/2026');
    expect(displayPeriod(null, null, 'AUD')).toBeNull();
  });

  it('no output is ever year-first', () => {
    for (const cur of ['AUD', 'INR']) {
      for (const iso of ['2025-08-20', '2026-02-12', '2024-12-31']) {
        expect(displayDate(iso, cur)).not.toMatch(/^\d{4}[-/]/);
        expect(displayDate(iso, cur)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      }
    }
  });
});

// ---- UI-2: the date scan -------------------------------------------------------------------------------------------------------
const DATE_FIELD = '(?:transaction_date|posting_date|value_date|period_start|period_end|statement_period_start|statement_period_end|transactionDate|postingDate|valueDate|periodStart|periodEnd)';
/** A date field rendered as text: `{x.transaction_date}`, `{x.posting_date ?? '—'}`, `${s.period_start}` in a template literal.
 * Not an attribute value (`value={periodStart}`) and not a React key (`key={`${row.transactionDate}-${i}`}`): neither is read by a person. */
const RAW_RENDER = new RegExp(String.raw`(?<!=)\{\s*[\w$.?\[\]]*\b${DATE_FIELD}\s*(?:\?\?[^}]*)?\}`, 'g');

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/^\s*\/\/.*$/gm, '');
}
export function rawDateRenders(file: string, source: string): string[] {
  return stripComments(source)
    .split('\n')
    .filter((line) => !/key=\{/.test(line))
    .flatMap((line) => [...line.matchAll(RAW_RENDER)].map((m) => `${file}: ${m[0]}`));
}

describe('UI-2 DATE-SCAN: no bank import / review / statement-details component renders a raw ISO date', () => {
  it('scans the real components and finds none', () => {
    for (const f of DATE_SCANNED) expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true);
    const found = DATE_SCANNED.flatMap((f) => rawDateRenders(f, read(f)));
    expect(found).toEqual([]);
  });

  it('the scan is not vacuous: it reads the date fields these screens really use, and they go through the formatter', () => {
    const review = read(REVIEW);
    const drawer = read(DRAWER);
    for (const used of ['displayDate(item.transaction_date', 'displayDate(line.transaction_date', 'displayPeriod(statement.period_start']) expect(review).toContain(used);
    for (const used of ['displayDate(row.transaction_date', 'displayDate(row.posting_date', 'displayDate(row.value_date', 'displayPeriod(d.statement.period_start']) expect(drawer).toContain(used);
  });

  it('DATESCAN-NC-1: putting back the review card\'s raw date (what the PO saw as 2025-08-20) is caught', () => {
    const mutated = read(REVIEW).replace('{displayDate(item.transaction_date, item.currency)}', '{item.transaction_date}');
    expect(mutated).not.toBe(read(REVIEW));
    expect(rawDateRenders(REVIEW, mutated)).toEqual([`${REVIEW}: {item.transaction_date}`]);
  });

  it('DATESCAN-NC-2: putting back the lines table\'s raw date (2026-02-12) and the raw period are caught', () => {
    const mutated = read(DRAWER)
      .replace("{displayDate(row.transaction_date, row.currency)}", '{row.transaction_date}')
      .replace("{displayDate(row.posting_date, row.currency, '—')}", "{row.posting_date ?? '—'}");
    const found = rawDateRenders(DRAWER, mutated);
    expect(found).toHaveLength(2);
    const period = read(DRAWER).replace(/`\$\{[^`]*`|displayPeriod\([^)]*\)/, '`${d.statement.period_start} to ${d.statement.period_end}`');
    expect(rawDateRenders(DRAWER, period).length).toBeGreaterThan(0);
  });

  it('DATESCAN-NC-3: a raw date inside a template-literal message is caught; a formatted one is not', () => {
    expect(rawDateRenders('x.tsx', 'const m = `Statement ${s.period_start} to ${s.period_end}`;')).toHaveLength(2);
    expect(rawDateRenders('x.tsx', 'const m = `Statement ${displayPeriod(s.period_start, s.period_end, c)}`;')).toEqual([]);
    expect(rawDateRenders('x.tsx', "<td>{row.value_date ?? '—'}</td>")).toHaveLength(1);
    expect(rawDateRenders('x.tsx', '// {row.value_date}\n<td>{displayDate(row.value_date, c)}</td>')).toEqual([]);
  });
});

// ---- UI-3: paging --------------------------------------------------------------------------------------------------------------
describe('UI-3 the lines table pages are called pages and say which lines they show', () => {
  it('"Page 2 of 4, lines 101 to 200 of 341" (the PO case), first page, last page, one page, none', () => {
    expect(linesPageSummary(2, 100, 341).text).toBe('Page 2 of 4, lines 101 to 200 of 341');
    expect(linesPageSummary(1, 100, 341).text).toBe('Page 1 of 4, lines 1 to 100 of 341');
    expect(linesPageSummary(4, 100, 341).text).toBe('Page 4 of 4, lines 301 to 341 of 341');
    expect(linesPageSummary(1, 100, 40).text).toBe('Page 1 of 1, lines 1 to 40 of 40');
    expect(linesPageSummary(1, 100, 0).text).toBe('No lines');
    expect(linesPageSummary(9, 100, 341).text).toBe('Page 4 of 4, lines 301 to 341 of 341');
    expect(linesPageSummary(2, 100, 341).pages).toBe(4);
  });

  const pagingSource = () => read(DRAWER);
  it('the drawer says Previous page / Next page, never "Previous lines" / "Next lines", in a labelled, keyboard-reachable nav', () => {
    const src = pagingSource();
    expect(src).toContain('>Previous page</button>');
    expect(src).toContain('>Next page</button>');
    expect(src).not.toMatch(/Previous lines|Next lines/);
    expect(src).toContain('<nav aria-label="Pages of statement lines"');
    expect(src).toContain('linesPageSummary(');
    // Real <button type="button"> elements (focusable, Enter/Space), not clickable spans.
    expect(src).toMatch(/<button type="button" disabled=\{shownPage <= 1 \|\| loading\} onClick=\{\(\) => goTo\(Math\.max\(1, shownPage - 1\)\)\}/);
    expect(src).toMatch(/<button type="button" disabled=\{shownPage >= pages \|\| loading\} onClick=\{\(\) => goTo\(shownPage \+ 1\)\}/);
  });

  it('PAGING-NC-1: the old wording is caught', () => {
    const old = pagingSource().replace('>Next page</button>', '>Next lines</button>');
    expect(old).not.toBe(pagingSource());
    expect(/Previous lines|Next lines/.test(old)).toBe(true);
  });

  it('PAGING-NC-2: the card list of the review page uses the same wording', () => {
    expect(read(REVIEW)).toContain('>Previous page</button>');
    expect(read(REVIEW)).toContain('>Next page</button>');
  });
});

// ---- UI-4: selection logic -----------------------------------------------------------------------------------------------------
const item = (id: string, description: string | null, extra: Partial<SelectableItem> = {}): SelectableItem => ({
  id, description, can_choose_category: true, suggested_category_id: null, ...extra,
});

describe('UI-4 bulk selection logic', () => {
  const many = Array.from({ length: 271 }, (_, i) => item(`id-${i}`, `Payee ${i % 40} 123`));

  it('pages the 271 cards by 50 and says which are shown', () => {
    expect(BULK_CARDS_PER_PAGE).toBe(50);
    expect(cardPageCount(271)).toBe(6);
    expect(itemsOnPage(many, 1)).toHaveLength(50);
    expect(itemsOnPage(many, 6)).toHaveLength(21);
    expect(itemsOnPage(many, 99)).toHaveLength(21);
    expect(itemsOnPage(many, 0)).toHaveLength(50);
    expect(cardPageSummary(2, 271)).toBe('Page 2 of 6, transactions 51 to 100 of 271');
    expect(cardPageSummary(1, 0)).toBe('No transactions');
  });

  it('"like this" means the same payee words, ignoring case and spacing, and only items that can be chosen here', () => {
    const items = [
      item('a', 'Woolworths Metro 4412'),
      item('b', 'WOOLWORTHS  METRO 9921'),
      item('c', 'Coles Express 12'),
      item('d', 'Woolworths Metro 11', { can_choose_category: false }),
    ];
    expect(likeKey('Woolworths Metro 4412')).toBe(likeKey('WOOLWORTHS  METRO 9921'));
    expect(idsLikeThis(items, items[0]).sort()).toEqual(['a', 'b']);
    expect(idsLikeThis(items, items[2])).toEqual(['c']);
    expect(idsLikeThis([item('z', '12 34')], item('z', '12 34'))).toEqual(['z']);
    expect(idsLikeThis([item('n', null)], item('n', null))).toEqual(['n']);
  });

  it('a selection keeps only lines still listed and choosable (approved or categorised meanwhile drop out)', () => {
    const items = [item('a', 'A'), item('b', 'B', { can_choose_category: false }), item('c', 'C')];
    expect(usableSelection(items, new Set(['a', 'b', 'gone'])).map((i) => i.id)).toEqual(['a']);
  });

  it('the suggested-category convenience covers only lines that have one and counts per category', () => {
    const sel = [item('a', 'A', { suggested_category_id: 'cat-t' }), item('b', 'B', { suggested_category_id: 'cat-t' }), item('c', 'C', { suggested_category_id: 'cat-h' }), item('d', 'D')];
    const plan = suggestedPlan(sel);
    expect(plan).toEqual({ covered: 3, notCovered: 1, perCategory: [{ category_id: 'cat-t', count: 2 }, { category_id: 'cat-h', count: 1 }] });
  });

  it('the confirmation states the count and the category, says nothing is approved, and mentions remember only when ticked', () => {
    const t = confirmCategoryText(12, 'Housing', false);
    expect(t).toContain('"Housing"');
    expect(t).toContain('12 transactions');
    expect(t).toContain('Nothing is approved');
    expect(t).not.toContain('remembered');
    expect(confirmCategoryText(1, 'Housing', true)).toContain('1 transaction?');
    expect(confirmCategoryText(1, 'Housing', true)).toContain('remembered for next time');
    const plan = suggestedPlan([item('a', 'A', { suggested_category_id: 'cat-t' }), item('b', 'B', { suggested_category_id: 'cat-t' }), item('d', 'D')]);
    const s = confirmSuggestedText(plan, 3, (id) => (id === 'cat-t' ? 'Own-Account Transfer' : id), false);
    expect(s).toContain('2 of the 3 selected');
    expect(s).toContain('Own-Account Transfer: 2');
    expect(s).toContain('The other 1 transaction has no suggestion and stays as it is.');
    expect(s).toContain('Nothing is approved');
  });

  it('the result sentence reports every outcome and always says nothing was approved', () => {
    const base = { requested: 5, applied: 3, unchanged: 1, failed: [{ transaction_id: 'x', description: 'X', message: 'm' }], payees_remembered: 2, payees_not_remembered: [] };
    const text = bulkResultText(base);
    expect(text).toContain('Category set on 3 transactions.');
    expect(text).toContain('1 transaction already had this choice and was left as it was.');
    expect(text).toContain('1 transaction could not be set (listed below).');
    expect(text).toContain('We will remember 2 payees next time.');
    expect(text.endsWith('Nothing was approved.')).toBe(true);
    expect(bulkResultText({ requested: 0, applied: 0, unchanged: 0, failed: [], payees_remembered: 0, payees_not_remembered: [] })).toContain('Nothing was changed.');
  });

  it('the cap is the server cap', () => {
    expect(BULK_MAX_SELECTION).toBe(500);
  });
});

// ---- UI-5: wiring --------------------------------------------------------------------------------------------------------------
describe('UI-5 the review component uses the one batch route and never approves from the bulk tools', () => {
  const src = () => read(REVIEW).replace(/\r\n/g, '\n');
  const bulkFn = () => {
    const s = src();
    const start = s.indexOf('function applyBulk(');
    const end = s.indexOf('\n  }\n', start);
    return s.slice(start, end);
  };

  it('offers select-all-on-page, select-all, select-all-like-this, one category, remember, a confirmation and the suggested convenience', () => {
    const s = src();
    for (const text of [
      'Choose a category for many at once',
      'Select all on this page (',
      'that need a category',
      'Select all {alike.length} like this',
      'Category for all selected',
      'Remember each payee next time',
      'Apply category to ',
      'Apply the suggested category to the ',
      'Clear selection',
      'Confirm the category',
      'confirmCategoryText(',
      'confirmSuggestedText(',
    ]) expect(s, text).toContain(text);
    expect(s).toContain('type="checkbox"');
  });

  it('applies the whole selection with ONE call to the batch route, in category or suggested mode', () => {
    const fn = bulkFn();
    expect(fn).toContain('`${url}/set-categories`');
    expect((fn.match(/apiPost</g) ?? []).length).toBe(1);
    expect(fn).toContain('transaction_ids: chosen.map');
    expect(fn).toContain('mode: kind');
    expect(fn).not.toMatch(/for \(|\.forEach\(|\.map\(\(i\) => apiPost/);
  });

  it('never approves: the bulk handler does not mention approval at all, and the existing approvals are untouched', () => {
    expect(bulkFn()).not.toMatch(/approve/i);
    const s = src();
    expect(s).toContain('`${url}/approve-group`');
    expect(s).toContain('`${url}/approve-all`');
    expect(s).toContain('set-category`');
    expect(s).toContain('Save category<span className="sr-only">');
  });

  it('keeps suggested categories visible on the cards and keeps the per-card Save', () => {
    const s = src();
    expect(s).toContain("{suggested ? ` (suggested: ${suggested})` : ''}");
    expect(s).toContain('Remember this payee next time');
    expect(s).toContain('onClick={() => saveCategory(item)}');
  });

  it('BULKUI-NC-1: a bulk handler that approved would be caught by the wiring test', () => {
    const mutated = bulkFn().replace('`${url}/set-categories`', '`${url}/approve-all`');
    expect(mutated.includes('set-categories')).toBe(false);
    const bad = bulkFn() + '\n  approveAll();';
    expect(/approve/i.test(bad)).toBe(true);
  });
});
