// Product Owner 08-10-2026 (global table layout): "GLOBALLY for every table in the app" - fit the screen, nothing wraps past two lines,
// nothing is lost, numbers/dates/statuses/actions are never clamped, and the page itself never scrolls sideways.
//
// Repo-wide GUARD (pattern: tests/unit/pageBackLinkGuard.test.ts): every table in app/ and components/ is rendered by the ONE shared
// <DataTable> (components/ui/DataTable.tsx). A raw `<table` anywhere else fails this test, unless the file is on the explicit
// allow-list below with a stated reason. It also checks that every <DataTable> is labelled (the scroll region must have a name),
// that the CSS contract the layout rules rely on is present, and that the allow-list cannot go stale.
// NEGATIVE CONTROLS re-run the scanner on mutated copies of real files / a virtual new file and require each to be caught.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

/** Files that may contain a raw `<table`. Every entry needs a reason; entries marked optional may not exist on every branch. */
export const RAW_TABLE_ALLOWED: Record<string, { reason: string; optional?: boolean }> = {
  'components/ui/DataTable.tsx': { reason: 'The shared mechanism itself: it renders the one real <table>.' },
  'components/admin/benchmarkData/responsiveTable.tsx': {
    reason:
      'Card-below-1280px table of the Market Index Data Mappings tab, built on branch fix/market-index-data-layout-20261008. Allowed until that branch adopts <DataTable>; remove this entry then.',
    optional: true,
  },
};

function walk(rel: string, acc: string[] = []): string[] {
  for (const e of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.next') continue;
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) walk(r, acc);
    else if (e.name.endsWith('.tsx')) acc.push(r);
  }
  return acc;
}

/** Line numbers of a raw `<table` element in JSX. Comments and strings that merely mention the tag are ignored. */
export function rawTableLines(src: string): number[] {
  const out: number[] = [];
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    let from = 0;
    for (;;) {
      const at = line.indexOf('<table', from);
      if (at === -1) break;
      from = at + 6;
      if (!/[\s>]/.test(line[at + 6] ?? '\n')) continue; // <tablet, <tableRow ...
      const prefix = line.slice(0, at);
      if (/^\s*(\/\/|\*|\/\*)/.test(prefix) || prefix.includes('//') || /`$/.test(prefix)) continue; // a comment or inline code in a comment
      out.push(i + 1);
    }
  });
  return out;
}

/** <DataTable ...> opening tags that carry no `label`. */
export function unlabelledDataTables(src: string): number[] {
  const out: number[] = [];
  let i = -1;
  while ((i = src.indexOf('<DataTable', i + 1)) !== -1) {
    if (!/[\s>]/.test(src[i + 10] ?? '')) continue;
    const lineStart = src.lastIndexOf('\n', i) + 1;
    const prefix = src.slice(lineStart, i);
    if (/^\s*(\/\/|\*|\/\*)/.test(prefix) || prefix.includes('//')) continue; // a mention in a comment
    let depth = 0;
    let quote: string | null = null;
    let end = i;
    for (let k = i; k < src.length; k++) {
      const c = src[k];
      if (quote) {
        if (c === quote && src[k - 1] !== '\\') quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) {
        end = k;
        break;
      }
    }
    if (!/\blabel=/.test(src.slice(i, end))) out.push(src.slice(0, i).split('\n').length);
  }
  return out;
}

function offenders(files: Record<string, string>): string[] {
  const bad: string[] = [];
  for (const [file, src] of Object.entries(files)) {
    if (RAW_TABLE_ALLOWED[file]) continue;
    for (const line of rawTableLines(src)) bad.push(`${file}:${line}`);
  }
  return bad;
}

const FILES = [...walk('app'), ...walk('components')];
const SOURCES: Record<string, string> = Object.fromEntries(FILES.map((f) => [f, read(f)]));

describe('every table is the shared <DataTable>', () => {
  it('finds no raw <table outside the shared mechanism and the explicit allow-list', () => {
    expect(offenders(SOURCES)).toEqual([]);
  });

  it('every <DataTable> has a label (the scroll region needs an accessible name)', () => {
    const bad: string[] = [];
    for (const [file, src] of Object.entries(SOURCES)) for (const line of unlabelledDataTables(src)) bad.push(`${file}:${line}`);
    expect(bad).toEqual([]);
  });

  it('a lot of tables really were migrated (the scan is not vacuous)', () => {
    const using = Object.values(SOURCES).reduce((n, src) => n + (src.match(/<DataTable[\s>]/g)?.length ?? 0), 0);
    expect(using).toBeGreaterThanOrEqual(100);
  });

  it('the allow-list cannot go stale: each entry that exists still holds a raw <table, and every entry has a reason', () => {
    for (const [file, entry] of Object.entries(RAW_TABLE_ALLOWED)) {
      expect(entry.reason.length, file).toBeGreaterThan(20);
      if (!existsSync(path.join(ROOT, file))) {
        expect(entry.optional, `${file} is allow-listed but missing`).toBe(true);
        continue;
      }
      expect(rawTableLines(read(file)).length, `${file} no longer has a raw <table: remove it from the allow-list`).toBeGreaterThan(0);
    }
  });

  it('the only raw <table in components/ui is the shared mechanism', () => {
    expect(rawTableLines(read('components/ui/DataTable.tsx')).length).toBe(1);
  });
});

describe('NEGATIVE CONTROLS: the guard demonstrably fails', () => {
  it('a new file with a raw <table is caught', () => {
    expect(offenders({ 'components/example/NewList.tsx': 'export const X = () => (\n  <table className="w-full">\n  </table>\n);\n' })).toEqual(['components/example/NewList.tsx:2']);
  });

  it('a real migrated file turned back into a raw <table is caught', () => {
    const real = 'components/reports/ReportHistoryTable.tsx';
    const mutated = read(real).replace('<DataTable ', '<table ').replace('</DataTable>', '</table>');
    expect(offenders({ [real]: mutated }).length).toBe(1);
    expect(offenders({ [real]: read(real) })).toEqual([]);
  });

  it('a <table> written inside a comment, and <tablet / <tableRow, are not false alarms', () => {
    expect(rawTableLines('// a real `<table>` is rendered by DataTable\n/* <table> */\n * <table>\n<tablet />\n<tableRow />')).toEqual([]);
  });

  it('a <DataTable> without a label is caught, one with a label (even a template label) is not', () => {
    expect(unlabelledDataTables('<DataTable className="w-full">\n</DataTable>')).toEqual([1]);
    expect(unlabelledDataTables('<DataTable label="Codes" className="x">\n</DataTable>')).toEqual([]);
    expect(unlabelledDataTables('<DataTable label={`Metrics for ${d.name}`} className={a > 1 ? "x" : "y"}>\n</DataTable>')).toEqual([]);
  });

  it('the allow-list does not hide an ordinary file', () => {
    expect(RAW_TABLE_ALLOWED['components/reports/ReportHistoryTable.tsx']).toBeUndefined();
  });
});

describe('the CSS contract the table rules rely on (app/globals.css)', () => {
  const css = read('app/globals.css');
  const tailwind = read('tailwind.config.ts');
  const block = (selector: string): string => {
    const at = css.indexOf(selector);
    expect(at, selector).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('}', at));
  };

  it('the scroll region scrolls sideways inside itself and adds no vertical scroll area', () => {
    const wrap = block('.fhip-table-wrap {');
    expect(wrap).toContain('overflow-x: auto');
    expect(wrap).toContain('max-width: 100%');
    expect(wrap).toContain('position: relative'); // so a visually hidden caption cannot widen the PAGE
    expect(wrap).not.toMatch(/max-height|overflow-y|height:/);
  });

  it('numbers, dates, statuses and actions do not wrap', () => {
    expect(block('.fhip-table .fhip-cell-nowrap')).toContain('white-space: nowrap');
  });

  it('text clamps to two lines by default and the clamp is not applied to anything else', () => {
    const clamp = block('.fhip-clamp {');
    expect(clamp).toContain('-webkit-line-clamp: var(--fhip-clamp-lines, 2)');
    expect(clamp).toContain('overflow: hidden');
    expect(clamp).toContain('overflow-wrap: anywhere');
  });

  it('the first column and the action column are sticky only below 768px', () => {
    const at = css.indexOf('@media (max-width: 767.98px)');
    expect(at).toBeGreaterThan(-1);
    const narrow = css.slice(at, css.indexOf('\n  }\n}', at));
    expect(narrow).toContain(":is(th, td):first-child");
    expect(narrow).toContain('position: sticky');
    expect(narrow).toContain('.fhip-cell-action');
    expect(css.slice(0, at)).not.toMatch(/position:\s*sticky/);
  });

  it('table text is one step below body text and never below 12px', () => {
    const t = block('.fhip-table {');
    const rem = Number(/font-size:\s*([\d.]+)rem/.exec(t)?.[1]);
    expect(rem * 16).toBeGreaterThanOrEqual(12);
    expect(rem * 16).toBeLessThan(14);
  });

  it('printing lays the whole table out (no scroll, no sticky)', () => {
    const printAt = css.indexOf('@media print');
    expect(css.slice(printAt)).toMatch(/\.fhip-table-wrap\s*\{\s*overflow:\s*visible\s*!important/);
  });

  it('Tailwind scans lib/ui so the cell classes defined there are not purged', () => {
    expect(tailwind).toContain("'./lib/ui/**/*.ts'");
  });
});
