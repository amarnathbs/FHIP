/**
 * WP-09 -- the payslip routes and the atomic wrappers.
 *
 *  - approve: a payslip flagged for review is refused (409 REVIEW_REQUIRED)
 *    until acknowledged; the owner reaches the RPC; "replaces earlier" links
 *    the server-derived predecessor; before 0210 a self approval falls back to
 *    the old RPC and a spouse approval is refused, never recorded as self.
 *  - proposal: an already-applied payslip is 409 ALREADY_APPLIED naming its
 *    Income row; an unapproved one is 409 NOT_APPROVED (the panel opens review).
 *  - apply: CURRENCY_MISMATCH / MEMBER_MISMATCH are 409, and ALREADY_APPLIED
 *    names the row.
 *  - persistProposal keeps the adapter's summary (0207), and still works
 *    without the column.
 *
 * NEGATIVE CONTROL: on the base branch the approve route ignores its body and
 * approves a pending review in one call, approvePayrollEventAtomic has one
 * argument and no fallback, the proposal route answers already-applied with a
 * fresh proposal and not-approved with a bare 409 text, the apply route maps
 * CURRENCY_MISMATCH to 400, and persistProposal drops the summary.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  review: { event: { approval_status: 'pending', review_status: 'pending' }, components: [] } as { event: Record<string, unknown>; components: unknown[] } | null,
  approveCalls: [] as unknown[][],
  approveResult: { ok: true, incomeOwner: 'self', alreadyApproved: false } as Record<string, unknown>,
  predecessor: null as null | { payroll_event_id: string },
  supersedeCalls: [] as string[][],
  audit: vi.fn(async () => undefined),
  generate: vi.fn(),
  applyResult: { ok: true } as Record<string, unknown>,
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  rpcResponses: [] as { data: unknown; error: unknown }[],
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  insertErrors: [] as unknown[],
}));

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, requireCountryConfirmedUser: async () => ({ user: { id: 'u1' }, unauthenticated: null }) };
});
vi.mock('@/lib/services/appCapability', () => ({ requireModuleCapability: async () => ({ user: { id: 'u1' }, blocked: null }) }));
vi.mock('@/lib/financial-data-hub/services/auditLog', () => ({ recordDocumentAuditEvent: h.audit }));
vi.mock('@/lib/financial-data-hub/services/payslipProcessingService', () => ({
  getPayrollEventIdForDocument: async () => 'pe1',
  getPayrollEventForReview: async () => h.review,
  findRevisionPredecessor: async () => h.predecessor,
  supersedePayrollEvent: async (a: string, b: string) => { h.supersedeCalls.push([a, b]); return { ok: true, bankMatchMoved: true }; },
  findEarlierIdenticalPayslip: async () => null,
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.rpcCalls.push({ name, args });
      return h.rpcResponses.shift() ?? { data: { ok: true }, error: null };
    },
    from: (table: string) => ({
      update: () => ({ eq: () => ({ eq: () => ({ eq: async () => ({ data: null, error: null }) }) }) }),
      insert: (row: Record<string, unknown>) => ({
        select: () => ({
          single: async () => {
            h.inserts.push({ table, row });
            const err = h.insertErrors.shift();
            return err ? { data: null, error: err } : { data: { id: `id-${h.inserts.length}` }, error: null };
          },
        }),
        then: (resolve: (v: unknown) => unknown) => { h.inserts.push({ table, row }); return resolve({ data: null, error: null }); },
      }),
    }),
  }),
}));

beforeEach(() => {
  h.review = { event: { approval_status: 'pending', review_status: 'pending' }, components: [] };
  h.approveCalls.length = 0;
  h.supersedeCalls.length = 0;
  h.predecessor = null;
  h.rpcCalls.length = 0;
  h.rpcResponses.length = 0;
  h.inserts.length = 0;
  h.insertErrors.length = 0;
  h.audit.mockClear();
});

const params = { params: Promise.resolve({ documentId: 'doc1' }) };
const post = (body?: unknown) => new Request('http://localhost/x', { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) });

describe('POST /payslip/{id}/approve', () => {
  it('refuses a payslip flagged for review until the user acknowledges it (409 REVIEW_REQUIRED), and calls no RPC', async () => {
    const { POST } = await import('@/app/api/financial-data-hub/payslip/[documentId]/approve/route');
    const res = await POST(post(), params);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('REVIEW_REQUIRED');
    expect(h.rpcCalls).toHaveLength(0);
  });

  it('acknowledged + spouse: the RPC receives the owner and the acknowledgement; the audit records them', async () => {
    h.rpcResponses.push({ data: { ok: true, outcome: 'approved', income_owner: 'spouse' }, error: null });
    const { POST } = await import('@/app/api/financial-data-hub/payslip/[documentId]/approve/route');
    const res = await POST(post({ income_owner: 'spouse', acknowledge_review: true }), params);
    expect(res.status).toBe(200);
    expect(h.rpcCalls[0]).toEqual({ name: 'fdh9_approve_payroll_event', args: { p_payroll_event_id: 'pe1', p_income_owner: 'spouse', p_acknowledge_review: true } });
    expect((await res.json()).data.income_owner).toBe('spouse');
    expect(h.audit.mock.calls[0]?.[0]).toMatchObject({ eventType: 'payroll_event_approved', metadata: { income_owner: 'spouse', review_acknowledged: true } });
  });

  it('replaces_earlier links the SERVER-derived predecessor after approval', async () => {
    h.review = { event: { approval_status: 'pending', review_status: 'not_required' }, components: [] };
    h.predecessor = { payroll_event_id: 'pe-old' };
    const { POST } = await import('@/app/api/financial-data-hub/payslip/[documentId]/approve/route');
    const res = await POST(post({ replaces_earlier: true }), params);
    expect(res.status).toBe(200);
    expect(h.supersedeCalls).toEqual([['pe-old', 'pe1']]);
    expect((await res.json()).data.superseded).toEqual({ payroll_event_id: 'pe-old', bank_match_moved: true });
  });

  it('an unknown body key is refused (422), never silently ignored', async () => {
    const { POST } = await import('@/app/api/financial-data-hub/payslip/[documentId]/approve/route');
    expect((await POST(post({ income_owner: 'joint' }), params)).status).toBe(422);
  });
});

describe('approvePayrollEventAtomic before 0210 is applied', () => {
  const missing = { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.fdh9_approve_payroll_event(p_acknowledge_review, p_income_owner, p_payroll_event_id)' } };

  it('self: falls back to the one-argument RPC (the old behaviour)', async () => {
    h.rpcResponses.push(missing, { data: { ok: true, outcome: 'approved' }, error: null });
    const { approvePayrollEventAtomic } = await import('@/lib/import-bridge/applyIncomeProposalAtomic');
    const r = await approvePayrollEventAtomic('pe1', { incomeOwner: 'self' });
    expect(r).toEqual({ ok: true, incomeOwner: 'self', alreadyApproved: false });
    expect(h.rpcCalls.map((c) => Object.keys(c.args))).toEqual([['p_payroll_event_id', 'p_income_owner', 'p_acknowledge_review'], ['p_payroll_event_id']]);
  });

  it("spouse: refused (MIGRATION_PENDING) -- never recorded as the user's own income", async () => {
    h.rpcResponses.push(missing);
    const { approvePayrollEventAtomic } = await import('@/lib/import-bridge/applyIncomeProposalAtomic');
    const r = await approvePayrollEventAtomic('pe1', { incomeOwner: 'spouse' });
    expect(r).toMatchObject({ ok: false, code: 'MIGRATION_PENDING' });
    expect(h.rpcCalls).toHaveLength(1);
  });
});

describe('POST /payslip/{id}/proposal', () => {
  it('already applied -> 409 ALREADY_APPLIED naming the Income row (no second proposal)', async () => {
    vi.resetModules();
    vi.doMock('@/lib/import-bridge/incomeProposalService', async () => {
      const actual = await vi.importActual<typeof import('@/lib/import-bridge/incomeProposalService')>('@/lib/import-bridge/incomeProposalService');
      return { ...actual, generateIncomeProposal: async () => { throw new actual.IncomeProposalError('already_applied', 'This payslip is already in your income.', 'src-1'); } };
    });
    const { POST } = await import('@/app/api/financial-data-hub/payslip/[documentId]/proposal/route');
    const res = await POST(post(), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'ALREADY_APPLIED', target_entity_id: 'src-1' });
    vi.doUnmock('@/lib/import-bridge/incomeProposalService');
  });

  it('not yet approved -> 409 NOT_APPROVED with the document, so the panel opens the review step', async () => {
    vi.resetModules();
    vi.doMock('@/lib/import-bridge/incomeProposalService', async () => {
      const actual = await vi.importActual<typeof import('@/lib/import-bridge/incomeProposalService')>('@/lib/import-bridge/incomeProposalService');
      return { ...actual, generateIncomeProposal: async () => { throw new actual.IncomeProposalError('not_approved', 'Approve first.'); } };
    });
    const { POST } = await import('@/app/api/financial-data-hub/payslip/[documentId]/proposal/route');
    const res = await POST(post(), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'NOT_APPROVED', document_id: 'doc1' });
    vi.doUnmock('@/lib/import-bridge/incomeProposalService');
  });

  it('a chosen frequency reaches the service; an invalid one is 422', async () => {
    vi.resetModules();
    const seen: unknown[] = [];
    vi.doMock('@/lib/import-bridge/incomeProposalService', async () => {
      const actual = await vi.importActual<typeof import('@/lib/import-bridge/incomeProposalService')>('@/lib/import-bridge/incomeProposalService');
      return {
        ...actual,
        generateIncomeProposal: async (_u: string, _e: string, o: unknown) => { seen.push(o); return { proposalId: 'p1', statementUploadId: 'doc1', recommendedApplyMode: 'add_new', summary: { title: 't', lines: [], reviewReasons: [] } }; },
        getIncomeProposalForReview: async () => ({ proposal: { id: 'p1' }, fields: [] }),
      };
    });
    const { POST } = await import('@/app/api/financial-data-hub/payslip/[documentId]/proposal/route');
    const res = await POST(post({ frequency: 'monthly' }), params);
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ frequency: 'monthly' }]);
    expect((await res.json()).data.summary).toEqual({ title: 't', lines: [], reviewReasons: [] });
    expect((await POST(post({ frequency: 'daily' }), params)).status).toBe(422);
    vi.doUnmock('@/lib/import-bridge/incomeProposalService');
  });
});

describe('POST /income-proposals/{id}/apply', () => {
  const applyParams = { params: Promise.resolve({ proposalId: 'p1' }) };
  it.each([
    ['CURRENCY_MISMATCH', { code: 'CURRENCY_MISMATCH', error: 'This payslip is in INR but the income entry is in AUD', target_currency: 'AUD', proposal_currency: 'INR' }],
    ['MEMBER_MISMATCH', { code: 'MEMBER_MISMATCH', error: 'different household member' }],
  ])('%s -> 409 with the code', async (_name, rpc) => {
    h.rpcResponses.push({ data: { ok: false, ...rpc }, error: null });
    vi.resetModules();
    const { POST } = await import('@/app/api/financial-data-hub/income-proposals/[proposalId]/apply/route');
    const res = await POST(post({ decision: 'update_existing' }), applyParams);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe(rpc.code);
  });

  it('ALREADY_APPLIED (event level) names the Income row the payslip is already in', async () => {
    h.rpcResponses.push({ data: { ok: false, code: 'ALREADY_APPLIED', error: 'This payslip is already in your income.', target_entity_id: 'src-1', application_id: 'a1' }, error: null });
    vi.resetModules();
    const { POST } = await import('@/app/api/financial-data-hub/income-proposals/[proposalId]/apply/route');
    const res = await POST(post({ decision: 'add_new', selectedFields: ['amount'] }), applyParams);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'ALREADY_APPLIED', target_entity_id: 'src-1' });
  });
});

describe('persistProposal keeps the explanation (GAP-07)', () => {
  const draft = {
    targetDomain: 'income', sourceKind: 'payslip', currencyCode: 'AUD', targetEntityId: null, targetEntityUpdatedAt: null,
    recommendedApplyMode: 'add_new', duplicateOfEntityId: null, fields: [],
    summary: { title: 'Add this as a new income source?', lines: [{ label: 'Employer', value: 'Acme' }], reviewReasons: ['bank_deposit_not_found'] },
  } as const;

  it('the summary (title, lines, review reasons) is stored on the proposal', async () => {
    vi.resetModules();
    const { persistProposal } = await import('@/lib/import-bridge/supabaseStore');
    await persistProposal('u1', draft as never, 'pe1');
    const row = h.inserts.find((i) => i.table === 'fhip_import_proposals')!.row;
    expect(row.summary).toEqual(draft.summary);
  });

  it('before 0207 (no summary column) the proposal is still stored, without it', async () => {
    h.insertErrors.push({ code: 'PGRST204', message: "Could not find the 'summary' column of 'fhip_import_proposals' in the schema cache" });
    vi.resetModules();
    const { persistProposal } = await import('@/lib/import-bridge/supabaseStore');
    const id = await persistProposal('u1', draft as never, 'pe1');
    const rows = h.inserts.filter((i) => i.table === 'fhip_import_proposals').map((i) => i.row);
    expect(rows).toHaveLength(2);
    expect('summary' in rows[1]).toBe(false);
    expect(id).toBe('id-2');
  });
});
