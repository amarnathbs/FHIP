/**
 * "Remember this payee next time" starts UNTICKED (PO decision, 2026-09-26).
 * R8 spec 47: a personal classification rule may only come from a deliberate
 * user action, so the review must never create one unless the box is ticked.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const src = fs.readFileSync(
  path.resolve(__dirname, '..', '..', 'app', '(app)', 'financial-data-hub', 'review', 'StatementCategoryReview.tsx'),
  'utf8',
);

describe('the remember-payee box starts unticked', () => {
  it('both the rendered box and the value sent default to false', () => {
    expect(src).toMatch(/checked=\{remember\[item\.id\] \?\? false\}/);
    expect(src).toMatch(/const rememberPayee = remember\[item\.id\] \?\? false;/);
    expect(src).not.toMatch(/remember\[item\.id\] \?\? true/);
  });
});
