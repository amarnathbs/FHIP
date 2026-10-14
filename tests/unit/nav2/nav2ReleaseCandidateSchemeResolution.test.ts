// NAV2 release candidate, blocker B4: NAV2-F1 changes how EVERY user's statement is matched to a fund. This proves the change separately, on its own,
// so that if it ever had to be shipped apart from NAV2 it could be.
//
// Evidence level: UNIT-TESTED (the pure resolver, exhaustively over identifier combinations, plus source contracts for the caller). The behaviour through
// the real upload, parse, review and accept path is DEV-VERIFIED by scripts/nav2_rc/dev_wrong_pair.mjs (exactly one case, idempotent re-processing, no
// transaction stored on a guess); the monitoring counter is PGLITE-VERIFIED in nav2ReleaseCandidateMigrations.test.ts (0282).
//
// NAMED NEGATIVE CONTROLS
//   NC-S1  ISIN and AMFI code of ONE fund: resolved, by ISIN, exactly as before this change (ordinary statements are unaffected);
//   NC-S2  the ISIN of fund D and the AMFI code of fund R (a Direct and a Regular plan of one scheme): AMBIGUOUS with both as candidates and a reason
//          that names the disagreement; neither is chosen, in either list order, so no plan is silently preferred;
//   NC-S3  an exhaustive sweep of every ISIN / AMFI / stored-identifier combination over three funds: the outcome is ambiguous exactly when the two
//          identifiers point at different funds, and resolved otherwise, never to the AMFI fund when the ISIN names another;
//   NC-S4  CONTROL: the previous rule (ISIN wins) is reproduced from the old code and shown to resolve the conflict silently, which is the defect;
//   NC-S5  the caller opens ONE case per distinct scheme per document and stores no transaction for the unresolved key; the case carries the reason that
//          the monitoring counter (0282) counts.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveScheme, type ExistingInstrumentForResolution, type SchemeResolutionQuery } from '@/lib/services/investment-intelligence/schemeResolution';

const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'; // Alpha Flexi Cap, Direct, Growth
const R = 'rrrrrrrr-rrrr-4rrr-8rrr-rrrrrrrrrrrr'; // Alpha Flexi Cap, Regular, Growth
const O = 'oooooooo-oooo-4ooo-8ooo-oooooooooooo'; // an unrelated fund
const inst = (id: string, isin: string | null, amfi: string | null, plan: 'direct' | 'regular', country = 'IN'): ExistingInstrumentForResolution => ({
  instrumentId: id, isin, amfiSchemeCode: amfi, internalProvisionalCode: null, normalisedSchemeName: `alpha flexi cap ${plan}`, amcName: 'Alpha AMC', planType: plan, optionType: 'growth', countryCode: country,
});
const EXISTING = [inst(D, 'INF000A01DIR', '100001', 'direct'), inst(R, 'INF000A01REG', '100002', 'regular'), inst(O, 'INF000B01OTH', '200001', 'direct')];
const q = (isin: string | null, amfi: string | null, over: Partial<SchemeResolutionQuery> = {}): SchemeResolutionQuery => ({
  isin, amfiSchemeCode: amfi, internalProvisionalCode: null, normalisedSchemeName: 'alpha flexi cap direct', amcName: 'Alpha AMC', planType: 'direct', optionType: 'growth', countryCode: 'IN', ...over,
});

describe('NC-S1: ordinary statements are unaffected', () => {
  it('ISIN and AMFI code of the same fund resolve by ISIN with full confidence', () => {
    expect(resolveScheme(q('INF000A01DIR', '100001'), EXISTING, [])).toEqual({ kind: 'resolved', instrumentId: D, matchedVia: 'isin', confidence: 1 });
  });
  it('ISIN alone, and AMFI code alone, resolve as before', () => {
    expect(resolveScheme(q('INF000A01REG', null), EXISTING, [])).toMatchObject({ kind: 'resolved', instrumentId: R, matchedVia: 'isin' });
    expect(resolveScheme(q(null, '100002'), EXISTING, [])).toMatchObject({ kind: 'resolved', instrumentId: R, matchedVia: 'amfi_scheme_code' });
  });
  it('a fund whose stored record has no AMFI code, or whose AMFI code is on no other fund, still resolves by ISIN (no false conflict)', () => {
    const noAmfi = [inst(D, 'INF000A01DIR', null, 'direct'), inst(R, 'INF000A01REG', '100002', 'regular')];
    expect(resolveScheme(q('INF000A01DIR', '100001'), noAmfi, [])).toMatchObject({ kind: 'resolved', instrumentId: D });
    expect(resolveScheme(q('INF000A01DIR', '999999'), EXISTING, [])).toMatchObject({ kind: 'resolved', instrumentId: D }); // an AMFI code nobody holds is not a conflict
  });
  it('the AMFI match is country scoped: a code that belongs to a fund in another country is not a conflict', () => {
    const au = [...EXISTING, inst('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', null, '300001', 'direct', 'AU')];
    expect(resolveScheme(q('INF000A01DIR', '300001'), au, [])).toMatchObject({ kind: 'resolved', instrumentId: D });
  });
});

describe('NC-S2: ISIN of one plan, AMFI code of another', () => {
  it('is ambiguous with both candidates, a reason that names the disagreement, and no chosen fund', () => {
    const r = resolveScheme(q('INF000A01DIR', '100002'), EXISTING, []);
    expect(r.kind).toBe('ambiguous');
    if (r.kind !== 'ambiguous') return;
    expect([...r.candidateInstrumentIds].sort()).toEqual([D, R].sort());
    expect(r.reason).toMatch(/point at different instruments/);
    expect(r.reason).toContain('INF000A01DIR');
    expect(r.reason).toContain('100002');
    expect('instrumentId' in r).toBe(false);
  });
  it('the answer does not depend on the order of the stored instruments (neither plan is silently preferred)', () => {
    const forward = resolveScheme(q('INF000A01DIR', '100002'), EXISTING, []);
    const reversed = resolveScheme(q('INF000A01DIR', '100002'), [...EXISTING].reverse(), []);
    expect(forward.kind).toBe('ambiguous');
    expect(reversed.kind).toBe('ambiguous');
    if (forward.kind === 'ambiguous' && reversed.kind === 'ambiguous') expect([...forward.candidateInstrumentIds].sort()).toEqual([...reversed.candidateInstrumentIds].sort());
  });
  it('is deterministic and has no state: the same input a hundred times gives one and the same answer', () => {
    const first = JSON.stringify(resolveScheme(q('INF000A01DIR', '100002'), EXISTING, []));
    for (let i = 0; i < 100; i++) expect(JSON.stringify(resolveScheme(q('INF000A01DIR', '100002'), EXISTING, []))).toBe(first);
  });
  it('the name path cannot rescue it: the plan and name of the statement line do not decide the conflict', () => {
    const asRegular = resolveScheme(q('INF000A01DIR', '100002', { planType: 'regular', normalisedSchemeName: 'alpha flexi cap regular' }), EXISTING, []);
    const asDirect = resolveScheme(q('INF000A01DIR', '100002', { planType: 'direct', normalisedSchemeName: 'alpha flexi cap direct' }), EXISTING, []);
    expect(asRegular.kind).toBe('ambiguous');
    expect(asDirect.kind).toBe('ambiguous');
  });
  it('two stored instruments sharing the AMFI code (one of them the ISIN fund) is also a refusal, not a silent pick', () => {
    const dup = [...EXISTING, inst('cccccccc-cccc-4ccc-8ccc-cccccccccccc', null, '100001', 'direct')];
    expect(resolveScheme(q('INF000A01DIR', '100001'), dup, []).kind).toBe('ambiguous');
  });
});

describe('NC-S3: the sweep', () => {
  const isins: Array<[string | null, string | null]> = [[null, null], ['INF000A01DIR', D], ['INF000A01REG', R], ['INF000B01OTH', O], ['INF000ZZZZZZ', null]];
  const amfis: Array<[string | null, string | null]> = [[null, null], ['100001', D], ['100002', R], ['200001', O], ['999999', null]];
  it('ambiguous exactly when both identifiers name different stored funds; otherwise resolved or unresolved as before; never the AMFI fund when the ISIN names another', () => {
    let ambiguous = 0;
    let resolved = 0;
    for (const [isin, isinFund] of isins) {
      for (const [amfi, amfiFund] of amfis) {
        const r = resolveScheme(q(isin, amfi, { normalisedSchemeName: 'no such name' }), EXISTING, []);
        const conflict = isinFund !== null && amfiFund !== null && isinFund !== amfiFund;
        if (conflict) {
          expect(r.kind, `${isin} / ${amfi}`).toBe('ambiguous');
          ambiguous++;
        } else if (isinFund) {
          expect(r).toMatchObject({ kind: 'resolved', instrumentId: isinFund, matchedVia: 'isin' });
          resolved++;
        } else if (amfiFund) {
          expect(r).toMatchObject({ kind: 'resolved', instrumentId: amfiFund, matchedVia: 'amfi_scheme_code' });
          resolved++;
        } else {
          expect(r.kind, `${isin} / ${amfi}`).toBe('unresolved');
        }
        if (r.kind === 'resolved' && isinFund && amfiFund && isinFund !== amfiFund) throw new Error('resolved on a conflict');
      }
    }
    expect(ambiguous).toBe(6); // 3 stored ISINs x 2 other stored AMFI codes
    expect(resolved).toBeGreaterThan(10);
  });
});

describe('NC-S4: the old rule (control)', () => {
  /** The ISIN step exactly as it was before NAV2-F1: a single ISIN match wins, whatever the AMFI code says. */
  function oldResolve(query: SchemeResolutionQuery, existing: ExistingInstrumentForResolution[]) {
    const matches = [...new Set(existing.filter((e) => e.isin && e.isin.toUpperCase() === query.isin!.toUpperCase()).map((e) => e.instrumentId))];
    return matches.length === 1 ? { kind: 'resolved' as const, instrumentId: matches[0] } : { kind: 'other' as const };
  }
  it('the old rule resolved the conflicting line silently to the ISIN fund; the new rule does not', () => {
    expect(oldResolve(q('INF000A01DIR', '100002'), EXISTING)).toEqual({ kind: 'resolved', instrumentId: D });
    expect(resolveScheme(q('INF000A01DIR', '100002'), EXISTING, []).kind).toBe('ambiguous');
  });
  it('the source still contains the fail-closed check (a removed check would be caught by NC-S2 above, and here by name)', () => {
    const src = readFileSync(path.resolve(__dirname, '..', '..', '..', 'lib', 'services', 'investment-intelligence', 'schemeResolution.ts'), 'utf8');
    expect(src).toContain('point at different instruments');
    expect(src).toContain("kind: 'ambiguous'");
  });
});

describe('NC-S5: the caller', () => {
  const src = readFileSync(path.resolve(__dirname, '..', '..', '..', 'lib', 'services', 'investment-intelligence', 'documentProcessing.ts'), 'utf8');
  const block = src.slice(src.indexOf("if (outcome.kind === 'ambiguous') {"), src.indexOf('// unresolved — create a new provisional instrument'));
  it('an ambiguous scheme marks its key unresolved (no transaction is stored for it), opens one case, and records the reason that the monitoring counter counts', () => {
    expect(block).toContain('instrumentUnresolvedKeys.add(key)');
    expect(block).not.toContain('instrumentIdByKey.set');
    expect(block).toContain("discrepancyType: 'ambiguous_instrument'");
    expect(block).toContain('reason: outcome.reason');
    expect((block.match(/openReconciliationCase\(/g) ?? []).length).toBe(1);
  });
  it('the loop is over DISTINCT schemes of the document (one case per scheme per document, not per line)', () => {
    expect(src).toMatch(/for \(const \[key, scheme\] of uniqueSchemes\)/);
  });
  it('an earlier explicit user resolution of exactly this scheme identity wins before the resolver runs, so a decided case never reopens', () => {
    const i = src.indexOf('findResolvedAmbiguousInstrumentOverride(admin, userId, signature)');
    const j = src.indexOf('const outcome = resolveScheme(');
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(j);
  });
});
