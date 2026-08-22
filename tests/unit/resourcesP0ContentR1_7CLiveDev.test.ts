// R1.7C — P0 Content Certification & CMS Load. Live-DEV integration test
// against the real DEV Supabase project (vqycarelcoijzwlpkpcz), read-only.
// Confirms the actual database state left by the real apply matches the
// spec's publication-safety and no-duplication requirements. Mirrors the
// live-DEV testing pattern established by resourcesImportR1_7LiveDev.test.ts
// (real ground-truth verification via a service-role read, not just "the
// query returned 0 rows").

import { describe, it, expect, beforeAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';

function loadEnv(): Record<string, string> {
  const text = readFileSync('.env.local', 'utf-8');
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const env = loadEnv();
const DEV_PROJECT_REF = 'vqycarelcoijzwlpkpcz';

let admin: SupabaseClient;

beforeAll(() => {
  const match = /^https:\/\/([a-z0-9]+)\.supabase\.co/.exec(env.NEXT_PUBLIC_SUPABASE_URL ?? '');
  const ref = match ? match[1] : '';
  if (ref !== DEV_PROJECT_REF) {
    throw new Error(`Refusing to run live-DEV tests: NEXT_PUBLIC_SUPABASE_URL resolves to "${ref}", not the confirmed DEV project "${DEV_PROJECT_REF}".`);
  }
  admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
});

const EXPECTED_84 = [
  'FH-001', 'FH-002', 'FH-003', 'FH-004', 'FH-005', 'FH-006',
  'MM-001', 'MM-002', 'MM-003', 'MM-004', 'ER-001', 'ER-002',
  'ER-003', 'ER-004', 'DB-001', 'DB-002', 'DB-003', 'DB-004',
  'NW-001', 'NW-002', 'NW-003', 'NW-004', 'GL-001', 'GL-002',
  'GL-003', 'IN-001', 'IN-002', 'IN-003', 'IN-004', 'IN-005',
  'RAU-001', 'RAU-002', 'RAU-003', 'RIN-001', 'RIN-002', 'RIN-003',
  'IP-001', 'IP-002', 'DN-001', 'FC-001', 'FC-002', 'FC-003',
  'CB-001', 'CB-002', 'SB-001', 'SB-002', 'SB-003', 'EX-001',
  'EX-002', 'EX-003', 'EX-004', 'EX-005', 'EX-006', 'EX-007',
  'EX-008', 'EX-009', 'EX-010', 'EX-011', 'EX-012', 'EX-025',
  'EX-026', 'VID-001', 'VID-002', 'VID-003', 'VID-004', 'VID-005',
  'VID-006', 'VID-007', 'VID-008', 'GLO-001', 'GLO-002', 'GLO-003',
  'GLO-004', 'GLO-005', 'GLO-006', 'GLO-007', 'GLO-008', 'GLO-009',
  'GLO-010', 'GLO-011', 'GLO-012', 'GLO-013', 'GLO-014', 'GLO-015',
];

describe('R1.7C live DEV -- post-load state', () => {
  it('all 84 P0 Content IDs exist exactly once, with substantive content_blocks', async () => {
    const { data, error } = await admin.from('resource_posts').select('content_id,content_blocks').in('content_id', EXPECTED_84);
    expect(error).toBeNull();
    expect(data?.length).toBe(84);
    const ids = (data ?? []).map((r) => r.content_id as string);
    expect(new Set(ids).size).toBe(84);
    for (const row of data ?? []) {
      expect(Array.isArray(row.content_blocks)).toBe(true);
      expect((row.content_blocks as unknown[]).length).toBeGreaterThan(0);
    }
  });

  // R1.7D-FINAL recorded the authorised human editorial and compliance
  // decisions, so the 84 are no longer all `draft`: 76 are now `approved`
  // and the 8 video scripts deliberately remain `draft` until a real @GKTC
  // video exists. The status expectation is updated to that authorised set.
  //
  // The security half of this assertion is NOT relaxed — it is the whole
  // point of the R1.7D-FINAL gate that approval must never imply publication,
  // so private / unpublished / non-indexable are still asserted for all 84.
  it('all 84 remain private/non-indexable/unpublished, in an authorised non-published status', async () => {
    const { data, error } = await admin.from('resource_posts').select('content_id,status,visibility,published_at,is_indexable').in('content_id', EXPECTED_84);
    expect(error).toBeNull();
    for (const row of data ?? []) {
      expect(['draft', 'approved'], `${row.content_id} status`).toContain(row.status);
      expect(row.visibility, `${row.content_id} visibility`).toBe('private');
      expect(row.published_at, `${row.content_id} published_at`).toBeNull();
      expect(row.is_indexable, `${row.content_id} is_indexable`).not.toBe(true);
    }
  });

  it('zero authors were invented for the 84', async () => {
    const { data } = await admin.from('resource_posts').select('content_id,author_id').in('content_id', EXPECTED_84);
    for (const row of data ?? []) expect(row.author_id, `${row.content_id} has a non-null author_id`).toBeNull();
  });

  it('zero resource_videos rows exist for the 8 P0 video posts (no fabricated YouTube metadata)', async () => {
    const videoIds = ['VID-001', 'VID-002', 'VID-003', 'VID-004', 'VID-005', 'VID-006', 'VID-007', 'VID-008'];
    const { data: posts } = await admin.from('resource_posts').select('id,content_id').in('content_id', videoIds);
    const postIds = (posts ?? []).map((p) => p.id as string);
    const { count } = await admin.from('resource_videos').select('*', { count: 'exact', head: true }).in('resource_post_id', postIds);
    expect(count).toBe(0);
  });

  it('the loader source is structurally update-only against resource_posts (never insert/upsert)', () => {
    // Static invariant check, not a DB query -- so it cannot be racy against
    // other concurrent live-DEV tests. Combined with the exact-84
    // .in(EXPECTED_84) match in the test above (which is mathematically
    // impossible to satisfy with a stray extra/duplicate row for those
    // specific ids), this is the real "zero new inserts" proof. A global
    // resource_posts table-total assertion was deliberately NOT used here:
    // other live-DEV test files (e.g. resourcesImportR1_7LiveDev.test.ts,
    // resourcesAdminR1_2.test.ts) create/delete their own disposable
    // fixtures concurrently, making a global count inherently racy and not
    // a meaningful R1.7C signal either way.
    const loaderSource = readFileSync('scripts/resources/p0-content/load-p0-content.ts', 'utf-8');
    expect(loaderSource).toMatch(/\.from\('resource_posts'\)\s*\n?\s*\.update\(/);
    expect(loaderSource).not.toMatch(/\.from\('resource_posts'\)[\s\S]{0,80}\.(insert|upsert)\(/);
  });
});
