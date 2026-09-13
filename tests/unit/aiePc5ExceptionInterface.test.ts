/**
 * AIE-1 closure mission (section 11) — unit coverage for the capability
 * gate itself (the part of `pc5ExceptionInterface.ts` this suite can prove
 * without a database: a denied capability check must short-circuit before
 * any AIE table is ever touched). The tenant-scoped read/resolve behaviour
 * underneath (`listOpenUnresolvedItemsForUser`/`decideOnItem`) is proven
 * against REAL DEV infrastructure separately — see
 * `scripts/aiecl_pc5_interface_live_dev_check.mjs` and
 * `docs/aie-programme/AIE_1_CLOSURE_PC5_INTERFACE_REPORT.md` — since PC5
 * itself does not exist to integrate with end-to-end, but the AIE-side
 * tables this interface reads/writes already do, so a real check is both
 * possible and more meaningful than another layer of mocks here.
 */
import { describe, it, expect, vi } from 'vitest';
import { listUnresolvedItemsForPc5, resolveUnresolvedItemForPc5 } from '@/lib/aie/pc5/pc5ExceptionInterface';

vi.mock('@/lib/aie/db/repository', () => ({
  listOpenUnresolvedItemsForUser: vi.fn(async () => {
    throw new Error('DB must never be touched when capability is denied');
  }),
}));
vi.mock('@/lib/aie/review/decide', () => ({
  decideOnItem: vi.fn(async () => {
    throw new Error('DB must never be touched when capability is denied');
  }),
}));

describe('PC5 exception interface — capability gate', () => {
  it('listUnresolvedItemsForPc5 refuses and never queries the DB when capability is denied', async () => {
    const result = await listUnresolvedItemsForPc5('pc5-caller-1', 'target-user-1', { checkCapability: async () => false });
    expect(result).toEqual({ ok: false, reason: 'capability_denied' });
  });

  it('resolveUnresolvedItemForPc5 refuses and never calls decideOnItem when capability is denied', async () => {
    const result = await resolveUnresolvedItemForPc5(
      { callerId: 'pc5-caller-1', targetUserId: 'target-user-1', itemId: 'item-1', action: 'defer', itemVersion: 1, idempotencyKey: 'k1' },
      { checkCapability: async () => false },
    );
    expect(result).toEqual({ ok: false, reason: 'capability_denied' });
  });

  it('the capability check receives the real caller and target ids, never swapped or omitted', async () => {
    const checkCapability = vi.fn(async () => false);
    await listUnresolvedItemsForPc5('caller-x', 'target-y', { checkCapability });
    expect(checkCapability).toHaveBeenCalledWith('caller-x', 'target-y');
  });
});
