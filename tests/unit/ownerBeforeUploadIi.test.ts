/**
 * Owner-before-upload (Phase 1): the India CAS (Investment Intelligence) flow.
 *
 * Route-level tests drive the real POST /api/investment-intelligence/source-
 * documents handler against the in-memory database; service-level tests drive
 * the real owner application against it. Storage, the admission scan and the
 * malware scan are mocked because they are not what is under test -- but the
 * "storage was NOT touched" assertions use the mock, so a refused upload is
 * proven to have stored nothing.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read raw JSON route payloads */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, type FakeDb } from '../support/fdhFakeSupabase';
import {
  applyDocumentOwnerToAccounts,
  computeHolderNameWarnings,
  confirmOwnerChange,
  confirmSoleOwner,
  withoutAcknowledgedWarnings,
  ownerSignature,
  planAccountOwner,
  readDocumentOwner,
} from '@/lib/services/investment-intelligence/documentOwner';
import { ownerColumnsFor } from '@/lib/services/investment-intelligence/uploadOwner';
import { OWNER_CASE_TYPES } from '@/lib/services/investment-intelligence/ownerModel';
import type { ParsedAccountRecord } from '@/lib/services/investment-intelligence/parsers/types';

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, user: null as { id: string } | null, storageCalls: 0, missingOwnerColumns: false }));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    const client = h.db.sessionClient(h.user!.id) as any;
    if (!h.missingOwnerColumns) return client;
    const missing = { message: "Could not find the 'owner_role' column of 'ii_source_documents' in the schema cache" };
    return new Proxy(client, {
      get(target, prop) {
        if (prop !== 'from') return target[prop];
        return (table: string) => {
          const q = target.from(table);
          if (table !== 'ii_source_documents') return q;
          return new Proxy(q, {
            get(t, p) {
              if (p === 'select') return (cols?: string) => (typeof cols === 'string' && /owner_role/.test(cols) ? { limit: async () => ({ data: null, error: missing }) } : t.select(cols));
              if (p === 'insert') return (row: Record<string, unknown>) => ('owner_role' in row ? { select: () => ({ single: async () => ({ data: null, error: missing }) }) } : t.insert(row));
              return t[p];
            },
          });
        };
      },
    });
  },
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.adminClient() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireCountryConfirmedUser: async () =>
    h.user ? { user: h.user } : { user: null, unauthenticated: Response.json({ error: 'unauthenticated' }, { status: 401 }) },
}));
vi.mock('@/lib/services/investment-intelligence/storage', () => ({
  validateUploadedFile: () => ({ ok: true }),
  generateObjectKey: (userId: string, name: string) => `${userId}/${name}`,
  uploadSourceDocumentObject: async () => { h.storageCalls += 1; return { error: null }; },
}));
vi.mock('@/lib/services/investment-intelligence/uploadAdmission', () => ({
  scanUploadedPdfForAdmission: () => ({ ok: true }),
  uploadAdmissionFailureMessage: () => 'x',
}));
vi.mock('@/lib/services/investment-intelligence/realScanAdmission', () => ({
  startIiRealScan: async () => ({ admitted: true }),
  II_SCAN_BLOCKED_MESSAGE: 'blocked',
  II_SCAN_UNAVAILABLE_MESSAGE: 'unavailable',
}));

vi.setConfig({ testTimeout: 30000 });

const A = 'a0000000-0000-4000-8000-00000000000a';
const B = 'b0000000-0000-4000-8000-00000000000b';
const SELF = 'a1111111-1111-4111-8111-111111111111';
const SPOUSE = 'a2222222-2222-4222-8222-222222222222';
const MEM_B = 'b1111111-1111-4111-8111-111111111111';
const TRUST = 'e1111111-1111-4111-8111-111111111111';
const HUF = 'e2222222-2222-4222-8222-222222222222';

async function post(meta: Record<string, unknown>, bytes: Uint8Array = new TextEncoder().encode('%PDF-1.4 fake cas statement one')) {
  const route = await import('@/app/api/investment-intelligence/source-documents/route');
  const form = new FormData();
  form.append('file', new File([bytes as unknown as BlobPart], 'cas.pdf', { type: 'application/pdf' }));
  form.append('meta', JSON.stringify({ sourceKey: 'cams', documentType: 'cas_statement', countryCode: 'IN', ...meta }));
  const res: Response = await route.POST(new Request('http://local/x', { method: 'POST', body: form }));
  return { status: res.status, json: await res.json() as any };
}
const docs = () => h.db.rows('ii_source_documents');

beforeEach(() => {
  h.db = createFakeDb();
  h.user = { id: A };
  h.storageCalls = 0;
  h.missingOwnerColumns = false;
  h.db.insert('user_profiles', { user_id: A, country_of_residence: 'IN' });
  h.db.insert('household_members', { id: SELF, user_id: A, full_name: 'Anil', relationship: 'self', is_active: true });
  h.db.insert('household_members', { id: SPOUSE, user_id: A, full_name: 'Priya', relationship: 'spouse', is_active: true });
  h.db.insert('household_members', { id: MEM_B, user_id: B, full_name: 'Bob', relationship: 'self', is_active: true });
  h.db.insert('business_entities', { id: TRUST, user_id: A, name: 'Sharma Family Trust', entity_type: 'family_trust', is_active: true });
  h.db.insert('business_entities', { id: HUF, user_id: A, name: 'Sharma HUF', entity_type: 'huf', is_active: true });
  h.db.insert('ii_sources', { id: 's0000000-0000-4000-8000-000000000001', source_key: 'manual' });
});

describe('owner is REQUIRED before a CAS can be uploaded (server-side)', () => {
  it('no owner -> 422 owner_required, nothing stored, storage untouched; the legacy ownerMemberId field is NOT an owner', async () => {
    const none = await post({});
    expect(none.status).toBe(422);
    expect(none.json.error).toBe('owner_required');
    const legacy = await post({ ownerMemberId: SELF });
    expect(legacy.status).toBe(422);
    expect(legacy.json.error).toBe('owner_required');
    expect(docs()).toHaveLength(0);
    expect(h.storageCalls).toBe(0);
    // CONTROL: with an owner the same request stores the document.
    const ok = await post({ owner: { kind: 'member', memberId: SELF } });
    expect(ok.status).toBe(200);
    expect(docs()).toHaveLength(1);
    expect(h.storageCalls).toBe(1);
  });
  it("a cross-tenant member id is refused (owner_not_found), not stored", async () => {
    const r = await post({ owner: { kind: 'member', memberId: MEM_B } });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe('owner_not_found');
    expect(docs()).toHaveLength(0);
    expect(h.storageCalls).toBe(0);
  });
});

describe('the chosen owner is stored on the document', () => {
  it('member: owner_member_id, role and source', async () => {
    const r = await post({ owner: { kind: 'member', memberId: SPOUSE } });
    expect(r.status).toBe(200);
    expect(docs()[0]).toMatchObject({ owner_member_id: SPOUSE, owner_role: 'spouse', owner_selection_source: 'user_selected', owner_business_entity_id: null, owner_allocation: null });
  });
  it('entity (family trust): entity id and entity role, no member', async () => {
    const r = await post({ owner: { kind: 'entity', entityId: TRUST } });
    expect(r.status).toBe(200);
    expect(docs()[0]).toMatchObject({ owner_member_id: null, owner_business_entity_id: TRUST, owner_role: 'family_trust', owner_selection_source: 'user_selected' });
  });
  it('joint: the split is stored in basis points summing to 10000', async () => {
    const r = await post({ owner: { kind: 'joint', allocations: [{ memberId: SELF, basisPoints: 6000 }, { memberId: SPOUSE, basisPoints: 4000 }] } });
    expect(r.status).toBe(200);
    expect(docs()[0].owner_role).toBe('joint');
    expect(docs()[0].owner_allocation).toEqual([{ ownerMemberId: SELF, basisPoints: 6000 }, { ownerMemberId: SPOUSE, basisPoints: 4000 }]);
  });
  it.each([
    ['9999', [{ memberId: SELF, basisPoints: 5000 }, { memberId: SPOUSE, basisPoints: 4999 }], 'joint_total_not_100'],
    ['duplicate owner', [{ memberId: SELF, basisPoints: 5000 }, { memberId: SELF, basisPoints: 5000 }], 'joint_duplicate_owner'],
    ['zero share', [{ memberId: SELF, basisPoints: 10000 }, { memberId: SPOUSE, basisPoints: 0 }], 'joint_zero_share'],
  ])('NEGATIVE: a joint split with %s is refused and nothing is stored', async (_label, allocations, expected) => {
    const r = await post({ owner: { kind: 'joint', allocations } });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe(expected);
    expect(docs()).toHaveLength(0);
    expect(h.storageCalls).toBe(0);
  });
  it('a joint CAS without percentages is refused (they are required for investments)', async () => {
    const r = await post({ owner: { kind: 'joint' } });
    expect(r.json.error).toBe('joint_allocation_required');
  });
});

describe('country rules use the profile country, never the request body', () => {
  it('HUF: accepted for an India user; refused for an AU user EVEN THOUGH the body says countryCode IN', async () => {
    const india = await post({ owner: { kind: 'entity', entityId: HUF } });
    expect(india.status).toBe(200);
    expect(docs()[0].owner_role).toBe('other'); // an HUF resolves to the existing 'other' role, never a ninth value
    h.db.tables.ii_source_documents = [];
    h.db.tables.user_profiles = [{ user_id: A, country_of_residence: 'AU' }];
    const au = await post({ countryCode: 'IN', owner: { kind: 'entity', entityId: HUF } }, new TextEncoder().encode('%PDF another file'));
    expect(au.status).toBe(403);
    expect(au.json.error).toBe('owner_not_allowed_for_country');
    expect(docs()).toHaveLength(0);
  });
  it('SMSF is never a CAS owner', async () => {
    h.db.tables.user_profiles = [{ user_id: A, country_of_residence: 'AU' }];
    expect((await post({ owner: { kind: 'smsf' } })).json.error).toBe('owner_not_allowed_for_flow');
  });
});

describe('DECISION 6: the identical file under a different owner is rejected', () => {
  it('names the first owner, stores nothing new, and does not touch storage', async () => {
    const first = await post({ owner: { kind: 'member', memberId: SELF } });
    expect(first.status).toBe(200);
    const storageAfterFirst = h.storageCalls;
    const second = await post({ owner: { kind: 'member', memberId: SPOUSE } });
    expect(second.status).toBe(409);
    expect(second.json.error).toBe('identical_upload_different_owner');
    expect(second.json.existing_document_id).toBe(first.json.data.id);
    expect(second.json.message).toMatch(/already uploaded under Anil.*You chose Priya/);
    expect(docs()).toHaveLength(1);
    expect(docs()[0].owner_member_id).toBe(SELF); // never silently reassigned
    expect(h.storageCalls).toBe(storageAfterFirst);
  });
  it('CONTROL: the identical file under the SAME owner is the usual deduplicated answer', async () => {
    const first = await post({ owner: { kind: 'member', memberId: SELF } });
    const again = await post({ owner: { kind: 'member', memberId: SELF } });
    expect(again.status).toBe(200);
    expect(again.json.data).toMatchObject({ id: first.json.data.id, deduplicated: true });
    expect(docs()).toHaveLength(1);
  });
  it('a joint upload is the same owner only with the same split', async () => {
    const split = (a: number, b: number) => ({ owner: { kind: 'joint', allocations: [{ memberId: SELF, basisPoints: a }, { memberId: SPOUSE, basisPoints: b }] } });
    await post(split(5000, 5000));
    expect((await post(split(5000, 5000))).json.data.deduplicated).toBe(true);
    const different = await post(split(6000, 4000));
    expect(different.status).toBe(409);
    expect(different.json.error).toBe('identical_upload_different_owner');
  });
  it("an earlier copy with NO owner recorded is not silently 'fixed' by the new choice -- the user is told", async () => {
    const bytes = new TextEncoder().encode('%PDF-1.4 fake cas statement one');
    const { createHash } = await import('crypto');
    h.db.insert('ii_source_documents', { id: 'f0000000-0000-4000-8000-000000000001', user_id: A, status: 'parsed', checksum: createHash('sha256').update(bytes).digest('hex'), owner_member_id: null, owner_role: null, owner_selection_source: 'legacy_unset' });
    const r = await post({ owner: { kind: 'member', memberId: SELF } });
    expect(r.status).toBe(409);
    expect(r.json.message).toMatch(/no owner was recorded/);
    expect(docs()[0].owner_member_id).toBeNull();
  });
  it("P1: the same bytes uploaded by ANOTHER user tell this user NOTHING (no 409, no owner name, no id, no 'deduplicated')", async () => {
    const bytes = new TextEncoder().encode('%PDF-1.4 fake cas statement one');
    const { createHash } = await import('crypto');
    const B_DOC = 'f0000000-0000-4000-8000-000000000002';
    h.db.insert('ii_source_documents', { id: B_DOC, user_id: B, status: 'parsed', checksum: createHash('sha256').update(bytes).digest('hex'), owner_member_id: MEM_B, owner_role: 'self', owner_selection_source: 'user_selected' });
    const withB = await post({ owner: { kind: 'member', memberId: SELF } });
    expect(withB.status).toBe(200);
    expect(withB.json.data.deduplicated).toBeUndefined();
    expect(withB.json.data.id).not.toBe(B_DOC);
    expect(JSON.stringify(withB.json)).not.toMatch(new RegExp(`${B_DOC}|Bob|identical|already uploaded`));
    expect(docs().filter((d) => d.user_id === A)).toHaveLength(1);
    expect(h.storageCalls).toBe(1); // stored normally: B's upload is invisible to A
  });
});

describe('a database one migration behind (no 0236 columns)', () => {
  it('a member-owned upload still works (owner_member_id is a long-standing column)', async () => {
    h.missingOwnerColumns = true;
    const r = await post({ owner: { kind: 'member', memberId: SELF } });
    expect(r.status).toBe(200);
    expect(docs()[0].owner_member_id).toBe(SELF);
    expect(docs()[0].owner_role).toBeUndefined();
  });
  it('an entity / joint upload is refused 503 BEFORE anything is stored -- it never stores a file whose owner it cannot record', async () => {
    h.missingOwnerColumns = true;
    const r = await post({ owner: { kind: 'entity', entityId: TRUST } });
    expect(r.status).toBe(503);
    expect(r.json.error).toBe('owner_storage_unavailable');
    expect(docs()).toHaveLength(0);
    expect(h.storageCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Owner application to accounts
// ---------------------------------------------------------------------------
const ACC_NEW = 'c0000000-0000-4000-8000-000000000001';
const ACC_EMPTY = 'c0000000-0000-4000-8000-000000000002';
const ACC_SAME = 'c0000000-0000-4000-8000-000000000003';
const ACC_OTHER = 'c0000000-0000-4000-8000-000000000004';
const ACC_B = 'c0000000-0000-4000-8000-0000000000b1';
const DOC = 'd0000000-0000-4000-8000-000000000001';

function seedAccounts() {
  const base = { account_type: 'mf_folio', country_code: 'IN', currency_code: 'INR', institution_name: 'AMC', status: 'active' };
  h.db.insert('ii_accounts', { id: ACC_NEW, user_id: A, owner_member_id: null, folio_number: 'F1', ...base });
  h.db.insert('ii_accounts', { id: ACC_EMPTY, user_id: A, owner_member_id: null, folio_number: 'F2', ...base });
  h.db.insert('ii_accounts', { id: ACC_SAME, user_id: A, owner_member_id: SELF, folio_number: 'F3', ...base });
  h.db.insert('ii_accounts', { id: ACC_OTHER, user_id: A, owner_member_id: SPOUSE, folio_number: 'F4', ...base });
  h.db.insert('ii_accounts', { id: ACC_B, user_id: B, owner_member_id: MEM_B, folio_number: 'FB', ...base });
}
const acc = (id: string) => h.db.rows('ii_accounts').find((a) => a.id === id)!;
const alloc = (id: string) => h.db.rows('ii_ownership_allocation').filter((r) => r.ii_account_id === id && r.status === 'active');
const A_ = (accountId: string, created: boolean) => ({ accountId, created, folioNumber: `F-${accountId.slice(-1)}`, institutionName: 'AMC' });
const selfOwner = { kind: 'member' as const, ownerRole: 'self', ownerMemberId: SELF, ownerBusinessEntityId: null, allocations: null };

describe('the document owner flows to the accounts', () => {
  it('entity: a NEW account gets a single 10000bp allocation to the entity (and no member owner)', async () => {
    seedAccounts();
    const review = await applyDocumentOwnerToAccounts(A, DOC, { kind: 'entity', ownerRole: 'family_trust', ownerMemberId: null, ownerBusinessEntityId: TRUST, allocations: null }, [A_(ACC_NEW, true)]);
    expect(review.appliedAccountIds).toEqual([ACC_NEW]);
    const rows = alloc(ACC_NEW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ owner_business_entity_id: TRUST, owner_member_id: null, allocation_basis_points: 10000, owner_role: 'family_trust', source: 'user' });
    expect(acc(ACC_NEW).owner_member_id).toBeNull();
  });
  it('joint: the split is written per account and sums to 10000', async () => {
    seedAccounts();
    const owner = { kind: 'joint' as const, ownerRole: 'joint', ownerMemberId: null, ownerBusinessEntityId: null, allocations: [{ ownerMemberId: SELF, basisPoints: 3334 }, { ownerMemberId: SPOUSE, basisPoints: 3333 }, { ownerBusinessEntityId: TRUST, basisPoints: 3333 }] };
    await applyDocumentOwnerToAccounts(A, DOC, owner, [A_(ACC_NEW, true), A_(ACC_EMPTY, false)]);
    for (const id of [ACC_NEW, ACC_EMPTY]) {
      const rows = alloc(id);
      expect(rows.reduce((n, r) => n + (r.allocation_basis_points as number), 0)).toBe(10000);
      expect(rows.every((r) => r.owner_role === 'joint')).toBe(true);
    }
    expect(acc(ACC_EMPTY).owner_member_id).toBeNull();
  });
  it('member: an existing account with no owner is FILLED IN', async () => {
    seedAccounts();
    const review = await applyDocumentOwnerToAccounts(A, DOC, selfOwner, [A_(ACC_EMPTY, false)]);
    expect(acc(ACC_EMPTY).owner_member_id).toBe(SELF);
    expect(review.appliedAccountIds).toEqual([ACC_EMPTY]);
    expect(review.conflicts).toEqual([]);
  });
  it('member: an existing account that already has the same owner is untouched', async () => {
    seedAccounts();
    const review = await applyDocumentOwnerToAccounts(A, DOC, selfOwner, [A_(ACC_SAME, false)]);
    expect(review).toEqual({ conflicts: [], warnings: [], appliedAccountIds: [], targetSignature: `member:${SELF}` });
  });
});

describe('DECISION 2: an existing account owner is never silently overwritten', () => {
  it('a different owner is KEPT and recorded as a conflict naming both owners', async () => {
    seedAccounts();
    const review = await applyDocumentOwnerToAccounts(A, DOC, selfOwner, [A_(ACC_OTHER, false)]);
    expect(acc(ACC_OTHER).owner_member_id).toBe(SPOUSE); // NOT overwritten
    expect(review.conflicts).toHaveLength(1);
    expect(review.conflicts[0]).toMatchObject({ accountId: ACC_OTHER, existingOwner: 'Priya', selectedOwner: 'Anil' });
    expect(review.appliedAccountIds).toEqual([]);
  });
  it('only the user\'s explicit confirmation changes it -- and only for a folio recorded as a conflict on THAT document', async () => {
    seedAccounts();
    h.db.insert('ii_source_documents', { id: DOC, user_id: A, status: 'parsed', owner_member_id: SELF, owner_role: 'self', owner_selection_source: 'user_selected', owner_review: null });
    const review = await applyDocumentOwnerToAccounts(A, DOC, selfOwner, [A_(ACC_OTHER, false)]);
    h.db.rows('ii_source_documents')[0].owner_review = review;

    // another user's account id, and an account that is not a conflict, are refused
    const foreign = await confirmOwnerChange(A, DOC, [ACC_B], `member:${SELF}`);
    expect(foreign).toMatchObject({ ok: false, status: 422 });
    expect((await confirmOwnerChange(A, DOC, [ACC_SAME], `member:${SELF}`)).ok).toBe(false);
    expect(acc(ACC_B).owner_member_id).toBe(MEM_B);
    expect(acc(ACC_OTHER).owner_member_id).toBe(SPOUSE);
    // another user cannot confirm on this document
    expect(await confirmOwnerChange(B, DOC, [ACC_OTHER], `member:${SELF}`)).toMatchObject({ ok: false, status: 404 });

    const confirmed = await confirmOwnerChange(A, DOC, [ACC_OTHER], `member:${SELF}`);
    expect(confirmed).toMatchObject({ ok: true, changed: [ACC_OTHER], remainingConflicts: 0 });
    expect(acc(ACC_OTHER).owner_member_id).toBe(SELF);
    expect((h.db.rows('ii_source_documents')[0].owner_review as any).conflicts).toEqual([]);
  });
  it('the pure planner: fill when empty, noop when equal, conflict when different', () => {
    expect(planAccountOwner(null, 'member:x')).toBe('apply');
    expect(planAccountOwner('member:x', 'member:x')).toBe('noop');
    expect(planAccountOwner('member:x', 'member:y')).toBe('conflict');
    expect(planAccountOwner('member:x', 'joint:member:x=5000,member:y=5000')).toBe('conflict');
  });
  it('ownership signatures ignore order and treat a single 10000bp allocation as that owner', () => {
    const joint = (a: number, b: number) => ownerSignature({ allocations: [{ ownerMemberId: 'x', basisPoints: a }, { ownerMemberId: 'y', basisPoints: b }] });
    expect(joint(5000, 5000)).toBe(ownerSignature({ allocations: [{ ownerMemberId: 'y', basisPoints: 5000 }, { ownerMemberId: 'x', basisPoints: 5000 }] }));
    expect(joint(5000, 5000)).not.toBe(joint(6000, 4000));
    expect(ownerSignature({ allocations: [{ ownerBusinessEntityId: 'e', basisPoints: 10000 }] })).toBe('entity:e');
  });
});

describe('holder-name mismatch is a NON-BLOCKING warning for new uploads; legacy cases are untouched', () => {
  const members = [
    { id: SELF, fullName: 'Anil Sharma', relationship: 'self', isActive: true },
    { id: SPOUSE, fullName: 'Priya Sharma', relationship: 'spouse', isActive: true },
  ];
  const acct = (over: Partial<ParsedAccountRecord>): ParsedAccountRecord => ({ folioNumber: 'F1', accountNumberMasked: null, amcName: '', holderName: null, panMasked: null, jointHolders: [], holdingModeRaw: null, raw: '', ...over });
  const run = (parsedAccounts: ParsedAccountRecord[]) =>
    computeHolderNameWarnings({ declaredOwnerMemberId: SELF, assignments: [{ folioNumber: 'F1', accountId: ACC_NEW }], parsedAccounts, members });

  it('a printed name that matches nobody -> one warning, no block', () => {
    const w = run([acct({ holderName: 'Zed Quark' })]);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ accountId: ACC_NEW, kind: 'holder_name_mismatch' });
    expect(w[0].message).toMatch(/filed under the owner you chose/);
  });
  it('a printed name that matches a DIFFERENT member -> warns, and says so', () => {
    expect(run([acct({ holderName: 'Priya Sharma' })])[0].kind).toBe('holder_matches_other_member');
  });
  it('a printed joint holding while a single owner was chosen -> warns', () => {
    expect(run([acct({ holderName: 'Anil Sharma', holdingModeRaw: 'Joint' })])[0].kind).toBe('statement_prints_joint_holding');
  });
  it('CONTROL: a name that matches the chosen owner, or no printed evidence at all, is silent', () => {
    expect(run([acct({ holderName: 'Anil Sharma' })])).toEqual([]);
    expect(run([acct({ holderName: null })])).toEqual([]);
  });

  it('processing: a document with a chosen owner takes the new branch and that branch opens NO reconciliation case', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../lib/services/investment-intelligence/documentProcessing.ts'), 'utf8');
    const start = src.indexOf('if (documentOwner) {');
    const end = src.indexOf('} else if (ownerUnresolved) {');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const newBranch = src.slice(start, end);
    expect(newBranch).not.toMatch(/openReconciliationCase/);
    expect(newBranch).toMatch(/computeHolderNameWarnings/);
    // CONTROL: the LEGACY branches that follow still open the blocking cases, unchanged.
    const legacy = src.slice(end, end + 12000);
    expect(legacy).toMatch(/discrepancyType: 'owner_unmatched'/);
    expect(legacy).toMatch(/discrepancyType: 'owner_mismatch'/);
    expect(legacy).toMatch(/discrepancyType: 'joint_holding_allocation_required'/);
  });
  it('a LEGACY document (owner_member_id but no user_selected source) has no document owner, so it keeps the legacy cases', () => {
    expect(readDocumentOwner({ owner_member_id: SELF, owner_selection_source: null, owner_role: null })).toBeNull();
    expect(readDocumentOwner({ owner_member_id: SELF, owner_selection_source: 'backfill_from_document', owner_role: 'self' })).toBeNull();
    expect(readDocumentOwner({ owner_member_id: SELF, owner_selection_source: 'legacy_unset', owner_role: null })).toBeNull();
    expect(readDocumentOwner({ owner_member_id: SELF, owner_selection_source: 'user_selected', owner_role: 'self' })).toMatchObject({ kind: 'member', ownerMemberId: SELF });
  });
  it('the Review / Resolutions surfaces and the owner-assignment route still handle the legacy case types', () => {
    const route = fs.readFileSync(path.resolve(__dirname, '../../app/api/investment-intelligence/accounts/[id]/owner/route.ts'), 'utf8');
    // ONE ownership model: the route resolves the legacy case types through the canonical writer / case-type list.
    expect(route).toMatch(/applyAccountOwnerChange/);
    expect(route).toMatch(/isOwnerCaseType/);
    expect(OWNER_CASE_TYPES).toEqual(expect.arrayContaining(['owner_unmatched', 'owner_mismatch', 'joint_holding_allocation_required']));
    const client = fs.readFileSync(path.resolve(__dirname, '../../components/investment-intelligence/InvestmentIntelligenceClient.tsx'), 'utf8');
    expect(client).toMatch(/c\.discrepancy_type === 'owner_unmatched'/);
    expect(client).toMatch(/handleAssignOwner/);
  });
});

describe('PO-OBU-05: conflicted folios are decided ONE BY ONE, never as one indivisible action', () => {
  const ACC_X = 'c0000000-0000-4000-8000-000000000005';
  const ACC_Y = 'c0000000-0000-4000-8000-000000000006';
  async function seedThreeConflicts() {
    seedAccounts();
    const base = { account_type: 'mf_folio', country_code: 'IN', currency_code: 'INR', institution_name: 'AMC', status: 'active' };
    h.db.insert('ii_accounts', { id: ACC_X, user_id: A, owner_member_id: SPOUSE, folio_number: 'FX', ...base });
    h.db.insert('ii_accounts', { id: ACC_Y, user_id: A, owner_member_id: SPOUSE, folio_number: 'FY', ...base });
    h.db.insert('ii_source_documents', { id: DOC, user_id: A, status: 'parsed', owner_member_id: SELF, owner_role: 'self', owner_selection_source: 'user_selected', owner_review: null });
    const review = await applyDocumentOwnerToAccounts(A, DOC, selfOwner, [A_(ACC_OTHER, false), A_(ACC_X, false), A_(ACC_Y, false)]);
    h.db.rows('ii_source_documents')[0].owner_review = review;
    return review;
  }
  it('three folios conflict; the user ticks TWO: exactly those two change, the third is untouched, each is audited', async () => {
    const review = await seedThreeConflicts();
    expect(review.conflicts.map((c) => c.accountId).sort()).toEqual([ACC_OTHER, ACC_X, ACC_Y].sort());
    expect(review.targetSignature).toBe(`member:${SELF}`);
    const r = await confirmOwnerChange(A, DOC, [ACC_OTHER, ACC_Y], `member:${SELF}`);
    expect(r).toMatchObject({ ok: true, remainingConflicts: 1 });
    expect(acc(ACC_OTHER).owner_member_id).toBe(SELF);
    expect(acc(ACC_Y).owner_member_id).toBe(SELF);
    expect(acc(ACC_X).owner_member_id).toBe(SPOUSE); // NOT ticked: unchanged
    const stored = h.db.rows('ii_source_documents')[0].owner_review as any;
    expect(stored.conflicts.map((c: any) => c.accountId)).toEqual([ACC_X]); // still waiting
    const audits = h.db.rows('ii_audit_events').filter((e) => (e.metadata as any)?.outcome === 'owner_change_confirmed_at_upload');
    expect(audits.map((e) => e.subject_id).sort()).toEqual([ACC_OTHER, ACC_Y].sort()); // one audit per changed folio, none for the third
    expect(audits.every((e) => (e.metadata as any).previousOwner === 'Priya' && (e.metadata as any).newOwner === 'Anil')).toBe(true);
  });
  it('NEGATIVE: an empty selection changes nothing; a stale or missing target owner changes nothing', async () => {
    await seedThreeConflicts();
    expect(await confirmOwnerChange(A, DOC, [], `member:${SELF}`)).toMatchObject({ ok: false, status: 422 });
    expect(await confirmOwnerChange(A, DOC, [ACC_X], `member:${SPOUSE}`)).toMatchObject({ ok: false, status: 409 }); // not the owner shown
    expect(await confirmOwnerChange(A, DOC, [ACC_X], null)).toMatchObject({ ok: false, status: 409 });
    for (const id of [ACC_OTHER, ACC_X, ACC_Y]) expect(acc(id).owner_member_id).toBe(SPOUSE);
    expect(h.db.rows('ii_audit_events').filter((e) => (e.metadata as any)?.outcome === 'owner_change_confirmed_at_upload')).toHaveLength(0);
  });
  it('the route body must name the folios AND the target owner (strict); extra keys are refused', async () => {
    const route = await import('@/app/api/investment-intelligence/source-documents/[id]/confirm-owner/route');
    const call = (body: unknown) => route.POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: DOC }) });
    expect((await call({ accountIds: [ACC_X] })).status).toBe(422); // no target owner
    expect((await call({ accountIds: [ACC_X], targetSignature: `member:${SELF}`, all: true })).status).toBe(422);
    expect((await call({ accountIds: [], targetSignature: `member:${SELF}` })).status).toBe(422);
  });
  it('the UI lists EACH folio with its own unchecked checkbox, offers Select all, names the target owner and needs a confirmation', () => {
    const panel = fs.readFileSync(path.resolve(__dirname, '../../components/investment-intelligence/OwnerConflictPanel.tsx'), 'utf8');
    expect(panel).toMatch(/useState<Set<string>>\(new Set\(\)\)/); // nothing ticked by default
    expect(panel).toMatch(/type="checkbox" checked=\{selected\.has\(c\.accountId\)\}/);
    expect(panel).toMatch(/Select all/);
    expect(panel).toMatch(/change to <strong>\{targetLabel\}<\/strong>/);
    expect(panel).toMatch(/Confirm change/);
    expect(panel).toMatch(/onConfirm\(ticked\.map/); // only the ticked folios are sent
    const client = fs.readFileSync(path.resolve(__dirname, '../../components/investment-intelligence/InvestmentIntelligenceClient.tsx'), 'utf8');
    expect(client).toMatch(/<OwnerConflictPanel/);
    expect(client).toMatch(/targetSignature/);
    // The old indivisible "change all conflicted folios" action is gone.
    expect(client).not.toMatch(/conflicts\.map\(\(c\) => c\.accountId\)\)/);
    expect(client).not.toMatch(/Change these folios to/);
  });
});

describe('"this is not joint": a statement that prints a joint holding but is solely owned', () => {
  const warn = (accountId: string) => ({ accountId, kind: 'statement_prints_joint_holding' as const, maskedHolderName: null, message: 'prints a joint holding' });
  function seedDoc(review: unknown, over: Record<string, unknown> = {}) {
    h.db.insert('ii_source_documents', { id: DOC, user_id: A, status: 'parsed', owner_member_id: SELF, owner_role: 'self', owner_selection_source: 'user_selected', owner_review: review, ...over });
  }
  it('dismisses ONLY the listed folios joint warning, remembers it, and does not touch any account owner', async () => {
    seedAccounts();
    seedDoc({ conflicts: [], appliedAccountIds: [], warnings: [warn(ACC_NEW), warn(ACC_EMPTY), { accountId: ACC_NEW, kind: 'holder_name_mismatch', maskedHolderName: null, message: 'x' }] });
    const r = await confirmSoleOwner(A, DOC, [ACC_NEW]);
    expect(r).toMatchObject({ ok: true, acknowledged: [ACC_NEW], remainingWarnings: 2 });
    const review = h.db.rows('ii_source_documents')[0].owner_review as any;
    expect(review.acknowledgedSoleOwner).toEqual([ACC_NEW]);
    expect(review.warnings.map((w: any) => `${w.accountId}:${w.kind}`)).toEqual([`${ACC_EMPTY}:statement_prints_joint_holding`, `${ACC_NEW}:holder_name_mismatch`]);
    expect(acc(ACC_NEW).owner_member_id).toBeNull(); // untouched: confirming is not an owner change
    expect(h.db.rows('ii_audit_events').some((e) => (e.metadata as any)?.outcome === 'confirmed_sole_owner')).toBe(true);
  });
  it('NEGATIVE: another user, a folio without that warning, or a joint/entity-owned document is refused', async () => {
    seedAccounts();
    seedDoc({ conflicts: [], appliedAccountIds: [], warnings: [warn(ACC_NEW)] });
    expect(await confirmSoleOwner(B, DOC, [ACC_NEW])).toMatchObject({ ok: false, status: 404 });
    expect(await confirmSoleOwner(A, DOC, [ACC_EMPTY])).toMatchObject({ ok: false, status: 422 });
    h.db.tables.ii_source_documents = [];
    seedDoc({ conflicts: [], appliedAccountIds: [], warnings: [warn(ACC_NEW)] }, { owner_member_id: null, owner_role: 'joint', owner_allocation: [{ ownerMemberId: SELF, basisPoints: 5000 }, { ownerMemberId: SPOUSE, basisPoints: 5000 }] });
    expect(await confirmSoleOwner(A, DOC, [ACC_NEW])).toMatchObject({ ok: false, status: 409 });
    expect((h.db.rows('ii_source_documents')[0].owner_review as any).warnings).toHaveLength(1);
  });
  it('a reprocess does not warn again about a folio the user already confirmed (and still warns about others)', () => {
    const warnings = [warn(ACC_NEW), warn(ACC_EMPTY)];
    expect(withoutAcknowledgedWarnings(warnings, [ACC_NEW]).map((w) => w.accountId)).toEqual([ACC_EMPTY]);
    expect(withoutAcknowledgedWarnings(warnings, undefined)).toHaveLength(2); // CONTROL
    const src = fs.readFileSync(path.resolve(__dirname, '../../lib/services/investment-intelligence/documentProcessing.ts'), 'utf8');
    expect(src).toMatch(/withoutAcknowledgedWarnings\(ownerReview\.warnings, acknowledged\)/);
  });
  it('the statement detail offers the confirmation only on a joint-holding warning', () => {
    const client = fs.readFileSync(path.resolve(__dirname, '../../components/investment-intelligence/InvestmentIntelligenceClient.tsx'), 'utf8');
    expect(client).toMatch(/w\.kind === 'statement_prints_joint_holding' && \(/);
    expect(client).toMatch(/confirm-sole-owner/);
    expect(client).toMatch(/This is not joint/);
  });
});

describe('the document purge keeps the owner (II)', () => {
  it('sourceDocumentPurge only ever writes the storage_* columns, never an owner column', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../lib/services/investment-intelligence/sourceDocumentPurge.ts'), 'utf8');
    const updates = [...src.matchAll(/\.update\(\{([^}]*)\}\)/g)].map((m) => m[1]);
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) {
      expect(u).toMatch(/storage_purge/);
      expect(u).not.toMatch(/owner_/);
    }
  });
});

describe('the upload form', () => {
  const client = fs.readFileSync(path.resolve(__dirname, '../../components/investment-intelligence/InvestmentIntelligenceClient.tsx'), 'utf8');
  it('uses the shared OwnerSelector, has no default owner, sends it in meta, and cannot upload without it', () => {
    expect(client).toMatch(/<OwnerSelector flow="ii_cas"/);
    expect(client).toMatch(/useState<OwnerSelection \| null>\(null\)/);
    expect(client).toMatch(/\.\.\.ownerSelectionToMeta\(owner\)/);
    expect(client).toMatch(/disabled=\{!file \|\| !owner \|\| uploading\}/);
    expect(client).toMatch(/if \(!file \|\| !owner\) return;/);
  });
  it('ownerColumnsFor writes exactly the columns the migration adds', () => {
    const cols = Object.keys(ownerColumnsFor({ kind: 'member', ownerRole: 'self', ownerMemberId: SELF, ownerBusinessEntityId: null, entityType: null, allocations: null, label: 'x' }));
    expect(cols.sort()).toEqual(['owner_allocation', 'owner_business_entity_id', 'owner_member_id', 'owner_role', 'owner_selection_source']);
    const sql = fs.readFileSync(path.resolve(__dirname, '../../supabase/migrations/0236_owner_before_upload_phase1.sql'), 'utf8');
    for (const c of cols.filter((c) => c !== 'owner_member_id')) expect(sql).toContain(`add column if not exists ${c} `);
  });
});
