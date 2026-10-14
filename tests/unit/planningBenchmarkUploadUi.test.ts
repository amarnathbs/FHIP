// Planning Benchmarks staged upload (F5): UI contract. Evidence label: UNIT-TESTED (source contract plus server
// render of the initial state). Not browser-verified. The repo has no jsdom, so interaction is covered by the route
// and PGlite tests; this file pins what a person reads and the confirmation step.
//
// NAMED NEGATIVE CONTROL
//   NC-UI1  the date check really bites: a source containing a year-first literal is flagged.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { PlanningBenchmarkUpload } from '@/components/admin/PlanningBenchmarkUpload';
import { parseAdminCapabilities, NO_ADMIN_CAPABILITIES } from '@/lib/admin/adminNav';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const yearFirst = (s: string) => /\b(19|20)\d{2}-\d{2}-\d{2}\b/.test(s) || /yyyy-mm-dd/i.test(s);

describe('F5 UI contract', () => {
  it('the screen source and the upload page contain no year-first date text', () => {
    expect(yearFirst(read('components/admin/PlanningBenchmarkUpload.tsx'))).toBe(false);
    expect(yearFirst(read('app/(app)/admin/benchmarks/upload/page.tsx'))).toBe(false);
  });

  it('NC-UI1: the date check flags a year-first literal', () => {
    expect(yearFirst('Staged 2026-10-06')).toBe(true);
    expect(yearFirst('Staged 06/10/2026')).toBe(false);
  });

  it('Activate always goes through a confirmation dialog that states what goes live and that it replaces (keeps) history', () => {
    const src = read('components/admin/PlanningBenchmarkUpload.tsx');
    expect(src).toContain('<ConfirmDialog');
    expect(src).toContain('Activate this upload?');
    expect(src).toContain('will go live for every FHIP user now');
    expect(src).toContain('kept as history');
    // the Activate API is only called from the confirm handler
    expect(src.match(/void activate\(\)/g)?.length).toBe(1);
  });

  it('the initial server render is an explicit loading state (never an empty healthy-looking form)', () => {
    const html = renderToStaticMarkup(createElement(PlanningBenchmarkUpload));
    expect(html).toMatch(/Loading/i);
    expect(html).not.toMatch(/No upload has been staged yet/);
  });

  it('the Upload tab and Activate button follow the two capability flags, which default to false', () => {
    expect(NO_ADMIN_CAPABILITIES.planningBenchmarkUpload).toBe(false);
    expect(NO_ADMIN_CAPABILITIES.planningBenchmarkActivate).toBe(false);
    expect(parseAdminCapabilities({ data: { capabilities: { planningBenchmarkUpload: 'true' } } }).planningBenchmarkUpload).toBe(false);
  });
});
