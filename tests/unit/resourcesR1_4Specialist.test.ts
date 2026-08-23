// R1.4 specialist content — pure-logic unit tests. No DB/network required,
// same convention as tests/unit/resourcesEditorBlocks.test.ts. Live DEV
// RBAC/RLS/workflow/relationship tests are in
// tests/unit/resourcesR1_4LiveDev.test.ts.

import { describe, it, expect } from 'vitest';
import { parseYouTubeVideoId, isValidYouTubeId, buildYouTubeEmbedUrl, buildYouTubeThumbnailUrl, isValidChapterTimestamp, chapterTimestampToSeconds, validateChapters, createChapter, sortChapters } from '@/lib/resources/video/youtube';
import { validateVideoForReview, validateVideoForPublish } from '@/lib/resources/video/validation';
import { normalizeAliases } from '@/lib/resources/glossary/mutations';
import { validateGlossaryForDraftSave, validateGlossaryForReview } from '@/lib/resources/glossary/validation';
import { validateFaq } from '@/lib/resources/faq/validation';
import { validateMoneyUpdateForDraftSave, validateMoneyUpdateForReview } from '@/lib/resources/money-update/validation';
import { starterTemplateForMoneyUpdate, starterTemplateForMoneyUpdateTemplate } from '@/lib/resources/money-update/blocks';
import { isSafeSourceUrl, validateSourceUrl } from '@/lib/resources/sources/validation';

describe('YouTube video ID parsing (spec §15, §83-84)', () => {
  it('accepts a standard watch URL', () => {
    const r = parseYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.videoId).toBe('dQw4w9WgXcQ');
  });
  it('accepts a watch URL with extra query params', () => {
    const r = parseYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s&list=PL123');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.videoId).toBe('dQw4w9WgXcQ');
  });
  it('accepts a youtu.be short URL', () => {
    const r = parseYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.videoId).toBe('dQw4w9WgXcQ');
  });
  it('accepts an embed URL', () => {
    const r = parseYouTubeVideoId('https://www.youtube.com/embed/dQw4w9WgXcQ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.videoId).toBe('dQw4w9WgXcQ');
  });
  it('accepts a bare video ID', () => {
    const r = parseYouTubeVideoId('dQw4w9WgXcQ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.videoId).toBe('dQw4w9WgXcQ');
  });
  it('accepts a URL missing its protocol', () => {
    const r = parseYouTubeVideoId('youtu.be/dQw4w9WgXcQ');
    expect(r.ok).toBe(true);
  });
  it('rejects an empty string', () => {
    expect(parseYouTubeVideoId('').ok).toBe(false);
  });
  it('rejects a non-YouTube host', () => {
    expect(parseYouTubeVideoId('https://vimeo.com/12345678').ok).toBe(false);
  });
  it('rejects a malformed URL', () => {
    expect(parseYouTubeVideoId('not a url at all ??').ok).toBe(false);
  });
  it('DENIES javascript: scheme (spec §84 security test)', () => {
    const r = parseYouTubeVideoId('javascript:alert(1)');
    expect(r.ok).toBe(false);
  });
  it('DENIES data: scheme', () => {
    expect(parseYouTubeVideoId('data:text/html,<script>alert(1)</script>').ok).toBe(false);
  });
  it('isValidYouTubeId rejects a too-short id', () => {
    expect(isValidYouTubeId('short')).toBe(false);
  });
  it('isValidYouTubeId rejects a non-ASCII id', () => {
    expect(isValidYouTubeId('dQw4w9WgX©Q')).toBe(false);
  });
});

describe('YouTube embed URL derivation (spec §21-23, §84, §123)', () => {
  it('derives a canonical embed URL from a valid id', () => {
    expect(buildYouTubeEmbedUrl('dQw4w9WgXcQ')).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
  });
  it('returns null (never an arbitrary iframe) for an invalid id', () => {
    expect(buildYouTubeEmbedUrl('javascript:alert(1)')).toBeNull();
    expect(buildYouTubeEmbedUrl('')).toBeNull();
  });
  it('derives a thumbnail URL from a valid id, null otherwise', () => {
    expect(buildYouTubeThumbnailUrl('dQw4w9WgXcQ')).toBe('https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
    expect(buildYouTubeThumbnailUrl('bad')).toBeNull();
  });
});

describe('Video chapters (spec §20, §79, §83)', () => {
  it('accepts mm:ss and h:mm:ss timestamps', () => {
    expect(isValidChapterTimestamp('02:15')).toBe(true);
    expect(isValidChapterTimestamp('1:02:15')).toBe(true);
    expect(isValidChapterTimestamp('00:00')).toBe(true);
  });
  it('rejects malformed timestamps', () => {
    expect(isValidChapterTimestamp('2:5')).toBe(false);
    expect(isValidChapterTimestamp('abc')).toBe(false);
    expect(isValidChapterTimestamp('99:99')).toBe(false);
  });
  it('converts timestamps to seconds correctly', () => {
    expect(chapterTimestampToSeconds('02:15')).toBe(135);
    expect(chapterTimestampToSeconds('1:02:15')).toBe(3735);
  });
  it('every created chapter has a stable id', () => {
    const c1 = createChapter();
    const c2 = createChapter();
    expect(c1.id).not.toBe(c2.id);
  });
  it('validateChapters flags an invalid timestamp', () => {
    const result = validateChapters([{ id: 'a', timestamp: 'bad', title: 'Intro' }]);
    expect(result.valid).toBe(false);
    expect(result.errors.a).toBeTruthy();
  });
  it('validateChapters flags a blank title', () => {
    const result = validateChapters([{ id: 'a', timestamp: '00:00', title: '' }]);
    expect(result.valid).toBe(false);
  });
  it('validateChapters passes a well-formed chapter list', () => {
    const result = validateChapters([
      { id: 'a', timestamp: '00:00', title: 'Introduction' },
      { id: 'b', timestamp: '02:15', title: 'Why emergency funds matter' },
    ]);
    expect(result.valid).toBe(true);
  });
  it('sortChapters orders by timestamp ascending', () => {
    const sorted = sortChapters([
      { id: 'b', timestamp: '02:15', title: 'Second' },
      { id: 'a', timestamp: '00:00', title: 'First' },
    ]);
    expect(sorted.map((c) => c.id)).toEqual(['a', 'b']);
  });
});

describe('Video review/publish validation never requires content_blocks (regression — spec §17, §83)', () => {
  // Genuine defect found and fixed during the R1.4 live browser pass: Video
  // has no content_blocks body (see lib/resources/video/mutations.ts), so a
  // validator that requires "at least one meaningful block" can never be
  // satisfied by a video and must not gate its workflow.
  const validVideo = {
    title: 'Emergency Funds Explained',
    slug: 'emergency-funds-explained',
    excerpt: 'Why an emergency fund matters and how much to keep.',
    jurisdiction: 'global',
    primary_category_id: 'cat-1',
    author_id: 'author-1',
    compliance_classification: 'green',
  };
  it('passes review with no content_blocks-related error', () => {
    const result = validateVideoForReview(validVideo);
    expect(result.valid).toBe(true);
    expect(result.errors.content_blocks).toBeUndefined();
  });
  it('still requires the core fields', () => {
    const result = validateVideoForReview({ ...validVideo, title: '', slug: null });
    expect(result.valid).toBe(false);
    expect(result.errors.title).toBeTruthy();
    expect(result.errors.slug).toBeTruthy();
  });
  it('publish validation applies SEO fallback and compliance rules without content_blocks', () => {
    const result = validateVideoForPublish({ ...validVideo, seo_title: 'Title', seo_description: 'Description', editorial_approved_by: 'user-1' });
    expect(result.valid).toBe(true);
  });
  it('RED video cannot pass publish validation', () => {
    const result = validateVideoForPublish({ ...validVideo, compliance_classification: 'red', seo_title: 'Title', seo_description: 'Description' });
    expect(result.valid).toBe(false);
    expect(result.errors.compliance_classification).toBeTruthy();
  });
});

describe('Glossary alias normalisation (spec §26, §113)', () => {
  it('trims whitespace and drops blanks', () => {
    expect(normalizeAliases(['  Emergency Fund  ', '', '   '])).toEqual(['Emergency Fund']);
  });
  it('de-duplicates case-insensitively, keeping the first occurrence', () => {
    expect(normalizeAliases(['Rainy Day Fund', 'rainy day fund', 'Cash Buffer'])).toEqual(['Rainy Day Fund', 'Cash Buffer']);
  });
});

describe('Glossary validation (spec §28)', () => {
  it('draft save only checks title length', () => {
    expect(validateGlossaryForDraftSave({ title: 'Savings Rate' }).valid).toBe(true);
  });
  it('review requires term/slug/short definition/jurisdiction/category/author/compliance', () => {
    const result = validateGlossaryForReview({ title: '', slug: null, excerpt: null, jurisdiction: 'global', primary_category_id: null, author_id: null, compliance_classification: 'green' });
    expect(result.valid).toBe(false);
    expect(result.errors.title).toBeTruthy();
    expect(result.errors.slug).toBeTruthy();
    expect(result.errors.excerpt).toBeTruthy();
    expect(result.errors.primary_category_id).toBeTruthy();
    expect(result.errors.author_id).toBeTruthy();
  });
  it('review does NOT require a detailed explanation (content_blocks) — spec §28', () => {
    // validateGlossaryForReview has no content_blocks parameter at all,
    // unlike R1.3's validateForReview — this test documents that omission
    // is intentional, not an oversight.
    const result = validateGlossaryForReview({
      title: 'Savings Rate',
      slug: 'savings-rate',
      excerpt: 'The percentage of income saved.',
      jurisdiction: 'global',
      primary_category_id: 'cat-1',
      author_id: 'author-1',
      compliance_classification: 'green',
    });
    expect(result.valid).toBe(true);
  });
});

describe('FAQ validation (spec §34-35)', () => {
  it('requires question and short answer', () => {
    const result = validateFaq({ question: '', short_answer: '', jurisdiction: 'global' });
    expect(result.valid).toBe(false);
    expect(result.errors.question).toBeTruthy();
    expect(result.errors.short_answer).toBeTruthy();
  });
  it('passes with question, short answer, jurisdiction', () => {
    const result = validateFaq({ question: 'What is an emergency fund?', short_answer: 'Money set aside for unplanned expenses.', jurisdiction: 'global' });
    expect(result.valid).toBe(true);
  });
});

describe('Money Update validation (spec §42, §46, §88)', () => {
  it('requires an event date and next-review-or-expiry for a real Money Update', () => {
    const result = validateMoneyUpdateForReview({
      title: 'RBA Cash Rate Change',
      slug: 'rba-cash-rate-change',
      excerpt: 'The RBA changed the cash rate.',
      jurisdiction: 'australia',
      primary_category_id: 'cat-1',
      author_id: 'author-1',
      compliance_classification: 'amber',
      content_blocks: [{ id: '1', type: 'paragraph', data: { text: 'What happened...' } }],
      event_date: null,
      next_review_at: null,
      expires_at: null,
      content_type: 'money_update',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.event_date).toBeTruthy();
    expect(result.errors.next_review_at).toBeTruthy();
  });
  it('does not require event date/review-expiry for a Template (spec §44)', () => {
    const result = validateMoneyUpdateForReview({
      title: 'Interest Rate Update Template',
      slug: 'interest-rate-update-template',
      excerpt: 'Starter structure for interest rate updates.',
      jurisdiction: 'global',
      primary_category_id: 'cat-1',
      author_id: 'author-1',
      compliance_classification: 'green',
      content_blocks: [{ id: '1', type: 'heading', data: { level: 2, text: 'What Happened?' } }],
      event_date: null,
      next_review_at: null,
      expires_at: null,
      content_type: 'money_update_template',
    });
    expect(result.valid).toBe(true);
  });
  it('passes a fully-specified Money Update', () => {
    const result = validateMoneyUpdateForReview({
      title: 'RBA Cash Rate Change',
      slug: 'rba-cash-rate-change',
      excerpt: 'The RBA changed the cash rate.',
      jurisdiction: 'australia',
      primary_category_id: 'cat-1',
      author_id: 'author-1',
      compliance_classification: 'amber',
      content_blocks: [{ id: '1', type: 'paragraph', data: { text: 'What happened...' } }],
      event_date: '2026-08-01',
      next_review_at: '2026-10-01',
      expires_at: null,
      content_type: 'money_update',
    });
    expect(result.valid).toBe(true);
  });
  it('draft save only checks title length', () => {
    expect(validateMoneyUpdateForDraftSave({ title: 'A Money Update' }).valid).toBe(true);
  });
});

describe('Money Update starter templates (spec §43-44)', () => {
  it('pre-populates the required structured section headings', () => {
    const blocks = starterTemplateForMoneyUpdate();
    const headings = blocks.filter((b) => b.type === 'heading').map((b) => (b.data as { text: string }).text);
    expect(headings).toContain('What Happened?');
    expect(headings).toContain('Why Does It Matter?');
    expect(headings).toContain('Who May Be Affected?');
  });
  it('a template starter includes guidance text, not blank paragraphs', () => {
    const blocks = starterTemplateForMoneyUpdateTemplate();
    const paragraphs = blocks.filter((b) => b.type === 'paragraph').map((b) => (b.data as { text: string }).text);
    expect(paragraphs.every((t) => t.length > 0)).toBe(true);
  });
});

describe('Source URL security (spec §51, §100)', () => {
  it('accepts a valid https URL', () => {
    expect(isSafeSourceUrl('https://www.rba.gov.au/')).toBe(true);
  });
  it('rejects http (https required)', () => {
    expect(isSafeSourceUrl('http://www.rba.gov.au/')).toBe(false);
  });
  it('DENIES javascript: scheme', () => {
    expect(isSafeSourceUrl('javascript:alert(1)')).toBe(false);
  });
  it('DENIES data: scheme', () => {
    expect(isSafeSourceUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
  });
  it('rejects a malformed URL', () => {
    expect(isSafeSourceUrl('not a url')).toBe(false);
  });
  it('validateSourceUrl treats a blank URL as valid (optional field)', () => {
    expect(validateSourceUrl('').valid).toBe(true);
  });
  it('validateSourceUrl rejects an unsafe non-blank URL with a message', () => {
    const r = validateSourceUrl('javascript:alert(1)');
    expect(r.valid).toBe(false);
    expect(r.error).toBeTruthy();
  });
});
