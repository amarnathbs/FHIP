// FDH-3's listObjectsUnderUserPrefix() -- previously had ZERO dedicated test
// coverage anywhere (confirmed by search before this file was added). Fixed
// alongside lib/services/accountDeletionStorage.ts's own copy of the same
// folder/object `id` discriminator bug -- see
// docs/live-recovery/LR9_STORAGE_PURGE_FOLDER_DISCRIMINATOR_FIX.md for the
// full record of the real live-DEV finding that caught it. This function
// has no caller anywhere in the codebase today (its intended consumer,
// scripts/fdh3_orphan_storage_report.mjs, was never built) but is fixed and
// tested here so the same discriminator mistake can't be copied a third
// time.
import { describe, it, expect, vi } from 'vitest';

const USER_ID = 'orphan-check-user';

interface FakeEntry {
  id: string | null;
  name: string;
}

function makeFakeStorage(entries: Record<string, FakeEntry[]>) {
  return {
    storage: {
      from: () => ({
        list: async (path: string) => ({ data: entries[path] ?? [], error: null }),
      }),
    },
  };
}

let currentFake: ReturnType<typeof makeFakeStorage>;
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => currentFake }));

describe('listObjectsUnderUserPrefix', () => {
  it('finds a real object inside a real folder placeholder (id: null) -- the exact case the original inverted discriminator missed', async () => {
    currentFake = makeFakeStorage({
      [USER_ID]: [{ id: null, name: 'doc-1' }],
      [`${USER_ID}/doc-1`]: [{ id: 'real-object-id', name: 'doc-1.bin' }],
    });
    vi.resetModules();
    const { listObjectsUnderUserPrefix } = await import('@/lib/financial-data-hub/services/storage');

    const keys = await listObjectsUnderUserPrefix(USER_ID);
    expect(keys).toEqual([`${USER_ID}/doc-1/doc-1.bin`]);
  });

  it('finds objects across multiple document folders', async () => {
    currentFake = makeFakeStorage({
      [USER_ID]: [{ id: null, name: 'doc-1' }, { id: null, name: 'doc-2' }],
      [`${USER_ID}/doc-1`]: [{ id: 'obj-1', name: 'doc-1.bin' }],
      [`${USER_ID}/doc-2`]: [{ id: 'obj-2', name: 'doc-2.bin' }],
    });
    vi.resetModules();
    const { listObjectsUnderUserPrefix } = await import('@/lib/financial-data-hub/services/storage');

    const keys = await listObjectsUnderUserPrefix(USER_ID);
    expect(keys.sort()).toEqual([`${USER_ID}/doc-1/doc-1.bin`, `${USER_ID}/doc-2/doc-2.bin`]);
  });

  it('a genuinely empty folder placeholder returns nothing for it', async () => {
    currentFake = makeFakeStorage({
      [USER_ID]: [{ id: null, name: 'empty-folder' }],
      [`${USER_ID}/empty-folder`]: [],
    });
    vi.resetModules();
    const { listObjectsUnderUserPrefix } = await import('@/lib/financial-data-hub/services/storage');

    expect(await listObjectsUnderUserPrefix(USER_ID)).toEqual([]);
  });

  it('a user with no files at all returns an empty array', async () => {
    currentFake = makeFakeStorage({});
    vi.resetModules();
    const { listObjectsUnderUserPrefix } = await import('@/lib/financial-data-hub/services/storage');

    expect(await listObjectsUnderUserPrefix(USER_ID)).toEqual([]);
  });

  it('an unexpected flat file at the top level (defensive case) is still returned', async () => {
    currentFake = makeFakeStorage({
      [USER_ID]: [{ id: 'flat-object-id', name: 'unexpected-flat.bin' }],
    });
    vi.resetModules();
    const { listObjectsUnderUserPrefix } = await import('@/lib/financial-data-hub/services/storage');

    expect(await listObjectsUnderUserPrefix(USER_ID)).toEqual([`${USER_ID}/unexpected-flat.bin`]);
  });
});
