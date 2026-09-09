// LR-8 WP-07/NEG-07 ("download caches private report publicly") — the
// download route previously used Response.redirect(), which sets only
// Location/status. A per-user financial-report redirect must carry
// Cache-Control: private, no-store so a shared/intermediate cache never
// retains it. Exercises the real route handler.
import { describe, it, expect, vi } from 'vitest';

const USER_ID = 'download-cache-user';
const EXPORT_ID = 'export-1';

const { requireUserMock } = vi.hoisted(() => ({
  requireUserMock: vi.fn(() => ({ user: { id: USER_ID }, unauthenticated: null })),
}));
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, requireUser: () => requireUserMock(), requireCountryConfirmedUser: () => requireUserMock() };
});

const exportRow = {
  id: EXPORT_ID,
  report_id: 'report-1',
  status: 'ready',
  storage_path: `${USER_ID}/report-1/${EXPORT_ID}.pdf`,
  expires_at: null,
  download_count: 0,
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            single: async () => ({ data: exportRow, error: null }),
          }),
        }),
      }),
    }),
  }),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    storage: {
      from: () => ({
        createSignedUrl: async () => ({ data: { signedUrl: 'https://storage.example/signed-url' }, error: null }),
      }),
    },
    from: () => ({
      update: () => ({ eq: async () => ({ data: null, error: null }) }),
      insert: async () => ({ data: null, error: null }),
    }),
  }),
}));

describe('GET /api/report-exports/[exportId]/download', () => {
  it('redirects to the signed URL with Cache-Control: private, no-store', async () => {
    const { GET } = await import('@/app/api/report-exports/[exportId]/download/route');
    const res = await GET(new Request('http://x'), { params: Promise.resolve({ exportId: EXPORT_ID }) });
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://storage.example/signed-url');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });
});
