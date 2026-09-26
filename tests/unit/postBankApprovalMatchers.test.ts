/**
 * WP-01 (j): the post-bank-approval matcher seam, and its wiring into the
 * three bank approval routes.
 *
 * NEGATIVE CONTROL. On the base branch the routes never call the seam, so the
 * "route runs the registered matchers" tests below fail there (no matcher is
 * invoked, no failure audit is written). They pass only with the wiring.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER_ID = 'u-post-approval';
const DOC_ID = 'doc-post-approval';

const h = vi.hoisted(() => ({
  requireUserMock: vi.fn(() => ({ user: { id: 'u-post-approval' }, unauthenticated: null })),
  approveStatementMock: vi.fn(async () => ({ statement: { id: 'doc-post-approval', processing_status: 'approved', approval_version: 1, approved_at: '2026-09-01T00:00:00Z' } })),
  approveAllMock: vi.fn(async () => ({ outcome: 'approved', approved: 3 })),
  approveGroupMock: vi.fn(async () => ({ outcome: 'approved', approved: 2, failed: 0, results: [], statement_finalised: false })),
  auditMock: vi.fn(async () => undefined),
  matcherCalls: [] as string[],
  registry: [] as { id: string; ownerWp: string; run: (ctx: unknown) => Promise<unknown> }[],
}));

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, requireCountryConfirmedUser: () => h.requireUserMock() };
});
vi.mock('@/lib/financial-data-hub/services/approvalService', () => ({
  approveStatement: h.approveStatementMock,
  ApprovalError: class ApprovalError extends Error { code = 'blocked'; details = null; },
}));
vi.mock('@/lib/financial-data-hub/services/categoryReviewService', () => ({
  approveAllOnStatement: h.approveAllMock,
  approveCategoryGroup: h.approveGroupMock,
}));
vi.mock('@/lib/financial-data-hub/services/auditLog', () => ({ recordDocumentAuditEvent: h.auditMock }));
vi.mock('@/lib/import-bridge/postBankApprovalMatchers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/import-bridge/postBankApprovalMatchers')>('@/lib/import-bridge/postBankApprovalMatchers');
  return {
    ...actual,
    runPostBankApprovalMatchers: (ctx: Parameters<typeof actual.runPostBankApprovalMatchers>[0], opts: Parameters<typeof actual.runPostBankApprovalMatchers>[1] = {}) =>
      // The routes pass no explicit matchers, so they get the test registry;
      // the pure-runner tests below pass their own and are left untouched.
      actual.runPostBankApprovalMatchers(ctx, { ...opts, matchers: opts.matchers ?? (h.registry as never) }),
  };
});

import {
  POST_BANK_APPROVAL_MATCHERS,
  runPostBankApprovalMatchers,
  type PostBankApprovalMatcher,
} from '@/lib/import-bridge/postBankApprovalMatchers';

const params = { params: Promise.resolve({ documentId: DOC_ID }) };

function registry(failing: boolean) {
  h.matcherCalls.length = 0;
  h.registry.length = 0;
  h.registry.push(
    { id: 'first', ownerWp: 'WP-TEST', run: async (ctx) => { h.matcherCalls.push(`first:${(ctx as { trigger: string }).trigger}`); if (failing) throw Object.assign(new Error('secret row data 123'), { name: 'MatcherBoom' }); } },
    { id: 'second', ownerWp: 'WP-TEST', run: async (ctx) => { h.matcherCalls.push(`second:${(ctx as { trigger: string }).trigger}`); return { linked: 1 }; } },
  );
}

beforeEach(() => {
  h.auditMock.mockClear();
  h.approveGroupMock.mockClear();
});

describe('runPostBankApprovalMatchers (pure runner)', () => {
  const ctx = { userId: USER_ID, statementUploadId: DOC_ID, trigger: 'statement_approve' as const };

  it('the shipped registry holds at most ONE entry per owning package, each with a unique id (WP-12 added its own)', () => {
    const ids = POST_BANK_APPROVAL_MATCHERS.map((m) => m.id);
    const owners = POST_BANK_APPROVAL_MATCHERS.map((m) => m.ownerWp);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(owners).size).toBe(owners.length);
    expect(POST_BANK_APPROVAL_MATCHERS.find((m) => m.ownerWp === 'WP-12')?.id).toBe('wp12_broker_bank_rematch');
  });

  it('runs every matcher in order and returns their outcomes', async () => {
    const calls: string[] = [];
    const matchers: PostBankApprovalMatcher[] = [
      { id: 'a', ownerWp: 'X', run: async () => { calls.push('a'); return { linked: 2 }; } },
      { id: 'b', ownerWp: 'X', run: async () => { calls.push('b'); } },
    ];
    const res = await runPostBankApprovalMatchers(ctx, { matchers });
    expect(calls).toEqual(['a', 'b']);
    expect(res).toEqual([{ id: 'a', status: 'ok', outcome: { linked: 2 } }, { id: 'b', status: 'ok', outcome: undefined }]);
  });

  it('a throwing matcher is reported by NAME only, and the next matcher still runs', async () => {
    const onMatcherError = vi.fn();
    const matchers: PostBankApprovalMatcher[] = [
      { id: 'boom', ownerWp: 'X', run: async () => { throw Object.assign(new Error('account 0412 balance 9999'), { code: 'P0001' }); } },
      { id: 'after', ownerWp: 'X', run: async () => ({ reclassified: 1 }) },
    ];
    const res = await runPostBankApprovalMatchers(ctx, { matchers, onMatcherError });
    expect(res[0]).toEqual({ id: 'boom', status: 'failed', errorName: 'P0001' });
    expect(JSON.stringify(res)).not.toContain('0412');
    expect(res[1]).toEqual({ id: 'after', status: 'ok', outcome: { reclassified: 1 } });
    expect(onMatcherError).toHaveBeenCalledTimes(1);
  });

  it('a throwing error reporter does not stop the remaining matchers and the runner never throws', async () => {
    const matchers: PostBankApprovalMatcher[] = [
      { id: 'boom', ownerWp: 'X', run: async () => { throw new Error('x'); } },
      { id: 'after', ownerWp: 'X', run: async () => ({ linked: 1 }) },
    ];
    const res = await runPostBankApprovalMatchers(ctx, { matchers, onMatcherError: () => { throw new Error('audit down'); } });
    expect(res.map((r) => r.status)).toEqual(['failed', 'ok']);
  });
});

describe('the three bank approval routes run the seam after a successful approval', () => {
  it('statement approve: runs matchers, audits a failure, still returns 200 with the approval', async () => {
    registry(true);
    const { POST } = await import('@/app/api/financial-data-hub/documents/[documentId]/approve/route');
    const res = await POST(new Request('http://x'), params);
    expect(res.status).toBe(200);
    expect((await res.json()).data.statement_id).toBe(DOC_ID);
    expect(h.matcherCalls).toEqual(['first:statement_approve', 'second:statement_approve']);
    expect(h.auditMock).toHaveBeenCalledTimes(1);
    const event = (h.auditMock.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(event).toMatchObject({ userId: USER_ID, documentId: DOC_ID, eventType: 'post_approval_matcher_failed', actorType: 'system' });
    expect(event.metadata).toEqual({ matcher_id: 'first', trigger: 'statement_approve', error_name: 'MatcherBoom' });
    expect(JSON.stringify(event)).not.toContain('secret row data');
  });

  it('statement approve: a refused approval never runs the matchers', async () => {
    registry(false);
    h.approveStatementMock.mockRejectedValueOnce(new Error('db down'));
    const { POST } = await import('@/app/api/financial-data-hub/documents/[documentId]/approve/route');
    const res = await POST(new Request('http://x'), params);
    expect(res.status).toBe(500);
    expect(h.matcherCalls).toEqual([]);
  });

  it('category-review approve-all: runs matchers when lines were approved, not when already approved', async () => {
    registry(false);
    const { POST } = await import('@/app/api/financial-data-hub/documents/[documentId]/category-review/approve-all/route');
    expect((await POST(new Request('http://x', { method: 'POST' }), params)).status).toBe(200);
    expect(h.matcherCalls).toEqual(['first:category_approve_all', 'second:category_approve_all']);
    registry(false);
    h.approveAllMock.mockResolvedValueOnce({ outcome: 'already_approved', approved: 0 });
    expect((await POST(new Request('http://x', { method: 'POST' }), params)).status).toBe(200);
    expect(h.matcherCalls).toEqual([]);
  });

  it('category-review approve-group: runs matchers when lines were approved', async () => {
    registry(false);
    const { POST } = await import('@/app/api/financial-data-hub/documents/[documentId]/category-review/approve-group/route');
    const res = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ group_key: 'food' }) }), params);
    expect(res.status).toBe(200);
    expect(h.approveGroupMock).toHaveBeenCalledTimes(1);
    expect(h.matcherCalls).toEqual(['first:category_approve_group', 'second:category_approve_group']);
  });
});
