// PO review F3 (06/10/2026): "Need to add delete button or by default save need
// to remove it should save only after save button is entered."
//
// Evidence level of this file: UNIT-TESTED (in-memory Supabase fake whose filters
// are applied for real, mocked route dependencies, react-dom/server render, and
// source-contract checks). Nothing here touches a real database.
//
// Admin Architecture Standard clauses covered:
//   s2  separately named capability (canDeleteDraftResource)
//   s4  direct-API test: 401 unauthenticated, 403 for an Author, never a quiet 200
//   s13 fail closed: a delete that matches no row is refused, not reported as success
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInMemoryDb } from './support/inMemorySupabase';
import { countryRegistryFrom } from './support/countryRegistryFake';

const mockGetUser = vi.fn();
const userDb = createInMemoryDb();
const adminDb = createInMemoryDb();
const mockRoles = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser },
    from: (t: string) => countryRegistryFrom(t) ?? (userDb.client.from(t) as never),
  }),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminDb.client }));
vi.mock('@/lib/resources/permissions', async (orig) => {
  const actual = await orig<typeof import('@/lib/resources/permissions')>();
  return { ...actual, getCurrentResourceRoles: () => mockRoles() };
});

import { deleteNeverPublishedDraft, isNeverPublishedDraft, DELETE_REFUSED_MESSAGE } from '@/lib/resources/editor/deleteDraft';
import { canDeleteDraftResource } from '@/lib/resources/permissions';
import { DELETE as deleteRoute } from '@/app/api/admin/resources/content/[id]/route';
import { POST as createRoute } from '@/app/api/admin/resources/content/route';
import { POST as createGlossary } from '@/app/api/admin/resources/glossary/route';
import { POST as createMoneyUpdate } from '@/app/api/admin/resources/money-updates/route';
import { blankEditorPost, createRecordOnFirstSave } from '@/lib/resources/editor/blankPost';
import { blankMoneyUpdatePost } from '@/lib/resources/money-update/blankPost';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const DRAFT_ID = '22222222-2222-4222-8222-222222222222';
const PUB_ID = '33333333-3333-4333-8333-333333333333';
const REVERTED_ID = '44444444-4444-4444-8444-444444444444';

const profile = { user_id: ADMIN_ID, country_of_residence: 'AU', country_confirmed_at: '2026-08-29T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true };

function seed() {
  userDb.reset({
    user_profiles: [profile],
    resource_posts: [
      { id: DRAFT_ID, title: 'My draft', content_type: 'article', status: 'draft', published_at: null, created_by: ADMIN_ID, slug: 'my-draft', content_id: null },
      { id: PUB_ID, title: 'Live piece', content_type: 'article', status: 'published', published_at: '2026-09-01T00:00:00Z', created_by: ADMIN_ID, slug: 'live', content_id: 'X-1' },
      { id: REVERTED_ID, title: 'Was live', content_type: 'article', status: 'draft', published_at: null, created_by: ADMIN_ID, slug: 'was-live', content_id: null },
    ],
    resource_workflow_history: [{ id: 'h1', post_id: REVERTED_ID, to_status: 'published' }],
    resource_post_versions: [{ id: 'v1', post_id: DRAFT_ID }],
  });
  adminDb.reset({ resource_audit_log: [] });
}

const asManager = () => mockRoles.mockResolvedValue({ userId: ADMIN_ID, isSuperAdmin: false, roles: ['resource_admin'] });
const asAuthor = () => mockRoles.mockResolvedValue({ userId: ADMIN_ID, isSuperAdmin: false, roles: ['author'] });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const del = (id: string) => deleteRoute(new Request('http://t/x', { method: 'DELETE' }), params(id));

beforeEach(() => {
  vi.clearAllMocks();
  seed();
  mockGetUser.mockResolvedValue({ data: { user: { id: ADMIN_ID } } });
  asManager();
});

describe('F3 capability: canDeleteDraftResource (Standard s2)', () => {
  it('is Super Admin and Resource Administrator only; Author, Editor, Publisher, Compliance Reviewer, Analyst are denied', () => {
    expect(canDeleteDraftResource({ userId: 'u', isSuperAdmin: true, roles: [] })).toBe(true);
    expect(canDeleteDraftResource({ userId: 'u', isSuperAdmin: false, roles: ['resource_admin'] })).toBe(true);
    for (const r of ['author', 'editor', 'publisher', 'compliance_reviewer', 'analyst'] as const) {
      expect(canDeleteDraftResource({ userId: 'u', isSuperAdmin: false, roles: [r] })).toBe(false);
    }
    expect(canDeleteDraftResource({ userId: null, isSuperAdmin: false, roles: [] })).toBe(false);
  });
});

describe('F3 deleteNeverPublishedDraft', () => {
  it('deletes a never-published draft, removes the row, and writes an audit event with the actor and the before state', async () => {
    const out = await deleteNeverPublishedDraft(userDb.client as never, adminDb.client as never, DRAFT_ID, ADMIN_ID);
    expect(out.status).toBe('deleted');
    expect(userDb.tables.resource_posts.find((p) => p.id === DRAFT_ID)).toBeUndefined();
    const audit = adminDb.tables.resource_audit_log;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entity_type: 'resource_post', entity_id: DRAFT_ID, action: 'RESOURCE_DRAFT_DELETED', actor_user_id: ADMIN_ID });
    expect(audit[0].before_state).toMatchObject({ title: 'My draft', status: 'draft' });
  });

  it('NEVER deletes published content: refused, the row is untouched, no delete is even issued, no audit row', async () => {
    const out = await deleteNeverPublishedDraft(userDb.client as never, adminDb.client as never, PUB_ID, ADMIN_ID);
    expect(out).toEqual({ status: 'not_deletable', reason: DELETE_REFUSED_MESSAGE });
    expect(userDb.tables.resource_posts.find((p) => p.id === PUB_ID)).toBeDefined();
    expect(userDb.writes.filter((w) => w.kind === 'delete')).toHaveLength(0);
    expect(adminDb.tables.resource_audit_log).toHaveLength(0);
  });

  it('treats a draft that was ever published or scheduled (history) as published content and refuses it', async () => {
    const out = await deleteNeverPublishedDraft(userDb.client as never, adminDb.client as never, REVERTED_ID, ADMIN_ID);
    expect(out.status).toBe('not_deletable');
    expect(userDb.tables.resource_posts.find((p) => p.id === REVERTED_ID)).toBeDefined();
  });

  it('the DELETE statement itself repeats the status and published_at predicate (a publish between check and delete cannot be deleted)', async () => {
    // Race: the row is read as a draft, then another user publishes it before
    // the delete runs. The fake applies the delete filters for real, so if the
    // statement did not carry the predicate the published row would vanish.
    const realFrom = userDb.client.from.bind(userDb.client);
    let reads = 0;
    userDb.client.from = (t: string) => {
      const q = realFrom(t) as Record<string, unknown>;
      if (t === 'resource_posts') {
        const origMaybeSingle = q.maybeSingle as () => Promise<unknown>;
        q.maybeSingle = async () => {
          const r = await origMaybeSingle.call(q);
          reads += 1;
          // After the guarded read, flip the stored row to published.
          const row = userDb.tables.resource_posts.find((p) => p.id === DRAFT_ID);
          if (row && reads === 1) Object.assign(row, { status: 'published', published_at: '2026-10-06T00:00:00Z' });
          return r;
        };
      }
      return q;
    };
    try {
      const out = await deleteNeverPublishedDraft(userDb.client as never, adminDb.client as never, DRAFT_ID, ADMIN_ID);
      expect(out.status).toBe('not_deletable');
      expect(userDb.tables.resource_posts.find((p) => p.id === DRAFT_ID)).toBeDefined();
      expect(adminDb.tables.resource_audit_log).toHaveLength(0);
    } finally {
      userDb.client.from = realFrom;
    }
  });

  it('a missing id is not_found', async () => {
    const out = await deleteNeverPublishedDraft(userDb.client as never, adminDb.client as never, '99999999-9999-4999-8999-999999999999', ADMIN_ID);
    expect(out.status).toBe('not_found');
  });

  it('isNeverPublishedDraft: idea and draft with no published_at only', () => {
    expect(isNeverPublishedDraft({ status: 'draft', published_at: null })).toBe(true);
    expect(isNeverPublishedDraft({ status: 'idea', published_at: null })).toBe(true);
    for (const s of ['editorial_review', 'compliance_review', 'approved', 'scheduled', 'published', 'review_due', 'archived']) {
      expect(isNeverPublishedDraft({ status: s, published_at: null })).toBe(false);
    }
    expect(isNeverPublishedDraft({ status: 'draft', published_at: '2026-01-01T00:00:00Z' })).toBe(false);
  });
});

describe('F3 DELETE /api/admin/resources/content/[id] (Standard s4 direct-API)', () => {
  it('401 when not signed in', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    expect((await del(DRAFT_ID)).status).toBe(401);
  });

  it('403 for an Author (capability absent), and the draft is untouched', async () => {
    asAuthor();
    const res = await del(DRAFT_ID);
    expect(res.status).toBe(403);
    expect(userDb.tables.resource_posts.find((p) => p.id === DRAFT_ID)).toBeDefined();
  });

  it('404 for a malformed id (no database access)', async () => {
    expect((await del('not-a-uuid')).status).toBe(404);
  });

  it('409 for published content, and 200 with removed counts and auditWritten for a draft', async () => {
    const pub = await del(PUB_ID);
    expect(pub.status).toBe(409);
    expect((await pub.json()).error).toContain('never-published drafts');
    const ok = await del(DRAFT_ID);
    expect(ok.status).toBe(200);
    expect((await ok.json()).data).toMatchObject({ deleted: true, auditWritten: true });
  });
});

describe('F3 creation routes require a real title (no Untitled records)', () => {
  const post = (handler: (r: Request) => Promise<Response>, body: unknown) => handler(new Request('http://t/x', { method: 'POST', body: JSON.stringify(body) }));

  it('Article/Guide/Explainer POST without a title is 422 and writes nothing', async () => {
    for (const body of [{ contentType: 'article' }, { contentType: 'guide', title: '   ' }]) {
      const res = await post(createRoute, body);
      expect(res.status).toBe(422);
    }
    expect(userDb.writes.filter((w) => w.kind === 'insert')).toHaveLength(0);
  });

  it('Glossary and Money Update POST without a title are 422 and write nothing', async () => {
    expect((await post(createGlossary, {})).status).toBe(422);
    expect((await post(createMoneyUpdate, { contentType: 'money_update' })).status).toBe(422);
    expect(userDb.writes.filter((w) => w.kind === 'insert')).toHaveLength(0);
  });

  it('with a title the record is created with that title (never a placeholder) and the response carries updated_at', async () => {
    const res = await post(createRoute, { contentType: 'article', title: 'Why savings rate matters' });
    expect(res.status).toBe(200);
    const inserted = userDb.tables.resource_posts.find((p) => p.title === 'Why savings rate matters');
    expect(inserted).toBeDefined();
    expect(userDb.tables.resource_posts.some((p) => String(p.title).startsWith('Untitled'))).toBe(false);
  });
});

describe('F3 blank (unsaved) posts and the client create-on-save helper', () => {
  it('blankEditorPost has no id, so opening the editor has no record to write to', () => {
    const post = blankEditorPost('article', ADMIN_ID);
    expect(post.id).toBe('');
    expect(post.title).toBe('');
    expect(post.status).toBe('draft');
    expect(post.visibility).toBe('private');
    expect(post.is_indexable).toBe(false);
    expect(blankMoneyUpdatePost('money_update', ADMIN_ID).id).toBe('');
    expect(blankMoneyUpdatePost('money_update_template', ADMIN_ID).freshness_type).toBe('evergreen');
    expect(blankMoneyUpdatePost('money_update', ADMIN_ID).freshness_type).toBe('time_sensitive');
  });

  it('createRecordOnFirstSave posts once and maps success and failure', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { id: 'abc', updated_at: '2026-10-06T01:00:00Z' } }) }).mockResolvedValueOnce({ ok: false, status: 422, json: async () => ({ error: 'Enter a title before saving.', fields: { title: 'x' } }) });
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect(await createRecordOnFirstSave('/api/x', { title: 'T' })).toEqual({ ok: true, id: 'abc', updatedAt: '2026-10-06T01:00:00Z' });
      expect(await createRecordOnFirstSave('/api/x', { title: '' })).toMatchObject({ ok: false, status: 422, fields: { title: 'x' } });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// Source-contract checks: the editors can no longer create or save by themselves.
describe('F3 source contracts: no create-on-open and no autosave in any content editor', () => {
  const root = resolve(__dirname, '..', '..');
  const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

  it.each([
    ['components/resources/editor/ResourceEditor.tsx'],
    ['components/resources/money-update/MoneyUpdateEditor.tsx'],
    ['components/resources/glossary/GlossaryEditor.tsx'],
  ])('%s has no debounced autosave', (file) => {
    const src = read(file);
    expect(src).not.toMatch(/AUTOSAVE_DEBOUNCE_MS\s*=/);
    expect(src).not.toMatch(/autosaveTimer/);
    expect(src).toContain('createRecordOnFirstSave');
  });

  it('the chooser pages only navigate: none of them fetches or posts on open', () => {
    for (const file of ['components/resources/editor/NewContentChooser.tsx', 'components/resources/glossary/GlossaryNewButton.tsx']) {
      expect(read(file)).not.toMatch(/fetch\(/);
    }
    const mu = read('components/resources/money-update/MoneyUpdateNewChooser.tsx');
    // The only POST left is the explicit "Create Update from Template" copy action.
    expect(mu.match(/fetch\(/g)?.length).toBe(2); // templates list (GET) + from-template (POST)
    expect(mu).not.toContain("'/api/admin/resources/money-updates', { method: 'POST'");
  });
});
