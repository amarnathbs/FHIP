// LR-9 WP-09/WP-10 — pure orchestration-order tests. Mocks both
// purgeAllUserStorage and the admin client's auth.admin.deleteUser so this
// exercises the REAL executeAccountDeletion() function's control flow
// (order of operations, error propagation) without touching a live
// Supabase project — see tests/unit/accountDeletionExecuteRoute.test.ts for
// the route-level state-machine tests, and the LR-9 phase report for why a
// full live-DEV execution against a real account was deliberately not
// performed this phase.
import { describe, it, expect, vi } from 'vitest';

const { purgeMock, deleteUserMock } = vi.hoisted(() => ({
  purgeMock: vi.fn(),
  deleteUserMock: vi.fn(),
}));

vi.mock('@/lib/services/accountDeletionStorage', () => ({ purgeAllUserStorage: purgeMock }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ auth: { admin: { deleteUser: deleteUserMock } } }),
}));

import { executeAccountDeletion } from '@/lib/services/accountDeletionOrchestration';

const USER_ID = 'orchestration-user';

describe('executeAccountDeletion', () => {
  it('NEG-06 — purges Storage BEFORE calling auth.admin.deleteUser (storage purge never depends on the auth row surviving)', async () => {
    const callOrder: string[] = [];
    purgeMock.mockImplementation(async () => {
      callOrder.push('purge');
      return [{ bucket: 'fdh-source-documents', objectsFound: 0, objectsDeleted: 0, error: null }];
    });
    deleteUserMock.mockImplementation(async () => {
      callOrder.push('deleteUser');
      return { error: null };
    });

    const result = await executeAccountDeletion(USER_ID);

    expect(callOrder).toEqual(['purge', 'deleteUser']);
    expect(deleteUserMock).toHaveBeenCalledWith(USER_ID);
    expect(result.success).toBe(true);
    expect(result.authDeleteError).toBeNull();
  });

  it('NEG-05 — a storage-purge failure does not block auth.admin.deleteUser (the account still gets deleted; the failure is reported, not hidden)', async () => {
    purgeMock.mockResolvedValue([
      { bucket: 'investment-source-documents', objectsFound: 2, objectsDeleted: 0, error: 'storage unavailable' },
    ]);
    deleteUserMock.mockResolvedValue({ error: null });

    const result = await executeAccountDeletion(USER_ID);

    expect(deleteUserMock).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.storageResults[0].error).toBe('storage unavailable');
  });

  it('reports failure when auth.admin.deleteUser itself fails, and still returns whatever storage results were gathered', async () => {
    purgeMock.mockResolvedValue([{ bucket: 'report-exports', objectsFound: 1, objectsDeleted: 1, error: null }]);
    deleteUserMock.mockResolvedValue({ error: { message: 'user not found' } });

    const result = await executeAccountDeletion(USER_ID);

    expect(result.success).toBe(false);
    expect(result.authDeleteError).toBe('user not found');
    expect(result.storageResults).toHaveLength(1);
  });
});
