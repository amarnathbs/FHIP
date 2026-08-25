import { describe, it, expect } from 'vitest';
import { smsfHoldingSchema, smsfHoldingUpdateSchema, smsfFundCreateSchema } from '@/lib/validation/smsf';

describe('smsfHoldingSchema (SMSF-4 Detailed Holdings)', () => {
  const base = {
    holding_class: 'cash' as const,
    holding_type: 'cash' as const,
    holding_name: 'SMSF Cash',
    value: 1000,
    currency_code: 'AUD' as const,
  };

  it('accepts a holding_type that matches its holding_class', () => {
    expect(smsfHoldingSchema.safeParse(base).success).toBe(true);
    expect(
      smsfHoldingSchema.safeParse({ ...base, holding_class: 'property', holding_type: 'residential_property' }).success
    ).toBe(true);
  });

  it('rejects a holding_type that does not belong to its holding_class', () => {
    const r = smsfHoldingSchema.safeParse({ ...base, holding_class: 'cash', holding_type: 'residential_property' });
    expect(r.success).toBe(false);
  });

  it('rejects linked_income_source_id on a non-property holding', () => {
    const r = smsfHoldingSchema.safeParse({
      ...base,
      linked_income_source_id: '11111111-1111-1111-1111-111111111111',
    });
    expect(r.success).toBe(false);
  });

  it('accepts linked_income_source_id on a property holding', () => {
    const r = smsfHoldingSchema.safeParse({
      ...base,
      holding_class: 'property',
      holding_type: 'residential_property',
      linked_income_source_id: '11111111-1111-1111-1111-111111111111',
    });
    expect(r.success).toBe(true);
  });

  it('rejects a negative value', () => {
    expect(smsfHoldingSchema.safeParse({ ...base, value: -1 }).success).toBe(false);
  });

  it('smsfHoldingUpdateSchema allows a partial patch missing holding_class/holding_type', () => {
    const r = smsfHoldingUpdateSchema.safeParse({ value: 2000 });
    expect(r.success).toBe(true);
  });
});

describe('smsfFundCreateSchema', () => {
  it('defaults owner to self and currency to AUD', () => {
    const r = smsfFundCreateSchema.safeParse({
      account_name: 'My SMSF',
      fund_name: 'My SMSF',
      summary_balance: 400000,
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.owner).toBe('self');
      expect(r.data.currency_code).toBe('AUD');
      expect(r.data.country_code).toBe('AU');
    }
  });

  it('rejects a non-AU country_code (SMSF is AU-only by construction, not just by gate)', () => {
    const r = smsfFundCreateSchema.safeParse({
      account_name: 'My SMSF',
      fund_name: 'My SMSF',
      summary_balance: 400000,
      country_code: 'IN',
    });
    expect(r.success).toBe(false);
  });

  it('rejects a negative summary_balance', () => {
    const r = smsfFundCreateSchema.safeParse({ account_name: 'x', fund_name: 'x', summary_balance: -1 });
    expect(r.success).toBe(false);
  });
});
