/**
 * Resources Bulk Upload -- ROUTE-LAYER access matrix (Admin Architecture Standard sections 2 and 4).
 *
 * The real exported route handlers, driven against a hermetic Supabase fake. Every caller x every import route is an
 * explicit status assertion; for every DENIED case the underlying staging function is asserted NEVER to have been
 * called, so a denial is an early return, not a filtered result. Capability resources.content.bulk_import is held by
 * Super Admin, Resource Admin and Editor ONLY.
 *
 * Also proves, structurally: the capability is its own predicate (not isResourceStaff / canCreateSpecialistContent),
 * is in the admin nav contract as its own field, and the Apply route carries no request body into the database.
 *
 * Hermetic: no database, no network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { countryRegistryFrom } from './support/countryRegistryFake';

const CONFIRMED = { country_of_residence: 'AU', country_confirmed_at: '2026-08-30T00:00:00.000Z', country_source: 'USER_CONFIRMED', onboarding_completed: true };
const state: { user: { id: string } | null; adminRow: { user_id: string } | null; roleRows: { role: string }[]; profile: typeof CONFIRMED | null } = { user: null, adminRow: null, roleRows: [], profile: CONFIRMED };

function chain(result: { data: unknown }) {
  const c = {
    select: () => c,
    eq: () => c,
    order: () => c,
    limit: () => c,
    maybeSingle: async () => result,
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej),
  };
  return c;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    from(table: string) {
      const registry = countryRegistryFrom(table);
      if (registry) return registry as ReturnType<typeof chain>;
      return chain(table === 'admin_users' ? { data: state.adminRow } : table === 'user_profiles' ? { data: state.profile } : { data: state.roleRows });
    },
  }),
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ marker: 'admin' }) }));

const spies = {
  processUpload: vi.fn(async () => ({ runId: 'r1', status: 'ready', fileIssues: [], summary: { rowCount: 1, validCount: 1, warningCount: 0, errorCount: 0 }, metrics: {} })),
  listRuns: vi.fn(async () => [{ id: 'r1' }]),
  getRun: vi.fn(async () => ({ id: 'r1', content_type: 'article', file_issues: [], status: 'ready' })),
  getRunRows: vi.fn(async () => []),
  getRowDetail: vi.fn(async () => ({ row_number: 2 })),
  applyRun: vi.fn(async () => ({ ok: true, alreadyApplied: false, created: 1, postIds: ['p1'], runId: 'r1' })),
  template: vi.fn(async () => new Uint8Array([1, 2, 3])),
  inspect: vi.fn(),
};
vi.mock('@/lib/resources/import/file-security', async () => {
  const real = await vi.importActual<typeof import('@/lib/resources/import/file-security')>('@/lib/resources/import/file-security');
  return {
    ...real,
    listUploadSheets: (...a: unknown[]) => {
      if (!spies.inspect.getMockImplementation()) spies.inspect.mockImplementation((...b: unknown[]) => real.listUploadSheets(...(b as [Parameters<typeof real.listUploadSheets>[0]])));
      return spies.inspect(...a);
    },
  };
});
vi.mock('@/lib/resources/import/staging', async () => {
  const real = await vi.importActual<typeof import('@/lib/resources/import/staging')>('@/lib/resources/import/staging');
  return {
    ...real,
    processUpload: (...a: unknown[]) => spies.processUpload(...(a as [])),
    listRuns: (...a: unknown[]) => spies.listRuns(...(a as [])),
    getRun: (...a: unknown[]) => spies.getRun(...(a as [])),
    getRunRows: (...a: unknown[]) => spies.getRunRows(...(a as [])),
    getRowDetail: (...a: unknown[]) => spies.getRowDetail(...(a as [])),
    applyRun: (...a: unknown[]) => spies.applyRun(...(a as [])),
  };
});
vi.mock('@/lib/resources/import/template-generator', async () => {
  const real = await vi.importActual<typeof import('@/lib/resources/import/template-generator')>('@/lib/resources/import/template-generator');
  return { ...real, buildTemplateXlsx: (...a: unknown[]) => spies.template(...(a as [])) };
});

import { GET as historyGet, POST as uploadPost } from '@/app/api/admin/resources/import/runs/route';
import { GET as runGet } from '@/app/api/admin/resources/import/runs/[id]/route';
import { GET as rowGet } from '@/app/api/admin/resources/import/runs/[id]/rows/[rowNumber]/route';
import { GET as resultsGet } from '@/app/api/admin/resources/import/runs/[id]/results/route';
import { POST as applyPost } from '@/app/api/admin/resources/import/runs/[id]/apply/route';
import { POST as inspectPost } from '@/app/api/admin/resources/import/inspect/route';
import { GET as templateGet } from '@/app/api/admin/resources/import/templates/route';
import { canBulkImportResources, canCreateSpecialistContent, isResourceStaff, BULK_IMPORT_CAPABILITY } from '@/lib/resources/permissions';
import { buildAdminNavGroups, NO_ADMIN_CAPABILITIES, parseAdminCapabilities } from '@/lib/admin/adminNav';
import { csvOf, good } from '../support/resourcesImportFixtures';

const ID = '11111111-1111-4111-8111-111111111111';
const params = (extra: Record<string, string> = {}) => ({ params: Promise.resolve({ id: ID, ...extra }) }) as never;
const upload = () => {
  const form = new FormData();
  form.set('contentType', 'article');
  form.set('file', new File([csvOf('article', [good('article')]) as unknown as BlobPart], 'a.csv', { type: 'text/csv' }));
  return new Request('https://fhip.test/api/admin/resources/import/runs', { method: 'POST', body: form });
};

type Call = () => Promise<Response>;
const BULK_ROUTES: { name: string; call: Call; spy: ReturnType<typeof vi.fn> }[] = [
  { name: 'GET runs (history)', call: () => historyGet(), spy: spies.listRuns },
  { name: 'POST runs (upload)', call: () => uploadPost(upload()), spy: spies.processUpload },
  { name: 'POST inspect (sheet list)', call: () => inspectPost(upload()), spy: spies.inspect },
  { name: 'GET runs/[id]', call: () => runGet(new Request('https://x.test'), params()), spy: spies.getRun },
  { name: 'GET runs/[id]/rows/[n]', call: () => rowGet(new Request('https://x.test'), params({ rowNumber: '2' })), spy: spies.getRowDetail },
  { name: 'GET runs/[id]/results (csv)', call: () => resultsGet(new Request('https://x.test'), params()), spy: spies.getRunRows },
  { name: 'POST runs/[id]/apply', call: () => applyPost(new Request('https://x.test', { method: 'POST' }), params()), spy: spies.applyRun },
];

const CALLERS: [string, { user: boolean; admin?: boolean; roles?: string[] }, boolean][] = [
  ['Super Admin', { user: true, admin: true }, true],
  ['Resource Admin', { user: true, roles: ['resource_admin'] }, true],
  ['Editor', { user: true, roles: ['editor'] }, true],
  ['Analyst + Editor', { user: true, roles: ['analyst', 'editor'] }, true],
  ['Author', { user: true, roles: ['author'] }, false],
  ['Compliance Reviewer', { user: true, roles: ['compliance_reviewer'] }, false],
  ['Publisher', { user: true, roles: ['publisher'] }, false],
  ['Analyst', { user: true, roles: ['analyst'] }, false],
  ['Customer (no Resources role)', { user: true, roles: [] }, false],
  ['Anonymous', { user: false }, false],
];

function as(setup: { user: boolean; admin?: boolean; roles?: string[] }) {
  state.user = setup.user ? { id: 'u1' } : null;
  state.adminRow = setup.admin ? { user_id: 'u1' } : null;
  state.roleRows = (setup.roles ?? []).map((role) => ({ role }));
}

beforeEach(() => {
  as({ user: false });
  state.profile = CONFIRMED;
  for (const s of Object.values(spies)) s.mockClear();
});

describe('bulk import routes: 10 callers x 6 routes (DENIED = explicit 401/403 and the work is never started)', () => {
  for (const route of BULK_ROUTES) {
    describe(route.name, () => {
      for (const [label, setup, allowed] of CALLERS) {
        it(`${label} -> ${allowed ? '2xx' : setup.user ? '403' : '401'}`, async () => {
          as(setup);
          const res = await route.call();
          if (allowed) {
            expect(res.status).toBeLessThan(300);
            expect(route.spy).toHaveBeenCalled();
          } else {
            expect(res.status).toBe(setup.user ? 403 : 401);
            const body = await res.json();
            expect(body.error).toBeTruthy();
            expect(body.data, 'a denial is never an empty success').toBeUndefined();
            for (const s of Object.values(spies)) expect(s, 'a denied caller must not reach any staging function').not.toHaveBeenCalled();
          }
        });
      }
    });
  }
});

describe('template download: anyone who can create Resources by hand; Compliance Reviewer, Publisher, Analyst, customer, anonymous DENIED', () => {
  const TEMPLATE_CALLERS: [string, { user: boolean; admin?: boolean; roles?: string[] }, number][] = [
    ['Super Admin', { user: true, admin: true }, 200],
    ['Resource Admin', { user: true, roles: ['resource_admin'] }, 200],
    ['Editor', { user: true, roles: ['editor'] }, 200],
    ['Author', { user: true, roles: ['author'] }, 200],
    ['Compliance Reviewer', { user: true, roles: ['compliance_reviewer'] }, 403],
    ['Publisher', { user: true, roles: ['publisher'] }, 403],
    ['Analyst', { user: true, roles: ['analyst'] }, 403],
    ['Customer', { user: true, roles: [] }, 403],
    ['Anonymous', { user: false }, 401],
  ];
  for (const type of ['article', 'money_update']) {
    for (const format of ['csv', 'xlsx']) {
      for (const [label, setup, status] of TEMPLATE_CALLERS) {
        it(`${type}.${format}: ${label} -> ${status}`, async () => {
          as(setup);
          const res = await templateGet(new Request(`https://fhip.test/api/admin/resources/import/templates?type=${type}&format=${format}`));
          expect(res.status).toBe(status);
          if (status === 200) {
            expect(res.headers.get('content-disposition')).toContain(type === 'article' ? 'FHIP_Article_Upload_Template_v1' : 'FHIP_Money_Update_Upload_Template_v1');
            expect(res.headers.get('content-disposition')).toContain(`.${format}`);
            expect(res.headers.get('cache-control')).toBe('no-store');
          }
        });
      }
    }
  }
  it('rejects an unknown type or format with 400, never a fallback', async () => {
    as({ user: true, admin: true });
    expect((await templateGet(new Request('https://x.test/t?type=guide&format=csv'))).status).toBe(400);
    expect((await templateGet(new Request('https://x.test/t?type=article&format=xls'))).status).toBe(400);
  });
});

describe('the upload route trusts nothing from the browser', () => {
  it('requires a content type chosen on the screen and a file; an unknown type is refused before any work', async () => {
    as({ user: true, roles: ['editor'] });
    const noType = new FormData();
    noType.set('file', new File(['x'], 'a.csv'));
    expect((await uploadPost(new Request('https://x.test', { method: 'POST', body: noType }))).status).toBe(400);
    const badType = new FormData();
    badType.set('contentType', 'guide');
    badType.set('file', new File(['x'], 'a.csv'));
    expect((await uploadPost(new Request('https://x.test', { method: 'POST', body: badType }))).status).toBe(400);
    const noFile = new FormData();
    noFile.set('contentType', 'article');
    expect((await uploadPost(new Request('https://x.test', { method: 'POST', body: noFile }))).status).toBe(400);
    expect(spies.processUpload).not.toHaveBeenCalled();
  });

  it('an oversized declared length is refused with 413 before the body is read', async () => {
    as({ user: true, roles: ['editor'] });
    const res = await uploadPost(new Request('https://x.test', { method: 'POST', headers: { 'content-length': String(11 * 1024 * 1024) }, body: new FormData() }));
    expect(res.status).toBe(413);
    expect(spies.processUpload).not.toHaveBeenCalled();
  });

  it('a rejected file is a 422 that still names the failure and the run (so the results can be downloaded)', async () => {
    as({ user: true, roles: ['editor'] });
    spies.processUpload.mockResolvedValueOnce({ runId: 'r9', status: 'rejected', fileIssues: [{ row: null, field: null, code: 'INVALID_FILE_TYPE', message: 'Nope', severity: 'error' }], summary: { rowCount: 0, validCount: 0, warningCount: 0, errorCount: 0 }, metrics: {} } as never);
    const res = await uploadPost(upload());
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe('INVALID_FILE_TYPE');
    expect(body.data.runId).toBe('r9');
  });

  it('the route reads the content type and file from the multipart body and passes ONLY those, the caller and the server clients (no role, status, visibility or actor from the browser)', async () => {
    as({ user: true, roles: ['editor'] });
    await uploadPost(upload());
    const arg = (spies.processUpload.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(Object.keys(arg).sort()).toEqual(['admin', 'bytes', 'contentType', 'declaredMime', 'fileName', 'sheetName', 'user', 'userId']);
    expect(arg.contentType).toBe('article');
    expect(arg.userId).toBe('u1');
  });
});

describe('apply carries no content from the browser', () => {
  it('the Apply route never reads a request body: it forwards only the run id and the caller', async () => {
    as({ user: true, roles: ['editor'] });
    const evil = new Request('https://x.test', { method: 'POST', body: JSON.stringify({ status: 'published', visibility: 'public', contentType: 'guide', rows: [{ title: 'x' }] }) });
    await applyPost(evil, params());
    const args = spies.applyRun.mock.calls[0] as unknown as unknown[];
    expect(args[2]).toBe(ID);
    expect(args[3]).toBe('u1');
    expect(args.length).toBe(4);
    const src = fs.readFileSync(path.resolve(__dirname, '../../app/api/admin/resources/import/runs/[id]/apply/route.ts'), 'utf8');
    expect(src).not.toMatch(/request\.(json|formData|text)\(/);
    expect(src).not.toMatch(/_request\.(json|formData|text)\(/);
  });

  it('an unknown run id or a malformed id is a 404; a denial from the database maps to its own status', async () => {
    as({ user: true, roles: ['editor'] });
    expect((await applyPost(new Request('https://x.test', { method: 'POST' }), { params: Promise.resolve({ id: 'not-a-uuid' }) })).status).toBe(404);
    spies.applyRun.mockResolvedValueOnce({ ok: false, code: 'STALE_PREVIEW', message: 'stale', status: 409 } as never);
    const res = await applyPost(new Request('https://x.test', { method: 'POST' }), params());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('STALE_PREVIEW');
  });
});

describe('the capability is its own predicate and its own nav field (Standard section 2)', () => {
  const roles = (r: string[], isSuperAdmin = false) => ({ userId: 'u', isSuperAdmin, roles: r as never });
  it('matches the SQL: super admin, resource admin, editor ONLY; not author, compliance reviewer, publisher or analyst', () => {
    for (const [r, want] of [['resource_admin', true], ['editor', true], ['author', false], ['compliance_reviewer', false], ['publisher', false], ['analyst', false]] as const) expect(canBulkImportResources(roles([r])), r).toBe(want);
    expect(canBulkImportResources(roles([], true))).toBe(true);
    expect(canBulkImportResources({ userId: null, isSuperAdmin: false, roles: [] })).toBe(false);
    expect(BULK_IMPORT_CAPABILITY).toBe('resources.content.bulk_import');
  });
  it('it is NOT derived from the broader predicates: an Author passes both of those and still lacks it', () => {
    const author = roles(['author']);
    expect(isResourceStaff(author)).toBe(true);
    expect(canCreateSpecialistContent(author)).toBe(true);
    expect(canBulkImportResources(author)).toBe(false);
  });
  it('the nav contract has its own capability field (no sidebar group since the PO decision of 16-10-2026), fails closed, and no other capability implies it', () => {
    expect(NO_ADMIN_CAPABILITIES.resourceContentBulkImport).toBe(false);
    expect(parseAdminCapabilities({ data: { capabilities: { resourceContentAdmin: true, resourcesDashboard: true } } }).resourceContentBulkImport).toBe(false);
    expect(parseAdminCapabilities({ data: { capabilities: { resourceContentBulkImport: 'true' } } }).resourceContentBulkImport).toBe(false);
    expect(parseAdminCapabilities({ data: { capabilities: { resourceContentBulkImport: true } } }).resourceContentBulkImport).toBe(true);
    // PO decision 16-10-2026: Bulk Upload lives inside Create Resource; holding the capability adds NO sidebar group or item
    // (the Create Resource page decides, on the server, whether to offer it: resourcesBulkUploadInsideCreateResource.test.ts).
    expect(buildAdminNavGroups(false, { ...NO_ADMIN_CAPABILITIES, resourceContentBulkImport: true })).toEqual([]);
    expect(buildAdminNavGroups(true, { ...NO_ADMIN_CAPABILITIES, resourceContentAdmin: true, resourcesDashboard: true }).map((g) => g.label)).not.toContain('Bulk Upload');
  });
});

describe('every import route and page starts with the capability guard (structural)', () => {
  const root = path.resolve(__dirname, '../..');
  const apiFiles = [
    'app/api/admin/resources/import/runs/route.ts',
    'app/api/admin/resources/import/inspect/route.ts',
    'app/api/admin/resources/import/runs/[id]/route.ts',
    'app/api/admin/resources/import/runs/[id]/rows/[rowNumber]/route.ts',
    'app/api/admin/resources/import/runs/[id]/results/route.ts',
    'app/api/admin/resources/import/runs/[id]/apply/route.ts',
  ];
  for (const f of apiFiles) {
    it(`${f}: every exported handler calls guardBulkImport() before anything else`, () => {
      const src = fs.readFileSync(path.join(root, f), 'utf8');
      // Handler signatures are single-line, so the first statement is the line after the one ending in "{".
      const handlers = [...src.matchAll(/export async function (GET|POST)\([^\n]*\{\n\s*([^\n]*)/g)];
      expect(handlers.length).toBeGreaterThan(0);
      for (const h of handlers) expect(h[2].startsWith('const g = await guardBulkImport();'), `${f} ${h[1]}`).toBe(true);
    });
  }
  const pageFiles = ['import/page.tsx', 'import/upload/page.tsx', 'import/runs/[id]/page.tsx', 'import/history/page.tsx'].map((p) => `app/(app)/admin/resources/${p}`);
  for (const f of pageFiles) {
    it(`${f}: requires admin access then redirects a caller without the capability`, () => {
      const src = fs.readFileSync(path.join(root, f), 'utf8');
      expect(src).toContain('requireResourceAdminAccess()');
      expect(src).toMatch(/if \(!canBulkImportResources\(current\)\) redirect\('\/admin\/resources'\);/);
    });
  }
});
