// Resources Bulk Upload -- the shared validation engine. Pure (no database, no
// clock: the caller injects `todayIso` and the batched reference data).
//
// Everything that is the same for Articles and Money Updates lives here: enums,
// strict dates, https-only source URLs, slug / external-id rules, category /
// tag / author / CTA resolution (exact match against EXISTING records only --
// nothing is ever created by an upload), duplicate detection inside the file,
// and conflict detection against existing content. The adapters add their own
// body mapping and type-specific rules through `AdapterHooks`.

import { isValidSlugFormat, slugify } from '@/lib/resources/editor/slug';
import { formatDateShort } from '@/lib/engines/date';
import {
  COMPLIANCE_VALUES,
  DIFFICULTY_VALUES,
  JURISDICTION_VALUES,
  SOURCE_COUNT,
  SOURCE_FIELD_SUFFIXES,
} from './common-schema';
import {
  IMPORT_LIMITS,
  type ColumnSpec,
  type ImportIssue,
  type ImportIssueCode,
  type ImportReferenceData,
  type ImportSchema,
  type NormalisedImportPayload,
  type NormalisedSource,
  type ParsedTable,
  type RawImportRow,
  type RefAuthor,
  type RefCategory,
  type RefCta,
  type RefTag,
  type RowDisplay,
  type ValidatedRow,
  type ValidationOutcome,
} from './types';

// ---------------------------------------------------------------------------
// Row issue collector
// ---------------------------------------------------------------------------
export class RowIssues {
  readonly errors: ImportIssue[] = [];
  readonly warnings: ImportIssue[] = [];
  constructor(readonly rowNumber: number) {}
  error(code: ImportIssueCode, field: string | null, message: string) {
    this.errors.push({ row: this.rowNumber, field, code, message, severity: 'error' });
  }
  warn(code: ImportIssueCode, field: string | null, message: string) {
    this.warnings.push({ row: this.rowNumber, field, code, message, severity: 'warning' });
  }
  get hasErrors() {
    return this.errors.length > 0;
  }
}

// ---------------------------------------------------------------------------
// Primitive parsers
// ---------------------------------------------------------------------------
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const FILE_DATE_HINT = 'Dates in the upload file must be written in the file format year-month-day with hyphens, for example 2026-10-06.';

/** Strict calendar date in the FILE format; returns the same string when real, null otherwise. */
export function parseFileDate(v: string): string | null {
  const m = DATE_RE.exec(v);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1900 || y > 2200 || mo < 1 || mo > 12 || d < 1) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? v : null;
}

/** Day-first display of a file date for use inside a message (India dd-mm-yyyy, otherwise dd/mm/yyyy). */
export function displayDate(iso: string, jurisdiction: string | null | undefined): string {
  return formatDateShort(iso, jurisdiction === 'india' ? 'INR' : 'AUD');
}

export function parseBooleanCell(v: string): boolean | null {
  const t = v.trim().toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(t)) return true;
  if (['false', 'no', 'n', '0'].includes(t)) return false;
  return null;
}

export function resolveEnum(v: string, allowed: readonly string[]): string | null {
  const t = v.trim().toLowerCase();
  return allowed.includes(t) ? t : null;
}

export function checkSourceUrl(raw: string): { ok: true } | { ok: false; code: 'INVALID_URL' | 'INSECURE_URL'; message: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, code: 'INVALID_URL', message: 'This is not a valid web address. Use a full link starting with https://.' };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, code: 'INSECURE_URL', message: `Only secure https:// links are accepted (this link uses "${url.protocol}").` };
  }
  if (!url.hostname) return { ok: false, code: 'INVALID_URL', message: 'This web address has no host name.' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Reference indexing (exact match, case-insensitive on trimmed text; never fuzzy)
// ---------------------------------------------------------------------------
const norm = (s: string) => s.trim().toLowerCase();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface IndexedRefs {
  categoriesBySlug: Map<string, RefCategory>;
  categoriesByName: Map<string, RefCategory[]>;
  tagsBySlug: Map<string, RefTag>;
  tagsByName: Map<string, RefTag[]>;
  authorsBySlug: Map<string, RefAuthor>;
  authorsById: Map<string, RefAuthor>;
  authorsByName: Map<string, RefAuthor[]>;
  ctasByName: Map<string, RefCta[]>;
  ctasById: Map<string, RefCta>;
  existingSlugs: ReadonlySet<string>;
  existingContentIds: ReadonlySet<string>;
  existingPostIds: ReadonlySet<string>;
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}

export function indexReferences(refs: ImportReferenceData): IndexedRefs {
  return {
    categoriesBySlug: new Map(refs.categories.map((c) => [norm(c.slug), c])),
    categoriesByName: groupBy(refs.categories, (c) => norm(c.name)),
    tagsBySlug: new Map(refs.tags.map((t) => [norm(t.slug), t])),
    tagsByName: groupBy(refs.tags, (t) => norm(t.name)),
    authorsBySlug: new Map(refs.authors.map((a) => [norm(a.slug), a])),
    authorsById: new Map(refs.authors.map((a) => [a.id.toLowerCase(), a])),
    authorsByName: groupBy(refs.authors, (a) => norm(a.display_name)),
    ctasByName: groupBy(refs.ctas, (c) => norm(c.name)),
    ctasById: new Map(refs.ctas.map((c) => [c.id.toLowerCase(), c])),
    existingSlugs: refs.existingSlugs,
    existingContentIds: refs.existingContentIds,
    existingPostIds: refs.existingPostIds,
  };
}

// ---------------------------------------------------------------------------
// Common field normalisation
// ---------------------------------------------------------------------------
export interface CommonFields {
  external_id: string | null;
  title: string;
  slug: string | null;
  slug_generated: boolean;
  jurisdiction: string;
  difficulty: string | null;
  compliance_classification: string;
  next_review_at: string | null;
  expires_at: string | null;
  excerpt: string;
  primary_category_id: string | null;
  primary_category_label: string | null;
  tag_ids: string[];
  tag_labels: string[];
  primary_cta_id: string | null;
  primary_cta_label: string | null;
  secondary_cta_id: string | null;
  secondary_cta_label: string | null;
  seo_title: string | null;
  seo_description: string | null;
  sources: NormalisedSource[];
}

function specOf(schema: ImportSchema, key: string): ColumnSpec {
  const s = schema.columns.find((c) => c.key === key);
  if (!s) throw new Error(`schema has no column ${key}`);
  return s;
}

function tooLong(issues: RowIssues, spec: ColumnSpec, value: string): boolean {
  const max = spec.maxLength ?? IMPORT_LIMITS.maxCellChars;
  if (value.length > max) {
    issues.error('FIELD_TOO_LONG', spec.key, `${spec.label} is ${value.length} characters; the limit is ${max}.`);
    return true;
  }
  return false;
}

/** Slug a row will carry (explicit or generated from the title); used to batch the existence lookup. */
export function effectiveSlug(raw: RawImportRow): string | null {
  const explicit = (raw.values.slug ?? '').trim();
  if (explicit) return explicit;
  const gen = slugify(raw.values.title ?? '');
  return gen || null;
}

export function collectLookupKeys(table: ParsedTable): { slugs: string[]; externalIds: string[]; urls: string[] } {
  const slugs = new Set<string>();
  const ids = new Set<string>();
  const urls = new Set<string>();
  for (const r of table.rows) {
    const s = effectiveSlug(r);
    if (s) slugs.add(s);
    const e = (r.values.external_id ?? '').trim();
    if (e) ids.add(e);
    for (let n = 1; n <= SOURCE_COUNT; n++) {
      const u = (r.values[`source_${n}_url`] ?? '').trim();
      if (u) urls.add(u);
    }
  }
  return { slugs: [...slugs], externalIds: [...ids], urls: [...urls] };
}

export function normaliseCommonFields(raw: RawImportRow, schema: ImportSchema, refs: IndexedRefs, issues: RowIssues, todayIso: string): CommonFields {
  const v = raw.values;
  const get = (k: string) => (v[k] ?? '').trim();

  // ---- length guard on every present column first (cheap, and keeps later regexes bounded) ----
  for (const c of schema.columns) {
    const val = get(c.key);
    if (val) tooLong(issues, c, val);
  }

  // ---- identity ----
  const external_id = get('external_id') || null;
  const title = get('title');
  if (!title) issues.error('MISSING_REQUIRED_VALUE', 'title', 'Title is required.');

  let slug: string | null = null;
  let slug_generated = false;
  const explicitSlug = get('slug');
  if (explicitSlug) {
    if (!isValidSlugFormat(explicitSlug)) {
      issues.error('INVALID_SLUG', 'slug', 'A slug may contain only lowercase letters, numbers and single hyphens (for example how-offset-accounts-work). It is never changed for you.');
    } else slug = explicitSlug;
  } else if (title) {
    const gen = slugify(title);
    if (gen && isValidSlugFormat(gen)) {
      slug = gen;
      slug_generated = true;
      issues.warn('SLUG_GENERATED', 'slug', `No slug was given, so "${gen}" will be generated from the title.`);
    } else issues.error('INVALID_SLUG', 'slug', 'A slug could not be generated from this title. Provide one.');
  }

  // ---- controlled values ----
  const jurisdictionRaw = get('jurisdiction');
  let jurisdiction = '';
  if (!jurisdictionRaw) issues.error('MISSING_REQUIRED_VALUE', 'jurisdiction', 'Jurisdiction is required.');
  else {
    const j = resolveEnum(jurisdictionRaw, JURISDICTION_VALUES);
    if (!j) issues.error('INVALID_ENUM', 'jurisdiction', `Jurisdiction must be one of: ${JURISDICTION_VALUES.join(', ')}.`);
    else jurisdiction = j;
  }

  const difficultyRaw = get('difficulty');
  let difficulty: string | null = null;
  if (difficultyRaw) {
    const d = resolveEnum(difficultyRaw, DIFFICULTY_VALUES);
    if (!d) issues.error('INVALID_ENUM', 'difficulty', `Difficulty must be one of: ${DIFFICULTY_VALUES.join(', ')}.`);
    else difficulty = d;
  }

  const complianceRaw = get('compliance_classification');
  let compliance = '';
  if (!complianceRaw) issues.error('MISSING_REQUIRED_VALUE', 'compliance_classification', 'Compliance classification is required (green, amber or red).');
  else {
    const c = resolveEnum(complianceRaw, COMPLIANCE_VALUES);
    if (!c) issues.error('INVALID_ENUM', 'compliance_classification', `Compliance classification must be one of: ${COMPLIANCE_VALUES.join(', ')}.`);
    else compliance = c;
  }

  // ---- dates (review / expiry; event date is Money Update specific) ----
  const readDate = (key: string): string | null => {
    const raw = get(key);
    if (!raw) return null;
    const d = parseFileDate(raw);
    if (!d) {
      issues.error('INVALID_DATE', key, `${specOf(schema, key).label} is not a valid date. ${FILE_DATE_HINT}`);
      return null;
    }
    return d;
  };
  const next_review_at = readDate('next_review_at');
  const expires_at = readDate('expires_at');
  for (const [key, d] of [['next_review_at', next_review_at], ['expires_at', expires_at]] as const) {
    if (d && d < todayIso) issues.warn('REVIEW_DATE_IN_PAST', key, `${specOf(schema, key).label} (${displayDate(d, jurisdiction)}) is already in the past.`);
  }

  // ---- excerpt ----
  const excerpt = get('excerpt');
  if (!excerpt) issues.error('MISSING_REQUIRED_VALUE', 'excerpt', 'Excerpt is required.');

  // ---- category ----
  let primary_category_id: string | null = null;
  let primary_category_label: string | null = null;
  const catRaw = get('primary_category');
  if (!catRaw) {
    issues.warn('PRIMARY_CATEGORY_MISSING', 'primary_category', 'No primary category. The draft can be saved, but a category must be set before it can go to review.');
  } else {
    const bySlug = refs.categoriesBySlug.get(norm(catRaw));
    const byName = refs.categoriesByName.get(norm(catRaw)) ?? [];
    const hit = bySlug ?? (byName.length === 1 ? byName[0] : null);
    if (hit) {
      primary_category_id = hit.id;
      primary_category_label = hit.name;
    } else if (byName.length > 1) {
      issues.error('UNKNOWN_PRIMARY_CATEGORY', 'primary_category', `More than one category is named "${catRaw}". Use the category slug instead.`);
    } else {
      issues.error('UNKNOWN_PRIMARY_CATEGORY', 'primary_category', `"${catRaw}" is not an existing category. Use the exact category name or slug; categories are never created by an upload.`);
    }
  }

  // ---- tags ----
  const tag_ids: string[] = [];
  const tag_labels: string[] = [];
  const tagRaw = get('tags');
  if (tagRaw) {
    const seen = new Set<string>();
    for (const part of tagRaw.split('|')) {
      const t = part.trim();
      if (!t) continue;
      const bySlug = refs.tagsBySlug.get(norm(t));
      const byName = refs.tagsByName.get(norm(t)) ?? [];
      const hit = bySlug ?? (byName.length === 1 ? byName[0] : null);
      if (!hit) {
        issues.error('UNKNOWN_TAG', 'tags', byName.length > 1 ? `More than one tag is named "${t}". Use the tag slug instead.` : `"${t}" is not an existing tag. Tags are never created by an upload.`);
        continue;
      }
      if (seen.has(hit.id)) continue;
      seen.add(hit.id);
      tag_ids.push(hit.id);
      tag_labels.push(hit.name);
    }
  }

  // ---- CTAs ----
  const resolveCta = (key: 'primary_cta' | 'secondary_cta'): { id: string | null; label: string | null } => {
    const raw = get(key);
    if (!raw) return { id: null, label: null };
    const byId = UUID_RE.test(raw) ? refs.ctasById.get(raw.toLowerCase()) : undefined;
    const byName = refs.ctasByName.get(norm(raw)) ?? [];
    const hit = byId ?? (byName.length === 1 ? byName[0] : null);
    if (!hit) {
      issues.error('UNKNOWN_CTA', key, byName.length > 1 ? `More than one active CTA is named "${raw}".` : `"${raw}" is not an existing, active CTA. CTAs are never created by an upload.`);
      return { id: null, label: null };
    }
    return { id: hit.id, label: hit.name };
  };
  const p = resolveCta('primary_cta');
  const s = resolveCta('secondary_cta');
  if (p.id && s.id && p.id === s.id) issues.error('SAME_PRIMARY_SECONDARY_CTA', 'secondary_cta', 'Primary and Secondary CTA cannot be the same. Choose a different Secondary CTA or leave it blank.');

  // ---- SEO / indexable ----
  const seo_title = get('seo_title') || null;
  const seo_description = get('seo_description') || null;
  const idxRaw = get('is_indexable');
  if (idxRaw) {
    const b = parseBooleanCell(idxRaw);
    if (b === null) issues.error('INVALID_BOOLEAN', 'is_indexable', 'Use TRUE or FALSE.');
    else if (b === true) issues.warn('IS_INDEXABLE_IGNORED', 'is_indexable', 'Imported drafts are never indexable. This value is ignored and the draft is saved as not indexable.');
  }

  // ---- sources ----
  const sources: NormalisedSource[] = [];
  const seenSource = new Set<string>();
  for (let n = 1; n <= SOURCE_COUNT; n++) {
    const f = (suffix: (typeof SOURCE_FIELD_SUFFIXES)[number]) => get(`source_${n}_${suffix}`);
    const present = SOURCE_FIELD_SUFFIXES.some((sfx) => sfx !== 'is_public' && f(sfx) !== '');
    if (!present) continue;
    const name = f('name');
    if (!name) {
      issues.error('MISSING_REQUIRED_VALUE', `source_${n}_name`, `Source ${n} has details but no name.`);
      continue;
    }
    const url = f('url');
    if (!url) issues.warn('SOURCE_URL_MISSING', `source_${n}_url`, `Source ${n} has no link. It will be saved as a name-only source.`);
    else {
      const chk = checkSourceUrl(url);
      if (!chk.ok) {
        issues.error(chk.code, `source_${n}_url`, chk.message);
        continue;
      }
    }
    const pub = f('publication_date');
    let publication_date: string | null = null;
    if (pub) {
      publication_date = parseFileDate(pub);
      if (!publication_date) {
        issues.error('INVALID_DATE', `source_${n}_publication_date`, `Source ${n} publication date is not a valid date. ${FILE_DATE_HINT}`);
        continue;
      }
    }
    const pubFlag = f('is_public');
    let is_public = true;
    if (pubFlag) {
      const b = parseBooleanCell(pubFlag);
      if (b === null) {
        issues.error('INVALID_BOOLEAN', `source_${n}_is_public`, 'Use TRUE or FALSE.');
        continue;
      }
      is_public = b;
    }
    const src: NormalisedSource = { source_name: name, document_title: f('document_title') || null, url: url || null, source_type: f('type') || null, publication_date, is_public };
    const key = JSON.stringify([src.source_name, src.document_title, src.url, src.source_type, src.publication_date, src.is_public]);
    if (seenSource.has(key)) continue;
    seenSource.add(key);
    sources.push(src);
  }

  return {
    external_id,
    title,
    slug,
    slug_generated,
    jurisdiction,
    difficulty,
    compliance_classification: compliance,
    next_review_at,
    expires_at,
    excerpt,
    primary_category_id,
    primary_category_label,
    tag_ids,
    tag_labels,
    primary_cta_id: p.id,
    primary_cta_label: p.label,
    secondary_cta_id: s.id,
    secondary_cta_label: s.label,
    seo_title,
    seo_description,
    sources,
  };
}

// ---------------------------------------------------------------------------
// Adapter contract + the whole-file validation driver
// ---------------------------------------------------------------------------
export interface AdapterBuild {
  freshness_type: string;
  event_date: string | null;
  affected_audience: string | null;
  author_id: string | null;
  author_label: string | null;
  content_blocks: unknown[];
}

export interface AdapterHooks {
  schema: ImportSchema;
  /** Type-specific validation and body mapping. Pushes issues; returns the type-specific payload parts. */
  build(raw: RawImportRow, common: CommonFields, refs: IndexedRefs, issues: RowIssues, todayIso: string): AdapterBuild;
}

function toPayload(common: CommonFields, extra: AdapterBuild): NormalisedImportPayload {
  return {
    external_id: common.external_id,
    title: common.title,
    slug: common.slug,
    slug_generated: common.slug_generated,
    jurisdiction: common.jurisdiction,
    difficulty: common.difficulty,
    compliance_classification: common.compliance_classification,
    freshness_type: extra.freshness_type,
    event_date: extra.event_date,
    affected_audience: extra.affected_audience,
    next_review_at: common.next_review_at,
    expires_at: common.expires_at,
    excerpt: common.excerpt,
    content_blocks: extra.content_blocks,
    primary_category_id: common.primary_category_id,
    tag_ids: common.tag_ids,
    author_id: extra.author_id,
    primary_cta_id: common.primary_cta_id,
    secondary_cta_id: common.secondary_cta_id,
    seo_title: common.seo_title,
    seo_description: common.seo_description,
    sources: common.sources,
  };
}

function toDisplay(common: CommonFields, extra: AdapterBuild): RowDisplay {
  return {
    title: common.title,
    slug: common.slug,
    external_id: common.external_id,
    jurisdiction: common.jurisdiction || null,
    compliance_classification: common.compliance_classification || null,
    primary_category: common.primary_category_label,
    author: extra.author_label,
    tags: common.tag_labels,
    primary_cta: common.primary_cta_label,
    secondary_cta: common.secondary_cta_label,
    event_date: extra.event_date,
    next_review_at: common.next_review_at,
    expires_at: common.expires_at,
    source_count: common.sources.length,
    block_count: extra.content_blocks.length,
  };
}

export function validateImportTable(table: ParsedTable, cellIssues: ImportIssue[], hooks: AdapterHooks, refsIn: ImportReferenceData, todayIso: string): ValidationOutcome {
  const refs = indexReferences(refsIn);
  const rows: ValidatedRow[] = [];
  const cellByRow = new Map<number, ImportIssue[]>();
  for (const ci of cellIssues) {
    if (ci.row === null) continue;
    const arr = cellByRow.get(ci.row);
    if (arr) arr.push(ci);
    else cellByRow.set(ci.row, [ci]);
  }

  const slugFirstRow = new Map<string, number>();
  const extFirstRow = new Map<string, number>();

  for (const raw of table.rows) {
    const issues = new RowIssues(raw.rowNumber);
    for (const ci of cellByRow.get(raw.rowNumber) ?? []) issues.errors.push(ci);
    const common = normaliseCommonFields(raw, hooks.schema, refs, issues, todayIso);
    const extra = hooks.build(raw, common, refs, issues, todayIso);

    // ---- duplicates inside the file ----
    if (common.slug) {
      const first = slugFirstRow.get(common.slug);
      if (first !== undefined) issues.error('DUPLICATE_SLUG_IN_FILE', 'slug', `The slug "${common.slug}" is already used by row ${first} of this file.`);
      else slugFirstRow.set(common.slug, raw.rowNumber);
    }
    if (common.external_id) {
      const first = extFirstRow.get(common.external_id);
      if (first !== undefined) issues.error('DUPLICATE_EXTERNAL_ID_IN_FILE', 'external_id', `The external ID "${common.external_id}" is already used by row ${first} of this file.`);
      else extFirstRow.set(common.external_id, raw.rowNumber);
    }

    // ---- conflicts with EXISTING content (v1 is create-only: nothing is ever overwritten) ----
    if (common.slug && refs.existingSlugs.has(common.slug)) {
      issues.error('EXISTING_CONTENT_CONFLICT', 'slug', `A Resource with the slug "${common.slug}" already exists. Uploads only create new items and never overwrite existing ones.${common.slug_generated ? ' Provide a different slug.' : ''}`);
    }
    if (common.external_id && (refs.existingContentIds.has(common.external_id) || refs.existingPostIds.has(common.external_id.toLowerCase()))) {
      issues.error('EXISTING_CONTENT_CONFLICT', 'external_id', `A Resource with the external ID "${common.external_id}" already exists. Uploads only create new items and never overwrite existing ones.`);
    }

    rows.push({
      rowNumber: raw.rowNumber,
      payload: toPayload(common, extra),
      display: toDisplay(common, extra),
      errors: issues.errors,
      warnings: issues.warnings,
    });
  }
  return { fileIssues: [], rows };
}

export function summariseOutcome(outcome: ValidationOutcome): { rowCount: number; validCount: number; warningCount: number; errorCount: number } {
  let valid = 0;
  let warn = 0;
  let err = 0;
  for (const r of outcome.rows) {
    if (r.errors.length > 0) err++;
    else valid++;
    if (r.warnings.length > 0) warn++;
  }
  return { rowCount: outcome.rows.length, validCount: valid, warningCount: warn, errorCount: err };
}

/** Everything a person sees about one row, flattened for the downloadable results file. */
export function flattenIssues(outcome: ValidationOutcome): ImportIssue[] {
  const all: ImportIssue[] = [...outcome.fileIssues];
  for (const r of outcome.rows) all.push(...r.errors, ...r.warnings);
  return all;
}
