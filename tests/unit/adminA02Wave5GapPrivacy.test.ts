// Admin A0.2 Wave 5 — Recommendations Gap Review privacy closure.
//
// The Product Owner decision this proves: no Admin role, including Super
// Admin, may hold standing access to identifiable individual financial
// figures through Gap Review.
//
// Deliberate testing choices:
//
//  - **No real person's data is used, read or reproduced anywhere here.**
//    The sensitive field names are asserted as ABSENT; the only values that
//    appear are synthetic. Nothing in this file, or in its output, contains
//    a real figure.
//  - The API handler is exercised **behaviourally**, with authorization
//    mocked at the boundary, so the 401/403/503 precedence is proven rather
//    than asserted from source. That is the authoritative control.
//  - The client and route are ALSO checked at source level, because the
//    defect being locked out (a query that fetches sensitive rows, or a
//    component that renders them) is a textual pattern a future refactor
//    could reintroduce without any behavioural test noticing.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const ROUTE = 'app/api/admin/recommendations/gaps/route.ts';
const CLIENT = 'components/admin/AdminRecommendationsClient.tsx';

/**
 * Every field the withdrawn payload carried. Each is either a direct
 * identifier, an indirect/household identifier, or an exact financial value.
 * The closure is only real if NONE of them can be returned or rendered.
 */
const PROHIBITED_FIELDS = [
  // Direct / indirect identifiers
  'user_id',
  'forecast_profile_id',
  'scenario_id',
  // The container for every financial value
  'context_snapshot',
  // Exact financial values carried inside it
  'monthly_surplus',
  'emergency_fund_months',
  'variance_amount',
  'variance_percentage',
  'actual_till_date',
  'forecast_till_date',
  'revised_forecast_value',
  'estimated_future_impact',
];

// ---------------------------------------------------------------------------
// 1. The authoritative server boundary
// ---------------------------------------------------------------------------

const requireAdmin = vi.fn();
const adminClient = vi.fn();

vi.mock('@/lib/services/adminAuth', () => ({
  requireAdmin: (...args: unknown[]) => requireAdmin(...args),
  adminClient: (...args: unknown[]) => adminClient(...args),
  safeDbError: () => {
    throw new Error('safeDbError must never be reached: the handler must not query at all.');
  },
}));

describe('Wave 5 privacy closure — the gaps endpoint fails closed', () => {
  beforeEach(() => {
    requireAdmin.mockReset();
    adminClient.mockReset();
  });

  it('returns the caller’s own denial unchanged for an anonymous caller (401 precedence preserved)', async () => {
    const denial = new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401 });
    requireAdmin.mockResolvedValue({ user: null, forbidden: denial });

    const { GET } = await import('@/app/api/admin/recommendations/gaps/route');
    const res = await GET();

    expect(res.status, 'anonymous callers still get 401, not the withheld-feature 503').toBe(401);
    expect(adminClient, 'no database client is ever constructed').not.toHaveBeenCalled();
  });

  it('returns the caller’s own denial unchanged for an authenticated non-admin (403 precedence preserved)', async () => {
    // Analyst, Resource Admin, Author, Editor, Compliance Reviewer, Publisher
    // and any ordinary authenticated user all reach requireAdmin's 403 path.
    const denial = new Response(JSON.stringify({ error: 'Admin access required' }), { status: 403 });
    requireAdmin.mockResolvedValue({ user: null, forbidden: denial });

    const { GET } = await import('@/app/api/admin/recommendations/gaps/route');
    const res = await GET();

    expect(res.status, 'non-admins still get 403 — they must not learn the feature state').toBe(403);
    expect(adminClient).not.toHaveBeenCalled();
  });

  it('gives an authorized Super Admin a stable unavailable contract, never the payload', async () => {
    requireAdmin.mockResolvedValue({ user: { id: 'synthetic-super-admin' }, forbidden: null });

    const { GET, GAP_REVIEW_UNAVAILABLE_CODE } = await import('@/app/api/admin/recommendations/gaps/route');
    const res = await GET();
    const body = await res.json();

    expect(res.status, 'a stable feature-unavailable status').toBe(503);
    expect(body.code).toBe(GAP_REVIEW_UNAVAILABLE_CODE);
    expect(body.code).toBe('FEATURE_WITHHELD_PENDING_PRIVACY_REVIEW');

    // The response carries NO data payload of any shape.
    expect(body).not.toHaveProperty('data');
    expect(Object.keys(body).sort()).toEqual(['code', 'error']);

    // And the explanation itself leaks nothing.
    const serialized = JSON.stringify(body);
    for (const field of PROHIBITED_FIELDS) {
      expect(serialized, `the unavailable response must not mention ${field}`).not.toContain(field);
    }
    expect(serialized).not.toMatch(/\d{3,}/); // no figure-shaped content at all
  });

  it('never constructs a database client, so no individual row is read, logged or cached', async () => {
    requireAdmin.mockResolvedValue({ user: { id: 'synthetic-super-admin' }, forbidden: null });

    const { GET } = await import('@/app/api/admin/recommendations/gaps/route');
    await GET();

    // This is the difference between "fetched then filtered" and "never
    // fetched". Only the latter is safe against logs, caches and refactors.
    expect(adminClient, 'the handler must not reach the database at all').not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Source-level invariants — locking the defect out of future refactors
// ---------------------------------------------------------------------------

describe('Wave 5 privacy closure — source invariants', () => {
  it('the route issues no query and names no sensitive field', () => {
    const src = read(ROUTE);
    // Strip comments: the handler documents WHAT it used to return, by name,
    // precisely so a future reader understands why it must not return it.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    expect(code, 'no table read').not.toContain('user_recommendation_runs');
    expect(code, 'no query builder').not.toMatch(/\.from\(/);
    expect(code, 'no select').not.toMatch(/\.select\(/);
    expect(code, 'no service-role client').not.toContain('adminClient');

    for (const field of PROHIBITED_FIELDS) {
      expect(code, `route code must not reference ${field}`).not.toContain(field);
    }

    // Authorization is still enforced, and still first.
    expect(code).toContain('requireAdmin');
    expect(code.indexOf('requireAdmin')).toBeLessThan(code.indexOf('503'));
  });

  it('the Admin client neither requests nor renders individual gap data', () => {
    const src = read(CLIENT);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // The request itself is gone — not ignored, not error-handled: gone.
    expect(code, 'no fetch of the gaps endpoint').not.toContain('/api/admin/recommendations/gaps');
    // The render path is gone.
    expect(code, 'no gap row state').not.toMatch(/setGaps|GapRun/);
    expect(code, 'no expandable per-person control').not.toContain('expandedGap');
    expect(code, 'no raw payload rendering').not.toContain('context_snapshot');

    // `variance_amount` and `variance_percentage` are deliberately excluded
    // from this particular sweep. They have a second, entirely legitimate
    // life on this screen as TEMPLATE PLACEHOLDER SYNTAX in the
    // recommendation-authoring form — the field's own placeholder text shows
    // an author how to write `{{variance_amount}}` into a financial-impact
    // template. That is library-authoring vocabulary, not any person's data.
    // Asserting their total absence would be a false positive that a future
    // maintainer would "fix" by removing real authoring guidance. Their
    // sensitive use is a value inside `context_snapshot`, and that container
    // is asserted absent above.
    const templateVocabulary = new Set(['variance_amount', 'variance_percentage']);
    for (const field of PROHIBITED_FIELDS) {
      if (templateVocabulary.has(field)) continue;
      expect(code, `client code must not reference ${field}`).not.toContain(field);
    }
    // ...and prove the excluded two really are only template vocabulary:
    // every occurrence must sit inside `{{ }}` interpolation syntax.
    for (const field of templateVocabulary) {
      for (const match of code.matchAll(new RegExp(`.{0,12}${field}.{0,4}`, 'g'))) {
        expect(match[0], `${field} may only appear as template placeholder syntax`).toMatch(/\{\{\s*\w+\s*\}\}/);
      }
    }
  });

  it('the withdrawn section presents an honest unavailable state with nothing to click', () => {
    const src = read(CLIENT);
    expect(src).toContain('Gap review — unavailable');
    // States the reason honestly, and that it applies to Super Admin too.
    expect(src).toMatch(/no\s*\n?\s*Admin role — including Super Admin — may hold standing access/);
    // Names the aggregate replacement so the capability stays traceable.
    expect(src).toMatch(/aggregated report/);
    // No placeholder affordance: the section must contain no interactive
    // element promising the withdrawn behaviour.
    const section = src.slice(src.indexOf('gap-review-heading'));
    const sectionEnd = section.indexOf('</section>');
    const sectionMarkup = section.slice(0, sectionEnd);
    expect(sectionMarkup, 'no button in the withdrawn section').not.toMatch(/<button/);
    expect(sectionMarkup, 'no link in the withdrawn section').not.toMatch(/<Link|<a\s/);
  });

  it('no export, download or client-storage path exists for gap data', () => {
    const code = read(CLIENT);
    // The client has no download/blob/storage machinery at all; assert it
    // stays that way rather than trusting today's absence.
    expect(code).not.toMatch(/createObjectURL|new Blob\(|download=/);
    expect(code).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  });

  it('the Help registry and manual both describe the task as withdrawn, with no operating steps', async () => {
    const { ADMIN_TASK_HELP } = await import('@/lib/admin/taskHelp');
    const help = ADMIN_TASK_HELP['ADM-06'];
    expect(help.availability).toBe('not_operational');
    expect(help.steps, 'no operating procedure for a withdrawn task').toHaveLength(0);
    expect(help.unavailableReason).toMatch(/privacy|financial figures/i);

    const manual = read('docs/admin/A02_WAVE5_ADMIN_TASK_MANUALS.md');
    const section = manual.slice(manual.indexOf('## ADM-06'), manual.indexOf('## ADM-07'));
    expect(section).toMatch(/withdrawn/i);
    expect(section).toMatch(/No Admin role has access, including Super Admin/i);
    // The manual must not reproduce a real figure — it contains none by
    // construction, but assert it so an edit cannot quietly add one.
    expect(section).not.toMatch(/[$₹]\s?\d/);
  });
});

// ---------------------------------------------------------------------------
// 3. The rest of Recommendations must be untouched
// ---------------------------------------------------------------------------

describe('Wave 5 privacy closure — no collateral damage', () => {
  it('the library, editing, activation and CSV import remain present and wired', () => {
    const code = read(CLIENT);
    expect(code, 'library list still fetched').toContain("fetch('/api/admin/recommendations')");
    expect(code, 'create/edit still posts').toContain("fetch('/api/admin/recommendations'");
    expect(code, 'CSV import still posts').toContain('/api/admin/recommendations/upload');
    expect(code, 'activation toggle still patches').toMatch(/\/api\/admin\/recommendations\/\$\{rec\.id\}/);
    // Wave 5's own UX fixes on this screen must survive the closure.
    expect(code, 'activation still confirms').toContain('Deactivate this recommendation?');
    expect(code, 'outcomes still announced').toContain('AdminActionStatus');
    expect(code, 'Help still present').toContain('AdminTaskHelp');
  });

  it('the other Recommendations routes are untouched by this closure', () => {
    // Only the gaps route changed; the Pattern-B RPC routes and their
    // integrity invariants are outside this closure's scope entirely.
    for (const route of [
      'app/api/admin/recommendations/route.ts',
      'app/api/admin/recommendations/[id]/route.ts',
      'app/api/admin/recommendations/upload/route.ts',
    ]) {
      const src = read(route);
      expect(src, `${route} still enforces admin authorization`).toContain('requireAdmin');
    }
    expect(read('app/api/admin/recommendations/route.ts')).toContain('admin_upsert_recommendation_atomic');
    expect(read('app/api/admin/recommendations/upload/route.ts')).toContain('admin_import_recommendation_conditions');
  });
});
