/**
 * Resources Bulk Upload -- builds the clearly marked SYNTHETIC files for the PRODUCTION verification.
 *
 *   npx tsx scripts/resources_bulk_upload_make_synthetic_prod_files.ts [--rows 1] [--category financial-health] [--out docs/resources/po_apply_bulk_upload_production/synthetic]
 *
 * Writes ZZ_BULKVERIFY_Article_<n>_row(s).csv and ZZ_BULKVERIFY_Money_Update_<n>_row(s).csv. Everything in them carries the markers the
 * cleanup SQL matches on: slugs start with zz-bulkverify-, source names with ZZ BULKVERIFY, file names with ZZ_BULKVERIFY. No
 * author, tag or call to action is named (a production database may not hold the same ones); the category must exist, so it
 * is a parameter (P0 section D lists the real slugs). Dates are written year first in the file because the template contract
 * says so; every screen shows them day first.
 *
 * The files are checked by tests/unit/resourcesBulkImportProductionPack.test.ts with the real parser and validators.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ARTICLE_SCHEMA } from '../lib/resources/import/article/schema';
import { MONEY_UPDATE_SCHEMA } from '../lib/resources/import/money-update/schema';

export type Row = Record<string, string>;

export function syntheticArticleRow(i: number, category: string): Row {
  return {
    template_version: '1.0',
    external_id: `ZZBV-A-${i}`,
    title: `ZZ BULKVERIFY synthetic article ${i} (not real content, delete me)`,
    slug: `zz-bulkverify-article-${i}`,
    jurisdiction: 'global',
    difficulty: 'beginner',
    compliance_classification: 'green',
    freshness_type: 'evergreen',
    next_review_at: '',
    expires_at: '',
    excerpt: 'Synthetic production verification record. Not real content. Delete me.',
    quick_answer: 'Synthetic quick answer.',
    key_takeaways: 'Synthetic takeaway one\nSynthetic takeaway two\nSynthetic takeaway three',
    main_content: '## Synthetic heading\n\nSynthetic paragraph for the production verification.\n\n- synthetic bullet one\n- synthetic bullet two',
    example: 'Synthetic example.',
    financial_health_meaning: 'Synthetic financial health meaning.',
    primary_category: category,
    tags: '',
    author: '',
    primary_cta: '',
    secondary_cta: '',
    seo_title: '',
    seo_description: '',
    is_indexable: 'FALSE',
    source_1_name: 'ZZ BULKVERIFY Source A',
    source_1_document_title: 'Synthetic document',
    source_1_url: 'https://example.com/zz-bulkverify/article',
    source_1_type: 'regulator',
    source_1_publication_date: '2026-08-12',
    source_1_is_public: 'TRUE',
  };
}

export function syntheticMoneyUpdateRow(i: number, category: string): Row {
  return {
    template_version: '1.0',
    external_id: `ZZBV-M-${i}`,
    title: `ZZ BULKVERIFY synthetic money update ${i} (not real content, delete me)`,
    slug: `zz-bulkverify-money-update-${i}`,
    jurisdiction: 'global',
    difficulty: 'beginner',
    compliance_classification: 'amber',
    event_date: '2026-09-01',
    next_review_at: '2027-03-31',
    expires_at: '',
    affected_audience: 'Synthetic audience',
    excerpt: 'Synthetic production verification record. Not real content. Delete me.',
    what_happened: 'Synthetic: what happened.',
    why_it_matters: 'Synthetic: why it matters.',
    who_may_be_affected: 'Synthetic: who may be affected.',
    financial_health_impact: 'Synthetic: financial health impact.',
    how_fhip_can_help: 'Synthetic: how FHIP can help.',
    primary_category: category,
    tags: '',
    primary_cta: '',
    secondary_cta: '',
    seo_title: '',
    seo_description: '',
    is_indexable: '',
    source_1_name: 'ZZ BULKVERIFY Source M',
    source_1_document_title: 'Synthetic document',
    source_1_url: 'https://example.com/zz-bulkverify/money-update',
    source_1_type: 'regulator',
    source_1_publication_date: '2026-09-01',
    source_1_is_public: 'TRUE',
  };
}

const q = (s: string) => (/[",\r\n]/.test(s) ? `"${s.split('"').join('""')}"` : s);
export function toCsv(columns: string[], rows: Row[]): string {
  return [columns.join(','), ...rows.map((r) => columns.map((c) => q(r[c] ?? '')).join(','))].join('\r\n') + '\r\n';
}

export function buildSyntheticFiles(rows: number, category: string): { name: string; csv: string }[] {
  const suffix = rows === 1 ? '1_row' : `${rows}_rows`;
  const a = Array.from({ length: rows }, (_, i) => syntheticArticleRow(i + 1, category));
  const m = Array.from({ length: rows }, (_, i) => syntheticMoneyUpdateRow(i + 1, category));
  return [
    { name: `ZZ_BULKVERIFY_Article_${suffix}.csv`, csv: toCsv(ARTICLE_SCHEMA.columns.map((c) => c.key), a) },
    { name: `ZZ_BULKVERIFY_Money_Update_${suffix}.csv`, csv: toCsv(MONEY_UPDATE_SCHEMA.columns.map((c) => c.key), m) },
  ];
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

if (process.argv[1] && /resources_bulk_upload_make_synthetic_prod_files/.test(process.argv[1])) {
  const rows = Number(arg('rows', '1'));
  const category = arg('category', 'financial-health');
  const out = path.resolve(arg('out', 'docs/resources/po_apply_bulk_upload_production/synthetic'));
  if (!Number.isInteger(rows) || rows < 1 || rows > 250) throw new Error('--rows must be 1 to 250');
  fs.mkdirSync(out, { recursive: true });
  for (const f of buildSyntheticFiles(rows, category)) {
    fs.writeFileSync(path.join(out, f.name), f.csv, 'utf8');
    console.log(`wrote ${path.join(out, f.name)}`);
  }
}
