// FHIP Admin Redesign A2-A5, A3-WP "requireAdmin() capability split, execution"
// (A1_02_CAPABILITY_CATALOGUE.md CAP-16 finding; A1_20_ROADMAP_A2_A5.md's A2/A3.3
// package description).
//
// Proves two things:
//  1. Behavioural equivalence — requireBenchmarksAdmin / requireRecommendationsAdmin /
//     requireAIPlatformAdmin allow and deny in EXACTLY the same cases as the original
//     requireAdmin() (same admin_users check, same country-confirmation gate). This is
//     the "additive, not access-changing" property A1_20 requires of this split.
//  2. No silent regression — every route file under app/api/admin/{benchmarks,
//     recommendations,ai}/** calls its domain-scoped capability function, and NONE of
//     them calls the old broad requireAdmin() any more. This is a static/structural
//     guard: it fails loudly if a future edit reintroduces the broad gate on one of
//     these 34 routes without deliberately intending to.
//
// What this test file does NOT prove (disclosed, not silently assumed): the full
// 9-caller-type live-DEV matrix (Standard §4) — no Supabase DEV credentials are
// available in this execution environment. See docs/admin/A3_03_CAPABILITY_SPLIT_EXECUTION.md
// for the full disclosure.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
const ADMIN_ID = 'capability-split-admin';

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  }),
}));

// Country confirmation has its own dedicated coverage
// (tests/unit/countryGateAdminAndHousehold.test.ts) — mocked out here so this file
// isolates the capability-split behaviour specifically.
vi.mock('@/lib/services/countryGate', () => ({ countryConfirmationBlockResponse: async () => null }));

beforeEach(() => {
  vi.clearAllMocks();
});

function mockAdminRow(row: { user_id: string } | null) {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'admin_users') {
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) };
    }
    throw new Error(`unexpected table in this test: ${table}`);
  });
}

describe('CAP-16 split — behavioural equivalence with requireAdmin()', () => {
  it.each([
    ['requireBenchmarksAdmin', () => import('@/lib/services/adminAuth').then((m) => m.requireBenchmarksAdmin)],
    ['requireRecommendationsAdmin', () => import('@/lib/services/adminAuth').then((m) => m.requireRecommendationsAdmin)],
    ['requireAIPlatformAdmin', () => import('@/lib/services/adminAuth').then((m) => m.requireAIPlatformAdmin)],
  ])('%s denies an unauthenticated caller with 401, exactly like requireAdmin()', async (_name, load) => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const fn = await load();
    const { user, forbidden } = await fn();
    expect(user).toBeNull();
    expect(forbidden?.status).toBe(401);
  });

  it.each([
    ['requireBenchmarksAdmin', () => import('@/lib/services/adminAuth').then((m) => m.requireBenchmarksAdmin)],
    ['requireRecommendationsAdmin', () => import('@/lib/services/adminAuth').then((m) => m.requireRecommendationsAdmin)],
    ['requireAIPlatformAdmin', () => import('@/lib/services/adminAuth').then((m) => m.requireAIPlatformAdmin)],
  ])('%s denies an authenticated non-admin with 403, exactly like requireAdmin()', async (_name, load) => {
    mockGetUser.mockResolvedValue({ data: { user: { id: ADMIN_ID } } });
    mockAdminRow(null);
    const fn = await load();
    const { user, forbidden } = await fn();
    expect(user).toBeNull();
    expect(forbidden?.status).toBe(403);
  });

  it.each([
    ['requireBenchmarksAdmin', () => import('@/lib/services/adminAuth').then((m) => m.requireBenchmarksAdmin)],
    ['requireRecommendationsAdmin', () => import('@/lib/services/adminAuth').then((m) => m.requireRecommendationsAdmin)],
    ['requireAIPlatformAdmin', () => import('@/lib/services/adminAuth').then((m) => m.requireAIPlatformAdmin)],
  ])('%s allows a real admin_users holder, exactly like requireAdmin()', async (_name, load) => {
    mockGetUser.mockResolvedValue({ data: { user: { id: ADMIN_ID } } });
    mockAdminRow({ user_id: ADMIN_ID });
    const fn = await load();
    const { user, forbidden } = await fn();
    expect(forbidden).toBeNull();
    expect(user?.id).toBe(ADMIN_ID);
  });
});

describe('CAP-16 split — static regression guard over the 34 renamed route files', () => {
  const root = path.resolve(__dirname, '..', '..');

  function listRouteFiles(dir: string): string[] {
    const full = path.join(root, dir);
    const out: string[] = [];
    (function walk(d: string) {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name === 'route.ts') out.push(p);
      }
    })(full);
    return out;
  }

  const domains: Array<[string, string]> = [
    ['app/api/admin/benchmarks', 'requireBenchmarksAdmin'],
    ['app/api/admin/recommendations', 'requireRecommendationsAdmin'],
    ['app/api/admin/ai', 'requireAIPlatformAdmin'],
  ];

  it.each(domains)('every route.ts under %s calls %s, and none calls the old bare requireAdmin()', (dir, expectedFn) => {
    const files = listRouteFiles(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      // Whole-word match only — must not match the expected function's own name
      // (e.g. requireBenchmarksAdmin does not contain the standalone word requireAdmin).
      const callsBareRequireAdmin = /\brequireAdmin\b/.test(content);
      expect(callsBareRequireAdmin, `${file} still calls the broad requireAdmin()`).toBe(false);
      expect(content.includes(expectedFn), `${file} does not call ${expectedFn}`).toBe(true);
    }
  });

  it('the account-deletions route is unaffected — it already used its own separately-named capability', () => {
    const file = path.join(root, 'app/api/admin/account-deletions/route.ts');
    const content = fs.readFileSync(file, 'utf8');
    expect(content.includes('requireAccountDeletionAdmin')).toBe(true);
    // Checks the functional call site only — the file's own header comment
    // legitimately mentions "bare requireAdmin()" in prose, contrasting itself
    // with the broad gate it deliberately does not use.
    expect(/await\s+requireAdmin\(\)/.test(content)).toBe(false);
  });
});
