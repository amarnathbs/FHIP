// Resources Bulk Upload -- shared framework: schema/template drift, parsing (CSV + XLSX), structural errors
// and the row validation primitives common to Articles and Money Updates.
//
// NAMED NEGATIVE CONTROLS (each is a PAIR: the clean input passes, the same input with exactly one defect is
// rejected with the NAMED code -- so a check that silently stopped working would turn the pair red):
//   NC-P1 missing required field   NC-P2 unexpected content type column   NC-P3 status injection
//   NC-P4 visibility injection     NC-P5 formula cell                      NC-P6 duplicate slug
//   NC-P7 unsafe source URL        NC-P8 template drift (headers differ from schema)
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseImportFile } from '@/lib/resources/import/parser';
import { collectLookupKeys, validateImportTable } from '@/lib/resources/import/validation';
import { getImportAdapter } from '@/lib/resources/import/adapters';
import { stripUnusedBinContentType } from '@/lib/resources/import/xlsx-sanitize';
import { buildTemplateCsv, buildTemplateXlsx, templateFileName, templateHeaders, EMPTY_LOOKUPS } from '@/lib/resources/import/template-generator';
import { IMPORT_CONTENT_TYPES, IMPORT_LIMITS, type ImportContentType, type ImportReferenceData } from '@/lib/resources/import/types';
import { CAT_ID, csvOf, good, refs, SCHEMAS, xlsxFor, xlsxOf, rowsToAoa } from '../support/resourcesImportFixtures';

const TODAY = '2026-10-06';

function run(type: ImportContentType, rows: Record<string, string>[], opts: Parameters<typeof csvOf>[2] = {}, refOver: Partial<ImportReferenceData> = {}) {
  const parsed = parseImportFile({ fileName: 'upload.csv', bytes: csvOf(type, rows, opts) }, SCHEMAS[type], { sheetName: SCHEMAS[type].uploadSheetName });
  if (!parsed.ok) return { parsed, outcome: null as never };
  const outcome = validateImportTable(parsed.table, parsed.cellIssues, getImportAdapter(type).hooks, refs(refOver), TODAY);
  return { parsed, outcome };
}
const errCodes = (r: { errors: { code: string }[] }) => r.errors.map((e) => e.code);
const fileCodes = (p: { ok: boolean; issues?: { code: string }[] }) => (p.ok ? [] : (p.issues ?? []).map((i) => i.code));

describe('canonical schema: template and parser cannot drift', () => {
  for (const type of IMPORT_CONTENT_TYPES) {
    it(`${type}: the generated CSV header is exactly the parser schema, in order`, () => {
      const csv = buildTemplateCsv(type).replace(/^﻿/, '');
      expect(csv.split('\r\n')[0].split(',')).toEqual(SCHEMAS[type].columns.map((c) => c.key));
      expect(templateHeaders(SCHEMAS[type])).toEqual(SCHEMAS[type].columns.map((c) => c.key));
    });

    it(`${type}: the generated XLSX has the four sheets, the upload sheet header equals the parser schema, and every column is documented`, async () => {
      const bytes = await buildTemplateXlsx(type, EMPTY_LOOKUPS);
      const wb = XLSX.read(bytes, { type: 'array' });
      expect(wb.SheetNames).toEqual(['Instructions', SCHEMAS[type].uploadSheetName, 'Lookup_Values', SCHEMAS[type].exampleSheetName]);
      const header = (XLSX.utils.sheet_to_json(wb.Sheets[SCHEMAS[type].uploadSheetName], { header: 1 })[0] as string[]).map(String);
      expect(header).toEqual(SCHEMAS[type].columns.map((c) => c.key));
      const instructions = JSON.stringify(XLSX.utils.sheet_to_json(wb.Sheets.Instructions, { header: 1 }));
      for (const c of SCHEMAS[type].columns) expect(instructions, `Instructions must document ${c.key}`).toContain(c.key);
      expect(templateFileName(type, 'xlsx')).toBe(`${SCHEMAS[type].templateFileBase}.xlsx`);
    });

    it(`${type}: the template round trip works -- header-only is an EMPTY_FILE, a filled template (CSV and XLSX) is accepted`, async () => {
      const header = parseImportFile({ fileName: 'a.csv', bytes: new TextEncoder().encode(buildTemplateCsv(type)) }, SCHEMAS[type], { sheetName: SCHEMAS[type].uploadSheetName });
      expect(fileCodes(header)).toEqual(['EMPTY_FILE']);
      const xlsxEmpty = parseImportFile({ fileName: 'a.xlsx', bytes: await buildTemplateXlsx(type) }, SCHEMAS[type], { sheetName: SCHEMAS[type].uploadSheetName });
      expect(fileCodes(xlsxEmpty)).toEqual(['EMPTY_FILE']);
      const filledCsv = run(type, [good(type)]);
      expect(filledCsv.parsed.ok).toBe(true);
      expect(filledCsv.outcome.rows[0].errors).toEqual([]);
      const xl = parseImportFile({ fileName: 'a.xlsx', bytes: xlsxFor(type, [good(type)]) }, SCHEMAS[type], { sheetName: SCHEMAS[type].uploadSheetName });
      expect(xl.ok).toBe(true);
    });

    it(`${type}: the example sheet row is itself valid against the parser (an Example that fails its own template would mislead)`, () => {
      const example: Record<string, string> = {};
      for (const c of SCHEMAS[type].columns) example[c.key] = c.example;
      const r = run(type, [example]);
      expect(r.parsed.ok).toBe(true);
      // Only reference lookups (category, author, CTA, tags) can differ from the live data; no structural error.
      const structural = r.outcome.rows[0].errors.filter((e) => !['UNKNOWN_PRIMARY_CATEGORY', 'UNKNOWN_TAG', 'UNKNOWN_AUTHOR', 'UNKNOWN_CTA'].includes(e.code));
      expect(structural.map((e) => `${e.code}:${e.field}`)).toEqual(type === 'money_update' ? [] : []);
    });
  }

  it('NC-P8: the drift test bites -- a template with one header renamed no longer equals the parser schema, and the parser refuses it', () => {
    const real = SCHEMAS.article.columns.map((c) => c.key);
    const drifted = real.map((k) => (k === 'excerpt' ? 'summary' : k));
    expect(drifted).not.toEqual(real);
    const r = run('article', [good('article')], { headersOverride: drifted });
    expect(fileCodes(r.parsed)).toEqual(expect.arrayContaining(['UNKNOWN_COLUMN', 'MISSING_REQUIRED_COLUMN']));
  });

  it("Money Update columns are the PO's v1 contract, unchanged, in order", () => {
    const cols = SCHEMAS.money_update.columns.map((c) => c.key);
    expect(cols).toEqual([
      'template_version', 'external_id', 'title', 'slug', 'jurisdiction', 'difficulty', 'compliance_classification', 'event_date', 'next_review_at', 'expires_at', 'affected_audience', 'excerpt',
      'what_happened', 'why_it_matters', 'who_may_be_affected', 'financial_health_impact', 'how_fhip_can_help', 'primary_category', 'tags', 'primary_cta', 'secondary_cta', 'seo_title', 'seo_description', 'is_indexable',
      'source_1_name', 'source_1_document_title', 'source_1_url', 'source_1_type', 'source_1_publication_date', 'source_1_is_public',
      'source_2_name', 'source_2_document_title', 'source_2_url', 'source_2_type', 'source_2_publication_date', 'source_2_is_public',
    ]);
  });

  it('Article columns follow the spec and contain no workflow-state column', () => {
    const cols = SCHEMAS.article.columns.map((c) => c.key);
    expect(cols.slice(0, 24)).toEqual([
      'template_version', 'external_id', 'title', 'slug', 'jurisdiction', 'difficulty', 'compliance_classification', 'freshness_type', 'next_review_at', 'expires_at', 'excerpt', 'quick_answer', 'key_takeaways', 'main_content', 'example',
      'financial_health_meaning', 'primary_category', 'tags', 'author', 'primary_cta', 'secondary_cta', 'seo_title', 'seo_description', 'is_indexable',
    ]);
    for (const bad of ['status', 'visibility', 'published_at', 'scheduled_at', 'content_type', 'approved_by']) expect(cols).not.toContain(bad);
    expect(SCHEMAS.article.uploadSheetName).toBe('Article_Upload');
  });

  it('every enumerated column carries the spec controlled values and nothing else', () => {
    const enumOf = (t: ImportContentType, k: string) => [...(SCHEMAS[t].columns.find((c) => c.key === k)?.enumValues ?? [])];
    for (const t of IMPORT_CONTENT_TYPES) {
      expect(enumOf(t, 'jurisdiction')).toEqual(['global', 'australia', 'india', 'australia_india_cross_border']);
      expect(enumOf(t, 'difficulty')).toEqual(['beginner', 'beginner_intermediate', 'intermediate', 'intermediate_advanced', 'advanced']);
      expect(enumOf(t, 'compliance_classification')).toEqual(['green', 'amber', 'red']);
    }
    expect(enumOf('article', 'freshness_type')).toEqual(['evergreen', 'time_sensitive']);
  });
});

describe('structural file errors (named codes)', () => {
  it('NC-P1 missing required field: the clean row passes; a missing required COLUMN is MISSING_REQUIRED_COLUMN; a blank required VALUE is MISSING_REQUIRED_VALUE', () => {
    expect(run('article', [good('article')]).outcome.rows[0].errors).toEqual([]);
    expect(fileCodes(run('article', [good('article')], { drop: ['title'] }).parsed)).toEqual(['MISSING_REQUIRED_COLUMN']);
    expect(errCodes(run('article', [good('article', { title: '' })]).outcome.rows[0])).toContain('MISSING_REQUIRED_VALUE');
    expect(errCodes(run('article', [good('article', { excerpt: '' })]).outcome.rows[0])).toContain('MISSING_REQUIRED_VALUE');
    expect(errCodes(run('article', [good('article', { jurisdiction: '' })]).outcome.rows[0])).toContain('MISSING_REQUIRED_VALUE');
    expect(errCodes(run('article', [good('article', { compliance_classification: '' })]).outcome.rows[0])).toContain('MISSING_REQUIRED_VALUE');
  });

  it('NC-P2 unexpected content type: a content_type / type column is FORBIDDEN_COLUMN; the screen decides the type', () => {
    const clean = run('article', [good('article')]);
    expect(clean.parsed.ok).toBe(true);
    for (const col of ['content_type', 'type']) {
      const r = run('article', [good('article')], { extra: { [col]: 'money_update' } });
      expect(fileCodes(r.parsed), col).toEqual(['FORBIDDEN_COLUMN']);
    }
    // and a money-update file uploaded on the Article screen is not accepted as an article
    const wrong = parseImportFile({ fileName: 'mu.csv', bytes: csvOf('money_update', [good('money_update')]) }, SCHEMAS.article, { sheetName: SCHEMAS.article.uploadSheetName });
    expect(fileCodes(wrong)).toEqual(expect.arrayContaining(['UNKNOWN_COLUMN']));
  });

  it('NC-P3 status injection and NC-P4 visibility injection: the whole file is refused, nothing is staged', () => {
    expect(run('article', [good('article')]).parsed.ok).toBe(true);
    for (const col of ['status', 'visibility', 'published_at', 'scheduled_at', 'approved_by', 'editorial_approved_at', 'compliance_approved_by', 'workflow_status', 'is_featured']) {
      const r = run('article', [good('article')], { extra: { [col]: 'published' } });
      expect(fileCodes(r.parsed), col).toEqual(['FORBIDDEN_COLUMN']);
    }
    for (const col of ['status', 'visibility']) {
      const r = run('money_update', [good('money_update')], { extra: { [col]: col === 'status' ? 'published' : 'public' } });
      expect(fileCodes(r.parsed), col).toEqual(['FORBIDDEN_COLUMN']);
    }
  });

  it('header handling: case, spaces and BOM are tolerated; unknown and duplicate columns are named', () => {
    const schemaKeys = SCHEMAS.article.columns.map((c) => c.key);
    const loud = schemaKeys.map((k) => k.toUpperCase().replace(/_/g, ' '));
    const loudRow = Object.fromEntries(Object.entries(good('article')).map(([k, v]) => [k.toUpperCase().replace(/_/g, ' '), v]));
    expect(run('article', [loudRow], { headersOverride: loud }).parsed.ok).toBe(true);
    expect(fileCodes(run('article', [good('article')], { extra: { surprise: 'x' } }).parsed)).toEqual(['UNKNOWN_COLUMN']);
    expect(fileCodes(run('article', [good('article')], { headersOverride: [...schemaKeys, 'title'] }).parsed)).toEqual(['DUPLICATE_COLUMN']);
  });

  it('EMPTY_FILE for no rows or no header; TOO_MANY_ROWS above 250 records; exactly 250 is accepted', () => {
    expect(fileCodes(parseImportFile({ fileName: 'a.csv', bytes: new Uint8Array() }, SCHEMAS.article, { sheetName: SCHEMAS.article.uploadSheetName }))).toEqual(['EMPTY_FILE']);
    expect(fileCodes(run('article', []).parsed)).toEqual(['EMPTY_FILE']);
    const many = (n: number) => Array.from({ length: n }, (_, i) => good('article', { external_id: `E${i}`, slug: `s-${i}`, title: `T${i}` }));
    expect(run('article', many(250)).parsed.ok).toBe(true);
    expect(fileCodes(run('article', many(251)).parsed)).toEqual(['TOO_MANY_ROWS']);
    expect(IMPORT_LIMITS.maxRows).toBe(250);
    // the limit wording follows the single constant
    expect(JSON.stringify(run('article', many(251)).parsed)).toContain(String(IMPORT_LIMITS.maxRows));
  });

  it('TEMPLATE_VERSION_UNSUPPORTED unless 1.0 (a numeric 1 from Excel counts as 1.0)', () => {
    expect(run('article', [good('article', { template_version: '1.0' })]).parsed.ok).toBe(true);
    expect(run('article', [good('article', { template_version: '1' })]).parsed.ok).toBe(true);
    for (const v of ['2.0', '0.9', '', 'v1', '1.1']) expect(fileCodes(run('article', [good('article', { template_version: v })]).parsed), v).toEqual(['TEMPLATE_VERSION_UNSUPPORTED']);
    const num = xlsxOf({ Article_Upload: [SCHEMAS.article.columns.map((c) => c.key), SCHEMAS.article.columns.map((c) => (c.key === 'template_version' ? { n: 1 } : (good('article')[c.key] ?? '')))] });
    expect(parseImportFile({ fileName: 'a.xlsx', bytes: num }, SCHEMAS.article, { sheetName: SCHEMAS.article.uploadSheetName }).ok).toBe(true);
  });

  it('UPLOAD_SHEET_MISSING when the workbook has no sheet with the upload name; only that sheet is ever read', () => {
    const wrong = xlsxFor('article', [good('article')], 'Sheet1');
    expect(fileCodes(parseImportFile({ fileName: 'a.xlsx', bytes: wrong }, SCHEMAS.article, { sheetName: SCHEMAS.article.uploadSheetName }))).toEqual(['UPLOAD_SHEET_MISSING']);
    // a decoy: the other sheets hold a different (bad) row; only Article_Upload counts
    const decoy = xlsxOf({
      Instructions: [['title', 'status'], ['x', 'published']],
      Example_Article: rowsToAoa('article', [good('article', { title: 'DECOY' })]),
      Article_Upload: rowsToAoa('article', [good('article', { title: 'REAL' })]),
    });
    const p = parseImportFile({ fileName: 'a.xlsx', bytes: decoy }, SCHEMAS.article, { sheetName: SCHEMAS.article.uploadSheetName });
    expect(p.ok && p.table.rows.map((r) => r.values.title)).toEqual(['REAL']);
  });

  it('CSV and XLSX produce the same table for the same data (parity), including multi-line cells', () => {
    const row = good('article');
    const c = parseImportFile({ fileName: 'a.csv', bytes: csvOf('article', [row]) }, SCHEMAS.article, { sheetName: SCHEMAS.article.uploadSheetName });
    const x = parseImportFile({ fileName: 'a.xlsx', bytes: xlsxFor('article', [row]) }, SCHEMAS.article, { sheetName: SCHEMAS.article.uploadSheetName });
    expect(c.ok && x.ok).toBe(true);
    if (c.ok && x.ok) expect(x.table.rows[0].values).toEqual(c.table.rows[0].values);
  });

  it('XLSX date cells are read as calendar dates in the file format; text dates pass through', () => {
    const header = SCHEMAS.money_update.columns.map((c) => c.key);
    const row = SCHEMAS.money_update.columns.map((c) => (c.key === 'event_date' ? '' : (good('money_update')[c.key] ?? '')));
    const wb = XLSX.utils.book_new();
    const aoa = [header, row];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const evCol = header.indexOf('event_date');
    ws[XLSX.utils.encode_cell({ r: 1, c: evCol })] = { t: 'n', v: 46295, z: 'dd/mm/yyyy' }; // 2026-09-30
    XLSX.utils.book_append_sheet(wb, ws, 'Money_Update_Upload');
    const bytes = stripUnusedBinContentType(new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx', cellStyles: true }) as ArrayBuffer));
    const p = parseImportFile({ fileName: 'm.xlsx', bytes }, SCHEMAS.money_update, { sheetName: SCHEMAS.money_update.uploadSheetName });
    expect(p.ok && p.table.rows[0].values.event_date).toBe('2026-09-30');
  });
});

describe('row validation primitives', () => {
  it('controlled values are exact: anything else is INVALID_ENUM with the allowed list', () => {
    const r = run('article', [good('article', { jurisdiction: 'mars', compliance_classification: 'purple', difficulty: 'expert', freshness_type: 'forever' })]).outcome.rows[0];
    expect(errCodes(r)).toEqual(expect.arrayContaining(['INVALID_ENUM']));
    expect(r.errors.filter((e) => e.code === 'INVALID_ENUM').map((e) => e.field).sort()).toEqual(['compliance_classification', 'difficulty', 'freshness_type', 'jurisdiction']);
    expect(r.errors.find((e) => e.field === 'jurisdiction')?.message).toContain('australia_india_cross_border');
    // case is tolerated, the set is not widened
    expect(run('article', [good('article', { jurisdiction: 'India', compliance_classification: 'AMBER' })]).outcome.rows[0].errors).toEqual([]);
  });

  it('dates are strict: INVALID_DATE for a non-existent day, wrong order, wrong shape; the message names the FILE format', () => {
    for (const bad of ['2026-02-30', '31/12/2026', '2026-1-5', '2026/12/31', '12-31-2026', 'tomorrow', '2026-13-01']) {
      const r = run('article', [good('article', { next_review_at: bad })]).outcome.rows[0];
      expect(errCodes(r), bad).toContain('INVALID_DATE');
    }
    const msg = run('article', [good('article', { next_review_at: '31/12/2026' })]).outcome.rows[0].errors[0].message;
    expect(msg).toMatch(/file format/);
  });

  it('NC-P7 unsafe source URL: the https link passes; http, javascript:, data:, file:, ftp: and malformed are rejected with the NAMED code', () => {
    expect(run('article', [good('article')]).outcome.rows[0].errors).toEqual([]);
    for (const bad of ['http://example.com/x', 'javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'ftp://example.com/x']) {
      expect(errCodes(run('article', [good('article', { source_1_url: bad })]).outcome.rows[0]), bad).toContain('INSECURE_URL');
    }
    for (const bad of ['not a url', 'https://', '//example.com']) {
      expect(errCodes(run('article', [good('article', { source_1_url: bad })]).outcome.rows[0]), bad).toContain('INVALID_URL');
    }
  });

  it('sources: a name is required once any detail is given; a missing link is only a warning; identical sources collapse', () => {
    expect(errCodes(run('article', [good('article', { source_1_name: '' })]).outcome.rows[0])).toContain('MISSING_REQUIRED_VALUE');
    const noUrl = run('article', [good('article', { source_1_url: '' })]).outcome.rows[0];
    expect(noUrl.errors).toEqual([]);
    expect(noUrl.warnings.map((w) => w.code)).toContain('SOURCE_URL_MISSING');
    const dup = run('article', [good('article', { source_2_name: 'MoneySmart', source_2_document_title: 'Offset accounts', source_2_url: 'https://moneysmart.gov.au/home-loans/offset-accounts', source_2_type: 'regulator', source_2_publication_date: '2026-08-12', source_2_is_public: 'TRUE' })]).outcome.rows[0];
    expect(dup.payload?.sources.length).toBe(1);
    expect(errCodes(run('article', [good('article', { source_1_is_public: 'maybe' })]).outcome.rows[0])).toContain('INVALID_BOOLEAN');
  });

  it('NC-P6 duplicate slug: unique slugs pass; a repeated slug or external id in the file is DUPLICATE_SLUG_IN_FILE / DUPLICATE_EXTERNAL_ID_IN_FILE on the later row', () => {
    const a = good('article', { external_id: 'A', slug: 'one' });
    const b = good('article', { external_id: 'B', slug: 'two' });
    expect(run('article', [a, b]).outcome.rows.flatMap(errCodes)).toEqual([]);
    const dupSlug = run('article', [a, good('article', { external_id: 'B', slug: 'one' })]).outcome.rows;
    expect(errCodes(dupSlug[0])).toEqual([]);
    expect(errCodes(dupSlug[1])).toEqual(['DUPLICATE_SLUG_IN_FILE']);
    const dupExt = run('article', [a, good('article', { external_id: 'A', slug: 'two' })]).outcome.rows;
    expect(errCodes(dupExt[1])).toEqual(['DUPLICATE_EXTERNAL_ID_IN_FILE']);
    // a generated slug can collide too
    const gen = run('article', [good('article', { slug: '', title: 'Same Title', external_id: '1' }), good('article', { slug: '', title: 'Same Title', external_id: '2' })]).outcome.rows;
    expect(errCodes(gen[1])).toContain('DUPLICATE_SLUG_IN_FILE');
  });

  it('v1 is CREATE-ONLY: an existing slug, external id (content id) or post id is EXISTING_CONTENT_CONFLICT; nothing is matched by title', () => {
    const base = good('article', { slug: 'taken', external_id: 'EXT-9', title: 'Brand new title' });
    expect(run('article', [base]).outcome.rows[0].errors).toEqual([]);
    expect(errCodes(run('article', [base], {}, { existingSlugs: new Set(['taken']) }).outcome.rows[0])).toEqual(['EXISTING_CONTENT_CONFLICT']);
    expect(errCodes(run('article', [base], {}, { existingContentIds: new Set(['EXT-9']) }).outcome.rows[0])).toEqual(['EXISTING_CONTENT_CONFLICT']);
    const uuid = '55555555-5555-4555-8555-555555555555';
    expect(errCodes(run('article', [good('article', { external_id: uuid })], {}, { existingPostIds: new Set([uuid]) }).outcome.rows[0])).toEqual(['EXISTING_CONTENT_CONFLICT']);
    // same TITLE as something existing is fine (no title-based fuzzy dedupe)
    expect(run('article', [good('article', { title: 'How a mortgage offset account works' })], {}, { existingSlugs: new Set(['some-other-slug']) }).outcome.rows[0].errors).toEqual([]);
  });

  it('slugs: a provided slug is validated, never rewritten; a blank slug is generated from the title with a visible note', () => {
    expect(errCodes(run('article', [good('article', { slug: 'Not A Slug!' })]).outcome.rows[0])).toEqual(['INVALID_SLUG']);
    expect(run('article', [good('article', { slug: 'ok-slug-1' })]).outcome.rows[0].payload?.slug).toBe('ok-slug-1');
    const gen = run('article', [good('article', { slug: '', title: "Café Society's Guide" })]).outcome.rows[0];
    expect(gen.payload?.slug).toBe('cafe-societys-guide');
    expect(gen.payload?.slug_generated).toBe(true);
    expect(gen.warnings.map((w) => w.code)).toContain('SLUG_GENERATED');
  });

  it('category, tags and CTAs resolve to EXISTING records by exact name or slug; unknowns are named errors; nothing is created', () => {
    const ok = run('article', [good('article', { primary_category: 'investing', tags: 'Mortgage| offset-account |mortgage', primary_cta: 'try forecasting', secondary_cta: 'Open dashboard' })]).outcome.rows[0];
    expect(ok.errors).toEqual([]);
    expect(ok.payload?.primary_category_id).toBe('10000000-0000-4000-8000-000000000002');
    expect(ok.payload?.tag_ids.length).toBe(2); // the duplicate collapses
    expect(errCodes(run('article', [good('article', { primary_category: 'Nonexistent' })]).outcome.rows[0])).toEqual(['UNKNOWN_PRIMARY_CATEGORY']);
    expect(errCodes(run('article', [good('article', { tags: 'mortgage|made-up' })]).outcome.rows[0])).toEqual(['UNKNOWN_TAG']);
    expect(errCodes(run('article', [good('article', { primary_cta: 'No such CTA' })]).outcome.rows[0])).toEqual(['UNKNOWN_CTA']);
    expect(errCodes(run('article', [good('article', { primary_cta: 'Open dashboard', secondary_cta: 'open dashboard' })]).outcome.rows[0])).toEqual(['SAME_PRIMARY_SECONDARY_CTA']);
    // fuzzy near-misses do not match
    expect(errCodes(run('article', [good('article', { primary_category: 'Managing' })]).outcome.rows[0])).toEqual(['UNKNOWN_PRIMARY_CATEGORY']);
    const noCat = run('article', [good('article', { primary_category: '' })]).outcome.rows[0];
    expect(noCat.errors).toEqual([]);
    expect(noCat.warnings.map((w) => w.code)).toContain('PRIMARY_CATEGORY_MISSING');
  });

  it('SEO stays blank (the normal fallback applies); is_indexable cannot be turned on', () => {
    const r = run('article', [good('article', { is_indexable: 'TRUE' })]).outcome.rows[0];
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toContain('IS_INDEXABLE_IGNORED');
    expect(r.payload?.seo_title).toBeNull();
    expect(r.payload?.seo_description).toBeNull();
    expect(JSON.stringify(r.payload)).not.toMatch(/indexable/);
    expect(errCodes(run('article', [good('article', { is_indexable: 'maybe' })]).outcome.rows[0])).toEqual(['INVALID_BOOLEAN']);
  });

  it('length limits use the existing editor limits (title 180, excerpt 300): FIELD_TOO_LONG', () => {
    expect(errCodes(run('article', [good('article', { title: 'x'.repeat(181) })]).outcome.rows[0])).toContain('FIELD_TOO_LONG');
    expect(errCodes(run('article', [good('article', { excerpt: 'x'.repeat(301) })]).outcome.rows[0])).toContain('FIELD_TOO_LONG');
    expect(run('article', [good('article', { title: 'x'.repeat(180), excerpt: 'y'.repeat(300) })]).outcome.rows[0].errors).toEqual([]);
  });

  it('a source link is batched into the lookup keys with every slug and external id (constant query count however many rows)', () => {
    const rows = Array.from({ length: 50 }, (_, i) => good('article', { external_id: `E${i}`, slug: `s-${i}` }));
    const p = parseImportFile({ fileName: 'a.csv', bytes: csvOf('article', rows) }, SCHEMAS.article, { sheetName: SCHEMAS.article.uploadSheetName });
    expect(p.ok).toBe(true);
    if (p.ok) {
      const keys = collectLookupKeys(p.table);
      expect(keys.slugs.length).toBe(50);
      expect(keys.externalIds.length).toBe(50);
      expect(keys.urls).toEqual(['https://moneysmart.gov.au/home-loans/offset-accounts']);
    }
  });

  it('dates shown in messages are day-first (India dd-mm-yyyy, otherwise dd/mm/yyyy), never year-first', () => {
    const au = run('money_update', [good('money_update', { event_date: '2026-10-20', jurisdiction: 'australia' })]).outcome.rows[0];
    const fut = au.errors.find((e) => e.code === 'FUTURE_EVENT_DATE');
    expect(fut?.message).toContain('20/10/2026');
    expect(fut?.message).not.toMatch(/2026-10-20/);
    const india = run('money_update', [good('money_update', { event_date: '2026-10-20', jurisdiction: 'india' })]).outcome.rows[0];
    expect(india.errors.find((e) => e.code === 'FUTURE_EVENT_DATE')?.message).toContain('20-10-2026');
    expect(CAT_ID).toBeTruthy();
  });
});
