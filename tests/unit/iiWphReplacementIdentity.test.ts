// Document2 (4) WP-H (F5/F6/F14) -- is a replacement copy plausibly the SAME logical statement? PURE rules (replacementIdentity.ts):
// every threshold and every reject / confirm / not-compared decision, the plain day-first wording, and reading a real parsed statement.
import { describe, expect, it } from 'vitest';
import {
  PERIOD_TOLERANCE_DAYS,
  compareStatementIdentity,
  describeCandidate,
  readCandidateIdentity,
  unconfirmedDifferences,
  unreadableCopyVerdict,
  type CandidateStatementIdentity,
  type RetainedStatementIdentity,
} from '@/lib/services/investment-intelligence/replacementIdentity';
import { buildWphCas, OTHER_FOLIO, PRIME_FOLIO_Q1 } from '../support/buildWphCasText';

const MEMBERS = [
  { id: 'm-asha', fullName: 'Asha Rao', relationship: 'self', isActive: true },
  { id: 'm-ravi', fullName: 'Ravi Rao', relationship: 'spouse', isActive: true },
];

function retained(over: Partial<RetainedStatementIdentity> = {}): RetainedStatementIdentity {
  return {
    sourceKey: 'cams',
    documentType: 'cas_statement',
    periodStart: '2025-01-01',
    periodEnd: '2025-03-31',
    asOf: '2025-03-31',
    folios: [{ folio: '1122334455', institutions: ['Prime Mutual Fund'] }],
    isins: ['INF999K01AB1'],
    owner: { kind: 'member', memberId: 'm-asha' },
    currency: 'INR',
    ...over,
  };
}
function candidate(over: Partial<CandidateStatementIdentity> = {}): CandidateStatementIdentity {
  return {
    sourceKey: 'cams',
    documentType: 'cas_statement',
    periodStart: '2025-01-01',
    periodEnd: '2025-03-31',
    asOf: '2025-03-31',
    folios: [{ folio: '1122334455', institutions: ['Prime Mutual Fund'] }],
    isins: ['INF999K01AB1'],
    holder: { holderName: 'Asha Rao', jointHolders: [], holdingModeRaw: null },
    transactionCount: 2,
    holdingCount: 1,
    ...over,
  };
}
const codes = (r: retainedArg, c: candidateArg, members = MEMBERS) => compareStatementIdentity(r, c, members).differences.map((d) => d.code);
type retainedArg = RetainedStatementIdentity;
type candidateArg = CandidateStatementIdentity;

describe('the same statement', () => {
  it('everything agrees -> match, with every signal listed as compared', () => {
    const v = compareStatementIdentity(retained(), candidate(), MEMBERS);
    expect(v.decision).toBe('match');
    expect(v.differences).toEqual([]);
    expect(v.comparedOn).toEqual(['fund house or registrar (provider)', 'type of statement', 'statement period', 'folio numbers', 'schemes (ISIN)', 'owner']);
    expect(v.notComparedOn).toEqual([]);
  });
  it('the period tolerance is exactly 3 days at each end (a registrar rolling over a weekend), and 4 days is a difference', () => {
    expect(PERIOD_TOLERANCE_DAYS).toBe(3);
    expect(codes(retained(), candidate({ periodEnd: '2025-03-28', asOf: '2025-03-28' }))).toEqual([]); // 3 days earlier
    expect(codes(retained(), candidate({ periodEnd: '2025-03-27', asOf: '2025-03-27' }))).toEqual(['period_differs']); // 4 days earlier
    expect(codes(retained(), candidate({ periodStart: '2025-01-04' }))).toEqual([]);
    expect(codes(retained(), candidate({ periodStart: '2025-01-05' }))).toEqual(['period_differs']);
  });
});

describe('period', () => {
  it('overlapping but materially different (extended by a month) -> needs confirmation, never a rejection', () => {
    const v = compareStatementIdentity(retained(), candidate({ periodEnd: '2025-04-30', asOf: '2025-04-30' }), MEMBERS);
    expect(v.decision).toBe('needs_confirmation');
    expect(v.differences).toEqual([expect.objectContaining({ code: 'period_differs', severity: 'confirm' })]);
  });
  it('no overlap at all -> rejected (a different statement, not a correction)', () => {
    const v = compareStatementIdentity(retained(), candidate({ periodStart: '2024-04-01', periodEnd: '2024-12-31', asOf: '2024-12-31' }), MEMBERS);
    expect(v.decision).toBe('rejected');
    expect(v.differences.map((d) => d.code)).toContain('period_no_overlap');
  });
  it('touching on a single day counts as overlap (the boundary is inclusive)', () => {
    expect(codes(retained(), candidate({ periodStart: '2025-03-31', periodEnd: '2025-06-30', asOf: '2025-06-30' }))).toEqual(['period_differs']);
    expect(codes(retained(), candidate({ periodStart: '2025-04-01', periodEnd: '2025-06-30', asOf: '2025-06-30' }))).toEqual(['period_no_overlap']);
  });
  it('the old statement kept NO period: it is reported as not compared (never as agreement) and the other signals decide', () => {
    const v = compareStatementIdentity(retained({ periodStart: null, periodEnd: null, asOf: null }), candidate(), MEMBERS);
    expect(v.decision).toBe('match');
    expect(v.notComparedOn).toEqual(['statement period (the old statement kept no record of it)']);
    expect(v.comparedOn).not.toContain('statement period');
  });
  it('only the as-of date was retained: it is compared against the copy period end with the same 3 day rule', () => {
    expect(codes(retained({ periodStart: null, periodEnd: null, asOf: '2025-03-31' }), candidate())).toEqual([]);
    expect(codes(retained({ periodStart: null, periodEnd: null, asOf: '2025-03-31' }), candidate({ periodStart: '2025-01-01', periodEnd: '2025-05-31', asOf: '2025-05-31' }))).toEqual(['as_of_differs']);
  });
  it('the copy prints no period or date at all while the old statement had one -> needs confirmation (cannot be checked)', () => {
    const v = compareStatementIdentity(retained(), candidate({ periodStart: null, periodEnd: null, asOf: null }), MEMBERS);
    expect(v.decision).toBe('needs_confirmation');
    expect(v.differences.map((d) => d.code)).toEqual(['period_missing_in_copy']);
  });
});

describe('provider and document type', () => {
  it('a different provider is rejected', () => {
    const v = compareStatementIdentity(retained(), candidate({ sourceKey: 'kfintech' }), MEMBERS);
    expect(v.decision).toBe('rejected');
    expect(v.differences[0].message).toMatch(/KFintech statement, but the statement it would replace is a CAMS statement/);
  });
  it('a different kind of statement is rejected', () => {
    const v = compareStatementIdentity(retained(), candidate({ documentType: 'cams_folio_details' }), MEMBERS);
    expect(v.decision).toBe('rejected');
    expect(v.differences[0].code).toBe('document_type_differs');
  });
  it('a provider the old statement never recorded is not compared (and is said so)', () => {
    const v = compareStatementIdentity(retained({ sourceKey: null, documentType: null }), candidate(), MEMBERS);
    expect(v.decision).toBe('match');
    expect(v.notComparedOn).toEqual(expect.arrayContaining(['fund house or registrar (the old statement kept no record of it)', 'type of statement (the old statement kept no record of it)']));
  });
});

describe('folios, fund houses and schemes', () => {
  it('no folio in common -> rejected, folio numbers are masked to their last four characters', () => {
    const v = compareStatementIdentity(retained(), candidate({ folios: [{ folio: '9988776655', institutions: ['Zenith Mutual Fund'] }] }), MEMBERS);
    expect(v.decision).toBe('rejected');
    const d = v.differences.find((x) => x.code === 'no_common_folio')!;
    expect(d.message).toContain('ending 6655');
    expect(d.message).toContain('ending 4455');
    expect(d.message).not.toContain('9988776655');
    expect(d.message).not.toContain('1122334455');
  });
  it('some folios shared, some missing or extra -> needs confirmation', () => {
    const r = retained({ folios: [{ folio: '1122334455', institutions: [] }, { folio: '2233445566', institutions: [] }] });
    const v = compareStatementIdentity(r, candidate({ folios: [{ folio: '1122334455', institutions: [] }, { folio: '3344556677', institutions: [] }] }), MEMBERS);
    expect(v.decision).toBe('needs_confirmation');
    expect(v.differences.map((d) => d.code)).toEqual(['folios_differ']);
    expect(v.differences[0].message).toMatch(/a folio of the old statement \(ending 5566\) is not in this copy, and this copy has a folio the old statement did not \(ending 6677\)/);
  });
  it('the same folio number under a different fund house is a different account -> needs confirmation; an unknown fund house is not a difference', () => {
    expect(codes(retained(), candidate({ folios: [{ folio: '1122334455', institutions: ['Zenith Mutual Fund'] }] }))).toEqual(['institution_differs']);
    expect(codes(retained(), candidate({ folios: [{ folio: '1122334455', institutions: ['Unknown AMC'] }] }))).toEqual([]);
    expect(codes(retained(), candidate({ folios: [{ folio: '1122334455', institutions: ['PRIME MUTUAL FUND.'] }] }))).toEqual([]); // punctuation / case only
  });
  it('no scheme (ISIN) in common -> needs confirmation; one in common is enough; an ISIN missing on either side is not compared', () => {
    expect(codes(retained(), candidate({ isins: ['INF888K01ZZ9'] }))).toEqual(['schemes_differ']);
    expect(codes(retained({ isins: ['INF999K01AB1', 'INF111K01CD2'] }), candidate({ isins: ['inf999k01ab1', 'INF222K01EF3'] }))).toEqual([]);
    const v = compareStatementIdentity(retained({ isins: [] }), candidate(), MEMBERS);
    expect(v.notComparedOn).toContain('schemes (ISIN not available on both sides)');
  });
});

describe('owner', () => {
  it('the printed holder is exactly a DIFFERENT household member -> rejected (K.7: never silently re-filed)', () => {
    const v = compareStatementIdentity(retained(), candidate({ holder: { holderName: 'Ravi Rao', jointHolders: [], holdingModeRaw: 'SI' } }), MEMBERS);
    expect(v.decision).toBe('rejected');
    expect(v.differences[0].code).toBe('owner_belongs_to_other_member');
    expect(v.differences[0].message).toContain('R*** R**'); // masked, never the raw name
    expect(v.differences[0].message).not.toContain('Ravi');
  });
  it('a holder name that matches nobody in the household -> needs confirmation (names are noisy), never a silent pass', () => {
    const v = compareStatementIdentity(retained(), candidate({ holder: { holderName: 'A B Rao', jointHolders: [], holdingModeRaw: null } }), MEMBERS);
    expect(v.decision).toBe('needs_confirmation');
    expect(v.differences.map((d) => d.code)).toEqual(['owner_name_differs']);
  });
  it('no holder printed, a joint holding, or an old statement without a single-member owner -> not compared', () => {
    expect(compareStatementIdentity(retained(), candidate({ holder: { holderName: null, jointHolders: [], holdingModeRaw: null } }), MEMBERS).notComparedOn).toContain('owner (this copy prints no holder name)');
    expect(compareStatementIdentity(retained(), candidate({ holder: { holderName: 'Asha Rao', jointHolders: ['Ravi Rao'], holdingModeRaw: 'JO' } }), MEMBERS).decision).toBe('match');
    expect(compareStatementIdentity(retained({ owner: { kind: 'none' } }), candidate({ holder: { holderName: 'Ravi Rao', jointHolders: [], holdingModeRaw: null } }), MEMBERS).decision).toBe('match');
    expect(compareStatementIdentity(retained({ owner: { kind: 'not_a_single_member' } }), candidate(), MEMBERS).notComparedOn.join(' ')).toMatch(/held jointly or by an entity/);
  });
});

describe('nothing retained at all', () => {
  const nothing = retained({ sourceKey: null, documentType: null, periodStart: null, periodEnd: null, asOf: null, folios: [], isins: [], owner: { kind: 'none' } });
  it('the old statement was never read: nothing to compare, so the person must confirm what the copy actually is', () => {
    const v = compareStatementIdentity(nothing, candidate(), MEMBERS);
    expect(v.decision).toBe('needs_confirmation');
    expect(v.differences.map((d) => d.code)).toEqual(['nothing_retained_to_compare']);
    expect(v.candidateSummary).toBe('This file is a CAMS consolidated account statement covering 01-01-2025 to 31-03-2025, with 1 folio (ending 4455).');
  });
  it('only folios retained: compared on folios alone and the rest is listed as not compared', () => {
    const v = compareStatementIdentity({ ...nothing, folios: [{ folio: '1122334455', institutions: [] }] }, candidate(), MEMBERS);
    expect(v.decision).toBe('match');
    expect(v.comparedOn).toEqual(['folio numbers']);
    expect(v.notComparedOn.length).toBeGreaterThanOrEqual(4);
  });
});

describe('an unreadable copy', () => {
  it('the old statement was read successfully before -> a file we cannot read cannot replace it (rejected)', () => {
    const v = unreadableCopyVerdict(retained(), 'unrecognised_format');
    expect(v.decision).toBe('rejected');
    expect(v.differences[0]).toMatchObject({ code: 'unreadable_copy', severity: 'reject' });
  });
  it('the old statement was never recognised either -> the person decides (needs confirmation)', () => {
    const v = unreadableCopyVerdict(retained({ sourceKey: null }), 'insufficient_text');
    expect(v.decision).toBe('needs_confirmation');
    expect(v.differences[0].message).toMatch(/no readable text/);
  });
});

describe('confirmation: only a confirmable difference can ever be confirmed', () => {
  const extended = () => compareStatementIdentity(retained(), candidate({ periodEnd: '2025-04-30', asOf: '2025-04-30' }), MEMBERS);
  const wrongFund = () => compareStatementIdentity(retained(), candidate({ sourceKey: 'kfintech', periodEnd: '2025-04-30' }), MEMBERS);
  it('unconfirmed -> listed; confirmed by code -> none left', () => {
    expect(unconfirmedDifferences(extended(), []).map((d) => d.code)).toEqual(['period_differs']);
    expect(unconfirmedDifferences(extended(), ['period_differs'])).toEqual([]);
    expect(unconfirmedDifferences(extended(), ['something_else']).map((d) => d.code)).toEqual(['period_differs']);
  });
  it('a rejection can NEVER be confirmed: listing its code (or every code) changes nothing', () => {
    const v = wrongFund();
    expect(v.decision).toBe('rejected');
    expect(unconfirmedDifferences(v, ['provider_differs', 'period_differs']).map((d) => d.code)).toEqual(['provider_differs']);
  });
});

describe('wording: plain, day-first, no internal labels', () => {
  const messages = (cur: 'INR' | 'AUD') =>
    [
      compareStatementIdentity(retained({ currency: cur }), candidate({ periodStart: '2024-01-01', periodEnd: '2024-03-31', asOf: '2024-03-31' }), MEMBERS),
      compareStatementIdentity(retained({ currency: cur }), candidate({ periodEnd: '2025-04-30', asOf: '2025-04-30' }), MEMBERS),
      compareStatementIdentity(retained({ currency: cur }), candidate({ periodStart: null, periodEnd: null, asOf: null }), MEMBERS),
    ].flatMap((v) => [...v.differences.map((d) => d.message), v.candidateSummary]);
  it('India: dd-mm-yyyy', () => {
    expect(messages('INR').join(' ')).toMatch(/01-01-2024 to 31-03-2024/);
    expect(messages('INR').join(' ')).toMatch(/01-01-2025 to 31-03-2025/);
  });
  it('Australia: dd/mm/yyyy', () => {
    expect(messages('AUD').join(' ')).toMatch(/01\/01\/2024 to 31\/03\/2024/);
  });
  it('never an ISO date, an internal code or the word null / undefined', () => {
    for (const cur of ['INR', 'AUD'] as const) {
      const all = messages(cur).join(' ');
      expect(all).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
      expect(all).not.toMatch(/\b(null|undefined|data_currency|period_differs|cas_statement)\b/);
    }
  });
});

describe('reading a real parsed statement (the same parsers the process route uses; nothing is written)', () => {
  const asCsv = (text: string) => ({ bytes: new TextEncoder().encode(text), mimeType: 'text/csv' });
  it('reads provider, type, period, folios with fund house, ISINs, holder and counts', async () => {
    const r = await readCandidateIdentity(asCsv(buildWphCas({ periodStart: '01-Jan-2025', periodEnd: '31-Mar-2025', folios: [PRIME_FOLIO_Q1, OTHER_FOLIO] })));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.identity).toMatchObject({ sourceKey: 'cams', documentType: 'cas_statement', periodStart: '2025-01-01', periodEnd: '2025-03-31', asOf: '2025-03-31', transactionCount: 3, holdingCount: 2 });
    expect(r.identity.folios.map((f) => f.folio).sort()).toEqual(['1122334455', '9988776655']);
    expect(r.identity.folios.find((f) => f.folio === '1122334455')?.institutions).toEqual(['Prime Mutual Fund']);
    expect(r.identity.isins.sort()).toEqual(['INF888K01ZZ9', 'INF999K01AB1']);
    expect(r.identity.holder.holderName).toBe('Asha Rao');
    expect(describeCandidate(r.identity, 'INR')).toBe('This file is a CAMS consolidated account statement covering 01-01-2025 to 31-03-2025, with 2 folios (ending 4455, ending 6655).');
  });
  it('a document that is not a statement is unreadable (not a guess)', async () => {
    const r = await readCandidateIdentity(asCsv('Certificate of Insurance\nPolicy Number: XYZ-000-111\nThis is not a statement.'));
    expect(r).toEqual({ kind: 'unreadable', reason: 'unrecognised_format' });
  });
});
