/**
 * "Export PDF" on a generated Monthly Report must never answer with the platform's bare 500 (17-10-2026).
 *
 * Production evidence: HTTP 500, 21 bytes of body ("Internal Server Error"), about 230 ms, no typed answer. A typed
 * answer from this route is a JSON body of a few hundred bytes, so the failure happened where no handler code could
 * catch it: while LOADING the route. The route imported the headless-browser renderer (and `playwright`) at the top of
 * the file.
 *
 * NAMED NEGATIVE CONTROLS
 *   NC-X1  the OLD shape: statically importing a renderer whose `playwright` cannot be loaded rejects at import time
 *          (this is the platform 500). Proves the broken-package simulation in NC-X2 really breaks something.
 *   NC-X2  with `playwright` made unloadable, the real route + real loader + real renderer module answers typed JSON
 *          503 EXPORT_RENDER_FAILED / renderer_unavailable instead.
 *   NC-X3  a deadline test that the fake renderer really does hang for (without the deadline the promise never settles).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyRenderFailure, ReportExportError, withExportDeadline } from '@/lib/services/reportExportFailure';
import { describeExportFailure, readApiResponse } from '@/lib/reports/apiClient';

interface World {
  entitled: boolean;
  insertError: { message: string } | null;
  uploadError: { message: string } | null;
  updates: Array<Record<string, unknown>>;
  rendererCalls: number;
}

let world: World;
let renderImpl: () => Promise<{ buffer: Buffer; checksum: string }>;

function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'insert', 'update']) c[m] = () => c;
  c.maybeSingle = async () => ({ data: result, error: null });
  c.single = async () => ({ data: { id: 'exp-1', status: 'generating' }, error: null });
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
  return c;
}

function installMocks(opts: { rendererModule?: 'fake' | 'real' } = {}) {
  vi.doMock('@/lib/api', async (orig) => ({ ...(await orig<object>()), requireCountryConfirmedUser: async () => ({ user: { id: 'user-1' }, unauthenticated: null }) }));
  vi.doMock('@/lib/services/entitlements', () => ({ canExportReports: async () => world.entitled }));
  vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => ({ from: () => chain({ id: 'r1' }) }) }));
  vi.doMock('@/lib/supabase/admin', () => ({
    createAdminClient: () => ({
      from: () => ({
        ...chain(null),
        insert: () => ({
          select: () => ({
            single: async () => (world.insertError ? { data: null, error: world.insertError } : { data: { id: 'exp-1', status: 'generating' }, error: null }),
          }),
        }),
        update: (row: Record<string, unknown>) => {
          world.updates.push(row);
          return { eq: () => ({ select: () => ({ single: async () => ({ data: { id: 'exp-1', status: 'ready', ...row }, error: null }) }), then: (r: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(r) }) };
        },
      }),
      storage: { from: () => ({ upload: async () => ({ error: world.uploadError }) }) },
    }),
  }));
  if ((opts.rendererModule ?? 'fake') === 'fake') {
    vi.doMock('@/lib/services/reportPdfRenderer', () => ({
      renderReportToPdf: async () => {
        world.rendererCalls += 1;
        return renderImpl();
      },
    }));
  }
}

async function post() {
  const { POST } = await import('@/app/api/reports/[id]/exports/route');
  return POST(new Request('http://t/x', { method: 'POST', body: JSON.stringify({ format: 'pdf' }) }), { params: Promise.resolve({ id: 'r1' }) });
}

async function typed(res: Response) {
  const text = await res.text();
  expect(text.length).toBeGreaterThan(21); // never the 21-byte platform body
  expect(text).not.toBe('Internal Server Error');
  return JSON.parse(text) as { error: string; code: string; correlationId: string; retryable: boolean; detail?: string; data?: { status: string } };
}

beforeEach(() => {
  vi.resetModules();
  world = { entitled: true, insertError: null, uploadError: null, updates: [], rendererCalls: 0 };
  renderImpl = async () => ({ buffer: Buffer.from('%PDF-1.7 fake'), checksum: 'abc' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.doUnmock('playwright');
  vi.doUnmock('@/lib/services/reportPdfRenderer');
  vi.doUnmock("@/lib/services/forecastReportPdfRenderer");
  vi.useRealTimers();
});

describe('POST /api/reports/[id]/exports with a fake renderer', () => {
  it('success: a ready export row, the renderer called once', async () => {
    installMocks();
    const res = await post();
    expect(res.status).toBe(200);
    const body = await typed(res);
    expect(body.data?.status).toBe('ready');
    expect(world.rendererCalls).toBe(1);
  });

  it('renderer missing at launch: typed 503 EXPORT_RENDER_FAILED / renderer_unavailable, not retryable, row marked failed', async () => {
    installMocks();
    renderImpl = async () => {
      throw new Error("browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium-1234/chrome-linux/chrome");
    };
    const res = await post();
    expect(res.status).toBe(503);
    const body = await typed(res);
    expect(body).toMatchObject({ code: 'EXPORT_RENDER_FAILED', detail: 'renderer_unavailable', retryable: false });
    expect(body.error).toMatch(/temporarily unavailable/);
    expect(body.error).toMatch(/Print/);
    expect(body.correlationId).toMatch(/^rpt-/);
    expect(JSON.stringify(body)).not.toContain('ms-playwright'); // the path stays in the server log
    expect(world.updates.some((u) => u.status === 'failed' && u.error_code === 'renderer_unavailable')).toBe(true);
  });

  it('token failure: typed 503 / token_failed, retryable', async () => {
    installMocks();
    renderImpl = async () => {
      throw new ReportExportError('token_failed', 'Could not prepare render token: permission denied for table report_exports');
    };
    const res = await post();
    expect(res.status).toBe(503);
    const body = await typed(res);
    expect(body).toMatchObject({ code: 'EXPORT_RENDER_FAILED', detail: 'token_failed', retryable: true });
    expect(JSON.stringify(body)).not.toContain('permission denied');
  });

  it('entitlement refusal: typed 403 EXPORT_PREMIUM_REQUIRED, the renderer is never called', async () => {
    installMocks();
    world.entitled = false;
    const res = await post();
    expect(res.status).toBe(403);
    const body = await typed(res);
    expect(body).toMatchObject({ code: 'EXPORT_PREMIUM_REQUIRED', detail: 'entitlement', retryable: false });
    expect(world.rendererCalls).toBe(0);
  });

  it('timeout: a renderer that hangs is cut at the deadline with a typed 504 / render_timeout (NC-X3)', async () => {
    installMocks();
    renderImpl = () => new Promise(() => {}); // never settles
    const { POST } = await import('@/app/api/reports/[id]/exports/route'); // load first: only the deadline timer is faked
    vi.useFakeTimers();
    const pending = POST(new Request('http://t/x', { method: 'POST', body: JSON.stringify({ format: 'pdf' }) }), { params: Promise.resolve({ id: 'r1' }) });
    let settled = false;
    void pending.then(() => (settled = true));
    for (let i = 0; i < 40 && !settled; i++) await vi.advanceTimersByTimeAsync(1000);
    const res = await pending;
    expect(res.status).toBe(504);
    const body = await typed(res);
    expect(body).toMatchObject({ code: 'EXPORT_RENDER_FAILED', detail: 'render_timeout', retryable: true });
  });

  it('storage failure: typed 502 / storage_failed', async () => {
    installMocks();
    world.uploadError = { message: 'Bucket not found' };
    const res = await post();
    expect(res.status).toBe(502);
    expect(await typed(res)).toMatchObject({ code: 'EXPORT_RENDER_FAILED', detail: 'storage_failed' });
  });

  it('export record not writable: typed 503 EXPORT_FAILED / record_failed, the database message is not returned', async () => {
    installMocks();
    world.insertError = { message: 'relation "report_exports" does not exist' };
    const res = await post();
    expect(res.status).toBe(503);
    const body = await typed(res);
    expect(body).toMatchObject({ code: 'EXPORT_FAILED', detail: 'record_failed' });
    expect(JSON.stringify(body)).not.toContain('report_exports');
    expect(world.rendererCalls).toBe(0);
  });

  it('an unclassified throw anywhere is still typed JSON with a reference', async () => {
    installMocks();
    renderImpl = async () => {
      throw new Error('something nobody planned for');
    };
    const res = await post();
    expect(res.status).toBe(502);
    expect(await typed(res)).toMatchObject({ code: 'EXPORT_RENDER_FAILED', detail: 'render_failed' });
  });
});

describe('a module load / initialisation failure becomes typed JSON (the production defect)', () => {
  it('NC-X1: statically importing the renderer while `playwright` cannot be loaded rejects at import (the old route died here)', async () => {
    vi.doMock('playwright', () => {
      throw new Error("Cannot find module 'playwright-9b51c99ca474dcf1'");
    });
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }));
    await expect(import('@/lib/services/reportPdfRenderer')).rejects.toThrow();
  });

  it('NC-X2: the real route + real loader + real renderer module answer typed 503 renderer_unavailable', async () => {
    installMocks({ rendererModule: 'real' });
    vi.doMock('playwright', () => {
      throw new Error("Cannot find module 'playwright-9b51c99ca474dcf1'");
    });
    const res = await post();
    expect(res.status).toBe(503);
    const body = await typed(res);
    expect(body).toMatchObject({ code: 'EXPORT_RENDER_FAILED', detail: 'renderer_unavailable' });
    expect(JSON.stringify(body)).not.toContain('playwright-9b51');
    expect(world.updates.some((u) => u.status === 'failed' && u.error_code === 'renderer_unavailable')).toBe(true);
  });

  it('importing the route itself never touches `playwright` (it is not in the route load path)', async () => {
    let touched = false;
    vi.doMock('playwright', () => {
      touched = true;
      throw new Error('should not be loaded');
    });
    installMocks({ rendererModule: 'real' });
    await import('@/app/api/reports/[id]/exports/route');
    expect(touched).toBe(false);
  });
});

describe('pure helpers', () => {
  it('classifyRenderFailure', () => {
    expect(classifyRenderFailure(new ReportExportError('token_failed', 'x'))).toBe('token_failed');
    const timeout = new Error('page.goto: Timeout 30000ms exceeded.');
    timeout.name = 'TimeoutError';
    expect(classifyRenderFailure(timeout)).toBe('render_timeout');
    expect(classifyRenderFailure(new Error("Executable doesn't exist at /x"))).toBe('renderer_unavailable');
    expect(classifyRenderFailure(new Error('error while loading shared libraries: libnss3.so'))).toBe('renderer_unavailable');
    expect(classifyRenderFailure(new Error("Cannot find module 'playwright-abc'"))).toBe('renderer_unavailable');
    expect(classifyRenderFailure(new Error('Print route returned 404'))).toBe('render_failed');
    expect(classifyRenderFailure('weird')).toBe('render_failed');
  });

  it('withExportDeadline settles with the work when it is fast and rejects render_timeout when it is not', async () => {
    await expect(withExportDeadline(Promise.resolve(7), 50)).resolves.toBe(7);
    await expect(withExportDeadline(new Promise(() => {}), 20)).rejects.toMatchObject({ step: 'render_timeout' });
  });
});

describe('browser side: what the PO sees', () => {
  const asResponse = (status: number, text: string) => new Response(text, { status });

  it('the production answer (500, the 21-byte plain text) reads as an actionable message with Print offered', async () => {
    const read = await readApiResponse(asResponse(500, 'Internal Server Error'));
    expect('Internal Server Error'.length).toBe(21);
    const view = describeExportFailure(read);
    expect(view.message).toMatch(/PDF export is temporarily unavailable/);
    expect(view.message).toMatch(/Print/);
    expect(view.message).toContain('HTTP_500');
    expect(view.message).not.toMatch(/could not read/);
    expect(view.offerPrint).toBe(true);
  });

  it('an empty body is the same actionable message', async () => {
    const view = describeExportFailure(await readApiResponse(asResponse(500, '')));
    expect(view.message).toMatch(/temporarily unavailable/);
    expect(view.offerPrint).toBe(true);
  });

  it('a typed answer shows its sentence with code, reason and reference', async () => {
    const json = JSON.stringify({ error: 'PDF export is temporarily unavailable. You can still view this report and use Print, then choose Save as PDF.', code: 'EXPORT_RENDER_FAILED', correlationId: 'rpt-abc123', retryable: false, detail: 'renderer_unavailable' });
    const view = describeExportFailure(await readApiResponse(asResponse(503, json)));
    expect(view.message).toContain('EXPORT_RENDER_FAILED');
    expect(view.message).toContain('renderer_unavailable');
    expect(view.message).toContain('reference rpt-abc123');
    expect(view.offerPrint).toBe(true);
  });

  it('a Premium refusal keeps its own message', async () => {
    const json = JSON.stringify({ error: 'Exporting reports requires a premium plan. You can still view and print this report.', code: 'EXPORT_PREMIUM_REQUIRED', correlationId: 'rpt-x', retryable: false, detail: 'entitlement' });
    const view = describeExportFailure(await readApiResponse(asResponse(403, json)));
    expect(view.message).toBe('Exporting reports requires a premium plan. You can still view and print this report.');
  });

  it('a signed-out answer does not offer print', async () => {
    const view = describeExportFailure(await readApiResponse(asResponse(401, JSON.stringify({ error: 'unauthenticated' }))));
    expect(view.offerPrint).toBe(false);
  });
});

describe('Consolidated Forecasting Report export (same defect class, same fix)', () => {
  it('a renderer that cannot be loaded is typed JSON 503 renderer_unavailable, not a platform 500', async () => {
    vi.doMock('@/lib/api', async (orig) => ({ ...(await orig<object>()), requireCountryConfirmedUser: async () => ({ user: { id: 'user-1' }, unauthenticated: null }) }));
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
    vi.doMock('@/lib/services/entitlements', () => ({ canExportReports: async () => true }));
    vi.doMock('@/lib/services/forecastReportPdfRenderer', () => {
      throw new Error("Cannot find module 'playwright-9b51c99ca474dcf1'");
    });
    const { GET } = await import('@/app/api/forecast/report/export/route');
    const res = await GET(new Request('http://t/api/forecast/report/export'));
    expect(res.status).toBe(503);
    const body = await typed(res);
    expect(body).toMatchObject({ code: 'EXPORT_RENDER_FAILED', detail: 'renderer_unavailable' });
    expect(body.error).toMatch(/Print/);
  });
});
