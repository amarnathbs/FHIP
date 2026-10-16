/**
 * PO request 16-10-2026: "Bonus" as a selectable income option, recorded as its OWN income source, separate from
 * Employment Salary (a fortnightly payslip scaled to the year would not match an annual gross that included a bonus).
 *
 * FINDING: 'bonus' (and 'commission', 'overtime') are ALREADY in the master income catalogue
 * (supabase/seed_master_items.sql, active, no country restriction, so AU and India households both get them). What was
 * missing was behaviour around them, covered here:
 *   1. the catalogue entry is present, stable, and no migration deactivates or restricts it (negative control: the same
 *      parser reports it missing when the line is removed);
 *   2. the Add menu offers it, a new Bonus row starts as Annually and taxable, and the form explains it;
 *   3. money: a Bonus with no take-home falls to the gross-as-take-home rule and is NAMED; a tax amount derives its net;
 *   4. NO DOUBLE COUNT with a payslip's own bonus (PO D-06): a recorded Bonus stands for it, said on the Income page;
 *   5. a payslip is never matched to (and never overwrites) a Bonus / Overtime / Commission source;
 *   6. a wage-like Bonus with an implausible take-home is flagged.
 *
 * Hand-calculated oracles (never produced by running the code under test):
 *   salary 100,000 a year, take-home 70,000  +  Bonus 20,000 a year, no take-home, no tax
 *     gross a month = 8,333.33 + 1,666.67 = 10,000.00
 *     net a month   = 5,833.33 + 1,666.67 =  7,500.00   (the bonus's gross is taken as its take-home)
 *     assumed sources = [Bonus 1,666.67 a month]
 *   Bonus 20,000 a year with tax 6,000 -> net 14,000 a year = 1,166.67 a month (derived, nothing assumed)
 *   Window Jun-Aug 2026 (3 months). Applied payslip: salary 6,500 gross / 5,000 net a month, bonus 3,000 dated 15-08-2026
 *     without a recorded Bonus -> +3,000 / 3 = 1,000 a month of one-off pay (gross 7,500)
 *     with a recorded Bonus 20,000 a year -> payslip bonus left out: gross 6,500 + 1,666.67 = 8,166.67, net 5,000 + 1,666.67 = 6,666.67
 *     payslip bonus 3,000 + overtime 600, only Bonus recorded -> overtime 600 / 3 = 200 a month still counted
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { catalogPickerItems, mergeSavedRows } from '@/components/grid/FinancialDataGrid';
import { incomeGridConfig } from '@/lib/grid/configs';
import { incomeDefaultsForMasterItem, incomeItemHint, isVariablePayItemKey } from '@/lib/engines/incomeVariablePay';
import { isWageLikeIncome } from '@/lib/engines/incomePlausibility';
import { findDuplicateIncome, incomeAdapter, type ExistingIncomeRow, type IncomeEvidence } from '@/lib/import-bridge/adapters/incomeAdapter';
import { selectIncome, type IncomeReadModelData } from '@/lib/read-models/income';
import { toIncomeActualsDto } from '@/lib/income/importedIncomeActuals';
import { loadDashboard } from '@/lib/services/dashboardData';
import { makeFakeSupabase, type Row } from './readModels/helpers/fakeSupabase';
import { incomeSource, profile, tables, taxonomy, USER, WINDOW } from './readModels/helpers/fixtures';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// ---------------------------------------------------------------------------
// 1. The catalogue
// ---------------------------------------------------------------------------

/** The income rows of a master-item SQL seed, in file order. */
function incomeCatalogueFrom(sql: string): { key: string; label: string; sort: number }[] {
  return [...sql.matchAll(/^\('income', '([a-z_]+)', '([^']+)', (\d+)\)/gm)].map((m) => ({ key: m[1], label: m[2], sort: Number(m[3]) }));
}

const EXPECTED_INCOME_KEYS = [
  'employment_salary', 'bonus', 'commission', 'overtime', 'director_fees', 'consulting_income', 'business_income', 'self_employed_income',
  'partnership_distribution', 'trust_distribution', 'rental_income', 'airbnb_income', 'interest_income', 'dividend_income', 'managed_fund_distribution',
  'capital_gains', 'government_pension', 'age_pension', 'disability_pension', 'child_support_received', 'family_tax_benefit', 'super_pension',
  'annuity_income', 'overseas_income', 'royalty_income', 'other_regular_income', 'other_one_off_income',
];

describe('the master income catalogue offers Bonus (and keeps every existing item)', () => {
  const seed = incomeCatalogueFrom(read('supabase/seed_master_items.sql'));

  it('Bonus is a catalogue item with a stable key, right after Employment Salary', () => {
    const bonus = seed.find((i) => i.key === 'bonus');
    expect(bonus).toEqual({ key: 'bonus', label: 'Bonus', sort: 20 });
    expect(seed[0]).toMatchObject({ key: 'employment_salary', label: 'Employment Salary', sort: 10 });
    expect(seed[1].key).toBe('bonus');
  });

  it('Commission and Overtime are catalogue items too (nothing to add for them)', () => {
    expect(seed.find((i) => i.key === 'commission')).toMatchObject({ label: 'Commission', sort: 30 });
    expect(seed.find((i) => i.key === 'overtime')).toMatchObject({ label: 'Overtime', sort: 40 });
  });

  it('every existing income item is unchanged: same 27 keys in the same order, strictly increasing sort order', () => {
    expect(seed.map((i) => i.key)).toEqual(EXPECTED_INCOME_KEYS);
    expect(seed.map((i) => i.sort)).toEqual(EXPECTED_INCOME_KEYS.map((_, i) => (i + 1) * 10));
  });

  it('the same row is in the other places the catalogue is bootstrapped from', () => {
    for (const file of ['supabase/combined_0004.sql', 'supabase/production_bootstrap_part09.sql']) {
      expect(incomeCatalogueFrom(read(file)).find((i) => i.key === 'bonus'), file).toMatchObject({ label: 'Bonus', sort: 20 });
    }
  });

  it('no migration deactivates, renames, deletes or country-restricts Bonus / Commission / Overtime (AU and India both get them)', () => {
    const dir = join(ROOT, 'supabase/migrations');
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql'))) {
      const sql = read(`supabase/migrations/${f}`);
      // A statement that touches master_financial_items AND names one of the three keys.
      for (const stmt of sql.split(';')) {
        if (/master_financial_items/i.test(stmt) && /\b(update|delete)\b/i.test(stmt) && /'(bonus|commission|overtime)'/.test(stmt)) offenders.push(`${f}: ${stmt.trim().slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
    // Restriction is by array, never by a blanket rule: only these two income items are AU-only (0102).
    const m0102 = read('supabase/migrations/0102_g0_wave2_catalogue_applicability.sql');
    expect(m0102).not.toMatch(/'bonus'/);
  });

  it('[NEGATIVE CONTROL] the parser DOES notice a removed option: without the Bonus line there is no Bonus and the order check fails', () => {
    const withoutBonus = read('supabase/seed_master_items.sql').replace(/^\('income', 'bonus', 'Bonus', 20\),\r?\n/m, '');
    const parsed = incomeCatalogueFrom(withoutBonus);
    expect(parsed.find((i) => i.key === 'bonus')).toBeUndefined();
    expect(parsed.map((i) => i.key)).not.toEqual(EXPECTED_INCOME_KEYS);
  });
});

// ---------------------------------------------------------------------------
// 2. The Add menu and the new row
// ---------------------------------------------------------------------------

describe('the Income "What are you adding?" menu', () => {
  const seed = incomeCatalogueFrom(read('supabase/seed_master_items.sql'));
  const master = seed.map((i) => ({ item_key: i.key, item_label: i.label, sort_order: i.sort }));

  for (const currency of ['AUD', 'INR'] as const) {
    it(`offers Bonus for a ${currency === 'AUD' ? 'Australian' : 'Indian'} household, in catalogue order, and a new row starts Annually and taxable`, () => {
      const rows = mergeSavedRows(master, [], incomeGridConfig, currency);
      const menu = catalogPickerItems(rows);
      expect(menu.map((r) => r.item_label).slice(0, 3)).toEqual(['Employment Salary', 'Bonus', 'Commission']);
      const bonus = menu.find((r) => r.master_item_key === 'bonus')!;
      expect(bonus).toMatchObject({ item_label: 'Bonus', frequency: 'annually', is_taxable: true, included: false, owner: 'self', currency_code: currency });
    });
  }

  it('only Bonus gets a default frequency; Employment Salary, Commission and Overtime start exactly as before (no frequency)', () => {
    const rows = mergeSavedRows(master, [], incomeGridConfig, 'AUD');
    for (const key of ['employment_salary', 'commission', 'overtime', 'rental_income']) {
      expect(rows.find((r) => r.master_item_key === key)!.frequency, key).toBeUndefined();
      expect(incomeDefaultsForMasterItem(key), key).toEqual({});
    }
    expect(incomeDefaultsForMasterItem('bonus')).toEqual({ frequency: 'annually' });
  });

  it('a saved Bonus row keeps its own values (the default only applies to a NEW row) and leaves the menu', () => {
    const saved = [{ id: 'b1', master_item_key: 'bonus', currency_code: 'AUD', owner: 'self', source_name: 'Bonus', amount: 20000, frequency: 'quarterly' }];
    const rows = mergeSavedRows(master, saved, incomeGridConfig, 'AUD');
    expect(rows.find((r) => r.master_item_key === 'bonus')).toMatchObject({ id: 'b1', frequency: 'quarterly', included: true });
    expect(catalogPickerItems(rows).some((r) => r.master_item_key === 'bonus')).toBe(false);
  });

  it('[NEGATIVE CONTROL] if the catalogue lost Bonus, the menu would not offer it and no Annual default could apply', () => {
    const rows = mergeSavedRows(master.filter((m) => m.item_key !== 'bonus'), [], incomeGridConfig, 'AUD');
    expect(catalogPickerItems(rows).map((r) => r.master_item_key)).not.toContain('bonus');
  });

  it('the form explains Bonus in one line (separate from salary, counted once with payslips) and says nothing for other items', () => {
    expect(incomeGridConfig.itemHint?.('bonus')).toMatch(/separately from your salary/);
    expect(incomeGridConfig.itemHint?.('bonus')).toMatch(/counted once/);
    expect(incomeItemHint('employment_salary')).toBeUndefined();
    expect(incomeItemHint(null)).toBeUndefined();
  });

  it('Bonus is a wage-like item for the take-home plausibility test, and a variable-pay item for the payslip rules', () => {
    expect(isWageLikeIncome('bonus', 'manual')).toBe(true);
    expect(isVariablePayItemKey('bonus') && isVariablePayItemKey('overtime') && isVariablePayItemKey('commission')).toBe(true);
    expect(isVariablePayItemKey('employment_salary')).toBe(false);
    expect(isVariablePayItemKey(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Money: read model and Dashboard
// ---------------------------------------------------------------------------

const salary = (over: Row = {}) => incomeSource('sal', 'Employment Salary', 100000, 'annually', { net_amount: 70000, employer_name: 'Acme', ...over });
const bonusRow = (over: Row = {}) => incomeSource('bon', 'Bonus', 20000, 'annually', { master_item_key: 'bonus', ...over });

async function run(t: Record<string, Row[]>): Promise<IncomeReadModelData> {
  const { client } = makeFakeSupabase(tables(profile(), taxonomy(), t));
  const res = await selectIncome(USER, { client, window: WINDOW });
  if (res.status !== 'ok') throw new Error(`unavailable: ${res.reason} ${res.source}`);
  return res;
}

describe('a Bonus source in the income figures', () => {
  it('salary 100,000 (take-home 70,000) + Bonus 20,000 with no take-home: gross 10,000, net 7,500, the Bonus is named as the assumed-gross source', async () => {
    const e = await run({ income_sources: [salary(), bonusRow()] });
    expect(e.combined.grossMonthly).toBeCloseTo(10000, 2);
    expect(e.combined.netMonthly).toBeCloseTo(7500, 2);
    expect(e.planned.lines.find((l) => l.masterItemKey === 'bonus')).toMatchObject({ name: 'Bonus', netBasis: 'assumed_gross', frequency: 'annually' });
    expect(e.combined.assumedNetSources).toHaveLength(1);
    expect(e.combined.assumedNetSources[0].name).toBe('Bonus');
    expect(e.combined.assumedNetSources[0].grossMonthly).toBeCloseTo(1666.67, 2);
    expect(e.combined.netAssumedMonthly).toBeCloseTo(1666.67, 2);
  });

  it('a tax amount on the Bonus gives its take-home (20,000 - 6,000 = 14,000 a year = 1,166.67 a month) and assumes nothing', async () => {
    const e = await run({ income_sources: [bonusRow({ tax_amount: 6000 })] });
    expect(e.planned.lines[0]).toMatchObject({ netBasis: 'derived_from_tax', netNative: 14000 });
    expect(e.combined.netMonthly).toBeCloseTo(1166.67, 2);
    expect(e.combined.assumedNetComponents).toBe(0);
  });

  it('the Dashboard shows the same figures and the notice names the Bonus', async () => {
    const { client } = makeFakeSupabase(tables(profile(), taxonomy(), { income_sources: [salary(), bonusRow()] }));
    const d = await loadDashboard(USER, client as never);
    expect(d.grossMonthlyIncome).toBeCloseTo(10000, 2);
    expect(d.netMonthlyIncome).toBeCloseTo(7500, 2);
    expect(d.dataStatus?.netIncomeAssumed.sources.map((x) => x.name)).toEqual(['Bonus']);
    expect(d.dataStatus?.netIncomeAssumed.sources[0].grossMonthly).toBeCloseTo(1666.67, 2);
    expect(d.dataStatus?.netIncomeBasis).toBe('net_partial');
  });

  it('a Bonus whose entered take-home is a tiny share of its gross is flagged (wage-like): 20,000 a year, take-home 2,000 = 10%', async () => {
    const { client } = makeFakeSupabase(tables(profile(), taxonomy(), { income_sources: [salary(), bonusRow({ net_amount: 2000 })] }));
    const d = await loadDashboard(USER, client as never);
    const flags = d.dataStatus?.netIncomeImplausible ?? [];
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ name: 'Bonus', kind: 'net_far_below_gross' });
    expect(flags[0].netToGross).toBeCloseTo(0.1, 4);
  });
});

// ---------------------------------------------------------------------------
// 4. No double count with a payslip's own bonus (PO D-06)
// ---------------------------------------------------------------------------

const payrollEvent = (extra: Row = {}): Row => ({
  id: 'pe1', user_id: USER, employer_name: 'Acme', currency_code: 'AUD', payment_date: '2026-08-15', pay_period_end: '2026-08-14',
  gross_pay: 9500, net_pay: 7100, bonus_pay: 3000, overtime_pay: null, commission_pay: null, other_earnings: null,
  approval_status: 'approved', superseded_by_payroll_event_id: null, bank_match_transaction_id: null, bank_match_status: 'not_attempted', ...extra,
});
const payslipSalary = (over: Row = {}) => incomeSource('src-payslip', 'Salary — Acme', 6500, 'monthly', { net_amount: 5000, source_type: 'payslip_import', employer_name: 'Acme', ...over });
const applied = { fhip_import_applications: [{ user_id: USER, target_domain: 'income', source_payroll_event_id: 'pe1', target_entity_id: 'src-payslip' }] };

describe('a recorded Bonus and an imported payslip bonus are counted ONCE', () => {
  it('control (no recorded Bonus): the payslip bonus 3,000 counts as one-off pay, +1,000 a month (existing PO D-06 rule, unchanged)', async () => {
    const e = await run(tables({ income_sources: [payslipSalary()], fdh_payroll_events: [payrollEvent()] }, applied));
    expect(e.actual.variablePay.grossMonthly).toBe(1000);
    expect(e.actual.variablePay.leftOut).toEqual([]);
    expect(e.combined.grossMonthly).toBe(7500);
  });

  it('with a recorded Bonus 20,000 a year the payslip bonus is NOT added again: gross 8,166.67, net 6,666.67, one left-out line naming the Bonus', async () => {
    const e = await run(tables({ income_sources: [payslipSalary(), bonusRow()], fdh_payroll_events: [payrollEvent()] }, applied));
    expect(e.actual.variablePay.lines).toEqual([]);
    expect(e.actual.variablePay.grossMonthly).toBe(0);
    expect(e.actual.variablePay.leftOut).toEqual([{ payrollEventId: 'pe1', kind: 'bonus', date: '2026-08-15', grossNative: 3000, currency: 'AUD', recordedSourceId: 'bon', recordedSourceName: 'Bonus' }]);
    expect(e.combined.grossMonthly).toBeCloseTo(8166.67, 2);
    expect(e.combined.netMonthly).toBeCloseTo(6666.67, 2);
    // The only assumed-gross source is the Bonus itself; there is no "Variable pay (payslip)" line to double up on.
    expect(e.combined.assumedNetSources.map((x) => x.name)).toEqual(['Bonus']);
  });

  it('only the recorded kind is left out: payslip bonus 3,000 + overtime 600 with only a Bonus recorded -> overtime 600 / 3 = 200 a month still counts', async () => {
    const e = await run(tables({ income_sources: [payslipSalary(), bonusRow()], fdh_payroll_events: [payrollEvent({ overtime_pay: 600 })] }, applied));
    expect(e.actual.variablePay.grossMonthly).toBe(200);
    expect(e.actual.variablePay.lines[0].grossNative).toBe(600);
    expect(e.actual.variablePay.leftOut.map((l) => l.kind)).toEqual(['bonus']);
  });

  it('recording Overtime and Commission works the same way', async () => {
    const e = await run(tables({
      income_sources: [payslipSalary(), incomeSource('ot', 'Overtime', 600, 'monthly', { master_item_key: 'overtime' }), incomeSource('co', 'Commission', 900, 'monthly', { master_item_key: 'commission' })],
      fdh_payroll_events: [payrollEvent({ bonus_pay: null, overtime_pay: 600, commission_pay: 900, other_earnings: 150 })],
    }, applied));
    expect(e.actual.variablePay.leftOut.map((l) => l.kind).sort()).toEqual(['commission', 'overtime']);
    expect(e.actual.variablePay.lines[0].grossNative).toBe(150); // other earnings are never left out
    expect(e.actual.variablePay.grossMonthly).toBe(50);
  });

  it('a Bonus recorded for the SPOUSE does not hide the account holder\'s payslip bonus (owner must match)', async () => {
    const e = await run(tables({ income_sources: [payslipSalary(), bonusRow({ owner: 'spouse' })], fdh_payroll_events: [payrollEvent()] }, applied));
    expect(e.actual.variablePay.grossMonthly).toBe(1000);
    expect(e.actual.variablePay.leftOut).toEqual([]);
  });

  it('a one-off Bonus (no monthly effect), or one left out of the income, does not hide the payslip bonus', async () => {
    for (const row of [bonusRow({ frequency: 'one_off' }), bonusRow({ superseded_by_bank_import: true })]) {
      const e = await run(tables({ income_sources: [payslipSalary(), row], fdh_payroll_events: [payrollEvent()] }, applied));
      expect(e.actual.variablePay.grossMonthly, JSON.stringify(row.frequency)).toBe(1000);
    }
  });

  it('the Income page says so: the DTO carries the left-out line and the rendered note names the Bonus, with a day-first date', async () => {
    const e = await run(tables({ income_sources: [payslipSalary(), bonusRow()], fdh_payroll_events: [payrollEvent()] }, applied));
    const dto = toIncomeActualsDto(e);
    expect(dto.variablePay.leftOut).toEqual([{ payrollEventId: 'pe1', kind: 'bonus', date: '2026-08-15', grossNative: 3000, currency: 'AUD', recordedSourceName: 'Bonus' }]);
    const { IncomeActualsBody } = await import('@/components/income/ImportedIncomeActuals');
    const html = renderToStaticMarkup(createElement(IncomeActualsBody, { data: dto }));
    expect(html).toContain('data-testid="income-variable-left-out"');
    expect(html).toContain('not added again');
    expect(html).toMatch(/bonus of \$3,000 on your payslip dated 15\/08\/2026/);
    expect(html).toContain('“Bonus”');
    expect(html).not.toContain('2026-08-15');
  });

  it('without a recorded Bonus the note is absent', async () => {
    const e = await run(tables({ income_sources: [payslipSalary()], fdh_payroll_events: [payrollEvent()] }, applied));
    const html = renderToStaticMarkup(createElement((await import('@/components/income/ImportedIncomeActuals')).IncomeActualsBody, { data: toIncomeActualsDto(e) }));
    expect(html).not.toContain('income-variable-left-out');
  });
});

// ---------------------------------------------------------------------------
// 5. A payslip never overwrites a Bonus / Overtime / Commission source
// ---------------------------------------------------------------------------

const row = (over: Partial<ExistingIncomeRow>): ExistingIncomeRow => ({
  id: 'x', source_name: 'Employment Salary', income_type: 'other', amount: 100000, net_amount: null, frequency: 'annually', currency_code: 'AUD',
  owner: 'self', is_taxable: true, employer_name: null, notes: null, master_item_key: 'employment_salary', ...over,
});
const evidence = (over: Partial<IncomeEvidence> = {}): IncomeEvidence => ({
  payrollEventId: 'pe-1', employerName: 'Acme Pty Ltd', currencyCode: 'AUD', canonicalFrequency: 'fortnightly', frequencyStated: true,
  grossPay: 3846.15, netPay: 2700, reimbursementsIncludedInGross: false, reviewReasons: [], bankMatchStatus: 'not_attempted', ...over,
});

describe('payslip import never targets a Bonus / Overtime / Commission source', () => {
  const bonusWithEmployer = row({ id: 'bonus-row', source_name: 'Bonus', master_item_key: 'bonus', amount: 20000, employer_name: 'Acme Pty Ltd' });
  const salaryWithEmployer = row({ id: 'salary-row', employer_name: 'Acme Pty Ltd' });

  it('[DEFECT it prevents] a Bonus row carrying the employer name listed FIRST is not the payslip target; the salary row is', () => {
    expect(findDuplicateIncome(evidence(), [bonusWithEmployer, salaryWithEmployer])?.id).toBe('salary-row');
    expect(incomeAdapter.buildProposal(evidence(), [bonusWithEmployer, salaryWithEmployer]).targetEntityId).toBe('salary-row');
  });

  it('with only a Bonus row present the payslip proposes a NEW salary row and leaves the Bonus alone', () => {
    expect(findDuplicateIncome(evidence(), [bonusWithEmployer])).toBeNull();
    const draft = incomeAdapter.buildProposal(evidence(), [bonusWithEmployer]);
    expect(draft.recommendedApplyMode).toBe('add_new');
    expect(draft.targetEntityId ?? null).toBeNull();
  });

  it('the same holds for Overtime and Commission, and for the name-based and catalogue-salary fallbacks', () => {
    for (const key of ['overtime', 'commission']) {
      expect(findDuplicateIncome(evidence(), [row({ id: 'v', master_item_key: key, employer_name: 'Acme Pty Ltd' })])).toBeNull();
    }
    expect(findDuplicateIncome(evidence(), [row({ id: 'v', master_item_key: 'bonus', income_type: 'salary', source_name: 'Acme Pty Ltd bonus' })])).toBeNull();
    // Control: the catalogue Employment Salary row with no employer is still the recommended target.
    expect(findDuplicateIncome(evidence(), [bonusWithEmployer, row({ id: 'cat-salary' })])?.id).toBe('cat-salary');
  });
});
