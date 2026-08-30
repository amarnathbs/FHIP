// Admin A0.2 Wave 2 (Scope A) — reorderRelatedContent() unit tests.
//
// The transactional guarantee itself is a DATABASE property and is certified
// against a real PostgreSQL instance in
// scripts/admin_a02_wave2_certification.mjs (SECTIONS 1-6): defect
// reproduction, rollback, complete-set validation, locking and grants. What
// these tests cover is the TypeScript half that the certification script
// cannot reach — that the wrapper invokes the RPC with exactly the right
// parameters, and that it classifies each of the function's deliberate
// SQLSTATEs into the right failure kind without ever passing a raw SQL error
// back to the caller.
import { describe, it, expect, vi } from 'vitest';
import { reorderRelatedContent, MAX_RELATED_REORDER_ITEMS } from '@/lib/resources/discovery/relatedAdmin';
import type { SupabaseClient } from '@supabase/supabase-js';

function clientReturning(response: { data?: unknown; error?: { code?: string; message?: string } | null }) {
  const rpc = vi.fn().mockResolvedValue({ data: response.data ?? null, error: response.error ?? null });
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

const COMMITTED = {
  source_post_id: '11111111-1111-4111-8111-111111111111',
  count: 2,
  ordered: [
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sort_order: 0 },
    { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', sort_order: 1 },
  ],
};

describe('reorderRelatedContent — RPC invocation', () => {
  it('calls admin_reorder_related_content with the source id and the ordered ids, and nothing else', async () => {
    const { client, rpc } = clientReturning({ data: COMMITTED });
    await reorderRelatedContent(client, COMMITTED.source_post_id, ['a', 'b']);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('admin_reorder_related_content', {
      p_source_post_id: COMMITTED.source_post_id,
      p_ordered_ids: ['a', 'b'],
    });
  });

  it('makes exactly ONE database call — the whole point of the fix (the old path made N)', async () => {
    const { client, rpc } = clientReturning({ data: COMMITTED });
    await reorderRelatedContent(client, COMMITTED.source_post_id, Array.from({ length: 25 }, (_, i) => `id-${i}`));
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('returns the COMMITTED ordering the database read back, not the request', async () => {
    const { client } = clientReturning({ data: COMMITTED });
    const res = await reorderRelatedContent(client, COMMITTED.source_post_id, ['b', 'a']);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual(COMMITTED);
  });
});

describe('reorderRelatedContent — SQLSTATE classification', () => {
  it('maps 22023 (invalid payload) to kind "invalid"', async () => {
    const { client } = clientReturning({ error: { code: '22023', message: 'admin_reorder_related_content: the ordered list contains a duplicate relationship id.' } });
    const res = await reorderRelatedContent(client, 'src', ['a']);
    expect(res).toEqual({ ok: false, kind: 'invalid', message: 'the ordered list contains a duplicate relationship id.' });
  });

  it('maps P0002 (unknown source) to kind "not_found"', async () => {
    const { client } = clientReturning({ error: { code: 'P0002', message: 'admin_reorder_related_content: Resource x not found.' } });
    const res = await reorderRelatedContent(client, 'src', ['a']);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe('not_found');
  });

  it('maps 40001 (stale set) to kind "conflict"', async () => {
    const { client } = clientReturning({ error: { code: '40001', message: 'admin_reorder_related_content: the related items have changed since this list was loaded (1 of 4 supplied ids are not current links of this Resource).' } });
    const res = await reorderRelatedContent(client, 'src', ['a']);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe('conflict');
  });

  it('strips the function-name prefix so the administrator sees a clean sentence', async () => {
    const { client } = clientReturning({ error: { code: '22023', message: 'admin_reorder_related_content: too many related items in one request (101 supplied, maximum 100).' } });
    const res = await reorderRelatedContent(client, 'src', ['a']);
    if (!res.ok) expect(res.message).toBe('too many related items in one request (101 supplied, maximum 100).');
  });
});

describe('reorderRelatedContent — unexpected errors are never leaked', () => {
  it.each([
    ['23514', 'new row for relation "resource_related_content" violates check constraint "resource_related_content_sort_order_check"'],
    ['42501', 'permission denied for function admin_reorder_related_content'],
    ['42883', 'function public.admin_reorder_related_content(uuid, uuid[]) does not exist'],
    ['08006', 'connection failure'],
    [undefined, 'TypeError: fetch failed'],
  ])('SQLSTATE %s is classified "error" with a generic message', async (code, message) => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = clientReturning({ error: { code: code as string | undefined, message } });
    const res = await reorderRelatedContent(client, 'src', ['a']);
    expect(res).toEqual({ ok: false, kind: 'error', message: 'Could not reorder related content.' });
    // The raw detail must reach the server log, and only the server log.
    expect(spy).toHaveBeenCalled();
    expect(res.ok === false && res.message).not.toMatch(/constraint|permission denied|does not exist|fetch failed/i);
    spy.mockRestore();
  });
});

describe('MAX_RELATED_REORDER_ITEMS', () => {
  it('mirrors the cap the database function enforces, so the API rejects an oversized payload before the round trip', () => {
    expect(MAX_RELATED_REORDER_ITEMS).toBe(100);
  });
});
