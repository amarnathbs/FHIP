import { describe, it, expect } from 'vitest';
import { buildInvestmentReconciliationRule, type InvestmentReconciliationContext } from '@/lib/aie/adapters/investment-intelligence/reconciliationRule';
import { toAieCandidates } from '@/lib/aie/adapters/investment-intelligence/parserAdapter';
import { matchAccountsReadOnly, type ExistingAccountForMatching } from '@/lib/aie/adapters/investment-intelligence/accountMatching';
import { matchInstrumentsReadOnly } from '@/lib/aie/adapters/investment-intelligence/instrumentMatching';
import { computeTransactionFingerprint } from '@/lib/services/investment-intelligence/fingerprint';
import { parseExactDecimal } from '@/lib/services/investment-intelligence/decimal';
import { DEFAULT_RECONCILIATION_CONFIG } from '@/lib/services/investment-intelligence/reconciliationConfig';
import { parseExtractedDocument } from '@/lib/services/investment-intelligence/parsers/registry';
import type { ExistingInstrumentForResolution } from '@/lib/services/investment-intelligence/schemeResolution';
import { buildAieIiCasFixtureText } from '../support/buildAieIiCasFixtureText';

const EXISTING_ACCOUNT: ExistingAccountForMatching = { id: 'acct-1', folioNumber: '1122334455', institutionName: 'Prime Mutual Fund' };
const EXISTING_INSTRUMENT: ExistingInstrumentForResolution = {
  instrumentId: 'instr-1',
  isin: 'INF999K01AB1',
  amfiSchemeCode: null,
  internalProvisionalCode: null,
  normalisedSchemeName: 'prime flexi cap fund growth direct plan',
  amcName: 'Prime Mutual Fund',
  planType: 'direct',
  optionType: 'growth',
  countryCode: 'IN',
};

function buildContext(overrides: Partial<InvestmentReconciliationContext> = {}): { ctx: InvestmentReconciliationContext; candidates: ReturnType<typeof toAieCandidates> } {
  const text = buildAieIiCasFixtureText();
  const parsed = parseExtractedDocument(text).parsed!;
  const candidates = toAieCandidates(parsed);
  const accountMatches = matchAccountsReadOnly(parsed, [EXISTING_ACCOUNT]);
  const instrumentMatches = matchInstrumentsReadOnly(parsed.transactions.map((t) => t.scheme), 'IN', [EXISTING_INSTRUMENT], []);

  const ctx: InvestmentReconciliationContext = {
    sourceKey: 'cams',
    countryCode: 'IN',
    accountMatches,
    instrumentMatches,
    existingFingerprints: new Set(),
    existingSnapshots: new Map(),
    existingTransactionsForPosition: new Map(),
    existingAccountCurrency: new Map([['acct-1', 'INR']]),
    config: DEFAULT_RECONCILIATION_CONFIG,
    ...overrides,
  };
  return { ctx, candidates };
}

describe('AIE-1.2 — deterministic reconciliation rule (execution sequence step 9)', () => {
  it('POSITIVE: a clean first-time position (no existing snapshot, statement covers from inception) reconciles PASS with zero variance', () => {
    const { ctx, candidates } = buildContext();
    const rule = buildInvestmentReconciliationRule(ctx);
    const results = rule({ runId: 'run-1', candidates });
    const rollForward = results.find((r) => r.ruleId.startsWith('ii_adapter_roll_forward:'));
    expect(rollForward?.outcome).toBe('pass');
    const dup = results.find((r) => r.ruleId === 'ii_adapter_duplicate_overlap');
    expect(dup?.outcome).toBe('pass');
    const conflict = results.find((r) => r.ruleId.startsWith('ii_adapter_canonical_conflict:'));
    expect(conflict?.outcome).toBe('pass');
  });

  it('DUPLICATE/OVERLAP: a transaction whose fingerprint already exists is pass_with_tolerance (linked, not re-imported), never a silent second write', () => {
    const { candidates } = buildContext();
    const txnValue = candidates.find((c) => c.fieldName === 'transaction:0')!;
    const parsedTxn = JSON.parse(txnValue.valueRaw!);
    const fingerprint = computeTransactionFingerprint({
      sourceKey: 'cams',
      accountId: 'acct-1',
      instrumentId: 'instr-1',
      transactionDateIso: parsedTxn.transactionDateIso,
      transactionType: parsedTxn.canonicalType,
      amountScaled: parseExactDecimal(parsedTxn.amount).ok ? (parseExactDecimal(parsedTxn.amount) as { scaled: bigint }).scaled : BigInt(0),
      unitsScaled: parseExactDecimal(parsedTxn.units).ok ? (parseExactDecimal(parsedTxn.units) as { scaled: bigint }).scaled : null,
      navScaled: parseExactDecimal(parsedTxn.nav).ok ? (parseExactDecimal(parsedTxn.nav) as { scaled: bigint }).scaled : null,
      sourceReference: parsedTxn.sourceReference,
    });
    const { ctx: ctxWithDup, candidates: candidatesWithDup } = buildContext({ existingFingerprints: new Set([`acct-1:${fingerprint}`]) });
    const rule = buildInvestmentReconciliationRule(ctxWithDup);
    const results = rule({ runId: 'run-1', candidates: candidatesWithDup });
    const dup = results.find((r) => r.ruleId === 'ii_adapter_duplicate_overlap');
    expect(dup?.outcome).toBe('pass_with_tolerance');
  });

  it('ROLL-FORWARD FAIL: an existing opening snapshot that does not reconcile to the statement\'s printed closing balance is a genuine FAIL — never masked', () => {
    const { ctx, candidates } = buildContext({
      existingSnapshots: new Map([['acct-1:instr-1', { unitsScaled: BigInt(5000) * BigInt(10) ** BigInt(6), asOfDateIso: '2024-12-31' }]]), // a wildly wrong opening balance vs. the statement's 100.000-unit closing
    });
    const rule = buildInvestmentReconciliationRule(ctx);
    const results = rule({ runId: 'run-1', candidates });
    const rollForward = results.find((r) => r.ruleId.startsWith('ii_adapter_roll_forward:'));
    expect(rollForward?.outcome).toBe('fail');
  });

  it('CANONICAL CONFLICT: an existing account whose on-file currency disagrees with the statement\'s implied currency is a FAIL, never silently accepted', () => {
    const { ctx, candidates } = buildContext({ existingAccountCurrency: new Map([['acct-1', 'AUD']]) }); // statement implies INR (countryCode 'IN'), account is on file as AUD
    const rule = buildInvestmentReconciliationRule(ctx);
    const results = rule({ runId: 'run-1', candidates });
    const conflict = results.find((r) => r.ruleId.startsWith('ii_adapter_canonical_conflict:'));
    expect(conflict?.outcome).toBe('fail');
  });

  it('ADVERSARIAL: an ambiguous account match makes the position genuinely INDETERMINATE, never a plausible-default guess (P4)', () => {
    const ambiguousExisting: ExistingAccountForMatching[] = [
      { id: 'acct-a', folioNumber: '9999999999', institutionName: 'Real AMC One' },
      { id: 'acct-b', folioNumber: '9999999999', institutionName: 'Real AMC Two' },
    ];
    // Force an ambiguous account match by re-parsing a document whose own
    // fund-house line is the sentinel and whose folio collides with two
    // differently-named existing accounts (same construction as
    // aieIiAdapterMatching.test.ts's own ambiguous-account case).
    const ambiguousText = buildAieIiCasFixtureText({ folioNumber: '9999999999', amcName: 'Unknown AMC' });
    const ambiguousParsed = parseExtractedDocument(ambiguousText).parsed!;
    const ambiguousCandidates = toAieCandidates(ambiguousParsed);
    const accountMatches = matchAccountsReadOnly(ambiguousParsed, ambiguousExisting);
    expect(accountMatches.outcomes[0].kind).toBe('ambiguous');

    const ctx: InvestmentReconciliationContext = {
      sourceKey: 'cams',
      countryCode: 'IN',
      accountMatches,
      instrumentMatches: new Map(),
      existingFingerprints: new Set(),
      existingSnapshots: new Map(),
      existingTransactionsForPosition: new Map(),
      existingAccountCurrency: new Map(),
      config: DEFAULT_RECONCILIATION_CONFIG,
    };
    const rule = buildInvestmentReconciliationRule(ctx);
    const results = rule({ runId: 'run-1', candidates: ambiguousCandidates });
    const dup = results.find((r) => r.ruleId === 'ii_adapter_duplicate_overlap');
    expect(dup?.outcome).toBe('indeterminate');
  });

  it('a document with zero transaction/holding candidates reports not_applicable rather than fabricating a pass', () => {
    const ctx: InvestmentReconciliationContext = {
      sourceKey: 'cams',
      countryCode: 'IN',
      accountMatches: { plan: { assignments: [], resolveRowKey: () => '' }, outcomes: [], byKey: new Map() },
      instrumentMatches: new Map(),
      existingFingerprints: new Set(),
      existingSnapshots: new Map(),
      existingTransactionsForPosition: new Map(),
      existingAccountCurrency: new Map(),
      config: DEFAULT_RECONCILIATION_CONFIG,
    };
    const rule = buildInvestmentReconciliationRule(ctx);
    const results = rule({ runId: 'run-1', candidates: [{ fieldName: 'metadata', valueRaw: '{}', isNull: false, sourceMethod: 'deterministic' }] });
    expect(results).toEqual([{ ruleId: 'ii_adapter_no_candidates', ruleVersion: '1', outcome: 'not_applicable' }]);
  });
});
