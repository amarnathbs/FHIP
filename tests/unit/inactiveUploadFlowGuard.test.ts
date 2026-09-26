/**
 * INS-00: insurance and the AIE-fronted intakes have NO active user flow, and
 * are held in the registry as `not_active` (never certified). This guard fails
 * the moment a page or component starts calling one of those intake routes
 * while it is still `not_active` -- so activating a flow forces the registry
 * (lib/canonical-data/disposition/insurance.ts) and the matrix to be updated
 * first.
 *
 * Comments are stripped before matching: app/(app)/aie-review/page.tsx names
 * the insurance intake in prose, which is not a caller.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { FIELD_DISPOSITION_REGISTRY, INACTIVE_UPLOAD_FLOWS } from '@/lib/canonical-data/disposition';

const ROOT = path.resolve(__dirname, '../..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => {
    const i = l.indexOf('//');
    // keep URLs like 'https://' intact: only strip a `//` that starts a comment
    return i === -1 || /['"`][^'"`]*$/.test(l.slice(0, i)) ? l : l.slice(0, i);
  }).join('\n');
}

/** UI files: every page/component, but not the API route handlers themselves. */
function uiFiles(): string[] {
  const apiDir = path.join(ROOT, 'app', 'api');
  return [...walk(path.join(ROOT, 'app')).filter((f) => !f.startsWith(apiDir)), ...walk(path.join(ROOT, 'components'))];
}

export function callersOf(route: string, files: { file: string; code: string }[]): string[] {
  // The route followed by a non-path character (so '/api/aie/intake' does not
  // match '/api/aie/intake-something', but does match '/api/aie/intake' and
  // '/api/aie/intake/{id}/...').
  const re = new RegExp(`${route.replace(/[/.]/g, '\\$&')}(?![A-Za-z0-9_-])`);
  return files.filter((f) => re.test(f.code)).map((f) => path.relative(ROOT, f.file));
}

describe('inactive upload flows stay inactive until the registry says otherwise (INS-00)', () => {
  const files = uiFiles().map((file) => ({ file, code: stripComments(fs.readFileSync(file, 'utf8')) }));

  it('scans a real UI tree', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  for (const flow of INACTIVE_UPLOAD_FLOWS) {
    it(`${flow.route}: no page or component calls it while it is ${flow.status}`, () => {
      if (flow.status !== 'not_active') return;
      expect(callersOf(flow.route, files)).toEqual([]);
    });
  }

  it('insurance registry entries are all not_active while the insurance intake is inactive', () => {
    const flow = INACTIVE_UPLOAD_FLOWS.find((f) => f.route === '/api/aie/insurance/intake')!;
    expect(flow.status).toBe('not_active');
    expect(FIELD_DISPOSITION_REGISTRY.filter((e) => e.adapter === 'insurance').every((e) => e.status === 'not_active')).toBe(true);
  });

  it('negative control: a component that fetches the insurance intake IS detected', () => {
    const fake = [{ file: path.join(ROOT, 'components', 'insurance', 'FakeUpload.tsx'), code: stripComments("await fetch('/api/aie/insurance/intake', { method: 'POST' });") }];
    expect(callersOf('/api/aie/insurance/intake', fake)).toEqual([path.join('components', 'insurance', 'FakeUpload.tsx')]);
    const templated = [{ file: path.join(ROOT, 'components', 'X.tsx'), code: 'fetch(`/api/aie/intake/${id}/accept`)' }];
    expect(callersOf('/api/aie/intake', templated)).toHaveLength(1);
  });

  it('negative control: the prose mention in aie-review/page.tsx is a comment, not a caller', () => {
    const page = path.join(ROOT, 'app', '(app)', 'aie-review', 'page.tsx');
    const raw = fs.readFileSync(page, 'utf8');
    expect(raw).toContain('/api/aie/insurance/intake'); // the mention exists...
    expect(callersOf('/api/aie/insurance/intake', [{ file: page, code: stripComments(raw) }])).toEqual([]); // ...and is not a call
  });
});
