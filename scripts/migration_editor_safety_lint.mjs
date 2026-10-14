// Editor-safety lint for hand-run migration SQL (the Supabase SQL editor on DEV mis-parsed text in strings and
// comments; the confirmed trigger is the statement words "into", "from" and "join" followed by a name).
//
// The rule set is the one proven by tests/unit/nav2/nav2MigrationPartsAndEditorSafety.test.ts (branch
// feat/nav2-stage2-datefmt-20261005), kept as a plain module so a test AND an operator can run it:
//   node scripts/migration_editor_safety_lint.mjs supabase/migrations/0264_*.sql
//
// RULES: ASCII only; no bare dollar quote (use a tagged one such as $fn$); no percent sign; no double quote;
// no semicolon or quote inside a comment; no semicolon or double quote inside a string literal; no comment or
// string that has into, from or join followed by a word.

import fs from 'node:fs';

export function statementWords(text, kind) {
  const found = [];
  for (const m of text.matchAll(/\b(into|from|join)\s+([A-Za-z_][A-Za-z0-9_.]*)/gi)) {
    found.push(`${kind} has "${m[0]}" (the editor may read it as a statement): ${text.slice(0, 50)}`);
  }
  return found;
}

export function hazards(sql) {
  const out = [];
  if (/[^\x00-\x7f]/.test(sql)) out.push('non-ascii');
  if (sql.includes('$$')) out.push('bare dollar quote');
  if (sql.includes('%')) out.push('percent sign');
  let i = 0;
  const n = sql.length;
  while (i < n) {
    if (sql.startsWith('--', i)) {
      let j = sql.indexOf('\n', i);
      if (j < 0) j = n;
      const t = sql.slice(i, j);
      if (/[;"']/.test(t)) out.push(`comment has ; or a quote: ${t.slice(0, 60)}`);
      out.push(...statementWords(t, 'comment'));
      i = j;
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") break;
        j++;
      }
      const lit = sql.slice(i, j + 1);
      if (/[;"]/.test(lit)) out.push(`string has ; or a double quote: ${lit.slice(0, 60)}`);
      out.push(...statementWords(lit, 'string'));
      i = j + 1;
      continue;
    }
    if (sql[i] === '"') out.push('double quote in code');
    i++;
  }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith('migration_editor_safety_lint.mjs')) {
  let bad = 0;
  for (const f of process.argv.slice(2)) {
    const h = hazards(fs.readFileSync(f, 'utf8'));
    if (h.length) {
      bad += 1;
      console.log(`${f}: ${h.length} hazard(s)`);
      for (const x of h) console.log(`  - ${x}`);
    } else console.log(`${f}: clean`);
  }
  process.exit(bad ? 1 : 0);
}
