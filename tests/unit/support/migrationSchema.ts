/**
 * The REAL database shape, derived from supabase/migrations (every numbered migration, in order): which columns each table has and which
 * functions (with their parameter names) exist. This is the oracle the NAV2 schema-contract test and the strict in-memory test double check
 * against, because a fake database that accepts any column name cannot catch "column ii_prices_nav.provider does not exist".
 *
 * It is a static reader, not a Postgres: it follows CREATE TABLE, ALTER TABLE ... ADD / DROP / RENAME COLUMN, ALTER TABLE ... RENAME TO,
 * DROP TABLE, CREATE VIEW (columns unknown: any column is accepted, the view's existence is checked) and CREATE FUNCTION headers.
 * Dollar-quoted bodies (function bodies, DO blocks) are opaque: DDL inside a DO block is NOT followed, and `doBlockDdl` counts those so the
 * limit is visible. The reader is validated against a known real column list (the coordinator's PostgREST OpenAPI dump of DEV's
 * ii_prices_nav) in tests/unit/nav2/nav2SchemaContract.test.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface TableShape {
  columns: Set<string>;
  /** A view (or CREATE TABLE ... AS): its columns are not derived, any column name is accepted. */
  open: boolean;
  createdIn: string;
}
export interface FunctionShape {
  params: string[];
  definedIn: string;
}
export interface MigrationSchema {
  tables: Map<string, TableShape>;
  functions: Map<string, FunctionShape>;
  files: number;
  /** Statements inside dollar-quoted DO blocks that mention table DDL: not followed by this reader. */
  doBlockDdl: string[];
}

const MIG = path.resolve(__dirname, '..', '..', '..', 'supabase', 'migrations');

const norm = (n: string): string => n.trim().replace(/^public\./i, '').replace(/"/g, '').toLowerCase();

interface Stmt {
  text: string;
  file: string;
}

/** Splits SQL into statements; comments are dropped, string literals collapsed, dollar-quoted bodies replaced by $$BODY$$. */
function statements(sql: string, file: string, doBlockDdl: string[]): Stmt[] {
  const out: Stmt[] = [];
  let cur = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const j = sql.indexOf('*/', i + 2);
      i = j < 0 ? n : j + 2;
      continue;
    }
    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") break;
        else i++;
      }
      i++;
      cur += "'x'";
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i, i + 40));
      if (m) {
        const tag = m[0];
        const j = sql.indexOf(tag, i + tag.length);
        const body = j < 0 ? sql.slice(i + tag.length) : sql.slice(i + tag.length, j);
        if (/^\s*(do\b|begin|declare)/i.test(cur.trim()) || /^\s*do\s*$/i.test(cur.trim()) || /\bdo\s*$/i.test(cur.trim())) {
          if (/\b(alter|create)\s+table\b/i.test(body)) doBlockDdl.push(`${file}: ${body.replace(/\s+/g, ' ').slice(0, 100)}`);
        }
        // DDL written as ALTER TABLE ... RENAME / ADD COLUMN / DROP COLUMN inside a DO block (often via EXECUTE '...') is replayed in order;
        // anything else in a body stays opaque. (0043 renames the R1 ii_analytics_results aside this way before creating the R4 table.)
        for (const a of body.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?[\w."]+\s+(?:rename\s+to\s+[\w."]+|add\s+column\s+(?:if\s+not\s+exists\s+)?[\w"]+|drop\s+column\s+(?:if\s+exists\s+)?[\w"]+)/gi)) out.push({ text: a[0], file });
        cur += ' $$BODY$$ ';
        i = j < 0 ? n : j + tag.length;
        continue;
      }
    }
    if (c === ';') {
      if (cur.trim()) out.push({ text: cur.trim(), file });
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur.trim()) out.push({ text: cur.trim(), file });
  return out;
}

/** Splits on commas that are not inside parentheses. */
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

/** The text between the first "(" and its matching ")" (and what follows it). */
function parenBody(s: string, from = 0): { body: string; rest: string } | null {
  const open = s.indexOf('(', from);
  if (open < 0) return null;
  let depth = 0;
  for (let k = open; k < s.length; k++) {
    if (s[k] === '(') depth++;
    else if (s[k] === ')') {
      depth--;
      if (depth === 0) return { body: s.slice(open + 1, k), rest: s.slice(k + 1) };
    }
  }
  return null;
}

const CONSTRAINT_START = /^(constraint|primary|unique|foreign|check|exclude|like)\b/i;
const NAME = String.raw`((?:"[^"]+"|[\w.]+))`;

let cached: MigrationSchema | null = null;

export function migrationSchema(): MigrationSchema {
  if (cached) return cached;
  const tables = new Map<string, TableShape>();
  const functions = new Map<string, FunctionShape>();
  const doBlockDdl: string[] = [];
  const files = readdirSync(MIG).filter((f) => /^\d{4}.*\.sql$/.test(f)).sort();
  for (const file of files) {
    for (const { text } of statements(readFileSync(path.join(MIG, file), 'utf8'), file, doBlockDdl)) {
      let m: RegExpExecArray | null;
      if ((m = new RegExp(String.raw`^create\s+(?:global\s+|local\s+)?(?:temp(?:orary)?\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?${NAME}\s*([\s\S]*)$`, 'i').exec(text))) {
        const name = norm(m[1]);
        const rest = m[2].trim();
        if (rest.startsWith('(')) {
          const pb = parenBody(rest);
          const cols = new Set<string>();
          let open = false;
          for (const el of splitTop(pb?.body ?? '')) {
            if (/^like\b/i.test(el)) {
              const like = /^like\s+([\w."]+)/i.exec(el);
              const src = like ? tables.get(norm(like[1])) : undefined;
              if (src) src.columns.forEach((c) => cols.add(c));
              else open = true;
              continue;
            }
            if (CONSTRAINT_START.test(el)) continue;
            const first = /^("[^"]+"|\w+)/.exec(el);
            if (first) cols.add(first[1].replace(/"/g, '').toLowerCase());
          }
          const ifNotExists = /^create\s+[\w\s]*?table\s+if\s+not\s+exists/i.test(text);
          if (!(ifNotExists && tables.has(name))) tables.set(name, { columns: cols, open, createdIn: file });
        } else {
          tables.set(name, { columns: new Set(), open: true, createdIn: file });
        }
        continue;
      }
      if ((m = new RegExp(String.raw`^create\s+(?:or\s+replace\s+)?(?:temp(?:orary)?\s+)?(?:materialized\s+|recursive\s+)?view\s+(?:if\s+not\s+exists\s+)?${NAME}`, 'i').exec(text))) {
        tables.set(norm(m[1]), { columns: new Set(), open: true, createdIn: file });
        continue;
      }
      if ((m = new RegExp(String.raw`^drop\s+(?:materialized\s+)?(?:table|view)\s+(?:if\s+exists\s+)?([\s\S]+?)(?:\s+(?:cascade|restrict))?$`, 'i').exec(text))) {
        for (const t of m[1].split(',')) tables.delete(norm(t));
        continue;
      }
      if ((m = new RegExp(String.raw`^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${NAME}\s+([\s\S]+)$`, 'i').exec(text))) {
        const name = norm(m[1]);
        const t = tables.get(name);
        for (const action of splitTop(m[2])) {
          let a: RegExpExecArray | null;
          if ((a = new RegExp(String.raw`^rename\s+to\s+${NAME}$`, 'i').exec(action))) {
            if (t) {
              tables.delete(name);
              tables.set(norm(a[1]), t);
            }
            continue;
          }
          if (!t) continue;
          if ((a = new RegExp(String.raw`^rename\s+(?:column\s+)?${NAME}\s+to\s+${NAME}$`, 'i').exec(action))) {
            t.columns.delete(norm(a[1]));
            t.columns.add(norm(a[2]));
          } else if ((a = new RegExp(String.raw`^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?${NAME}`, 'i').exec(action)) && !/^add\s+(constraint|primary|unique|foreign|check|exclude)\b/i.test(action)) {
            t.columns.add(norm(a[1]));
          } else if ((a = new RegExp(String.raw`^drop\s+(?:column\s+)?(?:if\s+exists\s+)?${NAME}`, 'i').exec(action)) && !/^drop\s+(constraint|primary|unique|foreign|check|exclude)\b/i.test(action)) {
            t.columns.delete(norm(a[1]));
          }
        }
        continue;
      }
      if ((m = new RegExp(String.raw`^create\s+(?:or\s+replace\s+)?function\s+${NAME}\s*\(`, 'i').exec(text))) {
        const pb = parenBody(text, text.indexOf('('));
        const params: string[] = [];
        for (const el of splitTop(pb?.body ?? '')) {
          const w = el.replace(/^(?:in|out|inout|variadic)\s+/i, '');
          const first = /^("[^"]+"|\w+)/.exec(w);
          if (first) params.push(first[1].replace(/"/g, '').toLowerCase());
        }
        const fname = norm(m[1]);
        // Overloads: keep the union of parameter names so any overload's names are accepted.
        const prev = functions.get(fname);
        functions.set(fname, { params: prev ? [...new Set([...prev.params, ...params])] : params, definedIn: file });
        continue;
      }
      if ((m = new RegExp(String.raw`^drop\s+function\s+(?:if\s+exists\s+)?${NAME}`, 'i').exec(text))) {
        // An overload may remain; the function is treated as present unless every definition is dropped later and re-created, which no NAV2 code relies on.
        continue;
      }
    }
  }
  cached = { tables, functions, files: files.length, doBlockDdl };
  return cached;
}
