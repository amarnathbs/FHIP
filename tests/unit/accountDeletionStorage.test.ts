// LR-9 WP-09 — Storage purge routines. Exercises purgeAllUserStorage()
// against a fake storage client mimicking Supabase Storage's .list()/
// .remove() shape, including the folder-vs-object `id` discriminator this
// mirrors from the already-certified FDH-3 orphan-report reference
// (lib/financial-data-hub/services/storage.ts's listObjectsUnderUserPrefix —
// an entry with no `id` is a folder placeholder, not a real object).
import { describe, it, expect, vi } from 'vitest';

const USER_ID = 'storage-purge-user';

interface FakeEntry {
  id: string | null;
  name: string;
}

function makeFakeStorage(buckets: Record<string, Record<string, FakeEntry[]>>) {
  const removed: Record<string, string[]> = {};
  return {
    client: {
      storage: {
        from(bucket: string) {
          return {
            list: async (path: string) => ({ data: buckets[bucket]?.[path] ?? [], error: null }),
            remove: async (keys: string[]) => {
              removed[bucket] = [...(removed[bucket] ?? []), ...keys];
              return { data: null, error: null };
            },
          };
        },
      },
    },
    removed,
  };
}

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => currentFake.client }));

// Reassigned per-test via a module-level indirection so each test can supply
// its own fake bucket layout without re-mocking.
let currentFake: ReturnType<typeof makeFakeStorage>;

describe('purgeAllUserStorage', () => {
  it('purges a flat bucket (investment-source-documents) and a nested bucket (report-exports, fdh-source-documents) correctly', async () => {
    currentFake = makeFakeStorage({
      'investment-source-documents': {
        [USER_ID]: [
          { id: 'obj-1', name: 'doc1.pdf' },
          { id: 'obj-2', name: 'doc2.pdf' },
        ],
      },
      // Per-document "folder" listing entries carry a truthy `id` in this
      // bucket shape (matching the already-certified FDH-3 orphan-report
      // reference this mirrors) — only entries with NO id at all are the
      // true empty-folder placeholders skipped below.
      'report-exports': {
        [USER_ID]: [{ id: 'folder-marker-1', name: 'report-1' }],
        [`${USER_ID}/report-1`]: [{ id: 'export-1', name: 'export-1.pdf' }],
      },
      'fdh-source-documents': {
        [USER_ID]: [{ id: 'folder-marker-2', name: 'doc-abc' }],
        [`${USER_ID}/doc-abc`]: [{ id: 'file-1', name: 'doc-abc.bin' }],
      },
    });
    vi.resetModules();
    const { purgeAllUserStorage } = await import('@/lib/services/accountDeletionStorage');

    const results = await purgeAllUserStorage(USER_ID);

    const byBucket = Object.fromEntries(results.map((r) => [r.bucket, r]));
    expect(byBucket['investment-source-documents']).toEqual({
      bucket: 'investment-source-documents',
      objectsFound: 2,
      objectsDeleted: 2,
      error: null,
    });
    expect(byBucket['report-exports']).toEqual({ bucket: 'report-exports', objectsFound: 1, objectsDeleted: 1, error: null });
    expect(byBucket['fdh-source-documents']).toEqual({ bucket: 'fdh-source-documents', objectsFound: 1, objectsDeleted: 1, error: null });

    expect(currentFake.removed['investment-source-documents']).toEqual([`${USER_ID}/doc1.pdf`, `${USER_ID}/doc2.pdf`]);
    expect(currentFake.removed['report-exports']).toEqual([`${USER_ID}/report-1/export-1.pdf`]);
    expect(currentFake.removed['fdh-source-documents']).toEqual([`${USER_ID}/doc-abc/doc-abc.bin`]);
  });

  it('a user with no files anywhere purges cleanly to zero, with no error', async () => {
    currentFake = makeFakeStorage({});
    vi.resetModules();
    const { purgeAllUserStorage } = await import('@/lib/services/accountDeletionStorage');

    const results = await purgeAllUserStorage(USER_ID);
    for (const r of results) {
      expect(r).toMatchObject({ objectsFound: 0, objectsDeleted: 0, error: null });
    }
  });

  it('a folder-placeholder entry (no id) is never mistaken for a deletable object', async () => {
    currentFake = makeFakeStorage({
      'report-exports': {
        [USER_ID]: [{ id: null, name: 'phantom-folder' }],
        [`${USER_ID}/phantom-folder`]: [], // empty — nothing inside
      },
    });
    vi.resetModules();
    const { purgeAllUserStorage } = await import('@/lib/services/accountDeletionStorage');

    const results = await purgeAllUserStorage(USER_ID);
    const reportExports = results.find((r) => r.bucket === 'report-exports')!;
    expect(reportExports.objectsFound).toBe(0);
    expect(currentFake.removed['report-exports']).toBeUndefined();
  });
});
