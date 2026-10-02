/**
 * Owner-before-upload -- FINANCIAL ORACLES (PO final-completion item j).
 *
 * Hand-written expected figures. Each oracle starts from the owner a user CHOSE BEFORE UPLOADING (the real
 * validator), carries it through the real document-owner -> account-ownership -> report path, and checks the
 * number the household would see. A mutation of the arithmetic or the separation rule must make a named
 * assertion fail (scripts: mutate harness in the engineer's session; the same assertions run in CI here).
 *
 *   O1  Joint 1,000,000 at 60/40 -> 600,000 / 400,000; the household holds 1,000,000, NEVER 2,000,000.
 *   O2  A company-held 1,000,000 with 50% user ownership -> the macro (Net Worth) line carries 500,000, the
 *       personal investments register adds NOTHING, and the 1,000,000 lives only in the company's own class.
 *   O3  A Company / Trust / HUF owner on a BANK statement is refused before any canonical write.
 *   O4  An SMSF expense of 1,000 changes SMSF cash flow and NOT the personal Expenses.
 */
import { describe, expect, it } from 'vitest';
import { validateOwnerSelectionAgainst, type OwnerContext } from '@/lib/ownership/validateOwnerSelection';
import { ownerColumnsFor } from '@/lib/services/investment-intelligence/uploadOwner';
import { documentOwnerToValidatedOwner, readDocumentOwner } from '@/lib/services/investment-intelligence/documentOwner';
import { ownershipBlocksPersonalPublication, validatedOwnerToOwnership } from '@/lib/services/investment-intelligence/ownerModel';
import { buildOwnerBreakup, type BreakupAccount, type BreakupPosition, type OwnerLabels } from '@/lib/services/investment-intelligence/ownerClass';
import { computeBusinessEntityOwnershipValue, type BusinessEntityWithLineItems } from '@/lib/engines/businessEntityValuation';
import { computeSmsfCashFlow } from '@/lib/engines/smsf/smsfCashFlow';
import { selectExpenses } from '@/lib/read-models/expenses';
import { makeFakeSupabase } from './readModels/helpers/fakeSupabase';
import { account, CAT, profile, statement, tables, taxonomy, txn, USER, WINDOW } from './readModels/helpers/fixtures';

const SELF = 'a1111111-1111-4111-8111-111111111111';
const SPOUSE = 'a2222222-2222-4222-8222-222222222222';
const COMPANY = 'e1111111-1111-4111-8111-111111111111';
const TRUST = 'e2222222-2222-4222-8222-222222222222';
const HUF = 'e3333333-3333-4333-8333-333333333333';

const ctx: OwnerContext = {
  homeCountry: 'IN',
  members: [
    { id: SELF, fullName: 'Anil', relationship: 'self', isActive: true },
    { id: SPOUSE, fullName: 'Priya', relationship: 'spouse', isActive: true },
  ],
  entities: [
    { id: COMPANY, name: 'Sharma Pty Ltd', entityType: 'company', isActive: true },
    { id: TRUST, name: 'Sharma Family Trust', entityType: 'family_trust', isActive: true },
    { id: HUF, name: 'Sharma HUF', entityType: 'huf', isActive: true },
  ],
};

const labels: OwnerLabels = {
  member: (id) => ({ [SELF]: { name: 'Anil', relationship: 'self' }, [SPOUSE]: { name: 'Priya', relationship: 'spouse' } } as Record<string, { name: string; relationship: string }>)[id],
  entity: (id) => ({ [COMPANY]: { name: 'Sharma Pty Ltd', entityType: 'company' } } as Record<string, { name: string; entityType: string }>)[id],
};

/** The chain a real CAS upload takes: wire owner -> validator -> document columns -> document owner -> account ownership. */
function ownershipChosenAtUpload(wire: unknown) {
  const verdict = validateOwnerSelectionAgainst(ctx, wire, 'ii_cas');
  if (!verdict.ok) throw new Error(`owner refused: ${verdict.code}`);
  const documentColumns = ownerColumnsFor(verdict.owner);
  const documentOwner = readDocumentOwner(documentColumns);
  if (!documentOwner) throw new Error('document owner not readable');
  return validatedOwnerToOwnership(documentOwnerToValidatedOwner(documentOwner));
}

const position = (accountId: string, value: number): BreakupPosition => ({ accountId, currencyCode: 'INR', value });

describe('O1 -- joint 1,000,000 at 60/40', () => {
  const wire = { kind: 'joint', allocations: [{ memberId: SELF, basisPoints: 6000 }, { memberId: SPOUSE, basisPoints: 4000 }] };
  const accounts: BreakupAccount[] = [{ id: 'acc-joint', ownership: ownershipChosenAtUpload(wire) }];
  const breakup = buildOwnerBreakup(accounts, [position('acc-joint', 1_000_000)], labels);
  const joint = breakup.classes.find((c) => c.info.kind === 'joint');

  it('is ONE joint class holding 1,000,000, split 600,000 / 400,000 by the chosen shares', () => {
    expect(joint?.valueByCurrency).toEqual([{ currencyCode: 'INR', totalValue: 1_000_000, positionCount: 1 }]);
    const byOwner = Object.fromEntries((joint?.ownerAttribution ?? []).map((o) => [o.ownerLabel, o.valueByCurrency[0].totalValue]));
    expect(byOwner).toEqual({ Anil: 600_000, Priya: 400_000 });
  });

  it('the household total is 1,000,000 -- the macro line counts the position once, never 2,000,000', () => {
    expect(breakup.consolidated.valueByCurrency[0].totalValue).toBe(1_000_000);
    expect(breakup.consolidated.valueByCurrency[0].totalValue).not.toBe(2_000_000);
    expect(breakup.consolidated.positionCount).toBe(1);
    const attributedSum = (joint?.ownerAttribution ?? []).reduce((s, o) => s + o.valueByCurrency[0].totalValue, 0);
    expect(attributedSum).toBe(1_000_000); // the two shares add back to the whole, not to twice the whole
  });

  it('no personal (sole-member) row carries any of it', () => {
    expect(breakup.classes.filter((c) => c.info.kind === 'personal')).toEqual([]);
  });

  it('CONTROL: a 100% sole Self upload of the same position is ONE personal row of 1,000,000 (so the split above is what divided it)', () => {
    const sole = buildOwnerBreakup([{ id: 'acc-self', ownership: ownershipChosenAtUpload({ kind: 'member', memberId: SELF }) }], [position('acc-self', 1_000_000)], labels);
    expect(sole.classes.map((c) => [c.info.kind, c.valueByCurrency[0].totalValue])).toEqual([['personal', 1_000_000]]);
  });

  it('a split that does not total 100% never reaches the report (refused at upload)', () => {
    const bad = validateOwnerSelectionAgainst(ctx, { kind: 'joint', allocations: [{ memberId: SELF, basisPoints: 6000 }, { memberId: SPOUSE, basisPoints: 3000 }] }, 'ii_cas');
    expect(bad).toMatchObject({ ok: false, code: 'joint_total_not_100' });
  });
});

describe('O2 -- company-held 1,000,000 with 50% user ownership', () => {
  const ownership = ownershipChosenAtUpload({ kind: 'entity', entityId: COMPANY });
  const breakup = buildOwnerBreakup([{ id: 'acc-co', ownership }, { id: 'acc-self', ownership: ownershipChosenAtUpload({ kind: 'member', memberId: SELF }) }], [position('acc-co', 1_000_000), position('acc-self', 250_000)], labels);

  const company: BusinessEntityWithLineItems = {
    entity: { id: COMPANY, ownership_percentage: 50, valuation_mode: 'summary', summary_net_asset_value: 1_000_000, currency_code: 'INR', is_active: true },
    assets: [],
    liabilities: [],
  };

  it('the macro (Net Worth) line carries the user\'s 50% share: 500,000', () => {
    expect(computeBusinessEntityOwnershipValue([company], 'INR', 1)).toBe(500_000);
  });

  it('the personal investments register adds NOTHING for the company-held position (it is blocked from personal publication)', () => {
    expect(ownershipBlocksPersonalPublication(ownership)).toBe(true);
    const personalRegister = [
      { id: 'acc-co', ownership, value: 1_000_000 },
      { id: 'acc-self', ownership: ownershipChosenAtUpload({ kind: 'member', memberId: SELF }), value: 250_000 },
    ]
      .filter((a) => !ownershipBlocksPersonalPublication(a.ownership))
      .reduce((s, a) => s + a.value, 0);
    expect(personalRegister).toBe(250_000);
    expect(personalRegister).not.toBe(1_250_000);
  });

  it('the full 1,000,000 appears only inside the company\'s own class, never in a personal row', () => {
    const personal = breakup.classes.filter((c) => c.info.kind === 'personal');
    expect(personal.map((c) => c.valueByCurrency[0].totalValue)).toEqual([250_000]);
    const entity = breakup.classes.find((c) => c.info.kind === 'entity');
    expect(entity?.valueByCurrency[0].totalValue).toBe(1_000_000);
    expect(entity?.info.label).toBe('Sharma Pty Ltd');
  });

  it('the 500,000 macro share and the 1,000,000 held value are two different lines; no report row is their sum', () => {
    const macro = computeBusinessEntityOwnershipValue([company], 'INR', 1);
    const rows = [...breakup.classes.map((c) => c.valueByCurrency[0].totalValue), breakup.consolidated.valueByCurrency[0].totalValue];
    expect(macro).toBe(500_000);
    expect(rows).not.toContain(1_500_000);
    expect(rows).not.toContain(macro + 1_000_000);
  });

  it('CONTROL: at 100% ownership the same company contributes 1,000,000, so the 50% above is the ownership rule at work', () => {
    expect(computeBusinessEntityOwnershipValue([{ ...company, entity: { ...company.entity, ownership_percentage: 100 } }], 'INR', 1)).toBe(1_000_000);
  });
});

describe('O3 -- a Company / Trust / HUF owner on a bank statement is refused before any canonical write', () => {
  it.each([
    ['company', COMPANY],
    ['family_trust', TRUST],
    ['huf', HUF],
  ])('%s is refused for the bank flow', (_type, id) => {
    const verdict = validateOwnerSelectionAgainst({ ...ctx, homeCountry: 'IN' }, { kind: 'entity', entityId: id }, 'bank');
    expect(verdict).toMatchObject({ ok: false, code: 'owner_not_allowed_for_flow' });
  });

  it('CONTROL: the same three entities ARE accepted for an Investment Intelligence upload (so the bank refusal is the flow policy)', () => {
    for (const id of [COMPANY, TRUST, HUF]) expect(validateOwnerSelectionAgainst(ctx, { kind: 'entity', entityId: id }, 'ii_cas').ok).toBe(true);
  });
});

describe('O4 -- an SMSF expense of 1,000', () => {
  it('changes SMSF cash flow by exactly 1,000 a month', () => {
    const base = { incomeRows: [], propertyLoanLiabilities: [], contributionsMonthly: 0 };
    const without = computeSmsfCashFlow({ ...base, expenseRows: [] });
    const withExpense = computeSmsfCashFlow({ ...base, expenseRows: [{ amount: 1000, frequency: 'monthly', master_item_key: 'smsf_audit_fee', owner: 'smsf' }] as never });
    expect(withExpense.outflows.operatingExpenseItemsMonthly - without.outflows.operatingExpenseItemsMonthly).toBe(1000);
    expect(withExpense.netCashFlowMonthly - without.netCashFlowMonthly).toBe(-1000);
  });

  async function personalExpenses(ownerRole: string) {
    const { client } = makeFakeSupabase(
      tables(
        profile(),
        taxonomy(),
        { fdh_financial_accounts: [account('acc', 'transaction', { owner_role: ownerRole })] },
        { fdh_statement_uploads: [statement('s1', 'acc', '2026-08-01', '2026-08-31')] },
        { fdh_transactions: [txn({ account: 'acc', statement: 's1', date: '2026-08-12', amount: 1000, type: 'expense', category: CAT.fees })] },
      ),
    );
    const res = await selectExpenses(USER, { client, window: WINDOW, basis: 'actual' });
    if (res.status !== 'ok') throw new Error(`unavailable: ${res.reason}`);
    return res;
  }

  it('does NOT change the personal Expenses: an SMSF-owned bank statement adds 0 and is counted as excluded', async () => {
    const e = await personalExpenses('smsf');
    expect(e.actual.monthly).toBe(0);
    expect(e.actual.excludedNonHouseholdCount).toBe(1);
  });

  it('CONTROL: the identical 1,000 on a SELF-owned statement IS a personal expense (so ownership is what separated it)', async () => {
    const e = await personalExpenses('self');
    expect(e.actual.monthly).toBe(1000);
    expect(e.actual.excludedNonHouseholdCount).toBe(0);
  });
});
