// Bank-statement AI reading -- printed money shapes (28-10-2026, production defect). SYNTHETIC text only.
//
// Production: a real 10-page NAB statement read by AI in 43 parts; 16 provider outcomes were `schema_rejected`, every issue
// `invalid_string` on transactions.N.balanceAfter / declaredClosingBalance.value / declaredOpeningBalance.value (sometimes
// transactions.N.amount): the model copied the statement's own printed shape ("1,234.56 CR") and the strict decimal pattern threw
// away the whole billed part. Written to FAIL on origin/main (6c60e0d + a63ca14): the old adapter rejects every shape below.
//
// Layers proved here (UNIT-TESTED; the provider is a fake, the shared gateway, wire schema, normaliser, strict schema, mapper and the
// "figures must be printed" guard are the REAL code):
//   1. normalisePrintedMoney: every printed shape, the CR/DR sign rule, the refusals, and "never invents a digit".
//   2. the real shared gateway with a fake provider: shapes accepted, a garbage amount still rejected, a garbage balance nulled
//      and counted, direction conflict refused.
//   3. mapping + printed-figures guard: normalised figures are still checked against the part's text.
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
vi.mock('@/lib/aie/cost/costAdmission', () => ({
  reserveConservativeAiCost: async () => ({ admitted: true, reservedUsd: 0.01 }),
  settleAiCost: async () => undefined,
}));

import { normalisePrintedMoney } from '@/lib/aie/adapters/shared/printedMoney';
import { normaliseBankStatementRawFacts, type BankFactsNormalisationNotes } from '@/lib/aie/adapters/bankStatement/normalise';
import { requestBankStatementAiExtraction } from '@/lib/aie/adapters/bankStatement/gateway';
import { mapBankStatementFactsToDraft, keepOnlyPrintedBankFigures } from '@/lib/aie/adapters/bankStatement/mapping';
import { BANK_STATEMENT_AI_EXTRACTION_SYSTEM_PROMPT } from '@/lib/aie/adapters/bankStatement/gateway';
import { AIE_DOCUMENT_FACTS_FORMAT_INSTRUCTIONS } from '@/lib/aie/adapters/shared/gateway';
import { explicitSignOfPrintedFigure } from '@/lib/aie/adapters/shared/reviewDraft';

const USER = '20000000-0000-4000-8000-0000000000aa';
const v = (value: string | null) => ({ value, missingReasonCode: value === null ? 'not_present_on_document' : null });

beforeEach(() => {
  process.env.AIE_AI_FALLBACK_ENABLED = 'true';
  h.state.prompts.length = 0;
});

function factsJson(over: { opening?: string | null; closing?: string | null; tx?: Array<Record<string, unknown>> }): string {
  return JSON.stringify({
    schemaVersion: '1',
    documentMissingReasonCode: null,
    institutionName: v('Synthetic Test Bank'),
    maskedAccountIdentifier: v(null),
    statementPeriodStart: v('2026-09-01'),
    statementPeriodEnd: v('2026-09-30'),
    declaredOpeningBalance: v(over.opening === undefined ? '1000.00' : over.opening),
    declaredClosingBalance: v(over.closing === undefined ? '1100.00' : over.closing),
    allTransactionsListed: true,
    transactions: over.tx ?? [{ transactionDate: '2026-09-02', descriptionRaw: 'SALARY', amount: '100.00', creditDebit: 'credit', balanceAfter: '1100.00' }],
  });
}
const tx = (balanceAfter: string | null, amount = '100.00', creditDebit = 'credit', n = 2) => ({ transactionDate: `2026-09-${String(n).padStart(2, '0')}`, descriptionRaw: `ITEM ${n}`, amount, creditDebit, balanceAfter });

describe('normalisePrintedMoney: balance shapes', () => {
  const cases: Array<[string, string]> = [
    ['1,234.56 CR', '1234.56'],
    ['1,234.56CR', '1234.56'],
    ['1,234.56 Cr', '1234.56'],
    ['1,234.56 cr.', '1234.56'],
    ['CR 1,234.56', '1234.56'],
    ['1,234.56 DR', '-1234.56'],
    ['1,234.56DR', '-1234.56'],
    ['DR $1,234.56', '-1234.56'],
    ['$1,234.56', '1234.56'],
    ['A$1,234.56', '1234.56'],
    ['AUD 1,234.56', '1234.56'],
    ['$1,234.56 AUD', '1234.56'],
    ['-$1,234.56', '-1234.56'],
    ['$-1,234.56', '-1234.56'],
    ['- $ 1,234.56', '-1234.56'],
    ['−$1,234.56', '-1234.56'],
    ['(1,234.56)', '-1234.56'],
    ['($1,234.56)', '-1234.56'],
    ['1,234.56-', '-1234.56'],
    ['  1234.56  ', '1234.56'],
    ['1234.5', '1234.5'],
    ['1234', '1234'],
    ['1 234.56', '1234.56'],
    ['12,345,678.90', '12345678.90'],
    ['Rs. 1,23,456.78', '123456.78'],
    ['₹1,23,456.78 CR', '123456.78'],
    ['0.00 DR', '0.00'],
    ['0.00 CR', '0.00'],
    ['+1,234.56', '1234.56'],
    ['-1234.56', '-1234.56'],
  ];
  for (const [printed, expected] of cases) {
    it(`"${printed}" -> "${expected}"`, () => {
      const r = normalisePrintedMoney(printed, 'balance');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(expected);
    });
  }

  it('already-clean values are returned unchanged (fast path, idempotent)', () => {
    for (const clean of ['0', '12.5', '-3200.00', '123456789012345.99']) {
      const r = normalisePrintedMoney(clean, 'balance');
      expect(r).toMatchObject({ ok: true, value: clean, changed: false });
      const again = normalisePrintedMoney((r as { value: string }).value, 'balance');
      expect(again).toMatchObject({ ok: true, value: clean });
    }
  });

  it('CR is positive and DR is negative for a running balance (the documented sign rule)', () => {
    expect(normalisePrintedMoney('50.00 CR', 'balance')).toMatchObject({ ok: true, value: '50.00', marker: 'CR' });
    expect(normalisePrintedMoney('50.00 DR', 'balance')).toMatchObject({ ok: true, value: '-50.00', marker: 'DR' });
    expect(normalisePrintedMoney('50.00', 'balance')).toMatchObject({ ok: true, value: '50.00', marker: null });
  });

  it('never guesses a sign: conflicting marks are refused', () => {
    for (const bad of ['-1,234.56 DR', '(1,234.56) DR', '(1,234.56)-', '--5.00', '-5.00-', '-50.00 CR', '(50.00) CR', '+50.00 DR', '50.00 CR DR']) {
      expect(normalisePrintedMoney(bad, 'balance').ok, bad).toBe(false);
    }
  });

  it('refuses what is not a clean decimal afterwards', () => {
    for (const bad of ['', '   ', 'n/a', 'abc', '1,234.567', '12,34.56', '1.234,56', '1,23.45', '1234.', '.56', '12 34 56', '1,234.56 and 2,000.00', '1,234.56 balance', '9'.repeat(16), '1e6', 'NaN', '$']) {
      expect(normalisePrintedMoney(bad, 'balance').ok, bad).toBe(false);
    }
  });

  it('never invents or rounds a digit: the digits of the result are the digits of the input, in order', () => {
    const inputs = ['1,234.56 CR', '$-12,345.60', '(0.05)', 'Rs. 9,87,654.32 DR', '7.5 CR', '100', 'AUD 3,200.00-'];
    for (const input of inputs) {
      const r = normalisePrintedMoney(input, 'balance');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.replace(/\D/g, '')).toBe(input.replace(/\D/g, ''));
    }
  });
});

describe('normalisePrintedMoney: amount shapes (positive magnitude, direction separate)', () => {
  it('currency symbols and thousands separators are stripped', () => {
    expect(normalisePrintedMoney('$1,045.00', 'amount', 'debit')).toMatchObject({ ok: true, value: '1045.00' });
    expect(normalisePrintedMoney('1,045.00 AUD', 'amount', 'credit')).toMatchObject({ ok: true, value: '1045.00' });
  });
  it('a CR / DR marker is a direction hint, never a sign: agreeing marks give the magnitude', () => {
    expect(normalisePrintedMoney('45.00 DR', 'amount', 'debit')).toMatchObject({ ok: true, value: '45.00' });
    expect(normalisePrintedMoney('45.00 CR', 'amount', 'credit')).toMatchObject({ ok: true, value: '45.00' });
  });
  it('a CR / DR marker that contradicts the row direction is refused (never a silent wrong direction)', () => {
    expect(normalisePrintedMoney('45.00 DR', 'amount', 'credit')).toMatchObject({ ok: false, reason: 'direction_conflict' });
    expect(normalisePrintedMoney('45.00 CR', 'amount', 'debit')).toMatchObject({ ok: false, reason: 'direction_conflict' });
  });
  it('parentheses and a trailing minus keep the existing sign convention (a leading minus, which the mapper turns into the magnitude with a warning)', () => {
    expect(normalisePrintedMoney('(45.00)', 'amount', 'debit')).toMatchObject({ ok: true, value: '-45.00' });
    expect(normalisePrintedMoney('45.00-', 'amount', 'debit')).toMatchObject({ ok: true, value: '-45.00' });
  });
  it('genuine garbage is refused', () => {
    for (const bad of ['forty five', '45.00.00', '4 5.00 0', '45,00', '']) expect(normalisePrintedMoney(bad, 'amount', 'debit').ok, bad).toBe(false);
  });
});

type Normalised = {
  declaredOpeningBalance: { value: string | null };
  declaredClosingBalance: { value: string | null; missingReasonCode: string | null };
  transactions: Array<{ balanceAfter: string | null; amount: string }>;
};

describe('normaliseBankStatementRawFacts', () => {
  it('re-spells balances and amounts, nulls (and counts) an unreadable balance, leaves an unreadable amount alone', () => {
    const raw = JSON.parse(factsJson({
      opening: '$1,000.00 CR',
      closing: 'n/a-ish',
      tx: [tx('1,100.00 CR'), tx('garbage balance', '$50.00', 'debit', 3), tx('', 'forty five', 'debit', 4), tx('250.00 DR', '10.00', 'debit', 5)],
    }));
    const { data, notes } = normaliseBankStatementRawFacts(raw) as unknown as { data: Normalised; notes: BankFactsNormalisationNotes };
    expect(data.declaredOpeningBalance.value).toBe('1000.00');
    expect(data.declaredClosingBalance).toEqual({ value: null, missingReasonCode: 'illegible' });
    expect(data.transactions.map((t: { balanceAfter: string | null; amount: string }) => t.balanceAfter)).toEqual(['1100.00', null, null, '-250.00']);
    expect(data.transactions.map((t: { balanceAfter: string | null; amount: string }) => t.amount)).toEqual(['100.00', '50.00', 'forty five', '10.00']);
    expect(notes).toMatchObject({ balanceLinesNotRead: [2], declaredOpeningNotRead: false, declaredClosingNotRead: true });
  });
  it('a placeholder ("-", "N/A", empty) means "not printed", not "could not read"', () => {
    const raw = JSON.parse(factsJson({ closing: 'N/A', tx: [tx('-'), tx(''), tx('n/a', '5.00', 'debit', 3)] }));
    const { data, notes } = normaliseBankStatementRawFacts(raw) as unknown as { data: Normalised; notes: BankFactsNormalisationNotes };
    expect(data.transactions.map((t: { balanceAfter: string | null; amount: string }) => t.balanceAfter)).toEqual([null, null, null]);
    expect(notes.balanceLinesNotRead).toEqual([]);
    expect(data.declaredClosingBalance).toEqual({ value: null, missingReasonCode: 'not_present_on_document' });
  });
  it('does not mutate its input and tolerates a non-object', () => {
    const raw = JSON.parse(factsJson({ tx: [tx('1,100.00 CR')] }));
    const before = JSON.stringify(raw);
    normaliseBankStatementRawFacts(raw);
    expect(JSON.stringify(raw)).toBe(before);
    expect(normaliseBankStatementRawFacts(null).data).toBeNull();
    expect(normaliseBankStatementRawFacts('x').data).toBe('x');
  });
});

describe('real shared gateway, fake provider: the production failure shapes', () => {
  it('a part where EVERY row balance is "1,234.56 CR" is accepted (it was schema_rejected on every row before)', async () => {
    const rows = Array.from({ length: 18 }, (_, i) => tx(`${(1000 + i * 10).toLocaleString('en-US')}.00 CR`, '10.00', 'credit', (i % 27) + 1));
    h.state.reply = () => factsJson({ opening: '990.00', closing: '1,170.00 CR', tx: rows });
    const out = await requestBankStatementAiExtraction({ maskedText: 'synthetic', requestId: 'doc:part1', userId: USER });
    expect(out.outcome).toBe('success');
    if (out.outcome !== 'success') return;
    expect(out.facts.transactions).toHaveLength(18);
    expect(out.facts.transactions[0].balanceAfter).toBe('1000.00');
    expect(out.facts.transactions[17].balanceAfter).toBe('1170.00');
    expect(out.facts.declaredClosingBalance.value).toBe('1170.00');
    expect(out.notes?.balanceLinesNotRead).toEqual([]);
  });

  it('declared opening / closing balances with "$" and commas, and a DR closing, are accepted', async () => {
    h.state.reply = () => factsJson({ opening: '$12,345.67', closing: '$2,345.67 DR' });
    const out = await requestBankStatementAiExtraction({ maskedText: 'synthetic', requestId: 'doc:part2', userId: USER });
    expect(out.outcome).toBe('success');
    if (out.outcome !== 'success') return;
    expect(out.facts.declaredOpeningBalance.value).toBe('12345.67');
    expect(out.facts.declaredClosingBalance.value).toBe('-2345.67');
  });

  it('an amount printed "$1,045.00" is accepted as 1045.00', async () => {
    h.state.reply = () => factsJson({ tx: [tx('2,000.00 CR', '$1,045.00')] });
    const out = await requestBankStatementAiExtraction({ maskedText: 'synthetic', requestId: 'doc:part3', userId: USER });
    expect(out.outcome).toBe('success');
    if (out.outcome === 'success') expect(out.facts.transactions[0].amount).toBe('1045.00');
  });

  it('a part with one genuinely garbage AMOUNT is still rejected (never a silent wrong amount), with the path recorded and no value', async () => {
    h.state.reply = () => factsJson({ tx: [tx('1,100.00 CR'), tx('1,150.00 CR', 'fifty dollars', 'credit', 3)] });
    const out = await requestBankStatementAiExtraction({ maskedText: 'synthetic', requestId: 'doc:part4', userId: USER });
    expect(out.outcome).toBe('schema_rejected');
    expect(out.evidence?.schemaErrorCodes).toEqual(['transactions.1.amount:invalid_string']);
    expect(JSON.stringify(out)).not.toContain('fifty');
  });

  it('an amount with a CR/DR marker that contradicts the row direction is rejected', async () => {
    h.state.reply = () => factsJson({ tx: [tx('1,100.00 CR', '100.00 DR', 'credit')] });
    const out = await requestBankStatementAiExtraction({ maskedText: 'synthetic', requestId: 'doc:part5', userId: USER });
    expect(out.outcome).toBe('schema_rejected');
    expect(out.evidence?.schemaErrorCodes).toEqual(['transactions.0.amount:invalid_string']);
  });

  it('an unreadable BALANCE no longer discards the part: the line is kept with a null balance and counted', async () => {
    h.state.reply = () => factsJson({ tx: [tx('1,100.00 CR'), tx('see page 2', '50.00', 'debit', 3), tx('1,050.00 CR', '0.00', 'credit', 4)] });
    const out = await requestBankStatementAiExtraction({ maskedText: 'synthetic', requestId: 'doc:part6', userId: USER });
    expect(out.outcome).toBe('success');
    if (out.outcome !== 'success') return;
    expect(out.facts.transactions).toHaveLength(3);
    expect(out.facts.transactions[1].balanceAfter).toBeNull();
    expect(out.notes?.balanceLinesNotRead).toEqual([2]);
  });

  it('structure and dates stay strict: a bad date is still schema_rejected by the wire schema', async () => {
    h.state.reply = () => factsJson({ tx: [{ ...tx('1,100.00 CR'), transactionDate: '02/09/2026' }] });
    const out = await requestBankStatementAiExtraction({ maskedText: 'synthetic', requestId: 'doc:part7', userId: USER });
    expect(out.outcome).toBe('schema_rejected');
    expect(out.evidence?.schemaErrorCodes?.[0]).toBe('transactions.0.transactionDate:invalid_string');
  });

  it('an unknown key is still rejected', async () => {
    h.state.reply = () => JSON.stringify({ ...JSON.parse(factsJson({})), surprise: 1 });
    const out = await requestBankStatementAiExtraction({ maskedText: 'synthetic', requestId: 'doc:part8', userId: USER });
    expect(out.outcome).toBe('schema_rejected');
  });
});

describe('mapping and the "figures must be printed" guard run AFTER normalisation', () => {
  const PART_TEXT = ['02/09/2026 SALARY 100.00 1,100.00 CR', '03/09/2026 RENT 50.00 1,050.00 CR', 'Closing balance 1,050.00 CR'].join('\n');

  it('a normalised balance that IS printed is kept; one that is NOT printed is dropped (normalisation cannot invent a number)', async () => {
    h.state.reply = () => factsJson({ opening: '1,000.00 CR', closing: '1,050.00 CR', tx: [tx('1,100.00 CR'), tx('9,999.99 CR', '50.00', 'debit', 3)] });
    const out = await requestBankStatementAiExtraction({ maskedText: PART_TEXT, requestId: 'doc:part9', userId: USER });
    expect(out.outcome).toBe('success');
    if (out.outcome !== 'success') return;
    const mapped = mapBankStatementFactsToDraft(out.facts, out.notes)!;
    const kept = keepOnlyPrintedBankFigures(mapped, PART_TEXT);
    expect(kept.rows.map((r) => r.balanceAfter)).toEqual([1100, null]);
    expect(kept.warnings).toContain('ai_row_2_balance_not_printed_dropped');
    // 1,000.00 (declared opening) is not printed in this part's text -> dropped; 1,050.00 is printed -> kept.
    expect(kept.statementMetadata.declaredOpeningBalance).toBeNull();
    expect(kept.statementMetadata.declaredClosingBalance).toBe(1050);
  });

  it('a DR balance keeps its sign through the printed check (the check compares the magnitude)', async () => {
    const text = '05/09/2026 CARD 200.00 150.00 DR';
    h.state.reply = () => factsJson({ opening: null, closing: null, tx: [tx('150.00 DR', '200.00', 'debit', 5)] });
    const out = await requestBankStatementAiExtraction({ maskedText: text, requestId: 'doc:part10', userId: USER });
    expect(out.outcome).toBe('success');
    if (out.outcome !== 'success') return;
    const kept = keepOnlyPrintedBankFigures(mapBankStatementFactsToDraft(out.facts, out.notes)!, text);
    expect(kept.rows[0].balanceAfter).toBe(-150);
  });

  it('unread balances are counted on the draft (kept lines only) and add one warning per reading, not one per line', async () => {
    h.state.reply = () => factsJson({ opening: 'see summary', closing: '1,050.00 CR', tx: [tx('x1'), tx('x2', '50.00', 'debit', 3), { ...tx('x3', '5.00', 'debit', 4), descriptionRaw: 'Balance b/f' }] });
    const out = await requestBankStatementAiExtraction({ maskedText: PART_TEXT, requestId: 'doc:part11', userId: USER });
    expect(out.outcome).toBe('success');
    if (out.outcome !== 'success') return;
    const mapped = mapBankStatementFactsToDraft(out.facts, out.notes)!;
    // the summary line ("Balance b/f") is dropped, so its unreadable balance is not counted
    expect(mapped.rows).toHaveLength(2);
    expect(mapped.balancesNotRead).toBe(2);
    expect(mapped.declaredBalancesNotRead).toBe(1);
    expect(mapped.warnings.filter((w) => w.startsWith('ai_balances_not_read'))).toEqual(['ai_balances_not_read:2']);
    expect(mapped.warnings).toContain('ai_opening_balance_not_read');
  });
});

describe('the prompt: amounts plain, balances copied as printed (the deterministic step owns the sign)', () => {
  it('bank prompt: balances are copied EXACTLY as printed with their CR / DR mark; amounts stay plain positive decimals; direction in creditDebit', () => {
    for (const phrase of [
      'copy it EXACTLY as the document prints it',
      '"$1,234.56 CR", "$34.15 DR", "(34.15)"',
      'The mark carries the sign of a balance, so never drop it',
      'Every money value that is NOT a balance must be a plain decimal string',
      'Report every amount as a POSITIVE magnitude',
      'use the separate type/direction field',
    ]) {
      expect(BANK_STATEMENT_AI_EXTRACTION_SYSTEM_PROMPT, phrase).toContain(phrase);
    }
    // the bank prompt does not ask the model to CONVERT a balance (measured live: it dropped the DR on every overdrawn line)
    expect(BANK_STATEMENT_AI_EXTRACTION_SYSTEM_PROMPT).not.toContain('Every money value must be a plain decimal string');
  });
  it('the SHARED format instructions (every other adapter) are unchanged in meaning and say never to copy CR / DR / brackets / trailing minus', () => {
    expect(AIE_DOCUMENT_FACTS_FORMAT_INSTRUCTIONS).toContain('Every money value must be a plain decimal string');
    expect(AIE_DOCUMENT_FACTS_FORMAT_INSTRUCTIONS).toContain('never copy a CR or DR suffix, parentheses, or a trailing minus');
    expect(AIE_DOCUMENT_FACTS_FORMAT_INSTRUCTIONS).toContain('Report every amount as a POSITIVE magnitude');
  });
});

describe('sign evidence in the document (a model that drops a DR mark is not trusted)', () => {
  it('explicitSignOfPrintedFigure: DR / brackets / minus are negative, CR is positive, silence and mixed evidence are unknown', () => {
    expect(explicitSignOfPrintedFigure(34.15, '10 Sep Fuel   71.20  $34.15 DR')).toBe('negative');
    expect(explicitSignOfPrintedFigure(34.15, '10 Sep Fuel   71.20  DR $34.15')).toBe('negative');
    expect(explicitSignOfPrintedFigure(34.15, 'balance (34.15)')).toBe('negative');
    expect(explicitSignOfPrintedFigure(34.15, 'balance 34.15-')).toBe('negative');
    expect(explicitSignOfPrintedFigure(34.15, 'balance | -34.15 |')).toBe('negative');
    expect(explicitSignOfPrintedFigure(34.15, 'balance | -$34.15 |')).toBe('negative');
    expect(explicitSignOfPrintedFigure(34.15, 'balance $34.15 CR')).toBe('positive');
    expect(explicitSignOfPrintedFigure(34.15, 'balance 34.15')).toBe('unknown'); // silence draws no conclusion
    expect(explicitSignOfPrintedFigure(34.15, 'paid 34.15 then balance $34.15 DR')).toBe('unknown'); // one occurrence unmarked: mixed
    expect(explicitSignOfPrintedFigure(34.15, 'COFFEE - 34.15')).toBe('unknown'); // a spaced dash is a separator, not a sign
    expect(explicitSignOfPrintedFigure(99.99, 'balance $34.15 DR')).toBe('unknown'); // not printed
    expect(explicitSignOfPrintedFigure(34.15, 'balance $134.15 DR')).toBe('unknown'); // 34.15 is only part of a longer number
  });

  const TEXT = ['02/09/2026 FUEL 71.20 $34.15 DR', '03/09/2026 PAY 200.00 $165.85 CR', 'Closing balance $165.85 CR'].join('\n');
  const mk = (balances: Array<string | null>, opening: string | null = null, closing: string | null = null) =>
    JSON.parse(factsJson({
      opening, closing,
      tx: [tx(balances[0], '71.20', 'debit', 2), tx(balances[1], '200.00', 'credit', 3)],
    }));

  it('the model dropped the DR ("34.15"): the balance is NOT kept with a wrong sign, it is dropped and counted as not read', async () => {
    h.state.reply = () => JSON.stringify(mk(['34.15', '165.85 CR'], null, '165.85'));
    const out = await requestBankStatementAiExtraction({ maskedText: TEXT, requestId: 'doc:s1', userId: USER });
    expect(out.outcome).toBe('success');
    if (out.outcome !== 'success') return;
    const kept = keepOnlyPrintedBankFigures(mapBankStatementFactsToDraft(out.facts, out.notes)!, TEXT);
    expect(kept.rows.map((r) => r.balanceAfter)).toEqual([null, 165.85]);
    expect(kept.warnings).toContain('ai_row_1_balance_sign_contradicts_document_dropped');
    expect(kept.balancesNotRead).toBe(1);
  });

  it('copied as printed ("$34.15 DR"): the deterministic step gives the right sign, nothing is dropped', async () => {
    h.state.reply = () => JSON.stringify(mk(['$34.15 DR', '$165.85 CR'], null, '$165.85 CR'));
    const out = await requestBankStatementAiExtraction({ maskedText: TEXT, requestId: 'doc:s2', userId: USER });
    expect(out.outcome).toBe('success');
    if (out.outcome !== 'success') return;
    const kept = keepOnlyPrintedBankFigures(mapBankStatementFactsToDraft(out.facts, out.notes)!, TEXT);
    expect(kept.rows.map((r) => r.balanceAfter)).toEqual([-34.15, 165.85]);
    expect(kept.balancesNotRead).toBeUndefined();
    expect(kept.statementMetadata.declaredClosingBalance).toBe(165.85);
  });

  it('the model invented a minus on a figure the document prints as CR: dropped and counted, not flipped', async () => {
    h.state.reply = () => JSON.stringify(mk(['34.15 DR', '-165.85'], null, null));
    const out = await requestBankStatementAiExtraction({ maskedText: TEXT, requestId: 'doc:s3', userId: USER });
    if (out.outcome !== 'success') throw new Error('success expected');
    const kept = keepOnlyPrintedBankFigures(mapBankStatementFactsToDraft(out.facts, out.notes)!, TEXT);
    expect(kept.rows.map((r) => r.balanceAfter)).toEqual([-34.15, null]);
    expect(kept.balancesNotRead).toBe(1);
  });

  it('a declared closing balance whose sign the document contradicts is dropped and counted too', async () => {
    h.state.reply = () => JSON.stringify(mk(['$34.15 DR', '$165.85 CR'], null, '-165.85'));
    const out = await requestBankStatementAiExtraction({ maskedText: TEXT, requestId: 'doc:s4', userId: USER });
    if (out.outcome !== 'success') throw new Error('success expected');
    const kept = keepOnlyPrintedBankFigures(mapBankStatementFactsToDraft(out.facts, out.notes)!, TEXT);
    expect(kept.statementMetadata.declaredClosingBalance).toBeNull();
    expect(kept.declaredBalancesNotRead).toBe(1);
  });

  it('silence draws no conclusion: an unmarked figure keeps the sign the reading gave it', async () => {
    const plain = '02/09/2026 FUEL 71.20 -34.15\n03/09/2026 PAY 200.00 165.85';
    h.state.reply = () => JSON.stringify(mk(['-34.15', '165.85']));
    const out = await requestBankStatementAiExtraction({ maskedText: plain, requestId: 'doc:s5', userId: USER });
    if (out.outcome !== 'success') throw new Error('success expected');
    const kept = keepOnlyPrintedBankFigures(mapBankStatementFactsToDraft(out.facts, out.notes)!, plain);
    expect(kept.rows.map((r) => r.balanceAfter)).toEqual([-34.15, 165.85]);
  });
});
