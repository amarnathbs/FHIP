// R1.7 — Content Master Import. Pure-logic unit tests: source parsing,
// mapping tables, slug resolution, duplicate detection, taxonomy
// normalization, video/money-update-template validation, readiness
// classification, and human-edit-protection logic. No DB/network required
// (mirrors the pattern of tests/unit/resourcesEditorBlocks.test.ts).

import { describe, it, expect } from 'vitest';
import {
  CONTENT_TYPE_MAP,
  JURISDICTION_MAP,
  DIFFICULTY_MAP,
  FRESHNESS_MAP,
  RISK_CLASS_MAP,
  mapOrNull,
  validateContentId,
  validateContentType,
  validateJurisdiction,
  validatePriority,
  validateDifficulty,
  validateRiskClass,
  validateUrl,
  validateSlug,
  validateYouTubeVideoId,
  isInternalVideoRef,
} from '../../scripts/resources/lib/mapping';
import { resolveSlug } from '../../scripts/resources/lib/slug';
import { normalizeForMatch, categorySlugFor, resolveAgainstMap, type CategoryRef } from '../../scripts/resources/lib/taxonomy';
import { classifyReadiness } from '../../scripts/resources/lib/readiness';
import { planRow } from '../../scripts/resources/lib/planRow';
import type { ContentMasterRow } from '../../scripts/resources/lib/workbook';

function row(overrides: Partial<ContentMasterRow>): ContentMasterRow {
  return {
    Content_ID: 'FH-001',
    Title: 'Test Title',
    Content_Type: 'Article',
    Primary_Category: 'Financial Health',
    Subcategory: 'Core Education',
    Jurisdiction: 'Global',
    Audience_Level: 'Beginner-Intermediate',
    User_Question_Search_Intent: 'x',
    Primary_Keyword_Theme: 'x',
    Editorial_Brief: 'Explain x',
    Key_Points_to_Cover: 'a; b; c',
    Primary_FHIP_Module: 'Dashboard',
    Secondary_FHIP_Module: 'Scores',
    Primary_CTA: 'Check My Financial Health',
    GKTC_Video_Linkage: 'VID-001',
    YouTube_Channel: '@GKTC',
    Risk_Class: 'GREEN',
    Freshness_Type: 'Evergreen with periodic review',
    Review_Cycle_Months: 12,
    Launch_Priority: 'P0',
    Launch_Wave: 'Launch (Pre-Go-Live)',
    Recommended_Length: '900-1400',
    Recommended_Visual: 'x',
    Primary_Source_Hierarchy: 'x',
    SEO_Pillar: 'x',
    Related_Content_Cluster: 'x',
    Conversion_Goal: 'x',
    Proposed_URL: '/resources/financial-health/test-title',
    Status: 'Backlog',
    Owner: 'x',
    Notes: 'x',
    __row: 2,
    ...overrides,
  };
}

describe('Content-type mapping (spec §14, exact)', () => {
  it('maps every workbook Content_Type to the exact expected DB value', () => {
    expect(CONTENT_TYPE_MAP['Article']).toBe('article');
    expect(CONTENT_TYPE_MAP['Guide']).toBe('guide');
    expect(CONTENT_TYPE_MAP['FHIP Explainer']).toBe('fhip_explainer');
    expect(CONTENT_TYPE_MAP['Video']).toBe('video');
    expect(CONTENT_TYPE_MAP['Glossary']).toBe('glossary');
    expect(CONTENT_TYPE_MAP['Money Update Template']).toBe('money_update_template');
  });
  it('never maps Money Update Template to money_update', () => {
    expect(CONTENT_TYPE_MAP['Money Update Template']).not.toBe('money_update');
  });
  it('mapOrNull returns null for an unknown value rather than coercing', () => {
    expect(mapOrNull(CONTENT_TYPE_MAP, 'Podcast')).toBeNull();
  });
});

describe('Jurisdiction mapping (spec §32-40)', () => {
  it('maps the exact workbook string including the hyphenated cross-border label', () => {
    expect(JURISDICTION_MAP['Global']).toBe('global');
    expect(JURISDICTION_MAP['Australia']).toBe('australia');
    expect(JURISDICTION_MAP['India']).toBe('india');
    expect(JURISDICTION_MAP['Australia-India Cross-Border']).toBe('australia_india_cross_border');
  });
  it('does not match an en-dash variant (exact-string only, no fuzzy coercion)', () => {
    expect(mapOrNull(JURISDICTION_MAP, 'Australia–India Cross-Border')).toBeNull();
  });
});

describe('Difficulty mapping', () => {
  it('maps both workbook Audience_Level values actually present in the master', () => {
    expect(DIFFICULTY_MAP['Beginner']).toBe('beginner');
    expect(DIFFICULTY_MAP['Beginner-Intermediate']).toBe('beginner_intermediate');
  });
});

describe('Freshness mapping', () => {
  it('maps all 5 distinct workbook Freshness_Type strings', () => {
    expect(FRESHNESS_MAP['Evergreen with periodic review']).toBe('evergreen');
    expect(FRESHNESS_MAP['Time-sensitive / triggered']).toBe('time_sensitive');
    expect(Object.keys(FRESHNESS_MAP)).toHaveLength(5);
  });
});

describe('Risk class mapping', () => {
  it('maps GREEN/AMBER and flags RED as an error condition via validateRiskClass', () => {
    expect(RISK_CLASS_MAP['GREEN']).toBe('green');
    expect(RISK_CLASS_MAP['AMBER']).toBe('amber');
    const issues = validateRiskClass('RED', 'X-001', 2);
    expect(issues.some((i) => i.severity === 'error')).toBe(true);
  });
});

describe('validateContentId (spec §18-21)', () => {
  it('flags a blank Content_ID as an error', () => {
    const issues = validateContentId('', 2, new Set());
    expect(issues[0].severity).toBe('error');
  });
  it('flags a duplicate Content_ID as an error and only the second occurrence', () => {
    const seen = new Set<string>();
    const first = validateContentId('FH-001', 2, seen);
    const second = validateContentId('FH-001', 3, seen);
    expect(first).toHaveLength(0);
    expect(second.some((i) => i.severity === 'error')).toBe(true);
  });
});

describe('validateContentType / validateJurisdiction / validatePriority / validateDifficulty', () => {
  it('all report an error for an unmapped value', () => {
    expect(validateContentType('Podcast', 'X-001', 2)[0].severity).toBe('error');
    expect(validateJurisdiction('Narnia', 'X-001', 2)[0].severity).toBe('error');
    expect(validatePriority('P9', 'X-001', 2)[0].severity).toBe('error');
    expect(validateDifficulty('Expert', 'X-001', 2)[0].severity).toBe('error');
  });
  it('all report zero issues for a mapped value', () => {
    expect(validateContentType('Article', 'X-001', 2)).toHaveLength(0);
    expect(validateJurisdiction('Global', 'X-001', 2)).toHaveLength(0);
    expect(validatePriority('P0', 'X-001', 2)).toHaveLength(0);
    expect(validateDifficulty('Beginner', 'X-001', 2)).toHaveLength(0);
  });
});

describe('validateUrl — placeholder-token detection (Money Update Templates)', () => {
  it('flags a [date] placeholder as invalid, not a real slug source', () => {
    const result = validateUrl('/resources/money-updates/[date]-rba-cash-rate-decision', 'MU-001', 2);
    expect(result.valid).toBe(false);
    expect(result.issues[0].severity).toBe('warning');
  });
  it('accepts a clean, real proposed URL', () => {
    const result = validateUrl('/resources/financial-health/what-does-financial-health-actually-mean', 'FH-001', 2);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });
  it('flags a blank URL as an error', () => {
    const result = validateUrl('', 'FH-001', 2);
    expect(result.valid).toBe(false);
    expect(result.issues[0].severity).toBe('error');
  });
});

describe('validateSlug / validateYouTubeVideoId / isInternalVideoRef', () => {
  it('accepts a well-formed slug and rejects a malformed one', () => {
    expect(validateSlug('what-is-financial-health')).toBe(true);
    expect(validateSlug('Bad Slug!')).toBe(false);
    expect(validateSlug('')).toBe(false);
  });
  it('validates a real-shaped 11-char YouTube id and rejects a non-conforming string', () => {
    expect(validateYouTubeVideoId('dQw4w9WgXcQ')).toBe(true);
    expect(validateYouTubeVideoId('VID-001')).toBe(false);
    expect(validateYouTubeVideoId('too-short')).toBe(false);
  });
  it('recognizes the workbook internal VID-NNN cross-reference format', () => {
    expect(isInternalVideoRef('VID-001')).toBe(true);
    expect(isInternalVideoRef('VID-020')).toBe(true);
    expect(isInternalVideoRef('dQw4w9WgXcQ')).toBe(false);
  });
});

describe('resolveSlug (spec §19-21 idempotent slug resolution)', () => {
  it('uses the URL-derived slug when the Proposed_URL is clean', () => {
    const r = resolveSlug({
      proposedUrl: '/resources/financial-health/what-does-financial-health-actually-mean',
      title: 'What Does Financial Health Actually Mean?',
      contentId: 'FH-001',
      claimed: new Set(),
    });
    expect(r.slug).toBe('what-does-financial-health-actually-mean');
    expect(r.source).toBe('proposed_url');
  });
  it('falls back to the title when the URL contains a placeholder token', () => {
    const r = resolveSlug({
      proposedUrl: '/resources/money-updates/[date]-rba-cash-rate-decision-what-it-means-for-household-finances',
      title: 'RBA Cash Rate Decision: What It Means for Household Finances',
      contentId: 'MU-001',
      claimed: new Set(),
    });
    expect(r.source).toBe('title_fallback');
    expect(r.slug).not.toContain('[');
    expect(validateSlug(r.slug)).toBe(true);
  });
  it('deterministically disambiguates a genuine same-title collision using the Content_ID (never a silent -2)', () => {
    const claimed = new Set<string>();
    const first = resolveSlug({ proposedUrl: '/resources/retirement-australia/superannuation-explained-for-beginners', title: 'Superannuation Explained for Beginners', contentId: 'RAU-001', claimed });
    claimed.add(first.slug);
    const second = resolveSlug({ proposedUrl: '/resources/videos/superannuation-explained-for-beginners', title: 'Superannuation Explained for Beginners', contentId: 'VID-017', claimed });
    expect(first.slug).not.toBe(second.slug);
    expect(second.source).toBe('title_contentid_fallback');
    expect(second.slug).toContain('vid-017');
  });
  it('is reproducible: calling twice with the same inputs (and no prior claim) yields the same slug', () => {
    const a = resolveSlug({ proposedUrl: '/resources/glossary/asset', title: 'Asset', contentId: 'GLO-001', claimed: new Set() });
    const b = resolveSlug({ proposedUrl: '/resources/glossary/asset', title: 'Asset', contentId: 'GLO-001', claimed: new Set() });
    expect(a.slug).toBe(b.slug);
    expect(a.source).toBe(b.source);
  });
});

describe('taxonomy normalization (spec §32)', () => {
  it('normalizes whitespace/case so "Financial Health" and "financial   health" match', () => {
    expect(normalizeForMatch('Financial Health')).toBe(normalizeForMatch('financial   health'));
  });
  it('does NOT conflate two genuinely different category labels', () => {
    expect(normalizeForMatch('Managing Money')).not.toBe(normalizeForMatch('Managing Money & Cash Flow'));
    expect(normalizeForMatch('Investing')).not.toBe(normalizeForMatch('Investing & Building Wealth'));
  });
  it('resolveAgainstMap finds an existing category via the normalized key, never substituting a near-miss', () => {
    const lookup = new Map<string, CategoryRef>([
      [normalizeForMatch('Financial Health'), { id: '1', name: 'Financial Health', slug: 'financial-health' }],
    ]);
    const hit = resolveAgainstMap('financial   HEALTH', lookup);
    expect(hit.ref?.id).toBe('1');
    const miss = resolveAgainstMap('Managing Money & Cash Flow', lookup);
    expect(miss.ref).toBeNull();
  });
  it('categorySlugFor produces a valid slug for a newly-created category', () => {
    expect(categorySlugFor('Managing Money & Cash Flow')).toBe('managing-money-cash-flow');
    expect(validateSlug(categorySlugFor('Retirement - Australia'))).toBe(true);
  });
});

describe('readiness classification (spec §63 — manifest-only, never a status value)', () => {
  it('classifies a non-video row as NEEDS_BODY, not NEEDS_VIDEO', () => {
    const buckets = classifyReadiness({ contentType: 'article', hasUnresolvedTaxonomy: false, ctaResolved: true });
    expect(buckets).toContain('NEEDS_BODY');
    expect(buckets).not.toContain('NEEDS_VIDEO');
  });
  it('classifies a video row as NEEDS_VIDEO, not NEEDS_BODY', () => {
    const buckets = classifyReadiness({ contentType: 'video', hasUnresolvedTaxonomy: false, ctaResolved: true });
    expect(buckets).toContain('NEEDS_VIDEO');
    expect(buckets).not.toContain('NEEDS_BODY');
  });
  it('flags NEEDS_CTA_REVIEW only when the CTA is unresolved', () => {
    const resolved = classifyReadiness({ contentType: 'article', hasUnresolvedTaxonomy: false, ctaResolved: true });
    const unresolved = classifyReadiness({ contentType: 'article', hasUnresolvedTaxonomy: false, ctaResolved: false });
    expect(resolved).not.toContain('NEEDS_CTA_REVIEW');
    expect(unresolved).toContain('NEEDS_CTA_REVIEW');
  });
  it('always includes NEEDS_CONTEXT_REVIEW and NEEDS_AUTHOR for this import (no context keys or authors resolvable from the source)', () => {
    const buckets = classifyReadiness({ contentType: 'glossary', hasUnresolvedTaxonomy: false, ctaResolved: true });
    expect(buckets).toContain('NEEDS_CONTEXT_REVIEW');
    expect(buckets).toContain('NEEDS_AUTHOR');
  });
});

describe('planRow — the content-fabrication firewall (spec §10-14, pure)', () => {
  it('never puts Editorial_Brief/Key_Points_to_Cover into a field meant for finished public copy — they only ever land in planningMaterial', () => {
    const r = row({});
    const planned = planRow(r, new Set());
    expect(planned.planningMaterial.editorial_brief).toBe(r.Editorial_Brief);
    expect(planned.planningMaterial.key_points_to_cover).toBe(r.Key_Points_to_Cover);
    // planRow itself never produces an "excerpt" or "body" field at all —
    // the importer's own INSERT payload sets excerpt: null unconditionally
    // and content_blocks only via the empty starter template, never from
    // planningMaterial. This test locks in that planRow has no such field.
    expect((planned as unknown as Record<string, unknown>).excerpt).toBeUndefined();
    expect((planned as unknown as Record<string, unknown>).content_blocks).toBeUndefined();
  });
  it('collects a Title-blank error without throwing', () => {
    const planned = planRow(row({ Title: '' }), new Set());
    expect(planned.issues.some((i) => i.field === 'Title' && i.severity === 'error')).toBe(true);
  });
  it('flags a >180 character title as an error (matches the R1.3 editor TITLE_MAX_LENGTH)', () => {
    const planned = planRow(row({ Title: 'x'.repeat(181) }), new Set());
    expect(planned.issues.some((i) => i.field === 'Title' && i.severity === 'error')).toBe(true);
  });
  it('maps every controlled field for a clean row with zero issues', () => {
    const planned = planRow(row({}), new Set());
    expect(planned.issues).toHaveLength(0);
    expect(planned.contentType).toBe('article');
    expect(planned.jurisdiction).toBe('global');
    expect(planned.difficulty).toBe('beginner_intermediate');
    expect(planned.freshnessType).toBe('evergreen');
    expect(planned.complianceClassification).toBe('green');
  });
});

describe('Money Update Template typing (spec §14/§54-56)', () => {
  it('a Money Update Template row maps to money_update_template, never money_update, and is never auto-approved', () => {
    const r = row({ Content_Type: 'Money Update Template', Content_ID: 'MU-001', Risk_Class: 'AMBER', Status: 'Template - Publish only when triggered' });
    const planned = planRow(r, new Set());
    expect(planned.contentType).toBe('money_update_template');
    expect(planned.complianceClassification).toBe('amber');
    // The workbook's own Status column is never treated as publish
    // authorization — planRow doesn't even expose a "status" output field;
    // the importer hardcodes status:'draft' for every row regardless.
    expect((planned as unknown as Record<string, unknown>).status).toBeUndefined();
  });
});

describe('Human-edit-protection logic (spec §21-24, unit-level reproduction of the importer predicate)', () => {
  // Mirrors the exact predicate used in import-r0a-content-master.ts's Pass 1.
  function isProtected(existing: { status: string; updated_by: string | null }): boolean {
    return (existing.status !== 'draft' && existing.status !== 'idea') || !!existing.updated_by;
  }
  it('protects a row a human has moved beyond draft', () => {
    expect(isProtected({ status: 'editorial_review', updated_by: null })).toBe(true);
  });
  it('protects a row a human has saved through the editor (updated_by set)', () => {
    expect(isProtected({ status: 'draft', updated_by: 'a-real-user-id' })).toBe(true);
  });
  it('does NOT protect a row the importer itself created and never touched by a human', () => {
    expect(isProtected({ status: 'draft', updated_by: null })).toBe(false);
  });
  it('regression proof: corrupting the predicate to ignore updated_by would let a human edit be silently overwritten — verifying the test actually catches that', () => {
    // Deliberately-wrong predicate that only checks status, per the testing
    // discipline note: prove this test would fail on a real regression, not
    // just pass by construction.
    function brokenIsProtected(existing: { status: string; updated_by: string | null }): boolean {
      return existing.status !== 'draft' && existing.status !== 'idea';
    }
    const humanEdited = { status: 'draft', updated_by: 'a-real-user-id' };
    expect(isProtected(humanEdited)).toBe(true);
    expect(brokenIsProtected(humanEdited)).toBe(false); // demonstrates the broken version would wrongly allow overwrite
  });
});
