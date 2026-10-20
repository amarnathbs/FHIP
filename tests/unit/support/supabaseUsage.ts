/**
 * Static reader of supabase-js usage in source: finds every `.from('table')` chain and `.rpc('fn', {...})` call and checks the table, each
 * selected / filtered / ordered / written column, the RPC name and its parameter names against the REAL database shape derived from the
 * migrations (tests/unit/support/migrationSchema.ts). A fake database that accepts any column cannot catch this class of defect
 * ("column ii_prices_nav.provider does not exist" passed every unit suite and failed only against a real database).
 */
import { migrationSchema, type MigrationSchema } from './migrationSchema';

export interface SchemaViolation {
  file: string;
  line: number;
  what: 'unknown-table' | 'unknown-column' | 'unknown-function' | 'unknown-function-param' | 'unresolved-select';
  table?: string;
  detail: string;
}

export interface UsageSummary {
  tables: Set<string>;
  functions: Set<string>;
  selectsChecked: number;
  filtersChecked: number;
  writesChecked: number;
  /** Writes whose payload is a variable: not checkable statically (the strict in-memory database checks them at run time). */
  dynamicWrites: number;
}

function stripComments(s: string): string {
  const out: string[] = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (s[j] === '\\') {
          j += 2;
          continue;
        }
        if (s[j] === c) break;
        if (c !== '`' && s[j] === '\n') break;
        j += 1;
      }
      out.push(s.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (s.startsWith('//', i)) {
      let j = s.indexOf('\n', i);
      if (j < 0) j = n;
      out.push(' '.repeat(j - i));
      i = j;
      continue;
    }
    if (s.startsWith('/*', i)) {
      let j = s.indexOf('*/', i);
      j = j < 0 ? n : j + 2;
      out.push(s.slice(i, j).replace(/[^\n]/g, ' '));
      i = j;
      continue;
    }
    out.push(c);
    i += 1;
  }
  return out.join('');
}

/** Index just past the end of the statement/expression that begins at `from` (a `;` at depth 0, or the close of an enclosing call). */
function expressionEnd(code: string, from: number): number {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < code.length && code[j] !== c) {
        if (code[j] === '\\') j++;
        j++;
      }
      i = j;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth < 0) return i;
    } else if (c === ';' && depth === 0) return i;
  }
  return code.length;
}

function splitTop(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** The top-level keys of an object literal body (`a: 1, b, 'c-d': 2, ...spread`). Spreads are reported as `...`. */
function objectKeys(body: string): string[] {
  const keys: string[] = [];
  for (const part of splitTopBraces(body)) {
    const p = part.trim();
    if (!p) continue;
    if (p.startsWith('...')) {
      keys.push('...');
      continue;
    }
    const m = /^(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*(?::|$|\()/.exec(p);
    if (m) keys.push(m[1] ?? m[2] ?? m[3]);
  }
  return keys;
}

function splitTopBraces(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < s.length && s[j] !== c) {
        if (s[j] === '\\') j++;
        j++;
      }
      cur += s.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/** The balanced (...) argument text starting at the "(" at index `open`. */
function callArgs(code: string, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < code.length && code[j] !== c) {
        if (code[j] === '\\') j++;
        j++;
      }
      i = j;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  return code.slice(open + 1);
}

const lineOf = (code: string, idx: number): number => code.slice(0, idx).split('\n').length;

const FILTER_METHODS = ['eq', 'neq', 'in', 'is', 'gte', 'gt', 'lte', 'lt', 'not', 'like', 'ilike', 'order'] as const;

/** Columns named by a PostgREST select list. Embedded resources (`rel(...)`) are skipped; aliases and casts are stripped. */
export function selectColumns(list: string): string[] {
  const cols: string[] = [];
  for (const item of splitTop(list)) {
    if (item === '*' || item.includes('(')) continue;
    let x = item.replace(/::\w+(\[\])?$/, '').trim();
    const alias = /^([A-Za-z_]\w*)\s*:\s*(.+)$/.exec(x);
    if (alias) x = alias[2].trim();
    x = x.replace(/->>?.*$/, '').trim();
    if (/^[A-Za-z_]\w*$/.test(x)) cols.push(x.toLowerCase());
  }
  return cols;
}

/** `const NAME = 'value'` declarations (any file in `constantsSource`), used to resolve `${NAME}` inside a select template. */
export function constantMap(sources: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of sources) for (const x of s.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*'([^']*)'/g)) m.set(x[1], x[2]);
  return m;
}

export function checkUsage(file: string, source: string, constants: Map<string, string>, schema: MigrationSchema = migrationSchema()): { violations: SchemaViolation[]; summary: UsageSummary } {
  const code = stripComments(source);
  const violations: SchemaViolation[] = [];
  const summary: UsageSummary = { tables: new Set(), functions: new Set(), selectsChecked: 0, filtersChecked: 0, writesChecked: 0, dynamicWrites: 0 };

  const checkCols = (table: string, cols: string[], idx: number, what: string) => {
    const t = schema.tables.get(table);
    if (!t || t.open) return;
    for (const c of cols) {
      if (!t.columns.has(c)) violations.push({ file, line: lineOf(code, idx), what: 'unknown-column', table, detail: `${what} "${c}" is not a column of ${table}` });
    }
  };

  for (const fm of code.matchAll(/\.from\(\s*['"]([\w.]+)['"]\s*\)/g)) {
    const table = fm[1].replace(/^public\./, '').toLowerCase();
    const start = fm.index as number;
    summary.tables.add(table);
    if (!schema.tables.has(table)) {
      violations.push({ file, line: lineOf(code, start), what: 'unknown-table', table, detail: `${table} is not created by any migration` });
      continue;
    }
    let end = expressionEnd(code, start);
    // Two chains in one expression (Promise.all([...])): this chain ends where the next one begins.
    const next = code.indexOf('.from(', start + 6);
    if (next >= 0 && next < end) end = next;
    let window = code.slice(start, end);
    // `let q = admin.from('t').select(...)...;` followed by `q = q.eq('col', v)` in a branch.
    const before = code.slice(Math.max(0, start - 200), start);
    const variable = /(?:let|const)\s+(\w+)\s*=\s*(?:await\s+)?[\w.\s]*$/.exec(before)?.[1];
    if (variable) {
      const re = new RegExp(String.raw`\b${variable}\s*=\s*${variable}(\.[^;]*)`, 'g');
      for (const f of code.slice(end, end + 1200).matchAll(re)) window += ` ${f[1]}`;
    }
    const baseIdx = start;

    // select('a, b') / select(`${CONST}, ...`)
    for (const sm of window.matchAll(/\.select\(\s*(['"`])([\s\S]*?)\1/g)) {
      let list = sm[2];
      if (sm[1] === '`') {
        let unresolved = false;
        list = list.replace(/\$\{\s*([A-Za-z_]\w*)\s*\}/g, (_m, name: string) => {
          const v = constants.get(name);
          if (v === undefined) unresolved = true;
          return v ?? '';
        });
        if (unresolved) {
          violations.push({ file, line: lineOf(code, baseIdx), what: 'unresolved-select', table, detail: `select template ${sm[2]} uses a constant that cannot be resolved` });
          continue;
        }
      }
      summary.selectsChecked += 1;
      checkCols(table, selectColumns(list), baseIdx, 'selected column');
    }
    // filters and ordering
    for (const f of FILTER_METHODS) {
      for (const fmx of window.matchAll(new RegExp(String.raw`\.${f}\(\s*['"]([A-Za-z_][\w]*)['"]`, 'g'))) {
        summary.filtersChecked += 1;
        checkCols(table, [fmx[1].toLowerCase()], baseIdx, `${f}() column`);
      }
    }
    // writes: object literal payloads are checked here; a variable payload is checked by the strict in-memory database
    for (const w of ['insert', 'update', 'upsert'] as const) {
      for (const wm of window.matchAll(new RegExp(String.raw`\.${w}\(`, 'g'))) {
        const open = (wm.index as number) + wm[0].length - 1;
        const args = callArgs(window, open).trim();
        summary.writesChecked += 1;
        const first = splitTopBraces(args)[0]?.trim() ?? '';
        const lit = /^\{([\s\S]*)\}$/.exec(first) ?? /^\[\s*\{([\s\S]*)\}\s*\]$/.exec(first);
        if (!lit) {
          summary.dynamicWrites += 1;
        } else {
          const keys = objectKeys(lit[1]).filter((k) => k !== '...');
          checkCols(table, keys.map((k) => k.toLowerCase()), baseIdx, `${w}() payload key`);
        }
        const oc = /onConflict:\s*['"]([^'"]+)['"]/.exec(args);
        if (oc) checkCols(table, oc[1].split(',').map((c) => c.trim().toLowerCase()), baseIdx, 'onConflict column');
      }
    }
  }

  for (const rm of code.matchAll(/\.rpc\(\s*['"]([\w.]+)['"]/g)) {
    const name = rm[1].replace(/^public\./, '').toLowerCase();
    summary.functions.add(name);
    const fn = schema.functions.get(name);
    const idx = rm.index as number;
    if (!fn) {
      violations.push({ file, line: lineOf(code, idx), what: 'unknown-function', detail: `${name} is not created by any migration` });
      continue;
    }
    const open = code.indexOf('(', idx);
    const second = splitTopBraces(callArgs(code, open))[1]?.trim() ?? '';
    const lit = /^\{([\s\S]*)\}$/.exec(second);
    if (lit) {
      for (const k of objectKeys(lit[1]).filter((x) => x !== '...')) {
        if (!fn.params.includes(k.toLowerCase())) violations.push({ file, line: lineOf(code, idx), what: 'unknown-function-param', detail: `${name} has no parameter "${k}" (it has: ${fn.params.join(', ') || 'none'})` });
      }
    }
  }
  return { violations, summary };
}
