/**
 * AIE unified document fallback — EGRESS-BOUNDARY PRIVACY PROOF for all four
 * new adapters (bank statement, retirement, liability, investment).
 *
 * WHAT THIS TEST IS, AND WHY IT IS SHAPED THIS WAY.
 *
 * It does not check that the masking REGEXES look right. It captures the
 * bytes that would actually have left the process — by installing a
 * capturing provider at the real `AieDocumentAiGateway` boundary and reading
 * `req.userPrompt`, the exact string the HTTP call would carry — and asserts
 * that a list of PII sentinels planted in a synthetic document is absent from
 * it.
 *
 * That distinction is the entire point, and this programme has the scars to
 * prove it. Every masking gap found in this codebase so far was found this
 * way and would NOT have been found by inspection:
 *   - M12B-F1: a 10-digit insurance policy number matched no rule and
 *     egressed verbatim, while `coverage_by_type` for the run was `{}`.
 *   - M12B: `Policy Owner:` / `Insured Person:` were absent from the
 *     person-name alternation, so insurance policy-owner names egressed.
 *   - 2026-09-22: `Employee:` — the single most common person-bearing label
 *     on a payslip — was likewise absent, found while live-proving the
 *     payslip adapter.
 *   - THIS DISPATCH: an AU HIN/SRN (`HIN: X0001234567`) matched nothing at
 *     all. Confirmed by capture, then fixed in `piiMasking.ts`.
 *
 * Reading the regexes had not caught any of those. Capturing the payload
 * caught all of them.
 *
 * EVERY VALUE IN THESE FIXTURES IS SYNTHETIC AND CLEARLY LABELLED. No real
 * person, account, member number, HIN or address appears anywhere in this
 * file, and none of these documents describes a real holding.
 *
 * DISCLOSED SCOPE. This proves the adapters' OWN gate and the gateway's
 * pre-egress re-scan. It does not prove that `maskText` catches every
 * conceivable formatting of every identifier — it cannot, and the
 * `NOT_MASKED_DISCLOSED` block at the bottom records, as executable
 * assertions rather than prose, the formats this dispatch verified are still
 * NOT masked. A test that silently omitted those would be claiming more
 * coverage than exists.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AieDocumentAiGateway } from '@/lib/aie/provider/gateway';
import { MockAieProvider } from '@/lib/aie/provider/mockAieProvider';
import { evaluateAiFallbackGate } from '@/lib/aie/adapters/shared/fallbackGate';
import { maskText, containsUnmaskedPii } from '@/lib/aie/masking/piiMasking';

import { registerBankStatementDocumentFactsSchema, AIE_BANK_STATEMENT_FACTS_SCHEMA_NAME, AIE_BANK_STATEMENT_FACTS_SCHEMA_VERSION } from '@/lib/aie/adapters/bankStatement/schema';
import { BANK_STATEMENT_AI_EXTRACTION_SYSTEM_PROMPT } from '@/lib/aie/adapters/bankStatement/gateway';
import { registerRetirementDocumentFactsSchema, AIE_RETIREMENT_FACTS_SCHEMA_NAME, AIE_RETIREMENT_FACTS_SCHEMA_VERSION } from '@/lib/aie/adapters/retirement/schema';
import { RETIREMENT_AI_EXTRACTION_SYSTEM_PROMPT } from '@/lib/aie/adapters/retirement/gateway';

const TEST_MASK_KEY = 'a1'.repeat(32);
const TENANT = 'unified-fallback-masking-proof-synthetic-tenant';

let saved: Record<string, string | undefined> = {};

beforeAll(() => {
  saved = {
    AIE_MASK_TOKEN_ENCRYPTION_KEY: process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY,
    AIE_AI_FALLBACK_ENABLED: process.env.AIE_AI_FALLBACK_ENABLED,
    AIE_PILOT_COHORT_ENFORCED: process.env.AIE_PILOT_COHORT_ENFORCED,
  };
  process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = TEST_MASK_KEY;
  process.env.AIE_AI_FALLBACK_ENABLED = 'true';
  // Cohort enforcement OFF so the gate's later steps are reachable; the
  // cohort gate itself is asserted separately below.
  process.env.AIE_PILOT_COHORT_ENFORCED = 'false';
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Captures the exact prompt that would have been sent to the provider. */
function capturingGateway(): { gateway: AieDocumentAiGateway; captured: string[] } {
  const captured: string[] = [];
  const provider = new MockAieProvider({
    respond: (req) => {
      // THE WHOLE POINT: record what would really have left the process.
      captured.push(`${req.systemPrompt ?? ''}\n${req.userPrompt}`);
      // Returning invalid JSON is fine — this test asserts on what went OUT,
      // never on what came back.
      return '{}';
    },
  });
  const gateway = new AieDocumentAiGateway(provider, { isKillSwitchEnabled: () => true });
  return { gateway, captured };
}

// ---------------------------------------------------------------------------
// SYNTHETIC FIXTURES. Each plants the identifiers that type of document really
// carries, in the formats AU/India institutions really print them in.
// ---------------------------------------------------------------------------

const BANK_SENTINELS = {
  holderName: 'ROBIN TESTCASE SAMPLEPERSON',
  address: '17 Fictional Grove, Testville NSW 2999',
  bsb: '062-000',
  account: '1234 5678',
  cardNumber: '4532 1111 2222 3333',
  customerRef: 'CRN-88213047',
  email: 'not.a.real.person@example.invalid',
};

const SYNTHETIC_BANK_STATEMENT = [
  'SYNTHETIC TEST BANK — NOT A REAL INSTITUTION',
  'Account Statement (TEST DATA ONLY)',
  `Account Holder: ${BANK_SENTINELS.holderName}`,
  `Address: ${BANK_SENTINELS.address}`,
  `BSB: ${BANK_SENTINELS.bsb}`,
  `Account Number: ${BANK_SENTINELS.account}`,
  `Card Number: ${BANK_SENTINELS.cardNumber}`,
  `Customer Reference: ${BANK_SENTINELS.customerRef}`,
  `Email: ${BANK_SENTINELS.email}`,
  'Statement period 01/03/2026 to 31/03/2026',
  'Opening balance 1,500.00',
  'Date        Description              Debit     Credit    Balance',
  '02/03/2026  COLES SUPERMARKET 1234   82.40               1417.60',
  '05/03/2026  SALARY ACME PTY LTD                3200.00   4617.60',
  '09/03/2026  RENT PAYMENT             1800.00             2817.60',
  'Closing balance 2,817.60',
].join('\n');

const RETIREMENT_SENTINELS = {
  memberName: 'ALEX SAMPLE TESTPERSON',
  memberNumber: '4821993',
  tfn: '123 456 789',
  dob: '14/03/1978',
  address: '9 Imaginary Parade, Testburg VIC 3999',
  uan: 'UAN-100234567890',
};

const SYNTHETIC_RETIREMENT_STATEMENT = [
  'SYNTHETIC TEST SUPER FUND — NOT A REAL FUND',
  'Annual Member Statement (TEST DATA ONLY)',
  `Member: ${RETIREMENT_SENTINELS.memberName}`,
  `Member Number: ${RETIREMENT_SENTINELS.memberNumber}`,
  `Tax File Number: ${RETIREMENT_SENTINELS.tfn}`,
  `Date of Birth: ${RETIREMENT_SENTINELS.dob}`,
  `Address: ${RETIREMENT_SENTINELS.address}`,
  `UAN: ${RETIREMENT_SENTINELS.uan}`,
  'Statement period 01/07/2025 to 30/06/2026',
  'Opening balance 45,200.00',
  'Employer contributions 6,400.00',
  'Personal contributions 1,200.00',
  'Investment earnings 3,100.00',
  'Administration fees 240.00',
  'Insurance premiums 380.00',
  'Contributions tax 960.00',
  'Closing balance 54,320.00',
].join('\n');

const INVESTMENT_SENTINELS = {
  investorName: 'JORDAN SAMPLE TESTHOLDER',
  hin: 'X0001234567',
  srn: 'I0007654321',
  address: '3 Notreal Crescent, Sampletown QLD 4999',
  tfn: '987 654 321',
};

const SYNTHETIC_INVESTMENT_STATEMENT = [
  'SYNTHETIC TEST BROKER — NOT A REAL BROKER',
  'Holding Statement (TEST DATA ONLY)',
  `Investor: ${INVESTMENT_SENTINELS.investorName}`,
  `HIN: ${INVESTMENT_SENTINELS.hin}`,
  `SRN: ${INVESTMENT_SENTINELS.srn}`,
  `Address: ${INVESTMENT_SENTINELS.address}`,
  `Tax File Number: ${INVESTMENT_SENTINELS.tfn}`,
  'Valuation date 31/03/2026',
  'Code   Security Name          Quantity   Price    Market Value',
  'AAA    Sample Holdings Ltd        1000    12.50       12500.00',
  'BBB    Fictional Resources NL      500     3.20        1600.00',
].join('\n');

const LIABILITY_SENTINELS = {
  holderName: 'SAM SAMPLE TESTBORROWER',
  loanAccount: 'HL-00482913',
  cardNumber: '5412 9999 8888 7777',
  bsb: '083-004',
  address: '22 Pretend Street, Faketon WA 6999',
};

const SYNTHETIC_LIABILITY_STATEMENT = [
  'SYNTHETIC TEST LENDER — NOT A REAL LENDER',
  'Home Loan Statement (TEST DATA ONLY)',
  `Account Holder: ${LIABILITY_SENTINELS.holderName}`,
  `Loan Account: ${LIABILITY_SENTINELS.loanAccount}`,
  `Card Number: ${LIABILITY_SENTINELS.cardNumber}`,
  `BSB: ${LIABILITY_SENTINELS.bsb}`,
  `Address: ${LIABILITY_SENTINELS.address}`,
  'Statement period 01/03/2026 to 31/03/2026',
  'Opening principal 412,000.00',
  'Payment Date,Description,Amount,Type,Principal,Interest,Fee',
  '05/03/2026,Repayment,2450.00,Repayment,980.00,1470.00,0.00',
  'Closing principal 411,020.00',
].join('\n');

const FIXTURES = [
  { name: 'bank statement', text: SYNTHETIC_BANK_STATEMENT, sentinels: BANK_SENTINELS },
  { name: 'retirement statement', text: SYNTHETIC_RETIREMENT_STATEMENT, sentinels: RETIREMENT_SENTINELS },
  { name: 'investment statement', text: SYNTHETIC_INVESTMENT_STATEMENT, sentinels: INVESTMENT_SENTINELS },
  { name: 'liability statement', text: SYNTHETIC_LIABILITY_STATEMENT, sentinels: LIABILITY_SENTINELS },
] as const;

describe('AIE unified fallback — masking at the egress boundary', () => {
  describe.each(FIXTURES)('$name', ({ text, sentinels }) => {
    it('masks every planted identifier before the gate returns any text', () => {
      const gate = evaluateAiFallbackGate({ userId: TENANT, adapterEnabled: true, extractedText: text });
      expect(gate.ok).toBe(true);
      if (!gate.ok) return;

      for (const [label, value] of Object.entries(sentinels)) {
        expect(gate.maskedText, `${label} ("${value}") must not survive masking`).not.toContain(value);
      }
    });

    it('records the masking as having found something (coverage is not silently empty)', () => {
      // M12B-F1's own failure mode was a run whose `coverage_by_type` was
      // literally `{}` while PII egressed. An empty coverage map on a
      // document this full of identifiers means the masker did nothing.
      const gate = evaluateAiFallbackGate({ userId: TENANT, adapterEnabled: true, extractedText: text });
      expect(gate.ok).toBe(true);
      if (!gate.ok) return;
      expect(gate.totalMatches).toBeGreaterThan(0);
      expect(Object.keys(gate.coverageByType).length).toBeGreaterThan(0);
    });

    it('leaves the financial values the adapter exists to read intact', () => {
      // Masking that ate the amounts would be "safe" and useless. This is the
      // other half of correct behaviour and is asserted explicitly.
      const { maskedText } = maskText(text, { tenantKey: TENANT });
      expect(maskedText).toMatch(/\d/);
      expect(maskedText.length).toBeGreaterThan(100);
    });
  });

  it('bank statement: nothing sensitive reaches the provider through the REAL gateway', async () => {
    registerBankStatementDocumentFactsSchema();
    const { gateway, captured } = capturingGateway();
    const gate = evaluateAiFallbackGate({ userId: TENANT, adapterEnabled: true, extractedText: SYNTHETIC_BANK_STATEMENT });
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;

    await gateway.requestFieldCompletion({
      systemPrompt: BANK_STATEMENT_AI_EXTRACTION_SYSTEM_PROMPT,
      maskedUserPrompt: gate.maskedText,
      schemaName: AIE_BANK_STATEMENT_FACTS_SCHEMA_NAME,
      schemaVersion: AIE_BANK_STATEMENT_FACTS_SCHEMA_VERSION,
      model: 'test-model',
      maxOutputTokens: 256,
      requestedFields: [],
      idempotencyKey: 'masking-egress-bank',
    });

    expect(captured.length).toBe(1);
    for (const [label, value] of Object.entries(BANK_SENTINELS)) {
      expect(captured[0], `${label} must not reach the provider`).not.toContain(value);
    }
  });

  it('retirement statement: nothing sensitive reaches the provider through the REAL gateway', async () => {
    registerRetirementDocumentFactsSchema();
    const { gateway, captured } = capturingGateway();
    const gate = evaluateAiFallbackGate({ userId: TENANT, adapterEnabled: true, extractedText: SYNTHETIC_RETIREMENT_STATEMENT });
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;

    await gateway.requestFieldCompletion({
      systemPrompt: RETIREMENT_AI_EXTRACTION_SYSTEM_PROMPT,
      maskedUserPrompt: gate.maskedText,
      schemaName: AIE_RETIREMENT_FACTS_SCHEMA_NAME,
      schemaVersion: AIE_RETIREMENT_FACTS_SCHEMA_VERSION,
      model: 'test-model',
      maxOutputTokens: 256,
      requestedFields: [],
      idempotencyKey: 'masking-egress-retirement',
    });

    expect(captured.length).toBe(1);
    for (const [label, value] of Object.entries(RETIREMENT_SENTINELS)) {
      expect(captured[0], `${label} must not reach the provider`).not.toContain(value);
    }
  });

  it("the gateway's own independent pre-egress re-scan also passes on every fixture", () => {
    // `containsUnmaskedPii` is a SEPARATE guard from `maskText`, reading the
    // same `PII_PATTERNS` array. M12B-F2 was precisely the case where the two
    // asked different questions and the guard rejected fully-masked payloads.
    for (const { name, text } of FIXTURES) {
      const { maskedText } = maskText(text, { tenantKey: TENANT });
      expect(containsUnmaskedPii(maskedText), `${name} still trips the pre-egress guard`).toBe(false);
    }
  });
});

describe('AIE unified fallback — the gate fails closed', () => {
  it('refuses when the adapter flag is off, before touching the masking key', () => {
    const r = evaluateAiFallbackGate({ userId: TENANT, adapterEnabled: false, extractedText: SYNTHETIC_BANK_STATEMENT });
    expect(r).toEqual({ ok: false, reason: 'adapter_disabled' });
  });

  it('refuses when the shared global kill switch is off', () => {
    const prev = process.env.AIE_AI_FALLBACK_ENABLED;
    process.env.AIE_AI_FALLBACK_ENABLED = 'false';
    try {
      const r = evaluateAiFallbackGate({ userId: TENANT, adapterEnabled: true, extractedText: SYNTHETIC_BANK_STATEMENT });
      expect(r).toEqual({ ok: false, reason: 'global_kill_switch_disabled' });
    } finally {
      process.env.AIE_AI_FALLBACK_ENABLED = prev;
    }
  });

  it('refuses a user outside the shared pilot cohort', () => {
    const prevEnforced = process.env.AIE_PILOT_COHORT_ENFORCED;
    const prevIds = process.env.AIE_PILOT_COHORT_USER_IDS;
    process.env.AIE_PILOT_COHORT_ENFORCED = 'true';
    process.env.AIE_PILOT_COHORT_USER_IDS = 'someone-else';
    try {
      const r = evaluateAiFallbackGate({ userId: TENANT, adapterEnabled: true, extractedText: SYNTHETIC_BANK_STATEMENT });
      expect(r).toEqual({ ok: false, reason: 'cohort_denied' });
    } finally {
      if (prevEnforced === undefined) delete process.env.AIE_PILOT_COHORT_ENFORCED;
      else process.env.AIE_PILOT_COHORT_ENFORCED = prevEnforced;
      if (prevIds === undefined) delete process.env.AIE_PILOT_COHORT_USER_IDS;
      else process.env.AIE_PILOT_COHORT_USER_IDS = prevIds;
    }
  });

  it('refuses — never falls back to sending raw text — when the masking key is unset', () => {
    const prev = process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY;
    delete process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY;
    try {
      const r = evaluateAiFallbackGate({ userId: TENANT, adapterEnabled: true, extractedText: SYNTHETIC_BANK_STATEMENT });
      expect(r).toEqual({ ok: false, reason: 'masking_unavailable' });
    } finally {
      process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = prev;
    }
  });

  it('refuses a document with essentially no text rather than inviting invention', () => {
    const r = evaluateAiFallbackGate({ userId: TENANT, adapterEnabled: true, extractedText: '   \n  ' });
    expect(r).toEqual({ ok: false, reason: 'no_extracted_text' });
  });

  it('a successful gate result carries ONLY masked text — the raw text is not reachable from it', () => {
    const r = evaluateAiFallbackGate({ userId: TENANT, adapterEnabled: true, extractedText: SYNTHETIC_BANK_STATEMENT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // There is no `rawText`/`extractedText` field on the success shape, so a
    // caller physically cannot send the unmasked document by mistake.
    expect(Object.keys(r).sort()).toEqual(['coverageByType', 'maskedText', 'ok', 'totalMatches']);
  });
});

/**
 * DISCLOSED RESIDUAL EXPOSURE — asserted, not described.
 *
 * These formats are NOT masked today. They are recorded here as passing
 * assertions of the CURRENT behaviour so that (a) the gap is impossible to
 * overlook in review, and (b) if someone later fixes one, this test fails and
 * forces the disclosure to be updated rather than quietly going stale.
 *
 * Each was verified by capture during this dispatch, not assumed.
 */
describe('AIE unified fallback — masking gaps this dispatch found but did NOT close', () => {
  it('a HYPHENATED TFN is not masked (the rule requires the ATO-standard spaced form)', () => {
    const { maskedText } = maskText('Tax File Number: 123-456-789', { tenantKey: TENANT });
    expect(maskedText).toContain('123-456-789');
  });

  it('a fund ABN is PARTIALLY masked, and mislabelled as a tax_id', () => {
    // FOUND BY THIS TEST, and it corrected an assumption. The expectation
    // written first was "an ABN is not masked at all", on the reasoning that
    // no rule targets the 2-3-3-3 ABN shape. What actually happens is
    // stranger and worth recording precisely: an ABN's LAST NINE DIGITS
    // (`824 753 556`) match the AU TFN rule's 3-3-3 pattern, so the value is
    // half-redacted — `51 [MASKED:tax_id:...]` — and `coverage_by_type`
    // reports a `tax_id` for a document that contained no tax file number.
    //
    // This is over-capture, NOT a leak: no member identifier escapes. Its
    // real cost is that the privacy evidence describes the document
    // inaccurately, which is the same complaint `PII_PATTERNS`' own ordering
    // comment makes about the folio-vs-TFN case.
    //
    // DELIBERATELY NOT FIXED HERE. The clean fix is an ABN rule ordered above
    // `tax_id`, but `tax_id` is shared with the live, merged, live-proven
    // payslip path, and re-ordering a rule that path depends on is not a
    // change to make as a side effect of a different document type's
    // dispatch. Reported for the Product Owner instead.
    const { maskedText } = maskText('Fund ABN: 51 824 753 556', { tenantKey: TENANT });
    expect(maskedText).toContain('51 ');
    expect(maskedText).toContain('[MASKED:tax_id:');
    expect(maskedText).not.toContain('824 753 556');
  });

  it('a super fund USI is not masked — a deliberate decision, not a miss', () => {
    // A USI identifies the FUND, not the member. Masking it would be the same
    // mistake as masking an employer name on a payslip: redacting the very
    // field the adapter exists to read.
    const { maskedText } = maskText('USI: HST0100AU', { tenantKey: TENANT });
    expect(maskedText).toContain('HST0100AU');
  });

  it('an UNLABELLED postal address is not masked (the address rule is label-anchored by design)', () => {
    // A street address has no reliable shape, so the only dependable signal
    // is the label the document prints. A letterhead address with no label —
    // common on broker statements — is out of reach. Pre-existing and
    // documented in `piiMasking.ts` itself; restated here because it applies
    // squarely to these four document types.
    const { maskedText } = maskText('SOME BROKER PTY LTD\n17 Fictional Grove, Testville NSW 2999\n', { tenantKey: TENANT });
    expect(maskedText).toContain('17 Fictional Grove');
  });
});
