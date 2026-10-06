// Resources Bulk Upload (Articles + Money Updates) -- shared framework types.
//
// ONE engine, two canonical adapters. Everything that differs between content
// types (columns, required fields, mapping to content_blocks) lives in the
// adapter folders; everything else (file security, parsing, validation
// primitives, staging, preview, atomic apply) is shared.
//
// The whole import library is PURE except `staging.ts` / `apply.ts` (database).

export const IMPORT_CONTENT_TYPES = ['article', 'money_update'] as const;
export type ImportContentType = (typeof IMPORT_CONTENT_TYPES)[number];

export function isImportContentType(v: unknown): v is ImportContentType {
  return typeof v === 'string' && (IMPORT_CONTENT_TYPES as readonly string[]).includes(v);
}

export const CONTENT_TYPE_LABELS: Record<ImportContentType, { singular: string; plural: string }> = {
  article: { singular: 'Article', plural: 'Articles' },
  money_update: { singular: 'Money Update', plural: 'Money Updates' },
};

/** The only template version v1 understands. Anything else is TEMPLATE_VERSION_UNSUPPORTED. */
export const TEMPLATE_VERSION = '1.0';

export const IMPORT_LIMITS = Object.freeze({
  maxFileBytes: 10 * 1024 * 1024,
  /** Per-file record cap. 250 chosen 07-10-2026 (PO); 500 only after the production synthetic proof shows worst-case db_ms under about 6 s (see the runbook). */
  maxRows: 250,
  /** A single cell may not exceed this many characters (a body field is the largest legitimate value). */
  maxCellChars: 50_000,
  /** The raw workbook may not hold more sheets than the template defines plus a little slack. */
  maxSheets: 8,
  maxZipEntries: 100,
  maxZipUncompressedBytes: 50 * 1024 * 1024,
  maxZipEntryBytes: 25 * 1024 * 1024,
});

/** Unapplied staged runs are purged after this many days; applied runs have their payload cleared immediately. */
export const STAGING_RETENTION_DAYS = 7;

// ---------------------------------------------------------------------------
// Error codes (PO spec section F), plus a few additive codes this build needs.
// ---------------------------------------------------------------------------
export const IMPORT_ERROR_CODES = [
  // file level
  'INVALID_FILE_TYPE',
  'FILE_TOO_LARGE',
  'EMPTY_FILE',
  'TOO_MANY_ROWS',
  'UPLOAD_SHEET_MISSING',
  'TEMPLATE_VERSION_UNSUPPORTED',
  'MISSING_REQUIRED_COLUMN',
  'DUPLICATE_COLUMN',
  'FORMULA_NOT_ALLOWED',
  'FILE_ALREADY_APPLIED',
  'FILE_PARSE_ERROR',
  'UNKNOWN_COLUMN',
  'FORBIDDEN_COLUMN',
  // row level
  'MISSING_REQUIRED_VALUE',
  'INVALID_ENUM',
  'INVALID_DATE',
  'INVALID_URL',
  'INSECURE_URL',
  'INVALID_BOOLEAN',
  'INVALID_SLUG',
  'INVALID_CELL_VALUE',
  'FIELD_TOO_LONG',
  'DUPLICATE_SLUG_IN_FILE',
  'DUPLICATE_EXTERNAL_ID_IN_FILE',
  'EXISTING_CONTENT_CONFLICT',
  'UNKNOWN_PRIMARY_CATEGORY',
  'UNKNOWN_TAG',
  'UNKNOWN_CTA',
  'UNKNOWN_AUTHOR',
  'AMBIGUOUS_AUTHOR',
  'SAME_PRIMARY_SECONDARY_CTA',
  // Article
  'UNSUPPORTED_ARTICLE_MARKUP',
  'ARTICLE_BODY_EMPTY',
  // Money Update
  'UNSUPPORTED_MARKUP',
  'FUTURE_EVENT_DATE',
  'MISSING_REVIEW_OR_EXPIRY',
  'SOURCE_REQUIRED',
  // apply
  'STALE_PREVIEW',
  'IMPORT_NOT_READY',
  'APPLY_FAILED',
] as const;
export type ImportErrorCode = (typeof IMPORT_ERROR_CODES)[number];

export const IMPORT_WARNING_CODES = [
  'PRIMARY_CATEGORY_MISSING',
  'AUTHOR_MISSING',
  'IS_INDEXABLE_IGNORED',
  'SOURCE_URL_MISSING',
  'REVIEW_DATE_IN_PAST',
  'SLUG_GENERATED',
  // File-level disclosures (the shared ingest convention: nothing the operator did not choose is silently ignored).
  'SHEET_NOTE',
  'HIDDEN_ROWS_SKIPPED',
] as const;
export type ImportWarningCode = (typeof IMPORT_WARNING_CODES)[number];

export type ImportIssueCode = ImportErrorCode | ImportWarningCode;
export type ImportSeverity = 'error' | 'warning';

export interface ImportIssue {
  /** Spreadsheet row number (the header is row 1); null for a file-level issue. */
  row: number | null;
  field: string | null;
  code: ImportIssueCode;
  message: string;
  severity: ImportSeverity;
}

// ---------------------------------------------------------------------------
// Canonical schema definition. ONE definition drives the template headers,
// the parser, required fields, enums, preview labels, docs and tests.
// ---------------------------------------------------------------------------
export type FieldKind =
  | 'meta' // template_version
  | 'text'
  | 'long_text' // body field (restricted markdown or plain)
  | 'enum'
  | 'date'
  | 'boolean'
  | 'url'
  | 'pipe_list'
  | 'line_list'
  | 'reference'; // category / author / CTA, resolved against existing records

export interface ColumnSpec {
  key: string;
  kind: FieldKind;
  required: boolean;
  /** Plain-language label for the Instructions sheet and the preview. */
  label: string;
  /** One sentence of guidance for the Instructions sheet. */
  help: string;
  /** Realistic example value for the Example sheet. */
  example: string;
  maxLength?: number;
  enumValues?: readonly string[];
}

export interface ImportSchema {
  contentType: ImportContentType;
  templateVersion: string;
  /** The only importable sheet of the XLSX template. */
  uploadSheetName: string;
  exampleSheetName: string;
  /** e.g. FHIP_Article_Upload_Template_v1 -> .xlsx / .csv are appended. */
  templateFileBase: string;
  columns: readonly ColumnSpec[];
}

/** One raw spreadsheet row: column key -> trimmed string value. */
export interface RawImportRow {
  rowNumber: number;
  values: Record<string, string>;
}

export interface ParsedTable {
  /** Canonical column keys actually present in the file, in file order. */
  headers: string[];
  rows: RawImportRow[];
  sheetName: string | null;
  kind: 'csv' | 'xlsx';
}

// ---------------------------------------------------------------------------
// Reference data resolved once per run (batched; never per row).
// ---------------------------------------------------------------------------
export interface RefCategory {
  id: string;
  name: string;
  slug: string;
}
export interface RefTag {
  id: string;
  name: string;
  slug: string;
}
export interface RefAuthor {
  id: string;
  display_name: string;
  slug: string;
}
export interface RefCta {
  id: string;
  name: string;
  label: string;
}
export interface RefSource {
  id: string;
  source_name: string;
  document_title: string | null;
  url: string | null;
}

export interface ImportReferenceData {
  categories: RefCategory[];
  tags: RefTag[];
  authors: RefAuthor[];
  ctas: RefCta[];
  /** Existing sources whose url is one of the file's urls (for exact reuse display only; apply re-resolves in SQL). */
  sources: RefSource[];
  /** slug -> true for every slug in the file that already exists in resource_posts. */
  existingSlugs: ReadonlySet<string>;
  /** content_id values (external ids) in the file that already exist. */
  existingContentIds: ReadonlySet<string>;
  /** uuid-shaped external ids that equal an existing post id. */
  existingPostIds: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Normalised row (what is staged and what the apply RPC reads).
// snake_case on purpose: the SQL side reads these keys by name.
// ---------------------------------------------------------------------------
export interface NormalisedSource {
  source_name: string;
  document_title: string | null;
  url: string | null;
  source_type: string | null;
  publication_date: string | null;
  is_public: boolean;
}

export interface NormalisedImportPayload {
  external_id: string | null;
  title: string;
  slug: string | null;
  slug_generated: boolean;
  jurisdiction: string;
  difficulty: string | null;
  compliance_classification: string;
  freshness_type: string;
  event_date: string | null;
  affected_audience: string | null;
  next_review_at: string | null;
  expires_at: string | null;
  excerpt: string;
  content_blocks: unknown[];
  primary_category_id: string | null;
  tag_ids: string[];
  author_id: string | null;
  primary_cta_id: string | null;
  secondary_cta_id: string | null;
  seo_title: string | null;
  seo_description: string | null;
  sources: NormalisedSource[];
}

/** Small, display-only projection kept on the staged row so the preview table never loads full bodies. */
export interface RowDisplay {
  title: string;
  slug: string | null;
  external_id: string | null;
  jurisdiction: string | null;
  compliance_classification: string | null;
  primary_category: string | null;
  author: string | null;
  tags: string[];
  primary_cta: string | null;
  secondary_cta: string | null;
  event_date: string | null;
  next_review_at: string | null;
  expires_at: string | null;
  source_count: number;
  block_count: number;
}

export interface ValidatedRow {
  rowNumber: number;
  payload: NormalisedImportPayload | null;
  display: RowDisplay;
  errors: ImportIssue[];
  warnings: ImportIssue[];
}

export interface ValidationOutcome {
  fileIssues: ImportIssue[];
  rows: ValidatedRow[];
}

export const RUN_STATUSES = ['ready', 'has_errors', 'applied', 'failed', 'stale', 'rejected', 'expired'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
