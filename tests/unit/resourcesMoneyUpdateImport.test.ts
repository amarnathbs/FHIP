// Resources Bulk Upload -- Money Update adapter (the PO's v1 contract): the five finished sections become the
// existing Money Update content_blocks, plus event date / review-or-expiry / source rules.
//
// NAMED NEGATIVE CONTROLS (pairs: clean passes, the same input with ONE defect is refused with the NAMED code)
//   NC-M1 future event date           NC-M2 neither review nor expiry date     NC-M3 no source
//   NC-M4 a blank section             NC-M5 unsupported markup in a section    NC-M6 missing event date
import { describe, expect, it } from 'vitest';
import { parseImportFile } from '@/lib/resources/import/parser';
import { validateImportTable } from '@/lib/resources/import/validation';
import { getImportAdapter } from '@/lib/resources/import/adapters';
import { MONEY_UPDATE_SECTIONS } from '@/lib/resources/import/money-update/mapper';
import { starterTemplateForMoneyUpdate } from '@/lib/resources/money-update/blocks';
import { validateMoneyUpdateForReview } from '@/lib/resources/money-update/validation';
import { csvOf, good, refs, SCHEMAS } from '../support/resourcesImportFixtures';

const TODAY = '2026-10-06';
function row(over: Record<string, string> = {}) {
  const parsed = parseImportFile({ fileName: 'm.csv', bytes: csvOf('money_update', [good('money_update', over)]) }, SCHEMAS.money_update);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return validateImportTable(parsed.table, parsed.cellIssues, getImportAdapter('money_update').hooks, refs(), TODAY).rows[0];
}
const codes = (r: ReturnType<typeof row>) => r.errors.map((e) => e.code);
type Block = { id: string; type: string; data: Record<string, unknown> };

describe('Money Update golden fixture', () => {
  const r = row();
  const b = (r.payload?.content_blocks ?? []) as Block[];

  it('is valid and carries event date, audience, review date, jurisdiction, compliance, category and sources', () => {
    expect(r.errors).toEqual([]);
    expect(r.payload).toMatchObject({
      event_date: '2026-09-30',
      affected_audience: 'Households with a variable-rate home loan',
      next_review_at: '2026-12-31',
      jurisdiction: 'australia',
      compliance_classification: 'amber',
      freshness_type: 'time_sensitive',
      author_id: null,
    });
    expect(r.payload?.primary_category_id).toBeTruthy();
    expect(r.payload?.sources).toHaveLength(1);
    for (const k of ['status', 'visibility', 'content_type', 'is_indexable', 'published_at']) expect(Object.keys(r.payload ?? {})).not.toContain(k);
  });

  it('the five sections map to the SAME headings the manual Money Update starter uses, in order, each followed by its finished content', () => {
    const manualHeadings = starterTemplateForMoneyUpdate()
      .filter((x) => x.type === 'heading')
      .map((x) => (x.data as { text: string }).text);
    expect(MONEY_UPDATE_SECTIONS.map((s) => s.heading)).toEqual(manualHeadings);
    const headings = b.filter((x) => x.type === 'heading');
    expect(headings.map((h) => h.data.text)).toEqual(manualHeadings);
    for (const h of headings) expect(h.data.level).toBe(2);
    expect(b[0].type).toBe('heading');
    expect(b[1]).toMatchObject({ type: 'paragraph', data: { text: 'The Reserve Bank held the cash rate steady.' } });
    // a section may contain a list
    const who = b.findIndex((x) => x.type === 'heading' && x.data.text === 'Who May Be Affected?');
    expect(b.slice(who + 1, who + 3).map((x) => x.type)).toEqual(['paragraph', 'bulleted_list']);
    expect(b.find((x) => x.type === 'bulleted_list')?.data.items).toEqual(['Savers', 'Borrowers']);
    expect(new Set(b.map((x) => x.id)).size).toBe(b.length);
  });

  it('the imported body satisfies the existing Money Update review gate once category, author and review date exist (workflow readiness retained)', () => {
    const p = r.payload!;
    const gate = validateMoneyUpdateForReview({
      title: p.title, slug: p.slug, excerpt: p.excerpt, jurisdiction: p.jurisdiction, primary_category_id: p.primary_category_id, author_id: null,
      compliance_classification: p.compliance_classification, content_blocks: p.content_blocks as never, event_date: p.event_date, next_review_at: p.next_review_at, expires_at: p.expires_at, content_type: 'money_update',
    });
    // no author is imported for a Money Update: the gate (unchanged) still asks for one before review
    expect(Object.keys(gate.errors)).toEqual(['author_id']);
  });
});

describe('forced values: the spreadsheet cannot override', () => {
  it('freshness is always time_sensitive and is_indexable TRUE is ignored with a warning', () => {
    const r = row({ is_indexable: 'TRUE' });
    expect(r.errors).toEqual([]);
    expect(r.payload?.freshness_type).toBe('time_sensitive');
    expect(r.warnings.map((w) => w.code)).toContain('IS_INDEXABLE_IGNORED');
  });
  it('there is no freshness, status, visibility or author column in the Money Update contract', () => {
    const cols = SCHEMAS.money_update.columns.map((c) => c.key);
    for (const k of ['freshness_type', 'status', 'visibility', 'author', 'content_type']) expect(cols).not.toContain(k);
  });
});

describe('NC-M1 / NC-M6 event date', () => {
  it('a past or present date passes; a FUTURE date is FUTURE_EVENT_DATE; missing is MISSING_REQUIRED_VALUE; malformed is INVALID_DATE', () => {
    expect(codes(row({ event_date: '2026-10-06' }))).toEqual([]);
    expect(codes(row({ event_date: '2026-10-07' }))).toEqual([]); // one day of slack: Australia and India are ahead of UTC
    expect(codes(row({ event_date: '2026-10-08' }))).toEqual(['FUTURE_EVENT_DATE']);
    expect(codes(row({ event_date: '2030-01-01' }))).toEqual(['FUTURE_EVENT_DATE']);
    expect(codes(row({ event_date: '' }))).toEqual(['MISSING_REQUIRED_VALUE']);
    expect(codes(row({ event_date: '30/09/2026' }))).toEqual(['INVALID_DATE']);
  });
});

describe('NC-M2 review or expiry', () => {
  it('at least one of next review date / expiry date is required (MISSING_REVIEW_OR_EXPIRY)', () => {
    expect(codes(row({ next_review_at: '2026-12-31', expires_at: '' }))).toEqual([]);
    expect(codes(row({ next_review_at: '', expires_at: '2027-03-31' }))).toEqual([]);
    expect(codes(row({ next_review_at: '', expires_at: '' }))).toEqual(['MISSING_REVIEW_OR_EXPIRY']);
  });
});

describe('NC-M3 sources', () => {
  it('at least one source is required (SOURCE_REQUIRED); a second source is optional; an insecure link is refused', () => {
    expect(codes(row())).toEqual([]);
    const none = row({ source_1_name: '', source_1_document_title: '', source_1_url: '', source_1_type: '', source_1_publication_date: '', source_1_is_public: '' });
    expect(codes(none)).toEqual(['SOURCE_REQUIRED']);
    const two = row({ source_2_name: 'ATO', source_2_url: 'https://www.ato.gov.au/', source_2_type: 'regulator' });
    expect(two.payload?.sources.map((s) => s.source_name)).toEqual(['Reserve Bank of Australia', 'ATO']);
    expect(codes(row({ source_1_url: 'http://www.rba.gov.au/' }))).toEqual(['INSECURE_URL']);
  });
});

describe('NC-M4 / NC-M5 the five sections are finished content', () => {
  it('each of the five sections is required; the error names the blank field', () => {
    expect(codes(row())).toEqual([]);
    for (const s of MONEY_UPDATE_SECTIONS) {
      const r = row({ [s.key]: '' });
      expect(codes(r), s.key).toEqual(['MISSING_REQUIRED_VALUE']);
      expect(r.errors[0].field).toBe(s.key);
      expect(r.payload?.content_blocks).toEqual([]); // nothing partially mapped
    }
  });
  it('raw HTML or a non-https link in any section is UNSUPPORTED_MARKUP naming that section; nothing is dropped silently', () => {
    for (const s of MONEY_UPDATE_SECTIONS) {
      const r = row({ [s.key]: 'Fine text then <script>alert(1)</script>' });
      expect(codes(r), s.key).toEqual(['UNSUPPORTED_MARKUP']);
      expect(r.errors[0].field).toBe(s.key);
    }
    expect(codes(row({ why_it_matters: 'See [x](http://insecure.example)' }))).toEqual(['UNSUPPORTED_MARKUP']);
    expect(codes(row({ why_it_matters: '## Not allowed here' }))).toEqual(['UNSUPPORTED_MARKUP']);
    expect(codes(row({ why_it_matters: '### Allowed sub-heading\n\nText' }))).toEqual([]);
  });
});

describe('a Money Update row cannot carry Article-only content', () => {
  it('Article body columns are UNKNOWN_COLUMN on the Money Update screen (the screen decides the type)', () => {
    const parsed = parseImportFile({ fileName: 'a.csv', bytes: csvOf('article', [good('article')]) }, SCHEMAS.money_update);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['UNKNOWN_COLUMN', 'MISSING_REQUIRED_COLUMN']));
  });
});
