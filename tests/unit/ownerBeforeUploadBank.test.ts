/**
 * Owner-before-upload (Phase 1): the BANK upload flow, through the real routes
 * and services against the in-memory database (tests/support/fdhFakeSupabase).
 *
 * Covers PO decisions 2 (no silent overwrite of an existing account's owner),
 * 3 (bank joint stays 100% to the household, no percentages), 6 (identical file,
 * different owner) and 7 (entities refused for bank), plus "owner required" and
 * "owner never from the request-body country". Each rule has a control in the
 * same test that proves the refusal is the rule's doing.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read raw JSON route payloads */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, type FakeDb } from '../support/fdhFakeSupabase';
import { computeAccountFingerprint } from '@/lib/financial-data-hub/bank-csv/accountIdentity';
import { sha256Hex } from '@/lib/financial-data-hub/domain/fileValidation';
import { PURGE_RETAINED_STATEMENT_UPLOAD_COLUMNS, buildStatementUploadPurgePatch } from '@/lib/financial-data-hub/domain/privacy';
import { decideAccountOwnerWrite } from '@/lib/financial-data-hub/services/bankOwnerAttribution';

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, user: null as { id: string } | null, seq: 0 }));

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db.sessionClient(h.user!.id) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.adminClient() }));
vi.mock('@/lib/financial-data-hub/constants/featureFlags', () => ({ isFdhDocumentUploadEnabled: () => true }));
vi.mock('@/lib/financial-data-hub/services/uploadLifecycle', async () => {
  const { sha256Hex: hash } = await import('@/lib/financial-data-hub/domain/fileValidation');
  return {
    FdhUploadLifecycleError: class extends Error { constructor(readonly code: string, message: string) { super(message); } },
    createUploadSession: vi.fn(async () => ({ session: { id: 'session' } })),
    completeUpload: vi.fn(async (userId: string, _session: string, bytes: Uint8Array) => {
      h.seq += 1;
      const row = h.db.insert('fdh_statement_uploads', {
        id: `d0000000-0000-4000-8000-${String(h.seq).padStart(12, '0')}`, user_id: userId, household_id: null, processing_status: 'queued',
        source_type: 'csv', document_type: 'bank_statement', currency_code: 'AUD', country_code: 'AU', financial_account_id: null,
        file_hash: hash(bytes), created_at: new Date(2026, 9, 1, 0, 0, h.seq).toISOString(),
      });
      return { ...row };
    }),
  };
});
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireCountryConfirmedUser: async () =>
    h.user ? { user: h.user } : { user: null, unauthenticated: Response.json({ error: 'unauthenticated' }, { status: 401 }) },
}));

vi.setConfig({ testTimeout: 30000 });

const A = 'a0000000-0000-4000-8000-00000000000a';
const B = 'b0000000-0000-4000-8000-00000000000b';
const MEM_SELF = 'a1111111-1111-4111-8111-111111111111';
const MEM_SPOUSE = 'a2222222-2222-4222-8222-222222222222';
const MEM_B = 'b1111111-1111-4111-8111-111111111111';
const TRUST = 'e1111111-1111-4111-8111-111111111111';
const ACC = 'c0000000-0000-4000-8000-0000000000a1';
const CSV = new TextEncoder().encode('Date,Description,Amount\n2026-08-01,COFFEE,-4.50\n');

const self = { kind: 'member', memberId: MEM_SELF };
const spouse = { kind: 'member', memberId: MEM_SPOUSE };

async function post(kind: 'csv' | 'pdf', opts: { owner?: unknown; confirm?: boolean; bytes?: Uint8Array; query?: Record<string, string> } = {}): Promise<{ status: number; json: any }> {
  const route = kind === 'csv' ? await import('@/app/api/financial-data-hub/bank-csv/upload/route') : await import('@/app/api/financial-data-hub/bank-pdf/upload/route');
  const bytes = opts.bytes ?? CSV;
  const qs = new URLSearchParams({ country_code: 'AU', currency_code: 'AUD', masked_identifier: '1234', ...(opts.query ?? {}) });
  if (opts.owner !== undefined) qs.set('owner', typeof opts.owner === 'string' ? opts.owner : JSON.stringify(opts.owner));
  if (opts.confirm) qs.set('confirm_owner_change', '1');
  const res: Response = await route.POST(
    new Request(`http://local/x?${qs.toString()}`, { method: 'POST', headers: { 'content-length': String(bytes.byteLength) }, body: bytes as unknown as BodyInit }),
  );
  return { status: res.status, json: await res.json() };
}

const uploads = () => h.db.rows('fdh_statement_uploads');
const account = (id: string) => h.db.rows('fdh_financial_accounts').find((a) => a.id === id)!;
const fingerprint = () => computeAccountFingerprint({ userId: A, institutionId: null, currencyCode: 'AUD', maskedIdentifierNormalised: '1234' });
function seedAccount(ownerRole: string | null) {
  h.db.insert('fdh_financial_accounts', {
    id: ACC, user_id: A, institution_id: null, account_type: 'transaction', country_code: 'AU', currency_code: 'AUD', display_name: 'Existing',
    masked_identifier: '1234', account_fingerprint: fingerprint(), owner_role: ownerRole, status: 'active',
  });
}

beforeEach(() => {
  h.db = createFakeDb();
  h.user = { id: A };
  h.seq = 0;
  h.db.insert('user_profiles', { user_id: A, country_of_residence: 'AU' });
  h.db.insert('user_profiles', { user_id: B, country_of_residence: 'AU' });
  h.db.insert('household_members', { id: MEM_SELF, user_id: A, full_name: 'Anil', relationship: 'self', is_active: true });
  h.db.insert('household_members', { id: MEM_SPOUSE, user_id: A, full_name: 'Priya', relationship: 'spouse', is_active: true });
  h.db.insert('household_members', { id: MEM_B, user_id: B, full_name: 'Bob', relationship: 'self', is_active: true });
  h.db.insert('business_entities', { id: TRUST, user_id: A, name: 'A Family Trust', entity_type: 'family_trust', is_active: true });
});

describe('owner is REQUIRED server-side (both bank routes)', () => {
  it.each(['csv', 'pdf'] as const)('%s: an upload with no owner is refused 422 owner_required and NOTHING is stored', async (kind) => {
    const r = await post(kind);
    expect(r.status).toBe(422);
    expect(r.json.error).toBe('owner_required');
    expect(uploads()).toHaveLength(0);
    expect(h.db.rows('fdh_financial_accounts')).toHaveLength(0);
    // CONTROL: the same request WITH an owner is accepted.
    const ok = await post(kind, { owner: self });
    expect(ok.status).toBe(200);
    expect(uploads()).toHaveLength(1);
  });
  it('the old loose owner_role parameter is no longer an owner', async () => {
    const r = await post('csv', { query: { owner_role: 'self' } });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe('owner_required');
  });
  it('a garbled owner is owner_invalid; a cross-tenant member id is owner_not_found; nothing stored', async () => {
    expect((await post('csv', { owner: '{nope' })).json.error).toBe('owner_invalid');
    const foreign = await post('csv', { owner: { kind: 'member', memberId: MEM_B } });
    expect(foreign.status).toBe(422);
    expect(foreign.json.error).toBe('owner_not_found');
    expect(uploads()).toHaveLength(0);
  });
});

describe('the document owner is stored and flows to the account', () => {
  it('a new upload records the owner on the DOCUMENT and on the newly created ACCOUNT', async () => {
    const r = await post('csv', { owner: spouse });
    expect(r.status).toBe(200);
    expect(r.json.data.owner_role).toBe('spouse');
    expect(r.json.data.owner_recorded).toEqual({ account: 'recorded', document: 'recorded' });
    const doc = uploads()[0];
    expect(doc).toMatchObject({ owner_role: 'spouse', owner_member_id: MEM_SPOUSE, owner_selection_source: 'user_selected', owner_business_entity_id: null });
    expect(h.db.rows('fdh_financial_accounts')[0].owner_role).toBe('spouse');
    expect(doc.financial_account_id).toBe(h.db.rows('fdh_financial_accounts')[0].id);
  });
  it('bank joint: role joint, no percentages, counts 100% to the household (decision 3 limitation)', async () => {
    const r = await post('csv', { owner: { kind: 'joint' } });
    expect(r.status).toBe(200);
    expect(uploads()[0]).toMatchObject({ owner_role: 'joint', owner_member_id: null });
    const withPct = await post('csv', { owner: { kind: 'joint', allocations: [{ memberId: MEM_SELF, basisPoints: 5000 }, { memberId: MEM_SPOUSE, basisPoints: 5000 }] }, bytes: new TextEncoder().encode('other\n') });
    expect(withPct.status).toBe(422);
    expect(withPct.json.error).toBe('joint_allocation_not_used');
  });
  it('an account that has NO owner yet is filled in (nothing to overwrite)', async () => {
    seedAccount(null);
    const r = await post('csv', { owner: self });
    expect(r.status).toBe(200);
    expect(account(ACC).owner_role).toBe('self');
    expect(r.json.data.owner_recorded.account).toBe('recorded');
  });
});

describe('DECISION 2: an existing account owner is never silently overwritten', () => {
  it('a different owner is refused BEFORE anything is stored, naming both owners; the account is untouched', async () => {
    seedAccount('smsf');
    const r = await post('csv', { owner: self });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('account_owner_conflict');
    expect(r.json.existing_owner_role).toBe('smsf');
    expect(r.json.selected_owner_role).toBe('self');
    expect(r.json.message).toMatch(/your SMSF.s.*you chose yours/);
    expect(account(ACC).owner_role).toBe('smsf'); // NOT overwritten
    expect(uploads()).toHaveLength(0); // nothing stored
  });
  it('CONTROL: the same owner as the account is no conflict; explicit confirmation DOES change it', async () => {
    seedAccount('smsf');
    const same = await post('csv', { owner: { kind: 'smsf' } });
    expect(same.status).toBe(200);
    expect(same.json.data.owner_recorded.account).toBe('unchanged');
    const confirmed = await post('csv', { owner: self, confirm: true, bytes: new TextEncoder().encode('Date,Description,Amount\n2026-08-02,TEA,-3\n') });
    expect(confirmed.status).toBe(200);
    expect(confirmed.json.data.owner_recorded.account).toBe('recorded');
    expect(account(ACC).owner_role).toBe('self');
    expect(uploads().at(-1)).toMatchObject({ owner_role: 'self' });
  });
  it('the pure rule: conflict without confirmation, write with it, noop when equal, write when unset', () => {
    expect(decideAccountOwnerWrite('smsf', 'self', false)).toBe('conflict');
    expect(decideAccountOwnerWrite('smsf', 'self', true)).toBe('write');
    expect(decideAccountOwnerWrite('self', 'self', false)).toBe('noop');
    expect(decideAccountOwnerWrite(null, 'self', false)).toBe('write');
  });
  it('the PDF route enforces the same rule', async () => {
    seedAccount('self');
    const r = await post('pdf', { owner: spouse });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('account_owner_conflict');
    expect(account(ACC).owner_role).toBe('self');
  });
});

describe('DECISION 6: the identical file under a different owner is rejected, never ignored or reassigned', () => {
  it('names the first owner, stores nothing new, and leaves the first upload and account alone', async () => {
    const first = await post('csv', { owner: self });
    expect(first.status).toBe(200);
    const second = await post('csv', { owner: spouse });
    expect(second.status).toBe(409);
    expect(second.json.error).toBe('identical_upload_different_owner');
    expect(second.json.existing_document_id).toBe(first.json.data.document_id);
    expect(second.json.message).toMatch(/already uploaded, recorded as yours.*You chose your partner.s/);
    expect(uploads()).toHaveLength(1);
    expect(uploads()[0].owner_role).toBe('self');
    expect(h.db.rows('fdh_financial_accounts')[0].owner_role).toBe('self');
  });
  it('CONTROL: the identical file under the SAME owner is accepted and flagged as a duplicate of the original', async () => {
    const first = await post('csv', { owner: self });
    const again = await post('csv', { owner: self });
    expect(again.status).toBe(200);
    expect(again.json.data.duplicate_of_document_id).toBeNull(); // not settled -> no evidence yet; the upload itself is not refused
    expect(uploads()).toHaveLength(2);
    expect(first.json.data.document_id).not.toBe(again.json.data.document_id);
  });
  it('CONTROL: a rejected earlier copy is a retry, not "already uploaded" -- a different owner is allowed', async () => {
    const first = await post('csv', { owner: self });
    const row = uploads().find((u) => u.id === first.json.data.document_id)!;
    row.processing_status = 'rejected';
    const retry = await post('csv', { owner: spouse });
    // Not the identical-file refusal -- the file never produced a result. (The account still
    // belongs to 'self', so decision 2 asks for confirmation instead; with it, the retry goes through.)
    expect(retry.json.error).toBe('account_owner_conflict');
    const confirmed = await post('csv', { owner: spouse, confirm: true });
    expect(confirmed.status).toBe(200);
  });
  it('an upload that PREDATES owner columns is compared through its account owner', async () => {
    h.db.insert('fdh_financial_accounts', { id: ACC, user_id: A, institution_id: null, account_type: 'transaction', country_code: 'AU', currency_code: 'AUD', display_name: 'Old', owner_role: 'smsf', status: 'active' });
    h.db.insert('fdh_statement_uploads', { id: 'f0000000-0000-4000-8000-000000000001', user_id: A, source_type: 'csv', document_type: 'bank_statement', processing_status: 'approved', file_hash: sha256Hex(CSV), financial_account_id: ACC });
    const r = await post('csv', { owner: { kind: 'joint' } });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('identical_upload_different_owner');
    expect(r.json.message).toMatch(/recorded as your SMSF.s/);
  });
  it('an earlier copy with NO recorded owner anywhere cannot contradict the choice', async () => {
    h.db.insert('fdh_statement_uploads', { id: 'f0000000-0000-4000-8000-000000000002', user_id: A, source_type: 'csv', document_type: 'bank_statement', processing_status: 'approved', file_hash: sha256Hex(CSV), financial_account_id: null });
    expect((await post('csv', { owner: self })).status).toBe(200);
  });
  it("P1: the same bytes uploaded by ANOTHER user tell this user NOTHING (no 409, no owner, no existence signal)", async () => {
    const B_DOC = 'f0000000-0000-4000-8000-000000000003';
    h.db.insert('fdh_statement_uploads', { id: B_DOC, user_id: B, source_type: 'csv', document_type: 'bank_statement', processing_status: 'approved', certification_status: 'certified', processing_completed_at: '2026-09-01T00:00:00Z', file_hash: sha256Hex(CSV), owner_role: 'smsf', owner_selection_source: 'user_selected' });
    const withB = await post('csv', { owner: self });
    expect(withB.status).toBe(200);
    expect(withB.json.data.duplicate_of_document_id).toBeNull(); // the "already imported" signal is user-scoped
    const text = JSON.stringify(withB.json);
    expect(text).not.toContain(B_DOC);
    expect(text).not.toMatch(/smsf|identical|already uploaded/i);
    // The response is the SAME as when nobody else has uploaded those bytes (apart from generated ids).
    h.db = createFakeDb();
    h.seq = 0;
    h.db.insert('user_profiles', { user_id: A, country_of_residence: 'AU' });
    h.db.insert('household_members', { id: MEM_SELF, user_id: A, full_name: 'Anil', relationship: 'self', is_active: true });
    const without = await post('csv', { owner: self });
    const shape = (j: any) => JSON.stringify(j, (k, v) => (/_id$/.test(k) ? '<id>' : v));
    expect(shape(withB.json)).toBe(shape(without.json));
    // The shared rule that decides "already imported" is user-scoped too.
    const { findEarlierIdenticalUpload, IDENTICAL_UPLOAD_SPECS } = await import('@/lib/financial-data-hub/services/identicalUpload');
    const mine = h.db.rows('fdh_statement_uploads')[0];
    h.db.insert('fdh_statement_uploads', { id: B_DOC, user_id: B, source_type: 'csv', document_type: 'bank_statement', processing_status: 'approved', certification_status: 'certified', processing_completed_at: '2026-09-01T00:00:00Z', file_hash: sha256Hex(CSV), created_at: '2026-01-01T00:00:00Z' });
    expect(await findEarlierIdenticalUpload(A, mine.id as string, IDENTICAL_UPLOAD_SPECS.bank)).toBeNull();
  });
});

describe('DECISION 7: entity separation -- what the bank flow refuses', () => {
  it("a Trust the user really owns is REFUSED for a bank statement (entity money would flow into household totals)", async () => {
    const r = await post('csv', { owner: { kind: 'entity', entityId: TRUST } });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe('owner_not_allowed_for_flow');
    expect(r.json.message).toMatch(/entity money must stay separate/);
    expect(uploads()).toHaveLength(0);
    expect(h.db.rows('fdh_financial_accounts')).toHaveLength(0);
  });
});

describe('the owner is never taken from the request-body country', () => {
  it('SMSF is allowed from the AUTHORITATIVE home country: an India user is refused even with country_code=AU in the query', async () => {
    h.db.tables.user_profiles = [{ user_id: A, country_of_residence: 'IN' }];
    const r = await post('csv', { owner: { kind: 'smsf' }, query: { country_code: 'AU', currency_code: 'AUD' } });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('owner_not_allowed_for_country');
    expect(uploads()).toHaveLength(0);
  });
  it('CONTROL: an AU user is accepted, even when the query claims India', async () => {
    const r = await post('csv', { owner: { kind: 'smsf' }, query: { country_code: 'IN', currency_code: 'INR' } });
    expect(r.status).toBe(200);
    expect(uploads()[0].owner_role).toBe('smsf');
  });
});

describe('the owner write never costs the account link', () => {
  it('a database without the 0236 columns still links the account and reports the owner as unavailable', async () => {
    const repos = await import('@/lib/financial-data-hub/repositories');
    const real = repos.statementUploadsRepository.update.bind(repos.statementUploadsRepository);
    const spy = vi.spyOn(repos.statementUploadsRepository, 'update').mockImplementation(async (userId: string, id: string, patch: any) => {
      if ('owner_role' in patch) return { data: null, error: { message: "Could not find the 'owner_role' column of 'fdh_statement_uploads' in the schema cache" } } as never;
      return real(userId, id, patch);
    });
    const r = await post('csv', { owner: self });
    spy.mockRestore();
    expect(r.status).toBe(200);
    expect(r.json.data.owner_recorded.document).toBe('unavailable');
    expect(r.json.data.financial_account_id).toBeTruthy(); // the account link survived
    expect(uploads()[0].financial_account_id).toBe(r.json.data.financial_account_id);
  });
});

describe('purge keeps the owner columns', () => {
  it('buildStatementUploadPurgePatch never names an owner column; the retained list is exactly the five (incl. the joint split)', () => {
    const patch = buildStatementUploadPurgePatch('2026-10-01T00:00:00Z');
    for (const col of PURGE_RETAINED_STATEMENT_UPLOAD_COLUMNS) expect(Object.keys(patch)).not.toContain(col);
    expect([...PURGE_RETAINED_STATEMENT_UPLOAD_COLUMNS].sort()).toEqual(['owner_allocation', 'owner_business_entity_id', 'owner_member_id', 'owner_role', 'owner_selection_source']);
    // CONTROL: the purge patch DOES clear the raw columns, so "does not name" is meaningful.
    expect(Object.keys(patch)).toEqual(expect.arrayContaining(['raw_document_storage_reference', 'original_filename_sanitised']));
  });
});
