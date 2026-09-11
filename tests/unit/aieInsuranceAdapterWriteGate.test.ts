/**
 * AIE-1.4 — Insurance adapter: gated canonical write tests (execution
 * sequence step 6/AIE14-INS-12).
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { acceptAndWriteInsuranceCandidates, buildInsurancePolicyRow, type AcceptAndWriteInsuranceDeps, type AcceptAndWriteInsuranceInput } from '@/lib/aie/adapters/insurance/write';
import { isInsuranceAdapterCanonicalWriteEnabled } from '@/lib/aie/adapters/insurance/featureFlags';
import { parseInsuranceDocument } from '@/lib/aie/adapters/insurance/parser';
import { buildAieInsuranceFixtureText } from '../support/buildAieInsuranceFixtureText';
import type { AieFieldCandidate } from '@/lib/aie/types';

const cleanCandidates: readonly AieFieldCandidate[] = parseInsuranceDocument(buildAieInsuranceFixtureText()).candidates;

function baseInput(overrides: Partial<AcceptAndWriteInsuranceInput> = {}): AcceptAndWriteInsuranceInput {
  return {
    aieIntakeId: 'intake-1',
    aieRunId: 'run-1',
    userId: 'user-1',
    ownerHouseholdRole: 'self',
    candidates: cleanCandidates,
    acceptedByUserId: 'user-1',
    reconciliationOutcome: 'pass',
    hasOpenBlockingUnresolvedItems: false,
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<AcceptAndWriteInsuranceDeps> = {}): { deps: AcceptAndWriteInsuranceDeps; calls: Record<string, number>; savedRows: Record<string, unknown>[] } {
  const calls: Record<string, number> = { findExistingLink: 0, save: 0, link: 0 };
  const savedRows: Record<string, unknown>[] = [];
  const deps: AcceptAndWriteInsuranceDeps = {
    findExistingLink: async () => {
      calls.findExistingLink++;
      return null;
    },
    saveInsurancePolicy: async (_userId, row) => {
      calls.save++;
      savedRows.push(row);
      return { id: 'policy-1' };
    },
    recordLink: async () => {
      calls.link++;
      return { ok: true };
    },
    ...overrides,
  };
  return { deps, calls, savedRows };
}

describe('AIE-1.4 Insurance adapter — gated canonical write', () => {
  const originalFlag = process.env.AIE_INSURANCE_ADAPTER_CANONICAL_WRITE_ENABLED;
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.AIE_INSURANCE_ADAPTER_CANONICAL_WRITE_ENABLED;
    else process.env.AIE_INSURANCE_ADAPTER_CANONICAL_WRITE_ENABLED = originalFlag;
  });

  it('defaults OFF — the flag reads false when the env var is unset (production-safe default, P9)', () => {
    delete process.env.AIE_INSURANCE_ADAPTER_CANONICAL_WRITE_ENABLED;
    expect(isInsuranceAdapterCanonicalWriteEnabled()).toBe(false);
  });

  it('GATE 1: refuses when the feature flag is OFF, before touching any dependency', async () => {
    delete process.env.AIE_INSURANCE_ADAPTER_CANONICAL_WRITE_ENABLED;
    const { deps, calls } = fakeDeps();
    const result = await acceptAndWriteInsuranceCandidates(baseInput(), deps);
    expect(result).toEqual({ ok: false, reason: 'feature_flag_disabled' });
    expect(calls.findExistingLink).toBe(0);
    expect(calls.save).toBe(0);
  });

  describe('with the flag ON', () => {
    beforeEach(() => {
      process.env.AIE_INSURANCE_ADAPTER_CANONICAL_WRITE_ENABLED = 'true';
    });

    it('GATE 2: refuses on a FAILED reconciliation outcome, even with the flag on', async () => {
      const { deps, calls } = fakeDeps();
      const result = await acceptAndWriteInsuranceCandidates(baseInput({ reconciliationOutcome: 'fail' }), deps);
      expect(result).toEqual({ ok: false, reason: 'reconciliation_not_passed' });
      expect(calls.save).toBe(0);
    });

    it('GATE 2: refuses on an INDETERMINATE reconciliation outcome', async () => {
      const { deps } = fakeDeps();
      const result = await acceptAndWriteInsuranceCandidates(baseInput({ reconciliationOutcome: 'indeterminate' }), deps);
      expect(result).toEqual({ ok: false, reason: 'reconciliation_not_passed' });
    });

    it('GATE 2: refuses on a NOT_APPLICABLE reconciliation outcome', async () => {
      const { deps } = fakeDeps();
      const result = await acceptAndWriteInsuranceCandidates(baseInput({ reconciliationOutcome: 'not_applicable' }), deps);
      expect(result).toEqual({ ok: false, reason: 'reconciliation_not_passed' });
    });

    it('accepts PASS_WITH_TOLERANCE (P4 — a tolerance-passed reconciliation is still a pass, never downgraded)', async () => {
      const { deps } = fakeDeps();
      const result = await acceptAndWriteInsuranceCandidates(baseInput({ reconciliationOutcome: 'pass_with_tolerance' }), deps);
      expect(result.ok).toBe(true);
    });

    it('GATE 3: refuses while a blocking unresolved item remains open', async () => {
      const { deps, calls } = fakeDeps();
      const result = await acceptAndWriteInsuranceCandidates(baseInput({ hasOpenBlockingUnresolvedItems: true }), deps);
      expect(result).toEqual({ ok: false, reason: 'unresolved_items_open' });
      expect(calls.save).toBe(0);
    });

    it('IDEMPOTENCY: refuses (does not re-write) when a link already exists for this run', async () => {
      const { deps, calls } = fakeDeps({ findExistingLink: async () => ({ insurancePolicyId: 'existing-policy' }) });
      const result = await acceptAndWriteInsuranceCandidates(baseInput(), deps);
      expect(result).toEqual({ ok: false, reason: 'already_written', insurancePolicyId: 'existing-policy' });
      expect(calls.save).toBe(0);
    });

    it('refuses with schema_validation_failed when required canonical fields are missing from the candidate set', async () => {
      const incomplete = cleanCandidates.filter((c) => c.fieldName !== 'coverAmount');
      const { deps } = fakeDeps();
      const result = await acceptAndWriteInsuranceCandidates(baseInput({ candidates: incomplete }), deps);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('schema_validation_failed');
    });

    it('SUCCESS: calls save exactly once, then records the link, and returns the new policy id', async () => {
      const { deps, calls, savedRows } = fakeDeps();
      const result = await acceptAndWriteInsuranceCandidates(baseInput(), deps);
      expect(result).toEqual({ ok: true, insurancePolicyId: 'policy-1' });
      expect(calls.save).toBe(1);
      expect(calls.link).toBe(1);
      expect(savedRows[0]).toMatchObject({ policy_name: 'Acme SecureLife Term Cover', owner: 'self', currency_code: 'AUD' });
    });

    it('OWNER IS NEVER DERIVED FROM DOCUMENT TEXT: the written row\'s `owner` is always exactly the caller-supplied `ownerHouseholdRole`, regardless of policyOwnerName/insuredPersonName evidence on the document', async () => {
      const { deps, savedRows } = fakeDeps();
      await acceptAndWriteInsuranceCandidates(baseInput({ ownerHouseholdRole: 'spouse' }), deps);
      expect(savedRows[0].owner).toBe('spouse');
      // The document's own evidence names ("John Smith"/"Jane Smith") never
      // appear anywhere in the written row.
      expect(Object.values(savedRows[0])).not.toContain('John Smith');
      expect(Object.values(savedRows[0])).not.toContain('Jane Smith');
    });

    it('propagates a save failure honestly rather than reporting success', async () => {
      const { deps } = fakeDeps({ saveInsurancePolicy: async () => ({ error: 'db write failed' }) });
      const result = await acceptAndWriteInsuranceCandidates(baseInput(), deps);
      expect(result).toEqual({ ok: false, reason: 'insurance_policy_save_failed', message: 'db write failed' });
    });
  });
});

describe('AIE-1.4 Insurance adapter — buildInsurancePolicyRow()', () => {
  it('never includes evidence-only fields (masked policy number, names, exclusions, excess) — no column exists for them', () => {
    const row = buildInsurancePolicyRow(cleanCandidates, 'self', null, null);
    const keys = Object.keys(row);
    for (const forbidden of ['policyNumberMasked', 'policyOwnerName', 'insuredPersonName', 'beneficiaryName', 'exclusionsText', 'excessAmount', 'printedAnnualPremiumTotal', 'documentSubClass']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});
