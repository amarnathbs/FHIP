/**
 * Bank-statement AI reading -- printed balance shapes, REAL OpenAI provider (gpt-4o-mini), 28-10-2026.
 *
 * OPT-IN ONLY. Skipped unless `AIE_BANK_PRINTED_BALANCE_LIVE_PROOF=1` (it spends a few cents of the DEV OpenAI project). It needs
 * `AIE_OPENAI_API_KEY` (never printed). It writes NOTHING: no database, no storage, no FDH service, no cost ledger (the same scope
 * as `aieUnifiedFallbackLiveProviderProof.live.test.ts`: its own gateway with no `costAdmission`).
 *
 * WHAT IT PROVES. The production defect was a real NAB statement whose balances print as "1,234.56 CR" / "DR": the model copied the
 * printed shape and the strict decimal pattern discarded every billed part. This sends the EXACT production per-part prompt
 * (`aiPartPrompt`), system prompt and strict JSON schema, for a SYNTHETIC NAB-like statement text of a few dozen lines whose balances
 * are printed as "$1,234.56 CR" / "$123.45 DR", then runs the answer through the same deterministic steps the adapter runs
 * (the wire schema inside the gateway, `normaliseBankStatementRawFacts`, the strict schema, the mapper, the printed-figures guard)
 * and compares every line with an oracle computed from the same data. It reports how many figures the model still copied in the
 * printed shape (those are re-spelled by the normaliser; before this fix each one rejected the whole part).
 *
 * EVERY VALUE IS SYNTHETIC. No real person, account or statement.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { OpenAiAieProvider } from '@/lib/aie/provider/openaiAieProvider';
import { AieDocumentAiGateway } from '@/lib/aie/provider/gateway';
import { maskText, containsUnmaskedPii } from '@/lib/aie/masking/piiMasking';
import { getAieAiModel, getAieAiMaxOutputTokensPerLineItemDocument } from '@/lib/aie/config';
import {
  bankStatementDocumentFactsSchema,
  registerBankStatementDocumentFactsSchema,
  AIE_BANK_STATEMENT_FACTS_SCHEMA_NAME,
  AIE_BANK_STATEMENT_FACTS_SCHEMA_VERSION,
} from '@/lib/aie/adapters/bankStatement/schema';
import { BANK_STATEMENT_AI_EXTRACTION_SYSTEM_PROMPT } from '@/lib/aie/adapters/bankStatement/gateway';
import { normaliseBankStatementRawFacts } from '@/lib/aie/adapters/bankStatement/normalise';
import { mapBankStatementFactsToDraft, keepOnlyPrintedBankFigures } from '@/lib/aie/adapters/bankStatement/mapping';
import { aiPartPrompt } from '@/lib/financial-data-hub/bankImport/aiChunking';

const ENABLED = process.env.AIE_BANK_PRINTED_BALANCE_LIVE_PROOF === '1';
const TENANT = { tenantKey: 'bank-printed-balance-live-proof-synthetic-tenant' };

beforeAll(() => {
  if (!ENABLED) return;
  process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY ||= randomBytes(32).toString('hex');
  process.env.AIE_AI_PROVIDER = 'openai';
});

const grouped = (n: number) => Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const printed = (b: number) => `$${grouped(b)} ${b < 0 ? 'DR' : 'CR'}`;

const ITEMS: Array<{ d: string; text: string; amt: number; dir: 'debit' | 'credit' }> = [
  ['03', 'EXAMPLE SUPERMARKET SYNTH', 84.15, 'debit'], ['03', 'CAFE SYNTHETICA', 12.5, 'debit'], ['04', 'PAYROLL EXAMPLE EMPLOYER', 2450, 'credit'],
  ['05', 'SYNTH ENERGY BILL', 187.3, 'debit'], ['05', 'SYNTH WATER UTILITY', 96.4, 'debit'], ['06', 'TRANSFER TO SYNTH SAVINGS', 1500, 'debit'],
  ['07', 'EXAMPLE PHARMACY', 23.95, 'debit'], ['08', 'SYNTH STREAMING', 15.99, 'debit'], ['09', 'EXAMPLE FUEL STOP', 71.2, 'debit'],
  ['10', 'ATM WITHDRAWAL SYNTH', 200, 'debit'], ['11', 'REFUND EXAMPLE STORE', 39.99, 'credit'], ['12', 'SYNTH INSURANCE PREMIUM', 142.8, 'debit'],
  ['13', 'EXAMPLE RESTAURANT', 118.6, 'debit'], ['14', 'SYNTH GYM MEMBERSHIP', 49, 'debit'], ['15', 'PAYROLL EXAMPLE EMPLOYER', 2450, 'credit'],
  ['16', 'SYNTH MOBILE PLAN', 65, 'debit'], ['17', 'EXAMPLE HARDWARE', 312.45, 'debit'], ['18', 'SYNTH RENT PAYMENT', 2100, 'debit'],
  ['19', 'EXAMPLE BOOKSHOP', 34.9, 'debit'], ['20', 'SYNTH TRAIN CARD TOPUP', 50, 'debit'], ['21', 'EXAMPLE VETERINARY', 265, 'debit'],
  ['22', 'INTEREST PAID SYNTH', 0.87, 'credit'], ['23', 'EXAMPLE SUPERMARKET SYNTH', 132.7, 'debit'], ['24', 'SYNTH ACCOUNT FEE', 10, 'debit'],
  ['25', 'EXAMPLE TAKEAWAY', 41.5, 'debit'], ['26', 'PAYROLL EXAMPLE EMPLOYER', 2450, 'credit'], ['27', 'SYNTH COUNCIL RATES', 480, 'debit'],
  ['28', 'EXAMPLE DEPARTMENT STORE', 215.35, 'debit'], ['29', 'SYNTH CAR SERVICE', 389, 'debit'], ['30', 'EXAMPLE CINEMA', 46, 'debit'],
].map(([d, text, amt, dir]) => ({ d: d as string, text: text as string, amt: amt as number, dir: dir as 'debit' | 'credit' }));

const OPENING = 50.0; // small enough that the first line already overdraws the account (printed "DR")
const rows: Array<{ line: string; balance: number }> = [];
let balance = OPENING;
for (const it of ITEMS) {
  balance = Math.round((balance + (it.dir === 'credit' ? it.amt : -it.amt)) * 100) / 100;
  const debit = it.dir === 'debit' ? `$${grouped(it.amt)}` : '';
  const credit = it.dir === 'credit' ? `$${grouped(it.amt)}` : '';
  rows.push({ line: `${it.d} Sep  ${it.text.padEnd(30)} ${debit.padStart(10)} ${credit.padStart(10)}  ${printed(balance)}`, balance });
}
const CLOSING = balance;
const STATEMENT = [
  'SYNTHETIC TEST BANK (NOT A REAL INSTITUTION, TEST DATA ONLY)',
  'Classic Banking statement  1 Sep 2026 to 30 Sep 2026',
  '',
  `Opening balance  ${printed(OPENING)}`,
  'Date    Particulars                        Debits    Credits   Balance',
  ...rows.map((r) => r.line),
  `Closing balance  ${printed(CLOSING)}`,
].join('\n');

describe.skipIf(!ENABLED)('Bank AI reading: balances printed as "$1,234.56 CR / DR" -- REAL gpt-4o-mini', () => {
  it('the environment really is configured for a live call', () => {
    expect(process.env.AIE_OPENAI_API_KEY, 'AIE_OPENAI_API_KEY must be set (never printed)').toBeTruthy();
    expect(process.env.AIE_AI_PROVIDER).toBe('openai');
    console.log(`[live proof] model=${getAieAiModel()} lines=${ITEMS.length} overdrawn_lines=${rows.filter((r) => r.balance < 0).length}`);
  });

  it('a real model reading the production per-part prompt returns something the adapter accepts, with every balance and amount right', async () => {
    registerBankStatementDocumentFactsSchema();
    const masking = maskText(STATEMENT, TENANT);
    expect(containsUnmaskedPii(masking.maskedText)).toBe(false);
    const prompt = aiPartPrompt({ seq: 0, pageFrom: 1, pageTo: 1, text: masking.maskedText }, 1);

    const gateway = new AieDocumentAiGateway(new OpenAiAieProvider(), { isKillSwitchEnabled: () => true });
    const result = await gateway.requestFieldCompletion({
      systemPrompt: BANK_STATEMENT_AI_EXTRACTION_SYSTEM_PROMPT,
      maskedUserPrompt: prompt,
      schemaName: AIE_BANK_STATEMENT_FACTS_SCHEMA_NAME,
      schemaVersion: AIE_BANK_STATEMENT_FACTS_SCHEMA_VERSION,
      model: getAieAiModel(),
      maxOutputTokens: getAieAiMaxOutputTokensPerLineItemDocument(),
      requestedFields: [],
      idempotencyKey: `live-proof-printed-balance-${Date.now()}`,
      userId: '20000000-0000-4000-8000-0000000000aa',
    });
    console.log('[live proof] gateway outcome:', result.outcome, 'tokens in/out:', result.inputTokens, result.outputTokens, 'errors:', JSON.stringify(result.errorCodes ?? []));
    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;

    // How many balances / amounts did the model still copy in the printed shape? (each was a whole-part rejection before)
    const raw = result.data as { transactions: Array<{ amount: string; balanceAfter: string | null }>; declaredOpeningBalance: { value: string | null }; declaredClosingBalance: { value: string | null } };
    const notClean = (s: string | null) => s !== null && !/^-?\d{1,15}(\.\d{1,2})?$/.test(s);
    const printedShapeBalances = raw.transactions.filter((t) => notClean(t.balanceAfter)).length;
    const printedShapeAmounts = raw.transactions.filter((t) => notClean(t.amount)).length;
    console.log(`[live proof] model answered ${raw.transactions.length} lines; balances still in printed shape: ${printedShapeBalances}; amounts: ${printedShapeAmounts}; declared opening/closing printed shape: ${notClean(raw.declaredOpeningBalance.value)}/${notClean(raw.declaredClosingBalance.value)}`);

    const { data, notes } = normaliseBankStatementRawFacts(result.data);
    console.log('[live proof] normaliser notes:', JSON.stringify(notes));
    // Optional evidence file (counts only, no content): LIVE_PROOF_OUT=<path>
    if (process.env.LIVE_PROOF_OUT) appendFileSync(process.env.LIVE_PROOF_OUT, JSON.stringify({ model: getAieAiModel(), lines: raw.transactions.length, tokensIn: result.inputTokens, tokensOut: result.outputTokens, balancesStillInPrintedShape: printedShapeBalances, amountsInPrintedShape: printedShapeAmounts, notes }) + String.fromCharCode(10));
    const parsed = bankStatementDocumentFactsSchema.safeParse(data);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error?.issues.map((i) => `${i.path.join('.')}:${i.code}`))).toBe(true);
    if (!parsed.success) return;
    const mapped = mapBankStatementFactsToDraft(parsed.data, notes);
    expect(mapped).not.toBeNull();
    const kept = keepOnlyPrintedBankFigures(mapped!, masking.maskedText);

    // ---- The oracle ----
    expect(kept.rows).toHaveLength(ITEMS.length);
    kept.rows.forEach((r, i) => {
      expect(r.amountOriginal, `amount line ${i + 1}`).toBe(ITEMS[i].amt);
      expect(r.creditDebit, `direction line ${i + 1}`).toBe(ITEMS[i].dir);
      expect(r.balanceAfter, `balance line ${i + 1}`).toBe(rows[i].balance);
    });
    expect(kept.statementMetadata.declaredOpeningBalance).toBe(OPENING);
    expect(kept.statementMetadata.declaredClosingBalance).toBe(CLOSING);
    expect(notes.balanceLinesNotRead).toEqual([]);
    expect(kept.rows.some((r) => (r.balanceAfter ?? 0) < 0), 'the overdrawn (DR) lines keep a negative sign').toBe(true);
  }, 180_000);
});
