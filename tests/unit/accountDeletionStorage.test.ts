// LR-9 WP-09 — Storage purge routines. Exercises purgeAllUserStorage()
// against a fake storage client mimicking Supabase Storage's .list()/
// .remove() shape.
//
// CORRECTED MOCK SEMANTICS (2026-09-10 — real live-DEV LR-9 finding, see
// docs/live-recovery/LR9_STORAGE_PURGE_FOLDER_DISCRIMINATOR_FIX.md). This
// file's own original fixtures had the folder/object `id` discriminator
// BACKWARDS (gave folder-placeholder entries a truthy `id`, matching the
// equally-backwards production code at the time) — so this suite passed
// while testing the wrong behaviour end-to-end. Empirically confirmed
// against a REAL Supabase Storage bucket: a folder placeholder entry
// (e.g. a `documentId` directory) comes back with `id: null`; a real,
// deletable object comes back with a real UUID `id`. Every fixture below
// now matches that real shape.
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
  it('purges a flat bucket (investment-source-documents) and nested buckets (report-exports, fdh-source-documents) correctly', async () => {
    currentFake = makeFakeStorage({
      'investment-source-documents': {
        [USER_ID]: [
          { id: 'obj-1', name: 'doc1.pdf' },
          { id: 'obj-2', name: 'doc2.pdf' },
        ],
      },
      // Real Supabase Storage semantics: the per-document "folder" listing
      // entry carries `id: null` (it is a virtual placeholder, not a real
      // object) — only the file ONE LEVEL DEEPER has a real id.
      'report-exports': {
        [USER_ID]: [{ id: null, name: 'report-1' }],
        [`${USER_ID}/report-1`]: [{ id: 'export-1', name: 'export-1.pdf' }],
      },
      'fdh-source-documents': {
        [USER_ID]: [{ id: null, name: 'doc-abc' }],
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

  it('REGRESSION (the exact bug this test suite originally missed): a real folder (id: null) containing a real file is found and deleted, not silently skipped', async () => {
    currentFake = makeFakeStorage({
      'fdh-source-documents': {
        [USER_ID]: [{ id: null, name: 'genuine-document-folder' }],
        [`${USER_ID}/genuine-document-folder`]: [{ id: 'a-real-object-id', name: 'genuine-document-folder.bin' }],
      },
    });
    vi.resetModules();
    const { purgeAllUserStorage } = await import('@/lib/services/accountDeletionStorage');

    const results = await purgeAllUserStorage(USER_ID);
    const fdh = results.find((r) => r.bucket === 'fdh-source-documents')!;

    expect(fdh.objectsFound).toBe(1);
    expect(fdh.objectsDeleted).toBe(1);
    expect(currentFake.removed['fdh-source-documents']).toEqual([`${USER_ID}/genuine-document-folder/genuine-document-folder.bin`]);
  });

  it('an unexpected flat file sitting directly at the top level (defensive case, no known writer produces this) is still found and deleted', async () => {
    currentFake = makeFakeStorage({
      'report-exports': {
        [USER_ID]: [{ id: 'unexpected-flat-object-id', name: 'unexpected-flat-file.pdf' }],
      },
    });
    vi.resetModules();
    const { purgeAllUserStorage } = await import('@/lib/services/accountDeletionStorage');

    const results = await purgeAllUserStorage(USER_ID);
    const reportExports = results.find((r) => r.bucket === 'report-exports')!;

    expect(reportExports.objectsFound).toBe(1);
    expect(currentFake.removed['report-exports']).toEqual([`${USER_ID}/unexpected-flat-file.pdf`]);
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

  it('a genuinely empty folder placeholder (id: null, nothing inside) purges to zero for that folder, with no error', async () => {
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
