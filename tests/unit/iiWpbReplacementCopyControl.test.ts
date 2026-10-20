// Document2 (4) WP-B -- the replacement-copy control: wording of every outcome and its initial rendered state.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReplacementCopyControl, describeReplacementOutcome } from '@/components/investment-intelligence/ReplacementCopyControl';

describe('describeReplacementOutcome', () => {
  it('attach success says it is being processed', () => {
    expect(describeReplacementOutcome('attach', {}, true)).toEqual({ ok: true, message: 'Replacement copy attached. Processing it now.' });
  });
  it('attach failure shows the server message (a duplicate of another statement, a bad file...) and never a generic failure when one exists', () => {
    const r = describeReplacementOutcome('attach', { error: 'file_belongs_to_another_statement', message: 'This exact file is already attached to a different statement of yours.' }, false);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/different statement/);
  });
  it('process success promises no duplicates', () => {
    const r = describeReplacementOutcome('process', { data: { ok: true, status: 'parsed' } }, true);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/no duplicate holdings or transactions/);
  });
  it('a wrong or missing password is named, so the person can retry', () => {
    const r = describeReplacementOutcome('process', { data: { ok: false, status: 'password_required', error: 'x' } }, true);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/password was missing or wrong/);
  });
  it('another processing failure shows its specific error', () => {
    expect(describeReplacementOutcome('process', { data: { ok: false, status: 'parse_failed', error: 'Statement source/format could not be confidently identified.' } }, true).message).toMatch(/could not be confidently identified/);
  });
});

describe('ReplacementCopyControl markup', () => {
  const html = renderToStaticMarkup(createElement(ReplacementCopyControl, { documentId: 'doc1' }));
  it('offers a PDF file picker, an optional password box and a button that starts disabled until a file is chosen (duplicate-submission guard)', () => {
    expect(html).toContain('type="file"');
    expect(html).toContain('accept=".pdf,application/pdf"');
    expect(html).toContain('type="password"');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Upload replacement copy<\/button>/);
  });
  it('can omit the password box', () => {
    expect(renderToStaticMarkup(createElement(ReplacementCopyControl, { documentId: 'doc1', needsPassword: false }))).not.toContain('type="password"');
  });
});
