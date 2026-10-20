/**
 * Document2 (4) F25b -- manual retirement BALANCE entry and manual CONTRIBUTION entry are distinct actions, never combined.
 * Evidence label: UNIT-TESTED (real config, real schemas, real route validation, real markup via react-dom/server).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/ui/DateInput', () => ({ DateInput: (p: { id?: string }) => createElement('input', { id: p.id }) }));

import { retirementGridConfig } from '@/lib/grid/configs';
import { catalogPickerItems } from '@/components/grid/FinancialDataGrid';
import { retirementSchema, retirementPatchSchema } from '@/lib/validation/retirement';
import { manualContributionSchema } from '@/lib/validation/retirementContribution';
import { RetirementContributionsView, amountText, sourceText, type HistoryItemView } from '@/components/retirement/RetirementContributionsPanel';

const ACC = '11111111-1111-4111-8111-111111111111';

describe('the balance form holds a balance only', () => {
  it('the retirement account form has no contribution amount or frequency field any more', () => {
    const names = retirementGridConfig.fields.map((f) => f.name);
    expect(names).toContain('current_balance');
    for (const n of ['employer_contribution', 'personal_contribution', 'contribution_frequency']) expect(names).not.toContain(n);
  });

  it('[NC] the contribution flows are not offered as a NEW balance row ("contribution amount, not a balance")', () => {
    const rows = [
      { key: 'industry_super', is_custom: false, included: false },
      { key: 'employer_contributions', is_custom: false, included: false },
      { key: 'salary_sacrifice', is_custom: false, included: false },
      { key: 'spouse_contribution', is_custom: false, included: false },
      { key: 'government_co_contribution', is_custom: false, included: false },
      { key: 'other_retirement_assets', is_custom: false, included: false },
    ] as never[];
    expect(catalogPickerItems(rows, retirementGridConfig.hideFromAddPickerKeys).map((r: { key: string }) => r.key)).toEqual(['industry_super', 'other_retirement_assets']);
    // without the config the old picker offered them (so the filter is what removes them)
    expect(catalogPickerItems(rows)).toHaveLength(6);
  });

  it('an account save carrying contribution fields cannot smuggle them in (the schema drops them)', () => {
    const body = { account_name: 'Rest', account_type: 'super', current_balance: 1000, currency_code: 'AUD', owner: 'self', employer_contribution: 500, personal_contribution: 100, contribution_frequency: 'monthly' };
    const parsed = retirementSchema.parse(body) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('employer_contribution');
    expect(parsed).not.toHaveProperty('contribution_frequency');
    const patch = retirementPatchSchema.parse({ current_balance: 5, employer_contribution: 9 }) as Record<string, unknown>;
    expect(patch).toEqual({ current_balance: 5 });
  });
});

describe('the contribution action holds a contribution only', () => {
  it('requires the destination, type, a positive amount and when (a frequency or a date); has no balance field', () => {
    const ok = manualContributionSchema.safeParse({ retirement_account_id: ACC, contribution_type: 'personal', amount: 200, frequency: 'monthly' });
    expect(ok.success).toBe(true);
    expect(manualContributionSchema.safeParse({ retirement_account_id: ACC, contribution_type: 'personal', amount: 0, frequency: 'monthly' }).success).toBe(false);
    expect(manualContributionSchema.safeParse({ retirement_account_id: ACC, contribution_type: 'personal', amount: 5 }).success).toBe(false);
    expect(manualContributionSchema.safeParse({ retirement_account_id: ACC, contribution_type: 'personal', amount: 5, frequency: 'one_off' }).success).toBe(false);
    expect(manualContributionSchema.safeParse({ retirement_account_id: ACC, contribution_type: 'personal', amount: 5, frequency: 'one_off', contribution_date: '2026-06-30' }).success).toBe(true);
    // a balance can never ride along
    expect(manualContributionSchema.safeParse({ retirement_account_id: ACC, contribution_type: 'personal', amount: 5, frequency: 'monthly', current_balance: 99 }).success).toBe(false);
    // unknown type refused
    expect(manualContributionSchema.safeParse({ retirement_account_id: ACC, contribution_type: 'balance', amount: 5, frequency: 'monthly' }).success).toBe(false);
  });
});

const item = (over: Partial<HistoryItemView>): HistoryItemView => ({
  id: 'i1', kind: 'ledger', typeLabelKey: 'employer', amount: 684.68, currency: 'AUD', frequency: 'fortnightly', contributionDate: '2026-10-01', accountName: 'Bekal Super Fund',
  destinationKind: 'smsf', memberType: 'self', source: 'payslip', employerName: 'ACME PTY LTD', status: 'active', notCountedBecause: null, monthlyEquivalent: 1483.47, ...over,
});
const data = (items: HistoryItemView[], waiting: HistoryItemView[] = [], destinations = [{ accountId: 'a1', kind: 'smsf' as const, name: 'Bekal Super Fund', currency: 'AUD' }, { accountId: 'a2', kind: 'retirement_account' as const, name: 'Rest Super', currency: 'AUD' }]) => ({ items, waiting, destinations });

describe('the contribution history shows both sources with provenance', () => {
  it('imported payroll and manual contributions are in ONE history, each says where it came from, dates are day-first', () => {
    const html = renderToStaticMarkup(createElement(RetirementContributionsView, {
      data: data([item({}), item({ id: 'i2', source: 'manual', employerName: null, typeLabelKey: 'personal', amount: 200, frequency: 'monthly', destinationKind: 'retirement_account', accountName: 'Rest Super', contributionDate: null, monthlyEquivalent: 200 })]),
    }));
    expect(html).toContain('From your payslip (ACME PTY LTD)');
    expect(html).toContain('Entered by you');
    expect(html).toContain('Bekal Super Fund (SMSF)');
    expect(html).toContain('01/10/2026');
    expect(html).not.toMatch(/2026-10-01/);
    expect(html).toContain('adding one never changes a balance');
  });

  it('a payslip contribution waiting for a destination shows what happened, why, the choices and a working CTA; nothing is counted yet', () => {
    const waiting = item({ id: 'w1', accountName: null, destinationKind: null, status: 'needs_destination', notCountedBecause: 'Waiting for you to choose where it goes', monthlyEquivalent: null });
    const html = renderToStaticMarkup(createElement(RetirementContributionsView, { data: data([waiting], [waiting]) }));
    expect(html).toContain('Super from your payslip needs a destination');
    expect(html).toContain('has not guessed and has not counted it yet');
    expect(html).toContain('Bekal Super Fund (SMSF)');
    expect(html).toContain('Use this account');
    expect(html).toContain('disabled=""'); // the CTA is disabled until an account is chosen
    expect(html).toContain('Waiting for you to choose where it goes');
  });

  it('no destination in that currency: the person is told to add the account first, not shown a dead button', () => {
    const waiting = item({ id: 'w1', accountName: null, status: 'needs_destination', currency: 'INR' });
    const html = renderToStaticMarkup(createElement(RetirementContributionsView, { data: data([waiting], [waiting]) }));
    expect(html).toContain('You have no INR retirement account or SMSF yet');
    expect(html).not.toContain('Use this account');
  });

  it('wording helpers never leak internal keys', () => {
    expect(amountText(item({}))).toBe('$685 every fortnight');
    expect(amountText(item({ frequency: 'one_off', amount: 5000 }))).toBe('$5,000');
    expect(sourceText({ source: 'account', employerName: null })).toBe('Recorded on the account');
    const html = renderToStaticMarkup(createElement(RetirementContributionsView, { data: data([item({ status: 'superseded', notCountedBecause: 'Replaced by a revised payslip', monthlyEquivalent: null })]) }));
    expect(html).not.toMatch(/needs_destination|one_off|salary_sacrifice|retirement_account\b/);
  });
});
