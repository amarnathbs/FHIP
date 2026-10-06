/**
 * Generates the two template specification documents FROM the canonical schemas, so the documents cannot drift from
 * the parser or the templates (a unit test asserts every column key appears in its document).
 *
 *   npx tsx scripts/generate_resources_upload_template_docs.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { ARTICLE_SCHEMA } from '../lib/resources/import/article/schema';
import { MONEY_UPDATE_SCHEMA } from '../lib/resources/import/money-update/schema';
import { ARTICLE_TEMPLATE_NOTES } from '../lib/resources/import/article/template';
import { MONEY_UPDATE_TEMPLATE_NOTES } from '../lib/resources/import/money-update/template';
import type { ImportSchema } from '../lib/resources/import/types';

const OUT = path.resolve(__dirname, '..', 'docs', 'resources');

function table(schema: ImportSchema): string {
  const rows = schema.columns.map((c) => {
    const allowed = c.enumValues ? c.enumValues.join(', ') : '';
    const limit = c.maxLength ? `${c.maxLength}` : '';
    return `| \`${c.key}\` | ${c.required ? 'Required' : 'Optional'} | ${c.kind} | ${allowed} | ${limit} | ${c.help.replaceAll('|', '/').replaceAll('\n', ' ')} |`;
  });
  return ['| Column | Required | Kind | Allowed values | Max length | Notes |', '|---|---|---|---|---|---|', ...rows].join('\n');
}

function doc(title: string, schema: ImportSchema, notes: string[], extra: string): string {
  return `# ${title}

Generated from the canonical schema (\`lib/resources/import/${schema.contentType === 'article' ? 'article' : 'money-update'}/schema.ts\`) by \`scripts/generate_resources_upload_template_docs.ts\`. Do not edit by hand: change the schema and regenerate. A unit test fails if a column in the schema is missing from this document.

- Template version: **${schema.templateVersion}** (any other value is rejected with \`TEMPLATE_VERSION_UNSUPPORTED\`).
- Files: \`${schema.templateFileBase}.xlsx\` and \`${schema.templateFileBase}.csv\`. Only \`.xlsx\` and \`.csv\` are accepted.
- XLSX sheets: \`Instructions\`, \`${schema.uploadSheetName}\` (the **only** sheet that is imported), \`Lookup_Values\`, \`${schema.exampleSheetName}\` (an example, never processed).
- Dates inside the upload file are written year-month-day with hyphens (this is the file format only; the app shows dates day first).
- Every row becomes a **private draft**. The file cannot set status, visibility, approvals, scheduling, publication, the content type or whether the item is indexable. A column with such a name rejects the whole file.

## Columns

${table(schema)}

## Rules

${notes.map((n) => `- ${n}`).join('\n')}
${extra}
`;
}

const articleExtra = `
## How the finished body becomes the real article

| Column | Becomes |
|---|---|
| \`quick_answer\` | one \`callout\` block (the 30-second answer), omitted when blank |
| \`key_takeaways\` | one \`key_takeaways\` block, one item per line, omitted when blank |
| \`main_content\` | \`heading\` (H2 / H3), \`paragraph\`, \`bulleted_list\`, \`numbered_list\` blocks from restricted Markdown |
| \`example\` | one \`example\` block, omitted when blank |
| \`financial_health_meaning\` | an H2 "What this means for your financial health" followed by its paragraphs, omitted when blank |

Anything outside the restricted Markdown subset (raw HTML, H1, H4 and deeper, tables, block quotes, code, images, horizontal rules, nested lists, links that are not https) is rejected with \`UNSUPPORTED_ARTICLE_MARKUP\` naming the row and column. Nothing is dropped silently.

## Resolution of references (existing records only, never created)

- \`primary_category\`: exact category name or slug (\`UNKNOWN_PRIMARY_CATEGORY\`).
- \`tags\`: exact tag names or slugs separated by \`|\` (\`UNKNOWN_TAG\`).
- \`author\`: author id, author slug, or an exact **unique** display name (\`UNKNOWN_AUTHOR\`, \`AMBIGUOUS_AUTHOR\`). A blank author is accepted as a draft; the existing review gate still demands one before review.
- \`primary_cta\`, \`secondary_cta\`: exact name of an existing active CTA (\`UNKNOWN_CTA\`).
- Sources are reused only on an exact match of name, link and document title; otherwise they are created inside the same transaction.
`;

const muExtra = `
## How the five finished sections become the real Money Update

Each non-blank section becomes the same H2 heading the manual Money Update starter uses, followed by the section content (paragraphs, lists, H3):

| Column | Heading |
|---|---|
| \`what_happened\` | What Happened? |
| \`why_it_matters\` | Why Does It Matter? |
| \`who_may_be_affected\` | Who May Be Affected? |
| \`financial_health_impact\` | What Does This Mean for Your Financial Health? |
| \`how_fhip_can_help\` | How FHIP Can Help You Monitor It |

Forced on apply regardless of the file: \`content_type=money_update\`, \`status=draft\`, \`visibility=private\`, \`freshness_type=time_sensitive\`, \`is_indexable=false\`.
`;

fs.writeFileSync(path.join(OUT, 'ARTICLE_UPLOAD_TEMPLATE_SPEC.md'), doc('Article upload template specification (v1.0)', ARTICLE_SCHEMA, ARTICLE_TEMPLATE_NOTES, articleExtra));
fs.writeFileSync(path.join(OUT, 'MONEY_UPDATE_UPLOAD_TEMPLATE_SPEC.md'), doc('Money Update upload template specification (v1.0)', MONEY_UPDATE_SCHEMA, MONEY_UPDATE_TEMPLATE_NOTES, muExtra));
console.log('written');
