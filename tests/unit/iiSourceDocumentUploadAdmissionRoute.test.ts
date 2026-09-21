// Investment Intelligence source-document upload — admission gate at the
// real route handler (2026-09-21 fix, M13A finding). Proves a structurally
// hostile or corrupt file is refused BEFORE any Supabase client is touched,
// before storage is written to, and before an ii_source_documents row could
// ever be created — so it can never reach documentProcessing.ts's
// parsing/AI-fallback path, since that path only ever operates on an
// already-persisted row. A clean PDF is also proven to still go through
// end-to-end (the legitimate path is not collateral damage).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { requireUserMock, auditEvents, uploadSpy } = vi.hoisted(() => ({
  requireUserMock: vi.fn(() => ({ user: { id: 'ii-upload-user', email: 'user@example.com' }, unauthenticated: null })),
  auditEvents: [] as Record<string, unknown>[],
  uploadSpy: vi.fn(async () => ({ error: null })),
}));

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, requireCountryConfirmedUser: () => requireUserMock() };
});

vi.mock('@/lib/services/investment-intelligence/audit', () => ({
  emitAuditEvent: async (input: Record<string, unknown>) => {
    auditEvents.push(input);
    return { error: null };
  },
}));

vi.mock('@/lib/services/investment-intelligence/storage', async () => {
  const actual = await vi.importActual<typeof import('@/lib/services/investment-intelligence/storage')>(
    '@/lib/services/investment-intelligence/storage'
  );
  return { ...actual, uploadSourceDocumentObject: uploadSpy };
});

function buildPdfBytes(body: string): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.4\n${body}\n%%EOF\n`);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function uploadForm(bytes: Uint8Array, filename = 'statement.pdf', mimeType = 'application/pdf'): FormData {
  const form = new FormData();
  form.append('file', new File([toArrayBuffer(bytes)], filename, { type: mimeType }));
  form.append('meta', JSON.stringify({ sourceKey: 'manual', countryCode: 'AU' }));
  return form;
}

describe('POST /api/investment-intelligence/source-documents — admission gate', () => {
  beforeEach(() => {
    vi.resetModules();
    auditEvents.length = 0;
    uploadSpy.mockClear();
    requireUserMock.mockClear();
  });

  it('DENIAL: a structurally hostile PDF (embedded JavaScript) is rejected 422, before any Supabase client or storage write', async () => {
    // No Supabase server client is mocked at all here — if the route reached
    // `createClient()` it would hit the real module and fail in this test
    // environment, so a passing test is itself proof the code path never
    // got that far.
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: async () => {
        throw new Error('createClient must not be called for a structurally-rejected upload');
      },
    }));
    const { POST } = await import('@/app/api/investment-intelligence/source-documents/route');
    const bytes = buildPdfBytes('/Type /Action /S /JavaScript /JS (app.alert(1))');
    const res = await POST(new Request('http://x', { method: 'POST', body: uploadForm(bytes) }));

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('upload_admission_rejected');

    expect(uploadSpy).not.toHaveBeenCalled();
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].eventType).toBe('document_processing_failed');
    expect((auditEvents[0].metadata as Record<string, unknown>).failureCode).toBe('structural_reject');
  });

  it('DENIAL: bytes that do not look like a PDF at all, declared as application/pdf, are rejected 422', async () => {
    vi.doMock('@/lib/supabase/server', () => ({
      createClient: async () => {
        throw new Error('createClient must not be called for a structurally-rejected upload');
      },
    }));
    const { POST } = await import('@/app/api/investment-intelligence/source-documents/route');
    const bytes = new TextEncoder().encode('not a pdf at all, just plain text pretending to be one');
    const res = await POST(new Request('http://x', { method: 'POST', body: uploadForm(bytes) }));

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('upload_admission_rejected');
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it('LEGITIMATE PATH: a clean PDF upload still succeeds end-to-end (not collateral damage of the fix)', async () => {
    const insertedRows: Record<string, unknown>[] = [];
    const fakeClient = {
      from(table: string) {
        if (table === 'ii_source_documents') {
          const builder = {
            select: () => builder,
            eq: () => builder,
            maybeSingle: () => Promise.resolve({ data: null, error: null }), // no existing dedup match
            insert: (row: Record<string, unknown>) => ({
              select: () => ({
                single: () => {
                  const created = { id: 'new-doc-1', ...row };
                  insertedRows.push(created);
                  return Promise.resolve({ data: created, error: null });
                },
              }),
            }),
          };
          return builder;
        }
        if (table === 'ii_sources') {
          return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'source-manual' }, error: null }) }) }) };
        }
        throw new Error(`unexpected table: ${table}`);
      },
    };
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => fakeClient }));
    const { POST } = await import('@/app/api/investment-intelligence/source-documents/route');
    const bytes = buildPdfBytes('1 0 obj << /Type /Catalog >> endobj');
    const res = await POST(new Request('http://x', { method: 'POST', body: uploadForm(bytes) }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe('new-doc-1');
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(insertedRows).toHaveLength(1);
    // The success audit event ('upload') still fires as before — the new
    // admission check adds a rejection event on the DENIAL path only.
    expect(auditEvents.some((e) => e.eventType === 'upload')).toBe(true);
  });

  it('CSV uploads are not subjected to the PDF-only structural scan (out of this fix\'s scope) and still succeed', async () => {
    const fakeClient = {
      from(table: string) {
        if (table === 'ii_source_documents') {
          const builder = {
            select: () => builder,
            eq: () => builder,
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
            insert: (row: Record<string, unknown>) => ({
              select: () => ({ single: () => Promise.resolve({ data: { id: 'new-doc-csv', ...row }, error: null }) }),
            }),
          };
          return builder;
        }
        if (table === 'ii_sources') {
          return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'source-manual' }, error: null }) }) }) };
        }
        throw new Error(`unexpected table: ${table}`);
      },
    };
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => fakeClient }));
    const { POST } = await import('@/app/api/investment-intelligence/source-documents/route');
    const bytes = new TextEncoder().encode('date,description,amount\n2026-01-01,Test,100\n');
    const res = await POST(new Request('http://x', { method: 'POST', body: uploadForm(bytes, 'statement.csv', 'text/csv') }));

    expect(res.status).toBe(200);
    expect(uploadSpy).toHaveBeenCalledTimes(1);
  });
});
