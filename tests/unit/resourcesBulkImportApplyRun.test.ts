// applyRun (lib/resources/import/staging.ts): the server calls the service-role-only twin with the SESSION-VERIFIED actor;
// falls back to the signed-in function only when the twin does not exist yet (migration 0273 pending).
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { applyRun } from '@/lib/resources/import/staging';

function clients(twin: { data?: unknown; error?: { code?: string; message: string } | null }, signedIn?: { data?: unknown; error?: { code?: string; message: string } | null }) {
  const adminRpc = vi.fn(async () => ({ data: twin.data ?? null, error: twin.error ?? null }));
  const userRpc = vi.fn(async () => ({ data: signedIn?.data ?? null, error: signedIn?.error ?? null }));
  const updates: unknown[] = [];
  const admin = {
    rpc: adminRpc,
    from: () => ({ update: (v: unknown) => ({ eq: () => ({ neq: async () => (updates.push(v), { error: null }) }) }), insert: async () => ({ error: null }) }),
  };
  return { admin: admin as never, user: { rpc: userRpc } as never, adminRpc, userRpc, updates };
}
const OK = { data: { ok: true, already_applied: false, created: 3, post_ids: ['a', 'b', 'c'], run_id: 'r' } };

describe('applyRun', () => {
  it('calls the twin through the SERVER client with exactly the run id and the verified actor; never the signed-in client', async () => {
    const c = clients(OK);
    const r = await applyRun(c.user, c.admin, 'run-1', 'user-1');
    expect(r).toMatchObject({ ok: true, created: 3, alreadyApplied: false });
    expect(c.adminRpc).toHaveBeenCalledWith('apply_resource_content_import_as_actor', { p_run_id: 'run-1', p_actor: 'user-1' });
    expect(c.userRpc).not.toHaveBeenCalled();
  });

  it('falls back to the signed-in function ONLY when the twin does not exist (0273 not applied yet)', async () => {
    const missing = { error: { code: 'PGRST202', message: 'Could not find the function public.apply_resource_content_import_as_actor' } };
    const c = clients(missing, OK);
    expect((await applyRun(c.user, c.admin, 'run-1', 'user-1')).ok).toBe(true);
    expect(c.userRpc).toHaveBeenCalledWith('apply_resource_content_import', { p_run_id: 'run-1' });
  });

  it('does NOT fall back on any other failure: a FORBIDDEN or STALE_PREVIEW from the twin is final', async () => {
    for (const [message, code, status] of [['FORBIDDEN: only the person who uploaded this file can apply it', 'FORBIDDEN', 403], ['STALE_PREVIEW: the slug in row 2 now exists', 'STALE_PREVIEW', 409], ['APPLY_FAILED: the database refused the import (code 23514)', 'APPLY_FAILED', 500]] as const) {
      const c = clients({ error: { code: 'P0001', message } }, OK);
      const r = await applyRun(c.user, c.admin, 'run-1', 'user-1');
      expect(r).toMatchObject({ ok: false, code, status });
      expect(c.userRpc).not.toHaveBeenCalled();
    }
  });

  it('records a stale run so history shows it, and never leaks the database message', async () => {
    const c = clients({ error: { code: 'P0001', message: 'STALE_PREVIEW: the slug in row 2 now exists' } });
    const r = await applyRun(c.user, c.admin, 'run-1', 'user-1');
    expect(c.updates[0]).toMatchObject({ status: 'stale', failure_code: 'STALE_PREVIEW' });
    expect(JSON.stringify(r)).not.toContain('row 2');
  });

  it('the actor can only come from the route\'s verified session: the apply route passes g.user.id and never reads the request', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../app/api/admin/resources/import/runs/[id]/apply/route.ts'), 'utf8');
    expect(src).toContain('applyRun(g.supabase, createAdminClient(), id, g.user.id)');
    expect(src).not.toMatch(/_?request\.(json|formData|text)\(|searchParams|headers\.get/);
  });
});
