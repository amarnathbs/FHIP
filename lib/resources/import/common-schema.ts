// Resources Bulk Upload -- column definitions shared by BOTH adapters.
//
// The controlled values below mirror the CHECK constraints on resource_posts
// (migration 0049) exactly and are the ONLY values the importer accepts. Do not
// invent a value here without a matching database change.

import type { ColumnSpec } from './types';

export const JURISDICTION_VALUES = ['global', 'australia', 'india', 'australia_india_cross_border'] as const;
export const DIFFICULTY_VALUES = ['beginner', 'beginner_intermediate', 'intermediate', 'intermediate_advanced', 'advanced'] as const;
export const COMPLIANCE_VALUES = ['green', 'amber', 'red'] as const;
export const ARTICLE_FRESHNESS_VALUES = ['evergreen', 'time_sensitive'] as const;

export const SOURCE_COUNT = 2;
export const SOURCE_FIELD_SUFFIXES = ['name', 'document_title', 'url', 'type', 'publication_date', 'is_public'] as const;
export type SourceFieldSuffix = (typeof SOURCE_FIELD_SUFFIXES)[number];

/**
 * Columns that may NEVER appear in an upload file: workflow state, approvals,
 * scheduling, visibility and the content type itself. The screen the person
 * chose decides the type; the spreadsheet cannot switch it, approve, schedule,
 * publish or change visibility. A file carrying one of these is rejected whole.
 */
export const FORBIDDEN_COLUMNS: readonly string[] = [
  'status',
  'visibility',
  'content_type',
  'type',
  'published_at',
  'scheduled_at',
  'approved_by',
  'approved_at',
  'editorial_approved_by',
  'editorial_approved_at',
  'compliance_approved_by',
  'compliance_approved_at',
  'reviewer',
  'reviewer_id',
  'compliance_reviewer',
  'compliance_reviewer_id',
  'compliance_approval',
  'editorial_approval',
  'workflow_status',
  'workflow_history',
  'is_featured',
  'created_by',
  'updated_by',
  'id',
  'post_id',
];

export function sourceColumns(): ColumnSpec[] {
  const cols: ColumnSpec[] = [];
  for (let n = 1; n <= SOURCE_COUNT; n++) {
    const first = n === 1;
    cols.push(
      {
        key: `source_${n}_name`,
        kind: 'text',
        required: false,
        label: `Source ${n} name`,
        help: `The authority or publisher of source ${n}${first ? '. Fill in at least the name for every source you cite' : ''}. If any other source ${n} column is filled in, the name is required.`,
        example: first ? 'Reserve Bank of Australia' : 'Australian Taxation Office',
        maxLength: 200,
      },
      {
        key: `source_${n}_document_title`,
        kind: 'text',
        required: false,
        label: `Source ${n} document title`,
        help: 'The title of the specific document or page. Optional.',
        example: first ? 'Statement on Monetary Policy' : 'Tax rates and thresholds',
        maxLength: 300,
      },
      {
        key: `source_${n}_url`,
        kind: 'url',
        required: false,
        label: `Source ${n} URL`,
        help: 'A secure link starting with https://. Links that start with http://, javascript:, data:, file: or ftp: are rejected.',
        example: first ? 'https://www.rba.gov.au/publications/smp/' : 'https://www.ato.gov.au/tax-rates-and-codes',
      },
      {
        key: `source_${n}_type`,
        kind: 'text',
        required: false,
        label: `Source ${n} type`,
        help: 'A short label for the kind of source (see Lookup_Values for the usual ones). Free text, up to 100 characters.',
        example: first ? 'regulator' : 'official_publication',
        maxLength: 100,
      },
      {
        key: `source_${n}_publication_date`,
        kind: 'date',
        required: false,
        label: `Source ${n} publication date`,
        help: 'When the source was published. Optional. File format: year-month-day with hyphens.',
        example: first ? '2026-08-12' : '2026-07-01',
      },
      {
        key: `source_${n}_is_public`,
        kind: 'boolean',
        required: false,
        label: `Source ${n} publicly citable`,
        help: 'TRUE or FALSE. Blank means TRUE.',
        example: 'TRUE',
      }
    );
  }
  return cols;
}

export const COL_TEMPLATE_VERSION: ColumnSpec = {
  key: 'template_version',
  kind: 'meta',
  required: true,
  label: 'Template version',
  help: 'Leave as 1.0. Files made from a different template version are rejected.',
  example: '1.0',
  maxLength: 10,
};

export const COL_EXTERNAL_ID: ColumnSpec = {
  key: 'external_id',
  kind: 'text',
  required: false,
  label: 'External ID',
  help: 'Your own stable identifier for this row (for example from a content plan). Stored as the Resource content ID. Uploading an ID that already exists is rejected, so the same item can never be created twice.',
  example: 'ART-2026-0142',
  maxLength: 100,
};

export const COL_TITLE: ColumnSpec = {
  key: 'title',
  kind: 'text',
  required: true,
  label: 'Title',
  help: 'The headline. Up to 180 characters.',
  example: 'How a mortgage offset account works',
  maxLength: 180,
};

export const COL_SLUG: ColumnSpec = {
  key: 'slug',
  kind: 'text',
  required: false,
  label: 'Slug',
  help: 'The web address ending: lowercase letters, numbers and single hyphens. Leave blank to generate one from the title. A slug that already exists is rejected; nothing is ever overwritten.',
  example: 'how-a-mortgage-offset-account-works',
  maxLength: 200,
};

export const COL_JURISDICTION: ColumnSpec = {
  key: 'jurisdiction',
  kind: 'enum',
  required: true,
  label: 'Jurisdiction',
  help: 'Which country the content applies to. Pick one of the allowed values (see Lookup_Values).',
  example: 'australia',
  enumValues: JURISDICTION_VALUES,
};

export const COL_DIFFICULTY: ColumnSpec = {
  key: 'difficulty',
  kind: 'enum',
  required: false,
  label: 'Difficulty',
  help: 'How advanced the reader needs to be. Optional.',
  example: 'beginner_intermediate',
  enumValues: DIFFICULTY_VALUES,
};

export const COL_COMPLIANCE: ColumnSpec = {
  key: 'compliance_classification',
  kind: 'enum',
  required: true,
  label: 'Compliance classification',
  help: 'green, amber or red. AMBER content needs compliance review before publication; RED content cannot be published under the current workflow. This sets the classification only; nothing is approved by uploading.',
  example: 'green',
  enumValues: COMPLIANCE_VALUES,
};

export const COL_NEXT_REVIEW: ColumnSpec = {
  key: 'next_review_at',
  kind: 'date',
  required: false,
  label: 'Next review date',
  help: 'When this content should next be reviewed. File format: year-month-day with hyphens, for example 2027-03-31.',
  example: '2027-03-31',
};

export const COL_EXPIRES: ColumnSpec = {
  key: 'expires_at',
  kind: 'date',
  required: false,
  label: 'Expiry date',
  help: 'When this content stops being valid. File format: year-month-day with hyphens.',
  example: '2027-09-30',
};

export const COL_EXCERPT: ColumnSpec = {
  key: 'excerpt',
  kind: 'long_text',
  required: true,
  label: 'Excerpt',
  help: 'A short summary shown in listings. Required, up to 300 characters.',
  example: 'An offset account can cut the interest you pay on a home loan without locking your savings away.',
  maxLength: 300,
};

export const COL_PRIMARY_CATEGORY: ColumnSpec = {
  key: 'primary_category',
  kind: 'reference',
  required: false,
  label: 'Primary category',
  help: 'The exact name or slug of an existing category (see Lookup_Values). Categories are never created by an upload. Needed before the item can go to review.',
  example: 'Managing Money',
};

export const COL_TAGS: ColumnSpec = {
  key: 'tags',
  kind: 'pipe_list',
  required: false,
  label: 'Tags',
  help: 'Existing tag names or slugs separated by a pipe character (|). Tags are never created by an upload.',
  example: 'mortgage|offset-account',
};

export const COL_PRIMARY_CTA: ColumnSpec = {
  key: 'primary_cta',
  kind: 'reference',
  required: false,
  label: 'Primary CTA',
  help: 'The exact name of an existing, active call to action. CTAs are never created by an upload.',
  example: '',
};

export const COL_SECONDARY_CTA: ColumnSpec = {
  key: 'secondary_cta',
  kind: 'reference',
  required: false,
  label: 'Secondary CTA',
  help: 'The exact name of an existing, active call to action. Must differ from the primary CTA.',
  example: '',
};

export const COL_SEO_TITLE: ColumnSpec = {
  key: 'seo_title',
  kind: 'text',
  required: false,
  label: 'SEO title',
  help: 'Optional. Left blank, the normal Resources fallback (the title) applies.',
  example: '',
  maxLength: 300,
};

export const COL_SEO_DESCRIPTION: ColumnSpec = {
  key: 'seo_description',
  kind: 'text',
  required: false,
  label: 'SEO description',
  help: 'Optional. Left blank, the normal Resources fallback (the excerpt) applies.',
  example: '',
  maxLength: 400,
};

export const COL_IS_INDEXABLE: ColumnSpec = {
  key: 'is_indexable',
  kind: 'boolean',
  required: false,
  label: 'Indexable by search engines',
  help: 'Ignored. Imported drafts are never indexable; the value here cannot override that. Leave as FALSE.',
  example: 'FALSE',
};

export const SOURCE_TYPE_LOOKUP = ['regulator', 'official_publication', 'news', 'fhip_internal', 'other'] as const;
