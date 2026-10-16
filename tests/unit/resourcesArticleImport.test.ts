// Resources Bulk Upload -- Article adapter: finished body -> canonical content_blocks, author resolution,
// freshness, forced defaults and the markup allow-list.
//
// NAMED NEGATIVE CONTROLS (pairs: clean passes, same input with one defect is refused with the NAMED code)
//   NC-A1 unsupported Article markup (raw HTML, H1, H4, table, quote, code, image, nested list, http link, javascript link)
//   NC-A2 empty body                NC-A3 ambiguous / unknown author     NC-A4 time-sensitive without a review or expiry date
import { describe, expect, it } from 'vitest';
import { parseImportFile } from '@/lib/resources/import/parser';
import { validateImportTable } from '@/lib/resources/import/validation';
import { getImportAdapter } from '@/lib/resources/import/adapters';
import { mapArticleBody } from '@/lib/resources/import/article/mapper';
import { parseRestrictedMarkdown } from '@/lib/resources/import/markup';
import { BLOCK_TYPE_LABELS, isKnownBlockType } from '@/lib/resources/editor/blocks';
import { AUTHOR_DUP_A, AUTHOR_ID, csvOf, good, refs, SCHEMAS } from '../support/resourcesImportFixtures';

const TODAY = '2026-10-06';
function row(over: Record<string, string> = {}) {
  const parsed = parseImportFile({ fileName: 'a.csv', bytes: csvOf('article', [good('article', over)]) }, SCHEMAS.article);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return validateImportTable(parsed.table, parsed.cellIssues, getImportAdapter('article').hooks, refs(), TODAY).rows[0];
}
const codes = (r: ReturnType<typeof row>) => r.errors.map((e) => e.code);
type Block = { id: string; type: string; data: Record<string, unknown> };
const blocks = (r: ReturnType<typeof row>) => (r.payload?.content_blocks ?? []) as Block[];

describe('Article golden fixture: finished content becomes canonical content_blocks', () => {
  const r = row();
  const b = blocks(r);

  it('the golden row is fully valid and carries forced defaults (the spreadsheet cannot choose state)', () => {
    expect(r.errors).toEqual([]);
    expect(r.payload).toMatchObject({ freshness_type: 'evergreen', event_date: null, affected_audience: null, jurisdiction: 'australia', compliance_classification: 'green', author_id: AUTHOR_ID });
    // none of the state fields exist in the staged payload at all
    for (const k of ['status', 'visibility', 'content_type', 'is_indexable', 'published_at', 'scheduled_at', 'created_by']) expect(Object.keys(r.payload ?? {})).not.toContain(k);
  });

  it('order and shape follow the existing Article starter: callout, key takeaways, body, example, financial-health section', () => {
    expect(b.map((x) => x.type)).toEqual([
      'callout', 'key_takeaways',
      'heading', 'paragraph', 'heading', 'bulleted_list', 'heading', 'numbered_list', 'paragraph',
      'example', 'heading', 'paragraph', 'paragraph',
    ]);
    expect(b[0].data.text).toBe('An offset account is a savings account linked to your loan.');
    expect(b[1].data.items).toEqual(['Interest is charged on the loan minus the offset balance.', 'Your money stays accessible.', 'A full offset can match a lower rate.']);
    expect(b[1].data.items).toHaveLength(3);
  });

  it('two H2, one H3, paragraphs, a bullet list and a numbered list from the restricted Markdown', () => {
    const headings = b.filter((x) => x.type === 'heading');
    expect(headings.filter((h) => h.data.level === 2).map((h) => h.data.text)).toEqual(['How it works', 'Things to check', 'What this means for your financial health']);
    expect(headings.filter((h) => h.data.level === 3).map((h) => h.data.text)).toEqual(['An example']);
    expect(b.find((x) => x.type === 'bulleted_list')?.data.items).toEqual(['Loan balance: $500,000', 'Offset balance: $50,000']);
    expect(b.find((x) => x.type === 'numbered_list')?.data.items).toEqual(['Whether the loan charges a package fee', 'Whether the offset is full or partial']);
    expect(b.find((x) => x.type === 'paragraph')?.data.text).toBe('Your offset balance is subtracted from the loan balance before **interest** is worked out.');
    expect(b.filter((x) => x.type === 'paragraph').at(-3)?.data.text).toBe('See [the regulator](https://moneysmart.gov.au) for more.');
  });

  it('the example becomes an Example block and the financial-health meaning an H2 plus its paragraphs', () => {
    expect(b.find((x) => x.type === 'example')?.data.text).toContain('$450,000');
    const idx = b.findIndex((x) => x.type === 'heading' && x.data.text === 'What this means for your financial health');
    expect(idx).toBeGreaterThan(0);
    expect(b.slice(idx + 1).map((x) => x.data.text)).toEqual(['An offset account turns idle cash into interest savings.', 'That can lift your savings rate.']);
  });

  it('only EXISTING block types are produced, every block has a unique stable id, no heading is H1 or H4', () => {
    for (const x of b) expect(isKnownBlockType(x.type), x.type).toBe(true);
    for (const t of new Set(b.map((x) => x.type))) expect(Object.keys(BLOCK_TYPE_LABELS)).toContain(t);
    expect(new Set(b.map((x) => x.id)).size).toBe(b.length);
    for (const x of b) expect(x.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    for (const h of b.filter((x) => x.type === 'heading')) expect([2, 3]).toContain(h.data.level);
  });

  it('ids are deterministic: the same row always stages the same payload (a stable digest)', () => {
    expect(JSON.stringify(row().payload)).toBe(JSON.stringify(row().payload));
  });

  it('category, tags, author, CTA and the source resolve and are carried in the payload', () => {
    expect(r.payload?.primary_category_id).toBeTruthy();
    expect(r.payload?.tag_ids).toHaveLength(2);
    expect(r.payload?.primary_cta_id).toBeTruthy();
    expect(r.payload?.sources).toEqual([{ source_name: 'MoneySmart', document_title: 'Offset accounts', url: 'https://moneysmart.gov.au/home-loans/offset-accounts', source_type: 'regulator', publication_date: '2026-08-12', is_public: true }]);
  });
});

describe('optional body fields never create an empty visible block', () => {
  it('a blank quick answer, takeaways, example and financial-health meaning produce NO block for them', () => {
    const r = row({ quick_answer: '', key_takeaways: '', example: '', financial_health_meaning: '' });
    expect(r.errors).toEqual([]);
    expect(blocks(r).map((x) => x.type)).toEqual(['heading', 'paragraph', 'heading', 'bulleted_list', 'heading', 'numbered_list', 'paragraph']);
    for (const x of blocks(r)) expect(JSON.stringify(x.data)).not.toMatch(/"text":""/);
  });

  it('key takeaways tolerate leading bullet or number markers and blank lines', () => {
    const r = row({ key_takeaways: '- First\n\n* Second\n3. Third\n•Fourth' });
    expect(blocks(r).find((x) => x.type === 'key_takeaways')?.data.items).toEqual(['First', 'Second', 'Third', '•Fourth']);
  });
});

describe('NC-A1 unsupported Article markup is REPORTED with the field, never silently dropped', () => {
  const clean = (md: string) => row({ main_content: md });
  it('the clean markdown passes', () => {
    expect(clean('## Heading\n\nA paragraph with **bold**, _italic_ and a [link](https://example.com/x).\n\n- one\n- two').errors).toEqual([]);
  });
  const cases: [string, string][] = [
    ['raw html tag', 'A paragraph with <b>html</b> in it.'],
    ['script tag', '<script>alert(1)</script>'],
    ['html comment', 'Text <!-- hidden --> more'],
    ['top-level heading', '# Title'],
    ['H4 heading', '#### Deep'],
    ['table', '| a | b |\n|---|---|\n| 1 | 2 |'],
    ['block quote', '> quoted'],
    ['code fence', '```\ncode\n```'],
    ['image', 'See ![alt](https://example.com/x.png)'],
    ['horizontal rule', 'Above\n\n---\n\nBelow'],
    ['nested list', '- one\n  - nested'],
    ['http link', 'See [x](http://example.com)'],
    ['javascript link', 'See [x](javascript:alert(1))'],
  ];
  for (const [name, md] of cases) {
    it(`${name} -> UNSUPPORTED_ARTICLE_MARKUP on main_content`, () => {
      const r = clean(md);
      expect(codes(r), name).toContain('UNSUPPORTED_ARTICLE_MARKUP');
      expect(r.errors.find((e) => e.code === 'UNSUPPORTED_ARTICLE_MARKUP')?.field).toBe('main_content');
      expect(blocks(r)).toEqual([]); // nothing partially mapped
    });
  }
  it('the other body fields are checked the same way and name their own field', () => {
    expect(row({ quick_answer: 'Call <img src=x onerror=alert(1)> now' }).errors.find((e) => e.code === 'UNSUPPORTED_ARTICLE_MARKUP')?.field).toBe('quick_answer');
    expect(row({ key_takeaways: 'ok\n<b>bad</b>' }).errors.find((e) => e.code === 'UNSUPPORTED_ARTICLE_MARKUP')?.field).toBe('key_takeaways');
    expect(row({ example: '<iframe src=x></iframe>' }).errors.find((e) => e.code === 'UNSUPPORTED_ARTICLE_MARKUP')?.field).toBe('example');
    expect(row({ financial_health_meaning: '## Another H2' }).errors.find((e) => e.code === 'UNSUPPORTED_ARTICLE_MARKUP')?.field).toBe('financial_health_meaning');
  });
  it('text that merely CONTAINS angle brackets or a javascript word is plain text, not HTML', () => {
    expect(clean('Rates rose when 5 < 6 and the term javascript: appears in prose.').errors).toEqual([]);
  });
  it('lazy continuation: a wrapped list item stays one item, and a marker line ends a paragraph', () => {
    const p = parseRestrictedMarkdown('Intro line\n- item one\n  continues here\n- item two', { seed: 's' });
    expect(p.ok && p.blocks.map((b) => b.type)).toEqual(['paragraph', 'bulleted_list']);
  });
});

describe('NC-A2 empty body', () => {
  it('blank main content is ARTICLE_BODY_EMPTY even when other body fields are present', () => {
    expect(codes(row())).toEqual([]);
    expect(codes(row({ main_content: '' }))).toEqual(['ARTICLE_BODY_EMPTY']);
    expect(codes(row({ main_content: '   \n\n  ' }))).toEqual(['ARTICLE_BODY_EMPTY']);
  });
  it('mapArticleBody reports every unsupported field at once', () => {
    const res = mapArticleBody({ seed: 's', quick_answer: '<b>x</b>', key_takeaways: '', main_content: '# H1', example: '', financial_health_meaning: '' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.problems.map((p) => p.field)).toEqual(['quick_answer', 'main_content']);
  });
});

describe('NC-A3 author resolution: existing authors only, never created', () => {
  it('resolves by slug, by id and by exact UNIQUE display name; blank is a draft warning (the review gate still blocks it later)', () => {
    expect(row({ author: 'pat-author' }).payload?.author_id).toBe(AUTHOR_ID);
    expect(row({ author: AUTHOR_ID }).payload?.author_id).toBe(AUTHOR_ID);
    expect(row({ author: 'Pat Author' }).payload?.author_id).toBe(AUTHOR_ID);
    const blank = row({ author: '' });
    expect(blank.errors).toEqual([]);
    expect(blank.payload?.author_id).toBeNull();
    expect(blank.warnings.map((w) => w.code)).toContain('AUTHOR_MISSING');
  });
  it('an unknown name is UNKNOWN_AUTHOR; two authors with the same name is AMBIGUOUS_AUTHOR but their slugs still work', () => {
    expect(codes(row({ author: 'Nobody Here' }))).toEqual(['UNKNOWN_AUTHOR']);
    expect(codes(row({ author: 'Sam Same' }))).toEqual(['AMBIGUOUS_AUTHOR']);
    expect(row({ author: 'sam-same-1' }).payload?.author_id).toBe(AUTHOR_DUP_A);
    expect(codes(row({ author: 'pat' }))).toEqual(['UNKNOWN_AUTHOR']); // no fuzzy matching
  });
});

describe('NC-A4 freshness', () => {
  it('evergreen is the default; time_sensitive needs a next review date or an expiry date (MISSING_REVIEW_OR_EXPIRY)', () => {
    expect(row({ freshness_type: '' }).payload?.freshness_type).toBe('evergreen');
    expect(codes(row({ freshness_type: 'time_sensitive', next_review_at: '2027-01-01' }))).toEqual([]);
    expect(codes(row({ freshness_type: 'time_sensitive', next_review_at: '', expires_at: '2027-06-30' }))).toEqual([]);
    expect(codes(row({ freshness_type: 'time_sensitive', next_review_at: '', expires_at: '' }))).toEqual(['MISSING_REVIEW_OR_EXPIRY']);
    expect(codes(row({ freshness_type: 'evergreen', next_review_at: '', expires_at: '' }))).toEqual([]);
  });
});

describe('workflow readiness is not weakened by upload', () => {
  it('an Article without an author is accepted as a DRAFT only; the existing review gate (validateForReview) still demands an author and a category', async () => {
    const { validateForReview } = await import('@/lib/resources/editor/validation');
    const r = row({ author: '', primary_category: '' });
    expect(r.errors).toEqual([]);
    const gate = validateForReview({
      title: r.payload!.title, slug: r.payload!.slug, excerpt: r.payload!.excerpt, content_type: 'article', jurisdiction: r.payload!.jurisdiction,
      primary_category_id: r.payload!.primary_category_id, author_id: r.payload!.author_id, compliance_classification: r.payload!.compliance_classification,
      content_blocks: r.payload!.content_blocks as never, seo_title: null, seo_description: null,
    });
    expect(gate.valid).toBe(false);
    expect(Object.keys(gate.errors)).toEqual(expect.arrayContaining(['author_id', 'primary_category_id']));
    const full = row();
    const ok = validateForReview({
      title: full.payload!.title, slug: full.payload!.slug, excerpt: full.payload!.excerpt, content_type: 'article', jurisdiction: full.payload!.jurisdiction,
      primary_category_id: full.payload!.primary_category_id, author_id: full.payload!.author_id, compliance_classification: full.payload!.compliance_classification,
      content_blocks: full.payload!.content_blocks as never, seo_title: null, seo_description: null,
    });
    expect(ok.valid).toBe(true);
  });
});
