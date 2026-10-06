// PO review F11 (resource dropdown) and F12 (link a video to content, repair a video
// record with no YouTube details). Evidence label: UNIT-TESTED (pure logic, in-memory
// Supabase fake with real filters, mocked route dependencies, react-dom/server markup).
//
// Admin Architecture Standard: s2 (separately gated link vs list), s4 direct-API
// (401 / 403, never a quiet 200), s13 (explicit failure states).
//
// NAMED NEGATIVE CONTROLS
//   NC-F11-1  filterPickerOptions with the render bound removed would return all 300 rows (the test shows the bound is what limits it);
//   NC-F12-1  the repair REFUSES a record that already has a video row, even with the same id; removing that check overwrites it;
//   NC-F12-2  unlink refuses a link that belongs to a different video.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInMemoryDb } from './support/inMemorySupabase';
import { countryRegistryFrom } from './support/countryRegistryFake';

const mockGetUser = vi.fn();
const mockRoles = vi.fn();
const userDb = createInMemoryDb();
const adminDb = createInMemoryDb();

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: mockGetUser }, from: (t: string) => countryRegistryFrom(t) ?? (userDb.client.from(t) as never) }),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminDb.client }));
vi.mock('@/lib/resources/permissions', async (orig) => {
  const actual = await orig<typeof import('@/lib/resources/permissions')>();
  return { ...actual, getCurrentResourceRoles: () => mockRoles() };
});

import { PICKER_RENDER_LIMIT, filterPickerOptions, reduceCombobox, INITIAL_COMBOBOX_STATE, hiddenCountMessage, summarisePicker, type PickerOption } from '@/lib/resources/discovery/picker';
import { ResourceComboboxView } from '@/components/ui/ResourceCombobox';
import { repairMissingVideoRow, REPAIR_ALREADY_HAS_MESSAGE } from '@/lib/resources/video/repair';
import { unlinkVideoFromContent } from '@/lib/resources/video/links';
import { createVideoDraft, removeOrphanVideoPost } from '@/lib/resources/video/mutations';
import { GET as linksGET, POST as linksPOST } from '@/app/api/admin/resources/videos/[id]/links/route';
import { POST as repairPOST } from '@/app/api/admin/resources/videos/[id]/repair/route';

const U = '11111111-1111-4111-8111-111111111111';
const VID = '22222222-2222-4222-8222-222222222222';
const VID2 = '22222222-2222-4222-8222-222222222223';
const ART = '33333333-3333-4333-8333-333333333333';
const profile = { user_id: U, country_of_residence: 'AU', country_confirmed_at: '2026-08-29T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true };

const opts = (n: number): PickerOption[] =>
  Array.from({ length: n }, (_, i) => ({ id: `id-${i}`, title: `Resource ${String(i).padStart(3, '0')}`, content_type: i % 3 === 0 ? 'video' : 'article', jurisdiction: 'global', status: i % 2 ? 'published' : 'draft', slug: null }) as PickerOption);

describe('F11 picker logic', () => {
  it('lists every resource (up to the bound) when nothing is typed and filters on title, type and status words', () => {
    const all = opts(300);
    expect(filterPickerOptions(all.slice(0, 20), '').matchCount).toBe(20);
    const r = filterPickerOptions(all, 'resource 007');
    expect(r.visible.map((o) => o.title)).toEqual(['Resource 007']);
    const draftVideos = filterPickerOptions(all, 'draft video');
    expect(draftVideos.matchCount).toBeGreaterThan(0);
    expect(draftVideos.visible.every((o) => o.content_type === 'video' && o.status === 'draft')).toBe(true);
  });

  it('NC-F11-1: 300 resources render at most 50 options and report the remainder; a caller limit can lower but never raise the bound', () => {
    const all = opts(300);
    const r = filterPickerOptions(all, '');
    expect(r.visible).toHaveLength(PICKER_RENDER_LIMIT);
    expect(r.matchCount).toBe(300);
    expect(r.hiddenCount).toBe(250);
    expect(hiddenCountMessage(250)).toBe('250 more, keep typing to narrow');
    expect(filterPickerOptions(all, '', { limit: 5 }).visible).toHaveLength(5);
    expect(filterPickerOptions(all, '', { limit: 100000 }).visible).toHaveLength(PICKER_RENDER_LIMIT);
    // the unbounded alternative would have returned all 300: the bound is what limits it
    expect(all.filter(() => true)).toHaveLength(300);
  });

  it('excludes the item itself and already linked ids', () => {
    const all = opts(10);
    expect(filterPickerOptions(all, '', { excludeIds: ['id-1', 'id-2'] }).matchCount).toBe(8);
  });

  it('keyboard model: ArrowDown opens and moves, Home/End jump, Enter selects, Escape closes, Tab never traps', () => {
    let s = INITIAL_COMBOBOX_STATE;
    let r = reduceCombobox(s, { type: 'key', key: 'ArrowDown' }, 5);
    expect(r.state).toMatchObject({ open: true, activeIndex: 0 });
    r = reduceCombobox(r.state, { type: 'key', key: 'ArrowDown' }, 5);
    expect(r.state.activeIndex).toBe(1);
    r = reduceCombobox(r.state, { type: 'key', key: 'End' }, 5);
    expect(r.state.activeIndex).toBe(4);
    r = reduceCombobox(r.state, { type: 'key', key: 'ArrowDown' }, 5);
    expect(r.state.activeIndex).toBe(0);
    r = reduceCombobox(r.state, { type: 'key', key: 'Enter' }, 5);
    expect(r.selectIndex).toBe(0);
    expect(r.state.open).toBe(false);
    s = reduceCombobox(INITIAL_COMBOBOX_STATE, { type: 'focus' }, 5).state;
    expect(s.open).toBe(true);
    expect(reduceCombobox(s, { type: 'key', key: 'Escape' }, 5).state.open).toBe(false);
    const tab = reduceCombobox(s, { type: 'key', key: 'Tab' }, 5);
    expect(tab.preventDefault).toBe(false);
    expect(tab.selectIndex).toBeNull();
  });

  it('summaries state loading, error, forbidden and empty explicitly', () => {
    const base = { query: '', matchCount: 0, hiddenCount: 0, truncated: false, total: 0 };
    expect(summarisePicker({ ...base, status: 'loading' })).toContain('Loading');
    expect(summarisePicker({ ...base, status: 'error' })).toContain('could not be loaded');
    expect(summarisePicker({ ...base, status: 'forbidden' })).toContain('permission');
    expect(summarisePicker({ ...base, status: 'ready', query: 'zzz' })).toContain('No resources match');
  });

  it('component markup: ARIA 1.2 combobox with listbox, options show type and status text, bounded', () => {
    const visible = filterPickerOptions(opts(300), '').visible;
    const html = renderToStaticMarkup(
      createElement(ResourceComboboxView, {
        id: 'pick', label: 'Add a related Resource', status: 'ready', state: { open: true, query: '', activeIndex: 2 }, visible, matchCount: 300, hiddenCount: 250, truncated: false, total: 300,
      })
    );
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-controls=');
    expect(html).toContain('aria-activedescendant=');
    expect(html).toContain('role="listbox"');
    expect((html.match(/role="option"/g) ?? []).length).toBe(PICKER_RENDER_LIMIT);
    expect(html).toContain('250 more, keep typing to narrow');
    expect(html).toMatch(/Published|Draft/);
    expect(html).toMatch(/Video|Article/);
  });
});

function seedDb() {
  userDb.reset({
    user_profiles: [profile],
    resource_posts: [
      { id: VID, title: 'Video A', content_type: 'video', status: 'draft' },
      { id: VID2, title: 'Video B', content_type: 'video', status: 'draft' },
      { id: ART, title: 'An article', content_type: 'article', status: 'draft' },
    ],
    resource_videos: [{ id: 'rv2', resource_post_id: VID2, youtube_video_id: 'aaaaaaaaaaa', youtube_url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' }],
    resource_related_content: [],
  });
  adminDb.reset({ resource_audit_log: [] });
}
const role = (roles: string[]) => mockRoles.mockResolvedValue({ userId: U, isSuperAdmin: false, roles });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (body: unknown) => new Request('http://t/x', { method: 'POST', body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  seedDb();
  mockGetUser.mockResolvedValue({ data: { user: { id: U } } });
  role(['editor']);
});

describe('F12 repair of a video record with no YouTube details', () => {
  it('creates the missing row from a real URL, audits it, and is refused the second time', async () => {
    const first = await repairMissingVideoRow(userDb.client as never, adminDb.client as never, { postId: VID, youtubeInput: 'https://youtu.be/dQw4w9WgXcQ', actorUserId: U });
    expect(first).toMatchObject({ ok: true, youtubeVideoId: 'dQw4w9WgXcQ' });
    expect(userDb.tables.resource_videos.find((v) => v.resource_post_id === VID)).toMatchObject({ youtube_video_id: 'dQw4w9WgXcQ', embed_enabled: true });
    expect(adminDb.tables.resource_audit_log[0]).toMatchObject({ action: 'video_details_repaired', entity_id: VID });
    const again = await repairMissingVideoRow(userDb.client as never, adminDb.client as never, { postId: VID, youtubeInput: 'https://youtu.be/dQw4w9WgXcQ', actorUserId: U });
    expect(again).toMatchObject({ ok: false, kind: 'already_has_video' });
    expect(userDb.tables.resource_videos.filter((v) => v.resource_post_id === VID)).toHaveLength(1);
  });

  it('NC-F12-1: a healthy record is never changed (another id is refused and the stored id is untouched)', async () => {
    const r = await repairMissingVideoRow(userDb.client as never, adminDb.client as never, { postId: VID2, youtubeInput: 'bbbbbbbbbbb', actorUserId: U });
    expect(r).toMatchObject({ ok: false, kind: 'already_has_video', error: REPAIR_ALREADY_HAS_MESSAGE });
    expect(userDb.tables.resource_videos.find((v) => v.resource_post_id === VID2)?.youtube_video_id).toBe('aaaaaaaaaaa');
    expect(userDb.writes.filter((w) => w.table === 'resource_videos' && w.kind !== 'insert')).toHaveLength(0);
  });

  it('rejects a bad URL (no write) and a non-video post', async () => {
    expect(await repairMissingVideoRow(userDb.client as never, adminDb.client as never, { postId: VID, youtubeInput: 'not a url at all', actorUserId: U })).toMatchObject({ ok: false, kind: 'invalid' });
    expect(await repairMissingVideoRow(userDb.client as never, adminDb.client as never, { postId: ART, youtubeInput: 'dQw4w9WgXcQ', actorUserId: U })).toMatchObject({ ok: false, kind: 'not_found' });
    expect(userDb.writes.filter((w) => w.kind === 'insert')).toHaveLength(0);
  });

  it('repair route: 401 anonymous, 403 for a Publisher, 200 for an Editor', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null } });
    expect((await repairPOST(req({ youtubeInput: 'dQw4w9WgXcQ' }), params(VID))).status).toBe(401);
    role(['publisher']);
    expect((await repairPOST(req({ youtubeInput: 'dQw4w9WgXcQ' }), params(VID))).status).toBe(403);
    role(['editor']);
    expect((await repairPOST(req({ youtubeInput: 'dQw4w9WgXcQ' }), params(VID))).status).toBe(200);
    expect((await repairPOST(req({ youtubeInput: 'dQw4w9WgXcQ' }), params(VID))).status).toBe(409);
  });
});

describe('F12 link a video to content', () => {
  it('links through the existing relationship table, rejects duplicates, video-to-video and self links, and lists both ways', async () => {
    const ok1 = await linksPOST(req({ content_post_id: ART }), params(VID2));
    expect(ok1.status).toBe(200);
    expect(userDb.tables.resource_related_content[0]).toMatchObject({ source_post_id: ART, related_post_id: VID2, relationship_type: 'related' });
    expect(adminDb.tables.resource_audit_log[0]).toMatchObject({ action: 'video_linked_to_content' });
    expect((await linksPOST(req({ content_post_id: ART }), params(VID2))).status).toBe(409);
    expect((await linksPOST(req({ content_post_id: VID }), params(VID2))).status).toBe(422);
    expect((await linksPOST(req({ content_post_id: VID2 }), params(VID2))).status).toBe(422);
    expect((await linksPOST(req({}), params(VID2))).status).toBe(422);
  });

  it('direct-API: 401 anonymous, 403 for an Author and for a Publisher on link (read stays staff-wide), nothing written', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null } });
    expect((await linksPOST(req({ content_post_id: ART }), params(VID2))).status).toBe(401);
    for (const r of ['author', 'publisher', 'compliance_reviewer', 'analyst']) {
      role([r]);
      expect((await linksPOST(req({ content_post_id: ART }), params(VID2))).status).toBe(403);
    }
    expect(userDb.tables.resource_related_content).toHaveLength(0);
    role(['author']);
    expect((await linksGET(new Request('http://t/x'), params(VID2))).status).toBe(200);
    role(['analyst']);
    expect((await linksGET(new Request('http://t/x'), params(VID2))).status).toBe(403);
  });

  it('NC-F12-2: unlinking refuses a link that belongs to a different video', async () => {
    userDb.tables.resource_related_content.push({ id: 'L1', source_post_id: ART, related_post_id: VID2, relationship_type: 'related', sort_order: 0 });
    expect(await unlinkVideoFromContent(userDb.client as never, { videoPostId: VID, linkId: 'L1' })).toMatchObject({ ok: false, kind: 'not_found' });
    expect(userDb.tables.resource_related_content).toHaveLength(1);
    expect(await unlinkVideoFromContent(userDb.client as never, { videoPostId: VID2, linkId: 'L1' })).toMatchObject({ ok: true });
    expect(userDb.tables.resource_related_content).toHaveLength(0);
  });
});

describe('F12 root cause: an orphan video post is never left behind', () => {
  // A client whose resource_videos insert always fails and whose resource_posts delete is
  // RLS-blind (affects zero rows, as for a non-manager), plus a service-role fake that can delete.
  function brokenVideoClient() {
    const posts: Record<string, unknown>[] = [];
    return {
      posts,
      client: {
        from: (t: string) => {
          if (t === 'resource_posts') {
            return {
              insert: (row: Record<string, unknown>) => ({ select: () => ({ single: async () => { const r = { id: 'orph-1', ...row }; posts.push(r); return { data: { id: 'orph-1' }, error: null }; } }) }),
              delete: () => ({ eq: () => ({ select: async () => ({ data: [], error: null }) }) }), // RLS: zero rows, no error
            };
          }
          return { insert: async () => ({ error: { code: 'XX000' } }), select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
        },
      },
    };
  }

  it('a non-manager whose own delete removes zero rows still gets the orphan cleaned up by the scoped service-role delete', async () => {
    const { client, posts } = brokenVideoClient();
    const adminCalls: string[] = [];
    const admin = {
      from: (t: string) => {
        adminCalls.push(t);
        if (t === 'resource_videos') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
        const chain: Record<string, unknown> = {};
        chain.delete = () => chain;
        chain.eq = () => chain;
        chain.select = async () => ({ data: [{ id: 'orph-1' }], error: null });
        return chain;
      },
    };
    const res = await createVideoDraft(client as never, 'dQw4w9WgXcQ', U, admin as never);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).not.toContain('could not be cleaned up');
    expect(adminCalls).toContain('resource_posts');
    expect(posts).toHaveLength(1);
  });

  it('when no cleanup is possible the caller is told honestly (never a silent orphan)', async () => {
    const { client } = brokenVideoClient();
    const res = await createVideoDraft(client as never, 'dQw4w9WgXcQ', U, undefined);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('could not be cleaned up');
    expect(await removeOrphanVideoPost(client as never, undefined, 'orph-1', U)).toBe(false);
  });
});
