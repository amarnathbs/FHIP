// Market Index Data: turning a failed submit into per-field errors, as PURE functions (no React), so
// the mapping is unit-tested (tests/unit/benchmarkDataFormErrors.test.ts).
//
// A rejected form must show WHICH fields are wrong: a red outline and a red sentence under each field,
// one summary at the top of the form ("These fields need fixing:") whose entries are links that focus
// the field, and the first invalid field scrolled into view and focused. The summary never drops an
// error: a server path with no field on this form is listed under its own readable name.

/** How a typed date is described in a message (day first; the same words as the client validators). */
export const DATE_WORDS = 'DD-MM-YYYY, like 01-10-2026';

export type FieldErrors = Record<string, string>;

/** API field path (snake_case, dotted) -> form field key, optionally with a replacement sentence. */
export type FieldMap = Readonly<Record<string, string | { key: string; message?: string }>>;

export interface UnmappedField {
  path: string;
  message: string;
}

export interface MappedFailure {
  errors: FieldErrors;
  unmapped: UnmappedField[];
}

export interface SummaryItem {
  /** The form field key to focus, or null when the error is not about a field on this form. */
  key: string | null;
  label: string;
  message: string;
}

const MAX_MESSAGE = 300;

/** `fields` from a 422 body ({ path: message }), or null. Only plain short strings survive. */
export function serverFields(body: unknown): Record<string, string> | null {
  if (!body || typeof body !== 'object') return null;
  const raw = (body as Record<string, unknown>).fields;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string') continue;
    const msg = v.trim();
    if (!msg || msg.length > MAX_MESSAGE || /violates|sqlstate|relation "|column "|pgrst|<!doctype/i.test(msg)) continue;
    out[k] = msg;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** 'valid_from' -> 'Valid from'. Used only for paths this form has no field for. */
export function humanizePath(path: string): string {
  const last = path.split('.').filter(Boolean).pop() ?? path;
  const words = last.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'This entry';
}

/**
 * Map server field paths onto this form's field keys. A date field's message always names the
 * day-first format in words (the server cannot know the screen's date rule). Several paths may land
 * on one field; the first message wins. A path with no mapping is returned in `unmapped`, never lost.
 */
export function mapServerFields(fields: Record<string, string>, map: FieldMap, dateKeys: ReadonlySet<string> = new Set()): MappedFailure {
  const errors: FieldErrors = {};
  const unmapped: UnmappedField[] = [];
  for (const [path, serverMessage] of Object.entries(fields)) {
    const target = map[path];
    if (target === undefined) {
      unmapped.push({ path, message: serverMessage });
      continue;
    }
    const key = typeof target === 'string' ? target : target.key;
    let message = typeof target === 'string' ? serverMessage : target.message ?? serverMessage;
    if (dateKeys.has(key) && (typeof target === 'string' || !target.message)) message = `Use a valid date (${DATE_WORDS}).`;
    if (!(key in errors)) errors[key] = message;
  }
  return { errors, unmapped };
}

/** One entry per invalid field (in the form's own order), then one per unmapped server path. */
export function buildSummary(errors: FieldErrors, unmapped: readonly UnmappedField[], labels: Readonly<Record<string, string>>, order: readonly string[]): SummaryItem[] {
  const items: SummaryItem[] = [];
  const seen = new Set<string>();
  for (const key of order) {
    if (errors[key]) {
      items.push({ key, label: labels[key] ?? humanizePath(key), message: errors[key] });
      seen.add(key);
    }
  }
  // Errors for keys not in `order` are still listed (never dropped).
  for (const key of Object.keys(errors)) {
    if (!seen.has(key) && errors[key]) items.push({ key, label: labels[key] ?? humanizePath(key), message: errors[key] });
  }
  for (const u of unmapped) items.push({ key: null, label: humanizePath(u.path), message: u.message });
  return items;
}

/** The field to scroll to and focus first: the earliest invalid key in the form's order. */
export function firstInvalidKey(errors: FieldErrors, order: readonly string[]): string | null {
  for (const key of order) if (errors[key]) return key;
  const rest = Object.keys(errors).find((k) => errors[k]);
  return rest ?? null;
}

// ---------------------------------------------------------------- per-form maps ---

export const ENTITLEMENT_FIELD_ORDER = ['benchmarkKey', 'kind', 'rights', 'validFrom', 'validTo', 'dataFrom', 'dataTo', 'postExpiryStorage', 'evidenceReference', 'evidenceUrl', 'evidenceDocumentDate', 'evidenceRetrievedAt', 'attributionText', 'notes'] as const;
export const ENTITLEMENT_FIELD_LABELS: Readonly<Record<string, string>> = {
  benchmarkKey: 'Benchmark',
  kind: 'Kind of permission',
  rights: 'Rights granted',
  validFrom: 'Valid from',
  validTo: 'Valid to',
  dataFrom: 'First data date covered',
  dataTo: 'Last data date covered',
  postExpiryStorage: 'Stored data after expiry',
  evidenceReference: 'Evidence reference',
  evidenceUrl: 'Evidence URL',
  evidenceDocumentDate: 'Evidence document date',
  evidenceRetrievedAt: 'Evidence retrieved on',
  attributionText: 'Attribution wording',
  notes: 'Notes',
};
const NO_VARIANT_MESSAGE = 'This benchmark has no declared return type or currency in the catalogue. Complete the catalogue entry first.';
export const ENTITLEMENT_FIELD_MAP: FieldMap = {
  benchmark_id: 'benchmarkKey',
  return_variant: { key: 'benchmarkKey', message: NO_VARIANT_MESSAGE },
  currency_code: { key: 'benchmarkKey', message: NO_VARIANT_MESSAGE },
  entitlement_kind: 'kind',
  rights: 'rights',
  allow_manual_ingest: 'rights',
  allow_automation: 'rights',
  allow_storage: 'rights',
  allow_calculation: 'rights',
  allow_customer_display: 'rights',
  allow_report_export: 'rights',
  valid_from: 'validFrom',
  valid_to: 'validTo',
  data_from: 'dataFrom',
  data_to: 'dataTo',
  post_expiry_storage: 'postExpiryStorage',
  evidence_reference: 'evidenceReference',
  evidence_url: 'evidenceUrl',
  evidence_document_date: 'evidenceDocumentDate',
  evidence_retrieved_at: 'evidenceRetrievedAt',
  attribution_text: 'attributionText',
  notes: 'notes',
};
export const ENTITLEMENT_DATE_KEYS: ReadonlySet<string> = new Set(['validFrom', 'validTo', 'dataFrom', 'dataTo', 'evidenceDocumentDate', 'evidenceRetrievedAt']);

export const CATALOGUE_FIELD_ORDER = ['benchmarkKey', 'officialName', 'label', 'ownerName', 'officialIdentifier', 'assetClass', 'countryCode', 'currencyCode', 'returnType', 'returnVariant', 'baseDate', 'baseValue', 'launchDate', 'historyStartDate', 'historyClass', 'backtestedThrough', 'calendarCode', 'methodologyUrl', 'sourceUrl', 'evidenceRef', 'evidenceRetrievedAt'] as const;
export const CATALOGUE_FIELD_LABELS: Readonly<Record<string, string>> = {
  benchmarkKey: 'Key',
  officialName: 'Official name',
  label: 'Display label',
  ownerName: 'Owner',
  officialIdentifier: 'Official identifier',
  assetClass: 'Asset class',
  countryCode: 'Country',
  currencyCode: 'Currency',
  returnType: 'Return type',
  returnVariant: 'Exact variant',
  baseDate: 'Base date',
  baseValue: 'Base value',
  launchDate: 'Launch date',
  historyStartDate: 'History start date',
  historyClass: 'History type',
  backtestedThrough: 'Backtested through',
  calendarCode: 'Trading calendar',
  methodologyUrl: 'Methodology URL',
  sourceUrl: 'Source URL',
  evidenceRef: 'Evidence reference',
  evidenceRetrievedAt: 'Evidence retrieved on',
};
export const CATALOGUE_FIELD_MAP: FieldMap = {
  benchmark_key: 'benchmarkKey',
  official_name: 'officialName',
  benchmark_label: 'label',
  owner_name: 'ownerName',
  official_identifier: 'officialIdentifier',
  asset_class: 'assetClass',
  country_code: 'countryCode',
  currency_code: 'currencyCode',
  return_type: 'returnType',
  return_variant: 'returnVariant',
  base_date: 'baseDate',
  base_value: 'baseValue',
  launch_date: 'launchDate',
  history_start_date: 'historyStartDate',
  history_class: 'historyClass',
  backtested_through: 'backtestedThrough',
  calendar_code: 'calendarCode',
  methodology_url: 'methodologyUrl',
  source_url: 'sourceUrl',
  evidence_ref: 'evidenceRef',
  evidence_retrieved_at: 'evidenceRetrievedAt',
};
export const CATALOGUE_DATE_KEYS: ReadonlySet<string> = new Set(['baseDate', 'launchDate', 'historyStartDate', 'backtestedThrough', 'evidenceRetrievedAt']);

export const MAPPING_FIELD_ORDER = ['instrumentId', 'benchmarkKey', 'proposedBenchmarkName', 'relationshipType', 'effectiveFrom', 'effectiveTo', 'evidenceSource', 'evidenceUrl', 'evidenceTitle', 'evidenceDocumentDate', 'evidenceRetrievedAt', 'evidenceExcerpt', 'resolutionMethod', 'confidence', 'ambiguityReason'] as const;
export const MAPPING_FIELD_LABELS: Readonly<Record<string, string>> = {
  instrumentId: 'Instrument id',
  benchmarkKey: 'Benchmark in the catalogue',
  proposedBenchmarkName: 'Benchmark name as the scheme document states it',
  relationshipType: 'Relationship',
  effectiveFrom: 'Effective from',
  effectiveTo: 'Effective to',
  evidenceSource: 'Type of document',
  evidenceUrl: 'Document web address',
  evidenceTitle: 'Document title',
  evidenceDocumentDate: 'Document date',
  evidenceRetrievedAt: 'Retrieved on',
  evidenceExcerpt: 'Excerpt',
  resolutionMethod: 'How the benchmark was identified',
  confidence: 'Confidence',
  ambiguityReason: 'Anything ambiguous',
};
export const MAPPING_FIELD_MAP: FieldMap = {
  instrument_id: 'instrumentId',
  benchmark_id: 'benchmarkKey',
  proposed_benchmark_name: 'proposedBenchmarkName',
  relationship_type: 'relationshipType',
  effective_from: 'effectiveFrom',
  effective_to: 'effectiveTo',
  evidence_source: 'evidenceSource',
  evidence_url: 'evidenceUrl',
  evidence_title: 'evidenceTitle',
  evidence_document_date: 'evidenceDocumentDate',
  evidence_retrieved_at: 'evidenceRetrievedAt',
  evidence_excerpt: 'evidenceExcerpt',
  resolution_method: 'resolutionMethod',
  confidence: 'confidence',
  ambiguity_reason: 'ambiguityReason',
};
export const MAPPING_DATE_KEYS: ReadonlySet<string> = new Set(['effectiveFrom', 'effectiveTo', 'evidenceDocumentDate', 'evidenceRetrievedAt']);

/** The single-note forms: catalogue verify, entitlement approve and revoke, mapping review. */
export const NOTE_FIELD_ORDER = ['note'] as const;
export const NOTE_FIELD_LABELS: Readonly<Record<string, string>> = { note: 'Note' };
export const NOTE_FIELD_MAP: FieldMap = { note: 'note', reason: { key: 'note' }, selfApprovalAck: 'selfApprovalAck', decision: 'decision' };

export const INGESTION_FIELD_ORDER = ['mode', 'adapterId', 'sourceKey', 'automationEnabled', 'publicationLagDays', 'reason'] as const;
export const INGESTION_FIELD_LABELS: Readonly<Record<string, string>> = {
  mode: 'Mode',
  adapterId: 'Adapter',
  sourceKey: 'Source',
  automationEnabled: 'Automation',
  publicationLagDays: 'Publication lag in days',
  reason: 'Reason',
};
export const INGESTION_FIELD_MAP: FieldMap = {
  mode: 'mode',
  adapterId: 'adapterId',
  sourceKey: 'sourceKey',
  automationEnabled: 'automationEnabled',
  publicationLagDays: 'publicationLagDays',
  reason: 'reason',
};

export const UPLOAD_FIELD_ORDER = ['benchmarkKey', 'mode', 'returnVariant', 'currencyCode', 'historyClass', 'dateFormat', 'numberLocale', 'sheetName', 'headerRow', 'providerLayoutId', 'dateColumn', 'valueColumn', 'sourceOwner', 'sourceReference', 'dataAsOf', 'reason', 'entitlementId', 'file'] as const;
export const UPLOAD_FIELD_LABELS: Readonly<Record<string, string>> = {
  benchmarkKey: 'Benchmark',
  mode: 'Upload mode',
  returnVariant: 'Return type',
  currencyCode: 'Currency',
  historyClass: 'History type',
  dateFormat: 'Date format used in the file',
  numberLocale: 'How numbers are written',
  sheetName: 'Sheet',
  headerRow: 'Header row',
  providerLayoutId: 'Provider layout',
  dateColumn: 'Date column',
  valueColumn: 'Value column',
  sourceOwner: 'Source owner',
  sourceReference: 'Source URL or reference',
  dataAsOf: 'Data as of',
  reason: 'Reason for the correction',
  entitlementId: 'Approved entitlement',
  file: 'File',
};
export const UPLOAD_FIELD_MAP: FieldMap = {
  benchmarkKey: 'benchmarkKey',
  shape: 'benchmarkKey',
  mode: 'mode',
  returnVariant: 'returnVariant',
  currencyCode: 'currencyCode',
  historyClass: 'historyClass',
  dateFormat: 'dateFormat',
  numberLocale: 'numberLocale',
  sheetName: 'sheetName',
  headerRow: 'headerRow',
  providerLayoutId: 'providerLayoutId',
  'columnMap.date': 'dateColumn',
  'columnMap.value': 'valueColumn',
  sourceOwner: 'sourceOwner',
  sourceReference: 'sourceReference',
  dataAsOf: 'dataAsOf',
  reason: 'reason',
  entitlementIds: 'entitlementId',
};
export const UPLOAD_DATE_KEYS: ReadonlySet<string> = new Set(['dataAsOf']);

/** The wizard step that holds each upload field (a summary link switches to it before focusing). */
export const UPLOAD_FIELD_STEP: Readonly<Record<string, number>> = {
  benchmarkKey: 1,
  returnVariant: 1,
  currencyCode: 1,
  mode: 2,
  historyClass: 2,
  sourceOwner: 2,
  sourceReference: 2,
  dataAsOf: 2,
  reason: 2,
  entitlementId: 2,
  file: 3,
  dateFormat: 3,
  numberLocale: 3,
  sheetName: 3,
  headerRow: 3,
  providerLayoutId: 3,
  dateColumn: 3,
  valueColumn: 3,
};
