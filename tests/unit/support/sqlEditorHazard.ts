// The Supabase SQL editor mis-parses the words into / from / join followed by a word when they appear inside a COMMENT or a
// STRING of a pasted script (PO-reported hazard, 17-10-2026). This tokenizer finds them without touching real SQL code.
// It understands -- comments, block comments, single-quoted strings (with doubled quotes) and treats dollar-quote markers as code.
const HAZARD = /\b(into|from|join)\s+[A-Za-z_(]/i;

export interface HazardHit {
  line: number;
  kind: 'comment' | 'string';
  text: string;
}

export function findSqlEditorHazards(sql: string): HazardHit[] {
  const hits: HazardHit[] = [];
  let i = 0;
  let line = 1;
  const n = sql.length;
  const note = (kind: 'comment' | 'string', startLine: number, text: string) => {
    if (HAZARD.test(text)) hits.push({ line: startLine, kind, text: text.trim().slice(0, 120) });
  };
  while (i < n) {
    const ch = sql[i];
    if (ch === '\n') {
      line++;
      i++;
    } else if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      note('comment', line, sql.slice(i, stop));
      i = stop;
    } else if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      const chunk = sql.slice(i, stop);
      note('comment', line, chunk);
      line += (chunk.match(/\n/g) ?? []).length;
      i = stop;
    } else if (ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      const chunk = sql.slice(i + 1, j);
      note('string', line, chunk);
      line += (chunk.match(/\n/g) ?? []).length;
      i = j + 1;
    } else {
      i++;
    }
  }
  return hits;
}
