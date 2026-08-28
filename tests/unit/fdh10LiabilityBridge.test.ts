/**
 * FDH-10 — certifies `applyImportProposal()` for the LIABILITY domain against
 * adversarial inputs, without a database, using the same in-memory store
 * discipline `fdh9IncomeBridge.test.ts` established (see
 * `tests/support/importBridgeMemoryStore.ts`'s header). Defense in depth: the
 * real security boundary is migration 0096's `fdh10_apply_liability_proposal`
 * RPC; this suite proves the TypeScript guard enforces the identical rules.
 *
 * Covers spec section 58's full liability-bridge matrix: no-existing-
 * liability -> add-new, same-facility -> update-existing, keep-existing,
 * apply-selected-fields, no-apply, stale, duplicate-apply, concurrent-apply,
 * cross-tenant-target, forbidden field.
 */
import { describe, expect, it } from 'vitest';
import { applyImportProposal, type StoredProposal } from '@/lib/import-bridge/applyService';
import { liabilityAdapter, newLiabilityRowDefaults, findDuplicateLiability, type ExistingLiabilityRow, type LiabilityEvidence } from '@/lib/import-bridge/adapters/liabilityAdapter';
import { ImportBridgeMemoryStore, type MemoryLiabilityRow } from '../support/importBridgeMemoryStore';
import type { ProposedField } from '@/lib/import-bridge/types';

const USER_A = 'user-a';
const USER_B = 'user-b';

function field(fieldName: string, proposedValue: string | null, existingValue: string | null, overrides: Partial<ProposedField> = {}): ProposedField {
  const moneyFields = new Set(['balance', 'interest_rate', 'monthly_repayment', 'credit_limit', 'minimum_payment']);
  return {
    fieldName,
    valueKind: moneyFields.has(fieldName) ? 'money' : 'text',
    proposedValue,
    existingValue,
    isRecommended: true,
    requiresConfirmation: false,
    reasonCode: 'test',
    ...overrides,
  };
}

function baseLiabilityRow(overrides: Partial<MemoryLiabilityRow> = {}): MemoryLiabilityRow {
  return {
    id: 'liability-1', user_id: USER_A, liability_name: 'Card — Big Bank', debt_type: 'credit_card',
    balance: 1200, interest_rate: null, monthly_repayment: 50, currency_code: 'AUD', country_code: 'AU',
    lender: 'Big Bank', credit_limit: 5000, masked_identifier: '****1234', minimum_payment: 50, due_date: null,
    owner: 'self', is_active: true, source_type: 'manual',
    ...overrides,
  };
}

function proposal(overrides: Partial<StoredProposal> = {}): StoredProposal {
  return {
    id: 'proposal-1', userId: USER_A, targetDomain: 'liability', sourceKind: 'credit_card_statement',
    sourcePayrollEventId: null, targetEntityId: 'liability-1', status: 'ready',
    currencyCode: 'AUD', fields: [field('balance', '1500.00', '1200.00')],
    ...overrides,
  };
}

describe('FDH-10 liability bridge — add new (spec section 58)', () => {
  it('no existing liability: creates exactly one new liability with provenance', async () => {
    const store = new ImportBridgeMemoryStore();
    store.addProposal(proposal({
      id: 'p-new', targetEntityId: null,
      fields: [
        field('liability_name', 'Credit Card — Beta Bank', null),
        field('debt_type', 'credit_card', null),
        field('currency_code', 'AUD', null),
        field('balance', '800.00', null),
      ],
    }));

    const result = await applyImportProposal(
      store, liabilityAdapter, USER_A,
      { proposalId: 'p-new', decision: 'add_new', selectedFields: ['liability_name', 'debt_type', 'currency_code', 'balance'] },
      newLiabilityRowDefaults,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe('applied');
    expect(store.liabilityRows.size).toBe(1);
    expect(store.applications).toHaveLength(1);
    const created = store.liabilityRows.get(result.targetEntityId!);
    expect(created?.source_type).toBe('liability_statement_import');
    expect(created?.balance).toBe(800);

    // Idempotency (spec section 58): repeated Apply must not duplicate.
    const second = await applyImportProposal(
      store, liabilityAdapter, USER_A,
      { proposalId: 'p-new', decision: 'add_new', selectedFields: ['liability_name', 'debt_type', 'currency_code', 'balance'] },
      newLiabilityRowDefaults,
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('ALREADY_APPLIED');
    expect(store.liabilityRows.size).toBe(1); // still exactly one row
  });

  it('rejects a new liability missing a required field (spec section 58 domain validation)', async () => {
    const store = new ImportBridgeMemoryStore();
    store.addProposal(proposal({
      id: 'p-incomplete', targetEntityId: null,
      fields: [field('liability_name', 'Credit Card — Beta Bank', null)],
    }));
    const result = await applyImportProposal(
      store, liabilityAdapter, USER_A,
      { proposalId: 'p-incomplete', decision: 'add_new', selectedFields: ['liability_name'] },
      newLiabilityRowDefaults,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('DOMAIN_VALIDATION_FAILED');
    expect(store.liabilityRows.size).toBe(0);
  });
});

describe('FDH-10 liability bridge — update existing (spec section 58)', () => {
  it('updates the matched liability and stamps provenance', async () => {
    const store = new ImportBridgeMemoryStore();
    store.addLiability(baseLiabilityRow());
    store.addProposal(proposal());

    const result = await applyImportProposal(
      store, liabilityAdapter, USER_A,
      { proposalId: 'proposal-1', decision: 'update_existing', selectedFields: [] },
      newLiabilityRowDefaults,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const updated = store.liabilityRows.get('liability-1');
    expect(updated?.balance).toBe(1500);
    expect(updated?.last_import_application_id).toBe(result.applicationId);
  });

  it('KEEP EXISTING writes nothing to the canonical liability (spec section 58)', async () => {
    const store = new ImportBridgeMemoryStore();
    const original = store.addLiability(baseLiabilityRow());
    store.addProposal(proposal());

    const result = await applyImportProposal(
      store, liabilityAdapter, USER_A,
      { proposalId: 'proposal-1', decision: 'keep_existing', selectedFields: [] },
      newLiabilityRowDefaults,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toBe('kept_existing');
    expect(store.registerWrites).toHaveLength(0); // NO write of any kind
    expect(store.liabilityRows.get('liability-1')).toEqual(original);
  });

  it('APPLY SELECTED FIELDS applies only the ticked field, leaving others untouched', async () => {
    const store = new ImportBridgeMemoryStore();
    store.addLiability(baseLiabilityRow());
    store.addProposal(proposal({
      fields: [
        field('balance', '1500.00', '1200.00'),
        field('monthly_repayment', '75.00', '50.00'),
      ],
    }));

    const result = await applyImportProposal(
      store, liabilityAdapter, USER_A,
      { proposalId: 'proposal-1', decision: 'apply_selected_fields', selectedFields: ['balance'] },
      newLiabilityRowDefaults,
    );
    expect(result.ok).toBe(true);
    const updated = store.liabilityRows.get('liability-1');
    expect(updated?.balance).toBe(1500);
    expect(updated?.monthly_repayment).toBe(50); // untouched
  });

  it('FORBIDDEN FIELD: a field outside the allow-list can never be written (spec section 53)', async () => {
    const store = new ImportBridgeMemoryStore();
    store.addLiability(baseLiabilityRow());
    // Simulates a forged/corrupted proposal row naming a column the adapter
    // never permits (e.g. attempting to directly set is_active).
    store.addProposal(proposal({
      fields: [field('is_active', 'false', 'true')],
    }));

    const result = await applyImportProposal(
      store, liabilityAdapter, USER_A,
      { proposalId: 'proposal-1', decision: 'apply_selected_fields', selectedFields: ['is_active'] },
      newLiabilityRowDefaults,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('FORBIDDEN_FIELD');
    expect(store.registerWrites).toHaveLength(0);
  });

  it('STALE PROPOSAL: a liability edited after proposal generation is not silently overwritten', async () => {
    const store = new ImportBridgeMemoryStore();
    store.addLiability(baseLiabilityRow({ balance: 1300 })); // user already changed it from 1200
    store.addProposal(proposal()); // proposal still thinks existing balance is 1200.00

    const result = await applyImportProposal(
      store, liabilityAdapter, USER_A,
      { proposalId: 'proposal-1', decision: 'update_existing', selectedFields: [] },
      newLiabilityRowDefaults,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('STALE_PROPOSAL');
    expect(store.liabilityRows.get('liability-1')?.balance).toBe(1300); // untouched
  });

  it('DUPLICATE APPLY / CONCURRENT APPLY: exactly one mutation, one application record', async () => {
    const store = new ImportBridgeMemoryStore();
    store.addLiability(baseLiabilityRow());
    store.addProposal(proposal());

    const [first, second] = await Promise.all([
      applyImportProposal(store, liabilityAdapter, USER_A, { proposalId: 'proposal-1', decision: 'update_existing', selectedFields: [] }, newLiabilityRowDefaults),
      applyImportProposal(store, liabilityAdapter, USER_A, { proposalId: 'proposal-1', decision: 'update_existing', selectedFields: [] }, newLiabilityRowDefaults),
    ]);
    const outcomes = [first, second].map((r) => r.ok);
    expect(outcomes.filter(Boolean)).toHaveLength(1); // exactly one succeeded
    expect(store.applications).toHaveLength(1);
  });

  it('CROSS-TENANT TARGET: Tenant B cannot apply against Tenant A\'s liability or proposal', async () => {
    const store = new ImportBridgeMemoryStore();
    store.addLiability(baseLiabilityRow({ user_id: USER_A }));
    store.addProposal(proposal({ userId: USER_A }));

    const result = await applyImportProposal(
      store, liabilityAdapter, USER_B, // Tenant B calling with their own auth'd id
      { proposalId: 'proposal-1', decision: 'update_existing', selectedFields: [] },
      newLiabilityRowDefaults,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PROPOSAL_NOT_FOUND'); // same answer as "does not exist" — no information leak
    expect(store.liabilityRows.get('liability-1')?.user_id).toBe(USER_A); // untouched
  });

  it('NO APPLY: upload/parse/review/approve leaves the liability unchanged until Apply', async () => {
    const store = new ImportBridgeMemoryStore();
    const original = store.addLiability(baseLiabilityRow());
    store.addProposal(proposal());
    // Nothing is called here except loading the proposal for preview — no apply.
    const loaded = await store.loadProposal(USER_A, 'proposal-1');
    expect(loaded).not.toBeNull();
    expect(store.liabilityRows.get('liability-1')).toEqual(original);
    expect(store.registerWrites).toHaveLength(0);
  });
});

describe('FDH-10 liability bridge — findDuplicateLiability (this is the function buildProposal()/generateLiabilityProposal() actually calls -- spec sections 50-52, 59-60)', () => {
  function existingRow(overrides: Partial<ExistingLiabilityRow> = {}): ExistingLiabilityRow {
    return {
      id: 'liability-mortgage', liability_name: 'Test Bank Home Loan', debt_type: 'mortgage', balance: 420000,
      interest_rate: null, monthly_repayment: 0, currency_code: 'AUD', country_code: 'AU',
      lender: 'Test Bank', credit_limit: null, masked_identifier: 'XX724A', minimum_payment: null, due_date: null,
      ...overrides,
    };
  }
  function evidence(overrides: Partial<LiabilityEvidence> = {}): LiabilityEvidence {
    return {
      statementId: 'stmt-1', facilityType: 'home_loan', institutionName: 'Test Bank', maskedIdentifier: 'XX4001',
      currencyCode: 'AUD', reviewReasons: [], ...overrides,
    };
  }

  it('FIX (live-DEV final certification round): a statement whose masked identifier matches NOTHING must never fall back to an existing liability that ALREADY has its own (different) masked identifier on file', () => {
    // Genuinely reproduced live: this is the SAME class of bug as
    // facilityMatching.ts's matchLiabilityFacility (see that file's fix
    // note), but in a SEPARATE in-line duplicate of the same algorithm --
    // `matchExistingLiability()` in this file -- which is the one actually
    // consulted by buildProposal(). Fixing only facilityMatching.ts's copy
    // (which has no real caller) did NOT close the live gap; this copy
    // needed the identical fix. Before it: an AU generic loan statement that
    // is really about an unrelated personal loan, sharing only the SAME
    // lender name as an existing, already-identified mortgage, silently
    // matched that mortgage and its balance was overwritten.
    const result = findDuplicateLiability(evidence(), [existingRow()]);
    expect(result.outcome).toBe('no_match');
    expect(result.liabilityId).toBeNull();
  });

  it('FIX negative control: the institution fallback still works for a genuinely legacy liability with NO masked identifier on file (the fallback\'s own original purpose)', () => {
    const result = findDuplicateLiability(evidence(), [existingRow({ masked_identifier: null })]);
    expect(result.outcome).toBe('single_match');
    expect(result.liabilityId).toBe('liability-mortgage');
  });

  it('a masked-identifier match still resolves directly (Tier 1, unaffected by the fix)', () => {
    const result = findDuplicateLiability(evidence({ maskedIdentifier: 'XX724A' }), [existingRow()]);
    expect(result.outcome).toBe('single_match');
    expect(result.liabilityId).toBe('liability-mortgage');
  });
});

describe('FDH-10 liability bridge — target-domain isolation (spec section 6)', () => {
  it('a liability adapter cannot be used to apply an income-domain proposal', async () => {
    const store = new ImportBridgeMemoryStore();
    store.addProposal(proposal({ targetDomain: 'income' }));
    const result = await applyImportProposal(
      store, liabilityAdapter, USER_A,
      { proposalId: 'proposal-1', decision: 'update_existing', selectedFields: [] },
      newLiabilityRowDefaults,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PROPOSAL_NOT_ACTIONABLE');
  });
});
