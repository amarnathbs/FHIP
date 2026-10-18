/**
 * PO report 17-10-2026 ("there is no way to edit the net salary"). Reproduced in a real browser (scripts/a11y/incomeGridCheck.mjs) on a
 * synthetic row imported from a payslip: the Edit form DOES show Net Amount and Tax, enabled, and saving a new take-home works. The real
 * defect found beside it: a number field that was emptied turned into 0 (`Number('') === 0`), so a take-home that was cleared was saved as
 * an ENTERED take-home of 0 - and a cleared Tax as an entered tax of 0, which the net-basis rule treats as "no tax" - and there was no way
 * to return to "gross minus tax" or "assumed gross".
 *
 * The fix: a field declared `clearable` keeps '' while empty (the input stays empty) and, when the user emptied a field that HAD a value on
 * a saved row, the save sends an explicit null (the column is nullable). A field that was never filled is still omitted, so a save never
 * sends a column the database might not have yet (income_sources.tax_amount, migration 0285) unless the user cleared a real value.
 */
import { describe, expect, it } from 'vitest';

import { gridFieldBody, gridInputValue } from '@/lib/grid/saveBody';
import { incomeGridConfig, expenseGridConfig, assetGridConfig } from '@/lib/grid/configs';
import type { GridFieldDef } from '@/lib/grid/types';

const net = incomeGridConfig.fields.find((f) => f.name === 'net_amount') as GridFieldDef;
const tax = incomeGridConfig.fields.find((f) => f.name === 'tax_amount') as GridFieldDef;
const gross = incomeGridConfig.fields.find((f) => f.name === 'amount') as GridFieldDef;
const always = () => true;

describe('gridInputValue: what a number input keeps while the user types', () => {
  it('a clearable field keeps an emptied input empty', () => {
    expect(gridInputValue(net, '')).toBe('');
    expect(gridInputValue(tax, '')).toBe('');
  });
  it('a typed number is a number', () => {
    expect(gridInputValue(net, '138386.48')).toBe(138386.48);
    expect(gridInputValue(net, '0')).toBe(0);
  });
  it('a field that is not clearable behaves exactly as before (empty is 0): other registers are unchanged', () => {
    expect(gridInputValue(gross, '')).toBe(0);
    const expenseAmount = expenseGridConfig.fields.find((f) => f.name === 'amount') as GridFieldDef;
    expect(gridInputValue(expenseAmount, '')).toBe(0);
  });
  it('text and date inputs pass through', () => {
    const notes = incomeGridConfig.fields.find((f) => f.name === 'notes') as GridFieldDef;
    expect(gridInputValue(notes, 'hello')).toBe('hello');
  });
});

describe('gridFieldBody: what a save sends', () => {
  const saved = { amount: 196994.48, net_amount: 138386.48, tax_amount: null as number | null, frequency: 'annually', is_taxable: true, employer_name: 'Acme', notes: null };

  it('a new take-home is sent', () => {
    const body = gridFieldBody(incomeGridConfig, { ...saved, net_amount: 140000 }, { original: saved, applicable: always });
    expect(body.net_amount).toBe(140000);
    expect(body.amount).toBe(196994.48);
  });

  it('EMPTYING a take-home that had a value on a saved row sends null (clears it), never 0', () => {
    const body = gridFieldBody(incomeGridConfig, { ...saved, net_amount: '' }, { original: saved, applicable: always });
    expect(body.net_amount).toBeNull();
  });

  it('emptying a tax that had a value sends null as well', () => {
    const body = gridFieldBody(incomeGridConfig, { ...saved, net_amount: null, tax_amount: '' }, { original: { ...saved, tax_amount: 6000 }, applicable: always });
    expect(body.tax_amount).toBeNull();
  });

  it('a take-home that was never filled is omitted, so no column the database may not have yet is sent', () => {
    const untouched = { ...saved, net_amount: null, tax_amount: null };
    const body = gridFieldBody(incomeGridConfig, untouched, { original: untouched, applicable: always });
    expect('net_amount' in body && body.net_amount !== undefined).toBe(false);
    expect('tax_amount' in body && body.tax_amount !== undefined).toBe(false);
  });

  it('emptied on a NEW row (nothing saved yet) is omitted, not null', () => {
    const body = gridFieldBody(incomeGridConfig, { ...saved, net_amount: '' }, { original: undefined, applicable: always });
    expect(body.net_amount).toBeUndefined();
  });

  it('a real 0 typed by the user is still sent as 0 (an explicit take-home of nil)', () => {
    const body = gridFieldBody(incomeGridConfig, { ...saved, net_amount: 0 }, { original: saved, applicable: always });
    expect(body.net_amount).toBe(0);
  });

  it('a field hidden for the row is never sent, as before', () => {
    const body = gridFieldBody(incomeGridConfig, { ...saved, superseded_by_bank_import: true }, { original: saved, applicable: (name) => name !== 'superseded_by_bank_import' });
    expect(body.superseded_by_bank_import).toBeUndefined();
  });

  it('a field that is not clearable keeps the old rule: empty or null is omitted', () => {
    const row = { amount: '', frequency: 'monthly', notes: '' };
    const body = gridFieldBody(incomeGridConfig, row, { original: { amount: 5, frequency: 'monthly', notes: 'x' }, applicable: always });
    expect(body.amount).toBeUndefined();
    expect(body.notes).toBeUndefined();
  });

  it('only the Income take-home and tax fields are clearable, in no other register', () => {
    const clearable = (c: { fields: GridFieldDef[] }) => c.fields.filter((f) => f.clearable).map((f) => f.name);
    expect(clearable(incomeGridConfig)).toEqual(['net_amount', 'tax_amount']);
    expect(clearable(expenseGridConfig)).toEqual([]);
    expect(clearable(assetGridConfig)).toEqual([]);
  });
});
