/**
 * AIE-1.5 — the single most safety-critical function in this phase:
 * "no accept-anyway for material failed/indeterminate reconciliation" must
 * be structurally impossible, not merely untested. Every gate is exercised
 * here with fully injected, in-memory deps (no database) — matching
 * `tests/unit/aieOrchestrator.test.ts`'s established `fakeDeps` pattern.
 */
import { describe, it, expect, vi } from 'vitest';
import { acceptRun, type AcceptRunDeps } from '@/lib/aie/review/accept';
import type { AieRunRow } from '@/lib/aie/db/repository';

function baseRun(overrides: Partial<AieRunRow> = {}): AieRunRow {
  return { id: 'run-1', intakeId: 'intake-1', userId: 'user-1', status: 'awaiting_acceptance', aiUsed: false, startedAt: new Date().toISOString(), ...overrides };
}

function fakeDeps(overrides: Partial<AcceptRunDeps> = {}): { deps: AcceptRunDeps; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { transitions: [], batches: [], writes: [], audits: [] };
  const deps: AcceptRunDeps = {
    isCanonicalAcceptanceEnabled: () => true,
    getRunForUser: async () => baseRun(),
    getAdapterIdForRun: async () => 'insurance_generic_schedule_v1',
    getIntakeUploadMetadata: async () => null,
    countItemsBlockingAcceptanceForRun: async () => 0,
    latestReconciliationOutcomesForRun: async () => [{ ruleId: 'insurance_required_fields_present', outcome: 'pass' }],
    listFieldCandidatesForRun: async () => [],
    listLatestCorrectionsForRun: async () => [],
    transitionRunStatusCas: async (p) => {
      calls.transitions.push(p);
      return true;
    },
    findOrCreateWriteBatch: async (p) => {
      calls.batches.push(p);
      return { id: 'batch-1', status: 'pending' };
    },
    markWriteBatchStatus: async (id, status) => {
      calls.batches.push({ mark: id, status });
    },
    audit: async (e) => {
      calls.audits.push(e);
    },
    acceptAndWriteInsurance: async (input) => {
      calls.writes.push(input);
      return { ok: true, insurancePolicyId: 'policy-1' };
    },
    insuranceWriteDeps: {} as AcceptRunDeps['insuranceWriteDeps'],
    acceptAndWriteInvestment: async (input) => {
      calls.writes.push(input);
      return { ok: true, iiSourceDocumentId: 'ii-doc-1', iiResult: { ok: true, status: 'parsed', parseRunId: 'parse-run-1', error: null } };
    },
    investmentWriteDeps: {} as AcceptRunDeps['investmentWriteDeps'],
    ...overrides,
  };
  return { deps, calls };
}

const baseParams = { runId: 'run-1', userId: 'user-1', acceptedByUserId: 'user-1', ownerHouseholdRole: 'self' as const, idempotencyKey: 'run-1:accept:1' };

describe('AIE-1.5 accept.ts — acceptRun', () => {
  it('refuses when the canonical-acceptance feature flag is off, before touching the database', async () => {
    const { deps, calls } = fakeDeps({ isCanonicalAcceptanceEnabled: () => false, getRunForUser: vi.fn() as unknown as AcceptRunDeps['getRunForUser'] });
    const outcome = await acceptRun(baseParams, deps);
    expect(outcome).toEqual({ ok: false, reason: 'feature_flag_disabled' });
    expect(deps.getRunForUser).not.toHaveBeenCalled();
    expect(calls.writes).toHaveLength(0);
  });

  it('returns not_found for a run that does not belong to this user (or does not exist)', async () => {
    const { deps } = fakeDeps({ getRunForUser: async () => null });
    expect(await acceptRun(baseParams, deps)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('idempotent replay: an already-completed run returns ok without any further writes', async () => {
    const { deps, calls } = fakeDeps({ getRunForUser: async () => baseRun({ status: 'completed' }) });
    const outcome = await acceptRun(baseParams, deps);
    expect(outcome).toEqual({ ok: true, alreadyCompleted: true });
    expect(calls.writes).toHaveLength(0);
    expect(calls.transitions).toHaveLength(0);
  });

  it('refuses a run mid-flight (accepted/write_pending) as not_ready rather than re-running acceptance concurrently', async () => {
    const { deps, calls } = fakeDeps({ getRunForUser: async () => baseRun({ status: 'write_pending' }) });
    expect(await acceptRun(baseParams, deps)).toEqual({ ok: false, reason: 'not_ready' });
    expect(calls.writes).toHaveLength(0);
  });

  it('ACPT-02: refuses when items are still blocking, even if the run status itself is awaiting_acceptance', async () => {
    const { deps, calls } = fakeDeps({ countItemsBlockingAcceptanceForRun: async () => 1 });
    expect(await acceptRun(baseParams, deps)).toEqual({ ok: false, reason: 'items_still_blocking' });
    expect(calls.writes).toHaveLength(0);
  });

  it('ACPT-03/ACT-12: refuses on a FAIL reconciliation outcome — no accept-anyway', async () => {
    const { deps, calls } = fakeDeps({ latestReconciliationOutcomesForRun: async () => [{ ruleId: 'r', outcome: 'fail' }] });
    expect(await acceptRun(baseParams, deps)).toEqual({ ok: false, reason: 'reconciliation_not_fresh' });
    expect(calls.writes).toHaveLength(0);
  });

  it('ACPT-03: refuses on an INDETERMINATE reconciliation outcome — no accept-anyway', async () => {
    const { deps, calls } = fakeDeps({ latestReconciliationOutcomesForRun: async () => [{ ruleId: 'r', outcome: 'indeterminate' }] });
    expect(await acceptRun(baseParams, deps)).toEqual({ ok: false, reason: 'reconciliation_not_fresh' });
    expect(calls.writes).toHaveLength(0);
  });

  it('refuses on NOT_APPLICABLE — never accept a document nothing ever actually reconciled', async () => {
    const { deps, calls } = fakeDeps({ latestReconciliationOutcomesForRun: async () => [{ ruleId: 'r', outcome: 'not_applicable' }] });
    expect(await acceptRun(baseParams, deps)).toEqual({ ok: false, reason: 'reconciliation_not_fresh' });
    expect(calls.writes).toHaveLength(0);
  });

  it('accepts on PASS_WITH_TOLERANCE (a genuine, bounded-tolerance pass, not a failure)', async () => {
    const { deps } = fakeDeps({ latestReconciliationOutcomesForRun: async () => [{ ruleId: 'r', outcome: 'pass_with_tolerance' }] });
    const outcome = await acceptRun(baseParams, deps);
    expect(outcome.ok).toBe(true);
  });

  it('CONC-01/02: a lost CAS race on the FIRST transition (awaiting_acceptance -> accepted) reports stale_conflict and never calls the write service', async () => {
    const { deps, calls } = fakeDeps({ transitionRunStatusCas: async () => false });
    expect(await acceptRun(baseParams, deps)).toEqual({ ok: false, reason: 'stale_conflict' });
    expect(calls.writes).toHaveLength(0);
  });

  it('happy path: transitions accepted -> write_pending -> completed, calls the adapter write exactly once, and audits completion', async () => {
    const { deps, calls } = fakeDeps();
    const outcome = await acceptRun(baseParams, deps);
    expect(outcome).toEqual({ ok: true, alreadyCompleted: false, insurancePolicyId: 'policy-1' });
    expect(calls.writes).toHaveLength(1);
    const toStates = calls.transitions.map((t) => (t as { toStatus: string }).toStatus);
    expect(toStates).toEqual(['accepted', 'write_pending', 'completed']);
    expect(calls.audits.some((a) => (a as { eventType: string }).eventType === 'run_completed')).toBe(true);
  });

  it('FAIL-10 idempotency: a write batch already marked committed short-circuits — the write service is never called again', async () => {
    const { deps, calls } = fakeDeps({ findOrCreateWriteBatch: async () => ({ id: 'batch-1', status: 'committed' }) });
    const outcome = await acceptRun(baseParams, deps);
    expect(outcome).toEqual({ ok: true, alreadyCompleted: true });
    expect(calls.writes).toHaveLength(0);
  });

  it('"already_written" from the adapter (a genuine idempotent replay one level down) is reported as success, not failure', async () => {
    const { deps } = fakeDeps({ acceptAndWriteInsurance: async () => ({ ok: false, reason: 'already_written', insurancePolicyId: 'policy-existing' }) });
    const outcome = await acceptRun(baseParams, deps);
    expect(outcome).toEqual({ ok: true, alreadyCompleted: true, insurancePolicyId: 'policy-existing' });
  });

  it('a domain-terminal write failure (schema_validation_failed) transitions to failed_terminal, not failed_retryable', async () => {
    const { deps, calls } = fakeDeps({ acceptAndWriteInsurance: async () => ({ ok: false, reason: 'schema_validation_failed', message: 'bad row' }) });
    const outcome = await acceptRun(baseParams, deps);
    expect(outcome).toEqual({ ok: false, reason: 'write_failed', message: 'schema_validation_failed' });
    const toStates = calls.transitions.map((t) => (t as { toStatus: string }).toStatus);
    expect(toStates).toEqual(['accepted', 'write_pending', 'failed_terminal']);
  });

  it('an infrastructure-shaped write failure transitions to failed_retryable, preserving the acceptance for a safe retry (FAIL-03)', async () => {
    const { deps, calls } = fakeDeps({ acceptAndWriteInsurance: async () => ({ ok: false, reason: 'insurance_policy_save_failed', message: 'db down' }) });
    await acceptRun(baseParams, deps);
    const toStates = calls.transitions.map((t) => (t as { toStatus: string }).toStatus);
    expect(toStates).toEqual(['accepted', 'write_pending', 'failed_retryable']);
  });

  // AIE-1 merge plan section 4b / AIE_1_MERGE_PLAN.md's own follow-up fix:
  // accept.ts now dispatches to Investment Intelligence's real write.ts,
  // keyed off the run's own recorded adapter id — never defaulting to
  // Insurance for a run some other adapter actually produced.
  describe('Investment Intelligence dispatch (AIE-1.2 write.ts, via the run\'s real adapter id)', () => {
    const iiParams = { ...baseParams, ownerMemberId: 'member-1', countryCode: 'IN' };
    const iiOverrides = {
      getAdapterIdForRun: async () => 'ii_cas_kfintech_folio_v1',
      getIntakeUploadMetadata: async () => ({ storageKey: 'user-1/intake-1', declaredMimeType: 'application/pdf', displayFilename: 'statement.pdf' }),
    };

    it('reaches acceptAndWriteInvestment (not acceptAndWriteInsurance) for a run whose real adapter id is Investment Intelligence\'s', async () => {
      const insuranceWrite = vi.fn();
      const { deps, calls } = fakeDeps({ ...iiOverrides, acceptAndWriteInsurance: insuranceWrite as unknown as AcceptRunDeps['acceptAndWriteInsurance'] });
      const outcome = await acceptRun(iiParams, deps);
      expect(outcome).toEqual({ ok: true, alreadyCompleted: false, iiSourceDocumentId: 'ii-doc-1' });
      expect(calls.writes).toHaveLength(1);
      expect(insuranceWrite).not.toHaveBeenCalled();
      const toStates = calls.transitions.map((t) => (t as { toStatus: string }).toStatus);
      expect(toStates).toEqual(['accepted', 'write_pending', 'completed']);
    });

    it('passes the caller-supplied ownerMemberId/countryCode and the intake\'s own real storage key/mime type/filename through to write.ts, never invented', async () => {
      const { deps, calls } = fakeDeps(iiOverrides);
      await acceptRun(iiParams, deps);
      expect(calls.writes[0]).toMatchObject({
        ownerMemberId: 'member-1',
        countryCode: 'IN',
        quarantineStorageKey: 'user-1/intake-1',
        declaredMimeType: 'application/pdf',
        originalFilename: 'statement.pdf',
      });
    });

    it('refuses with missing_required_input when the caller has not supplied ownerMemberId/countryCode for an Investment Intelligence run', async () => {
      const { deps, calls } = fakeDeps(iiOverrides);
      const outcome = await acceptRun(baseParams, deps); // baseParams has neither field
      expect(outcome.ok).toBe(false);
      expect((outcome as { reason: string }).reason).toBe('missing_required_input');
      expect(calls.writes).toHaveLength(0);
    });

    it('"already_written" from write.ts is reported as success with iiSourceDocumentId, not failure', async () => {
      const { deps } = fakeDeps({ ...iiOverrides, acceptAndWriteInvestment: async () => ({ ok: false, reason: 'already_written', iiSourceDocumentId: 'ii-doc-existing' }) });
      const outcome = await acceptRun(iiParams, deps);
      expect(outcome).toEqual({ ok: true, alreadyCompleted: true, iiSourceDocumentId: 'ii-doc-existing' });
    });

    it('a storage/DB-shaped write.ts failure (e.g. quarantine_download_failed) transitions to failed_retryable, not failed_terminal', async () => {
      const { deps, calls } = fakeDeps({ ...iiOverrides, acceptAndWriteInvestment: async () => ({ ok: false, reason: 'quarantine_download_failed', message: 'not found' }) });
      const outcome = await acceptRun(iiParams, deps);
      expect(outcome).toEqual({ ok: false, reason: 'write_failed', message: 'quarantine_download_failed' });
      const toStates = calls.transitions.map((t) => (t as { toStatus: string }).toStatus);
      expect(toStates).toEqual(['accepted', 'write_pending', 'failed_retryable']);
    });
  });

  // Negative control: before this fix, EVERY run reaching this point was
  // unconditionally written through Insurance's service, whatever adapter
  // actually produced it (the exact latent defect AIE_1_MERGE_PLAN.md
  // section 3 finding #2 flagged for moduleRegistry.ts and this file both).
  // A run recorded against neither Insurance's nor Investment
  // Intelligence's real adapter id (e.g. FDH-bank's, not yet wired — see
  // AIE_1_3_IMPLEMENTATION.md section 5/8 — or none at all) must be refused,
  // never silently routed to Insurance's write service.
  describe('unsupported/unrecognised adapter (never silently defaults to Insurance)', () => {
    it('refuses a run recorded against FDH-bank\'s real adapter id — not yet wired to any write service', async () => {
      const insuranceWrite = vi.fn();
      const investmentWrite = vi.fn();
      const { deps, calls } = fakeDeps({
        getAdapterIdForRun: async () => 'aie_fdh_bank_statement_bridge_v1',
        acceptAndWriteInsurance: insuranceWrite as unknown as AcceptRunDeps['acceptAndWriteInsurance'],
        acceptAndWriteInvestment: investmentWrite as unknown as AcceptRunDeps['acceptAndWriteInvestment'],
      });
      const outcome = await acceptRun(baseParams, deps);
      expect(outcome).toEqual({ ok: false, reason: 'unsupported_adapter' });
      expect(insuranceWrite).not.toHaveBeenCalled();
      expect(investmentWrite).not.toHaveBeenCalled();
      expect(calls.transitions).toHaveLength(0); // refused before any CAS transition — never stranded mid-flight
    });

    it('refuses a run with no adapter recorded at all (null) the same way, never defaulting to Insurance', async () => {
      const insuranceWrite = vi.fn();
      const { deps, calls } = fakeDeps({ getAdapterIdForRun: async () => null, acceptAndWriteInsurance: insuranceWrite as unknown as AcceptRunDeps['acceptAndWriteInsurance'] });
      const outcome = await acceptRun(baseParams, deps);
      expect(outcome).toEqual({ ok: false, reason: 'unsupported_adapter' });
      expect(insuranceWrite).not.toHaveBeenCalled();
      expect(calls.transitions).toHaveLength(0);
    });

    it('a reconciliation-not-passed run for an unsupported adapter is still refused at the adapter check, not left ambiguous between the two gates', async () => {
      // Reconciliation itself passes here — proves the adapter check, not
      // the reconciliation gate, is what refuses this run.
      const { deps } = fakeDeps({ getAdapterIdForRun: async () => 'some_future_adapter_v1' });
      const outcome = await acceptRun(baseParams, deps);
      expect(outcome).toEqual({ ok: false, reason: 'unsupported_adapter' });
    });
  });
});
