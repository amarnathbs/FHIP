// The two template specification documents are GENERATED from the canonical schemas. This test fails when a
// document and its schema disagree (a column added, removed, renamed, or its required flag / allowed values changed
// without regenerating: npx tsx scripts/generate_resources_upload_template_docs.ts).
//
// NC-D1: the check bites -- a doc with one column line removed is detected as drifted.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ARTICLE_SCHEMA } from '@/lib/resources/import/article/schema';
import { MONEY_UPDATE_SCHEMA } from '@/lib/resources/import/money-update/schema';
import type { ImportSchema } from '@/lib/resources/import/types';

const DOCS = path.resolve(__dirname, '..', '..', 'docs', 'resources');

function drift(doc: string, schema: ImportSchema): string[] {
  const problems: string[] = [];
  for (const c of schema.columns) {
    const line = doc.split('\n').find((l) => l.startsWith(`| \`${c.key}\` |`));
    if (!line) {
      problems.push(`missing column ${c.key}`);
      continue;
    }
    if (!line.includes(c.required ? '| Required |' : '| Optional |')) problems.push(`required flag differs for ${c.key}`);
    for (const v of c.enumValues ?? []) if (!line.includes(v)) problems.push(`enum value ${v} missing for ${c.key}`);
  }
  const docColumns = doc.split('\n').filter((l) => /^\| `[a-z0-9_]+` \| (Required|Optional) \|/.test(l)).map((l) => l.split('`')[1]);
  for (const k of docColumns) if (!schema.columns.some((c) => c.key === k)) problems.push(`document lists ${k}, which the schema does not have`);
  return problems;
}

describe('template specification documents match the canonical schemas', () => {
  const cases: [string, ImportSchema][] = [
    ['ARTICLE_UPLOAD_TEMPLATE_SPEC.md', ARTICLE_SCHEMA],
    ['MONEY_UPDATE_UPLOAD_TEMPLATE_SPEC.md', MONEY_UPDATE_SCHEMA],
  ];
  for (const [file, schema] of cases) {
    it(`${file}: every column, required flag and allowed value agrees, and nothing extra is listed`, () => {
      const doc = fs.readFileSync(path.join(DOCS, file), 'utf8');
      expect(drift(doc, schema)).toEqual([]);
      expect(doc).toContain(`Template version: **${schema.templateVersion}**`);
      expect(doc).toContain(schema.uploadSheetName);
    });
  }

  it('NC-D1: the drift check bites -- a document with a column line removed or a flag flipped is flagged', () => {
    const doc = fs.readFileSync(path.join(DOCS, 'ARTICLE_UPLOAD_TEMPLATE_SPEC.md'), 'utf8');
    const without = doc.split('\n').filter((l) => !l.startsWith('| `excerpt` |')).join('\n');
    expect(drift(without, ARTICLE_SCHEMA)).toContain('missing column excerpt');
    const flipped = doc.replace('| `title` | Required |', '| `title` | Optional |');
    expect(drift(flipped, ARTICLE_SCHEMA)).toContain('required flag differs for title');
  });
});
