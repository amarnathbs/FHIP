// Document2 (4) WP-H -- the replacement ROUTE passes the document password and the person's confirmations to the service, returns the
// plain-words identity report on every refusal, and the screen only ever offers a confirm button for CONFIRMABLE differences.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const h = vi.hoisted(() => ({
  userId: 'user-1',
  denyImport: false,
  calls: [] as Record<string, unknown>[],
  result: null as unknown,
}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  requireCountryConfirmedUser: async () => ({ user: { id: h.userId, email: null }, unauthenticated: null }),
}));
vi.mock('@/lib/entitlements/financialDataImport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements/financialDataImport')>()),
  refuseUnlessFinancialImportAllowed: async () => (h.denyImport ? Response.json({ error: 'premium_required' }, { status: 403 }) : null),
}));
vi.mock('@/lib/services/investment-intelligence/sourceDocumentReplacement', () => ({
  replaceSourceDocumentFile: async (input: Record<string, unknown>) => {
    h.calls.push(input);
    return h.result;
  },
}));

import { POST } from '@/app/api/investment-intelligence/source-documents/[id]/replacement/route';
import { ReplacementCopyControl, readConfirmationRequest } from '@/components/investment-intelligence/ReplacementCopyControl';

const params = { params: Promise.resolve({ id: 'doc1' }) };
const identityReport = (decision: 'needs_confirmation' | 'rejected', differences: { code: string; severity: 'confirm' | 'reject'; message: string }[]) => ({ decision, differences, comparedOn: ['statement period'], notComparedOn: [], candidateSummary: 'This file is a CAMS consolidated account statement covering 01-01-2025 to 30-04-2025, with 1 folio (ending 4455).' });

function upload(fields: Record<string, string> = {}) {
  const form = new FormData();
  form.append('file', new File([new Uint8Array([37, 80, 68, 70])], 'new.pdf', { type: 'application/pdf' }));
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return new Request('http://t/x', { method: 'POST', body: form });
}

beforeEach(() => {
  h.userId = 'user-1';
  h.denyImport = false;
  h.calls.length = 0;
  h.result = { ok: true, sourceDocumentId: 'doc1', status: 'parsed', checksumChanged: true, previousFilename: 'old.pdf', scanPending: false, identity: identityReport('needs_confirmation', []) };
});

describe('replacement route: password and confirmations', () => {
  it('passes the password and the confirmed codes to the service for THIS user; the password is used for the check only', async () => {
    const res = await POST(upload({ password: 'pw-123', confirmDifferences: 'period_differs, folios_differ' }), params);
    expect(res.status).toBe(200);
    expect(h.calls[0]).toMatchObject({ userId: 'user-1', sourceDocumentId: 'doc1', password: 'pw-123', confirmedDifferences: ['period_differs', 'folios_differ'] });
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain('pw-123'); // never echoed
  });
  it('no password and no confirmation -> undefined and an empty list (nothing is confirmed by default)', async () => {
    await POST(upload(), params);
    expect(h.calls[0]).toMatchObject({ password: undefined, confirmedDifferences: [] });
  });
  it('garbage in confirmDifferences is dropped, not trusted (only lower-case snake_case codes survive)', async () => {
    await POST(upload({ confirmDifferences: "period_differs,'; drop table x;--,A B,<script>" }), params);
    expect(h.calls[0].confirmedDifferences).toEqual(['period_differs']);
  });
  it('is still Premium-gated before the body is read (a refused user reaches neither the service nor the check)', async () => {
    h.denyImport = true;
    const res = await POST(upload(), params);
    expect(res.status).toBe(403);
    expect(h.calls).toEqual([]);
  });
  it('a refusal returns the status, the code, the plain message and the identity report', async () => {
    h.result = { ok: false, httpStatus: 409, code: 'replacement_needs_confirmation', message: 'This copy differs.', identity: identityReport('needs_confirmation', [{ code: 'period_differs', severity: 'confirm', message: 'This copy covers 01-01-2025 to 30-04-2025.' }]) };
    const res = await POST(upload(), params);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'replacement_needs_confirmation', message: 'This copy differs.' });
    expect(body.identity.differences[0].code).toBe('period_differs');
  });
});

describe('the screen: a confirm button only for confirmable differences', () => {
  const needs = { error: 'replacement_needs_confirmation', identity: identityReport('needs_confirmation', [{ code: 'period_differs', severity: 'confirm', message: 'This copy covers 01-01-2025 to 30-04-2025, but the statement it would replace covers 01-01-2025 to 31-03-2025.' }]) };
  it('a needs-confirmation answer becomes a request listing the differences and the codes to send back', () => {
    expect(readConfirmationRequest(409, needs)).toEqual({
      codes: ['period_differs'],
      lines: ['This copy covers 01-01-2025 to 30-04-2025, but the statement it would replace covers 01-01-2025 to 31-03-2025.'],
      summary: 'This file is a CAMS consolidated account statement covering 01-01-2025 to 30-04-2025, with 1 folio (ending 4455).',
    });
  });
  it('NEGATIVE CONTROL: a rejection (a different statement) never produces a confirmation request, even if the answer is shaped like one', () => {
    const rejected = { error: 'replacement_identity_conflict', identity: identityReport('rejected', [{ code: 'period_no_overlap', severity: 'reject', message: 'x' }]) };
    expect(readConfirmationRequest(422, rejected)).toBeNull();
    expect(readConfirmationRequest(409, rejected)).toBeNull(); // wrong error code
    expect(readConfirmationRequest(409, { error: 'replacement_needs_confirmation', identity: identityReport('rejected', [{ code: 'period_no_overlap', severity: 'reject', message: 'x' }]) })).toBeNull(); // decision says rejected
  });
  it('only the confirmable codes are offered back, never a reject code mixed into the same answer', () => {
    const mixed = { error: 'replacement_needs_confirmation', identity: identityReport('needs_confirmation', [{ code: 'period_differs', severity: 'confirm', message: 'a' }, { code: 'provider_differs', severity: 'reject', message: 'b' }]) };
    expect(readConfirmationRequest(409, mixed)?.codes).toEqual(['period_differs']);
  });
  it('other failures (a duplicate file, a missing password, a server error) are not confirmation requests', () => {
    expect(readConfirmationRequest(409, { error: 'file_belongs_to_another_statement' })).toBeNull();
    expect(readConfirmationRequest(422, { error: 'password_required_for_check' })).toBeNull();
    expect(readConfirmationRequest(500, {})).toBeNull();
  });
  it('the control still opens with the password box and no confirmation block', () => {
    const html = renderToStaticMarkup(createElement(ReplacementCopyControl, { documentId: 'doc1' }));
    expect(html).toContain('type="password"');
    expect(html).not.toContain('replacement-confirmation');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Upload replacement copy<\/button>/);
  });
});
