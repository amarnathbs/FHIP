// Editor-safety lint for hand-run SQL. Mirrors hazards() of tests/unit/nav2/nav2MigrationPartsAndEditorSafety.test.ts
// (branch feat/nav2-stage2-*), whose rules come from a confirmed failure when pasting into the Supabase SQL editor on DEV:
// the editor pre-parser reads the word after into, from or join inside a string or comment as a statement object.
// Rules: ASCII only, no bare dollar quote, no percent sign, no double quote in code, no semicolon or quote inside a
// comment, no semicolon or double quote inside a string, no into/from/join followed by a word inside a comment or string.
const COMMENT_ALLOWED = new Set<string>();

export function statementWords(text: string, kind: 'comment' | 'string'): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/\b(into|from|join)\s+([A-Za-z_][A-Za-z0-9_.]*)/gi)) {
    if (kind === 'comment' && COMMENT_ALLOWED.has(m[0].toLowerCase().replace(/\s+/g, ' '))) continue;
    found.push(`${kind} has "${m[0]}" (the editor may read it as a statement): ${text.slice(0, 50)}`);
  }
  return found;
}

export function hazards(sql: string): string[] {
  const out: string[] = [];
  // eslint-disable-next-line no-control-regex
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
