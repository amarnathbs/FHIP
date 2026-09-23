/**
 * AIE unified document fallback — REAL OpenAI provider proof for the
 * bank-statement and retirement adapters, through the REAL code path (this
 * adapter's own schema, its own production prompt, the real gateway, the real
 * masking layer, the real mapping function).
 *
 * OPT-IN ONLY. Skipped unless `AIE_UNIFIED_FALLBACK_LIVE_PROVIDER_PROOF=1`,
 * because it spends real money against the configured OpenAI project. Two
 * `gpt-4o-mini` calls of a few thousand tokens each — well under a cent at the
 * pricing recorded in `lib/aie/config.ts`. Requires a real
 * `AIE_OPENAI_API_KEY` (the key is never printed, only its presence
 * asserted).
 *
 * WHY BOTH A UNIT SUITE AND THIS. `tests/unit/aieUnifiedFallbackSchemaShape.test.ts`
 * proves the schemas are internally consistent, and
 * `tests/unit/aieUnifiedFallbackMaskingEgress.test.ts` proves nothing
 * sensitive reaches the provider — both against a faked provider. Neither can
 * prove the thing that actually decides whether this feature works: that a
 * REAL model, given this adapter's real prompt and real strict JSON Schema,
 * returns something this adapter's own Zod contract accepts and its mapping
 * function can turn into a usable draft. The payslip dispatch found exactly
 * two defects this way that no unit test had caught — a schema the provider
 * rejected on format, and an unmasked employee name — and both were invisible
 * until a real call was made.
 *
 * SCOPE, DISCLOSED. This constructs its OWN `AieDocumentAiGateway` with
 * `isKillSwitchEnabled: () => true` and NO `costAdmission` option — exactly as
 * `aiePayslipAdapterLiveProviderProof.live.test.ts` and
 * `aieM2RealProviderProof.live.test.ts` already do, and for the same stated
 * reason: the adapters' shared module-level gateway wires the real
 * `reserveConservativeAiCost`/`settleAiCost`, which require the migration-0152
 * cost-ledger tables to exist in whatever database `SUPABASE_SERVICE_ROLE_KEY`
 * points at. This proof demonstrates what is NEW here — these adapters' own
 * schema/prompt/mapping round-tripping through a real model — not the shared
 * cost-admission plumbing, which is proven separately and reused unchanged.
 *
 * IT ALSO DOES NOT touch a database, a storage bucket, or any FDH service. It
 * never writes anything. The synthetic documents below never reach the native
 * upload path at all.
 *
 * EVERY VALUE IN THE FIXTURES IS SYNTHETIC AND CLEARLY LABELLED AS TEST DATA.
 * No real person, account, member number or address appears.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { randomBytes } from 'node:crypto';
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
import { mapBankStatementFactsToDraft } from '@/lib/aie/adapters/bankStatement/mapping';

import {
  retirementDocumentFactsSchema,
  registerRetirementDocumentFactsSchema,
  AIE_RETIREMENT_FACTS_SCHEMA_NAME,
  AIE_RETIREMENT_FACTS_SCHEMA_VERSION,
} from '@/lib/aie/adapters/retirement/schema';
import { RETIREMENT_AI_EXTRACTION_SYSTEM_PROMPT } from '@/lib/aie/adapters/retirement/gateway';
import { mapRetirementFactsToExtraction } from '@/lib/aie/adapters/retirement/mapping';

const ENABLED = process.env.AIE_UNIFIED_FALLBACK_LIVE_PROVIDER_PROOF === '1';
const TENANT = { tenantKey: 'unified-fallback-live-proof-synthetic-tenant' };

beforeAll(() => {
  if (!ENABLED) return;
  // The masking key is generated PER RUN and dies with the process — this
  // proof provisions no secret and persists nothing. Same discipline as the
  // M3 live-dev proof.
  process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY ||= randomBytes(32).toString('hex');
  process.env.AIE_AI_PROVIDER = 'openai';
});

function liveGateway(): AieDocumentAiGateway {
  return new AieDocumentAiGateway(new OpenAiAieProvider(), { isKillSwitchEnabled: () => true });
}

// ---------------------------------------------------------------------------
// BANK STATEMENT — synthetic, with a deliberately UNRECOGNISABLE layout (no
// FHIP adapter matches it), which is exactly the `unsupported_layout` case the
// fallback exists for.
// ---------------------------------------------------------------------------

const BANK_PII_SENTINELS = ['ROBIN TESTCASE SAMPLEPERSON', '17 Fictional Grove, Testville NSW 2999'];

const SYNTHETIC_BANK_STATEMENT = [
  'SYNTHETIC TEST BANK — NOT A REAL INSTITUTION (TEST DATA ONLY)',
  'Everyday Account Statement',
  'Account Holder: ROBIN TESTCASE SAMPLEPERSON',
  'Address: 17 Fictional Grove, Testville NSW 2999',
  'BSB: 062-000    Account Number: 1234 5678',
  'Statement period 01/03/2026 to 31/03/2026',
  '',
  'Opening balance: 1,500.00',
  '',
  '  DATE        NARRATIVE                        WITHDRAWN    DEPOSITED    BALANCE',
  '  02/03/2026  COLES SUPERMARKET 1234              82.40                  1,417.60',
  '  05/03/2026  SALARY ACME PTY LTD                              3,200.00  4,617.60',
  '  09/03/2026  RENT PAYMENT SAMPLE REALTY       1,800.00                  2,817.60',
  '  17/03/2026  ORIGIN ENERGY BILL                 145.20                  2,672.40',
  '  28/03/2026  TRANSFER TO SAVINGS                500.00                  2,172.40',
  '',
  'Closing balance: 2,172.40',
].join('\n');

/** The oracle: what a careful human reads off the document above. */
const BANK_EXPECTED = {
  transactionCount: 5,
  openingBalance: 1500,
  closingBalance: 2172.4,
  firstDate: '2026-03-02',
  salaryAmount: 3200,
  salaryDirection: 'credit' as const,
  rentAmount: 1800,
  rentDirection: 'debit' as const,
  finalBalance: 2172.4,
};

// ---------------------------------------------------------------------------
// RETIREMENT STATEMENT — synthetic AU super member statement, deliberately
// including BOTH individual contributions AND a summary total, to test the
// one instruction most likely to be got wrong (double counting).
// ---------------------------------------------------------------------------

const RETIREMENT_PII_SENTINELS = ['ALEX SAMPLE TESTPERSON', '9 Imaginary Parade, Testburg VIC 3999', '123 456 789'];

const SYNTHETIC_RETIREMENT_STATEMENT = [
  'SYNTHETIC TEST SUPER FUND — NOT A REAL FUND (TEST DATA ONLY)',
  'Annual Member Statement',
  'Member: ALEX SAMPLE TESTPERSON',
  'Member Number: 4821993',
  'Tax File Number: 123 456 789',
  'Date of Birth: 14/03/1978',
  'Address: 9 Imaginary Parade, Testburg VIC 3999',
  'Statement period: 01/07/2025 to 30/06/2026',
  '',
  'YOUR ACCOUNT AT A GLANCE',
  '  Opening balance at 01/07/2025          45,200.00',
  '  Closing balance at 30/06/2026          54,320.00',
  '',
  'TRANSACTIONS',
  '  15/01/2026  Employer contribution (SG)      533.33',
  '  15/04/2026  Employer contribution (SG)      533.33',
  '  20/04/2026  Personal contribution         1,200.00',
  '  30/06/2026  Administration fee              240.00',
  '  30/06/2026  Insurance premium               380.00',
  '  30/06/2026  Contributions tax               960.00',
  '  30/06/2026  Net investment earnings       3,100.00',
  '',
  'SUMMARY FOR THE YEAR',
  '  Total employer contributions this year   6,400.00',
  '  Total personal contributions this year   1,200.00',
  '',
  'YOUR INVESTMENTS',
  '  Balanced option      Diversified     54,320.00 as at 30/06/2026',
].join('\n');

const RETIREMENT_EXPECTED = {
  openingBalance: '45200.00',
  closingBalance: '54320.00',
  employerContributions: '6400.00',
  personalContributions: '1200.00',
};

describe.skipIf(!ENABLED)('AIE unified fallback — REAL gpt-4o-mini provider proof', () => {
  it('the environment really is configured for a live call', () => {
    expect(process.env.AIE_OPENAI_API_KEY, 'AIE_OPENAI_API_KEY must be set (never printed)').toBeTruthy();
    expect(process.env.AIE_AI_PROVIDER).toBe('openai');
    // Recorded so the report can state exactly which model answered.
    console.log(`[live proof] model=${getAieAiModel()} maxOutputTokens=${getAieAiMaxOutputTokensPerLineItemDocument()}`);
  });

  it('BANK STATEMENT: a real model reads an unrecognised layout into a usable, correct draft', async () => {
    registerBankStatementDocumentFactsSchema();

    const masking = maskText(SYNTHETIC_BANK_STATEMENT, TENANT);
    // Pre-egress: prove what is about to leave carries no sentinel.
    for (const s of BANK_PII_SENTINELS) expect(masking.maskedText, `sentinel "${s}" must not egress`).not.toContain(s);
    expect(containsUnmaskedPii(masking.maskedText)).toBe(false);
    console.log('[live proof] bank masking coverage:', JSON.stringify(masking.coverageByType));

    const result = await liveGateway().requestFieldCompletion({
      systemPrompt: BANK_STATEMENT_AI_EXTRACTION_SYSTEM_PROMPT,
      maskedUserPrompt: masking.maskedText,
      schemaName: AIE_BANK_STATEMENT_FACTS_SCHEMA_NAME,
      schemaVersion: AIE_BANK_STATEMENT_FACTS_SCHEMA_VERSION,
      model: getAieAiModel(),
      maxOutputTokens: getAieAiMaxOutputTokensPerLineItemDocument(),
      requestedFields: [],
      idempotencyKey: `live-proof-bank-${Date.now()}`,
    });

    console.log('[live proof] bank outcome:', result.outcome);
    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;

    const parsed = bankStatementDocumentFactsSchema.safeParse(result.data);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
    if (!parsed.success) return;

    const draft = mapBankStatementFactsToDraft(parsed.data);
    expect(draft, 'the mapping must produce a usable draft').not.toBeNull();
    if (!draft) return;

    console.log('[live proof] bank rows read:', draft.rows.length, JSON.stringify(draft.rows, null, 1));

    // ---- The oracle. Real values, compared against what the page says. ----
    expect(draft.rows).toHaveLength(BANK_EXPECTED.transactionCount);
    expect(draft.statementMetadata.declaredOpeningBalance).toBe(BANK_EXPECTED.openingBalance);
    expect(draft.statementMetadata.declaredClosingBalance).toBe(BANK_EXPECTED.closingBalance);
    expect(draft.rows[0].transactionDate).toBe(BANK_EXPECTED.firstDate);

    const salary = draft.rows.find((r) => /SALARY/i.test(r.descriptionRaw));
    expect(salary, 'the salary line must be read').toBeTruthy();
    expect(salary!.amountOriginal).toBe(BANK_EXPECTED.salaryAmount);
    expect(salary!.creditDebit).toBe(BANK_EXPECTED.salaryDirection);

    const rent = draft.rows.find((r) => /RENT/i.test(r.descriptionRaw));
    expect(rent, 'the rent line must be read').toBeTruthy();
    expect(rent!.amountOriginal).toBe(BANK_EXPECTED.rentAmount);
    expect(rent!.creditDebit).toBe(BANK_EXPECTED.rentDirection);

    // Direction must be carried by creditDebit, never by a sign.
    for (const r of draft.rows) expect(r.amountOriginal).toBeGreaterThanOrEqual(0);

    // The running balance on the last row must match the declared close —
    // this is the deterministic check the whole design leans on, and it is
    // the one a truncated or hallucinated extraction fails.
    const last = draft.rows[draft.rows.length - 1];
    expect(last.balanceAfter).toBe(BANK_EXPECTED.finalBalance);

    expect(draft.allTransactionsListed).toBe(true);

    // Nothing sensitive came BACK either.
    const responseText = JSON.stringify(result.data);
    for (const s of BANK_PII_SENTINELS) expect(responseText).not.toContain(s);
  }, 120_000);

  it('RETIREMENT: a real model reads a member statement, and marks the summary totals as totals', async () => {
    registerRetirementDocumentFactsSchema();

    const masking = maskText(SYNTHETIC_RETIREMENT_STATEMENT, TENANT);
    for (const s of RETIREMENT_PII_SENTINELS) expect(masking.maskedText, `sentinel "${s}" must not egress`).not.toContain(s);
    expect(containsUnmaskedPii(masking.maskedText)).toBe(false);
    console.log('[live proof] retirement masking coverage:', JSON.stringify(masking.coverageByType));

    const result = await liveGateway().requestFieldCompletion({
      systemPrompt: RETIREMENT_AI_EXTRACTION_SYSTEM_PROMPT,
      maskedUserPrompt: masking.maskedText,
      schemaName: AIE_RETIREMENT_FACTS_SCHEMA_NAME,
      schemaVersion: AIE_RETIREMENT_FACTS_SCHEMA_VERSION,
      model: getAieAiModel(),
      maxOutputTokens: getAieAiMaxOutputTokensPerLineItemDocument(),
      requestedFields: [],
      idempotencyKey: `live-proof-retirement-${Date.now()}`,
    });

    console.log('[live proof] retirement outcome:', result.outcome);
    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;

    const parsed = retirementDocumentFactsSchema.safeParse(result.data);
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error?.issues, null, 2)).toBe(true);
    if (!parsed.success) return;

    const extraction = mapRetirementFactsToExtraction(parsed.data, {
      jurisdiction: 'AU',
      currencyCode: 'AUD',
      statementType: 'retirement_statement_csv',
      accountType: 'unknown',
    });
    expect(extraction, 'the mapping must produce a usable extraction').not.toBeNull();
    if (!extraction) return;

    console.log('[live proof] retirement activities:', extraction.activities.length);
    console.log('[live proof] retirement balances:', extraction.openingBalance, '->', extraction.closingBalance);

    // ---- The oracle. ----
    expect(extraction.openingBalance).toBe(RETIREMENT_EXPECTED.openingBalance);
    expect(extraction.closingBalance).toBe(RETIREMENT_EXPECTED.closingBalance);
    expect(extraction.employerContributions).toBe(RETIREMENT_EXPECTED.employerContributions);
    expect(extraction.personalContributions).toBe(RETIREMENT_EXPECTED.personalContributions);

    // Money must be exact decimal STRINGS on this type — a number here would
    // be the defect the native type's own header names.
    expect(typeof extraction.closingBalance).toBe('string');
    for (const a of extraction.activities) {
      expect(typeof a.amount).toBe('string');
      expect(Number(a.amount)).toBeGreaterThanOrEqual(0);
    }

    // The instruction most likely to be got wrong: the document prints BOTH
    // two individual employer contributions AND a "Total employer
    // contributions this year" line. If the model marked no line as a summary
    // total, a downstream consumer summing activities would double-count the
    // year. This asserts it distinguished them.
    const summaryTotals = extraction.activities.filter((a) => a.isSummaryTotal || a.isYearToDate);
    console.log(
      '[live proof] retirement summary/YTD-marked lines:',
      summaryTotals.length,
      JSON.stringify(summaryTotals.map((a) => ({ t: a.activityType, amt: a.amount, sum: a.isSummaryTotal, ytd: a.isYearToDate }))),
    );
    expect(summaryTotals.length).toBeGreaterThan(0);

    // Jurisdiction and currency are caller context and must never come from
    // the model, whatever it said.
    expect(extraction.jurisdiction).toBe('AU');
    expect(extraction.currencyCode).toBe('AUD');
    expect(extraction.extractionConfidence).toBe(0);

    const responseText = JSON.stringify(result.data);
    for (const s of RETIREMENT_PII_SENTINELS) expect(responseText).not.toContain(s);
  }, 120_000);
});
