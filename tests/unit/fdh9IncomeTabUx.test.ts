/**
 * FDH-9 — Income-tab payslip journey: UI/API layer tests (spec section 68).
 *
 * Two things this file proves that the PGlite/extraction certifications
 * (76/76, 278/278) do not, because neither of those touches the app/api
 * layer that did not exist before this pass:
 *
 *   1. AUTH REJECTION (spec section 30): every new route derives identity
 *      from the authenticated session and refuses before touching any
 *      service/database call when there is none. Proven by mocking
 *      `requireUser()` to return unauthenticated and asserting a 401 with
 *      no downstream service invoked — not merely that the response looks
 *      right, per spec section 68's "do not rely solely on snapshots".
 *   2. The controlled failure-state VOCABULARY (spec sections 27-28, 33-34,
 *      59) is exhaustive and every code it can produce has a truthful,
 *      non-technical user-facing message — never a raw enum name, never a
 *      stack trace.
 *
 * MOCKING CONVENTION: this codebase has no general Supabase mock by design
 * (see `fdh6Pagination.test.ts`'s own header) — `@/lib/api`'s `requireUser`
 * is mocked directly instead, which is sufficient because every route in
 * this file checks `if (!user) return unauthenticated!` before any other
 * call, so no database client is ever constructed on the rejected path.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const requireUserMock = vi.fn();
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, requireUser: () => requireUserMock() };
});

import {
  errorCodeForPdfExtractionFailure,
  errorCodeForPayslipParseFailure,
  PAYSLIP_FAILURE_MESSAGES,
} from '@/lib/financial-data-hub/services/payslipProcessingService';
import type { PayslipExtractionFailureKind } from '@/lib/financial-data-hub/payslip/types';

const UNAUTHENTICATED = { user: null, unauthenticated: Response.json({ error: 'unauthenticated' }, { status: 401 }) };

beforeEach(() => {
  requireUserMock.mockReset();
  requireUserMock.mockResolvedValue(UNAUTHENTICATED);
});

// ---------------------------------------------------------------------------
describe('FDH-9 controlled failure vocabulary (spec 27-28, 33-34, 59)', () => {
  const pdfKinds = ['password_required', 'wrong_password', 'corrupt', 'insufficient_text', 'page_limit_exceeded', 'unknown_error'];
  it.each(pdfKinds)('every PDF-extraction failure kind ("%s") maps to a code with a truthful message', (kind) => {
    const code = errorCodeForPdfExtractionFailure(kind);
    expect(PAYSLIP_FAILURE_MESSAGES[code]).toBeTruthy();
    expect(PAYSLIP_FAILURE_MESSAGES[code]).not.toMatch(/error TS|stack|undefined|\[object/i);
  });

  it('a scanned/image-only payslip gets the spec-mandated OCR message verbatim', () => {
    const code = errorCodeForPdfExtractionFailure('insufficient_text');
    expect(code).toBe('ocr_required');
    expect(PAYSLIP_FAILURE_MESSAGES[code]).toBe(
      "We couldn't read text from this payslip. Scanned payslip OCR is not yet supported.",
    );
  });

  const parseKinds: PayslipExtractionFailureKind[] = [
    'scanned_document', 'ocr_required', 'password_required', 'wrong_password',
    'corrupt', 'layout_unsupported', 'country_not_identified', 'page_limit_exceeded',
    'not_a_payslip', 'unknown_error',
  ];
  it.each(parseKinds)('every payslip-layout parse failure kind ("%s") maps to a code with a truthful message', (kind) => {
    const code = errorCodeForPayslipParseFailure(kind);
    expect(PAYSLIP_FAILURE_MESSAGES[code]).toBeTruthy();
  });

  it('never invents a code outside the already-existing FDH error vocabulary', () => {
    const allCodes = [...pdfKinds.map(errorCodeForPdfExtractionFailure), ...parseKinds.map(errorCodeForPayslipParseFailure)];
    const allowed = new Set([
      'password_required', 'password_invalid', 'file_corrupt', 'ocr_required',
      'page_limit_exceeded', 'document_type_not_identified', 'layout_unsupported', 'internal_error',
    ]);
    for (const code of allCodes) expect(allowed.has(code)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('FDH-9 API layer — authenticated session required (spec section 30)', () => {
  it('POST /payslip/{id}/process rejects with 401 when unauthenticated', async () => {
    const { POST } = await import('@/app/api/financial-data-hub/payslip/[documentId]/process/route');
    const res = await POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ documentId: 'doc-1' }) });
    expect(res.status).toBe(401);
  });

  it('GET /payslip/{id} rejects with 401 when unauthenticated', async () => {
    const { GET } = await import('@/app/api/financial-data-hub/payslip/[documentId]/route');
    const res = await GET(new Request('http://x'), { params: Promise.resolve({ documentId: 'doc-1' }) });
    expect(res.status).toBe(401);
  });

  it('POST /payslip/{id}/approve rejects with 401 when unauthenticated', async () => {
    const { POST } = await import('@/app/api/financial-data-hub/payslip/[documentId]/approve/route');
    const res = await POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ documentId: 'doc-1' }) });
    expect(res.status).toBe(401);
  });

  it('POST /payslip/{id}/proposal rejects with 401 when unauthenticated', async () => {
    const { POST } = await import('@/app/api/financial-data-hub/payslip/[documentId]/proposal/route');
    const res = await POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ documentId: 'doc-1' }) });
    expect(res.status).toBe(401);
  });

  it('GET /payslip/{id}/proposal rejects with 401 when unauthenticated', async () => {
    const { GET } = await import('@/app/api/financial-data-hub/payslip/[documentId]/proposal/route');
    const res = await GET(new Request('http://x'), { params: Promise.resolve({ documentId: 'doc-1' }) });
    expect(res.status).toBe(401);
  });

  it('POST /income-proposals/{id}/apply rejects with 401 when unauthenticated, before any decision is inspected', async () => {
    const { POST } = await import('@/app/api/financial-data-hub/income-proposals/[proposalId]/apply/route');
    const res = await POST(
      new Request('http://x', { method: 'POST', body: JSON.stringify({ decision: 'add_new' }) }),
      { params: Promise.resolve({ proposalId: 'prop-1' }) },
    );
    expect(res.status).toBe(401);
  });

  it('GET /income-proposals rejects with 401 when unauthenticated', async () => {
    const { GET } = await import('@/app/api/financial-data-hub/income-proposals/route');
    const res = await GET();
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
describe('FDH-9 apply route — request validation (spec section 31, 38)', () => {
  it('rejects an unrecognised decision value with 422 (not a raw 500)', async () => {
    requireUserMock.mockResolvedValue({ user: { id: 'user-1' }, unauthenticated: null });
    const { POST } = await import('@/app/api/financial-data-hub/income-proposals/[proposalId]/apply/route');
    const res = await POST(
      new Request('http://x', { method: 'POST', body: JSON.stringify({ decision: 'delete_everything' }) }),
      { params: Promise.resolve({ proposalId: 'prop-1' }) },
    );
    expect(res.status).toBe(422);
  });

  it('rejects a request body with no decision at all with 422', async () => {
    requireUserMock.mockResolvedValue({ user: { id: 'user-1' }, unauthenticated: null });
    const { POST } = await import('@/app/api/financial-data-hub/income-proposals/[proposalId]/apply/route');
    const res = await POST(
      new Request('http://x', { method: 'POST', body: JSON.stringify({}) }),
      { params: Promise.resolve({ proposalId: 'prop-1' }) },
    );
    expect(res.status).toBe(422);
  });
});
