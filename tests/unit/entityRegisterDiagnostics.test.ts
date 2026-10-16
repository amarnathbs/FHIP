// Entity-in-personal-register diagnostics (design slice, 16-10-2026). EVIDENCE LABEL: UNIT-TESTED with hand-calculated oracles
// on the PO household (AUD): SMSF fund value 503,000 + SMSF-owned "Other Retirement Assets" 133,000 = 636,000 recorded; the
// real picture is asset 503,000 - loan 370,000 = net 133,000. Read-only: the engine never changes a figure.
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { diagnoseEntityRegisters, type DiagLiabilityRow, type DiagRetirementRow, type DiagSmsfFund } from '@/lib/engines/entityRegisterDiagnostics';
import { EntityRegisterNotice } from '@/components/entities/EntityRegisterNotice';

const ret = (r: Partial<DiagRetirementRow> & Pick<DiagRetirementRow, 'id' | 'balance'>): DiagRetirementRow => ({
  name: r.id, owner: 'self', masterItemKey: null, currency: 'AUD', isActive: true, ...r,
});
const liab = (l: Partial<DiagLiabilityRow> & Pick<DiagLiabilityRow, 'id' | 'balance'>): DiagLiabilityRow => ({
  name: l.id, owner: 'self', currency: 'AUD', isActive: true, ...l,
});
const FUND: DiagSmsfFund = { id: 'fund-1', retirementAccountId: 'smsf-row', mode: 'summary', isActive: true };

const PO_RETIREMENT = [
  ret({ id: 'smsf-row', name: 'SMSF', balance: 503_000, masterItemKey: 'smsf' }),
  ret({ id: 'other-ret', name: 'Other Retirement Assets', balance: 133_000, owner: 'smsf', masterItemKey: 'other_retirement' }),
  ret({ id: 'super', name: 'Industry super', balance: 120_000 }),
];
const PO_LIABILITIES = [
  liab({ id: 'home', balance: 600_000 }),
  liab({ id: 'inv', balance: 700_000, owner: 'joint' }),
  liab({ id: 'car', balance: 85_857, owner: 'spouse' }),
];

describe('diagnoseEntityRegisters: PO household', () => {
  const findings = diagnoseEntityRegisters({ retirement: PO_RETIREMENT, funds: [FUND], liabilities: PO_LIABILITIES, smsfLinkedLiabilityIds: [] });

  it('flags the SMSF recorded twice with the hand-calculated amounts (503,000 + 133,000 = 636,000)', () => {
    expect(findings.map((f) => f.code)).toEqual(['smsf_recorded_twice']);
    const f = findings[0];
    expect(f.amounts).toEqual({ fundValue: 503_000, smsfOwnedRows: 133_000, combined: 636_000 });
    expect(f.rowIds.sort()).toEqual(['other-ret', 'smsf-row']);
    expect(f.pages).toEqual(['retirement']);
    expect(f.message).toContain('$636,000');
    expect(f.message).toContain('counts only the SMSF-owned row');
    expect(f.message).toContain('net value');
  });

  it('says nothing about personal super or personal loans', () => {
    expect(findings.flatMap((f) => f.rowIds)).not.toContain('super');
    expect(findings.flatMap((f) => f.rowIds)).not.toContain('home');
  });
});

describe('diagnoseEntityRegisters: the corrected shapes are quiet', () => {
  it('interim shape: fund row removed, only the 133,000 SMSF-owned row remains', () => {
    const retirement = PO_RETIREMENT.filter((r) => r.id !== 'smsf-row');
    expect(diagnoseEntityRegisters({ retirement, funds: [], liabilities: PO_LIABILITIES, smsfLinkedLiabilityIds: [] })).toEqual([]);
  });
  it('interim shape: the fund row archived (is_active false) is not counted as a second record', () => {
    const retirement = PO_RETIREMENT.map((r) => (r.id === 'smsf-row' ? { ...r, isActive: false } : r));
    expect(diagnoseEntityRegisters({ retirement, funds: [{ ...FUND, isActive: false }], liabilities: PO_LIABILITIES, smsfLinkedLiabilityIds: [] })).toEqual([]);
  });
  it('a fund row alone (no SMSF-owned rows) is the normal single record', () => {
    const retirement = PO_RETIREMENT.filter((r) => r.id !== 'other-ret');
    expect(diagnoseEntityRegisters({ retirement, funds: [FUND], liabilities: PO_LIABILITIES, smsfLinkedLiabilityIds: [] })).toEqual([]);
  });
  it('a zero-balance SMSF-owned row is not a duplicate', () => {
    const retirement = PO_RETIREMENT.map((r) => (r.id === 'other-ret' ? { ...r, balance: 0 } : r));
    expect(diagnoseEntityRegisters({ retirement, funds: [FUND], liabilities: PO_LIABILITIES, smsfLinkedLiabilityIds: [] })).toEqual([]);
  });
});

describe('diagnoseEntityRegisters: SMSF debt among personal liabilities', () => {
  it('flags an owner=smsf liability (370,000) and a linked one, not personal loans', () => {
    const liabilities = [...PO_LIABILITIES, liab({ id: 'smsf-loan', name: 'SMSF property loan', balance: 370_000, owner: 'smsf' })];
    const f = diagnoseEntityRegisters({ retirement: [], funds: [], liabilities, smsfLinkedLiabilityIds: [] });
    expect(f).toHaveLength(1);
    expect(f[0].code).toBe('smsf_debt_in_personal_liabilities');
    expect(f[0].amounts).toEqual({ debts: 370_000 });
    expect(f[0].rowIds).toEqual(['smsf-loan']);
    expect(f[0].pages).toContain('liabilities');

    const linked = diagnoseEntityRegisters({ retirement: [], funds: [], liabilities: PO_LIABILITIES, smsfLinkedLiabilityIds: ['home'] });
    expect(linked[0].rowIds).toEqual(['home']);
    expect(linked[0].amounts).toEqual({ debts: 600_000 });
  });
  it('an archived or zero SMSF liability is not flagged', () => {
    const liabilities = [liab({ id: 'a', balance: 10, owner: 'smsf', isActive: false }), liab({ id: 'b', balance: 0, owner: 'smsf' })];
    expect(diagnoseEntityRegisters({ retirement: [], funds: [], liabilities, smsfLinkedLiabilityIds: [] })).toEqual([]);
  });
  it('mixed currencies are never added together', () => {
    const retirement = [
      ret({ id: 'smsf-row', balance: 503_000, masterItemKey: 'smsf' }),
      ret({ id: 'x', balance: 100, owner: 'smsf', currency: 'INR' }),
    ];
    const f = diagnoseEntityRegisters({ retirement, funds: [FUND], liabilities: [], smsfLinkedLiabilityIds: [] });
    expect(f[0].amounts).toBeNull();
    expect(f[0].currency).toBeNull();
  });
});

describe('read-only and wired', () => {
  it('does not mutate its input', () => {
    const input = { retirement: PO_RETIREMENT, funds: [FUND], liabilities: PO_LIABILITIES, smsfLinkedLiabilityIds: [] as string[] };
    const before = JSON.stringify(input);
    diagnoseEntityRegisters(input);
    expect(JSON.stringify(input)).toBe(before);
  });
  it('the notice renders nothing until data has loaded (no flash, no error banner)', () => {
    expect(renderToStaticMarkup(h(EntityRegisterNotice, { page: 'retirement' }))).toBe('');
  });
  it('is mounted on the Retirement and Liabilities pages', () => {
    const root = path.resolve(__dirname, '..', '..');
    expect(fs.readFileSync(path.join(root, 'app/(app)/retirement/page.tsx'), 'utf8')).toContain('<EntityRegisterNotice page="retirement" />');
    expect(fs.readFileSync(path.join(root, 'app/(app)/liabilities/page.tsx'), 'utf8')).toContain('<EntityRegisterNotice page="liabilities" />');
  });
});
