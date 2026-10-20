/**
 * Document2 (4) F25 -- which destination does the payslip's employer super line name?
 * PO: "SMSF if the fund/member evidence matches an SMSF, another retirement fund if it matches, otherwise ask the user to choose.
 * Never a weak fuzzy match." Evidence label: UNIT-TESTED (pure).
 */
import { describe, expect, it } from 'vitest';
import { distinctiveWords, routePayslipContribution, type DestinationCandidate } from '@/lib/retirement-contributions/routing';
import { classifyPayslipLabel } from '@/lib/financial-data-hub/payslip/labels';

const smsf = (name: string, over: Partial<DestinationCandidate> = {}): DestinationCandidate => ({ accountId: 'acc-smsf', kind: 'smsf', name, ownerRole: 'self', memberId: 'm-self', currency: 'AUD', fundId: 'f1', ...over });
const fund = (id: string, name: string, over: Partial<DestinationCandidate> = {}): DestinationCandidate => ({ accountId: id, kind: 'retirement_account', name, ownerRole: 'self', memberId: 'm-self', currency: 'AUD', ...over });
const PO_LINE = 'SGC Employer Cont. THE TRUSTEE FOR THE BEKAL SUPER FUND';
const route = (labels: string[], candidates: DestinationCandidate[], over: Record<string, unknown> = {}) =>
  routePayslipContribution({ contributionLabels: labels, employerName: 'AUSTRALIAN UNITY GROUP SERVICE P/L', payslipOwner: 'self', candidates, ...over });

describe('the PO payslip line', () => {
  it('is now read as an employer super line (it fell through to "For information" before)', () => {
    expect(classifyPayslipLabel(PO_LINE, 'AU')).toEqual({ side: 'employer_contribution', type: 'employer_retirement' });
    // not the total line, not the employee side
    expect(classifyPayslipLabel('Total Contributions', 'AU')).toBeUndefined();
    expect(classifyPayslipLabel('Voluntary Super', 'AU')?.type).toBe('employee_retirement');
  });

  it('routes to the SMSF whose fund name matches the line', () => {
    const r = route([PO_LINE], [smsf('Bekal Super Fund'), fund('acc-aus', 'AustralianSuper Industry')]);
    expect(r.kind).toBe('matched');
    if (r.kind === 'matched') {
      expect(r.candidate.kind).toBe('smsf');
      expect(r.matchedWords).toEqual(['bekal']);
    }
  });

  it('routes to another retirement fund when THAT fund matches', () => {
    const r = route(['Employer Super Guarantee HOSTPLUS'], [smsf('Bekal Super Fund'), fund('acc-host', 'Hostplus Industry Super')]);
    expect(r.kind).toBe('matched');
    if (r.kind === 'matched') expect(r.candidate.accountId).toBe('acc-host');
  });
});

describe('never a weak match -- the person is asked', () => {
  it('no destination names the fund: ask, with the person\'s own choices', () => {
    const r = route([PO_LINE], [fund('a', 'Rest Super'), fund('b', 'Hostplus')]);
    expect(r.kind).toBe('ask');
    if (r.kind === 'ask') { expect(r.reason).toBe('no_name_match'); expect(r.choices).toHaveLength(2); }
  });

  it('[NC] one near-miss spelling is NOT a match (no fuzzy matching): "Bekaly" or "Bekel" never route to "Bekal"', () => {
    for (const name of ['Bekaly Super Fund', 'Bekel Family Fund', 'Bek Super']) {
      expect(route([PO_LINE], [smsf(name)]).kind).toBe('ask');
    }
  });

  it('[NC] a word inside another word is not a match ("bek" inside "bekal")', () => {
    expect(route(['SGC Employer Cont. BEKALSUPER'], [smsf('Bekal Super Fund')]).kind).toBe('ask');
  });

  it('two accounts matching the same line: ask (ambiguous), never the first', () => {
    const r = route([PO_LINE], [smsf('Bekal Super Fund'), fund('b', 'Bekal Retirement Savings')]);
    expect(r.kind).toBe('ask');
    if (r.kind === 'ask') { expect(r.reason).toBe('ambiguous'); expect(r.tied).toHaveLength(2); }
  });

  it('a line that names no fund at all asks, even with exactly one retirement account (no "only fund" default)', () => {
    const r = route(['Superannuation Guarantee'], [fund('only', 'Industry Super')]);
    expect(r.kind).toBe('ask');
    if (r.kind === 'ask') expect(r.reason).toBe('no_fund_evidence_on_payslip');
  });

  it('an employer whose name shares a word with the fund does not route on the employer name alone', () => {
    const r = routePayslipContribution({ contributionLabels: ['SGC Employer Cont. Bekal Pty Ltd'], employerName: 'Bekal Pty Ltd', payslipOwner: 'self', candidates: [smsf('Bekal Super Fund')] });
    expect(r.kind).toBe('ask');
  });

  it('a fund whose name is only generic words can never be matched by name', () => {
    expect(distinctiveWords('Industry Super')).toEqual([]);
    expect(route(['Employer super Industry Super fund'], [fund('g', 'Industry Super')]).kind).toBe('ask');
  });

  it('"The Trustee for" alone is not evidence of an SMSF', () => {
    expect(route(['SGC Employer Cont. THE TRUSTEE FOR THE UNKNOWN FUND'], [smsf('Bekal Super Fund')]).kind).toBe('ask');
  });

  it('a Spouse\'s payslip never routes to the Self\'s account, and a joint account is allowed', () => {
    const selfOnly = route([PO_LINE], [smsf('Bekal Super Fund', { ownerRole: 'self' })], { payslipOwner: 'spouse' });
    expect(selfOnly.kind).toBe('ask');
    if (selfOnly.kind === 'ask') expect(selfOnly.reason).toBe('no_destinations');
    expect(route([PO_LINE], [smsf('Bekal Super Fund', { ownerRole: 'joint' })], { payslipOwner: 'spouse' }).kind).toBe('matched');
  });

  it('no destinations at all: ask with the plain reason', () => {
    const r = route([PO_LINE], []);
    expect(r.kind === 'ask' && r.reason).toBe('no_destinations');
  });
});
