// Walkthrough finding D3 (07/10/2026): after the first Save of an editor (create, then PATCH with the rest of the form),
// editing during the second request showed "Save failed" and the "updated elsewhere" dialog although nobody else had
// touched the record.
//
// CAUSE: the optimistic-concurrency token (updated_at) was React state. A save that is requested while another is in
// flight is queued and, when the first finishes, run from `doSaveRef.current`, the callback of the last RENDERED
// closure. The response handler calls the state setter and then, in `finally`, runs the queued save in the same tick,
// before React has re-rendered, so the queued save sent the token from before the response and the API answered 409.
// FIX: the token is a ref written synchronously by every response handler and read by the save at send time.
//
// EVIDENCE LABEL: UNIT-TESTED by a source contract. The repo has no jsdom, so the timing itself is not simulated in a
// DOM; the contract below fails on the previous source (see the report for the run against the base) and passes now.
// Not browser-verified.
//
// NAMED NEGATIVE CONTROL NC-D3: the checker is run against the previous source shape and must report a violation.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const EDITORS = [
  'components/resources/glossary/GlossaryEditor.tsx',
  'components/resources/editor/ResourceEditor.tsx',
  'components/resources/money-update/MoneyUpdateEditor.tsx',
  'components/resources/video/VideoEditor.tsx',
];

export function tokenViolations(src: string): string[] {
  const v: string[] = [];
  if (!/const lastUpdatedAtRef = useRef\(initialPost\.updated_at\)/.test(src)) v.push('the version token is not a ref initialised from the post');
  if (/useState\(initialPost\.updated_at\)/.test(src)) v.push('the version token is still state');
  if (/setLastUpdatedAt\(/.test(src)) v.push('a response handler still sets the token through state');
  if (!/(let expectedUpdatedAt = lastUpdatedAtRef\.current;|expectedUpdatedAt: lastUpdatedAtRef\.current,)/.test(src)) v.push('the save does not read the token from the ref at send time');
  if (/expectedUpdatedAt(:| =) lastUpdatedAt\b(?!Ref)/.test(src)) v.push('the save reads a state value of the token');
  const writes = (src.match(/lastUpdatedAtRef\.current = /g) ?? []).length;
  if (writes < 2) v.push(`only ${writes} place(s) refresh the token from a server response (create, save and workflow transition all return a new updated_at)`);
  // every response that returns a new updated_at must refresh the token
  for (const m of src.matchAll(/json\.data\.updated_at/g)) {
    const around = src.slice(Math.max(0, m.index! - 80), m.index! + 40);
    if (!/lastUpdatedAtRef\.current = json\.data\.updated_at/.test(around)) v.push('a response with a new updated_at does not refresh the token');
  }
  return v;
}

describe('D3: the version token is read at send time, so a queued save never sends a stale one', () => {
  for (const f of EDITORS) {
    it(`${path.basename(f)} keeps the token in a ref written by every response handler`, () => {
      expect(tokenViolations(fs.readFileSync(path.join(ROOT, f), 'utf8'))).toEqual([]);
    });
  }

  it('NC-D3: the checker reports every violation on the previous source shape', () => {
    const before = [
      "const [lastUpdatedAt, setLastUpdatedAt] = useState(initialPost.updated_at);",
      "let expectedUpdatedAt = lastUpdatedAt;",
      "setLastUpdatedAt(json.data.updated_at);",
    ].join('\n');
    const found = tokenViolations(before);
    expect(found).toEqual(
      expect.arrayContaining([
        'the version token is not a ref initialised from the post',
        'the version token is still state',
        'a response handler still sets the token through state',
        'the save does not read the token from the ref at send time',
      ])
    );
    expect(found.length).toBeGreaterThanOrEqual(4);
  });

  it('the queued save and the guard against a concurrent save are still in place (the fix did not remove them)', () => {
    for (const f of EDITORS) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      expect(src, f).toMatch(/queuedSaveRef\.current = true/);
      expect(src, f).toMatch(/savingRef\.current/);
      expect(src, f).toMatch(/doSaveRef\.current\?\.\(false\)/);
    }
  });
});
