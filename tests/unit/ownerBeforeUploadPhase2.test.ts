/**
 * Owner-before-upload PHASE 2: payslip, liability (credit card / loan), retirement and
 * AU investment uploads, plus the generic upload-session route.
 *
 * Every flow: owner REQUIRED before the file is read (the processing service is never
 * reached without one), validated against the flow's own policy, stored on the document,
 * the identical file under a different owner refused, and the owner chosen at upload is
 * the DEFAULT and the LOCK at the canonical-write gate. Each rule has a control.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, type FakeDb } from '../support/fdhFakeSupabase';
import { OWNER_FLOW_POLICIES, validateOwnerSelectionAgainst, type OwnerContext, type OwnerValidationResult } from '@/lib/ownership/validateOwnerSelection';
import { OWNER_FLOWS } from '@/lib/ownership/ownerSelection';
import { sha256Hex } from '@/lib/financial-data-hub/domain/fileValidation';
import { gateAuOwnerChoice, applyUploadOwnerToExistingAuAccount, toDocumentOwner } from '@/lib/investment-import-bridge/auDocumentOwner';
import { reconcileRequestedOwner } from '@/lib/financial-data-hub/services/documentOwnerRequest';

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  user: null as { id: string } | null,
  seq: 0,
  calls: { liability: 0, retirement: 0, au: 0, approve: [] as unknown[], liabilityApply: [] as unknown[], retirementMatch: [] as unknown[] },
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db.sessionClient(h.user!.id) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.adminClient() }));
vi.mock('@/lib/financial-data-hub/constants/featureFlags', () => ({ isFdhDocumentUploadEnabled: () => true }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireCountryConfirmedUser: async () => (h.user ? { user: h.user } : { user: null, unauthenticated: Response.json({ error: 'unauthenticated' }, { status: 401 }) }),
}));
vi.mock('@/lib/financial-data-hub/services/uploadLifecycle', () => ({
  FdhUploadLifecycleError: class extends Error { constructor(readonly code: string, message: string) { super(message); } },
  createUploadSession: async (userId: string, input: any) => {
    h.seq += 1;
    const document = h.db.insert('fdh_statement_uploads', { id: `d0000000-0000-4000-8000-${String(h.seq).padStart(12, '0')}`, user_id: userId, processing_status: 'created', document_type: input.document_type, source_type: input.source_type, country_code: input.country_code });
    const session = h.db.insert('fdh_upload_sessions', { id: `5e000000-0000-4000-8000-${String(h.seq).padStart(12, '0')}`, user_id: userId, document_id: document.id, allowed_mime_type: input.declared_mime_type, expected_max_size_bytes: 1000, expires_at: '2099-01-01T00:00:00Z' });
    return { document, session };
  },
  completeUpload: async (userId: string, sessionId: string, bytes: Uint8Array) => {
    const session = h.db.rows('fdh_upload_sessions').find((s) => s.id === sessionId)!;
    const doc = h.db.rows('fdh_statement_uploads').find((d) => d.id === session.document_id)!;
    doc.file_hash = sha256Hex(bytes);
    doc.processing_status = 'queued';
    return { ...doc };
  },
}));
vi.mock('@/lib/financial-data-hub/services/liabilityStatementProcessingService', async (orig) => ({
  ...(await orig<object>()),
  uploadAndProcessLiabilityStatement: async (userId: string, _m: any, bytes: Uint8Array) => {
    h.calls.liability += 1;
    h.seq += 1;
    const document = h.db.insert('fdh_statement_uploads', { id: `d1000000-0000-4000-8000-${String(h.seq).padStart(12, '0')}`, user_id: userId, processing_status: 'extracted', document_type: 'credit_card_statement', file_hash: sha256Hex(bytes) });
    return { document, duplicateOfDocumentId: null, pipelineStatus: 'extracted', statementId: 'st', failureKind: null, aiFallbackDraft: null };
  },
}));
vi.mock('@/lib/financial-data-hub/services/retirementStatementProcessingService', async (orig) => ({
  ...(await orig<object>()),
  uploadAndProcessRetirementStatement: async (userId: string, _m: any, bytes: Uint8Array) => {
    h.calls.retirement += 1;
    h.seq += 1;
    const document = h.db.insert('fdh_statement_uploads', { id: `d2000000-0000-4000-8000-${String(h.seq).padStart(12, '0')}`, user_id: userId, processing_status: 'extracted', document_type: 'super_statement', file_hash: sha256Hex(bytes) });
    return { document, duplicateOfDocumentId: null, statementId: 'st', pipelineStatus: 'extracted', failureKind: null, activitiesExtracted: 0, activitiesDeduplicated: 0, positionsExtracted: 0, aiFallbackDraft: null };
  },
  getRetirementStatementIdForDocument: async () => 'stmt-1',
}));
vi.mock('@/lib/financial-data-hub/services/investmentStatementProcessingService', async (orig) => ({
  ...(await orig<object>()),
  uploadAndProcessAuInvestmentStatement: async (userId: string, _m: any, bytes: Uint8Array) => {
    h.calls.au += 1;
    h.seq += 1;
    const document = h.db.insert('fdh_statement_uploads', { id: `d3000000-0000-4000-8000-${String(h.seq).padStart(12, '0')}`, user_id: userId, processing_status: 'extracted', document_type: 'investment_statement', file_hash: sha256Hex(bytes) });
    return { document, duplicateOfDocumentId: null, pipelineStatus: 'extracted', statementId: 'st', positionsExtracted: 0, activitiesExtracted: 0, failureKind: null, aiFallbackDraft: null };
  },
}));
vi.mock('@/lib/import-bridge/applyIncomeProposalAtomic', async (orig) => ({
  ...(await orig<object>()),
  approvePayrollEventAtomic: async (_id: string, opts: any) => { h.calls.approve.push(opts); return { ok: true, incomeOwner: opts.incomeOwner ?? 'self', alreadyApproved: false }; },
}));
vi.mock('@/lib/financial-data-hub/services/payslipProcessingService', async (orig) => ({
  ...(await orig<object>()),
  getPayrollEventIdForDocument: async () => 'pe-1',
  getPayrollEventForReview: async () => ({ event: { review_status: 'not_required', approval_status: 'pending' }, components: [] }),
}));
vi.mock('@/lib/import-bridge/applyLiabilityProposalAtomic', async (orig) => ({
  ...(await orig<object>()),
  applyLiabilityProposalAtomic: async (req: any) => { h.calls.liabilityApply.push(req); return { ok: true, outcome: 'applied', applyMode: 'add_new', targetEntityId: 't', applicationId: 'a', appliedFields: [], ledger: null, activitiesRejected: 0 }; },
}));
vi.mock('@/lib/retirement-import-bridge/retirementAccountResolution', async (orig) => ({
  ...(await orig<object>()),
  resolveRetirementStatementAccount: async (_u: string, _s: string, opts: any) => { h.calls.retirementMatch.push(opts); return { status: 'matched', accountId: null, memberId: opts.userConfirmedMemberId, error: null }; },
}));
vi.mock('@/lib/financial-data-hub/services/auditLog', () => ({ recordDocumentAuditEvent: async () => undefined }));

vi.setConfig({ testTimeout: 30000 });

const A = 'a0000000-0000-4000-8000-00000000000a';
const B = 'b0000000-0000-4000-8000-00000000000b';
const SELF = 'a1111111-1111-4111-8111-111111111111';
const SPOUSE = 'a2222222-2222-4222-8222-222222222222';
const CHILD = 'a3333333-3333-4333-8333-333333333333';
const MEM_B = 'b1111111-1111-4111-8111-111111111111';
const TRUST = 'e1111111-1111-4111-8111-111111111111';
const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '../..', p), 'utf8').replace(/\r\n/g, '\n');

const self = { kind: 'member', memberId: SELF };
const spouse = { kind: 'member', memberId: SPOUSE };

function ctx(homeCountry: 'AU' | 'IN' = 'AU'): OwnerContext {
  return {
    homeCountry,
    members: [
      { id: SELF, fullName: 'Anil', relationship: 'self', isActive: true },
      { id: SPOUSE, fullName: 'Priya', relationship: 'spouse', isActive: true },
      { id: CHILD, fullName: 'Rohan', relationship: 'child', isActive: true },
    ],
    entities: [{ id: TRUST, name: 'A Trust', entityType: 'family_trust', isActive: true }],
  };
}
const code = (r: OwnerValidationResult) => (r.ok ? 'ok' : r.code);
const verdict = (flow: any, input: unknown, c = ctx()) => validateOwnerSelectionAgainst(c, input, flow);

beforeEach(() => {
  h.db = createFakeDb();
  h.user = { id: A };
  h.seq = 0;
  h.calls = { liability: 0, retirement: 0, au: 0, approve: [], liabilityApply: [], retirementMatch: [] };
  h.db.insert('user_profiles', { user_id: A, country_of_residence: 'AU' });
  h.db.insert('household_members', { id: SELF, user_id: A, full_name: 'Anil', relationship: 'self', is_active: true });
  h.db.insert('household_members', { id: SPOUSE, user_id: A, full_name: 'Priya', relationship: 'spouse', is_active: true });
  h.db.insert('household_members', { id: MEM_B, user_id: B, full_name: 'Bobby Tables', relationship: 'self', is_active: true });
  h.db.insert('business_entities', { id: TRUST, user_id: A, name: 'A Trust', entity_type: 'family_trust', is_active: true });
});

// ---------------------------------------------------------------------------
describe('per-flow owner policy (one canonical table)', () => {
  it('every flow has a policy, and the options builder and the validator read the same table', () => {
    for (const flow of OWNER_FLOWS) expect(OWNER_FLOW_POLICIES[flow]).toBeDefined();
    expect([...OWNER_FLOWS]).toEqual(['bank', 'ii_cas', 'payslip', 'liability', 'retirement', 'au_investment']);
  });
  it('PAYSLIP: Self and Spouse only -- no joint, SMSF, entity or other member', () => {
    expect(code(verdict('payslip', self))).toBe('ok');
    expect(code(verdict('payslip', spouse))).toBe('ok');
    expect(code(verdict('payslip', { kind: 'member', memberId: CHILD }))).toBe('owner_not_allowed_for_flow');
    expect(code(verdict('payslip', { kind: 'joint' }))).toBe('owner_not_allowed_for_flow');
    const smsf = verdict('payslip', { kind: 'smsf' });
    expect(code(smsf)).toBe('owner_not_allowed_for_flow');
    expect(!smsf.ok && smsf.message).toMatch(/SMSF does not receive payslips/);
    const entity = verdict('payslip', { kind: 'entity', entityId: TRUST });
    expect(!entity.ok && entity.message).toMatch(/Income from a company, trust or HUF/);
  });
  it('LIABILITY: Self / Spouse / Joint (no percentages) / SMSF (Australia only); company, trust, HUF debt refused', () => {
    expect(code(verdict('liability', self))).toBe('ok');
    expect(code(verdict('liability', { kind: 'joint' }))).toBe('ok');
    expect(code(verdict('liability', { kind: 'smsf' }))).toBe('ok');
    expect(code(verdict('liability', { kind: 'smsf' }, ctx('IN')))).toBe('owner_not_allowed_for_country'); // CONTROL: AU only
    expect(code(verdict('liability', { kind: 'joint', allocations: [{ memberId: SELF, basisPoints: 5000 }, { memberId: SPOUSE, basisPoints: 5000 }] }))).toBe('joint_allocation_not_used');
    const entity = verdict('liability', { kind: 'entity', entityId: TRUST });
    expect(!entity.ok && entity.message).toMatch(/entity debt must stay out of your personal debt ratios/);
  });
  it('RETIREMENT: Self / Spouse only; SMSF is its own workspace, never an owner label; no entity, no joint', () => {
    expect(code(verdict('retirement', self))).toBe('ok');
    expect(code(verdict('retirement', spouse))).toBe('ok');
    const smsf = verdict('retirement', { kind: 'smsf' });
    expect(code(smsf)).toBe('owner_not_allowed_for_flow');
    expect(!smsf.ok && smsf.message).toMatch(/SMSF section of the Retirement page/);
    expect(code(verdict('retirement', { kind: 'joint' }))).toBe('owner_not_allowed_for_flow');
    expect(code(verdict('retirement', { kind: 'entity', entityId: TRUST }))).toBe('owner_not_allowed_for_flow');
  });
  it('AU INVESTMENT: Self / Spouse / Joint with percentages REQUIRED (exactly 10000); entities and SMSF refused', () => {
    expect(code(verdict('au_investment', self))).toBe('ok');
    const jointOk = verdict('au_investment', { kind: 'joint', allocations: [{ memberId: SELF, basisPoints: 6000 }, { memberId: SPOUSE, basisPoints: 4000 }] });
    expect(jointOk.ok && jointOk.owner.allocations?.reduce((n, a) => n + a.basisPoints, 0)).toBe(10000);
    expect(code(verdict('au_investment', { kind: 'joint' }))).toBe('joint_allocation_required');
    expect(code(verdict('au_investment', { kind: 'joint', allocations: [{ memberId: SELF, basisPoints: 6000 }, { memberId: SPOUSE, basisPoints: 3999 }] }))).toBe('joint_total_not_100');
    expect(code(verdict('au_investment', { kind: 'entity', entityId: TRUST }))).toBe('owner_not_allowed_for_flow');
    expect(code(verdict('au_investment', { kind: 'smsf' }))).toBe('owner_not_allowed_for_flow');
  });
});

// ---------------------------------------------------------------------------
describe('generic upload-session route (payslip and every other document type on it)', () => {
  async function createSession(body: Record<string, unknown>) {
    const route = await import('@/app/api/financial-data-hub/documents/upload-sessions/route');
    const res: Response = await route.POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ source_type: 'pdf_native', country_code: 'AU', declared_mime_type: 'application/pdf', declared_file_size_bytes: 1000, ...body }) }));
    return { status: res.status, json: await res.json() as any };
  }
  it('a payslip session without an owner is refused 422 owner_required: no session and no document row is created', async () => {
    const r = await createSession({ document_type: 'payslip' });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe('owner_required');
    expect(h.db.rows('fdh_statement_uploads')).toHaveLength(0);
    expect(h.db.rows('fdh_upload_sessions')).toHaveLength(0);
    // CONTROL
    const ok = await createSession({ document_type: 'payslip', owner: self });
    expect(ok.status).toBe(200);
    expect(ok.json.data.owner_role).toBe('self');
    expect(h.db.rows('fdh_statement_uploads')[0]).toMatchObject({ owner_role: 'self', owner_member_id: SELF, owner_selection_source: 'user_selected' });
  });
  it('a payslip owned by an entity, an SMSF, joint, a child, or another user\'s member is refused; nothing is created', async () => {
    for (const owner of [{ kind: 'entity', entityId: TRUST }, { kind: 'smsf' }, { kind: 'joint' }, { kind: 'member', memberId: CHILD }, { kind: 'member', memberId: MEM_B }]) {
      const r = await createSession({ document_type: 'payslip', owner });
      expect(r.status).toBeGreaterThanOrEqual(403);
      expect(['owner_not_allowed_for_flow', 'owner_not_found', 'owner_not_allowed_for_country']).toContain(r.json.error);
    }
    expect(h.db.rows('fdh_statement_uploads')).toHaveLength(0);
  });
  it('EVERY financial document type needs an owner on this route; tax_document / other do not', async () => {
    for (const t of ['bank_statement', 'credit_card_statement', 'loan_statement', 'super_statement', 'epf_statement', 'nps_statement', 'investment_statement']) {
      expect((await createSession({ document_type: t })).json.error).toBe('owner_required');
    }
    expect((await createSession({ document_type: 'tax_document' })).status).toBe(200);
    expect((await createSession({ document_type: 'other' })).status).toBe(200);
  });
  it('the type picks the policy: a loan accepts SMSF (AU), a payslip does not', async () => {
    expect((await createSession({ document_type: 'loan_statement', owner: { kind: 'smsf' } })).status).toBe(200);
    expect((await createSession({ document_type: 'payslip', owner: { kind: 'smsf' } })).json.error).toBe('owner_not_allowed_for_flow');
  });

  async function complete(sessionId: string, bytes: Uint8Array) {
    const route = await import('@/app/api/financial-data-hub/documents/upload-sessions/[sessionId]/complete/route');
    const res: Response = await route.POST(new Request('http://x', { method: 'POST', headers: { 'content-length': String(bytes.byteLength) }, body: bytes as unknown as BodyInit }), { params: Promise.resolve({ sessionId }) });
    return { status: res.status, json: await res.json() as any };
  }
  const BYTES = new TextEncoder().encode('%PDF payslip bytes');
  it('DECISION 6: the same payslip under a DIFFERENT owner is refused at complete, nothing stored, the empty row closed; the same owner is accepted', async () => {
    const first = await createSession({ document_type: 'payslip', owner: self });
    expect((await complete(first.json.data.session_id, BYTES)).status).toBe(200);
    const second = await createSession({ document_type: 'payslip', owner: spouse });
    const refused = await complete(second.json.data.session_id, BYTES);
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe('identical_upload_different_owner');
    expect(h.db.rows('fdh_statement_uploads').find((d) => d.id === second.json.data.document_id)!.processing_status).toBe('rejected');
    expect(h.db.rows('fdh_statement_uploads').find((d) => d.id === second.json.data.document_id)!.file_hash).toBeUndefined(); // never stored
    // CONTROL: same owner is fine
    const third = await createSession({ document_type: 'payslip', owner: self });
    expect((await complete(third.json.data.session_id, BYTES)).status).toBe(200);
  });
  it("P1: another user's identical payslip tells this user nothing", async () => {
    h.db.insert('fdh_statement_uploads', { id: 'f0000000-0000-4000-8000-000000000001', user_id: B, document_type: 'payslip', processing_status: 'approved', file_hash: sha256Hex(BYTES), owner_role: 'spouse', owner_selection_source: 'user_selected' });
    const s = await createSession({ document_type: 'payslip', owner: self });
    const done = await complete(s.json.data.session_id, BYTES);
    expect(done.status).toBe(200);
    expect(JSON.stringify(done.json)).not.toMatch(/spouse|identical|f0000000/);
  });
});

// ---------------------------------------------------------------------------
describe('dedicated upload routes: liability, retirement, AU investment', () => {
  const CSV = new TextEncoder().encode('a,b\n1,2\n');
  const post = async (route: string, query: Record<string, string>, owner: unknown, bytes: Uint8Array = CSV) => {
    const mod: any = await import(route);
    const qs = new URLSearchParams(query);
    if (owner !== undefined) qs.set('owner', JSON.stringify(owner));
    const res: Response = await mod.POST(new Request(`http://x?${qs}`, { method: 'POST', headers: { 'content-length': String(bytes.byteLength) }, body: bytes as unknown as BodyInit }));
    return { status: res.status, json: await res.json() as any };
  };
  const liability = (owner: unknown, bytes?: Uint8Array) => post('@/app/api/financial-data-hub/liability-statement/upload/route', { statement_type: 'credit_card', country_code: 'AU', currency_code: 'AUD' }, owner, bytes);
  const retirement = (owner: unknown, bytes?: Uint8Array) => post('@/app/api/financial-data-hub/retirement-statement/upload/route', { jurisdiction: 'AU', currency_code: 'AUD' }, owner, bytes);
  const au = (owner: unknown, bytes?: Uint8Array) => post('@/app/api/financial-data-hub/investment-statement/upload/route', { csv_kind: 'transaction', currency_code: 'AUD' }, owner, bytes);
  const flows = [
    ['liability', liability, 'liability'],
    ['retirement', retirement, 'retirement'],
    ['au_investment', au, 'au'],
  ] as const;

  it.each(flows)('%s: no owner -> 422 owner_required and the processing service is NEVER reached', async (_n, call, key) => {
    const r = await call(undefined);
    expect(r.status).toBe(422);
    expect(r.json.error).toBe('owner_required');
    expect((h.calls as any)[key]).toBe(0);
    expect(h.db.rows('fdh_statement_uploads')).toHaveLength(0);
    // CONTROL
    expect((await call(self)).status).toBe(200);
    expect((h.calls as any)[key]).toBe(1);
  });
  it.each(flows)('%s: a cross-tenant member id answers exactly like a missing id; nothing is processed', async (_n, call, key) => {
    const foreign = await call({ kind: 'member', memberId: MEM_B });
    const missing = await call({ kind: 'member', memberId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
    expect({ status: foreign.status, error: foreign.json.error, message: foreign.json.message }).toEqual({ status: missing.status, error: missing.json.error, message: missing.json.message });
    expect(JSON.stringify(foreign.json)).not.toMatch(/Bobby/);
    expect((h.calls as any)[key]).toBe(0);
  });
  it.each(flows)('%s: the owner is stored on the document', async (_n, call) => {
    const r = await call(spouse);
    expect(r.status).toBe(200);
    expect(h.db.rows('fdh_statement_uploads').at(-1)).toMatchObject({ owner_role: 'spouse', owner_member_id: SPOUSE, owner_selection_source: 'user_selected' });
  });
  it.each(flows)('%s: entities are refused (company / trust / HUF) and nothing is processed', async (_n, call, key) => {
    const r = await call({ kind: 'entity', entityId: TRUST });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe('owner_not_allowed_for_flow');
    expect((h.calls as any)[key]).toBe(0);
  });
  it.each(flows)('%s DECISION 6: the same file under a different owner is refused BEFORE processing; the same owner is accepted', async (_n, call, key) => {
    expect((await call(self)).status).toBe(200);
    const processed = (h.calls as any)[key];
    const refused = await call(spouse);
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe('identical_upload_different_owner');
    expect((h.calls as any)[key]).toBe(processed); // the service was not called again
    expect((await call(self)).status).toBe(200); // CONTROL
  });
  it('retirement: SMSF is not an owner label; liability: SMSF is accepted for an AU user; AU investment joint needs percentages', async () => {
    const smsfRetirement = await retirement({ kind: 'smsf' });
    expect(smsfRetirement.status).toBe(422);
    expect(smsfRetirement.json.message).toMatch(/SMSF section of the Retirement page/);
    expect((await liability({ kind: 'smsf' })).status).toBe(200);
    expect((await au({ kind: 'joint' })).json.error).toBe('joint_allocation_required');
    expect((await au({ kind: 'joint', allocations: [{ memberId: SELF, basisPoints: 5000 }, { memberId: SPOUSE, basisPoints: 5000 }] })).status).toBe(200);
    expect(h.db.rows('fdh_statement_uploads').at(-1)!.owner_allocation).toEqual([{ ownerMemberId: SELF, basisPoints: 5000 }, { ownerMemberId: SPOUSE, basisPoints: 5000 }]);
  });
  it("P1: another user's identical file tells this user nothing", async () => {
    h.db.insert('fdh_statement_uploads', { id: 'f0000000-0000-4000-8000-000000000002', user_id: B, document_type: 'credit_card_statement', processing_status: 'approved', file_hash: sha256Hex(CSV), owner_role: 'smsf', owner_selection_source: 'user_selected' });
    const r = await liability(self);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.json)).not.toMatch(/smsf|identical|f0000000/);
  });
});

// ---------------------------------------------------------------------------
describe('the canonical-write gates: the upload owner is the DEFAULT and the LOCK', () => {
  const seedDoc = (role: string, memberId: string | null, id = 'd9000000-0000-4000-8000-000000000001') =>
    h.db.insert('fdh_statement_uploads', { id, user_id: A, document_type: 'payslip', processing_status: 'extracted', owner_role: role, owner_member_id: memberId, owner_selection_source: 'user_selected' });

  it('the pure rule: absent -> the document\'s; same -> ok; different -> 409; no document owner (legacy) -> unchanged', () => {
    const doc = { ownerRole: 'spouse', ownerMemberId: SPOUSE, allocations: null };
    expect(reconcileRequestedOwner(doc, undefined)).toEqual({ ok: true, role: 'spouse' });
    expect(reconcileRequestedOwner(doc, 'spouse')).toEqual({ ok: true, role: 'spouse' });
    expect(reconcileRequestedOwner(doc, 'self')).toMatchObject({ ok: false, status: 409, code: 'owner_differs_from_upload' });
    expect(reconcileRequestedOwner(null, 'self')).toEqual({ ok: true, role: 'self' });
    expect(reconcileRequestedOwner(null, undefined)).toEqual({ ok: true, role: null });
  });
  async function approve(body: unknown, documentId = 'd9000000-0000-4000-8000-000000000001') {
    const route = await import('@/app/api/financial-data-hub/payslip/[documentId]/approve/route');
    const res: Response = await route.POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ documentId }) });
    return { status: res.status, json: await res.json() as any };
  }
  it('PAYSLIP approve: an approval naming a different owner is refused 409 and the atomic approval is NOT called; none takes the upload owner', async () => {
    seedDoc('spouse', SPOUSE);
    const refused = await approve({ income_owner: 'self' });
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe('owner_differs_from_upload');
    expect(h.calls.approve).toHaveLength(0);
    const ok = await approve({});
    expect(ok.status).toBe(200);
    expect((h.calls.approve[0] as any).incomeOwner).toBe('spouse'); // default = the upload owner
    // CONTROL: a legacy payslip (no upload owner) still names its owner at approval
    h.db.tables.fdh_statement_uploads = [];
    h.db.insert('fdh_statement_uploads', { id: 'd9000000-0000-4000-8000-000000000001', user_id: A, document_type: 'payslip', processing_status: 'extracted' });
    h.calls.approve.length = 0;
    expect((await approve({ income_owner: 'spouse' })).status).toBe(200);
    expect((h.calls.approve[0] as any).incomeOwner).toBe('spouse');
  });
  it("P1: another user's payslip owner is never read at approve (the document is invisible)", async () => {
    h.db.insert('fdh_statement_uploads', { id: 'd9000000-0000-4000-8000-0000000000b1', user_id: B, document_type: 'payslip', processing_status: 'extracted', owner_role: 'spouse', owner_selection_source: 'user_selected' });
    await approve({ income_owner: 'self' }, 'd9000000-0000-4000-8000-0000000000b1');
    expect((h.calls.approve[0] as any).incomeOwner).toBe('self'); // treated as a legacy/unknown document, B's owner not applied or leaked
  });
  it('LIABILITY apply: the statement\'s upload owner is the default and the lock (smsf / joint included)', async () => {
    h.db.insert('fdh_statement_uploads', { id: 'd8000000-0000-4000-8000-000000000001', user_id: A, document_type: 'credit_card_statement', processing_status: 'extracted', owner_role: 'smsf', owner_selection_source: 'user_selected' });
    h.db.insert('fdh_liability_statements', { id: 'ls-1', user_id: A, statement_upload_id: 'd8000000-0000-4000-8000-000000000001' });
    h.db.insert('fhip_import_proposals', { id: 'p0000000-0000-4000-8000-000000000001', user_id: A, source_liability_statement_id: 'ls-1' });
    const route = await import('@/app/api/financial-data-hub/liability-proposals/[proposalId]/apply/route');
    const apply = async (body: unknown) => {
      const res: Response = await route.POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ proposalId: 'p0000000-0000-4000-8000-000000000001' }) });
      return { status: res.status, json: await res.json() as any };
    };
    const refused = await apply({ decision: 'add_new', owner: 'self' });
    expect(refused.status).toBe(409);
    expect(h.calls.liabilityApply).toHaveLength(0);
    expect((await apply({ decision: 'add_new' })).status).toBe(200);
    expect((h.calls.liabilityApply[0] as any).owner).toBe('smsf');
    expect((await apply({ decision: 'add_new', owner: 'smsf' })).status).toBe(200); // CONTROL
  });
  it('RETIREMENT account match: the upload owner fixes the retirement member (self / spouse); a different member is refused', async () => {
    h.db.insert('fdh_statement_uploads', { id: 'd7000000-0000-4000-8000-000000000001', user_id: A, document_type: 'super_statement', processing_status: 'extracted', owner_role: 'spouse', owner_member_id: SPOUSE, owner_selection_source: 'user_selected' });
    h.db.insert('retirement_members', { id: 'c1000000-0000-4000-8000-000000000001', user_id: A, member_type: 'self', is_active: true });
    h.db.insert('retirement_members', { id: 'c2000000-0000-4000-8000-000000000002', user_id: A, member_type: 'spouse', is_active: true });
    const route = await import('@/app/api/financial-data-hub/retirement-statement/[documentId]/account-match/route');
    const match = async (body: unknown) => {
      const res: Response = await route.POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ documentId: 'd7000000-0000-4000-8000-000000000001' }) });
      return { status: res.status, json: await res.json() as any };
    };
    const refused = await match({ action: 'confirm_new', member_id: 'c1000000-0000-4000-8000-000000000001' }); // the SELF member for a SPOUSE statement
    expect(refused.status).toBe(409);
    expect(h.calls.retirementMatch).toHaveLength(0);
    expect((await match({ action: 'auto' })).status).toBe(200);
    expect((h.calls.retirementMatch[0] as any).userConfirmedMemberId).toBe('c2000000-0000-4000-8000-000000000002'); // default = the spouse member
    expect((await match({ action: 'confirm_new', member_id: 'c2000000-0000-4000-8000-000000000002' })).status).toBe(200); // CONTROL
  });
});

// ---------------------------------------------------------------------------
describe('AU investment: the owner reaches the canonical ii account (same allocation model)', () => {
  const stored = (role: string, memberId: string | null, allocations: any = null) => ({ ownerRole: role, ownerMemberId: memberId, allocations });
  it('member: the upload owner is the default and the lock; "owner_self" means only the Self statement', () => {
    expect(gateAuOwnerChoice(stored('spouse', SPOUSE), null)).toEqual({ ok: true, choice: { memberId: SPOUSE } });
    expect(gateAuOwnerChoice(stored('spouse', SPOUSE), { memberId: SPOUSE })).toMatchObject({ ok: true });
    expect(gateAuOwnerChoice(stored('spouse', SPOUSE), { memberId: SELF })).toMatchObject({ ok: false, code: 'owner_differs_from_upload' });
    expect(gateAuOwnerChoice(stored('spouse', SPOUSE), { self: true })).toMatchObject({ ok: false });
    expect(gateAuOwnerChoice(stored('self', SELF), { self: true })).toMatchObject({ ok: true });
    expect(gateAuOwnerChoice(null, { self: true })).toEqual({ ok: true, choice: { self: true } }); // legacy unchanged
  });
  it('joint: any single-member choice is refused (the split decides)', () => {
    const joint = stored('joint', null, [{ ownerMemberId: SELF, basisPoints: 6000 }, { ownerMemberId: SPOUSE, basisPoints: 4000 }]);
    expect(gateAuOwnerChoice(joint, { memberId: SELF })).toMatchObject({ ok: false });
    expect(gateAuOwnerChoice(joint, null)).toEqual({ ok: true, choice: null });
    expect(toDocumentOwner(joint)).toMatchObject({ kind: 'joint' });
    expect(toDocumentOwner(stored('joint', null, null))).toBeNull(); // a joint with no split is not an owner
  });
  const base = { account_type: 'broker', country_code: 'AU', currency_code: 'AUD', institution_name: 'Broker', status: 'active' };
  it('an existing account with a DIFFERENT owner is not overwritten without explicit confirmation; empty is filled; equal is a no-op', async () => {
    h.db.insert('ii_accounts', { id: 'c0000000-0000-4000-8000-000000000001', user_id: A, owner_member_id: SELF, ...base });
    h.db.insert('ii_accounts', { id: 'c0000000-0000-4000-8000-000000000002', user_id: A, owner_member_id: null, ...base });
    h.db.insert('ii_accounts', { id: 'c0000000-0000-4000-8000-000000000003', user_id: A, owner_member_id: SPOUSE, ...base });
    const spouseDoc = stored('spouse', SPOUSE);
    expect(await applyUploadOwnerToExistingAuAccount(A, 'c0000000-0000-4000-8000-000000000001', spouseDoc, false)).toBe('conflict');
    expect(h.db.rows('ii_accounts').find((a) => a.id === 'c0000000-0000-4000-8000-000000000001')!.owner_member_id).toBe(SELF); // NOT overwritten
    expect(await applyUploadOwnerToExistingAuAccount(A, 'c0000000-0000-4000-8000-000000000002', spouseDoc, false)).toBe('applied');
    expect(h.db.rows('ii_accounts').find((a) => a.id === 'c0000000-0000-4000-8000-000000000002')!.owner_member_id).toBe(SPOUSE);
    expect(await applyUploadOwnerToExistingAuAccount(A, 'c0000000-0000-4000-8000-000000000003', spouseDoc, false)).toBe('unchanged');
    expect(await applyUploadOwnerToExistingAuAccount(A, 'c0000000-0000-4000-8000-000000000001', spouseDoc, true)).toBe('applied'); // explicit confirmation
    expect(h.db.rows('ii_accounts').find((a) => a.id === 'c0000000-0000-4000-8000-000000000001')!.owner_member_id).toBe(SPOUSE);
  });
  it('a joint upload writes the split to the account\'s allocation group (basis points, 10000), owner_member_id stays null', async () => {
    h.db.insert('ii_accounts', { id: 'c0000000-0000-4000-8000-000000000004', user_id: A, owner_member_id: null, ...base });
    const joint = stored('joint', null, [{ ownerMemberId: SELF, basisPoints: 6000 }, { ownerMemberId: SPOUSE, basisPoints: 4000 }]);
    expect(await applyUploadOwnerToExistingAuAccount(A, 'c0000000-0000-4000-8000-000000000004', joint, false)).toBe('applied');
    const rows = h.db.rows('ii_ownership_allocation').filter((r) => r.ii_account_id === 'c0000000-0000-4000-8000-000000000004' && r.status === 'active');
    expect(rows.reduce((n, r) => n + (r.allocation_basis_points as number), 0)).toBe(10000);
    expect(rows.every((r) => r.owner_role === 'joint')).toBe(true);
    expect(h.db.rows('ii_accounts').find((a) => a.id === 'c0000000-0000-4000-8000-000000000004')!.owner_member_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('panels: owner chosen before upload, button disabled until chosen, no role-only owner', () => {
  const panels: Array<[string, string, string]> = [
    ['payslip', 'components/income/PayslipImportPanel.tsx', 'payslip'],
    ['liability', 'components/liabilities/LiabilityImportPanel.tsx', 'liability'],
    ['retirement', 'components/retirement/RetirementStatementImportPanel.tsx', 'retirement'],
    ['au investment', 'components/investments/AuInvestmentStatementImportPanel.tsx', 'au_investment'],
  ];
  it.each(panels)('%s panel uses the shared OwnerSelector with its own flow and cannot upload without an owner', (_n, file, flow) => {
    const src = read(file);
    expect(src).toContain(`<OwnerSelector flow="${flow}"`);
    expect(src).toMatch(/!owner\b|!uploadOwner\b/);
  });
  it('the payslip panel no longer asks "Whose payslip is this?" with a role-only Mine / spouse select before upload', () => {
    const src = read('components/income/PayslipImportPanel.tsx');
    expect(src).not.toMatch(/<option value="spouse">My spouse/);
    expect(src).toMatch(/data-testid="payslip-owner-fixed"/); // after upload the owner is shown, fixed
  });
});
