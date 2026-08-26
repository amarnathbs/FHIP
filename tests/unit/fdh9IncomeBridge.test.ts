/**
 * FDH-9 — certifies `applyImportProposal()` (the app-layer guard) against
 * adversarial inputs, without a database, using the in-memory store that
 * `tests/support/importBridgeMemoryStore.ts` already provides for exactly
 * this purpose (see that file's own header). This was a real, previously
 * undisclosed gap: applyService.ts / proposalEngine.ts / incomeAdapter.ts
 * shipped with the harness built but never wired to any test file.
 *
 * This suite is DEFENSE IN DEPTH, not the security boundary — the real
 * boundary is migration 0091's `fdh9_apply_income_proposal()` RPC, certified
 * separately against real Postgres by scripts/fdh9_certification.mjs. What
 * this file proves is that the TypeScript guard applyService.ts implements
 * (which a route may still call for fast, friendly error messages before
 * ever reaching the database) enforces the same rules the RPC enforces.
 */
import { describe, expect, it } from 'vitest';
import { applyImportProposal, type StoredProposal } from '@/lib/import-bridge/applyService';
import { incomeAdapter, newIncomeRowDefaults, type ExistingIncomeRow } from '@/lib/import-bridge/adapters/incomeAdapter';
import { ImportBridgeMemoryStore, type MemoryIncomeRow } from '../support/importBridgeMemoryStore';
import type { ProposedField } from '@/lib/import-bridge/types';

const USER_A = 'user-a';
const USER_B = 'user-b';

function field(fieldName: string, proposedValue: string | null, existingValue: string | null, overrides: Partial<ProposedField> = {}): ProposedField {
  return {
    fieldName,
    valueKind: fieldName === 'amount' || fieldName === 'net_amount' ? 'money' : fieldName === 'is_taxable' ? 'bool' : 'text',
    proposedValue,
    existingValue,
    isRecommended: true,
    requiresConfirmation: false,
    reasonCode: 'test',
    ...overrides,
  };
}

function baseIncomeRow(overrides: Partial<MemoryIncomeRow> = {}): MemoryIncomeRow {
  return {
    id: 'income-1', user_id: USER_A, source_name: 'Salary — Acme', income_type: 'salary',
    amount: 5000, net_amount: null, frequency: 'monthly', currency_code: 'AUD', owner: 'self',
    is_taxable: true, employer_name: 'Acme', notes: null, master_item_key: null,
    source_type: 'manual', is_active: true,
    ...overrides,
  };
}

function proposal(overrides: Partial<StoredProposal> = {}): StoredProposal {
  return {
    id: 'proposal-1', userId: USER_A, targetDomain: 'income', sourceKind: 'payslip',
    sourcePayrollEventId: 'payroll-1', targetEntityId: 'income-1', status: 'ready',
    currencyCode: 'AUD', fields: [field('amount', '5200.00', '5000.00')],
    ...overrides,
  };
}

describe('FDH-9 income bridge — add new (spec section 35)', () => {
  it('no existing match: creates exactly one new Income record with provenance', async () => {
    const store = new ImportBridgeMemoryStore();
    store.addProposal(proposal({
      id: 'p-new', targetEntityId: null, recommendedApplyMode: undefined as never,
      fields: [
        field('source_name', 'Salary — Beta', null),
        field('income_type', 'salary', null),
        field('amount', '4000.00', null),
        field('frequency', 'monthly', null),
        field('currency_code', 'AUD', null),
      ],
    }));

    const result = await applyImportProposal(
      store, incomeAdapter, USER_A,
      { proposalId: 'p-new', decision: 'add_new', selectedFields: ['source_name', 'income_type', 'amount', 'frequency', 'currency_code'] },
      newIncomeRowDefaults,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe('applied');
    expect(store.incomeRows.size).toBe(1);
    expect(store.applications).toHaveLength(1);
    const created = store.incomeRows.get(result.targetEntityId!);
    expect(created?.source_type).toBe('payslip_import');

    // Repeated Apply must not duplicate Income (idempotency, spec section 40).
    const second = await applyImportProposal(
      store, incomeAdapter, USER_A,
      { proposalId: 'p-new', decision: 'add_new', selectedFields: ['source_name', 'income_type', 'amount', 'frequency', 'currency_code'] },
      newIncomeRowDefaults,
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('ALREADY_APPLIED');
    expect(store.incomeRows.size).toBe(1);
  });
});

describe('FDH-9 income bridge — update existing (spec section 36)', () => {
  it('same employer: atomic update, no duplicate Income record created', async () => {
    const store = new ImportBridgeMemoryStore();
    store.addIncome(baseIncomeRow());
    store.addProposal(proposal());

    const result = await applyImportProposal(
      store, incomeAdapter, USER_A,
      { proposalId: 'proposal-1', decision: 'update_existing', selectedFields: [] },
      newIncomeRowDefaults,
    );
    expect(result.ok).toBe(true);
    expect(store.incomeRows.size).toBe(1);
    expect(store.incomeRows.get('income-1')?.amount).toBe(5200);
  });
});

describe('FDH-9 income bridge — keep existing (spec section 37)', () => {
  it('user rejects: Income unchanged, proposal resolved (dismissed)', async () => {
    const store = new ImportBridgeMemoryStore();
    const original = store.addIncome(baseIncomeRow());
    store.addProposal(proposal());

    const result = await applyImportProposal(
      store, incomeAdapter, USER_A,
      { proposalId: 'proposal-1', decision: 'keep_existing', selectedFields: [] },
      newIncomeRowDefaults,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe('kept_existing');
    expect(store.incomeRows.get('income-1')).toEqual(original);
    expect(store.registerWrites).toHaveLength(0);
    expect(store.proposals.get('proposal-1')?.status).toBe('dismissed');
  });
});

describe('FDH-9 income bridge — selected fields only (spec section 38)', () => {
  it('amount approved, frequency not approved: amount changes, frequency untouched', async () => {
    const store = new ImportBridgeMemoryStore();
    store.addIncome(baseIncomeRow({ frequency: 'monthly' }));
    store.addProposal(proposal({
      fields: [
        field('amount', '5200.00', '5000.00'),
        field('frequency', 'fortnightly', 'monthly', { requiresConfirmation: true }),
      ],
    }));

    const result = await applyImportProposal(
      store, incomeAdapter, USER_A,
      { proposalId: 'proposal-1', decision: 'apply_selected_fields', selectedFields: ['amount'] },
      newIncomeRowDefaults,
    );
    expect(result.ok).toBe(true);
    const row = store.incomeRows.get('income-1');
    expect(row?.amount).toBe(5200);
    expect(row?.frequency).toBe('monthly'); // untouched
  });
});

describe('FDH-9 income bridge — stale proposal (spec section 39)', () => {
  it('Income edited after generation: STALE_PROPOSAL, no canonical overwrite', async () => {
    const store = new ImportBridgeMemoryStore();
    store.addIncome(baseIncomeRow({ amount: 5100 })); // user manually edited 5000 -> 5100
    store.addProposal(proposal()); // proposal snapshot still says existing was 5000.00

    const result = await applyImportProposal(
      store, incomeAdapter, USER_A,
      { proposalId: 'proposal-1', decision: 'apply_selected_fields', selectedFields: ['amount'] },
      newIncomeRowDefaults,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('STALE_PROPOSAL');
    expect(store.incomeRows.get('income-1')?.amount).toBe(5100); // NOT overwritten to 5200
    expect(store.registerWrites).toHaveLength(0);
  });
});

describe('FDH-9 income bridge — forbidden field allow-list (spec section 6)', () => {
  it('a field outside the Income adapter allow-list is refused even if the proposal names it', async () => {
    const store = new ImportBridgeMemoryStore();
    store.addIncome(baseIncomeRow());
    store.addProposal(proposal({
      fields: [field('master_item_key', 'forged-key', null)], // not in INCOME_APPLICABLE_FIELDS
    }));

    const result = await applyImportProposal(
      store, incomeAdapter, USER_A,
      { proposalId: 'proposal-1', decision: 'apply_selected_fields', selectedFields: ['master_item_key'] },
      newIncomeRowDefaults,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('FORBIDDEN_FIELD');
  });
});

describe('FDH-9 income bridge — cross-tenant target (spec section 24)', () => {
  it('Tenant B cannot apply Tenant A\'s proposal (ownership scoped at load)', async () => {
    const store = new ImportBridgeMemoryStore();
    store.addIncome(baseIncomeRow());
    store.addProposal(proposal());

    const result = await applyImportProposal(
      store, incomeAdapter, USER_B,
      { proposalId: 'proposal-1', decision: 'apply_selected_fields', selectedFields: ['amount'] },
      newIncomeRowDefaults,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PROPOSAL_NOT_FOUND'); // same answer as "does not exist" — no tenant leak
    expect(store.incomeRows.get('income-1')?.amount).toBe(5000);
  });

  it('a proposal forged to target another tenant\'s Income row cannot read/write it', async () => {
    const store = new ImportBridgeMemoryStore();
    store.addIncome(baseIncomeRow({ id: 'income-b', user_id: USER_B }));
    // Tenant A's own proposal, but target_entity_id forged to point at B's income row.
    store.addProposal(proposal({ targetEntityId: 'income-b' }));

    const result = await applyImportProposal(
      store, incomeAdapter, USER_A,
      { proposalId: 'proposal-1', decision: 'apply_selected_fields', selectedFields: ['amount'] },
      newIncomeRowDefaults,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TARGET_NOT_FOUND');
  });
});

describe('FDH-9 income bridge — duplicate apply is refused by the store\'s own uniqueness (spec section 40)', () => {
  it('claiming twice is impossible even if application insert were attempted twice', async () => {
    const store = new ImportBridgeMemoryStore();
    store.addIncome(baseIncomeRow());
    store.addProposal(proposal());

    const first = await applyImportProposal(
      store, incomeAdapter, USER_A,
      { proposalId: 'proposal-1', decision: 'apply_selected_fields', selectedFields: ['amount'] },
      newIncomeRowDefaults,
    );
    expect(first.ok).toBe(true);

    const second = await applyImportProposal(
      store, incomeAdapter, USER_A,
      { proposalId: 'proposal-1', decision: 'apply_selected_fields', selectedFields: ['amount'] },
      newIncomeRowDefaults,
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('ALREADY_APPLIED');
    expect(store.applications).toHaveLength(1);
  });
});

describe('FDH-9 income bridge — duplicate employer detection (spec section 29)', () => {
  it('finds an existing Income entry for the same employer by folded name', () => {
    const existing: ExistingIncomeRow[] = [{
      id: 'income-1', source_name: 'Salary — Acme Pty Ltd', income_type: 'salary', amount: 5000,
      net_amount: null, frequency: 'monthly', currency_code: 'AUD', owner: 'self', is_taxable: true,
      employer_name: 'Acme Pty Ltd', notes: null, master_item_key: null,
    }];
    const draft = incomeAdapter.buildProposal({
      payrollEventId: 'evt-1', employerName: 'ACME PTY LTD', currencyCode: 'AUD',
      canonicalFrequency: 'monthly', frequencyStated: true, grossPay: 5200,
      reimbursementsIncludedInGross: false, reviewReasons: [], bankMatchStatus: 'not_attempted',
    }, existing);
    expect(draft.recommendedApplyMode).toBe('update_existing');
    expect(draft.targetEntityId).toBe('income-1');
  });
});
