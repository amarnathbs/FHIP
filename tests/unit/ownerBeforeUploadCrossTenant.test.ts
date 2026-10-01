/**
 * Owner-before-upload: CROSS-TENANT matrix for every owner-capable route this
 * branch adds or changes.
 *
 * For each route, User A supplies something that belongs to User B (a member id,
 * an entity id, a joint participant, a statement id, an account id, a source
 * document id). The assertion is stronger than "refused": the response must be
 * IDENTICAL to the response for an id that does not exist anywhere (same status,
 * same error code, same message), so a caller cannot tell "someone else's" from
 * "missing" (non-enumerating), and it must contain none of B's names or ids.
 *
 * Routes that belong to the owner-edit branch (PATCH accounts/:id/owner,
 * resolutions amend, reconciliation-case resolve) carry their own cross-tenant
 * tests there (tests/unit/iiOwnerChangeRoutes.test.ts) and are listed in the
 * final matrix document, not re-tested here.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, type FakeDb } from '../support/fdhFakeSupabase';

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, user: null as { id: string } | null, seq: 0 }));

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db.sessionClient(h.user!.id) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.adminClient() }));
vi.mock('@/lib/financial-data-hub/constants/featureFlags', () => ({ isFdhDocumentUploadEnabled: () => true }));
vi.mock('@/lib/financial-data-hub/services/storage', () => ({ downloadDocumentObject: async () => ({ ok: false, message: 'none' }) }));
vi.mock('@/lib/financial-data-hub/services/uploadLifecycle', async () => {
  const { sha256Hex } = await import('@/lib/financial-data-hub/domain/fileValidation');
  return {
    FdhUploadLifecycleError: class extends Error { constructor(readonly code: string, message: string) { super(message); } },
    createUploadSession: async () => ({ session: { id: 's' } }),
    completeUpload: async (userId: string, _s: string, bytes: Uint8Array) => {
      h.seq += 1;
      return { ...h.db.insert('fdh_statement_uploads', { id: `d0000000-0000-4000-8000-${String(h.seq).padStart(12, '0')}`, user_id: userId, processing_status: 'queued', source_type: 'csv', document_type: 'bank_statement', currency_code: 'AUD', country_code: 'AU', financial_account_id: null, file_hash: sha256Hex(bytes) }) };
    },
  };
});
vi.mock('@/lib/services/investment-intelligence/storage', () => ({
  validateUploadedFile: () => ({ ok: true }),
  generateObjectKey: (u: string, n: string) => `${u}/${n}`,
  uploadSourceDocumentObject: async () => ({ error: null }),
}));
vi.mock('@/lib/services/investment-intelligence/uploadAdmission', () => ({ scanUploadedPdfForAdmission: () => ({ ok: true }), uploadAdmissionFailureMessage: () => 'x' }));
vi.mock('@/lib/services/investment-intelligence/realScanAdmission', () => ({ startIiRealScan: async () => ({ admitted: true }), II_SCAN_BLOCKED_MESSAGE: 'b', II_SCAN_UNAVAILABLE_MESSAGE: 'u' }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireCountryConfirmedUser: async () => (h.user ? { user: h.user } : { user: null, unauthenticated: Response.json({ error: 'unauthenticated' }, { status: 401 }) }),
}));

vi.setConfig({ testTimeout: 30000 });

const A = 'a0000000-0000-4000-8000-00000000000a';
const B = 'b0000000-0000-4000-8000-00000000000b';
const MEM_A = 'a1111111-1111-4111-8111-111111111111';
const MEM_A2 = 'a2222222-2222-4222-8222-222222222222';
const MEM_B = 'b1111111-1111-4111-8111-111111111111';
const ENT_B = 'b2222222-2222-4222-8222-222222222222';
const ENT_A = 'a3333333-3333-4333-8333-333333333333';
const DOC_B = 'b3333333-3333-4333-8333-333333333333';
const ACC_B = 'b4444444-4444-4444-8444-444444444444';
const DOC_A = 'a4444444-4444-4444-8444-444444444444';
const ACC_A = 'a5555555-5555-4555-8555-555555555555';
const MISSING = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const B_SECRETS = /Bobby Tables|B Family Trust|BSECRET/i;

async function call(route: string, args: any[]) {
  const mod: any = await import(route);
  const res: Response = await mod[args[0]](...args.slice(1));
  return { status: res.status, body: await res.json() as any };
}
const same = (x: { status: number; body: any }, y: { status: number; body: any }) => {
  expect({ status: x.status, error: x.body.error, message: x.body.message }).toEqual({ status: y.status, error: y.body.error, message: y.body.message });
  expect(JSON.stringify(x.body)).not.toMatch(B_SECRETS);
  expect(JSON.stringify(x.body)).not.toContain(B);
};

beforeEach(() => {
  h.db = createFakeDb();
  h.user = { id: A };
  h.seq = 0;
  h.db.insert('user_profiles', { user_id: A, country_of_residence: 'IN' });
  h.db.insert('household_members', { id: MEM_A, user_id: A, full_name: 'Anil', relationship: 'self', is_active: true });
  h.db.insert('household_members', { id: MEM_A2, user_id: A, full_name: 'Priya', relationship: 'spouse', is_active: true });
  h.db.insert('household_members', { id: MEM_B, user_id: B, full_name: 'Bobby Tables', relationship: 'self', is_active: true });
  h.db.insert('business_entities', { id: ENT_B, user_id: B, name: 'B Family Trust', entity_type: 'family_trust', is_active: true });
  h.db.insert('business_entities', { id: ENT_A, user_id: A, name: 'A Trust', entity_type: 'family_trust', is_active: true });
  h.db.insert('ii_sources', { id: 's0000000-0000-4000-8000-000000000001', source_key: 'manual' });
  h.db.insert('ii_source_documents', { id: DOC_B, user_id: B, status: 'parsed', owner_member_id: MEM_B, owner_role: 'self', owner_selection_source: 'user_selected', owner_review: { conflicts: [{ accountId: ACC_B, existingOwner: 'BSECRET' }], warnings: [{ accountId: ACC_B, kind: 'statement_prints_joint_holding', message: 'BSECRET' }], appliedAccountIds: [], targetSignature: `member:${MEM_B}` } });
  h.db.insert('ii_source_documents', { id: DOC_A, user_id: A, status: 'parsed', owner_member_id: MEM_A, owner_role: 'self', owner_selection_source: 'user_selected', owner_review: { conflicts: [], warnings: [], appliedAccountIds: [], targetSignature: `member:${MEM_A}` } });
  h.db.insert('ii_accounts', { id: ACC_B, user_id: B, owner_member_id: MEM_B, account_type: 'mf_folio', country_code: 'IN', currency_code: 'INR', institution_name: 'AMC', folio_number: 'FB', status: 'active' });
  h.db.insert('ii_accounts', { id: ACC_A, user_id: A, owner_member_id: MEM_A2, account_type: 'mf_folio', country_code: 'IN', currency_code: 'INR', institution_name: 'AMC', folio_number: 'FA', status: 'active' });
  h.db.insert('fdh_financial_accounts', { id: ACC_B, user_id: B, institution_id: null, account_type: 'transaction', country_code: 'AU', currency_code: 'AUD', display_name: 'BSECRET account', masked_identifier: '9999', account_fingerprint: 'x', status: 'active', owner_role: 'smsf' });
  h.db.insert('fdh_statement_uploads', { id: DOC_B, user_id: B, source_type: 'csv', document_type: 'bank_statement', currency_code: 'AUD', financial_account_id: null, processing_status: 'queued' });
});

const CSV = new TextEncoder().encode('Date,Description,Amount\n2026-08-01,COFFEE,-4.50\n');
const bankPost = (kind: 'csv' | 'pdf', owner: unknown) => {
  const route = `@/app/api/financial-data-hub/bank-${kind}/upload/route`;
  const qs = new URLSearchParams({ country_code: 'AU', currency_code: 'AUD', owner: JSON.stringify(owner) });
  return call(route, ['POST', new Request(`http://x?${qs}`, { method: 'POST', headers: { 'content-length': String(CSV.byteLength) }, body: CSV as unknown as BodyInit })]);
};
const casPost = (owner: unknown) => {
  const form = new FormData();
  form.append('file', new File([new TextEncoder().encode('%PDF cas ' + Math.random()) as unknown as BlobPart], 'c.pdf', { type: 'application/pdf' }));
  form.append('meta', JSON.stringify({ sourceKey: 'cams', documentType: 'cas_statement', countryCode: 'IN', owner }));
  return call('@/app/api/investment-intelligence/source-documents/route', ['POST', new Request('http://x', { method: 'POST', body: form })]);
};

describe("bank upload (CSV and PDF): A supplies B's member / entity / joint participant", () => {
  it.each(['csv', 'pdf'] as const)('%s: B member id, B entity id and a B joint participant are indistinguishable from a missing id', async (kind) => {
    const missingMember = await bankPost(kind, { kind: 'member', memberId: MISSING });
    expect(missingMember.status).toBe(422);
    same(await bankPost(kind, { kind: 'member', memberId: MEM_B }), missingMember);
    // an entity is refused for bank by policy BEFORE ownership is even consulted: B's entity and a missing one answer the same
    same(await bankPost(kind, { kind: 'entity', entityId: ENT_B }), await bankPost(kind, { kind: 'entity', entityId: MISSING }));
    // bank joint takes no participants at all: naming B's member in one is refused the same way as naming a missing one
    same(await bankPost(kind, { kind: 'joint', allocations: [{ memberId: MEM_A, basisPoints: 5000 }, { memberId: MEM_B, basisPoints: 5000 }] }), await bankPost(kind, { kind: 'joint', allocations: [{ memberId: MEM_A, basisPoints: 5000 }, { memberId: MISSING, basisPoints: 5000 }] }));
    expect(h.db.rows('fdh_statement_uploads').filter((r) => r.user_id === A)).toHaveLength(0); // nothing stored for any of them
  });
});

describe("India CAS upload: A supplies B's member / entity / joint participant", () => {
  it('B member id, B entity id and B joint participant answer exactly like a missing id; nothing stored', async () => {
    same(await casPost({ kind: 'member', memberId: MEM_B }), await casPost({ kind: 'member', memberId: MISSING }));
    same(await casPost({ kind: 'entity', entityId: ENT_B }), await casPost({ kind: 'entity', entityId: MISSING }));
    same(
      await casPost({ kind: 'joint', allocations: [{ memberId: MEM_A, basisPoints: 5000 }, { entityId: ENT_B, basisPoints: 5000 }] }),
      await casPost({ kind: 'joint', allocations: [{ memberId: MEM_A, basisPoints: 5000 }, { entityId: MISSING, basisPoints: 5000 }] }),
    );
    expect(h.db.rows('ii_source_documents').filter((r) => r.user_id === A && r.id !== DOC_A)).toHaveLength(0);
    // CONTROL: A's own members and entity are accepted.
    expect((await casPost({ kind: 'member', memberId: MEM_A2 })).status).toBe(200);
    expect((await casPost({ kind: 'entity', entityId: ENT_A })).status).toBe(200);
  });
});

describe('confirm-owner / confirm-sole-owner: A supplies B\'s source document id and B\'s account id', () => {
  const confirm = (id: string, body: unknown) => call('@/app/api/investment-intelligence/source-documents/[id]/confirm-owner/route', ['POST', new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) }]);
  const sole = (id: string, body: unknown) => call('@/app/api/investment-intelligence/source-documents/[id]/confirm-sole-owner/route', ['POST', new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) }]);

  it("B's source document id is indistinguishable from a missing one, and nothing of B changes", async () => {
    same(await confirm(DOC_B, { accountIds: [ACC_B], targetSignature: `member:${MEM_B}` }), await confirm(MISSING, { accountIds: [ACC_B], targetSignature: `member:${MEM_B}` }));
    same(await sole(DOC_B, { accountIds: [ACC_B] }), await sole(MISSING, { accountIds: [ACC_B] }));
    expect(h.db.rows('ii_accounts').find((a) => a.id === ACC_B)!.owner_member_id).toBe(MEM_B);
    expect((h.db.rows('ii_source_documents').find((d) => d.id === DOC_B)!.owner_review as any).conflicts).toHaveLength(1);
  });
  it("A's own document but B's account id is indistinguishable from a missing account id", async () => {
    same(await confirm(DOC_A, { accountIds: [ACC_B], targetSignature: `member:${MEM_A}` }), await confirm(DOC_A, { accountIds: [MISSING], targetSignature: `member:${MEM_A}` }));
    same(await sole(DOC_A, { accountIds: [ACC_B] }), await sole(DOC_A, { accountIds: [MISSING] }));
    expect(h.db.rows('ii_accounts').find((a) => a.id === ACC_B)!.owner_member_id).toBe(MEM_B);
  });
});

describe('statement summary: A reads B\'s source document id', () => {
  it('404 identical to a missing id, with no owner label, role or review text', async () => {
    const get = (id: string) => call('@/app/api/investment-intelligence/source-documents/[id]/summary/route', ['GET', new Request('http://x'), { params: Promise.resolve({ id }) }]);
    same(await get(DOC_B), await get(MISSING));
  });
});

describe('bank resolve-account: A supplies B\'s statement id and B\'s account id', () => {
  const resolve = (id: string, body: unknown) => call('@/app/api/financial-data-hub/bank-statements/[documentId]/resolve-account/route', ['POST', new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ documentId: id }) }]);
  it("B's statement id is a 404 identical to a missing statement, for every input shape, and B's statement is never assigned", async () => {
    h.db.insert('fdh_financial_accounts', { id: 'a6666666-6666-4666-8666-666666666666', user_id: A, institution_id: null, account_type: 'transaction', country_code: 'AU', currency_code: 'AUD', display_name: 'Mine', masked_identifier: '1111', account_fingerprint: 'y', status: 'active' });
    for (const body of [{}, { account_id: 'a6666666-6666-4666-8666-666666666666' }, { new_account_digits: '1234' }]) {
      same(await resolve(DOC_B, body), await resolve(MISSING, body));
    }
    expect(h.db.rows('fdh_statement_uploads').find((d) => d.id === DOC_B)!.financial_account_id).toBeNull();
    expect(h.db.rows('fdh_financial_accounts').filter((a) => a.user_id === A)).toHaveLength(1); // no account minted for B's statement
  });
  it("A's own statement with B's account id is indistinguishable from a missing account id; B's account is never touched", async () => {
    h.db.insert('fdh_statement_uploads', { id: DOC_A, user_id: A, source_type: 'csv', document_type: 'bank_statement', currency_code: 'AUD', financial_account_id: null, processing_status: 'queued' });
    same(await resolve(DOC_A, { account_id: ACC_B }), await resolve(DOC_A, { account_id: MISSING }));
    expect(h.db.rows('fdh_financial_accounts').find((a) => a.id === ACC_B)!.owner_role).toBe('smsf');
    expect(h.db.rows('fdh_statement_uploads').find((d) => d.id === DOC_A)!.financial_account_id).toBeNull();
  });
});

describe('ownership options / self: only the caller\'s own owners, never a name of another tenant', () => {
  it('options list none of B\'s members or entities; self creates only for the caller', async () => {
    const opts = await call('@/app/api/ownership/options/route', ['GET', new Request('http://x?flow=ii_cas')]);
    expect(JSON.stringify(opts.body)).not.toMatch(B_SECRETS);
    expect(opts.body.data.members.map((m: any) => m.label).sort()).toEqual(['Anil', 'Priya']);
    expect(opts.body.data.entities.map((e: any) => e.label)).toEqual(['A Trust']);
    await call('@/app/api/ownership/self/route', ['POST']);
    expect(h.db.rows('household_members').filter((m) => m.user_id === B)).toHaveLength(1); // B untouched
  });
});
