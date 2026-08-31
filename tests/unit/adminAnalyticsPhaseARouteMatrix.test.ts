/**
 * FHIP Analyst Analytics Intelligence Centre — Phase A, Wave 1, §10.5.
 *
 * The eight corrected Resources GET routes, driven for real (the actual
 * exported GET handlers, not a re-implementation) against a hermetic
 * Supabase fake and mocked list/picker query functions.
 *
 * Ten callers x eight routes = 80 explicit status assertions, plus a payload
 * assertion on every one of the 64 positive cases: an authorised role must
 * still receive the route's real list/picker payload, never a 200 with an
 * empty substitute. Negative cases additionally assert that the underlying
 * query function was never invoked, so a denial is a genuine early return
 * rather than a filtered result.
 *
 * The POST handlers of these routes are exercised nowhere here and were not
 * modified by Wave 1; a structural guard at the end of this file proves the
 * change to each route is confined to its GET gate.
 *
 * Hermetic: no DEV/staging/production access, no .env read, no network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const state: { user: { id: string } | null; adminRow: { user_id: string } | null; roleRows: { role: string }[] } = {
  user: null,
  adminRow: null,
  roleRows: [],
};

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    from(table: string) {
      const result = table === 'admin_users' ? { data: state.adminRow } : { data: state.roleRows };
      const chain = {
        select: () => chain,
        eq: () => chain,
        limit: () => chain,
        maybeSingle: async () => result,
        then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej),
      };
      return chain;
    },
  }),
}));

// Distinctive, non-empty sentinel payloads. Asserting the response body
// equals these is what proves an authorised caller still gets the real data.
const PAYLOAD = {
  content: { items: [{ id: 'post-1', title: 'Real content row' }], total: 1 },
  videos: { items: [{ id: 'vid-1', title: 'Real video row' }], total: 1 },
  glossary: { items: [{ id: 'glo-1', term: 'Real glossary row' }], total: 1 },
  faqs: { items: [{ id: 'faq-1', question: 'Real FAQ row' }], total: 1 },
  moneyUpdates: { items: [{ id: 'mu-1', title: 'Real money update row' }], total: 1 },
  tags: [{ id: 'tag-1', name: 'Real tag' }],
  authors: [{ id: 'auth-1', name: 'Real author' }],
  categories: [{ id: 'cat-1', name: 'Real category' }],
};

const queryCalls = {
  content: vi.fn(async () => PAYLOAD.content),
  categories: vi.fn(async () => PAYLOAD.categories),
  videos: vi.fn(async () => PAYLOAD.videos),
  glossary: vi.fn(async () => PAYLOAD.glossary),
  faqs: vi.fn(async () => PAYLOAD.faqs),
  moneyUpdates: vi.fn(async () => PAYLOAD.moneyUpdates),
  tags: vi.fn(async () => PAYLOAD.tags),
  authors: vi.fn(async () => PAYLOAD.authors),
};

vi.mock('@/lib/resources/admin/queries', () => ({
  getResourceContentList: (...a: unknown[]) => queryCalls.content(...(a as [])),
  getResourceCategoriesForFilter: (...a: unknown[]) => queryCalls.categories(...(a as [])),
}));
vi.mock('@/lib/resources/video/queries', () => ({ getVideoList: (...a: unknown[]) => queryCalls.videos(...(a as [])) }));
vi.mock('@/lib/resources/glossary/queries', () => ({ getGlossaryList: (...a: unknown[]) => queryCalls.glossary(...(a as [])) }));
vi.mock('@/lib/resources/faq/queries', () => ({ getFaqList: (...a: unknown[]) => queryCalls.faqs(...(a as [])) }));
vi.mock('@/lib/resources/money-update/queries', () => ({
  getMoneyUpdateList: (...a: unknown[]) => queryCalls.moneyUpdates(...(a as [])),
}));
vi.mock('@/lib/resources/editor/queries', () => ({
  getResourceActiveTags: (...a: unknown[]) => queryCalls.tags(...(a as [])),
  getResourceActiveAuthors: (...a: unknown[]) => queryCalls.authors(...(a as [])),
}));

import { GET as contentGet } from '@/app/api/admin/resources/content/route';
import { GET as videosGet } from '@/app/api/admin/resources/videos/route';
import { GET as glossaryGet } from '@/app/api/admin/resources/glossary/route';
import { GET as faqsGet } from '@/app/api/admin/resources/faqs/route';
import { GET as moneyUpdatesGet } from '@/app/api/admin/resources/money-updates/route';
import { GET as tagsGet } from '@/app/api/admin/resources/tags/route';
import { GET as authorsGet } from '@/app/api/admin/resources/authors/route';
import { GET as categoriesGet } from '@/app/api/admin/resources/categories/route';

type Handler = (request: Request) => Promise<Response>;

const ROUTES: { name: string; file: string; handler: Handler; payload: unknown; spy: ReturnType<typeof vi.fn> }[] = [
  { name: 'content', file: 'app/api/admin/resources/content/route.ts', handler: contentGet as Handler, payload: PAYLOAD.content, spy: queryCalls.content },
  { name: 'videos', file: 'app/api/admin/resources/videos/route.ts', handler: videosGet as Handler, payload: PAYLOAD.videos, spy: queryCalls.videos },
  { name: 'glossary', file: 'app/api/admin/resources/glossary/route.ts', handler: glossaryGet as Handler, payload: PAYLOAD.glossary, spy: queryCalls.glossary },
  { name: 'faqs', file: 'app/api/admin/resources/faqs/route.ts', handler: faqsGet as Handler, payload: PAYLOAD.faqs, spy: queryCalls.faqs },
  { name: 'money-updates', file: 'app/api/admin/resources/money-updates/route.ts', handler: moneyUpdatesGet as Handler, payload: PAYLOAD.moneyUpdates, spy: queryCalls.moneyUpdates },
  { name: 'tags', file: 'app/api/admin/resources/tags/route.ts', handler: tagsGet as Handler, payload: PAYLOAD.tags, spy: queryCalls.tags },
  { name: 'authors', file: 'app/api/admin/resources/authors/route.ts', handler: authorsGet as Handler, payload: PAYLOAD.authors, spy: queryCalls.authors },
  { name: 'categories', file: 'app/api/admin/resources/categories/route.ts', handler: categoriesGet as Handler, payload: PAYLOAD.categories, spy: queryCalls.categories },
];

/** [label, setup, expected status] */
const CALLERS: [string, { user: boolean; admin?: boolean; roles?: string[] }, number][] = [
  ['unauthenticated', { user: false }, 401],
  ['authenticated, no Resources role', { user: true, roles: [] }, 403],
  ['Analyst only', { user: true, roles: ['analyst'] }, 403],
  ['Author', { user: true, roles: ['author'] }, 200],
  ['Editor', { user: true, roles: ['editor'] }, 200],
  ['Compliance Reviewer', { user: true, roles: ['compliance_reviewer'] }, 200],
  ['Publisher', { user: true, roles: ['publisher'] }, 200],
  ['Resource Admin', { user: true, roles: ['resource_admin'] }, 200],
  ['Super Admin', { user: true, admin: true, roles: [] }, 200],
  ['Analyst + Editor', { user: true, roles: ['analyst', 'editor'] }, 200],
];

beforeEach(() => {
  state.user = null;
  state.adminRow = null;
  state.roleRows = [];
  for (const spy of Object.values(queryCalls)) spy.mockClear();
});

describe('Wave 1 §10.5 — eight-route GET access matrix (10 callers x 8 routes)', () => {
  for (const route of ROUTES) {
    describe(`GET /api/admin/resources/${route.name}`, () => {
      for (const [label, setup, expectedStatus] of CALLERS) {
        it(`${label} -> ${expectedStatus}`, async () => {
          state.user = setup.user ? { id: 'u1' } : null;
          state.adminRow = setup.admin ? { user_id: 'u1' } : null;
          state.roleRows = (setup.roles ?? []).map((role) => ({ role }));

          const res = await route.handler(new Request(`https://fhip.test/api/admin/resources/${route.name}`));
          expect(res.status).toBe(expectedStatus);
          const body = await res.json();

          if (expectedStatus === 200) {
            // The REAL payload must still be returned — not a 200 with an
            // empty stand-in.
            expect(body.data).toEqual(route.payload);
            expect(route.spy).toHaveBeenCalledTimes(1);
          } else {
            expect(body.error).toBeTruthy();
            expect(body.data).toBeUndefined();
            // A denial must short-circuit before any query runs.
            expect(route.spy).not.toHaveBeenCalled();
          }
        });
      }
    });
  }
});

describe('Wave 1 §10.5 — denial semantics', () => {
  it('Analyst-only is denied with 403 on every one of the eight routes, never a misleading 200', async () => {
    for (const route of ROUTES) {
      state.user = { id: 'u1' };
      state.roleRows = [{ role: 'analyst' }];
      const res = await route.handler(new Request('https://fhip.test/x'));
      expect(res.status, route.name).toBe(403);
    }
  });

  it('an unauthenticated caller receives 401, distinguishable from an authenticated denial', async () => {
    for (const route of ROUTES) {
      state.user = null;
      const unauth = await route.handler(new Request('https://fhip.test/x'));
      expect(unauth.status, route.name).toBe(401);
      state.user = { id: 'u1' };
      state.roleRows = [{ role: 'analyst' }];
      const forbidden = await route.handler(new Request('https://fhip.test/x'));
      expect(forbidden.status, route.name).toBe(403);
    }
  });

  it('the denial message and status are byte-identical to the pre-Wave-1 behaviour', async () => {
    for (const route of ROUTES) {
      state.user = { id: 'u1' };
      state.roleRows = [];
      const res = await route.handler(new Request('https://fhip.test/x'));
      const body = await res.json();
      expect(body.error, route.name).toBe("You don't have permission to access Resources administration.");
    }
  });

  it('Analyst plus a staff role receives that other role’s access, unnarrowed by Analyst', async () => {
    for (const other of ['author', 'editor', 'compliance_reviewer', 'publisher', 'resource_admin']) {
      for (const route of ROUTES) {
        state.user = { id: 'u1' };
        state.roleRows = [{ role: 'analyst' }, { role: other }];
        const res = await route.handler(new Request('https://fhip.test/x'));
        expect(res.status, `${route.name}/${other}`).toBe(200);
        expect((await res.json()).data, `${route.name}/${other}`).toEqual(route.payload);
      }
    }
  });

  it('the content route’s workflow queues use the same GET handler and the same gate', async () => {
    for (const queue of ['drafts', 'review', 'scheduled', 'published', 'review-due', 'archived']) {
      state.user = { id: 'u1' };
      state.roleRows = [{ role: 'analyst' }];
      const denied = await contentGet(new Request(`https://fhip.test/api/admin/resources/content?queue=${queue}`));
      expect(denied.status, queue).toBe(403);

      state.roleRows = [{ role: 'editor' }];
      queryCalls.content.mockClear();
      const allowed = await contentGet(new Request(`https://fhip.test/api/admin/resources/content?queue=${queue}`));
      expect(allowed.status, queue).toBe(200);
      expect((await allowed.json()).data, queue).toEqual(PAYLOAD.content);
    }
  });
});

describe('Wave 1 §13 — scope guard on the eight route files', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs');

  /** File contents with `//` comment lines removed, so a guard inspects executable code only. */
  function codeOf(file: string): string {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
  }

  for (const route of ROUTES) {
    it(`${route.name}: the coarse role-count check is gone and the staff predicate is in place`, () => {
      const code = codeOf(route.file);
      expect(code).not.toContain('current.roles.length === 0');
      expect(code).toContain('if (!isResourceStaff(current)) return bad(');
      // Exactly one gate replaced — no second one introduced.
      expect(code.split('if (!isResourceStaff(current)) return bad(').length - 1).toBe(1);
    });
  }

  it('no route in app/api/admin/resources retains the coarse check except dashboard, which is deliberately out of scope', () => {
    // dashboard/route.ts keeps its coarse first-pass check because it
    // immediately branches on isResourceStaff() and returns a safe
    // analystPlaceholder rather than a misleading partial dataset (Final
    // Corrective Addendum §1.2). Wave 1 does not modify it.
    const dashboard = codeOf('app/api/admin/resources/dashboard/route.ts');
    expect(dashboard).toContain('current.roles.length === 0');
    expect(dashboard).toContain('isResourceStaff');
  });

  it('the already-correct Discovery routes are untouched and still gate on isResourceStaff', () => {
    for (const f of ['related', 'ctas', 'context']) {
      const code = codeOf(`app/api/admin/resources/${f}/route.ts`);
      expect(code, f).toContain('isResourceStaff(current)');
      expect(code, f).not.toContain('current.roles.length === 0');
    }
  });

  it('every modified route still has its POST/mutation gate on its own, unrelated predicate', () => {
    const expected: Record<string, string> = {
      content: 'canCreateResource',
      videos: 'canCreateSpecialistContent',
      glossary: 'canCreateSpecialistContent',
      faqs: 'canManageFaqs',
      'money-updates': 'canCreateSpecialistContent',
    };
    for (const [name, predicate] of Object.entries(expected)) {
      const source = fs.readFileSync(`app/api/admin/resources/${name}/route.ts`, 'utf8');
      expect(source, name).toContain('export async function POST');
      expect(source, name).toContain(predicate);
    }
  });
});
