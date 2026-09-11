import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { acceptAndWriteInvestmentCandidates, type AcceptAndWriteDeps, type AcceptAndWriteInput } from '@/lib/aie/adapters/investment-intelligence/write';
import { isIiAdapterCanonicalWriteEnabled } from '@/lib/aie/adapters/investment-intelligence/featureFlags';

function baseInput(overrides: Partial<AcceptAndWriteInput> = {}): AcceptAndWriteInput {
  return {
    aieIntakeId: 'intake-1',
    aieRunId: 'run-1',
    userId: 'user-1',
    ownerMemberId: 'member-1',
    countryCode: 'IN',
    originalFilename: 'statement.pdf',
    declaredMimeType: 'application/pdf',
    quarantineStorageKey: 'user-1/intake-1',
    acceptedByUserId: 'user-1',
    reconciliationOutcome: 'pass',
    hasOpenBlockingUnresolvedItems: false,
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<AcceptAndWriteDeps> = {}): { deps: AcceptAndWriteDeps; calls: Record<string, number> } {
  const calls: Record<string, number> = { findExistingLink: 0, download: 0, upload: 0, insert: 0, process: 0, link: 0 };
  const deps: AcceptAndWriteDeps = {
    findExistingLink: async () => {
      calls.findExistingLink++;
      return null;
    },
    downloadQuarantined: async () => {
      calls.download++;
      return { ok: true, bytes: new Uint8Array([1, 2, 3]) };
    },
    uploadToIiStorage: async () => {
      calls.upload++;
      return { error: null };
    },
    insertSourceDocument: async () => {
      calls.insert++;
      return { id: 'ii-doc-1' };
    },
    processDocument: async () => {
      calls.process++;
      return { ok: true, status: 'parsed', parseRunId: 'parse-run-1', error: null };
    },
    recordLink: async () => {
      calls.link++;
      return { ok: true };
    },
    ...overrides,
  };
  return { deps, calls };
}

describe('AIE-1.2 — gated canonical write (execution sequence step 11)', () => {
  const originalFlag = process.env.AIE_II_ADAPTER_CANONICAL_WRITE_ENABLED;
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.AIE_II_ADAPTER_CANONICAL_WRITE_ENABLED;
    else process.env.AIE_II_ADAPTER_CANONICAL_WRITE_ENABLED = originalFlag;
  });

  it('defaults OFF — the flag reads false when the env var is unset (production-safe default, P9)', () => {
    delete process.env.AIE_II_ADAPTER_CANONICAL_WRITE_ENABLED;
    expect(isIiAdapterCanonicalWriteEnabled()).toBe(false);
  });

  it('GATE 1: refuses when the feature flag is OFF, before touching any dependency', async () => {
    delete process.env.AIE_II_ADAPTER_CANONICAL_WRITE_ENABLED;
    const { deps, calls } = fakeDeps();
    const result = await acceptAndWriteInvestmentCandidates(baseInput(), deps);
    expect(result).toEqual({ ok: false, reason: 'feature_flag_disabled' });
    expect(calls.findExistingLink).toBe(0);
    expect(calls.process).toBe(0);
  });

  describe('with the flag ON', () => {
    beforeEach(() => {
      process.env.AIE_II_ADAPTER_CANONICAL_WRITE_ENABLED = 'true';
    });

    it('GATE 2: refuses on a FAILED reconciliation outcome, even with the flag on', async () => {
      const { deps, calls } = fakeDeps();
      const result = await acceptAndWriteInvestmentCandidates(baseInput({ reconciliationOutcome: 'fail' }), deps);
      expect(result).toEqual({ ok: false, reason: 'reconciliation_not_passed' });
      expect(calls.process).toBe(0);
    });

    it('GATE 2: refuses on an INDETERMINATE reconciliation outcome — never a confidence-based override (P4)', async () => {
      const { deps } = fakeDeps();
      const result = await acceptAndWriteInvestmentCandidates(baseInput({ reconciliationOutcome: 'indeterminate' }), deps);
      expect(result).toEqual({ ok: false, reason: 'reconciliation_not_passed' });
    });

    it('GATE 3: refuses while a blocking unresolved item is still open, even with a passing reconciliation outcome', async () => {
      const { deps, calls } = fakeDeps();
      const result = await acceptAndWriteInvestmentCandidates(baseInput({ hasOpenBlockingUnresolvedItems: true }), deps);
      expect(result).toEqual({ ok: false, reason: 'unresolved_items_open' });
      expect(calls.process).toBe(0);
    });

    it('IDEMPOTENCY: a second acceptance for the same run finds the existing link and never re-writes', async () => {
      const { deps, calls } = fakeDeps({ findExistingLink: async () => ({ iiSourceDocumentId: 'already-written-doc' }) });
      const result = await acceptAndWriteInvestmentCandidates(baseInput(), deps);
      expect(result).toEqual({ ok: false, reason: 'already_written', iiSourceDocumentId: 'already-written-doc' });
      expect(calls.download).toBe(0);
      expect(calls.process).toBe(0);
    });

    it('POSITIVE: all gates satisfied — creates exactly one ii_source_documents row and delegates the ENTIRE canonical write to the existing processSourceDocument service', async () => {
      const { deps, calls } = fakeDeps();
      const result = await acceptAndWriteInvestmentCandidates(baseInput(), deps);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.iiSourceDocumentId).toBe('ii-doc-1');
        expect(result.iiResult.ok).toBe(true);
      }
      expect(calls.download).toBe(1);
      expect(calls.upload).toBe(1);
      expect(calls.insert).toBe(1);
      expect(calls.link).toBe(1);
      expect(calls.process).toBe(1); // exactly once — no direct-to-table write happens alongside it
    });

    it('a quarantine download failure is reported honestly, never silently treated as an empty document', async () => {
      const { deps } = fakeDeps({ downloadQuarantined: async () => ({ ok: false, message: 'not found' }) });
      const result = await acceptAndWriteInvestmentCandidates(baseInput(), deps);
      expect(result).toEqual({ ok: false, reason: 'quarantine_download_failed', message: 'not found' });
    });
  });
});
