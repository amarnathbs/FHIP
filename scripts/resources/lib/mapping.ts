// R1.7 — explicit mapping tables + row-level validators (spec §14/§32-40/§66-73).
// Every controlled-value mapping is an explicit table lookup; nothing is
// coerced by pattern-matching or guessing (spec §72: "don't assume AU means
// Australia without an explicit mapping table entry").

export type ResourceContentType = 'article' | 'guide' | 'fhip_explainer' | 'video' | 'glossary' | 'money_update_template';
export type ResourceJurisdiction = 'global' | 'australia' | 'india' | 'australia_india_cross_border';
export type ResourceDifficulty = 'beginner' | 'beginner_intermediate' | 'intermediate' | 'intermediate_advanced' | 'advanced';
export type ResourceFreshness = 'evergreen' | 'time_sensitive';
export type ComplianceClassification = 'green' | 'amber' | 'red';

// spec §14 — exact content-type mapping. Money Update Template MUST map to
// 'money_update_template', never 'money_update'.
export const CONTENT_TYPE_MAP: Record<string, ResourceContentType> = {
  Article: 'article',
  Guide: 'guide',
  'FHIP Explainer': 'fhip_explainer',
  Video: 'video',
  Glossary: 'glossary',
  'Money Update Template': 'money_update_template',
};

// Workbook's exact literal string (hyphen, not en-dash) — confirmed by our
// own parse (see preimport validation report).
export const JURISDICTION_MAP: Record<string, ResourceJurisdiction> = {
  Global: 'global',
  Australia: 'australia',
  India: 'india',
  'Australia-India Cross-Border': 'australia_india_cross_border',
};

export const DIFFICULTY_MAP: Record<string, ResourceDifficulty> = {
  Beginner: 'beginner',
  'Beginner-Intermediate': 'beginner_intermediate',
  Intermediate: 'intermediate',
  'Intermediate-Advanced': 'intermediate_advanced',
  Advanced: 'advanced',
};

// Freshness_Type is free text in the workbook (5 distinct values observed
// across all 218 rows) mapped onto the DB's 2-value evergreen/time_sensitive
// enum. "Product-dependent; update on logic change" is mapped to
// 'evergreen' deliberately: it is not tied to an external dated event (the
// trigger is an internal FHIP logic change, not a calendar date), which is
// what distinguishes it from the one genuinely time-sensitive value below.
// Documented explicitly (not a silent coercion) — see the completion report
// §M for the reasoning recorded against this exact decision.
export const FRESHNESS_MAP: Record<string, ResourceFreshness> = {
  'Evergreen with periodic review': 'evergreen',
  'Evergreen definition; product/rule terms reviewed periodically': 'evergreen',
  'Product-dependent; update on logic change': 'evergreen',
  'Evergreen video; replace/update if rules materially change': 'evergreen',
  'Time-sensitive / triggered': 'time_sensitive',
};

export const RISK_CLASS_MAP: Record<string, ComplianceClassification> = {
  GREEN: 'green',
  AMBER: 'amber',
  RED: 'red', // never expected in this master (confirmed 0/218) but mapped for completeness/fail-closed
};

export function mapOrNull<T extends string>(table: Record<string, T>, value: string): T | null {
  return Object.prototype.hasOwnProperty.call(table, value) ? table[value] : null;
}

// ---------------------------------------------------------------------------
// Row-level validators — collect all errors, never throw mid-validation.
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  contentId: string;
  row: number;
  field: string;
  message: string;
  severity: 'error' | 'warning';
}

export function validateContentId(id: string, row: number, seen: Set<string>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!id || id.trim() === '') {
    issues.push({ contentId: id || '(blank)', row, field: 'Content_ID', message: 'Content_ID is blank', severity: 'error' });
    return issues;
  }
  if (!/^[A-Z]{2,4}-\d{3}$/.test(id)) {
    issues.push({ contentId: id, row, field: 'Content_ID', message: `Content_ID "${id}" does not match the expected PREFIX-NNN shape`, severity: 'warning' });
  }
  if (seen.has(id)) {
    issues.push({ contentId: id, row, field: 'Content_ID', message: `Duplicate Content_ID "${id}"`, severity: 'error' });
  }
  seen.add(id);
  return issues;
}

export function validateContentType(value: string, contentId: string, row: number): ValidationIssue[] {
  if (!mapOrNull(CONTENT_TYPE_MAP, value)) {
    return [{ contentId, row, field: 'Content_Type', message: `Unknown Content_Type "${value}" — no mapping table entry`, severity: 'error' }];
  }
  return [];
}

export function validateJurisdiction(value: string, contentId: string, row: number): ValidationIssue[] {
  if (!mapOrNull(JURISDICTION_MAP, value)) {
    return [{ contentId, row, field: 'Jurisdiction', message: `Unknown Jurisdiction "${value}" — no mapping table entry`, severity: 'error' }];
  }
  return [];
}

export function validatePriority(value: string, contentId: string, row: number): ValidationIssue[] {
  const known = new Set(['P0', 'P1', 'P2', 'Ongoing']);
  if (!known.has(value)) {
    return [{ contentId, row, field: 'Launch_Priority', message: `Unknown Launch_Priority "${value}"`, severity: 'error' }];
  }
  return [];
}

export function validateDifficulty(value: string, contentId: string, row: number): ValidationIssue[] {
  if (!value) return [{ contentId, row, field: 'Audience_Level', message: 'Audience_Level is blank', severity: 'warning' }];
  if (!mapOrNull(DIFFICULTY_MAP, value)) {
    return [{ contentId, row, field: 'Audience_Level', message: `Unknown Audience_Level "${value}" — no mapping table entry`, severity: 'error' }];
  }
  return [];
}

export function validateRiskClass(value: string, contentId: string, row: number): ValidationIssue[] {
  if (!mapOrNull(RISK_CLASS_MAP, value)) {
    return [{ contentId, row, field: 'Risk_Class', message: `Unknown Risk_Class "${value}"`, severity: 'error' }];
  }
  if (value === 'RED') {
    return [{ contentId, row, field: 'Risk_Class', message: 'RED content present — RED is explicitly out of scope for this master per the R0-A specification', severity: 'error' }];
  }
  return [];
}

export function validateFreshness(value: string, contentId: string, row: number): ValidationIssue[] {
  if (!mapOrNull(FRESHNESS_MAP, value)) {
    return [{ contentId, row, field: 'Freshness_Type', message: `Unknown Freshness_Type "${value}" — no mapping table entry`, severity: 'error' }];
  }
  return [];
}

export function validateUrl(url: string, contentId: string, row: number): { valid: boolean; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  if (!url) {
    issues.push({ contentId, row, field: 'Proposed_URL', message: 'Proposed_URL is blank', severity: 'error' });
    return { valid: false, issues };
  }
  if (url.includes('[') || url.includes(']')) {
    issues.push({ contentId, row, field: 'Proposed_URL', message: `Proposed_URL contains an unresolved placeholder token: "${url}" — cannot be used as a real slug, falling back to title-derived slug`, severity: 'warning' });
    return { valid: false, issues };
  }
  if (!url.startsWith('/resources/')) {
    issues.push({ contentId, row, field: 'Proposed_URL', message: `Proposed_URL "${url}" does not start with /resources/`, severity: 'warning' });
  }
  return { valid: true, issues };
}

const SLUG_FORMAT_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export function validateSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= 200 && SLUG_FORMAT_RE.test(slug);
}

// spec §72 — YouTube video-id validator exists even though this import
// never has a real value to validate (all 20 Video rows carry only internal
// VID-NNN cross-references, not real YouTube IDs) — kept ready for the day
// real @GKTC metadata is entered through the normal video editor, and
// exercised directly by the unit tests against both a real-shaped and a
// deliberately-fake id.
const YOUTUBE_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
export function validateYouTubeVideoId(id: string): boolean {
  return YOUTUBE_ID_RE.test(id);
}

// spec's own confirmed finding: GKTC_Video_Linkage on Video rows is always
// an internal VID-NNN cross-reference, never a real YouTube ID. This
// recognizer exists so the importer can assert that fact as a real check
// (not just an assumption) against every one of the 20 Video rows.
const INTERNAL_VID_REF_RE = /^VID-\d{3}$/;
export function isInternalVideoRef(value: string): boolean {
  return INTERNAL_VID_REF_RE.test(value);
}
