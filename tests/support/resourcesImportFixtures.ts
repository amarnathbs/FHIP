// Shared fixtures for the Resources Bulk Upload tests. SYNTHETIC ONLY: nothing here is real PO content.

import * as XLSX from 'xlsx';
import { ARTICLE_SCHEMA } from '@/lib/resources/import/article/schema';
import { MONEY_UPDATE_SCHEMA } from '@/lib/resources/import/money-update/schema';
import type { ImportContentType, ImportReferenceData, ImportSchema } from '@/lib/resources/import/types';

export const SCHEMAS: Record<ImportContentType, ImportSchema> = { article: ARTICLE_SCHEMA, money_update: MONEY_UPDATE_SCHEMA };

export const CAT_ID = '10000000-0000-4000-8000-000000000001';
export const CAT2_ID = '10000000-0000-4000-8000-000000000002';
export const TAG1_ID = '20000000-0000-4000-8000-000000000001';
export const TAG2_ID = '20000000-0000-4000-8000-000000000002';
export const AUTHOR_ID = '30000000-0000-4000-8000-000000000001';
export const AUTHOR_DUP_A = '30000000-0000-4000-8000-000000000002';
export const AUTHOR_DUP_B = '30000000-0000-4000-8000-000000000003';
export const CTA1_ID = '40000000-0000-4000-8000-000000000001';
export const CTA2_ID = '40000000-0000-4000-8000-000000000002';

export function refs(over: Partial<ImportReferenceData> = {}): ImportReferenceData {
  return {
    categories: [
      { id: CAT_ID, name: 'Managing Money', slug: 'managing-money' },
      { id: CAT2_ID, name: 'Investing', slug: 'investing' },
    ],
    tags: [
      { id: TAG1_ID, name: 'Mortgage', slug: 'mortgage' },
      { id: TAG2_ID, name: 'Offset Account', slug: 'offset-account' },
    ],
    authors: [
      { id: AUTHOR_ID, display_name: 'Pat Author', slug: 'pat-author' },
      { id: AUTHOR_DUP_A, display_name: 'Sam Same', slug: 'sam-same-1' },
      { id: AUTHOR_DUP_B, display_name: 'Sam Same', slug: 'sam-same-2' },
    ],
    ctas: [
      { id: CTA1_ID, name: 'Open dashboard', label: 'Open your dashboard' },
      { id: CTA2_ID, name: 'Try forecasting', label: 'Try forecasting' },
    ],
    sources: [],
    existingSlugs: new Set<string>(),
    existingContentIds: new Set<string>(),
    existingPostIds: new Set<string>(),
    ...over,
  };
}

export const GOOD_ARTICLE: Record<string, string> = {
  template_version: '1.0',
  external_id: 'ART-1',
  title: 'How a mortgage offset account works',
  slug: 'how-a-mortgage-offset-account-works',
  jurisdiction: 'australia',
  difficulty: 'beginner_intermediate',
  compliance_classification: 'green',
  freshness_type: 'evergreen',
  next_review_at: '2027-03-31',
  expires_at: '',
  excerpt: 'An offset account can cut the interest you pay on a home loan.',
  quick_answer: 'An offset account is a savings account linked to your loan.',
  key_takeaways: 'Interest is charged on the loan minus the offset balance.\nYour money stays accessible.\nA full offset can match a lower rate.',
  main_content: [
    '## How it works',
    '',
    'Your offset balance is subtracted from the loan balance before **interest** is worked out.',
    '',
    '### An example',
    '',
    '- Loan balance: $500,000',
    '- Offset balance: $50,000',
    '',
    '## Things to check',
    '',
    '1. Whether the loan charges a package fee',
    '2. Whether the offset is full or partial',
    '',
    'See [the regulator](https://moneysmart.gov.au) for more.',
  ].join('\n'),
  example: 'Sam has a $500,000 loan and a $50,000 offset, so interest is charged on $450,000.',
  financial_health_meaning: 'An offset account turns idle cash into interest savings.\n\nThat can lift your savings rate.',
  primary_category: 'Managing Money',
  tags: 'mortgage|offset-account',
  author: 'pat-author',
  primary_cta: 'Open dashboard',
  secondary_cta: '',
  seo_title: '',
  seo_description: '',
  is_indexable: 'FALSE',
  source_1_name: 'MoneySmart',
  source_1_document_title: 'Offset accounts',
  source_1_url: 'https://moneysmart.gov.au/home-loans/offset-accounts',
  source_1_type: 'regulator',
  source_1_publication_date: '2026-08-12',
  source_1_is_public: 'TRUE',
};

export const GOOD_MONEY_UPDATE: Record<string, string> = {
  template_version: '1.0',
  external_id: 'MU-1',
  title: 'RBA holds the cash rate in September',
  slug: 'rba-holds-the-cash-rate-in-september',
  jurisdiction: 'australia',
  difficulty: 'beginner',
  compliance_classification: 'amber',
  event_date: '2026-09-30',
  next_review_at: '2026-12-31',
  expires_at: '',
  affected_audience: 'Households with a variable-rate home loan',
  excerpt: 'The Reserve Bank left the cash rate unchanged.',
  what_happened: 'The Reserve Bank held the cash rate steady.',
  why_it_matters: 'Repayments are unlikely to change this month.',
  who_may_be_affected: 'Households with variable-rate loans.\n\n- Savers\n- Borrowers',
  financial_health_impact: 'Stable repayments protect the debt servicing ratio.',
  how_fhip_can_help: 'Your dashboard shows your debt servicing ratio.',
  primary_category: 'Managing Money',
  tags: 'mortgage',
  primary_cta: '',
  secondary_cta: '',
  seo_title: '',
  seo_description: '',
  is_indexable: '',
  source_1_name: 'Reserve Bank of Australia',
  source_1_document_title: 'Monetary policy decision',
  source_1_url: 'https://www.rba.gov.au/media-releases/',
  source_1_type: 'regulator',
  source_1_publication_date: '2026-09-30',
  source_1_is_public: 'TRUE',
};

export function good(type: ImportContentType, over: Record<string, string> = {}): Record<string, string> {
  return { ...(type === 'article' ? GOOD_ARTICLE : GOOD_MONEY_UPDATE), ...over };
}

function csvCell(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.split('"').join('""')}"` : s;
}

/** Full-width CSV for a schema; columns not supplied are blank. Optionally drop or add columns. */
export function csvOf(type: ImportContentType, rows: Record<string, string>[], opts: { drop?: string[]; extra?: Record<string, string>; headersOverride?: string[] } = {}): Uint8Array {
  const schema = SCHEMAS[type];
  const headers = opts.headersOverride ?? [...schema.columns.map((c) => c.key).filter((k) => !(opts.drop ?? []).includes(k)), ...Object.keys(opts.extra ?? {})];
  const lines = [headers.join(',')];
  for (const r of rows) {
    const merged = { ...r, ...(opts.extra ?? {}) };
    lines.push(headers.map((h) => csvCell(merged[h] ?? '')).join(','));
  }
  return new TextEncoder().encode(lines.join('\r\n') + '\r\n');
}

export type CellSpec = string | { f: string; v?: string } | { n: number };

/** Builds an XLSX with the given sheets (array of arrays). Cells can be strings, numbers or formulas. */
export function xlsxOf(sheets: Record<string, CellSpec[][]>): Uint8Array {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) {
    const ws: XLSX.WorkSheet = {};
    let maxC = 0;
    aoa.forEach((row, r) => {
      row.forEach((cell, c) => {
        const addr = XLSX.utils.encode_cell({ r, c });
        maxC = Math.max(maxC, c);
        if (typeof cell === 'string') ws[addr] = { t: 's', v: cell };
        else if ('f' in cell) ws[addr] = { t: 's', v: cell.v ?? '', f: cell.f };
        else ws[addr] = { t: 'n', v: cell.n };
      });
    });
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(aoa.length - 1, 0), c: maxC } });
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);
}

export function rowsToAoa(type: ImportContentType, rows: Record<string, string>[]): string[][] {
  const headers = SCHEMAS[type].columns.map((c) => c.key);
  return [headers, ...rows.map((r) => headers.map((h) => r[h] ?? ''))];
}

export function xlsxFor(type: ImportContentType, rows: Record<string, string>[], sheetName?: string): Uint8Array {
  return xlsxOf({ Instructions: [['x']], [sheetName ?? SCHEMAS[type].uploadSheetName]: rowsToAoa(type, rows), Lookup_Values: [['y']] });
}
