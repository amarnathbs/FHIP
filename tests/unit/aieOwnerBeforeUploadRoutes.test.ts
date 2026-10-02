/**
 * Owner-before-upload -- the two AIE intake ROUTES (fdh-bank and investment-intelligence) refuse a request
 * without a valid owner BEFORE any intake row is created or any byte of the body is read, and store the
 * chosen owner on the intake when one is supplied.
 *
 * NEGATIVE CONTROLS live in the same file: the identical request WITH an owner reaches createIntake, so the
 * refusal is the owner check and not an earlier gate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SELF = 'a1111111-1111-4111-8111-111111111111';
const TRUST = 'e1111111-1111-4111-8111-111111111111';

const h = vi.hoisted(() => ({
  createIntake: vi.fn(async () => ({ id: 'intake-1' })),
  recorded: [] as Array<{ intakeId: string; selection: unknown }>,
  bodyRead: false,
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, requireCountryConfirmedUser: async () => ({ user: { id: 'user-owner-test', email: 'pilot@example.test' }, unauthenticated: null }) };
});
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ from: () => ({}) }) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: () => ({}) }) }));
vi.mock('@/lib/aie/audit', () => ({ recordAieAuditEvent: async () => {} }));
vi.mock('@/lib/aie/db/repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/aie/db/repository')>();
  return {
    ...actual,
    createIntake: h.createIntake,
    updateIntakeStatus: async () => true,
    recordFdhBankUploadMetadata: async () => {},
    recordFingerprint: async () => {},
    existingFingerprintHashesForUser: async () => [],
  };
});
vi.mock('@/lib/aie/intakeOwner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/aie/intakeOwner')>();
  return {
    ...actual,
    recordIntakeOwnerSelection: async (intakeId: string, _userId: string, selection: unknown) => {
      h.recorded.push({ intakeId, selection });
      return true;
    },
  };
});
// The validator is the REAL flow-aware validator, fed a fixed household context.
vi.mock('@/lib/ownership/validateOwnerSelection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ownership/validateOwnerSelection')>();
  const ctx = {
    homeCountry: 'AU' as const,
    members: [{ id: 'a1111111-1111-4111-8111-111111111111', fullName: 'Anil', relationship: 'self' as const, isActive: true }],
    entities: [{ id: 'e1111111-1111-4111-8111-111111111111', name: 'Sharma Family Trust', entityType: 'family_trust' as const, isActive: true }],
  };
  return { ...actual, validateOwnerSelection: async (_u: string, input: unknown, flow: Parameters<typeof actual.validateOwnerSelectionAgainst>[2]) => actual.validateOwnerSelectionAgainst(ctx, input, flow) };
});

function request(path: string, owner?: unknown): Request {
  const u = new URL(`https://app.test${path}`);
  if (owner !== undefined) u.searchParams.set('owner', JSON.stringify(owner));
  const body = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  const req = new Request(u, { method: 'POST', headers: { 'content-length': String(body.byteLength), 'content-type': 'application/pdf' }, body, duplex: 'half' } as RequestInit & { duplex: 'half' });
  const original = req.arrayBuffer.bind(req);
  req.arrayBuffer = async () => {
    h.bodyRead = true;
    return original();
  };
  return req;
}

beforeEach(() => {
  h.createIntake.mockClear();
  h.recorded.length = 0;
  h.bodyRead = false;
  process.env.AIE_FDH_BANK_ADAPTER_ENABLED = 'true';
  process.env.AIE_II_ADAPTER_ENABLED = 'true';
  process.env.AIE_DOCUMENT_INTAKE_ENABLED = 'true';
  process.env.AIE_ALLOW_MISSING_SIGNATURE_SCANNER = 'true';
  process.env.AIE_PILOT_COHORT_USER_IDS = 'user-owner-test';
});

const BANK_PATH = '/api/aie/fdh-bank/intake?country_code=AU&currency_code=AUD&filename=s.pdf';
const II_PATH = '/api/aie/investment-intelligence/intake?filename=s.pdf';

describe('POST /api/aie/fdh-bank/intake', () => {
  it('NEGATIVE: no owner -> 422 owner_required, no intake row, body never read', async () => {
    const { POST } = await import('@/app/api/aie/fdh-bank/intake/route');
    const res = await POST(request(BANK_PATH));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'owner_required' });
    expect(h.createIntake).not.toHaveBeenCalled();
    expect(h.bodyRead).toBe(false);
  });

  it('NEGATIVE (PO-OBU-02): a Trust-owned bank statement is refused at intake, before any intake row', async () => {
    const { POST } = await import('@/app/api/aie/fdh-bank/intake/route');
    const res = await POST(request(BANK_PATH, { kind: 'entity', entityId: TRUST }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'owner_not_allowed_for_flow' });
    expect(h.createIntake).not.toHaveBeenCalled();
  });

  it('CONTROL: the same request with a valid Self owner creates the intake and stores the owner on it', async () => {
    const { POST } = await import('@/app/api/aie/fdh-bank/intake/route');
    await POST(request(BANK_PATH, { kind: 'member', memberId: SELF })).catch(() => undefined);
    expect(h.createIntake).toHaveBeenCalledTimes(1);
    expect(h.recorded).toEqual([{ intakeId: 'intake-1', selection: { kind: 'member', memberId: SELF } }]);
  });
});

describe('POST /api/aie/investment-intelligence/intake', () => {
  it('NEGATIVE: no owner -> 422 owner_required, no intake row, body never read (a bare owner_member_id is not an owner)', async () => {
    const { POST } = await import('@/app/api/aie/investment-intelligence/intake/route');
    const res = await POST(request(`${II_PATH}&owner_member_id=${SELF}`));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'owner_required' });
    expect(h.createIntake).not.toHaveBeenCalled();
    expect(h.bodyRead).toBe(false);
  });

  it('NEGATIVE: owner_member_id that disagrees with the chosen member owner is refused', async () => {
    const { POST } = await import('@/app/api/aie/investment-intelligence/intake/route');
    const res = await POST(request(`${II_PATH}&owner_member_id=b1111111-1111-4111-8111-111111111111`, { kind: 'member', memberId: SELF }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'owner_member_mismatch' });
    expect(h.createIntake).not.toHaveBeenCalled();
  });

  it('CONTROL: a Trust owner IS accepted here (CAS-type documents may be entity-owned) and is stored on the intake', async () => {
    const { POST } = await import('@/app/api/aie/investment-intelligence/intake/route');
    await POST(request(II_PATH, { kind: 'entity', entityId: TRUST })).catch(() => undefined);
    expect(h.createIntake).toHaveBeenCalledTimes(1);
    expect(h.recorded[0]).toEqual({ intakeId: 'intake-1', selection: { kind: 'entity', entityId: TRUST } });
  });
});
