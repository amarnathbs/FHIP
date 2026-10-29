/**
 * Bank-statement AI reading -- a part that starts at a page top with UNDATED transaction lines, REAL OpenAI provider (gpt-4o-mini).
 *
 * OPT-IN ONLY. Skipped unless `AIE_BANK_UNDATED_LIVE_PROOF=1`. Needs `AIE_OPENAI_API_KEY` (never printed). Writes NOTHING (no database,
 * no storage, no cost ledger: the same scope as `aieBankPrintedBalanceFormat.live.test.ts`). Costs a few cents of the DEV OpenAI project.
 *
 * 28-10-2026 production defect: a NAB statement prints the date only on the first transaction of a day, so the part that starts at the
 * top of page 2 begins with page headers, "Brought forward" and transaction lines with NO printed date; the date in force is the last
 * dated line of the previous part. The model returned empty dates and the strict schema rejected the whole part three times.
 *
 * This sends the EXACT production per-part prompt (`aiPartPrompt`) for part 2 of a SYNTHETIC two-part statement of that shape, once WITH
 * the deterministic date-in-force note and once WITHOUT it (the old behaviour), through the real gateway, then runs the answer through
 * the adapter's own deterministic steps. EVERY VALUE IS SYNTHETIC: no real person, account or statement.
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
import { aiPartPrompt, dateHintsForParts, datesInForceAtStartOfParts, datePlausibilityWindow } from '@/lib/financial-data-hub/bankImport/aiChunking';

const ENABLED = process.env.AIE_BANK_UNDATED_LIVE_PROOF === '1';
const TENANT = { tenantKey: 'bank-undated-live-proof-synthetic-tenant' };

beforeAll(() => {
  if (!ENABLED) return;
  process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY ||= randomBytes(32).toString('hex');
  process.env.AIE_AI_PROVIDER = 'openai';
});

const PART1 = [
  'SYNTHETIC TEST BANK (NOT A REAL INSTITUTION, TEST DATA ONLY)',
  'Classic Banking statement  1 Sep 2025 to 30 Sep 2025   Page 1 of 2',
  'Opening balance  $1,000.00 CR',
  'Date    Particulars                                  Debits     Credits   Balance',
  '3 Sep 2025  Synthetic Cafe Stop                          4.50                $995.50 CR',
  '            Synthetic Utility Debit                    10.00                $985.50 CR',
  '3 Sep 2025  Carried forward                                                $985.50 CR',
].join('\n');
const PART2 = [
  'SYNTHETIC TEST BANK (NOT A REAL INSTITUTION, TEST DATA ONLY)',
  'Classic Banking statement  1 Sep 2025 to 30 Sep 2025   Page 2 of 2',
  '            Brought forward                                                $985.50 CR',
  '            Online 0001 Linked Acc Trns / Synthetic Payee 20.00            $965.50 CR',
  '            Online 0002 Linked Acc Trns / Synthetic Payee 15.00            $950.50 CR',
  '            EFTPOS 21/09 16:30 Synthetic Fuel Stop      55.00              $895.50 CR',
  '            Online 0003 Linked Acc Trns / Synthetic Payee 10.00            $885.50 CR',
  '4 Sep 2025  Synthetic Pharmacy                          12.00              $873.50 CR',
  '            EFTPOS 22/09 09:10 Synthetic Grocer         30.00              $843.50 CR',
  'Closing balance  $843.50 CR',
].join('\n');
const TRUTH = ['2025-09-03', '2025-09-03', '2025-09-03', '2025-09-03', '2025-09-04', '2025-09-04'];
const TRUTH_BALANCES = [965.5, 950.5, 895.5, 885.5, 873.5, 843.5];

describe.skipIf(!ENABLED)('Bank AI reading: undated lines at a page top -- REAL gpt-4o-mini', () => {
  it('the environment really is configured for a live call', () => {
    expect(process.env.AIE_OPENAI_API_KEY, 'AIE_OPENAI_API_KEY must be set (never printed)').toBeTruthy();
    expect(process.env.AIE_AI_PROVIDER).toBe('openai');
  });

  async function read(maskedPart2: string, withHint: boolean) {
    registerBankStatementDocumentFactsSchema();
    const maskedPart1 = maskText(PART1, TENANT).maskedText;
    const texts = [maskedPart1, maskedPart2];
    const hint = dateHintsForParts(texts)[1];
    const inForce = datesInForceAtStartOfParts(texts)[1];
    if (withHint) expect(hint?.iso, 'the deterministic hint is the date of the last dated line of part 1').toBe('2025-09-03');
    const prompt = aiPartPrompt({ seq: 1, pageFrom: 2, pageTo: 2, text: maskedPart2 }, 2, null, withHint ? hint : null);
    const gateway = new AieDocumentAiGateway(new OpenAiAieProvider(), { isKillSwitchEnabled: () => true });
    const result = await gateway.requestFieldCompletion({
      systemPrompt: BANK_STATEMENT_AI_EXTRACTION_SYSTEM_PROMPT,
      maskedUserPrompt: prompt,
      schemaName: AIE_BANK_STATEMENT_FACTS_SCHEMA_NAME,
      schemaVersion: AIE_BANK_STATEMENT_FACTS_SCHEMA_VERSION,
      model: getAieAiModel(),
      maxOutputTokens: getAieAiMaxOutputTokensPerLineItemDocument(),
      requestedFields: [],
      idempotencyKey: `live-proof-undated-${withHint ? 'with' : 'without'}-${Date.now()}`,
      userId: '20000000-0000-4000-8000-0000000000aa',
    });
    return { result, inForce, prompt };
  }

  it('WITH the date-in-force note every line gets its true posting date; WITHOUT it (the old behaviour) the strict schema rejects the part or the dates are not the true ones', async () => {
    const maskedPart2 = maskText(PART2, TENANT).maskedText;
    expect(containsUnmaskedPii(maskedPart2)).toBe(false);

    // ---- WITH the hint (the fix), then the adapter's own deterministic steps with the date in force and the part's date range ----
    const withHint = await read(maskedPart2, true);
    expect(withHint.result.outcome).toBe('success');
    if (withHint.result.outcome !== 'success') return;
    const rawWith = withHint.result.data as { transactions: Array<{ transactionDate: string | null; balanceAfter: string | null }> };
    const normalisedWith = normaliseBankStatementRawFacts(withHint.result.data, { dateInForceIso: withHint.inForce?.iso ?? null, dateWindow: datePlausibilityWindow(maskedPart2, withHint.inForce) });
    const strictWith = bankStatementDocumentFactsSchema.safeParse(normalisedWith.data);
    const datesWith = strictWith.success ? strictWith.data.transactions.map((t) => t.transactionDate) : [];
    const modelDatesWith = rawWith.transactions.map((t) => t.transactionDate);

    // ---- WITHOUT the hint, and without the safety net's date in force: exactly the old behaviour ----
    const without = await read(maskedPart2, false);
    let withoutSummary = `outcome=${without.result.outcome}`;
    let withoutMatchesTruth = false;
    if (without.result.outcome === 'success') {
      const norm = normaliseBankStatementRawFacts(without.result.data, { dateInForceIso: null });
      const strict = bankStatementDocumentFactsSchema.safeParse(norm.data);
      withoutSummary += strict.success ? ' strict=accepted' : ` strict=rejected(${[...new Set(strict.error.issues.map((i) => `${i.path.slice(-1)[0]}:${i.code}`))].join(',')})`;
      withoutMatchesTruth = strict.success && JSON.stringify(strict.data.transactions.map((t) => t.transactionDate)) === JSON.stringify(TRUTH);
      withoutSummary += ` modelDates=${JSON.stringify((without.result.data as { transactions: Array<{ transactionDate: string | null }> }).transactions.map((t) => t.transactionDate))}`;
    }
    if (process.env.LIVE_PROOF_OUT) {
      appendFileSync(
        process.env.LIVE_PROOF_OUT,
        JSON.stringify({ model: getAieAiModel(), withHint: { modelDates: modelDatesWith, strictAccepted: strictWith.success, datesAfterNormaliser: datesWith, carriedForward: normalisedWith.notes.datesCarriedForward, tokens: [withHint.result.inputTokens, withHint.result.outputTokens] }, without: withoutSummary, withoutMatchesTruth }) + String.fromCharCode(10),
      );
    }

    // ---- The oracle ----
    expect(strictWith.success, strictWith.success ? '' : JSON.stringify(strictWith.error?.issues.map((i) => `${i.path.join('.')}:${i.code}`))).toBe(true);
    expect(datesWith).toEqual(TRUTH);
    expect(rawWith.transactions).toHaveLength(TRUTH.length);
    const balances = strictWith.success ? strictWith.data.transactions.map((t) => Number(String(t.balanceAfter).replace(/[^\d.-]/g, ''))) : [];
    expect(balances).toEqual(TRUTH_BALANCES);
    // the fix is what changed the outcome: without the note the same text does NOT yield the true dates through the strict schema
    expect(withoutMatchesTruth, `without the hint: ${withoutSummary}`).toBe(false);
  }, 240_000);
});
