// App Review 2026-09-15 — Global Standard G2 repo-wide guard.
//
//   "In every table across every report and screen, numeric/amount columns
//    must be right-aligned. Text columns stay left-aligned. Apply at the
//    shared table/column component level so it cannot be missed on
//    individual pages."
//
// This app has no single shared <Table> component (43 files hand-roll their
// own <table>). The standard is therefore defined once in
// lib/ui/tableAlign.ts and ENFORCED here: this test scans every .tsx file for
// a table cell that renders a monetary value and fails if that cell is not
// right-aligned. That is what makes G2 a standard rather than a one-off sweep
// of the nine screenshots in the review — a new misaligned amount column
// added next month fails the build.
//
// Scope is deliberately "cells that render money", not "cells that contain a
// number": a count, a percentage, a date or a ratio is out of G2's stated
// scope ("values, targets, gaps, variances, currency amounts").
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const SCAN_DIRS = ['app', 'components'];

// The canonical money formatters. Everything else is discovered per file.
const CANONICAL = ['formatMoney', 'formatMoneyWhole', 'formatMoneyCode', 'formatMoneyNarrative', 'formatMoneyExact'];
const RIGHT_ALIGNED = /(?:\btext-right\b|NUM_CELL_CLASS|numCell\()/;

/**
 * Local one-line aliases for a money formatter, e.g.
 *   const fmt = (n: unknown) => formatMoneyWhole(Number(n ?? 0), currency);
 *   function fmtMoney(v, c) { ... formatMoneyCode(v, c) }
 * Resolved per file so a generic name like `fmt` is only treated as money in
 * files where it actually IS money — several files use `fmt` for plain string
 * formatting (e.g. AdminBenchmarksClient's `fmt(cell(r, 'Dataset'))`), and
 * flagging those would be a false positive, not a G2 violation.
 */
function moneyFnNames(src: string): string[] {
  const names = new Set<string>(CANONICAL.filter((n) => src.includes(`${n}(`)));
  // A declaration whose first ~600 characters reach a canonical money
  // formatter is itself a money formatter. Deliberately simple and
  // conservative: the window is short enough that an unrelated later
  // function cannot be swept in, and long enough for every wrapper shape
  // this codebase actually uses (arrow one-liner, try/catch with a fallback
  // branch, or a guard clause followed by the call).
  const declRe = /(?:const|function)\s+([A-Za-z_$][\w$]*)\s*[=(]/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(src)) !== null) {
    // Stop the window at the NEXT top-level declaration, so a percentage
    // helper declared immediately above a money helper (fmtPct / fmtMoney,
    // a very common pairing here) is not promoted by its neighbour's body.
    const rest = src.slice(m.index + 1, m.index + 600);
    const nextDecl = rest.search(/\n(?:export\s+)?(?:const|function)\s/);
    const window = nextDecl === -1 ? rest : rest.slice(0, nextDecl);
    if (CANONICAL.some((c) => window.includes(`${c}(`))) names.add(m[1]);
  }
  // Never let the alias search promote a name that is obviously not a
  // formatter (a component, a hook, a constant map).
  return [...names].filter((n) => !/^[A-Z]/.test(n) && !n.startsWith('use'));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

/** Split a file into `<td ...>…</td>` slices, tolerating nesting by simple
 *  depth counting on the `<td`/`</td` tokens. Good enough for a lint-style
 *  guard: a false negative is a missed warning, never a wrong build failure,
 *  because every reported cell is re-checked by eye when the list changes. */
function tdSlices(src: string): { className: string; body: string; index: number }[] {
  const slices: { className: string; body: string; index: number }[] = [];
  const openRe = /<td\b([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(src)) !== null) {
    const attrs = m[1];
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < src.length && depth > 0) {
      const nextOpen = src.indexOf('<td', i);
      const nextClose = src.indexOf('</td', i);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth += 1;
        i = nextOpen + 3;
      } else {
        depth -= 1;
        i = nextClose + 4;
      }
    }
    slices.push({ className: attrs, body: src.slice(start, i), index: m.index });
  }
  return slices;
}

describe('G2 — every amount column in every table is right-aligned', () => {
  it('finds no money-rendering table cell without right alignment', () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of walk(path.join(ROOT, dir))) {
        const src = fs.readFileSync(file, 'utf8');
        if (!src.includes('<td')) continue;
        const names = moneyFnNames(src);
        if (names.length === 0) continue;
        const moneyCall = new RegExp(`\\b(?:${names.map((n) => n.replace(/[$]/g, '\\$')).join('|')})\\s*\\(`);
        for (const td of tdSlices(src)) {
          if (!moneyCall.test(td.body)) continue;
          if (RIGHT_ALIGNED.test(td.className)) continue;
          const line = src.slice(0, td.index).split('\n').length;
          offenders.push(`${path.relative(ROOT, file).replace(/\\/g, '/')}:${line}`);
        }
      }
    }
    expect(
      offenders,
      `G2 violation — these table cells render a monetary value but are not right-aligned.\n` +
        `Add NUM_CELL_CLASS (lib/ui/tableAlign.ts) to the <td> className, and NUM_HEADER_CLASS to its <th>:\n  ` +
        offenders.join('\n  ')
    ).toEqual([]);
  });
});
