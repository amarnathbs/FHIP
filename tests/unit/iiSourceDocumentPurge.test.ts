// Investment Intelligence — raw source-document storage purge (2026-09-19).
//
// deleteSourceDocumentObject() existed since R1 but had zero callers
// anywhere in the application (confirmed by a repo-wide search) — every
// raw statement PDF ever uploaded through this pipeline was retained
// indefinitely. This tests the actual fix: purgeSourceDocumentStorage(),
// which documentProcessing.ts now calls once a document finishes parsing
// successfully.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const deleteSourceDocumentObject = vi.fn();
const verifySourceDocumentObjectAbsent = vi.fn();
vi.mock('@/lib/services/investment-intelligence/storage', () => ({
  deleteSourceDocumentObject: (...args: unknown[]) => deleteSourceDocumentObject(...args),
  verifySourceDocumentObjectAbsent: (...args: unknown[]) => verifySourceDocumentObjectAbsent(...args),
}));

import { purgeSourceDocumentStorage } from '@/lib/services/investment-intelligence/sourceDocumentPurge';

const DOC_ID = 'doc-1';
const STORAGE_PATH = 'user-1/statement.pdf';

function makeFakeAdmin() {
  const updates: Array<{ table: string; patch: Record<string, unknown>; id: string }> = [];
  return {
    updates,
    admin: {
      from(table: string) {
        return {
          update(patch: Record<string, unknown>) {
            return {
              eq(_col: string, id: string) {
                updates.push({ table, patch, id });
                return Promise.resolve({ error: null });
              },
            };
          },
        };
      },
    },
  };
}

beforeEach(() => {
  deleteSourceDocumentObject.mockReset();
  verifySourceDocumentObjectAbsent.mockReset();
});

describe('purgeSourceDocumentStorage', () => {
  it('marks the document purged when delete succeeds and absence is independently confirmed', async () => {
    deleteSourceDocumentObject.mockResolvedValue({ error: null });
    verifySourceDocumentObjectAbsent.mockResolvedValue(true);
    const { admin, updates } = makeFakeAdmin();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await purgeSourceDocumentStorage(admin as any, DOC_ID, STORAGE_PATH);

    expect(deleteSourceDocumentObject).toHaveBeenCalledWith(STORAGE_PATH);
    expect(verifySourceDocumentObjectAbsent).toHaveBeenCalledWith(STORAGE_PATH);
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe('ii_source_documents');
    expect(updates[0].id).toBe(DOC_ID);
    expect(updates[0].patch.storage_purged_at).toEqual(expect.any(String));
    expect(updates[0].patch.storage_purge_error).toBeNull();
  });

  it('records a purge error and does NOT mark purged when the delete call itself errors', async () => {
    deleteSourceDocumentObject.mockResolvedValue({ error: 'storage provider unavailable' });
    const { admin, updates } = makeFakeAdmin();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await purgeSourceDocumentStorage(admin as any, DOC_ID, STORAGE_PATH);

    expect(verifySourceDocumentObjectAbsent).not.toHaveBeenCalled();
    expect(updates).toHaveLength(1);
    expect(updates[0].patch.storage_purge_error).toBe('storage provider unavailable');
    expect(updates[0].patch.storage_purged_at).toBeUndefined();
  });

  it('never trusts a "no error" delete response alone — records a purge error if the object is still listable', async () => {
    // The exact scenario this two-step check exists for: the delete call
    // itself reports success, but an independent listing still finds the
    // object.
    deleteSourceDocumentObject.mockResolvedValue({ error: null });
    verifySourceDocumentObjectAbsent.mockResolvedValue(false);
    const { admin, updates } = makeFakeAdmin();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await purgeSourceDocumentStorage(admin as any, DOC_ID, STORAGE_PATH);

    expect(updates).toHaveLength(1);
    expect(updates[0].patch.storage_purge_error).toMatch(/still listable/i);
    expect(updates[0].patch.storage_purged_at).toBeUndefined();
  });

  it('never throws — a purge failure must never fail the parse request that already succeeded', async () => {
    deleteSourceDocumentObject.mockRejectedValue(new Error('network blip'));
    const { admin, updates } = makeFakeAdmin();

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      purgeSourceDocumentStorage(admin as any, DOC_ID, STORAGE_PATH)
    ).resolves.toBeUndefined();

    expect(updates).toHaveLength(1);
    expect(updates[0].patch.storage_purge_error).toBe('network blip');
  });
});
