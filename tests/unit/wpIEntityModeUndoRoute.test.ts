// Document2 (4) WP-I, entity mode switch Undo: the route and the plain wording. EVIDENCE LABEL: UNIT-TESTED (the real route handler with the database call
// replaced by a recording double; the database half is PGLITE-VERIFIED in wpIEntityModeUndoPglite.test.ts).
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';

const { userMock, rpcMock } = vi.hoisted(() => ({ userMock: vi.fn(), rpcMock: vi.fn() }));
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, requireCountryConfirmedUser: async () => userMock() };
});
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ rpc: rpcMock }) }));

import { EntityModeChooser, entityUndoMessage } from '@/components/entities/EntityModeChooser';

const post = (body?: unknown) => new Request('http://x', { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe('POST /api/business-entities/[id]/undo-switch', () => {
  it('unauthenticated: the gate answers and the database is never called', async () => {
    rpcMock.mockReset();
    userMock.mockReturnValue({ user: null, unauthenticated: Response.json({ error: 'unauthenticated' }, { status: 401 }) });
    const { POST } = await import('@/app/api/business-entities/[id]/undo-switch/route');
    const res = await POST(post({ confirm: true }), params('e1'));
    expect(res.status).toBe(401);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('is PREVIEW-FIRST: no body, or confirm false, asks the database for a preview only', async () => {
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({ data: { status: 'preview' }, error: null });
    userMock.mockReturnValue({ user: { id: 'u1' }, unauthenticated: null });
    const { POST } = await import('@/app/api/business-entities/[id]/undo-switch/route');
    expect((await POST(post(), params('e1'))).status).toBe(200);
    expect(rpcMock).toHaveBeenLastCalledWith('business_entity_undo_last_switch', { p_entity_id: 'e1', p_confirm: false });
    await POST(post({ confirm: false }), params('e1'));
    expect(rpcMock).toHaveBeenLastCalledWith('business_entity_undo_last_switch', { p_entity_id: 'e1', p_confirm: false });
  });

  it('applies only on an explicit confirm true, for the entity in the path', async () => {
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({ data: { status: 'applied' }, error: null });
    userMock.mockReturnValue({ user: { id: 'u1' }, unauthenticated: null });
    const { POST } = await import('@/app/api/business-entities/[id]/undo-switch/route');
    const res = await POST(post({ confirm: true }), params('e9'));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ status: 'applied' });
    expect(rpcMock).toHaveBeenCalledWith('business_entity_undo_last_switch', { p_entity_id: 'e9', p_confirm: true });
  });

  it('maps the database answers: another household or nothing to undo, in plain words and without the internal prefix', async () => {
    userMock.mockReturnValue({ user: { id: 'u1' }, unauthenticated: null });
    const { POST } = await import('@/app/api/business-entities/[id]/undo-switch/route');
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({ data: null, error: { code: 'P0002', message: 'entity: not found' } });
    const notFound = await POST(post({ confirm: true }), params('e1'));
    expect(notFound.status).toBe(404);
    expect((await notFound.json()).error).toBe('not found');
    rpcMock.mockResolvedValue({ data: null, error: { code: '55000', message: 'entity: the most recent change to this entity cannot be undone here (nothing to undo, or something else was recorded after the last switch)' } });
    const nothing = await POST(post({ confirm: true }), params('e1'));
    expect(nothing.status).toBe(409);
    expect((await nothing.json()).error).toMatch(/^the most recent change to this entity cannot be undone here/);
  });
});

describe('the wording and the screen', () => {
  it('back to net value only: says lines are archived not deleted, kept in the history, and only the net value is counted', () => {
    const m = entityUndoMessage({ to_mode: 'summary', net_before: 360_000, net_after: 250_000, will_archive: { assets: 2, liabilities: 1 } }, 'AUD');
    expect(m).toContain('net value only');
    expect(m).toContain('2 assets and 1 liability are archived, not deleted');
    expect(m).toContain('$360,000');
    expect(m).toContain('$250,000');
    expect(m).toMatch(/Only the net value is counted/);
  });
  it('back to itemised: says the earlier lines return, the typed net is kept in the history, and only the itemised figures are counted', () => {
    const m = entityUndoMessage({ to_mode: 'detailed', net_before: 650_000, net_after: 600_000, will_restore: { assets: 1, liabilities: 1 } }, 'AUD');
    expect(m).toContain('itemised assets and liabilities');
    expect(m).toContain('1 asset and 1 liability that you had before are brought back');
    expect(m).toMatch(/only the itemised figures are counted/);
  });
  it('the chooser offers no Undo until the history says there is a switch to undo (no cosmetic button)', () => {
    const html = renderToStaticMarkup(React.createElement(EntityModeChooser, { entityId: 'e1', mode: 'detailed', currency: 'AUD', onChanged: () => undefined }));
    expect(html).not.toContain('entity-undo-switch');
    expect(html).toContain('How do you want to record this entity?');
  });
});
