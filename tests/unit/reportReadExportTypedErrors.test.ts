/**
 * The report read and export routes answer with typed JSON, never an empty body (16-10-2026).
 *
 * NAMED NEGATIVE CONTROLS
 *   NC-R1  before: a throw inside getReport / the PDF renderer escaped the handler (platform 500, empty body, which the
 *          browser reports as "Unexpected end of JSON input"). The tests make those collaborators throw and require JSON.
 *   NC-R2  recording the "viewed" event failing must not stop the report being read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getReport = vi.fn();
const recordAccessEvent = vi.fn();
const renderReportToPdf = vi.fn();
const insertedExports: unknown[] = [];

vi.mock('@/lib/api', async (orig) => ({ ...(await orig<object>()), requireCountryConfirmedUser: async () => ({ user: { id: 'user-1' }, unauthenticated: null }) }));
vi.mock('@/lib/services/reportsData', () => ({
  getReport: (...a: unknown[]) => getReport(...a),
  recordAccessEvent: (...a: unknown[]) => recordAccessEvent(...a),
  archiveReport: vi.fn(),
}));
vi.mock('@/lib/services/reportPdfRenderer', () => ({ renderReportToPdf: (...a: unknown[]) => renderReportToPdf(...a) }));
vi.mock('@/lib/services/entitlements', () => ({ canExportReports: async () => true }));
const chain = (result: unknown) => {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'insert', 'update']) c[m] = () => c;
  c.maybeSingle = async () => ({ data: result, error: null });
  c.single = async () => ({ data: { id: 'exp-1', status: 'generating' }, error: null });
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
  return c;
};
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ from: () => chain({ id: 'r1' }) }) }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({ ...chain(null), insert: (row: unknown) => { insertedExports.push(row); return chain(null); } }),
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
  }),
}));

import { GET as reportGET } from '@/app/api/reports/[id]/route';
import { GET as sectionsGET } from '@/app/api/reports/[id]/sections/route';
import { POST as exportPOST } from '@/app/api/reports/[id]/exports/route';

const ctx = { params: Promise.resolve({ id: 'r1' }) };

beforeEach(() => {
  vi.clearAllMocks();
  insertedExports.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

async function parsed(res: Response) {
  const text = await res.text();
  expect(text.length).toBeGreaterThan(0); // never an empty body
  return JSON.parse(text);
}

describe('report read routes', () => {
  it('NC-R1: a throw while reading the report is a typed, retryable 500 with a reference', async () => {
    getReport.mockRejectedValue(new Error('connection reset by peer'));
    const res = await reportGET(new Request('http://t/x'), ctx);
    expect(res.status).toBe(500);
    const body = await parsed(res);
    expect(body).toMatchObject({ code: 'REPORT_READ_FAILED', retryable: true });
    expect(body.correlationId).toMatch(/^rpt-/);
    expect(JSON.stringify(body)).not.toContain('connection reset');
  });

  it('a missing report is a typed 404', async () => {
    getReport.mockResolvedValue(null);
    const res = await reportGET(new Request('http://t/x'), ctx);
    expect(res.status).toBe(404);
    expect(await parsed(res)).toMatchObject({ code: 'REPORT_NOT_FOUND', retryable: false });
  });

  it('NC-R2: a failing "viewed" event does not stop the report being returned', async () => {
    getReport.mockResolvedValue({ report: { id: 'r1' }, sections: [] });
    recordAccessEvent.mockRejectedValue(new Error('insert failed'));
    const res = await reportGET(new Request('http://t/x'), ctx);
    expect(res.status).toBe(200);
    expect((await parsed(res)).data.report.id).toBe('r1');
  });

  it('the sections route is typed on failure too', async () => {
    getReport.mockRejectedValue(new Error('boom'));
    const res = await sectionsGET(new Request('http://t/x'), ctx);
    expect(res.status).toBe(500);
    expect(await parsed(res)).toMatchObject({ code: 'REPORT_READ_FAILED' });
  });
});

describe('export route', () => {
  const post = () => exportPOST(new Request('http://t/x', { method: 'POST', body: JSON.stringify({ format: 'pdf' }) }), ctx);

  it('NC-R1: a renderer that throws is a typed 500 naming the cause for support, and the browser can still print', async () => {
    renderReportToPdf.mockRejectedValue(new Error('Executable doesn\'t exist at /var/task/chromium'));
    const res = await post();
    expect(res.status).toBe(500);
    const body = await parsed(res);
    expect(body).toMatchObject({ code: 'EXPORT_RENDER_FAILED', retryable: true });
    expect(body.error).toMatch(/view and print/);
    expect(body.detail).toContain('Executable');
    expect(body.correlationId).toMatch(/^rpt-/);
  });

  it('an unexpected throw anywhere in the handler is still typed JSON', async () => {
    const bad = exportPOST(new Request('http://t/x', { method: 'POST', body: JSON.stringify({ format: 'pdf' }) }), { params: Promise.reject(new Error('params gone')) });
    const res = await bad;
    expect(res.status).toBe(500);
    expect(await parsed(res)).toMatchObject({ code: 'EXPORT_FAILED' });
  });
});
