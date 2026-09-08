// LR-8 WP-09/NEG-02 ("premium route accessible free") — before this phase,
// GET /api/forecast/report/export never checked entitlement at all: any
// authenticated, country-confirmed user (Free or Premium) could download
// the Consolidated Forecasting Report PDF, unlike the sibling Monthly
// report's export route (app/api/reports/[id]/exports/route.ts), which has
// always required canExportReports(). This exercises the real route
// handler (not a reimplementation) with the real canExportReports()
// running against a fake user_entitlements table.
import { describe, it, expect, vi } from 'vitest';

const USER_ID = 'forecast-export-user';

const { requireUserMock } = vi.hoisted(() => ({
  requireUserMock: vi.fn(() => ({ user: { id: USER_ID }, unauthenticated: null })),
}));
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, requireUser: () => requireUserMock(), requireCountryConfirmedUser: () => requireUserMock() };
});

const { renderMock } = vi.hoisted(() => ({
  renderMock: vi.fn(async () => Buffer.from('%PDF-fake')),
}));
vi.mock('@/lib/services/forecastReportPdfRenderer', () => ({ renderForecastReportToPdf: renderMock }));

function makeFakeSupabase(planTier: 'free' | 'premium' | null) {
  return {
    from(table: string) {
      if (table === 'user_entitlements') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: planTier ? { plan_tier: planTier } : null, error: null }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table in this test: ${table}`);
    },
  };
}

describe('GET /api/forecast/report/export', () => {
  it('NEG-02 — a Free-plan user is refused with 403 and no PDF is ever rendered', async () => {
    vi.resetModules();
    renderMock.mockClear();
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => makeFakeSupabase('free') }));
    const { GET } = await import('@/app/api/forecast/report/export/route');
    const res = await GET(new Request('http://x/api/forecast/report/export'));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/premium plan/i);
    expect(renderMock).not.toHaveBeenCalled();
  });

  it('a user with no entitlement row at all defaults to free and is refused (fail-closed, not fail-open)', async () => {
    vi.resetModules();
    renderMock.mockClear();
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => makeFakeSupabase(null) }));
    const { GET } = await import('@/app/api/forecast/report/export/route');
    const res = await GET(new Request('http://x/api/forecast/report/export'));
    expect(res.status).toBe(403);
    expect(renderMock).not.toHaveBeenCalled();
  });

  it('a Premium-plan user succeeds, receives the rendered PDF, a labelled filename and a private/no-store cache header', async () => {
    vi.resetModules();
    renderMock.mockClear();
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => makeFakeSupabase('premium') }));
    const { GET } = await import('@/app/api/forecast/report/export/route');
    const res = await GET(new Request('http://x/api/forecast/report/export?scenario=Conservative Plan'));
    expect(res.status).toBe(200);
    expect(renderMock).toHaveBeenCalledWith(USER_ID, 'Conservative Plan');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const disposition = res.headers.get('Content-Disposition') ?? '';
    expect(disposition).toMatch(/^attachment; filename="consolidated-forecast-report-conservative-plan-\d{4}-\d{2}-\d{2}\.pdf"$/);
  });
});
