import { describe, it, expect } from 'vitest';
import { matchAccountsReadOnly, type ExistingAccountForMatching } from '@/lib/aie/adapters/investment-intelligence/accountMatching';
import { matchInstrumentsReadOnly, schemeKey } from '@/lib/aie/adapters/investment-intelligence/instrumentMatching';
import { checkStatementPeriod } from '@/lib/aie/adapters/investment-intelligence/statementMatching';
import {
  unresolvedItemsForAccountMatches,
  unresolvedItemForOwnerUnresolved,
  unresolvedItemsForInstrumentMatches,
  unresolvedItemForStatementPeriod,
} from '@/lib/aie/adapters/investment-intelligence/unresolvedItems';
import { parseExtractedDocument } from '@/lib/services/investment-intelligence/parsers/registry';
import type { ExistingInstrumentForResolution } from '@/lib/services/investment-intelligence/schemeResolution';
import { buildAieIiCasFixtureText } from '../support/buildAieIiCasFixtureText';

describe('AIE-1.2 — conservative account matching (execution sequence step 7)', () => {
  it('POSITIVE: an existing account with matching institution + folio resolves, never re-created', () => {
    const parsed = parseExtractedDocument(buildAieIiCasFixtureText()).parsed!;
    const existing: ExistingAccountForMatching[] = [{ id: 'acct-1', folioNumber: '1122334455', institutionName: 'Prime Mutual Fund' }];
    const result = matchAccountsReadOnly(parsed, existing);
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]).toMatchObject({ kind: 'resolved', accountId: 'acct-1' });
    expect(unresolvedItemsForAccountMatches(result.outcomes)).toEqual([]);
  });

  it('a genuinely first-seen folio is reported as a candidate, NOT an unresolved item (first import is expected, not an error)', () => {
    const parsed = parseExtractedDocument(buildAieIiCasFixtureText()).parsed!;
    const result = matchAccountsReadOnly(parsed, []);
    expect(result.outcomes[0].kind).toBe('new_account_candidate');
    expect(unresolvedItemsForAccountMatches(result.outcomes)).toEqual([]);
  });

  it('ADVERSARIAL: an AMC-blind import matching a folio that already has TWO different real-institution accounts on file is a blocking unresolved item, never silently guessed', () => {
    // Mirrors resolveOrCreateAccount's own documented ambiguity branch
    // exactly: this import supplies NO real AMC evidence (its fund-house
    // line is the literal sentinel string, so planFolioAccountResolution's
    // assignment.amcName comes out equal to UNKNOWN_AMC_SENTINEL), and the
    // same folio number is already on file under two DIFFERENT real
    // institution names — a human, not a guess, must decide which one this
    // statement belongs to.
    const existing: ExistingAccountForMatching[] = [
      { id: 'acct-a', folioNumber: '5500660077', institutionName: 'Real AMC One' },
      { id: 'acct-b', folioNumber: '5500660077', institutionName: 'Real AMC Two' },
    ];
    const parsed = parseExtractedDocument(
      buildAieIiCasFixtureText({ folioNumber: '5500660077', amcName: 'Unknown AMC', schemeName: 'Some Fund - Growth' }),
    ).parsed!;
    const result = matchAccountsReadOnly(parsed, existing);
    expect(result.outcomes[0].kind).toBe('ambiguous');
    const items = unresolvedItemsForAccountMatches(result.outcomes);
    expect(items).toHaveLength(1);
    expect(items[0].reasonCode).toBe('ii_adapter:ambiguous_account');
    expect(items[0].severity).toBe('blocking');
  });

  it('owner-unresolved is reported only when at least one account actually matched', () => {
    expect(unresolvedItemForOwnerUnresolved(false)).toEqual([]);
    expect(unresolvedItemForOwnerUnresolved(true)).toHaveLength(1);
    expect(unresolvedItemForOwnerUnresolved(true)[0].reasonCode).toBe('ii_adapter:owner_unresolved');
  });
});

describe('AIE-1.2 — conservative instrument matching (execution sequence step 7)', () => {
  const scheme = {
    rawSchemeName: 'Prime Flexi Cap Fund - Growth (Direct Plan)',
    normalisedSchemeName: 'prime flexi cap fund growth',
    amcName: 'Prime Mutual Fund',
    planType: 'direct' as const,
    optionType: 'growth' as const,
    isin: 'INF999K01AB1',
    amfiSchemeCode: null,
  };

  it('POSITIVE: an existing instrument with a matching ISIN resolves', () => {
    const existing: ExistingInstrumentForResolution[] = [
      { instrumentId: 'instr-1', isin: 'INF999K01AB1', amfiSchemeCode: null, internalProvisionalCode: null, normalisedSchemeName: 'prime flexi cap fund growth', amcName: 'Prime Mutual Fund', planType: 'direct', optionType: 'growth', countryCode: 'IN' },
    ];
    const outcomes = matchInstrumentsReadOnly([scheme], 'IN', existing, []);
    const key = `${scheme.normalisedSchemeName}|${scheme.planType}|${scheme.optionType}|${scheme.amcName}`;
    expect(outcomes.get(key)).toMatchObject({ kind: 'resolved', instrumentId: 'instr-1', matchedVia: 'isin' });
    expect(unresolvedItemsForInstrumentMatches(outcomes)).toEqual([]);
  });

  it('a genuinely unseen scheme is "unresolved" (would create provisional), NOT an unresolved item', () => {
    const outcomes = matchInstrumentsReadOnly([scheme], 'IN', [], []);
    const key = schemeKey(scheme);
    expect(outcomes.get(key)!.kind).toBe('unresolved');
    expect(unresolvedItemsForInstrumentMatches(outcomes)).toEqual([]);
  });

  it('ADVERSARIAL: two existing instruments sharing the same ISIN is ambiguous — a typed blocking unresolved item, never a guess', () => {
    const existing: ExistingInstrumentForResolution[] = [
      { instrumentId: 'instr-1', isin: 'INF999K01AB1', amfiSchemeCode: null, internalProvisionalCode: null, normalisedSchemeName: 'x', amcName: null, planType: null, optionType: null, countryCode: 'IN' },
      { instrumentId: 'instr-2', isin: 'INF999K01AB1', amfiSchemeCode: null, internalProvisionalCode: null, normalisedSchemeName: 'y', amcName: null, planType: null, optionType: null, countryCode: 'IN' },
    ];
    const outcomes = matchInstrumentsReadOnly([scheme], 'IN', existing, []);
    const key = schemeKey(scheme);
    expect(outcomes.get(key)!.kind).toBe('ambiguous');
    const items = unresolvedItemsForInstrumentMatches(outcomes);
    expect(items).toHaveLength(1);
    expect(items[0].severity).toBe('blocking');
    expect(items[0].reasonCode).toBe('ii_adapter:ambiguous_instrument');
  });
});

describe('AIE-1.2 — statement-period matching', () => {
  it('POSITIVE: a complete, well-ordered period passes', () => {
    expect(checkStatementPeriod({ statementPeriodStartIso: '2025-01-01', statementPeriodEndIso: '2025-03-31', statementAsOfDateIso: '2025-03-31' }).ok).toBe(true);
    expect(unresolvedItemForStatementPeriod({ ok: true })).toEqual([]);
  });

  it('a "since inception" statement (no explicit start/end) is NOT treated as invalid', () => {
    expect(checkStatementPeriod({ statementPeriodStartIso: null, statementPeriodEndIso: null, statementAsOfDateIso: '2025-03-31' }).ok).toBe(true);
  });

  it('NEGATIVE: a missing as-of date is a blocking unresolved item, never guessed', () => {
    const check = checkStatementPeriod({ statementPeriodStartIso: null, statementPeriodEndIso: null, statementAsOfDateIso: null });
    expect(check.ok).toBe(false);
    expect(check.reasonCode).toBe('statement_as_of_date_missing');
    const items = unresolvedItemForStatementPeriod(check);
    expect(items).toHaveLength(1);
    expect(items[0].severity).toBe('blocking');
  });

  it('ADVERSARIAL: an end date before the start date is invalid, never silently accepted', () => {
    const check = checkStatementPeriod({ statementPeriodStartIso: '2025-03-31', statementPeriodEndIso: '2025-01-01', statementAsOfDateIso: '2025-03-31' });
    expect(check.ok).toBe(false);
    expect(check.reasonCode).toBe('statement_period_invalid_order');
  });
});
