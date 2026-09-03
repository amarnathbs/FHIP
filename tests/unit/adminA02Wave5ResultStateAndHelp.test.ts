// Admin A0.2 Wave 5 — focused unit coverage for the logic this Wave added.
//
// Three groups:
//   1. The shared client-side result-state classifier — the module that makes
//      §9's taxonomy real on screen, and that is the single choke point
//      stopping raw database/transport strings reaching an administrator.
//   2. The in-product Help registry — its own internal consistency, and its
//      parity with the operator manual, which is what stops the product and
//      the documentation drifting apart silently (§15, §16).
//   3. Source-level invariants this Wave establishes across the Admin
//      surface. These are deliberately asserted against the real files
//      rather than a mock: the defects they lock out (a native alert(), a
//      verbatim `json.error`, a response whose outcome is never inspected)
//      are all textual patterns that a future edit could reintroduce without
//      any behavioural test noticing.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  actionFailureMessage,
  failureFromResponse,
  failureFromThrown,
  isSafeServerMessage,
  readJsonSafely,
} from '@/lib/resources/admin/resultState';
import { ADMIN_TASK_HELP, ADMIN_TASK_IDS, getTaskHelp } from '@/lib/admin/taskHelp';

const REPO = process.cwd();

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), 'utf8');
}

/**
 * Removes `//` and block comments so an assertion about operator-facing copy
 * is not tripped by a code comment that quotes the very string it explains
 * having removed.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// ---------------------------------------------------------------------------
// 1. Result-state classification
// ---------------------------------------------------------------------------

describe('Wave 5 — result-state classification (§9)', () => {
  it('maps every named HTTP outcome to its own distinct state', () => {
    const subject = 'Resources content';
    expect(failureFromResponse(401, null, subject).state).toBe('forbidden');
    expect(failureFromResponse(403, null, subject).state).toBe('forbidden');
    expect(failureFromResponse(404, null, subject).state).toBe('not_found');
    expect(failureFromResponse(409, null, subject).state).toBe('conflict');
    expect(failureFromResponse(422, null, subject).state).toBe('validation_error');
    expect(failureFromResponse(400, null, subject).state).toBe('validation_error');
    expect(failureFromResponse(503, null, subject).state).toBe('unavailable');
    expect(failureFromResponse(502, null, subject).state).toBe('unavailable');
    expect(failureFromResponse(504, null, subject).state).toBe('unavailable');
    expect(failureFromResponse(500, null, subject).state).toBe('error');
  });

  it('never offers a retry for an outcome retrying cannot fix', () => {
    // This is the specific defect the Wave found: a 403 rendered in a red
    // "Try again" panel with a Retry button that could never succeed.
    expect(failureFromResponse(401, null, 'x').retryable).toBe(false);
    expect(failureFromResponse(403, null, 'x').retryable).toBe(false);
    expect(failureFromResponse(404, null, 'x').retryable).toBe(false);
    expect(failureFromResponse(422, null, 'x').retryable).toBe(false);
    // ...and does offer one where it genuinely might.
    expect(failureFromResponse(503, null, 'x').retryable).toBe(true);
    expect(failureFromResponse(500, null, 'x').retryable).toBe(true);
    expect(failureFromResponse(409, null, 'x').retryable).toBe(true);
    expect(failureFromThrown(new Error('Failed to fetch'), 'x').retryable).toBe(true);
  });

  it('gives every failure a specific headline naming what could not be loaded', () => {
    const f = failureFromResponse(500, null, 'the CTA library');
    expect(f.title).toContain('the CTA library');
    // Not the single hardcoded string every screen shared before this Wave.
    expect(f.title).not.toContain("We couldn't load Resources content");
  });

  it('forwards a curated server message but refuses an engine-shaped one', () => {
    const curated = { error: 'Cannot remove the final active Resource Administrator.' };
    expect(failureFromResponse(422, curated, 'x').message).toBe(curated.error);

    const leaks = [
      'duplicate key value violates unique constraint "resource_user_roles_user_id_role_key"',
      'new row violates row-level security policy for table "resource_posts"',
      'null value in column "title" violates not-null constraint',
      'permission denied for table benchmark_sources',
      'relation "resource_posts" does not exist',
      'function public.admin_transition_benchmark_source(uuid, text) does not exist',
      "SyntaxError: Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON",
      'Failed to fetch',
      'PGRST116: JSON object requested, multiple (or no) rows returned',
    ];
    for (const leak of leaks) {
      expect(isSafeServerMessage(leak), `should refuse: ${leak}`).toBe(false);
      const shown = failureFromResponse(500, { error: leak }, 'x').message;
      expect(shown, `should not render: ${leak}`).not.toContain(leak);
    }
  });

  it('refuses a non-string or absurdly long server message', () => {
    expect(isSafeServerMessage(undefined)).toBe(false);
    expect(isSafeServerMessage(null)).toBe(false);
    expect(isSafeServerMessage(42)).toBe(false);
    expect(isSafeServerMessage({ nested: 'object' })).toBe(false);
    expect(isSafeServerMessage('')).toBe(false);
    expect(isSafeServerMessage('  ')).toBe(false);
    expect(isSafeServerMessage('x'.repeat(401))).toBe(false);
    expect(isSafeServerMessage('A short, curated sentence.')).toBe(true);
  });

  it('never lets a thrown transport error surface its own text', () => {
    const f = failureFromThrown(new Error('NetworkError when attempting to fetch resource'), 'Videos');
    expect(f.message).not.toContain('NetworkError');
    expect(f.message).toContain('Videos');
  });

  it('readJsonSafely returns null instead of throwing on a non-JSON body', async () => {
    const htmlPage = new Response('<!DOCTYPE html><html><body>502 Bad Gateway</body></html>', { status: 502 });
    await expect(readJsonSafely(htmlPage)).resolves.toBeNull();

    // 204 forbids a body per the WHATWG spec, so the null-body form is the
    // only constructible one — and is exactly what a real 204 delivers.
    const empty = new Response(null, { status: 204 });
    await expect(readJsonSafely(empty)).resolves.toBeNull();

    const jsonArray = new Response('[1,2,3]', { status: 200 });
    // An array is valid JSON but is not the object envelope the callers read.
    await expect(readJsonSafely(jsonArray)).resolves.toEqual([1, 2, 3]);

    const ok = new Response('{"error":"Nope."}', { status: 422 });
    await expect(readJsonSafely(ok)).resolves.toEqual({ error: 'Nope.' });
  });

  it('action failures name the action and never leak an engine string', () => {
    expect(actionFailureMessage(403, null, 'remove this role')).toContain('remove this role');
    expect(actionFailureMessage(404, null, 'remove this role')).toMatch(/no longer exists/i);
    expect(actionFailureMessage(409, null, 'remove this role')).toMatch(/changed this first/i);
    const leaked = actionFailureMessage(500, { error: 'permission denied for table resource_user_roles' }, 'assign this role');
    expect(leaked).not.toContain('resource_user_roles');
    expect(actionFailureMessage(422, { error: 'That role is already assigned.' }, 'assign this role')).toBe('That role is already assigned.');
  });
});

// ---------------------------------------------------------------------------
// 2. In-product Help registry, and its parity with the manual
// ---------------------------------------------------------------------------

describe('Wave 5 — in-product Help registry (§15, §17)', () => {
  const MANUAL = read('docs/admin/A02_WAVE5_ADMIN_TASK_MANUALS.md');

  it('every registry entry is internally complete', () => {
    for (const id of ADMIN_TASK_IDS) {
      const help = ADMIN_TASK_HELP[id];
      expect(help.taskId, `${id} taskId matches its key`).toBe(id);
      expect(help.name.length, `${id} has a name`).toBeGreaterThan(0);
      expect(help.purpose.length, `${id} has a purpose`).toBeGreaterThan(0);
      expect(help.nextStep.length, `${id} states a next step`).toBeGreaterThan(0);
      if (help.availability === 'operational') {
        expect(help.steps.length, `${id} is operational so it must have steps`).toBeGreaterThan(0);
        expect(help.successEvidence.length, `${id} states how you know it worked`).toBeGreaterThan(0);
        expect(help.reversal.length, `${id} states how to undo it`).toBeGreaterThan(0);
      } else {
        // §16: an unavailable future function gets an availability
        // explanation, never a fake operating procedure.
        expect(help.steps, `${id} is not operational so it must have no steps`).toHaveLength(0);
        expect(help.unavailableReason, `${id} must explain why it is unavailable`).toBeTruthy();
      }
    }
  });

  it('never describes deferred functionality as operational', () => {
    expect(getTaskHelp('ADM-10')?.availability).toBe('not_operational');
    expect(getTaskHelp('ADM-19')?.availability).toBe('not_operational');
    expect(getTaskHelp('ADM-10')?.unavailableReason).toMatch(/not available in this release/i);
    expect(getTaskHelp('ADM-19')?.unavailableReason).toMatch(/no analytics/i);
  });

  it('exposes no route, RPC, table or repository path to operators', () => {
    // §15: "avoid raw route/RPC details in operator instructions".
    const forbidden = [/\/api\//, /\bRPC\b/, /supabase/i, /migration/i, /docs\//, /\.tsx?\b/, /resource_posts/, /admin_users/];
    for (const id of ADMIN_TASK_IDS) {
      const help = ADMIN_TASK_HELP[id];
      const prose = [help.purpose, help.eligibleRoles, ...help.prerequisites, ...help.steps, help.successEvidence, help.reversal, help.nextStep, help.unavailableReason ?? ''].join(' \n ');
      for (const pattern of forbidden) {
        expect(prose, `${id} must not expose ${pattern} to an operator`).not.toMatch(pattern);
      }
    }
  });

  it('every registry task also has a manual section, and vice versa', () => {
    for (const id of ADMIN_TASK_IDS) {
      expect(MANUAL, `${id} must have a manual section`).toContain(`## ${id} —`);
      expect(MANUAL, `${id} must appear in the central index`).toContain(`| ${id} |`);
    }
    // Every ADM-nn heading in the manual must resolve to a registry entry or
    // be one of the two documented no-UI tasks. ADM-20 is the shared
    // capability check (no page, so no in-page Help is possible).
    const headings = [...MANUAL.matchAll(/^## (ADM-\d+) —/gm)].map((m) => m[1]);
    const noPageTasks = new Set(['ADM-20']);
    for (const heading of headings) {
      if (noPageTasks.has(heading)) continue;
      expect(ADMIN_TASK_IDS, `${heading} has a manual but no Help entry`).toContain(heading);
    }
  });

  it('every taskId referenced by a component exists in the registry', () => {
    const files = [
      'components/resources/admin/ResourceUsersClient.tsx',
      'components/resources/admin/ResourcesDashboardClient.tsx',
      'components/resources/admin/ResourceContentListClient.tsx',
      'components/admin/AdminBenchmarksClient.tsx',
      'components/admin/AdminRecommendationsClient.tsx',
      'components/resources/related/RelatedContentManager.tsx',
      'components/resources/context/ContextMappingManager.tsx',
      'components/resources/cta/CtaListClient.tsx',
      'components/resources/faq/FaqEditor.tsx',
      'components/resources/faq/FaqListClient.tsx',
      'components/resources/video/VideoListClient.tsx',
      'components/resources/glossary/GlossaryListClient.tsx',
      'components/resources/money-update/MoneyUpdateListClient.tsx',
      'components/resources/editor/ResourceEditor.tsx',
      'components/resources/video/VideoEditor.tsx',
      'components/resources/glossary/GlossaryEditor.tsx',
      'components/resources/money-update/MoneyUpdateEditor.tsx',
    ];
    let literalRefs = 0;
    for (const file of files) {
      const src = read(file);
      expect(src, `${file} must render the Help disclosure`).toContain('AdminTaskHelp');
      for (const match of src.matchAll(/taskId=["'](ADM-\d+)["']/g)) {
        literalRefs++;
        expect(ADMIN_TASK_IDS, `${file} references unknown task ${match[1]}`).toContain(match[1]);
      }
    }
    expect(literalRefs, 'most Help wiring is a literal task id').toBeGreaterThan(0);

    // Two files choose their task id dynamically rather than literally, so
    // the scan above cannot see them. Check each one's source of ids
    // explicitly, otherwise a typo there would silently render no Help.
    const contentList = read('components/resources/admin/ResourceContentListClient.tsx');
    const contentListIds = [...contentList.matchAll(/'(ADM-\d+)'/g)].map((m) => m[1]);
    expect(contentListIds.length, 'the queue/non-queue Help ids are present').toBe(2);
    for (const id of contentListIds) expect(ADMIN_TASK_IDS).toContain(id);

    const benchmarks = read('components/admin/AdminBenchmarksClient.tsx');
    const benchmarkIds = [...benchmarks.matchAll(/helpTaskId: '(ADM-\d+)'/g)].map((m) => m[1]);
    expect(benchmarkIds.length, 'every Benchmarks tab declares a Help task').toBe(6);
    for (const id of benchmarkIds) expect(ADMIN_TASK_IDS).toContain(id);
  });
});

// ---------------------------------------------------------------------------
// 3. Admin-surface invariants this Wave establishes
// ---------------------------------------------------------------------------

describe('Wave 5 — Admin surface invariants', () => {
  const ADMIN_COMPONENTS = [
    'components/admin/AdminBenchmarksClient.tsx',
    'components/admin/AdminRecommendationsClient.tsx',
    'components/resources/admin/ResourceUsersClient.tsx',
    'components/resources/admin/ResourcesDashboardClient.tsx',
    'components/resources/admin/ResourceContentListClient.tsx',
    'components/resources/context/ContextMappingManager.tsx',
    'components/resources/related/RelatedContentManager.tsx',
    'components/resources/cta/CtaListClient.tsx',
    'components/resources/cta/CtaForm.tsx',
    'components/resources/faq/FaqEditor.tsx',
    'components/resources/editor/WorkflowPanel.tsx',
  ];

  it('no Admin surface uses a native browser dialog', () => {
    // Benchmarks was the last holdout: 5 alert() and 2 confirm() calls,
    // despite the app having had its own ConfirmDialog primitive since the
    // sign-out flow was built.
    for (const file of ADMIN_COMPONENTS) {
      const src = read(file);
      expect(src, `${file} must not call window.alert`).not.toMatch(/(^|[^.\w])alert\s*\(/m);
      expect(src, `${file} must not call window.confirm`).not.toMatch(/(^|[^.\w])confirm\s*\(/m);
    }
  });

  it('the shared confirm dialog traps focus, restores it, and defaults to the safe choice', () => {
    const src = read('components/ui/ConfirmDialog.tsx');
    expect(src, 'declares itself modal').toContain('aria-modal="true"');
    expect(src, 'traps Tab inside the dialog').toMatch(/e\.key !== 'Tab'|key === 'Tab'/);
    expect(src, 'restores focus to the opener on close').toMatch(/returnFocusRef/);
    expect(src, 'ids are per-instance, not hardcoded').toContain('useId()');
    expect(src, "defaults focus to Cancel, not the destructive action").toContain("initialFocus = 'cancel'");
    expect(src, 'still closes on Escape').toContain("e.key === 'Escape'");
  });

  it('the two mutation helpers that fed raw Postgres text to the screen no longer do', () => {
    const roles = read('lib/resources/admin/userRoles.ts');
    // The six `error.message` / `findErr.message` returns are gone.
    expect(roles).not.toMatch(/return \{ ok: false, error: (findErr|error)\.message \}/);
    expect(roles, 'routes failures through a safe mapper').toContain('safeRoleError');
    // The deliberate, curated domain message is still returned unchanged.
    expect(roles).toContain('Cannot remove the final active Resource Administrator');

    const workflow = read('lib/resources/workflow.ts');
    // The RPC's own authored `raise exception` messages (SQLSTATE P0001)
    // still pass through — that behaviour was correct and is preserved.
    expect(workflow).toContain("error.code === 'P0001'");
    // But an unmapped engine error no longer becomes a 403 carrying its own text.
    expect(workflow).toMatch(/isAuthoredRuleMessage/);
    expect(workflow).toContain('unexpected database error during transition');
  });

  it('the route error boundary shows a correlation reference, never the raw message', () => {
    const src = read('app/(app)/admin/resources/error.tsx');
    expect(src, 'no raw message rendered').not.toMatch(/message=\{error\.message/);
    expect(src, 'shows the digest instead').toContain('error.digest');
  });

  it('the editors actually send the Featured field they let an operator change', () => {
    // The defect: a checkbox that marked the form dirty, reported "Saved",
    // and discarded the value. `is_featured` is consumed by the public
    // Resources landing page, so this was a silent, load-bearing loss.
    expect(read('lib/resources/editor/types.ts')).toContain('is_featured?: boolean;');
    // Written only when supplied, so a caller that omits it cannot silently
    // un-feature content by having `false` invented on its behalf.
    expect(read('lib/resources/editor/mutations.ts')).toContain('patch.is_featured === undefined ? {} : { is_featured: patch.is_featured }');
    for (const editor of [
      'components/resources/editor/ResourceEditor.tsx',
      'components/resources/video/VideoEditor.tsx',
      'components/resources/glossary/GlossaryEditor.tsx',
      'components/resources/money-update/MoneyUpdateEditor.tsx',
    ]) {
      expect(read(editor), `${editor} must send is_featured`).toContain('is_featured: meta.isFeatured');
    }
  });

  it('all four content editors use one save label, and the shared panel does not contradict it', () => {
    for (const editor of [
      'components/resources/editor/ResourceEditor.tsx',
      'components/resources/video/VideoEditor.tsx',
      'components/resources/glossary/GlossaryEditor.tsx',
      'components/resources/money-update/MoneyUpdateEditor.tsx',
    ]) {
      expect(read(editor), `${editor} uses the shared save label`).toContain("'Save Changes'");
    }
    // Assert on the RENDERED copy, not the whole file: the panel's own
    // explanatory comment quotes the old strings in order to explain why
    // they were removed, and that commentary is not operator-facing.
    const panel = stripComments(read('components/resources/editor/RevisionHistoryPanel.tsx'));
    expect(panel, 'no longer names a button three of its four hosts do not have').not.toContain('Save Draft');
    expect(panel, 'no longer cites an internal engineering document').not.toContain('completion report');
  });

  it('publishing requires an explicit confirmation that names the effect', () => {
    const src = read('components/resources/editor/WorkflowPanel.tsx');
    expect(src, 'Publish carries confirmation copy').toContain('Publish this content now?');
    expect(src, 'the copy states the real effect').toMatch(/publicly visible on the FHIP Resources site immediately/);
    expect(src, 'the two send-back actions are distinguishable').toContain('Send Back to Draft (editorial)');
    expect(src, 'the two send-back actions are distinguishable').toContain('Send Back to Draft (compliance)');
    expect(src, 'a completed transition is announced').toContain('AdminActionStatus');
  });

  it('the mutations that ignored their own responses now check them', () => {
    const context = read('components/resources/context/ContextMappingManager.tsx');
    // Previously: `await fetch(...); await load(...)` with no inspection.
    expect(context).not.toMatch(/await fetch\(`\/api\/admin\/resources\/context\/\$\{[^}]+\}`, \{ method: 'DELETE' \}\);\s*\n\s*await load/);
    expect(context, 'reports the outcome').toContain('actionFailureMessage');
    expect(context, 'reconciles the reorder against the server').toContain('the order that is actually stored');

    const related = read('components/resources/related/RelatedContentManager.tsx');
    expect(related, 'remove is confirmed').toContain('Remove this related item?');
    expect(related, 'remove reports its outcome').toContain('actionFailureMessage');

    const faq = read('components/resources/faq/FaqEditor.tsx');
    expect(faq, 'unlink checks its response').toMatch(/if \(!res\.ok && res\.status !== 404\)/);
  });

  it('a save requested during an in-flight save is queued, not dropped, in all four editors', () => {
    // The original guard was `if (savingRef.current) return;` — the newer
    // edits were silently discarded, with no retry and no signal. Combined
    // with the unconditional `setDirty(false)` below, the editor could sit
    // reading "Saved" while holding genuinely unsaved work.
    for (const editor of [
      'components/resources/editor/ResourceEditor.tsx',
      'components/resources/video/VideoEditor.tsx',
      'components/resources/glossary/GlossaryEditor.tsx',
      'components/resources/money-update/MoneyUpdateEditor.tsx',
    ]) {
      // Comments stripped: the fix's own explanatory comment quotes the old
      // guard in order to explain why it was replaced.
      const src = stripComments(read(editor));
      expect(src, `${editor} must not silently drop a concurrent save`).not.toMatch(/if \(savingRef\.current\) return;/);
      expect(src, `${editor} queues the concurrent save`).toContain('queuedSaveRef.current = true;');
      expect(src, `${editor} drains the queue when the in-flight save finishes`).toContain('void doSaveRef.current?.(false);');
    }
  });

  it('no editor claims "Saved" for content that changed while the save was in flight', () => {
    for (const editor of [
      'components/resources/editor/ResourceEditor.tsx',
      'components/resources/video/VideoEditor.tsx',
      'components/resources/glossary/GlossaryEditor.tsx',
      'components/resources/money-update/MoneyUpdateEditor.tsx',
    ]) {
      const src = stripComments(read(editor));
      // `setDirty(false)` must now be reached only through the
      // edit-counter comparison, never unconditionally on success.
      expect(src, `${editor} guards the clean state on an edit counter`).toContain('changeSeqRef.current === seqAtStart');
      expect(src, `${editor} records the counter at save start`).toContain('const seqAtStart = changeSeqRef.current;');
      expect(src, `${editor} increments the counter on every edit`).toContain('changeSeqRef.current += 1;');
    }
  });

  it('the shared empty/error/unavailable states are distinguishable by role', () => {
    const src = read('components/resources/admin/ResourceStates.tsx');
    // A retryable failure is an alert with a Retry; a non-retryable one is a
    // neutral status with none. Conflating them was the original defect.
    expect(src).toContain('ResourceUnavailableState');
    expect(src).toContain('ResourceFailureState');
    expect(src).toMatch(/if \(!failure\.retryable\)/);
    // The headline is no longer a single hardcoded string for every screen.
    expect(src).toContain('title?: string');
  });
});
