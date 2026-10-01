/**
 * Investment Intelligence -- owner change on the live pipeline (2026-10-01).
 *
 *   PATCH /api/investment-intelligence/accounts/[id]/owner      (Review tab)
 *   GET   /api/investment-intelligence/accounts/[id]/owner      (dialog data)
 *   POST  /api/investment-intelligence/resolutions/[caseId]/amend (Resolutions tab)
 *
 * The routes run for real against an in-memory Supabase fake whose filters are
 * applied for real (a query that forgets its user_id scope returns the wrong
 * rows here too), and every write is recorded, so "nothing was written" and
 * "exactly one allocation set" are asserted on the data, not on mocks.
 * `emitAuditEvent` and `recordAllocationGroup` are the REAL implementations:
 * audit rows land in the fake's `ii_audit_events` table.
 *
 * WHAT THIS CANNOT PROVE: the database-level backstops (the cross-tenant
 * trigger on ii_ownership_allocation, the HUF trigger on business_entities, the
 * ii_reconciliation_cases write guard). Those are real migrations (0153, 0154,
 * 0087) exercised by their own live-DEV suites, not by an in-memory fake.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createInMemoryDb, type InMemoryDb, type Row } from './support/inMemorySupabase';
import { countryRegistryFrom } from './support/countryRegistryFake';

const mockGetUser = vi.fn();
const mockUserFrom = vi.fn();
const mockAdminFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mockGetUser }, from: mockUserFrom }) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: mockAdminFrom }) }));
vi.mock('@/lib/services/investment-intelligence/documentProcessing', () => ({ processSourceDocument: vi.fn() }));

import { GET, PATCH } from '@/app/api/investment-intelligence/accounts/[id]/owner/route';
import { POST as AMEND } from '@/app/api/investment-intelligence/resolutions/[caseId]/amend/route';
import { GET as RESOLUTIONS } from '@/app/api/investment-intelligence/resolutions/route';
import { POST as GENERIC_RESOLVE } from '@/app/api/investment-intelligence/reconciliation-cases/[id]/resolve/route';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const USER_A = 'user-a';
const USER_B = 'user-b';
const ACCOUNT = id(100);
const OTHER_USERS_ACCOUNT = id(101);
const SELF = id(1);
const SPOUSE = id(2);
const INACTIVE = id(3);
const B_MEMBER = id(51); // user B's member
const TRUST = id(11);
const HUF = id(12);
const COMPANY = id(13);
const B_ENTITY = id(52);
const CASE_UNMATCHED = id(201);
const CASE_JOINT = id(202);

let db: InMemoryDb;

function profile(userId: string, country: 'AU' | 'IN') {
  return { user_id: userId, country_of_residence: country, country_confirmed_at: '2026-08-29T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true };
}

function seed(opts: { country?: 'AU' | 'IN'; withTrust?: boolean; withHuf?: boolean; withCompany?: boolean; cases?: Row[]; accountOwner?: string | null; published?: boolean } = {}) {
  const { country = 'IN', withTrust = true, withHuf = true, withCompany = true, accountOwner = null, published = false } = opts;
  db = createInMemoryDb();
  db.reset({
    user_profiles: [profile(USER_A, country), profile(USER_B, 'IN')],
    household_members: [
      { id: SELF, user_id: USER_A, full_name: 'Asha Rao', relationship: 'self', is_active: true },
      { id: SPOUSE, user_id: USER_A, full_name: 'Ravi Rao', relationship: 'spouse', is_active: true },
      { id: INACTIVE, user_id: USER_A, full_name: 'Old Member', relationship: 'child', is_active: false },
      { id: B_MEMBER, user_id: USER_B, full_name: 'Bella Other', relationship: 'self', is_active: true },
    ],
    business_entities: [
      ...(withTrust ? [{ id: TRUST, user_id: USER_A, name: 'Rao Family Trust', entity_type: 'family_trust', is_active: true }] : []),
      ...(withHuf ? [{ id: HUF, user_id: USER_A, name: 'Rao HUF', entity_type: 'huf', is_active: true }] : []),
      ...(withCompany ? [{ id: COMPANY, user_id: USER_A, name: 'Rao Pty Ltd', entity_type: 'company', is_active: true }] : []),
      { id: B_ENTITY, user_id: USER_B, name: 'Bella Trust', entity_type: 'family_trust', is_active: true },
    ],
    ii_accounts: [
      { id: ACCOUNT, user_id: USER_A, owner_member_id: accountOwner, folio_number: 'F-1', institution_name: 'Example AMC', currency_code: 'INR', status: 'active' },
      { id: OTHER_USERS_ACCOUNT, user_id: USER_B, owner_member_id: B_MEMBER, folio_number: 'F-9', institution_name: 'Other AMC', currency_code: 'INR', status: 'active' },
    ],
    ii_ownership_allocation: [],
    ii_fhip_publications: published ? [{ id: 'pub-1', user_id: USER_A, account_id: ACCOUNT, status: 'published' }] : [],
    ii_audit_events: [],
    ii_reconciliation_cases: opts.cases ?? [],
  });
  mockUserFrom.mockImplementation((table: string) => countryRegistryFrom(table) ?? db.client.from(table));
  mockAdminFrom.mockImplementation((table: string) => db.client.from(table));
}

const openCase = (over: Row = {}): Row => ({
  id: CASE_UNMATCHED,
  user_id: USER_A,
  subject_type: 'account',
  subject_id: ACCOUNT,
  discrepancy_type: 'owner_unmatched',
  severity: 'blocking',
  status: 'open',
  discrepancy_details: { reason: 'No household member was specified for this statement at upload time.' },
  ...over,
});
const jointCase = (over: Row = {}) => openCase({ id: CASE_JOINT, discrepancy_type: 'joint_holding_allocation_required', discrepancy_details: { maskedHolderName: 'A**** R**', matchedMemberIds: [SELF, SPOUSE], declaredOwnerMemberId: null }, ...over });

const rows = (table: string) => db.tables[table] ?? [];
const activeAllocations = (accountId = ACCOUNT) => rows('ii_ownership_allocation').filter((r) => r.ii_account_id === accountId && r.status === 'active');
const auditUserCorrections = () => rows('ii_audit_events').filter((r) => r.event_type === 'user_correction');

function patch(accountId: string, body: unknown) {
  return PATCH(new Request('http://test/x', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id: accountId }) });
}
function get(accountId: string) {
  return GET(new Request('http://test/x'), { params: Promise.resolve({ id: accountId }) });
}
function amend(caseId: string, body: unknown) {
  return AMEND(new Request('http://test/x', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ caseId }) });
}
const body = async (res: Response) => (await res.json()) as { data?: Record<string, unknown>; error?: string; message?: string };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: { id: USER_A, email: 'a@example.com' } } });
  seed();
});

describe('PATCH accounts/[id]/owner -- confirmation and tenant isolation', () => {
  it('401 when unauthenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const res = await patch(ACCOUNT, { owner: { kind: 'member', member_id: SELF }, confirm: true });
    expect(res.status).toBe(401);
  });

  it('NEGATIVE CONTROL [explicit confirm]: a request without confirm:true is refused and writes NOTHING', async () => {
    seed({ cases: [openCase()] });
    for (const confirm of [undefined, false]) {
      const res = await patch(ACCOUNT, { owner: { kind: 'member', member_id: SELF }, ...(confirm === undefined ? {} : { confirm }) });
      expect(res.status).toBe(422);
      expect((await body(res)).error).toBe('OWNER_CHANGE_NOT_CONFIRMED');
    }
    expect(db.writes).toEqual([]);
    expect(rows('ii_accounts').find((a) => a.id === ACCOUNT)?.owner_member_id).toBeNull();
    expect(rows('ii_reconciliation_cases')[0].status).toBe('open');
  });

  it('the legacy { ownerMemberId } body still works, but only with confirm:true', async () => {
    seed({ cases: [openCase()] });
    expect((await patch(ACCOUNT, { ownerMemberId: SELF })).status).toBe(422);
    const ok = await patch(ACCOUNT, { ownerMemberId: SELF, confirm: true });
    expect(ok.status).toBe(200);
    expect(rows('ii_accounts').find((a) => a.id === ACCOUNT)?.owner_member_id).toBe(SELF);
  });

  it('NEGATIVE CONTROL [account tenant isolation]: another user\'s account is 404 and nothing is written', async () => {
    const res = await patch(OTHER_USERS_ACCOUNT, { owner: { kind: 'member', member_id: SELF }, confirm: true });
    expect(res.status).toBe(404);
    expect(db.writes).toEqual([]);
    expect(rows('ii_accounts').find((a) => a.id === OTHER_USERS_ACCOUNT)?.owner_member_id).toBe(B_MEMBER);
  });

  it('NEGATIVE CONTROL [cross-tenant owner ids]: user B\'s member and entity ids are rejected, nothing written, no audit', async () => {
    const m = await patch(ACCOUNT, { owner: { kind: 'member', member_id: B_MEMBER }, confirm: true });
    expect(m.status).toBe(404);
    expect((await body(m)).error).toBe('OWNER_MEMBER_NOT_FOUND');
    const e = await patch(ACCOUNT, { owner: { kind: 'entity', business_entity_id: B_ENTITY }, confirm: true });
    expect(e.status).toBe(404);
    expect((await body(e)).error).toBe('OWNER_ENTITY_NOT_FOUND');
    const j = await patch(ACCOUNT, { owner: { kind: 'joint', allocations: [{ member_id: SELF, basis_points: 5000 }, { member_id: B_MEMBER, basis_points: 5000 }] }, confirm: true });
    expect(j.status).toBe(404);
    expect(db.writes).toEqual([]);
    expect(auditUserCorrections()).toHaveLength(0);
  });

  it('NEGATIVE CONTROL [inactive member]: refused with 422, nothing written', async () => {
    const res = await patch(ACCOUNT, { owner: { kind: 'member', member_id: INACTIVE }, confirm: true });
    expect(res.status).toBe(422);
    expect((await body(res)).error).toBe('OWNER_MEMBER_INACTIVE');
    expect(db.writes).toEqual([]);
  });
});

describe('PATCH accounts/[id]/owner -- entity owners', () => {
  it('assigns a Family Trust: one 100% allocation row, owner_member_id stays null, open owner case resolved, one audit row', async () => {
    seed({ cases: [openCase()] });
    const res = await patch(ACCOUNT, { owner: { kind: 'entity', business_entity_id: TRUST }, confirm: true, case_id: CASE_UNMATCHED });
    expect(res.status).toBe(200);
    const alloc = activeAllocations();
    expect(alloc).toHaveLength(1);
    expect(alloc[0]).toMatchObject({ owner_business_entity_id: TRUST, owner_member_id: null, allocation_basis_points: 10000, owner_role: 'family_trust', source: 'user', status: 'active' });
    expect(rows('ii_accounts').find((a) => a.id === ACCOUNT)?.owner_member_id).toBeNull();
    const c = rows('ii_reconciliation_cases').find((r) => r.id === CASE_UNMATCHED)!;
    expect(c.status).toBe('resolved');
    expect(c.resolution_method).toBe('user_mapped_entity_owner');
    expect(((c.discrepancy_details as Record<string, unknown>).resolvedOwner as { kind: string }).kind).toBe('entity');
    expect(auditUserCorrections()).toHaveLength(1);
    // holdings / transactions are never touched
    expect(db.writes.map((w) => w.table).filter((t) => ['ii_holding_snapshots', 'ii_transactions', 'ii_tax_lots', 'ii_fhip_publications', 'investments'].includes(t))).toEqual([]);
  });

  it('NEGATIVE CONTROL [HUF India-only]: an HUF owner is refused for an AU user (403) and ACCEPTED for an India user', async () => {
    seed({ country: 'AU' });
    const refused = await patch(ACCOUNT, { owner: { kind: 'entity', business_entity_id: HUF }, confirm: true });
    expect(refused.status).toBe(403);
    expect((await body(refused)).error).toBe('OWNER_ENTITY_TYPE_UNAVAILABLE_FOR_COUNTRY');
    expect(db.writes).toEqual([]);
    expect(activeAllocations()).toHaveLength(0);

    seed({ country: 'IN' });
    const accepted = await patch(ACCOUNT, { owner: { kind: 'entity', business_entity_id: HUF }, confirm: true });
    expect(accepted.status).toBe(200);
    expect(activeAllocations()[0]).toMatchObject({ owner_business_entity_id: HUF, owner_role: 'other' });
  });

  it('NEGATIVE CONTROL [company only if the user has one]: refused when the user has no company, accepted when they do', async () => {
    seed({ withCompany: false });
    const refused = await patch(ACCOUNT, { owner: { kind: 'entity', business_entity_id: COMPANY }, confirm: true });
    expect(refused.status).toBe(404);
    expect(db.writes).toEqual([]);
    seed({ withCompany: true });
    expect((await patch(ACCOUNT, { owner: { kind: 'entity', business_entity_id: COMPANY }, confirm: true })).status).toBe(200);
  });

  it('NEGATIVE CONTROL [entity separation]: an account already published to personal Net Worth cannot be moved under an entity (409), nothing written', async () => {
    seed({ published: true, accountOwner: SELF });
    const res = await patch(ACCOUNT, { owner: { kind: 'entity', business_entity_id: TRUST }, confirm: true });
    expect(res.status).toBe(409);
    expect((await body(res)).error).toBe('ACCOUNT_PUBLISHED_UNPUBLISH_FIRST');
    expect(db.writes).toEqual([]);
    expect(rows('ii_accounts').find((a) => a.id === ACCOUNT)?.owner_member_id).toBe(SELF);
  });

  it('a published account can still change between household members (flagged: its Net Worth label updates on re-publish)', async () => {
    seed({ published: true, accountOwner: SELF });
    const res = await patch(ACCOUNT, { owner: { kind: 'member', member_id: SPOUSE }, confirm: true });
    expect(res.status).toBe(200);
    expect((await body(res)).data?.republishRecommended).toBe(true);
  });

  it('moving from an entity back to a member supersedes the entity allocation (kept as history) and restores the member pointer', async () => {
    seed({ cases: [openCase()] });
    await patch(ACCOUNT, { owner: { kind: 'entity', business_entity_id: TRUST }, confirm: true });
    const res = await patch(ACCOUNT, { owner: { kind: 'member', member_id: SPOUSE }, confirm: true });
    expect(res.status).toBe(200);
    const all = rows('ii_ownership_allocation');
    expect(all.filter((r) => r.status === 'active')).toHaveLength(1);
    expect(all.filter((r) => r.status === 'superseded')).toHaveLength(1); // history kept, not deleted
    expect(activeAllocations()[0]).toMatchObject({ owner_member_id: SPOUSE, allocation_basis_points: 10000 });
    expect(rows('ii_accounts').find((a) => a.id === ACCOUNT)?.owner_member_id).toBe(SPOUSE);
  });
});

describe('PATCH accounts/[id]/owner -- joint splits', () => {
  const joint = (allocations: { member_id?: string; business_entity_id?: string; basis_points: number }[], extra: Row = {}) => ({ owner: { kind: 'joint', allocations }, confirm: true, ...extra });

  it('NEGATIVE CONTROL [total != 10000]: 6000 + 3000 is refused, nothing written', async () => {
    const res = await patch(ACCOUNT, joint([{ member_id: SELF, basis_points: 6000 }, { member_id: SPOUSE, basis_points: 3000 }]));
    expect(res.status).toBe(422);
    expect((await body(res)).error).toBe('JOINT_ALLOCATION_INVALID');
    expect(db.writes).toEqual([]);
  });

  it('NEGATIVE CONTROL [duplicate owner] and [zero share] are refused, nothing written', async () => {
    const dup = await patch(ACCOUNT, joint([{ member_id: SELF, basis_points: 5000 }, { member_id: SELF, basis_points: 5000 }]));
    expect(dup.status).toBe(422);
    const zero = await patch(ACCOUNT, joint([{ member_id: SELF, basis_points: 10000 }, { member_id: SPOUSE, basis_points: 0 }]));
    expect(zero.status).toBe(422);
    expect(db.writes).toEqual([]);
  });

  it('JOINT CASE: a 60/40 split resolves joint_holding_allocation_required and clears the blocking state', async () => {
    seed({ cases: [jointCase()] });
    const res = await patch(ACCOUNT, joint([{ member_id: SELF, basis_points: 6000 }, { member_id: SPOUSE, basis_points: 4000 }], { case_id: CASE_JOINT }));
    expect(res.status).toBe(200);
    expect((await body(res)).data).toMatchObject({ resolvedCaseCount: 1, changed: true });
    const alloc = activeAllocations();
    expect(alloc.map((r) => `${r.owner_member_id}:${r.allocation_basis_points}`).sort()).toEqual([`${SELF}:6000`, `${SPOUSE}:4000`].sort());
    expect(new Set(alloc.map((r) => r.allocation_group_id)).size).toBe(1);
    expect(alloc.every((r) => r.owner_role === 'joint')).toBe(true);
    expect(rows('ii_accounts').find((a) => a.id === ACCOUNT)?.owner_member_id).toBeNull();
    const c = rows('ii_reconciliation_cases')[0];
    expect(c.status).toBe('resolved');
    expect(c.resolution_method).toBe('user_assigned_joint_allocation');
    // the blocking state is cleared: no open blocking case remains for the account
    expect(rows('ii_reconciliation_cases').filter((r) => r.subject_id === ACCOUNT && r.status === 'open' && r.severity === 'blocking')).toHaveLength(0);
  });

  it('a member + trust joint split is recorded with both identities', async () => {
    const res = await patch(ACCOUNT, joint([{ member_id: SELF, basis_points: 5000 }, { business_entity_id: TRUST, basis_points: 5000 }]));
    expect(res.status).toBe(200);
    const alloc = activeAllocations();
    expect(alloc.find((r) => r.owner_business_entity_id === TRUST)?.allocation_basis_points).toBe(5000);
    expect(alloc.find((r) => r.owner_member_id === SELF)?.allocation_basis_points).toBe(5000);
  });

  it('NEGATIVE CONTROL [joint case needs a joint owner]: with case_id, a sole-owner choice is refused and the case stays OPEN', async () => {
    seed({ cases: [jointCase()] });
    const res = await patch(ACCOUNT, { owner: { kind: 'member', member_id: SELF }, confirm: true, case_id: CASE_JOINT });
    expect(res.status).toBe(422);
    expect((await body(res)).error).toBe('JOINT_CASE_REQUIRES_JOINT_OWNER');
    expect(db.writes).toEqual([]);
    expect(rows('ii_reconciliation_cases')[0].status).toBe('open');
  });

  it('without case_id, a sole-owner choice never resolves an open joint-holding case', async () => {
    seed({ cases: [jointCase(), openCase()] });
    const res = await patch(ACCOUNT, { owner: { kind: 'member', member_id: SELF }, confirm: true });
    expect(res.status).toBe(200);
    expect(rows('ii_reconciliation_cases').find((r) => r.id === CASE_JOINT)?.status).toBe('open');
    expect(rows('ii_reconciliation_cases').find((r) => r.id === CASE_UNMATCHED)?.status).toBe('resolved');
  });

  it('case_id must be this account\'s own case (another account\'s or another user\'s case id is 404)', async () => {
    seed({ cases: [jointCase({ subject_id: OTHER_USERS_ACCOUNT, user_id: USER_B })] });
    const res = await patch(ACCOUNT, joint([{ member_id: SELF, basis_points: 5000 }, { member_id: SPOUSE, basis_points: 5000 }], { case_id: CASE_JOINT }));
    expect(res.status).toBe(404);
    expect(db.writes).toEqual([]);
  });
});

describe('PATCH accounts/[id]/owner -- idempotency and audit', () => {
  it('NEGATIVE CONTROL [replay idempotency]: the same joint change sent twice yields ONE allocation set and ONE audit row', async () => {
    seed({ cases: [jointCase()] });
    const payload = { owner: { kind: 'joint', allocations: [{ member_id: SELF, basis_points: 6000 }, { member_id: SPOUSE, basis_points: 4000 }] }, confirm: true, case_id: CASE_JOINT };
    const first = await patch(ACCOUNT, payload);
    const second = await patch(ACCOUNT, payload);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(rows('ii_ownership_allocation')).toHaveLength(2); // not 4
    expect(new Set(rows('ii_ownership_allocation').map((r) => r.allocation_group_id)).size).toBe(1);
    expect((await body(second)).data).toMatchObject({ changed: false, resolvedCaseCount: 0, allocationGroupId: null });
    expect(auditUserCorrections()).toHaveLength(1);
  });

  it('replaying an entity change is idempotent too', async () => {
    const payload = { owner: { kind: 'entity', business_entity_id: TRUST }, confirm: true };
    await patch(ACCOUNT, payload);
    await patch(ACCOUNT, payload);
    expect(rows('ii_ownership_allocation')).toHaveLength(1);
  });

  it('a different split after the first supersedes it: one active group, the old one kept as history', async () => {
    await patch(ACCOUNT, { owner: { kind: 'joint', allocations: [{ member_id: SELF, basis_points: 5000 }, { member_id: SPOUSE, basis_points: 5000 }] }, confirm: true });
    await patch(ACCOUNT, { owner: { kind: 'joint', allocations: [{ member_id: SELF, basis_points: 7000 }, { member_id: SPOUSE, basis_points: 3000 }] }, confirm: true });
    expect(new Set(activeAllocations().map((r) => r.allocation_group_id)).size).toBe(1);
    expect(activeAllocations().map((r) => r.allocation_basis_points).sort()).toEqual([3000, 7000]);
    expect(rows('ii_ownership_allocation').filter((r) => r.status === 'superseded')).toHaveLength(2);
  });

  it('NEGATIVE CONTROL [audit]: an accepted change writes an audit row with before/after (ids + basis points only); a rejected one writes none', async () => {
    seed({ accountOwner: SELF });
    await patch(ACCOUNT, { owner: { kind: 'member', member_id: INACTIVE }, confirm: true }); // rejected
    await patch(ACCOUNT, { owner: { kind: 'joint', allocations: [{ member_id: SELF, basis_points: 9000 }, { member_id: SPOUSE, basis_points: 2000 }] }, confirm: true }); // rejected (total)
    expect(rows('ii_audit_events')).toHaveLength(0);

    const ok = await patch(ACCOUNT, { owner: { kind: 'joint', allocations: [{ member_id: SELF, basis_points: 6000 }, { member_id: SPOUSE, basis_points: 4000 }] }, confirm: true });
    expect(ok.status).toBe(200);
    const [row] = auditUserCorrections();
    expect(row).toBeTruthy();
    expect(row).toMatchObject({ user_id: USER_A, actor_type: 'user', actor_id: USER_A, subject_type: 'ii_accounts', subject_id: ACCOUNT });
    const meta = row.metadata as { field: string; before: { kind: string }; after: { kind: string; shares: unknown[] }; origin: string };
    expect(meta.field).toBe('ownership');
    expect(meta.before.kind).toBe('member');
    expect(meta.after.kind).toBe('joint');
    expect(meta.after.shares).toHaveLength(2);
    expect(meta.origin).toBe('review');
  });

  it('NEGATIVE CONTROL [no PII in audit]: no audit row or case detail contains a person\'s name, the folio, or the masked holder text', async () => {
    seed({ cases: [jointCase()] });
    await patch(ACCOUNT, { owner: { kind: 'joint', allocations: [{ member_id: SELF, basis_points: 5000 }, { business_entity_id: TRUST, basis_points: 5000 }] }, confirm: true, case_id: CASE_JOINT });
    const auditJson = JSON.stringify(rows('ii_audit_events'));
    expect(auditJson).not.toMatch(/Asha|Rao|Ravi|F-1|A\*\*\*\*/);
    const resolvedDetails = JSON.stringify((rows('ii_reconciliation_cases')[0].discrepancy_details as Record<string, unknown>).resolvedOwner);
    expect(resolvedDetails).not.toMatch(/Asha|Rao|Trust/);
  });
});

describe('POST reconciliation-cases/[id]/resolve (the generic "mark resolved" route)', () => {
  const generic = (caseId: string) =>
    GENERIC_RESOLVE(new Request('http://test/x', { method: 'POST', body: JSON.stringify({ resolution: 'manual_correction' }) }), { params: Promise.resolve({ id: caseId }) });

  it('NEGATIVE CONTROL [no bypass]: a joint-holding case cannot be closed without an owner decision; it stays open and nothing is written', async () => {
    seed({ cases: [jointCase()] });
    const res = await generic(CASE_JOINT);
    expect(res.status).toBe(422);
    expect((await body(res)).error).toBe('JOINT_CASE_REQUIRES_JOINT_OWNER');
    expect(db.writes).toEqual([]);
    expect(rows('ii_reconciliation_cases')[0].status).toBe('open');
  });

  it('other case types still resolve through it (unchanged behaviour)', async () => {
    seed({ cases: [openCase({ id: id(203), discrepancy_type: 'unsupported_document' })] });
    expect((await generic(id(203))).status).toBe(200);
    expect(rows('ii_reconciliation_cases')[0].status).toBe('resolved');
  });
});

describe('GET accounts/[id]/owner -- dialog data', () => {
  it('returns the caller\'s own current owner and options only; an AU user is not offered the HUF', async () => {
    seed({ country: 'AU', accountOwner: SELF });
    const res = await get(ACCOUNT);
    expect(res.status).toBe(200);
    const data = (await body(res)).data as { current: { kind: string; owners: { label: string }[] }; options: { label: string }[]; jointAvailable: boolean; published: boolean };
    expect(data.current.kind).toBe('member');
    expect(data.current.owners[0].label).toBe('Asha Rao');
    const labels = data.options.map((o) => o.label);
    expect(labels).toEqual(['Asha Rao', 'Ravi Rao', 'Rao Family Trust', 'Rao Pty Ltd']);
    expect(labels).not.toContain('Rao HUF'); // India-only
    expect(labels).not.toContain('Bella Other'); // other tenant
    expect(labels).not.toContain('Old Member'); // inactive
    expect(data.jointAvailable).toBe(true);
    expect(data.published).toBe(false);
  });

  it('an India user is offered the HUF', async () => {
    seed({ country: 'IN' });
    const data = (await body(await get(ACCOUNT))).data as { options: { label: string }[] };
    expect(data.options.map((o) => o.label)).toContain('Rao HUF');
  });

  it('NEGATIVE CONTROL [cross-user isolation]: another user\'s account is 404, and user B sees only B\'s options', async () => {
    expect((await get(OTHER_USERS_ACCOUNT)).status).toBe(404);
    mockGetUser.mockResolvedValue({ data: { user: { id: USER_B, email: 'b@example.com' } } });
    const data = (await body(await get(OTHER_USERS_ACCOUNT))).data as { options: { label: string }[]; current: { owners: { label: string }[] } };
    expect(data.options.map((o) => o.label)).toEqual(['Bella Other', 'Bella Trust']);
    expect(data.current.owners[0].label).toBe('Bella Other');
    // and B cannot write to A's account
    expect((await patch(ACCOUNT, { owner: { kind: 'member', member_id: B_MEMBER }, confirm: true })).status).toBe(404);
  });

  it('shows an entity / joint current owner with readable labels and shares', async () => {
    await patch(ACCOUNT, { owner: { kind: 'joint', allocations: [{ member_id: SELF, basis_points: 6000 }, { business_entity_id: TRUST, basis_points: 4000 }] }, confirm: true });
    const data = (await body(await get(ACCOUNT))).data as { current: { kind: string; owners: { label: string; basisPoints: number }[] } };
    expect(data.current.kind).toBe('joint');
    expect(data.current.owners.map((o) => `${o.label}:${o.basisPoints}`)).toEqual(['Asha Rao:6000', 'Rao Family Trust:4000']);
  });
});

describe('POST resolutions/[caseId]/amend -- immutability and history', () => {
  const resolvedCase = (over: Row = {}): Row => ({
    id: CASE_UNMATCHED,
    user_id: USER_A,
    subject_type: 'account',
    subject_id: ACCOUNT,
    discrepancy_type: 'owner_unmatched',
    severity: 'blocking',
    status: 'resolved',
    resolved_at: '2026-09-28T01:00:00.000Z',
    resolution_method: 'user_mapped_owner',
    resolved_by: USER_A,
    resolved_by_actor_type: 'user',
    discrepancy_details: { reason: 'No household member was specified for this statement at upload time.', resolvedOwnerMemberId: SELF },
    ...over,
  });

  it('NEGATIVE CONTROL [immutability]: amending inserts a NEW resolved row; the original row is byte-for-byte unchanged', async () => {
    seed({ accountOwner: SELF, cases: [resolvedCase()] });
    const before = JSON.stringify(rows('ii_reconciliation_cases')[0]);
    const res = await amend(CASE_UNMATCHED, { owner: { kind: 'entity', business_entity_id: TRUST }, confirm: true });
    expect(res.status).toBe(200);
    expect(rows('ii_reconciliation_cases')).toHaveLength(2);
    expect(JSON.stringify(rows('ii_reconciliation_cases').find((r) => r.id === CASE_UNMATCHED))).toBe(before);
    const added = rows('ii_reconciliation_cases').find((r) => r.id !== CASE_UNMATCHED)!;
    expect(added).toMatchObject({ status: 'resolved', resolution_method: 'user_amended_owner', resolved_by: USER_A });
    const d = added.discrepancy_details as Record<string, unknown>;
    expect(d.amendsCaseId).toBe(CASE_UNMATCHED);
    expect((d.previousOwner as { kind: string }).kind).toBe('member');
    expect((d.resolvedOwner as { kind: string }).kind).toBe('entity');
    expect(d.previousOwnerMemberId).toBe(SELF);
    expect(activeAllocations()[0].owner_business_entity_id).toBe(TRUST);
    expect(rows('ii_accounts').find((a) => a.id === ACCOUNT)?.owner_member_id).toBeNull();
  });

  it('NEGATIVE CONTROL [amend needs confirm]: without confirm:true nothing is written', async () => {
    seed({ accountOwner: SELF, cases: [resolvedCase()] });
    const res = await amend(CASE_UNMATCHED, { owner: { kind: 'entity', business_entity_id: TRUST } });
    expect(res.status).toBe(422);
    expect((await body(res)).error).toBe('OWNER_CHANGE_NOT_CONFIRMED');
    expect(db.writes).toEqual([]);
  });

  it('NEGATIVE CONTROL [replay]: replaying the same amend is 409 already_amended and adds no second allocation set', async () => {
    seed({ accountOwner: SELF, cases: [resolvedCase()] });
    const payload = { owner: { kind: 'joint', allocations: [{ member_id: SELF, basis_points: 5000 }, { member_id: SPOUSE, basis_points: 5000 }] }, confirm: true };
    expect((await amend(CASE_UNMATCHED, payload)).status).toBe(200);
    const again = await amend(CASE_UNMATCHED, payload);
    expect(again.status).toBe(409);
    expect(rows('ii_reconciliation_cases')).toHaveLength(2);
    expect(rows('ii_ownership_allocation')).toHaveLength(2);
  });

  it('an open case cannot be amended (decide it on Review instead)', async () => {
    seed({ cases: [openCase()] });
    const res = await amend(CASE_UNMATCHED, { owner: { kind: 'member', member_id: SELF }, confirm: true });
    expect(res.status).toBe(422);
    expect(db.writes).toEqual([]);
  });

  it('a resolved JOINT case can be amended to another joint split, but not to a sole owner', async () => {
    seed({ cases: [resolvedCase({ id: CASE_JOINT, discrepancy_type: 'joint_holding_allocation_required', discrepancy_details: { matchedMemberIds: [SELF, SPOUSE] } })] });
    const sole = await amend(CASE_JOINT, { owner: { kind: 'member', member_id: SELF }, confirm: true });
    expect(sole.status).toBe(422);
    expect((await body(sole)).error).toBe('JOINT_CASE_REQUIRES_JOINT_OWNER');
    expect(db.writes).toEqual([]);
    const ok = await amend(CASE_JOINT, { owner: { kind: 'joint', allocations: [{ member_id: SELF, basis_points: 7000 }, { member_id: SPOUSE, basis_points: 3000 }] }, confirm: true });
    expect(ok.status).toBe(200);
    expect(activeAllocations().map((r) => r.allocation_basis_points).sort()).toEqual([3000, 7000]);
  });

  it('NEGATIVE CONTROL [amend validation is the same function]: cross-tenant owner, HUF for an AU user and a bad total are all refused with no new row', async () => {
    seed({ country: 'AU', accountOwner: SELF, cases: [resolvedCase()] });
    for (const owner of [
      { kind: 'member', member_id: B_MEMBER },
      { kind: 'entity', business_entity_id: HUF },
      { kind: 'joint', allocations: [{ member_id: SELF, basis_points: 5000 }, { member_id: SPOUSE, basis_points: 4000 }] },
    ]) {
      const res = await amend(CASE_UNMATCHED, { owner, confirm: true });
      expect([403, 404, 422]).toContain(res.status);
    }
    expect(rows('ii_reconciliation_cases')).toHaveLength(1);
    expect(db.writes).toEqual([]);
  });

  it('an amend refused by the published-account rule leaves NO amendment row behind', async () => {
    seed({ published: true, accountOwner: SELF, cases: [resolvedCase()] });
    const res = await amend(CASE_UNMATCHED, { owner: { kind: 'entity', business_entity_id: TRUST }, confirm: true });
    expect(res.status).toBe(409);
    expect(rows('ii_reconciliation_cases')).toHaveLength(1);
  });

  it('cross-user: user B cannot amend user A\'s decision (404)', async () => {
    seed({ accountOwner: SELF, cases: [resolvedCase()] });
    mockGetUser.mockResolvedValue({ data: { user: { id: USER_B, email: 'b@example.com' } } });
    const res = await amend(CASE_UNMATCHED, { owner: { kind: 'member', member_id: B_MEMBER }, confirm: true });
    expect(res.status).toBe(404);
    expect(db.writes).toEqual([]);
  });

  it('the Resolutions history shows entity and joint decisions with labels and shares, never raw ids, and marks the superseded one', async () => {
    seed({ cases: [openCase()] });
    await patch(ACCOUNT, { owner: { kind: 'entity', business_entity_id: TRUST }, confirm: true, case_id: CASE_UNMATCHED });
    await amend(CASE_UNMATCHED, { owner: { kind: 'joint', allocations: [{ member_id: SELF, basis_points: 6000 }, { business_entity_id: TRUST, basis_points: 4000 }] }, confirm: true });
    const res = await RESOLUTIONS(new Request('http://test/x'));
    const { items } = (await body(res)).data as { items: { id: string; isSuperseded: boolean; amendable: boolean; resolvedOwnerName: string; previousOwnerName: string | null; resolvedOwner: { kind: string } | null }[] };
    const original = items.find((i) => i.id === CASE_UNMATCHED)!;
    const amended = items.find((i) => i.id !== CASE_UNMATCHED)!;
    expect(original.isSuperseded).toBe(true);
    expect(original.amendable).toBe(false);
    expect(original.resolvedOwnerName).toBe('Rao Family Trust');
    expect(amended.amendable).toBe(true);
    expect(amended.resolvedOwner?.kind).toBe('joint');
    expect(amended.resolvedOwnerName).toBe('Asha Rao 60.00% / Rao Family Trust 40.00%');
    expect(amended.previousOwnerName).toBe('Rao Family Trust');
    // the readable summaries never contain a raw id
    for (const i of items) expect(`${i.resolvedOwnerName} ${i.previousOwnerName ?? ''}`).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});
