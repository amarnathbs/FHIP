/**
 * Owner-before-upload -- the AIE-fronted intakes (fdh_bank, Investment Intelligence).
 *
 * "No route may bypass ownership because AI is involved." An AIE intake that can end in a canonical bank
 * statement or a canonical Investment Intelligence source document must:
 *   1. refuse a missing / invalid owner at INTAKE, before the body is read and before an intake row exists;
 *   2. refuse an entity-owned bank statement (PO-OBU-02), exactly as the interactive upload does;
 *   3. at ACCEPT, re-load and re-validate the stored owner and refuse an intake that carries none;
 *   4. hand the validated owner to the canonical write, and refuse a conflicting owner at the write.
 * Every refusal below has a CONTROL showing the same input is accepted when the guard is not what refused it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveAieIntakeOwner, resolveIntakeOwnerForAccept } from '@/lib/aie/intakeOwner';
import type { OwnerFlow } from '@/lib/ownership/ownerSelection';
import { validateOwnerSelectionAgainst, type OwnerContext, type OwnerValidationResult } from '@/lib/ownership/validateOwnerSelection';
import { acceptRun, type AcceptRunDeps } from '@/lib/aie/review/accept';
import type { AieRunRow } from '@/lib/aie/db/repository';
import type { ResolvedOwner } from '@/lib/ownership/validateOwnerSelection';

const SELF = 'a1111111-1111-4111-8111-111111111111';
const SPOUSE = 'a2222222-2222-4222-8222-222222222222';
const TRUST = 'e1111111-1111-4111-8111-111111111111';
const COMPANY = 'e2222222-2222-4222-8222-222222222222';

function ctx(country: 'AU' | 'IN' = 'AU'): OwnerContext {
  return {
    homeCountry: country,
    members: [
      { id: SELF, fullName: 'Anil', relationship: 'self', isActive: true },
      { id: SPOUSE, fullName: 'Priya', relationship: 'spouse', isActive: true },
    ],
    entities: [
      { id: TRUST, name: 'Sharma Family Trust', entityType: 'family_trust', isActive: true },
      { id: COMPANY, name: 'Sharma Pty Ltd', entityType: 'company', isActive: true },
    ],
  };
}

const validateWith = (c: OwnerContext) => async (_userId: string, input: unknown, flow: OwnerFlow): Promise<OwnerValidationResult> => validateOwnerSelectionAgainst(c, input, flow);

const urlWith = (owner?: unknown) => {
  const u = new URL('https://app.test/api/aie/fdh-bank/intake?country_code=AU&currency_code=AUD');
  if (owner !== undefined) u.searchParams.set('owner', typeof owner === 'string' ? owner : JSON.stringify(owner));
  return u;
};

describe('AIE intake: the owner is required and validated BEFORE the file is accepted', () => {
  it('a missing owner is refused (422 owner_required)', async () => {
    const r = await resolveAieIntakeOwner('u1', urlWith(), 'bank', validateWith(ctx()));
    expect(r).toMatchObject({ ok: false, status: 422, code: 'owner_required' });
  });

  it('a garbled owner is refused, not defaulted', async () => {
    const r = await resolveAieIntakeOwner('u1', urlWith('{not json'), 'bank', validateWith(ctx()));
    expect(r.ok).toBe(false);
  });

  it('CONTROL: the same request WITH a valid Self owner is accepted and returns the wire selection to store', async () => {
    const r = await resolveAieIntakeOwner('u1', urlWith({ kind: 'member', memberId: SELF }), 'bank', validateWith(ctx()));
    expect(r).toMatchObject({ ok: true, owner: { ownerRole: 'self', ownerMemberId: SELF }, selection: { kind: 'member', memberId: SELF } });
  });

  it('a Spouse, a Joint (no shares) and an SMSF (AU) owner are accepted for a bank statement', async () => {
    for (const owner of [{ kind: 'member', memberId: SPOUSE }, { kind: 'joint' }, { kind: 'smsf' }]) {
      const r = await resolveAieIntakeOwner('u1', urlWith(owner), 'bank', validateWith(ctx()));
      expect(r.ok, JSON.stringify(owner)).toBe(true);
    }
  });

  it('PO-OBU-02: a Trust or Company owner on a bank statement is REFUSED (entity bank cash flow is deferred)', async () => {
    for (const id of [TRUST, COMPANY]) {
      const r = await resolveAieIntakeOwner('u1', urlWith({ kind: 'entity', entityId: id }), 'bank', validateWith(ctx()));
      expect(r).toMatchObject({ ok: false, code: 'owner_not_allowed_for_flow' });
    }
  });

  it("CONTROL: the SAME Trust owner is accepted for an Investment Intelligence (ii_cas) intake -- the flow policy is what refused it for the bank", async () => {
    const r = await resolveAieIntakeOwner('u1', urlWith({ kind: 'entity', entityId: TRUST }), 'ii_cas', validateWith(ctx()));
    expect(r).toMatchObject({ ok: true, owner: { kind: 'entity', ownerBusinessEntityId: TRUST } });
  });

  it("another user's household member is refused (cross-tenant)", async () => {
    const r = await resolveAieIntakeOwner('u1', urlWith({ kind: 'member', memberId: "b1111111-1111-4111-8111-111111111111" }), 'bank', validateWith(ctx()));
    expect(r).toMatchObject({ ok: false, code: 'owner_not_found' });
  });

  it('an Investment Intelligence intake takes a Joint owner only WITH shares adding to 100%', async () => {
    const good = await resolveAieIntakeOwner('u1', urlWith({ kind: 'joint', allocations: [{ memberId: SELF, basisPoints: 6000 }, { memberId: SPOUSE, basisPoints: 4000 }] }), 'ii_cas', validateWith(ctx('IN')));
    const bad = await resolveAieIntakeOwner('u1', urlWith({ kind: 'joint', allocations: [{ memberId: SELF, basisPoints: 6000 }, { memberId: SPOUSE, basisPoints: 3000 }] }), 'ii_cas', validateWith(ctx('IN')));
    expect(good.ok).toBe(true);
    expect(bad).toMatchObject({ ok: false, code: 'joint_total_not_100' });
  });
});

describe('AIE accept: the stored owner is re-loaded and re-validated', () => {
  const stored = { kind: 'member', memberId: SPOUSE };

  it('an intake that carries NO owner (created before this change) is refused with an actionable message', async () => {
    const r = await resolveIntakeOwnerForAccept('u1', 'i1', 'bank', { load: async () => null, validate: validateWith(ctx()) });
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toMatch(/Upload it again and choose who it belongs to/);
  });

  it('CONTROL: the same intake WITH a stored owner resolves to that owner', async () => {
    const r = await resolveIntakeOwnerForAccept('u1', 'i1', 'bank', { load: async () => stored, validate: validateWith(ctx()) });
    expect(r).toMatchObject({ ok: true, owner: { ownerRole: 'spouse', ownerMemberId: SPOUSE } });
  });

  it('an owner that has become invalid between upload and accept (member deactivated) is refused', async () => {
    const c = ctx();
    c.members[1].isActive = false;
    const r = await resolveIntakeOwnerForAccept('u1', 'i1', 'bank', { load: async () => stored, validate: validateWith(c) });
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toMatch(/no longer valid/);
  });

  it('a stored owner is validated for the flow it is accepted under (an entity stored on a bank intake is refused)', async () => {
    const r = await resolveIntakeOwnerForAccept('u1', 'i1', 'bank', { load: async () => ({ kind: 'entity', entityId: TRUST }), validate: validateWith(ctx()) });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// acceptRun: the canonical write receives the validated owner, and nothing is written without one.
// ---------------------------------------------------------------------------

const memberOwner = (id: string, role: 'self' | 'spouse' = 'self'): ResolvedOwner => ({ kind: 'member', ownerRole: role, ownerMemberId: id, ownerBusinessEntityId: null, entityType: null, allocations: null, label: 'x' });
const entityOwner: ResolvedOwner = { kind: 'entity', ownerRole: 'family_trust', ownerMemberId: null, ownerBusinessEntityId: TRUST, entityType: 'family_trust', allocations: null, label: 'Sharma Family Trust' };

function run(): AieRunRow {
  return { id: 'run-1', intakeId: 'intake-1', userId: 'user-1', status: 'awaiting_acceptance', aiUsed: false, startedAt: new Date().toISOString() };
}

function deps(adapterId: string, overrides: Partial<AcceptRunDeps> = {}): { d: AcceptRunDeps; writes: unknown[]; transitions: unknown[] } {
  const writes: unknown[] = [];
  const transitions: unknown[] = [];
  const d: AcceptRunDeps = {
    isCanonicalAcceptanceEnabled: () => true,
    getRunForUser: async () => run(),
    getAdapterIdForRun: async () => adapterId,
    getIntakeUploadMetadata: async () => ({ storageKey: 'user-1/intake-1', declaredMimeType: 'application/pdf', displayFilename: 'statement.pdf' }),
    getFdhBankUploadMetadata: async () => ({ country_code: 'AU', currency_code: 'AUD', institution_id: null, declared_masked_identifier: null }),
    findCommittedFdhBankWriteForRun: async () => null,
    downloadQuarantinedBytes: async () => ({ ok: true, bytes: new Uint8Array([1, 2, 3]) }),
    countItemsBlockingAcceptanceForRun: async () => 0,
    latestReconciliationOutcomesForRun: async () => [{ ruleId: 'r', outcome: 'pass' }],
    listFieldCandidatesForRun: async () => [],
    listLatestCorrectionsForRun: async () => [],
    transitionRunStatusCas: async (p) => {
      transitions.push(p);
      return true;
    },
    recordRunTransitionAudit: async () => {},
    findOrCreateWriteBatch: async () => ({ id: 'batch-1', status: 'pending' }),
    markWriteBatchStatus: async () => {},
    audit: async () => {},
    acceptAndWriteInsurance: async () => ({ ok: true, insurancePolicyId: 'p1' }),
    insuranceWriteDeps: {} as AcceptRunDeps['insuranceWriteDeps'],
    acceptAndWriteInvestment: async (input) => {
      writes.push(input);
      return { ok: true, iiSourceDocumentId: 'ii-doc-1', iiResult: { ok: true, status: 'parsed', parseRunId: 'pr1', error: null } };
    },
    investmentWriteDeps: {} as AcceptRunDeps['investmentWriteDeps'],
    commitFdhBankImport: async (req) => {
      writes.push(req);
      return { committed: true, statementUploadId: 'st-1', transactionsCreated: 3, certificationStatus: 'certified' };
    },
    resolveIntakeOwner: async () => ({ ok: true, owner: memberOwner(SELF) }),
    finalizeDocumentBinary: async () => ({ status: 'deleted' }),
    ...overrides,
  };
  return { d, writes, transitions };
}

const params = { runId: 'run-1', userId: 'user-1', acceptedByUserId: 'user-1', ownerHouseholdRole: 'self' as const, idempotencyKey: 'k1' };
const BANK = 'aie_fdh_bank_statement_bridge_v1';
const II = 'ii_cas_kfintech_folio_v1';

describe('acceptRun -- FDH bank', () => {
  it('passes the VALIDATED stored owner to the canonical commit (the commit cannot run without one)', async () => {
    const { d, writes } = deps(BANK, { resolveIntakeOwner: async () => ({ ok: true, owner: memberOwner(SPOUSE, 'spouse') }) });
    expect(await acceptRun(params, d)).toMatchObject({ ok: true });
    expect(writes).toHaveLength(1);
    expect((writes[0] as { owner: unknown }).owner).toEqual(memberOwner(SPOUSE, 'spouse'));
  });

  it('NEGATIVE: an intake with no (or an invalid) stored owner is refused BEFORE any state transition or write', async () => {
    const { d, writes, transitions } = deps(BANK, { resolveIntakeOwner: async () => ({ ok: false, message: 'No document owner was recorded' }) });
    const out = await acceptRun(params, d);
    expect(out).toMatchObject({ ok: false, reason: 'missing_required_input', message: 'No document owner was recorded' });
    expect(writes).toHaveLength(0);
    expect(transitions).toHaveLength(0);
  });

  it('the owner is resolved for the BANK flow (never the CAS flow) and for this run\'s own intake and user', async () => {
    const resolve = vi.fn(async () => ({ ok: true as const, owner: memberOwner(SELF) }));
    const { d } = deps(BANK, { resolveIntakeOwner: resolve });
    await acceptRun(params, d);
    expect(resolve).toHaveBeenCalledWith('user-1', 'intake-1', 'bank');
  });
});

describe('acceptRun -- Investment Intelligence', () => {
  const iiParams = { ...params, countryCode: 'IN' };

  it('writes the stored owner (member) -- not a caller-chosen one', async () => {
    const { d, writes } = deps(II, { resolveIntakeOwner: async () => ({ ok: true, owner: memberOwner(SPOUSE, 'spouse') }) });
    expect(await acceptRun({ ...iiParams, ownerMemberId: SPOUSE }, d)).toMatchObject({ ok: true });
    expect(writes[0]).toMatchObject({ ownerMemberId: SPOUSE, owner: { ownerRole: 'spouse' } });
  });

  it('a member id supplied at accept that DIFFERS from the stored owner is refused (it can never choose another owner)', async () => {
    const { d, writes } = deps(II, { resolveIntakeOwner: async () => ({ ok: true, owner: memberOwner(SELF) }) });
    const out = await acceptRun({ ...iiParams, ownerMemberId: SPOUSE }, d);
    expect(out).toMatchObject({ ok: false, reason: 'missing_required_input' });
    expect(writes).toHaveLength(0);
  });

  it('CONTROL: the same member id equal to the stored owner is accepted', async () => {
    const { d } = deps(II, { resolveIntakeOwner: async () => ({ ok: true, owner: memberOwner(SELF) }) });
    expect(await acceptRun({ ...iiParams, ownerMemberId: SELF }, d)).toMatchObject({ ok: true });
  });

  it('an ENTITY-owned intake reaches the write with the entity owner and NO member id (the caller needs no ownerMemberId)', async () => {
    const { d, writes } = deps(II, { resolveIntakeOwner: async () => ({ ok: true, owner: entityOwner }) });
    expect(await acceptRun(iiParams, d)).toMatchObject({ ok: true });
    expect(writes[0]).toMatchObject({ ownerMemberId: null, owner: { kind: 'entity', ownerBusinessEntityId: TRUST } });
  });

  it('a member id supplied for an entity-owned intake is refused', async () => {
    const { d, writes } = deps(II, { resolveIntakeOwner: async () => ({ ok: true, owner: entityOwner }) });
    expect(await acceptRun({ ...iiParams, ownerMemberId: SELF }, d)).toMatchObject({ ok: false, reason: 'missing_required_input' });
    expect(writes).toHaveLength(0);
  });

  it('NEGATIVE: an intake with no stored owner is refused -- a caller-supplied ownerMemberId alone is no longer enough', async () => {
    const { d, writes, transitions } = deps(II, { resolveIntakeOwner: async () => ({ ok: false, message: 'No document owner was recorded' }) });
    const out = await acceptRun({ ...iiParams, ownerMemberId: SELF }, d);
    expect(out).toMatchObject({ ok: false, reason: 'missing_required_input' });
    expect(writes).toHaveLength(0);
    expect(transitions).toHaveLength(0);
  });
});

describe('Insurance acceptance is unaffected (it has its own ownerHouseholdRole gate)', () => {
  it('never asks for an intake owner', async () => {
    const resolve = vi.fn();
    const { d } = deps('insurance_generic_schedule_v1', { resolveIntakeOwner: resolve as unknown as AcceptRunDeps['resolveIntakeOwner'] });
    expect(await acceptRun(params, d)).toMatchObject({ ok: true });
    expect(resolve).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The canonical writes themselves.
// ---------------------------------------------------------------------------

describe('FDH bank atomic import carries the owner into the upload service', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.AIE_FDH_BANK_ATOMIC_IMPORT_ENABLED = 'true';
  });

  async function load(upload: (...a: unknown[]) => Promise<unknown>) {
    const processed: unknown[] = [];
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: () => ({ upsert: async () => ({ error: null }) }) }) }));
    vi.doMock('@/lib/financial-data-hub/services/bankPdfUploadService', () => ({ uploadBankPdf: upload }));
    vi.doMock('@/lib/financial-data-hub/services/bankPdfProcessingService', () => ({
      processBankPdfDocument: async (...a: unknown[]) => {
        processed.push(a);
        return { certificationStatus: 'certified', pipelineStatus: 'completed', transactionsCreated: 1 };
      },
      BankPdfProcessingError: class extends Error {},
    }));
    const mod = await import('@/lib/aie/adapters/fdhBankStatement/atomicImport');
    const attribution = await import('@/lib/financial-data-hub/services/bankOwnerAttribution');
    return { ...mod, ...attribution, processed };
  }

  const req = (owner: unknown) => ({ userId: 'user-1', runId: 'run-1', intakeId: 'intake-1', bytes: new Uint8Array([1]), metadata: { country_code: 'AU', currency_code: 'AUD' }, owner } as never);

  it('uploadBankPdf is called WITH the owner (so the interactive upload guards run on the AIE path too)', async () => {
    const upload = vi.fn(async (..._args: unknown[]) => {
      void _args;
      return { accountResolution: 'create', document: { id: 'doc-1' } };
    });
    const { commitFdhBankStatementImport } = await load(upload);
    const owner = memberOwner(SPOUSE, 'spouse');
    expect(await commitFdhBankStatementImport(req(owner))).toMatchObject({ committed: true });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0][3]).toEqual({ ownerRole: 'spouse', ownerMemberId: SPOUSE, label: 'x' });
  });

  it('an existing account owned by someone else is NOT silently re-owned: the commit stops as owner_conflict and nothing is processed', async () => {
    const ref: { m?: Awaited<ReturnType<typeof load>> } = {};
    const upload = async () => {
      throw new (ref.m as NonNullable<typeof ref.m>).BankOwnerConflictError('self', 'spouse', 'acc-1');
    };
    const load2 = (ref.m = await load(upload));
    const out = await load2.commitFdhBankStatementImport(req(memberOwner(SPOUSE, 'spouse')));
    expect(out).toMatchObject({ committed: false, reason: 'owner_conflict', detail: 'account_owner_conflict' });
    expect(load2.processed).toHaveLength(0);
  });

  it('the same bytes already stored under a different owner stop the commit too', async () => {
    const ref: { m?: Awaited<ReturnType<typeof load>> } = {};
    const upload = async () => {
      throw new (ref.m as NonNullable<typeof ref.m>).BankIdenticalUploadOwnerConflictError('doc-0', 'self', 'spouse');
    };
    const load2 = (ref.m = await load(upload));
    const out = await load2.commitFdhBankStatementImport(req(memberOwner(SPOUSE, 'spouse')));
    expect(out).toMatchObject({ committed: false, reason: 'owner_conflict' });
    expect(load2.processed).toHaveLength(0);
  });

  it('CONTROL: an unrelated upload failure is NOT swallowed as an owner conflict', async () => {
    const { commitFdhBankStatementImport } = await load(async () => {
      throw new Error('storage down');
    });
    await expect(commitFdhBankStatementImport(req(memberOwner(SELF)))).rejects.toThrow('storage down');
  });
});

describe('Investment Intelligence AIE write stores the chosen owner on the source document', () => {
  async function insertWith(owner: ResolvedOwner, failFirstWithMissingColumn = false) {
    vi.resetModules();
    const rows: Array<Record<string, unknown>> = [];
    vi.doMock('@/lib/supabase/admin', () => ({
      createAdminClient: () => ({
        from: () => ({
          insert: (row: Record<string, unknown>) => {
            rows.push(row);
            const first = rows.length === 1 && failFirstWithMissingColumn;
            return { select: () => ({ single: async () => (first ? { data: null, error: { message: 'column "owner_role" does not exist' } } : { data: { id: 'doc-1' }, error: null }) }) };
          },
        }),
      }),
    }));
    const { createDefaultAcceptAndWriteDeps } = await import('@/lib/aie/adapters/investment-intelligence/write');
    const res = await createDefaultAcceptAndWriteDeps().insertSourceDocument({
      userId: 'user-1',
      ownerMemberId: owner.ownerMemberId,
      owner,
      countryCode: 'IN',
      checksum: 'abc',
      storagePath: 'p',
      originalFilename: 'f.pdf',
      mimeType: 'application/pdf',
      fileSize: 1,
    });
    return { res, rows };
  }

  it('a member owner is written as user_selected with its role', async () => {
    const { res, rows } = await insertWith(memberOwner(SPOUSE, 'spouse'));
    expect(res).toEqual({ id: 'doc-1' });
    expect(rows[0]).toMatchObject({ owner_member_id: SPOUSE, owner_role: 'spouse', owner_selection_source: 'user_selected', owner_business_entity_id: null });
  });

  it('a Trust owner is written to the entity column and NO member pointer', async () => {
    const { rows } = await insertWith(entityOwner);
    expect(rows[0]).toMatchObject({ owner_member_id: null, owner_business_entity_id: TRUST, owner_role: 'family_trust' });
  });

  it('a member-owned write survives a database one migration behind (0236 columns missing) by falling back to the legacy column', async () => {
    const { res, rows } = await insertWith(memberOwner(SELF), true);
    expect(res).toEqual({ id: 'doc-1' });
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual(expect.objectContaining({ owner_member_id: SELF }));
    expect(rows[1]).not.toHaveProperty('owner_role');
  });

  it('NEGATIVE: an entity-owned write on a database one migration behind FAILS CLOSED rather than being stored as ownerless', async () => {
    const { res, rows } = await insertWith(entityOwner, true);
    expect(res).toHaveProperty('error');
    expect(rows).toHaveLength(1);
  });
});
