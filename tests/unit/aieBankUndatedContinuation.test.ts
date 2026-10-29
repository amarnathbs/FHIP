// Bank statements that print a date ONLY on the first transaction of a day (28-10-2026, production: a NAB statement, 43 parts; the
// parts that start at the top of a page began with page headers, "Brought forward" and transaction lines with NO printed date, the
// model returned an empty date and the strict schema rejected the whole part, three times). SYNTHETIC layout with the same shape: no
// real statement text, name, reference or amount appears here.
//
// UNIT-TESTED: the deterministic "date in force" hint, the prompt, the repair note, the date normaliser and the safety net, through
// the real shared gateway with a fake provider.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const state = { reply: (() => '{}') as () => string, prompts: [] as string[] };
  const fakeProvider = {
    providerName: 'fake',
    generateStructured: async (req: { userPrompt: string }) => {
      state.prompts.push(req.userPrompt);
      return { rawText: state.reply(), inputTokens: 900, outputTokens: 300, latencyMs: 1, modelVersion: 'fake', finishReason: 'stop' as const, providerRequestIds: ['req_synthetic'] };
    },
    validateProviderHealth: async () => ({}) as never,
    estimateCost: () => ({}) as never,
  };
  return { state, fakeProvider };
});
vi.mock('@/lib/ai/access/premiumAiAccess', async (importOriginal) =>
  (await import('../support/premiumAiAccessMock')).premiumAiAccessModule(await importOriginal()));
vi.mock('@/lib/aie/provider/providerFactory', () => ({ createAieAiProvider: () => h.fakeProvider, createLazyAieAiProvider: () => h.fakeProvider }));
vi.mock('@/lib/aie/cost/costAdmission', () => ({ reserveConservativeAiCost: async () => ({ admitted: true, reservedUsd: 0.01 }), settleAiCost: async () => undefined }));

import { leadingPrintedDate } from '@/lib/aie/adapters/shared/printedDate';
import { dateHintsForParts, datesInForceAtStartOfParts, datePlausibilityWindow, partStartsWithUndatedTransactions, aiPartPrompt, aiRepairNote } from '@/lib/financial-data-hub/bankImport/aiChunking';
import { normaliseBankStatementRawFacts } from '@/lib/aie/adapters/bankStatement/normalise';
import { requestBankStatementAiExtraction } from '@/lib/aie/adapters/bankStatement/gateway';
import { mapBankStatementFactsToDraft, keepOnlyPrintedBankFigures } from '@/lib/aie/adapters/bankStatement/mapping';
import { statementNoteText, AI_DATES_CARRIED_TITLE_CODE, ACKNOWLEDGEABLE_STATEMENT_TITLE_CODES } from '@/lib/financial-data-hub/domain/categoryReview';

const USER = '20000000-0000-4000-8000-0000000000aa';
beforeEach(() => {
  process.env.AIE_AI_FALLBACK_ENABLED = 'true';
  h.state.prompts.length = 0;
});

// ---- a synthetic statement in the NAB-like shape: the date is printed on the first transaction of a day only ----
const PAGE1_END = [
  '3 Sep 2025 Synthetic Cafe Stop 4.50 995.50 CR',
  'Synthetic Utility Debit 10.00 985.50 CR',
  '3 Sep 2025 Carried forward 985.50 CR',
];
const PAGE2_TOP = [
  'Synthetic Bank Statement   Page 2 of 3',
  'Brought forward 985.50 CR',
  'Online 0001 Linked Acc Trns / Synthetic Payee 20.00 965.50 CR', // undated: belongs to 3 Sep 2025
  'Online 0002 Linked Acc Trns / Synthetic Payee 15.00 950.50 CR',
  '4 Sep 2025 Synthetic Pharmacy 12.00 938.50 CR',
  'EFTPOS 21/09 16:30 Synthetic Fuel Stop 55.00 883.50 CR', // undated; "21/09" is a value date, not the posting date
];
const OWN_DATE_TOP = [
  'Synthetic Bank Statement   Page 3 of 3',
  '5 Sep 2025 Synthetic Grocer 30.00 853.50 CR',
  'Synthetic Bakery 6.00 847.50 CR',
];

describe('leadingPrintedDate: only a FULL printed date, day-first, never a guess', () => {
  const ok: Array<[string, string]> = [
    ['3 Sep 2025 Coffee 4.50', '2025-09-03'],
    ['03 September 2025 Coffee', '2025-09-03'],
    ['  3 Sept 2025', '2025-09-03'],
    ['Sep 3, 2025 Coffee', '2025-09-03'],
    ['03/09/2025 Coffee', '2025-09-03'],
    ['3.9.2025 Coffee', '2025-09-03'],
    ['3-9-2025', '2025-09-03'],
    ['2025-09-03 Coffee', '2025-09-03'],
    ['31 Dec 2025 Interest', '2025-12-31'],
    ['1 Jan 2026 Fee', '2026-01-01'],
    ['29 Feb 2024 Leap', '2024-02-29'],
  ];
  for (const [text, iso] of ok) it(`"${text}" -> ${iso}`, () => expect(leadingPrintedDate(text)?.iso).toBe(iso));
  for (const bad of ['3 Sep Coffee 4.50', '21/09 16:30 EFTPOS', 'Online 0001 3 Sep 2025', '31 Feb 2025', '13/13/2025', '09/13/2025', 'Marketing 2025 spend', '3 Foo 2025', 'EFTPOS 21/09/2025', '']) {
    it(`"${bad}" is not a leading full date`, () => expect(leadingPrintedDate(bad)).toBeNull());
  }
});

describe('the date in force where each part starts', () => {
  const parts = [[...PAGE1_END].join('\n'), PAGE2_TOP.join('\n'), OWN_DATE_TOP.join('\n')];

  it('a part that starts at a page top with "Brought forward" and undated transactions gets the last dated line of the parts before it', () => {
    const hints = dateHintsForParts(parts);
    expect(hints[1]).toEqual({ iso: '2025-09-03', printed: '3 Sep 2025' });
    expect(partStartsWithUndatedTransactions(parts[1])).toBe(true);
  });
  it('the first part gets no hint', () => {
    expect(dateHintsForParts(parts)[0]).toBeNull();
    expect(dateHintsForParts([PAGE2_TOP.join('\n')])[0]).toBeNull();
  });
  it('a part that starts with its own dated transaction gets no hint (nothing to resolve)', () => {
    const hints = dateHintsForParts(parts);
    expect(hints[2]).toBeNull();
    expect(partStartsWithUndatedTransactions(parts[2])).toBe(false);
    // ... but the date in force is still known for the safety net
    expect(datesInForceAtStartOfParts(parts)[2]).toEqual({ iso: '2025-09-04', printed: '4 Sep 2025' });
  });
  it('"Brought forward" / "Carried forward" lines and headers alone are not undated transactions', () => {
    expect(partStartsWithUndatedTransactions('Page 4 of 10\nBrought forward 1,234.56 CR\n5 Sep 2025 Coffee 4.50 1,230.06 CR')).toBe(false);
    expect(partStartsWithUndatedTransactions('Page 4 of 10\nBrought forward 1,234.56 CR')).toBe(false);
  });
  it('the date carries across a part with no dated line at all, and nothing is invented when no earlier part printed a date', () => {
    const undated = 'Online 0003 Linked Acc Trns / Synthetic Payee 9.00 100.00 CR';
    const hints = dateHintsForParts([PAGE1_END.join('\n'), undated, undated]);
    expect(hints[1]?.iso).toBe('2025-09-03');
    expect(hints[2]?.iso).toBe('2025-09-03');
    expect(dateHintsForParts([undated, undated])).toEqual([null, null]);
  });
  it('year boundary: the last printed date of December is carried into January\'s undated lines, and a part that prints its own January date needs none', () => {
    const dec = '31 Dec 2025 Synthetic Interest 0.50 100.50 CR';
    const janUndated = 'Page 5 of 8\nBrought forward 100.50 CR\nOnline 0009 Linked Acc Trns / Synthetic Payee 3.00 97.50 CR';
    const janOwn = '2 Jan 2026 Synthetic Grocer 3.00 94.50 CR';
    const hints = dateHintsForParts([dec, janUndated, janOwn]);
    expect(hints[1]).toEqual({ iso: '2025-12-31', printed: '31 Dec 2025' });
    expect(hints[2]).toBeNull();
  });
  it('resume determinism: computed from the stored part texts alone, so the same on every call, after a restart, and whatever was already read', () => {
    const a = dateHintsForParts(parts);
    const b = dateHintsForParts(parts.map((t) => `${t}`));
    expect(b).toEqual(a);
    // the hint for part N never depends on the parts AFTER it, nor on which parts were already answered
    expect(dateHintsForParts(parts.slice(0, 2))[1]).toEqual(a[1]);
  });
});

describe('the prompt and the repair note', () => {
  const part = { seq: 1, pageFrom: 2, pageTo: 2, text: PAGE2_TOP.join('\n') };
  it('adds the date-in-force line only when a hint exists, above the statement text, naming the printed and ISO forms', () => {
    const none = aiPartPrompt(part, 3, null, null);
    expect(none).not.toContain('date in force');
    const hinted = aiPartPrompt(part, 3, null, { iso: '2025-09-03', printed: '3 Sep 2025' });
    expect(hinted).toContain('date in force where this part starts is 3 Sep 2025 (2025-09-03)');
    expect(hinted).toContain('that date as its transactionDate');
    expect(hinted).toContain('posting date, not a time-stamped value date');
    expect(hinted.indexOf('date in force')).toBeLessThan(hinted.indexOf('Brought forward'));
    expect(hinted.endsWith(part.text)).toBe(true);
  });
  it('a retry whose error codes name transactionDate also explains undated lines', () => {
    const note = aiRepairNote(['transactions.0.transactionDate:invalid_string', 'transactions.1.transactionDate:invalid_string', 'transactions.2.transactionDate:invalid_string', 'transactions.3.transactionDate:invalid_string'])!;
    expect(note).toContain('transactions[*].transactionDate (4 lines)');
    expect(note).toContain('prints no date of its own');
    expect(note).toContain('is never empty');
    expect(aiRepairNote(['transactions.0.amount:invalid_string'])).not.toContain('prints no date of its own');
  });
});

describe('a value date read out of a description is not a posting date', () => {
  it('the window is the range of leading dates the part prints plus the date in force; none when nothing is known', () => {
    const inForce = { iso: '2025-09-03', printed: '3 Sep 2025' };
    expect(datePlausibilityWindow(PAGE2_TOP.join('\n'), inForce)).toEqual({ from: '2025-09-03', to: '2025-09-04' });
    expect(datePlausibilityWindow(PAGE2_TOP.slice(2, 4).join('\n'), inForce)).toEqual({ from: '2025-09-03', to: '2025-09-03' });
    expect(datePlausibilityWindow(PAGE2_TOP.slice(2, 4).join('\n'), null)).toBeNull();
    expect(datePlausibilityWindow(['31 Dec 2025 A 1.00 1.00 CR', '2 Jan 2026 B 1.00 1.00 CR'].join('\n'), null)).toEqual({ from: '2025-12-31', to: '2026-01-02' });
  });

  const rows = (dates: Array<string | null>) => dates.map((d, i) => ({ transactionDate: d, descriptionRaw: 'SYNTHETIC', amount: '10.00', creditDebit: 'debit', balanceAfter: null, _i: i }));
  const norm = (dates: Array<string | null>, inForce: string | null, window: { from: string; to: string } | null) =>
    normaliseBankStatementRawFacts({ transactions: rows(dates) }, { dateInForceIso: inForce, dateWindow: window }) as unknown as { data: { transactions: Array<{ transactionDate: string }> }; notes: { datesCarriedForward: number[] } };

  it('a date outside the range the part prints (the live model dated an undated EFTPOS line 21 Sept from "EFTPOS 21/09 16:30") takes the date of the line above and is flagged', () => {
    const { data, notes } = norm(['2025-09-03', '2025-09-21', '2025-09-04', '2025-09-22'], '2025-09-03', { from: '2025-09-03', to: '2025-09-04' });
    expect(data.transactions.map((t) => t.transactionDate)).toEqual(['2025-09-03', '2025-09-03', '2025-09-04', '2025-09-04']);
    expect(notes.datesCarriedForward).toEqual([2, 4]);
  });
  it('dates inside the range are never touched, and with no window nothing is checked', () => {
    const inside = norm(['2025-09-03', '2025-09-04'], '2025-09-03', { from: '2025-09-03', to: '2025-09-04' });
    expect(inside.notes.datesCarriedForward).toEqual([]);
    const noWindow = norm(['2025-09-21'], '2025-09-03', null);
    expect(noWindow.data.transactions[0].transactionDate).toBe('2025-09-21');
  });
  it('an out-of-range date with nothing above it to take is left alone (never invented)', () => {
    const { data, notes } = norm(['2025-09-21'], null, { from: '2025-09-03', to: '2025-09-04' });
    expect(data.transactions[0].transactionDate).toBe('2025-09-21');
    expect(notes.datesCarriedForward).toEqual([]);
  });
});

describe('the date normaliser and the safety net', () => {
  const row = (transactionDate: unknown, amount = '10.00', balanceAfter: string | null = null) => ({ transactionDate, descriptionRaw: 'SYNTHETIC', amount, creditDebit: 'debit', balanceAfter });
  const doc = (tx: unknown[]) => ({ schemaVersion: '1', documentMissingReasonCode: null, transactions: tx });
  const run = (tx: unknown[], inForce: string | null = null) => normaliseBankStatementRawFacts(doc(tx), { dateInForceIso: inForce }) as unknown as { data: { transactions: Array<{ transactionDate: string | null; amount: string }> }; notes: { datesCarriedForward: number[]; respelled: number } };

  it('an empty / partial date takes the nearest earlier line\'s date, or the date in force for the first line, and is COUNTED', () => {
    const { data, notes } = run([row(''), row('2025-09-03'), row(null), row('21/09'), row('2025-09-04'), row('')], '2025-09-02');
    expect(data.transactions.map((t) => t.transactionDate)).toEqual(['2025-09-02', '2025-09-03', '2025-09-03', '2025-09-03', '2025-09-04', '2025-09-04']);
    expect(notes.datesCarriedForward).toEqual([1, 3, 4, 6]);
  });
  it('a FULL printed date is re-spelled, not carried (the printed digits are exact)', () => {
    const { data, notes } = run([row('3 Sep 2025'), row('04/09/2025')]);
    expect(data.transactions.map((t) => t.transactionDate)).toEqual(['2025-09-03', '2025-09-04']);
    expect(notes.datesCarriedForward).toEqual([]);
  });
  it('with no earlier line and no date in force NOTHING is invented: the date is left alone and the strict schema rejects it', () => {
    const { data, notes } = run([row(''), row('2025-09-03')]);
    expect(data.transactions[0].transactionDate).toBe('');
    expect(notes.datesCarriedForward).toEqual([]);
  });
  it('a bad AMOUNT is still rejected even when its date was carried (the safety net is for dates only)', async () => {
    h.state.reply = () => JSON.stringify({
      schemaVersion: '1', documentMissingReasonCode: null,
      institutionName: { value: null, missingReasonCode: 'not_present_on_document' }, maskedAccountIdentifier: { value: null, missingReasonCode: 'not_present_on_document' },
      statementPeriodStart: { value: null, missingReasonCode: 'not_present_on_document' }, statementPeriodEnd: { value: null, missingReasonCode: 'not_present_on_document' },
      declaredOpeningBalance: { value: null, missingReasonCode: 'not_present_on_document' }, declaredClosingBalance: { value: null, missingReasonCode: 'not_present_on_document' },
      allTransactionsListed: true, transactions: [row('', 'about twenty')],
    });
    const out = await requestBankStatementAiExtraction({ maskedText: 'synthetic', requestId: 'doc:d1', userId: USER, dateInForceIso: '2025-09-03' });
    expect(out.outcome).toBe('schema_rejected');
    expect(out.evidence?.schemaErrorCodes).toEqual(['transactions.0.amount:invalid_string']);
  });
});

describe('through the real gateway with a fake provider: the production failure, with and without the date in force', () => {
  const none = { value: null, missingReasonCode: 'not_present_on_document' };
  const answer = (dates: string[]) => JSON.stringify({
    schemaVersion: '1', documentMissingReasonCode: null, institutionName: none, maskedAccountIdentifier: none, statementPeriodStart: none, statementPeriodEnd: none,
    declaredOpeningBalance: none, declaredClosingBalance: none, allTransactionsListed: true,
    transactions: dates.map((d, i) => ({ transactionDate: d, descriptionRaw: `SYNTHETIC ${i + 1}`, amount: '10.00', creditDebit: 'debit', balanceAfter: null })),
  });
  const TEXT = PAGE2_TOP.slice(0, 4).join('\n');

  it('the model returns EMPTY dates for the four undated lines (as in production): with the date in force they take it, are counted and flagged; WITHOUT it the part is rejected the old way', async () => {
    h.state.reply = () => answer(['', '', '', '']);
    const without = await requestBankStatementAiExtraction({ maskedText: TEXT, requestId: 'doc:d2', userId: USER });
    expect(without.outcome).toBe('schema_rejected');
    expect(without.evidence?.schemaErrorCodes).toEqual([0, 1, 2, 3].map((i) => `transactions.${i}.transactionDate:invalid_string`));

    const withIt = await requestBankStatementAiExtraction({ maskedText: TEXT, requestId: 'doc:d3', userId: USER, dateInForceIso: '2025-09-03' });
    expect(withIt.outcome).toBe('success');
    if (withIt.outcome !== 'success') return;
    expect(withIt.facts.transactions.map((t) => t.transactionDate)).toEqual(Array(4).fill('2025-09-03'));
    const mapped = keepOnlyPrintedBankFigures(mapBankStatementFactsToDraft(withIt.facts, withIt.notes)!, TEXT);
    expect(mapped.datesCarriedForward).toBe(4);
    expect(mapped.warnings).toContain('ai_dates_taken_from_previous_line:4');
  });

  it('a model that follows the hint (valid ISO dates) needs no safety net: nothing counted, nothing flagged', async () => {
    h.state.reply = () => answer(['2025-09-03', '2025-09-03', '2025-09-04', '2025-09-04']);
    const out = await requestBankStatementAiExtraction({ maskedText: TEXT, requestId: 'doc:d4', userId: USER, dateInForceIso: '2025-09-03' });
    if (out.outcome !== 'success') throw new Error('success expected');
    const mapped = mapBankStatementFactsToDraft(out.facts, out.notes)!;
    expect(mapped.datesCarriedForward).toBeUndefined();
    expect(mapped.warnings.some((w) => w.startsWith('ai_dates_taken'))).toBe(false);
  });
});

describe('the statement note for carried-forward dates', () => {
  it('says in words what to check, and can be acknowledged after the person has checked', () => {
    const text = statementNoteText({ id: '1', severity: 'blocking', title_code: AI_DATES_CARRIED_TITLE_CODE, context_json: { lines_carried: 4 } });
    expect(text).toContain('4 transactions on this statement print no date of their own');
    expect(text).toContain('given the date of the line above it');
    expect(text).toContain('cannot be approved');
    expect(ACKNOWLEDGEABLE_STATEMENT_TITLE_CODES).toContain(AI_DATES_CARRIED_TITLE_CODE);
  });
});
