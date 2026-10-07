// Walkthrough 07-10-2026 defect: at 390 px the "Choose a template" select on /admin/resources/money-updates/new grew to the width of its
// longest option title (page scrollWidth 593 px against a 390 px viewport), so the whole page scrolled sideways. The select must be able to
// shrink to its container.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.resolve(__dirname, '../../components/resources/money-update/MoneyUpdateNewChooser.tsx'), 'utf8');
const selectTag = src.match(/<select id="template-select"[^>]*>/)?.[0] ?? '';

describe('Money Update template chooser at phone width', () => {
  it('finds the template select', () => {
    expect(selectTag).not.toBe('');
  });
  it('the select is capped to its container (max-w-full) so a long template title cannot widen the page', () => {
    expect(selectTag).toMatch(/\bmax-w-full\b/);
  });
  it('the select may shrink inside its flex row (min-w-0)', () => {
    expect(selectTag).toMatch(/\bmin-w-0\b/);
  });
});
