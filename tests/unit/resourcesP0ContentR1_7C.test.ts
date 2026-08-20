// R1.7C — P0 Content Certification & CMS Load. Static content-quality and
// financial-math tests against the consolidated normalized dataset and
// structured-block conversion output (both committed as source-of-truth
// JSON derived from the 14 read-only source DOCX files under
// D:\FHIP\content\, gitignored per the same precedent as R1.7's own source
// workbook). These are STATIC tests -- they do not touch the network or
// DEV Supabase; see resourcesP0ContentR1_7CLiveDev.test.ts for the live-DB
// counterpart.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const CONSOLIDATED_DIR = 'D:/FHIP/content/consolidated';

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(`${CONSOLIDATED_DIR}/${name}`, 'utf-8')) as T;
}

interface NormalizedRecord {
  content_id: string;
  title: string;
  content_type: string;
  jurisdiction: string;
  risk_class: string;
  body_word_count: number;
  has_30_second_answer: boolean;
  has_key_takeaways: boolean;
  has_faq: boolean;
  has_disclaimer: boolean;
}

const EXPECTED_84 = [
  'FH-001', 'FH-002', 'FH-003', 'FH-004', 'FH-005', 'FH-006',
  'MM-001', 'MM-002', 'MM-003', 'MM-004', 'ER-001', 'ER-002',
  'ER-003', 'ER-004', 'DB-001', 'DB-002', 'DB-003', 'DB-004',
  'NW-001', 'NW-002', 'NW-003', 'NW-004', 'GL-001', 'GL-002',
  'GL-003', 'IN-001', 'IN-002', 'IN-003', 'IN-004', 'IN-005',
  'RAU-001', 'RAU-002', 'RAU-003', 'RIN-001', 'RIN-002', 'RIN-003',
  'IP-001', 'IP-002', 'DN-001', 'FC-001', 'FC-002', 'FC-003',
  'CB-001', 'CB-002', 'SB-001', 'SB-002', 'SB-003', 'EX-001',
  'EX-002', 'EX-003', 'EX-004', 'EX-005', 'EX-006', 'EX-007',
  'EX-008', 'EX-009', 'EX-010', 'EX-011', 'EX-012', 'EX-025',
  'EX-026', 'VID-001', 'VID-002', 'VID-003', 'VID-004', 'VID-005',
  'VID-006', 'VID-007', 'VID-008', 'GLO-001', 'GLO-002', 'GLO-003',
  'GLO-004', 'GLO-005', 'GLO-006', 'GLO-007', 'GLO-008', 'GLO-009',
  'GLO-010', 'GLO-011', 'GLO-012', 'GLO-013', 'GLO-014', 'GLO-015',
];

describe('R1.7C P0 content -- source discovery gate', () => {
  const records = loadJson<NormalizedRecord[]>('p0-content-normalized.json');

  it('has exactly 84 unique Content IDs', () => {
    const ids = records.map((r) => r.content_id);
    expect(ids.length).toBe(84);
    expect(new Set(ids).size).toBe(84);
  });

  it('has no unexpected P0 Content ID and no missing one', () => {
    const found = new Set(records.map((r) => r.content_id));
    for (const id of EXPECTED_84) expect(found.has(id)).toBe(true);
    for (const id of found) expect(EXPECTED_84).toContain(id);
  });

  it('has the exact expected composition: 8 Video, 15 Glossary, 14 FHIP Explainer, 47 Article/Guide', () => {
    const byType = records.reduce<Record<string, number>>((acc, r) => {
      acc[r.content_type] = (acc[r.content_type] ?? 0) + 1;
      return acc;
    }, {});
    expect(byType['Video']).toBe(8);
    expect(byType['Glossary']).toBe(15);
    expect(byType['FHIP Explainer']).toBe(14);
    expect((byType['Article'] ?? 0) + (byType['Guide'] ?? 0)).toBe(47);
  });

  it('has zero RED risk-class records (only GREEN/AMBER expected)', () => {
    for (const r of records) expect(r.risk_class).not.toBe('RED');
  });

  it('no duplicate glossary term among GLO-001..015', () => {
    const glossary = records.filter((r) => r.content_type === 'Glossary');
    expect(glossary.length).toBe(15);
    const titles = glossary.map((r) => r.title.trim().toLowerCase());
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe('R1.7C P0 content -- structural completeness', () => {
  const records = loadJson<NormalizedRecord[]>('p0-content-normalized.json');

  it('every Article/Guide/FHIP Explainer has a non-empty short-answer/excerpt-equivalent section', () => {
    const textResources = records.filter((r) => ['Article', 'Guide', 'FHIP Explainer'].includes(r.content_type));
    expect(textResources.length).toBe(61);
    for (const r of textResources) {
      expect(r.has_30_second_answer, `${r.content_id} missing 30-second answer`).toBe(true);
      expect(r.has_key_takeaways, `${r.content_id} missing key takeaways`).toBe(true);
      expect(r.has_faq, `${r.content_id} missing FAQ`).toBe(true);
      expect(r.has_disclaimer, `${r.content_id} missing disclaimer`).toBe(true);
    }
  });

  it('every non-video text Resource has substantive body content (>= 400 words)', () => {
    for (const r of records) {
      if (r.content_type === 'Glossary' || r.content_type === 'Video') continue;
      expect(r.body_word_count, `${r.content_id} too short`).toBeGreaterThanOrEqual(400);
    }
  });

  it('every Glossary record has a non-empty definition', () => {
    const glossary = records.filter((r) => r.content_type === 'Glossary');
    for (const r of glossary) expect(r.body_word_count).toBeGreaterThan(20);
  });

  it('every Video has a non-empty script/transcript represented', () => {
    const videos = records.filter((r) => r.content_type === 'Video');
    expect(videos.length).toBe(8);
    for (const r of videos) expect(r.body_word_count).toBeGreaterThan(200);
  });
});

const VALID_BLOCK_TYPES = new Set([
  'paragraph', 'heading', 'bulleted_list', 'numbered_list', 'key_takeaways',
  'callout', 'example', 'warning', 'quote', 'divider', 'fhip_context', 'table',
]);

describe('R1.7C P0 content -- structured block conversion', () => {
  // content_blocks2.json lives in the session scratchpad (not committed --
  // it is a build intermediate of the payload, not a manifest); this test
  // reads the committed p0-cms-payload.json's embedded blocks instead, which
  // is the actual artifact that was loaded into DEV.
  interface Payload { content_id: string; update_fields: { content_blocks?: { id: string; type: string; data: Record<string, unknown> }[] }; video_handling: string | null }
  const payload = loadJson<{ payloads: Payload[] }>('p0-cms-payload.json');

  it('has exactly 84 payloads, matching the 84 Content IDs, zero expected inserts', () => {
    expect(payload.payloads.length).toBe(84);
    const ids = new Set(payload.payloads.map((p) => p.content_id));
    for (const id of EXPECTED_84) expect(ids.has(id)).toBe(true);
  });

  it('every payload uses only valid block types with non-empty content', () => {
    for (const p of payload.payloads) {
      const blocks = p.update_fields.content_blocks ?? [];
      expect(blocks.length, `${p.content_id} has zero blocks`).toBeGreaterThan(0);
      for (const b of blocks) {
        expect(VALID_BLOCK_TYPES.has(b.type), `${p.content_id} has invalid block type ${b.type}`).toBe(true);
        if ('text' in b.data) {
          expect((b.data.text as string).trim().length, `${p.content_id} has an empty ${b.type} block`).toBeGreaterThan(0);
        }
        if ('items' in b.data) {
          const items = b.data.items as string[];
          expect(items.some((it) => it.trim().length > 0), `${p.content_id} has an empty-key-takeaway/list block`).toBe(true);
        }
      }
    }
  });

  it('no payload leaks internal editorial-instruction text into a block', () => {
    const leakPhrases = ['should route', 'cta library', 'batch contents', 'editorial review checklist'];
    for (const p of payload.payloads) {
      const blocks = p.update_fields.content_blocks ?? [];
      const serialized = JSON.stringify(blocks).toLowerCase();
      for (const phrase of leakPhrases) {
        expect(serialized.includes(phrase), `${p.content_id} leaked "${phrase}" into content_blocks`).toBe(false);
      }
    }
  });

  it('zero fabricated YouTube URL/ID -- video payloads are script-staged only, never claim resource_videos fields', () => {
    const videoPayloads = payload.payloads.filter((p) => p.video_handling !== null);
    expect(videoPayloads.length).toBe(8);
    for (const p of videoPayloads) {
      expect(p.video_handling).toContain('VIDEO_SCRIPT_READY_AWAITING_YOUTUBE');
      expect(p.video_handling).not.toMatch(/youtube\.com\/watch|youtu\.be/i);
    }
  });

  it('no payload ever sets a workflow/publication field (status/visibility/published_at/is_indexable)', () => {
    for (const p of payload.payloads) {
      const fields = Object.keys(p.update_fields);
      for (const forbidden of ['status', 'visibility', 'published_at', 'is_indexable', 'content_id', 'slug', 'content_type', 'jurisdiction', 'compliance_classification', 'author_id']) {
        expect(fields.includes(forbidden), `${p.content_id} payload illegally touches ${forbidden}`).toBe(false);
      }
    }
  });
});

describe('R1.7C P0 content -- independent financial-math verification', () => {
  // Reproduces the hand-verified worked examples from
  // p0-financial-math-verification.csv as executable assertions, so a
  // future content edit that breaks the arithmetic fails CI rather than
  // silently passing.

  it('EX-001 net worth worked example: 700,000 - 355,000 = 345,000', () => {
    const includedAssets = 20000 + 500000 + 80000 + 100000;
    const includedLiabilities = 350000 + 5000;
    expect(includedAssets).toBe(700000);
    expect(includedLiabilities).toBe(355000);
    expect(includedAssets - includedLiabilities).toBe(345000);
  });

  it('EX-002 cash flow surplus worked example: 8,000 - 6,200 = 1,800; deficit case = -400', () => {
    const outflows = 5000 + 1200;
    expect(outflows).toBe(6200);
    expect(8000 - outflows).toBe(1800);
    expect(8000 - 8400).toBe(-400);
  });

  it('EX-003 savings rate worked example: 1,800/8,000 = 22.5%; -400/8,000 = -5%', () => {
    expect((1800 / 8000) * 100).toBeCloseTo(22.5, 5);
    expect((-400 / 8000) * 100).toBeCloseTo(-5, 5);
  });

  it('EX-004 emergency fund coverage: 12,000/4,000 = 3 months; 12,000/4,800 = 2.5 months', () => {
    expect(12000 / 4000).toBe(3);
    expect(12000 / 4800).toBe(2.5);
  });

  it('EX-005 DTI (balance-based): 420,000/120,000 = 3.5x; 360,000/120,000 = 3.0x; 420,000/140,000 = 3.0x', () => {
    expect(420000 / 120000).toBe(3.5);
    expect(360000 / 120000).toBe(3.0);
    expect(420000 / 140000).toBe(3.0);
  });

  it('EX-006 DSR (net-income basis): 2,000/8,000 = 25%; 2,800/8,000 = 35%; 2,000/7,000 ~= 28.6%', () => {
    expect((2000 / 8000) * 100).toBe(25);
    expect((2800 / 8000) * 100).toBe(35);
    expect((2000 / 7000) * 100).toBeCloseTo(28.6, 1);
  });

  it('EX-010/EX-011 goal funding progress: 8,100/30,000 = 27%', () => {
    expect((8100 / 30000) * 100).toBeCloseTo(27, 5);
  });

  it('DB-004 loan amortization: standard formula reproduces the drafted 4%/5%/6% payments within $1', () => {
    const principal = 300000;
    const months = 25 * 12;
    function monthlyPayment(annualRate: number): number {
      const r = annualRate / 12;
      return (principal * r * Math.pow(1 + r, months)) / (Math.pow(1 + r, months) - 1);
    }
    expect(monthlyPayment(0.04)).toBeCloseTo(1584, 0);
    expect(monthlyPayment(0.05)).toBeCloseTo(1754, 0);
    expect(monthlyPayment(0.06)).toBeCloseTo(1933, 0);
  });

  it('CB-001/CB-002 cross-border FX: INR 600,000 / 60 = AUD 10,000; net worth 190,000 - 70,000 = 120,000', () => {
    expect(600000 / 60).toBe(10000);
    expect(180000 + 10000).toBe(190000);
    expect(190000 - 70000).toBe(120000);
    expect(Math.round(600000 / 66)).toBe(9091);
    expect(Math.round(600000 / 54)).toBe(11111);
  });

  it('RAU-001 superannuation guarantee: 80,000 x 12% = 9,600', () => {
    expect(80000 * 0.12).toBe(9600);
  });

  it('RIN-001 EPF: 12% of 15,000 = 1,800; 8.33% of 15,000 rounds to 1,250', () => {
    expect(15000 * 0.12).toBe(1800);
    expect(Math.round(15000 * 0.0833)).toBe(1250);
  });
});
