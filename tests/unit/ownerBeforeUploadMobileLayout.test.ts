// DEV browser certification at 375px found the Statements & data page 32px wider than the screen (horizontal page scroll): each statement row
// kept its badge, password box and Reprocess button on ONE line (`flex items-center`, no wrap), so a long badge such as
// "2 positions need attention" pushed the Reprocess button off screen. The page that hosts the owner selector and the conflict panel must not
// scroll sideways on a phone.
//
// NAMED NEGATIVE CONTROL: the check really bites -- the pre-fix markup (the same container without flex-wrap) is flagged.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'components', 'investment-intelligence', 'InvestmentIntelligenceClient.tsx'), 'utf8');

/** the class list of the container that holds a statement row's badge, password box and action buttons */
function rowActionContainerClass(source: string): string | null {
  const row = source.indexOf('function renderDocumentRow');
  if (row < 0) return null;
  const m = source.slice(row).match(/<StatusBadge status=\{doc\.status\} \/>/);
  if (!m || m.index === undefined) return null;
  const before = source.slice(row, row + m.index);
  const all = [...before.matchAll(/<div className="([^"]*)">/g)];
  return all.length ? all[all.length - 1][1] : null;
}

describe('Statements & data: a statement row wraps on a narrow screen', () => {
  it('the badge / password / button container may wrap (no sideways page scroll at 375px)', () => {
    const cls = rowActionContainerClass(src);
    expect(cls).not.toBeNull();
    expect(cls).toMatch(/\bflex-wrap\b/);
  });

  it('NEGATIVE CONTROL: the pre-fix class list (no flex-wrap) would be flagged', () => {
    const preFix = src.replace('<div className="flex flex-wrap items-center gap-2">\n          <StatusBadge', '<div className="flex items-center gap-2">\n          <StatusBadge');
    expect(preFix).not.toBe(src);
    expect(rowActionContainerClass(preFix)).not.toMatch(/\bflex-wrap\b/);
  });
});
