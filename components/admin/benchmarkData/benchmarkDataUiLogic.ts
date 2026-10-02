// BENCH-1 Phase 2 - Market Index Data Admin UI: ALL non-trivial decisions, as PURE functions.
//
// This repository has no DOM test environment, so everything the screens decide
// (which controls are shown, which steps may advance, when Publish enables, how
// a server response becomes a sentence) lives here, with no React and no browser
// globals, and is unit-tested exhaustively (tests/unit/benchmarkDataUiLogic.test.ts)
// including NAMED negative controls (scripts/bench1_ui_negative_controls.mjs).
//
// Everything here is UX only. The server and the database enforce every
// capability again (Admin Architecture Standard sections 2 and 4): hiding or
// disabling a control is never the security control.
//
// Type-only imports from the API contract; no server-only module is imported.
import type {
  BenchmarkCapabilityFlags,
  BenchmarkOverviewRow,
  CatalogueRowView,
  EntitlementRightsView,
  ImportJobSummary,
  JobPreview,
  PendingImportTask,
  PublishRequestBody,
  PublishResponse,
  StageUploadRequestParams,
} from '@/lib/services/investment-intelligence/benchmarkData/apiTypes';
import { PROVIDER_LAYOUTS } from '@/lib/services/investment-intelligence/benchmarkData/fileIngest/layouts';
import { isSafeServerMessage } from '@/lib/resources/admin/resultState';
import { formatDateShort } from '@/lib/engines/date';
import { DATE_INPUT_PLACEHOLDER, formatDateInput, parseDateInput } from '@/lib/engines/dateInput';

// ------------------------------------------------------------------ API paths ---

export const API_BASE = '/api/admin/investment-intelligence/benchmark-data';

const seg = (s: string) => encodeURIComponent(s);

/** The ONLY place the client builds API paths (the contract test checks each against the contract list). */
export const apiPaths = {
  overview: () => `${API_BASE}/overview`,
  uploadInspect: () => `${API_BASE}/upload/inspect`,
  upload: () => `${API_BASE}/upload`,
  jobs: () => `${API_BASE}/jobs`,
  job: (id: string) => `${API_BASE}/jobs/${seg(id)}`,
  jobErrors: (id: string) => `${API_BASE}/jobs/${seg(id)}/errors`,
  jobPublish: (id: string) => `${API_BASE}/jobs/${seg(id)}/publish`,
  jobCancel: (id: string) => `${API_BASE}/jobs/${seg(id)}/cancel`,
  jobRollback: (id: string) => `${API_BASE}/jobs/${seg(id)}/rollback`,
  template: (name: TemplateName) => `${API_BASE}/templates/${seg(name)}`,
  help: () => `${API_BASE}/help`,
  catalogue: () => `${API_BASE}/catalogue`,
  catalogueVerify: (id: string) => `${API_BASE}/catalogue/${seg(id)}/verify`,
  entitlements: () => `${API_BASE}/entitlements`,
  entitlementApprove: (id: string) => `${API_BASE}/entitlements/${seg(id)}/approve`,
  entitlementRevoke: (id: string) => `${API_BASE}/entitlements/${seg(id)}/revoke`,
  mappings: () => `${API_BASE}/mappings`,
  mappingReview: (id: string) => `${API_BASE}/mappings/${seg(id)}/review`,
  ingestionMode: (benchmarkId: string) => `${API_BASE}/ingestion/${seg(benchmarkId)}/mode`,
} as const;

export type TemplateName = 'single_date_value' | 'multi_key_date_value' | 'provider_nse_tri_export';

export const TEMPLATE_LINKS: ReadonlyArray<{ name: TemplateName; label: string; description: string }> = [
  { name: 'single_date_value', label: 'Single benchmark template (date,value)', description: 'One benchmark; the benchmark, source, return type and currency are chosen on the form.' },
  { name: 'multi_key_date_value', label: 'Several benchmarks template (benchmark_key,date,value)', description: 'Every benchmark_key must exactly match a catalogue key.' },
  { name: 'provider_nse_tri_export', label: 'NSE total-return export template (Date, Total Returns Index)', description: 'The shape of a supported provider export.' },
];

// ----------------------------------------------------------- option lists ---

export type ShapeId = StageUploadRequestParams['shape'];
export type VariantId = NonNullable<CatalogueRowView['returnVariant']>;
export type HistoryClassId = StageUploadRequestParams['historyClass'];
export type DateFormatId = StageUploadRequestParams['dateFormat'];
export type NumberLocaleId = StageUploadRequestParams['numberLocale'];
export type UploadModeId = StageUploadRequestParams['mode'];

export const SHAPE_OPTIONS: ReadonlyArray<{ value: ShapeId; label: string; columns: string; description: string }> = [
  { value: 'single', label: 'Single benchmark', columns: 'date,value', description: 'One benchmark per file. You choose which one on this form.' },
  { value: 'multi', label: 'Several benchmarks', columns: 'benchmark_key,date,value', description: 'Each row names its benchmark. Every key must already exist in the catalogue.' },
  { value: 'provider_export', label: 'Supported provider export', columns: 'as exported by the provider', description: 'A file straight from an index provider. You choose a known layout or map the columns yourself; nothing is guessed.' },
];

export const VARIANT_OPTIONS: ReadonlyArray<{ value: VariantId; label: string }> = [
  { value: 'price', label: 'Price' },
  { value: 'total_return', label: 'Total return (TRI)' },
  { value: 'net_total_return', label: 'Net total return' },
];

export function variantLabel(v: string | null | undefined): string {
  return VARIANT_OPTIONS.find((o) => o.value === v)?.label ?? (v ? v : 'not declared');
}

export const HISTORY_CLASS_OPTIONS: ReadonlyArray<{ value: HistoryClassId; label: string }> = [
  { value: 'live', label: 'Live (published as it happened)' },
  { value: 'backtested', label: 'Backtested (calculated back from launch)' },
  { value: 'mixed', label: 'Mixed (backtested, then live)' },
  { value: 'unknown', label: 'Not known' },
];

export const UPLOAD_MODE_OPTIONS: ReadonlyArray<{ value: UploadModeId; label: string; description: string }> = [
  { value: 'new_history', label: 'New history', description: 'Adds dates that are not yet stored. Dates already stored with the same value are skipped; a different value is a correction and is refused in this mode.' },
  { value: 'correction', label: 'Correction', description: 'Replaces stored levels with corrected values. The old level is kept as revision history. Needs a written reason and the correction permission.' },
];

/** Explicit date formats. There is deliberately NO default: a date such as 03-04-2024 is two different days depending on the order. */
export const DATE_FORMAT_OPTIONS: ReadonlyArray<{ value: DateFormatId; label: string; example: string }> = [
  { value: 'YYYY-MM-DD', label: 'Year first (YYYY-MM-DD)', example: '2024-01-31' },
  { value: 'DD/MM/YYYY', label: 'Day/month/year (DD/MM/YYYY)', example: '31/01/2024' },
  { value: 'MM/DD/YYYY', label: 'Month/day/year, US (MM/DD/YYYY)', example: '01/31/2024' },
  { value: 'DD-MM-YYYY', label: 'Day-month-year (DD-MM-YYYY)', example: '31-01-2024' },
  { value: 'DD-MMM-YYYY', label: 'Day-Mon-year (DD-MMM-YYYY)', example: '31-Jan-2024' },
  { value: 'DD MMM YYYY', label: 'Day Mon year (DD MMM YYYY)', example: '31 Jan 2024' },
  { value: 'excel_1900', label: 'Excel date number (1900 date system)', example: '45322' },
  { value: 'excel_1904', label: 'Excel date number (1904 date system)', example: '43860' },
];

export const NUMBER_LOCALE_OPTIONS: ReadonlyArray<{ value: NumberLocaleId; label: string; example: string }> = [
  { value: 'plain', label: 'Plain, no thousands separator', example: '12345.67' },
  { value: 'en', label: 'English grouping (commas by thousands)', example: '12,345.67' },
  { value: 'in', label: 'Indian grouping (lakhs and crores)', example: '1,23,456.78' },
  { value: 'eu', label: 'European (dot for thousands, comma for decimals)', example: '12.345,67' },
];

export function isDateFormatId(v: string): v is DateFormatId {
  return DATE_FORMAT_OPTIONS.some((o) => o.value === v);
}
export function isNumberLocaleId(v: string): v is NumberLocaleId {
  return NUMBER_LOCALE_OPTIONS.some((o) => o.value === v);
}

export const PROVIDER_LAYOUT_OPTIONS: ReadonlyArray<{ id: string; label: string; hasIndexName: boolean; unverified: boolean }> = Object.values(PROVIDER_LAYOUTS).map((l) => ({
  id: l.id,
  label: l.label,
  hasIndexName: Boolean(l.indexNameColumn),
  unverified: l.unverified,
}));

export const ACK_INFO: Readonly<Record<string, { label: string; warning: string }>> = {
  scale_change: { label: 'I have checked the possible scale change', warning: 'The levels appear to jump by a large factor (for example a rebasing, or points entered as thousands). Confirm the levels are on the same scale as the stored history.' },
  large_moves: { label: 'I have checked the large day-to-day moves', warning: 'Some days move by an unusually large amount. Large real moves are possible, but they can also be typing errors. Confirm they are genuine.' },
  weekend_rows: { label: 'I have checked the Saturday and Sunday rows', warning: 'The file has levels on weekend dates. Indian benchmarks do not normally publish on weekends, except special sessions. Confirm these are genuine.' },
  coverage_gaps: { label: 'I accept the gaps in coverage', warning: 'The file skips some expected trading days. Missing days are never filled in or estimated. Confirm you accept the gaps.' },
  hidden_rows_included: { label: 'I accept that hidden spreadsheet rows are included', warning: 'You chose to include rows that are hidden in the spreadsheet. Confirm that hidden rows belong in this upload.' },
};

export function ackInfo(id: string): { label: string; warning: string } {
  return ACK_INFO[id] ?? { label: `I confirm: ${id}`, warning: 'This upload needs an explicit confirmation before it can be published.' };
}

export const ENTITLEMENT_RIGHT_INFO: ReadonlyArray<{ key: keyof EntitlementRightsView['rights']; short: string; label: string; meaning: string }> = [
  { key: 'ingestManual', short: 'Ingest', label: 'Manual ingestion', meaning: 'An administrator may load a file of this benchmark by hand.' },
  { key: 'automation', short: 'Automation', label: 'Automated ingestion', meaning: 'A scheduled job may fetch this benchmark from the provider without a person.' },
  { key: 'storage', short: 'Storage', label: 'Storage', meaning: 'The levels may be kept in the database.' },
  { key: 'calculation', short: 'Calculation', label: 'Calculation', meaning: 'The levels may be used inside return calculations. Needs storage.' },
  { key: 'customerDisplay', short: 'Display', label: 'Customer display', meaning: 'Customers may see comparisons built from the levels. Needs calculation.' },
  { key: 'reportExport', short: 'Export', label: 'Report and export', meaning: 'Reports and downloads may include the levels or comparisons. Needs customer display.' },
];

export const LICENCE_STATUS_EXPLAINER =
  'A licence status label on a benchmark (for example "public open" or "licensed") grants nothing by itself. Every right below must be recorded in an approved entitlement record for the exact benchmark, return type and currency, and each right is checked separately.';

export const NO_ENTITLEMENT_MESSAGE =
  'A file upload does not itself establish permission to use the data. An approved entitlement record for this benchmark is required before anything can be published. Propose one on the Entitlements tab; a user who can approve entitlements must then approve it.';

export const RETURN_TYPE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'TRI', label: 'TRI (total return index)' },
  { value: 'PRI', label: 'PRI (price return index)' },
  { value: 'DEBT_INDEX', label: 'Debt index' },
  { value: 'COMMODITY_GOLD', label: 'Gold / commodity' },
  { value: 'OTHER', label: 'Other (use for net total return)' },
];

export const ASSET_CLASS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'equity', label: 'Equity' },
  { value: 'debt', label: 'Debt' },
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'gold', label: 'Gold' },
  { value: 'silver', label: 'Silver' },
  { value: 'commodity', label: 'Commodity' },
  { value: 'international_equity', label: 'International equity' },
  { value: 'money_market', label: 'Money market' },
  { value: 'other', label: 'Other' },
];

export const RELATIONSHIP_OPTIONS: ReadonlyArray<{ value: 'primary' | 'secondary' | 'category_average'; label: string }> = [
  { value: 'primary', label: 'Primary benchmark (declared by the scheme)' },
  { value: 'secondary', label: 'Secondary benchmark' },
  { value: 'category_average', label: 'Category average' },
];
export const EVIDENCE_SOURCE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'amc_sid', label: 'Scheme information document' },
  { value: 'amc_kim', label: 'Key information memorandum' },
  { value: 'amc_factsheet', label: 'AMC factsheet' },
  { value: 'amc_addendum', label: 'AMC addendum' },
  { value: 'amfi_disclosure', label: 'AMFI disclosure' },
  { value: 'other', label: 'Other document' },
];
export const RESOLUTION_METHOD_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'deterministic_exact', label: 'Exact name match' },
  { value: 'identifier_match', label: 'Identifier match' },
  { value: 'admin_judgement', label: 'Administrator judgement' },
];
export const CONFIDENCE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];

// ------------------------------------------------------------ chips / labels ---

export type Tone = 'ok' | 'warn' | 'bad' | 'neutral' | 'info';

export function catalogueStatusChip(status: CatalogueRowView['catalogueStatus']): { label: string; tone: Tone } {
  switch (status) {
    case 'verified':
      return { label: 'Verified', tone: 'ok' };
    case 'draft':
      return { label: 'Draft', tone: 'warn' };
    case 'deprecated':
      return { label: 'Deprecated', tone: 'neutral' };
    default:
      return { label: 'Unknown status', tone: 'bad' };
  }
}

export function dataStateChip(state: BenchmarkOverviewRow['dataState']): { label: string; tone: Tone } {
  switch (state) {
    case 'no_data':
      return { label: 'No data', tone: 'bad' };
    case 'history_missing':
      return { label: 'History missing', tone: 'warn' };
    case 'stale':
      return { label: 'Stale', tone: 'warn' };
    case 'current':
      return { label: 'Current', tone: 'ok' };
    case 'blocked_no_entitlement':
      return { label: 'Blocked: no entitlement', tone: 'bad' };
    default:
      return { label: 'Unknown', tone: 'bad' };
  }
}

/** NEVER describes a manual import as automatic (Mission J). */
export function ingestionModeLabel(ing: BenchmarkOverviewRow['ingestion'], effectivelyEnabled: boolean): { label: string; tone: Tone } {
  if (!ing) return { label: 'Manual import (not configured; nothing updates automatically)', tone: 'neutral' };
  switch (ing.mode) {
    case 'manual_import':
      return { label: 'Manual import', tone: 'neutral' };
    case 'disabled':
      return { label: 'Disabled', tone: 'neutral' };
    case 'automated':
      return ing.automationEnabled && effectivelyEnabled ? { label: 'Automated', tone: 'ok' } : { label: 'Automated mode, but recurring ingestion is OFF', tone: 'warn' };
    default:
      return { label: 'Unknown mode', tone: 'bad' };
  }
}

export const INGESTION_MODE_OPTIONS: ReadonlyArray<{ value: 'disabled' | 'manual_import' | 'automated'; label: string; description: string }> = [
  { value: 'disabled', label: 'Disabled', description: 'No import of any kind is expected for this benchmark.' },
  { value: 'manual_import', label: 'Manual import', description: 'An administrator uploads files. Nothing updates automatically; the Overview shows when an upload is due.' },
  { value: 'automated', label: 'Automated', description: 'A scheduled job fetches the data from a provider. Needs every condition listed below.' },
];

export function pendingStatusChip(status: PendingImportTask['status']): { label: string; tone: Tone } {
  switch (status) {
    case 'due':
      return { label: 'Due', tone: 'warn' };
    case 'overdue':
      return { label: 'Overdue', tone: 'bad' };
    case 'never_imported':
      return { label: 'Never imported', tone: 'bad' };
    case 'current':
      return { label: 'Up to date', tone: 'ok' };
    case 'not_manual':
      return { label: 'Not a manual import', tone: 'neutral' };
    default:
      return { label: 'Unknown', tone: 'bad' };
  }
}

const SEVERITY_RANK: Record<PendingImportTask['severity'], number> = { critical: 0, warning: 1, info: 2 };

/** Only tasks that need an operator, most severe first. A "current" or "not manual" row is never listed as pending work. */
export function visiblePendingTasks(tasks: readonly PendingImportTask[]): PendingImportTask[] {
  return tasks
    .filter((t) => t.status === 'due' || t.status === 'overdue' || t.status === 'never_imported')
    .slice()
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.benchmarkLabel.localeCompare(b.benchmarkLabel));
}

export function jobStatusChip(status: string): { label: string; tone: Tone; hint: string } {
  switch (status) {
    case 'staging':
      return { label: 'Staging', tone: 'info', hint: 'The file is being read and checked.' };
    case 'validated':
      return { label: 'Validated', tone: 'info', hint: 'Checked and waiting for a publisher.' };
    case 'published':
      return { label: 'Published', tone: 'ok', hint: 'The levels are live.' };
    case 'rolled_back':
      return { label: 'Rolled back', tone: 'neutral', hint: 'Published, then reversed. History is kept.' };
    case 'failed':
      return { label: 'Failed', tone: 'bad', hint: 'Something went wrong. Nothing was published.' };
    case 'stale':
      return { label: 'Stale', tone: 'warn', hint: 'The stored levels changed after the preview. Upload the file again.' };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'neutral', hint: 'Cancelled before publication.' };
    case 'expired':
      return { label: 'Expired', tone: 'neutral', hint: 'Not published in time. Upload the file again.' };
    default:
      return { label: status || 'Unknown', tone: 'neutral', hint: '' };
  }
}

export function mappingStatusChip(status: string): { label: string; tone: Tone } {
  switch (status) {
    case 'proposed':
      return { label: 'Awaiting review', tone: 'warn' };
    case 'approved':
      return { label: 'Approved', tone: 'ok' };
    case 'rejected':
      return { label: 'Rejected', tone: 'bad' };
    case 'superseded':
      return { label: 'Superseded', tone: 'neutral' };
    default:
      return { label: status, tone: 'neutral' };
  }
}

export function entitlementStatusChip(status: EntitlementRightsView['status']): { label: string; tone: Tone } {
  switch (status) {
    case 'approved':
      return { label: 'Approved', tone: 'ok' };
    case 'draft':
      return { label: 'Awaiting approval', tone: 'warn' };
    case 'revoked':
      return { label: 'Revoked', tone: 'bad' };
    default:
      return { label: 'Unknown', tone: 'bad' };
  }
}

export function entitlementKindLabel(kind: EntitlementRightsView['kind']): string {
  return kind === 'public_use_permission' ? 'Public-use permission' : 'Commercial licence';
}

export function postExpiryLabel(v: EntitlementRightsView['postExpiryStorage']): string {
  return v === 'retain' ? 'Keep stored data after expiry' : v === 'delete' ? 'Delete stored data after expiry' : 'After expiry: not stated';
}

export interface EntitlementSummary {
  approvedInTerm: number;
  granted: ReadonlyArray<{ key: string; label: string }>;
  noApproved: boolean;
  text: string;
}

/** Union of rights granted by APPROVED, in-term records only. A draft, revoked or expired record grants nothing. */
export function summariseEntitlements(entitlements: readonly EntitlementRightsView[], asOfDate: string): EntitlementSummary {
  const live = entitlements.filter((e) => e.status === 'approved' && e.validFrom <= asOfDate && (e.validTo === null || e.validTo >= asOfDate));
  const granted = ENTITLEMENT_RIGHT_INFO.filter((r) => live.some((e) => e.rights[r.key] === true)).map((r) => ({ key: r.key as string, label: r.short }));
  const noApproved = live.length === 0;
  return { approvedInTerm: live.length, granted, noApproved, text: noApproved ? 'No approved entitlement' : granted.map((g) => g.label).join(', ') };
}

// ------------------------------------------------------------- automation ---

export interface AutomationStatus {
  headline: string;
  on: boolean;
  switches: ReadonlyArray<{ label: string; on: boolean }>;
  blockedBy: string[];
}

export function automationStatus(s: { globalIngestion: boolean; writeIngestion: boolean; environmentFlag: boolean; effectivelyEnabled: boolean }): AutomationStatus {
  const switches = [
    { label: 'Environment flag', on: s.environmentFlag === true },
    { label: 'Global ingestion switch', on: s.globalIngestion === true },
    { label: 'Write switch (publishing fetched rows)', on: s.writeIngestion === true },
  ];
  const on = s.effectivelyEnabled === true && switches.every((x) => x.on);
  return {
    headline: on ? 'Recurring ingestion is ON' : 'Recurring ingestion is OFF',
    on,
    switches,
    blockedBy: switches.filter((x) => !x.on).map((x) => x.label),
  };
}

// ----------------------------------------------------------- capabilities ---

export interface CapabilityDecisions {
  canViewAnything: boolean;
  canStage: boolean;
  canPublishNew: boolean;
  canCorrect: boolean;
  canManageCatalogue: boolean;
  canProposeEntitlement: boolean;
  canApproveEntitlement: boolean;
  canReviewMappings: boolean;
  canEditIngestion: boolean;
  /** Plain-language reason per hidden/disabled control group (empty string when the control is available). */
  why: { stage: string; publish: string; correct: string; catalogue: string; entitlementApprove: string };
}

/** Each capability decides ONLY its own controls; none implies another (Standard section 2). */
export function capabilityDecisions(caps: BenchmarkCapabilityFlags): CapabilityDecisions {
  const c = (k: keyof BenchmarkCapabilityFlags) => caps[k] === true;
  return {
    canViewAnything: c('view'),
    canStage: c('upload'),
    canPublishNew: c('publish'),
    canCorrect: c('correct'),
    canManageCatalogue: c('catalogue'),
    canProposeEntitlement: c('catalogue'),
    canApproveEntitlement: c('entitlementApprove'),
    canReviewMappings: c('catalogue'),
    canEditIngestion: c('catalogue'),
    why: {
      stage: c('upload') ? '' : 'You do not have the upload permission, so you can read this page but cannot stage a file. Ask an administrator who manages roles to grant it.',
      publish: c('publish') ? '' : 'You do not have the permission to publish new history. You can stage and review an upload; a user with the publish permission must publish it.',
      correct: c('correct') ? '' : 'You do not have the correction permission. Corrections replace stored levels, so they need that separate permission.',
      catalogue: c('catalogue') ? '' : 'You do not have the catalogue permission, so this information is read-only for you.',
      entitlementApprove: c('entitlementApprove') ? '' : 'You do not have the permission to approve or revoke entitlements.',
    },
  };
}

/** Which capability publishes a job: corrections need `correct`, everything else needs `publish`. */
export function publishCapabilityFor(mode: string, caps: BenchmarkCapabilityFlags): boolean {
  return mode === 'correction' ? caps.correct === true : caps.publish === true;
}

// ---------------------------------------------------------- upload form ---

export interface UploadFormState {
  shape: ShapeId | '';
  benchmarkKey: string;
  returnVariant: VariantId | '';
  currencyCode: string;
  historyClass: HistoryClassId | '';
  mode: UploadModeId;
  reason: string;
  dateFormat: DateFormatId | '';
  numberLocale: NumberLocaleId | '';
  sourceOwner: string;
  sourceReference: string;
  dataAsOf: string;
  entitlementId: string;
  columnChoice: 'layout' | 'explicit' | '';
  providerLayoutId: string;
  dateColumn: string;
  valueColumn: string;
  indexNameColumn: string;
  indexNameMap: Array<{ indexName: string; benchmarkKey: string }>;
  sheetName: string;
  includeHiddenRows: boolean;
  headerRow: string;
}

export function emptyUploadForm(preselectBenchmarkKey = ''): UploadFormState {
  return {
    shape: '',
    benchmarkKey: preselectBenchmarkKey,
    returnVariant: '',
    currencyCode: '',
    historyClass: '',
    mode: 'new_history',
    reason: '',
    // Deliberately EMPTY: the operator must choose. An ambiguous format is never guessed.
    dateFormat: '',
    numberLocale: '',
    sourceOwner: '',
    sourceReference: '',
    dataAsOf: '',
    entitlementId: '',
    columnChoice: '',
    providerLayoutId: '',
    dateColumn: '',
    valueColumn: '',
    indexNameColumn: '',
    indexNameMap: [],
    sheetName: '',
    includeHiddenRows: false,
    headerRow: '1',
  };
}

export interface SheetOption {
  name: string;
  index: number;
  state: 'visible' | 'hidden' | 'veryHidden';
  rowCount: number | null;
}

/** Result of POST upload/inspect. `header` is optional (the contract does not promise it). */
export interface InspectState {
  kind: 'csv' | 'xlsx' | null;
  sheets: SheetOption[];
  problems: Array<{ code: string; message: string; rowNumber?: number }>;
  fileSha256: string;
  bytes: number;
  header?: string[];
}

export interface UploadFileInfo {
  name: string;
  size: number;
}

export type FileKind = 'csv' | 'xlsx';

export const ACCEPTED_EXTENSIONS = '.csv,.xlsx';

export function fileKindFromName(name: string): FileKind | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(name.trim());
  const ext = m ? m[1].toLowerCase() : '';
  return ext === 'csv' ? 'csv' : ext === 'xlsx' ? 'xlsx' : null;
}

export function fileProblem(file: UploadFileInfo | null, maxBytes: number | null): string | null {
  if (!file) return 'Choose a file.';
  if (fileKindFromName(file.name) === null) return 'Only .csv and .xlsx files are accepted. PDF, .xls and macro-enabled workbooks (.xlsm) are not.';
  if (file.size <= 0) return 'The file is empty.';
  if (maxBytes !== null && file.size > maxBytes) return `The file is ${formatBytes(file.size)}, which is over the ${formatBytes(maxBytes)} limit.`;
  return null;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return 'unknown size';
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${Math.round((n / 1024) * 10) / 10} KB`;
  return `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;
}

export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'n/a';
  return n.toLocaleString('en-IN');
}

export function formatLevel(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'n/a';
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

/**
 * Every date this module shows is day-first (PO rule, Document2 findings #8/#19):
 * the Market Index Data catalogue is India's (NSE, BSE), so dates use the India
 * format dd-mm-yyyy through the canonical formatter, never ISO year-first. A
 * screen that lists benchmarks in another currency passes that currency.
 */
export type DateDisplayCurrency = 'AUD' | 'INR';
export const MODULE_DATE_CURRENCY: DateDisplayCurrency = 'INR';

export function formatDateTime(iso: string | null | undefined, currency: DateDisplayCurrency = MODULE_DATE_CURRENCY): string {
  if (!iso) return 'never';
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(iso);
  return m ? `${formatDateShort(m[1], currency)} ${m[2]} UTC` : iso;
}

/** An ISO date-only value (or the date part of a timestamp) as a day-first date; 'none' when absent. */
export function formatDate(iso: string | null | undefined, currency: DateDisplayCurrency = MODULE_DATE_CURRENCY): string {
  if (!iso) return 'none';
  const day = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return day ? formatDateShort(day[1], currency) : iso;
}

// ------------------------------------------------------------ typed date fields ---
// Date fields are TEXT fields (never the browser's date picker, which follows the
// browser locale). The operator types DD-MM-YYYY; the form holds that text and the
// request body gets the ISO value the API expects.

export { DATE_INPUT_PLACEHOLDER };

/** Words for a typed date field in a validation message. */
export const DATE_TYPING_HELP = 'DD-MM-YYYY, like 01-10-2026';

/** ISO value for a typed date, or null when it is not a valid day-first date. */
export function typedDateToIso(v: string | null | undefined): string | null {
  return parseDateInput(v);
}

/** Typed (or empty) date for the request body: ISO when valid; the raw text otherwise so the server refuses it; null when empty. */
function bodyDate(v: string): string | null {
  const t = v.trim();
  if (t === '') return null;
  return parseDateInput(t) ?? t;
}

export function shortDigest(d: string | null | undefined): string {
  if (!d) return 'n/a';
  return d.length > 16 ? `${d.slice(0, 8)}...${d.slice(-8)}` : d;
}

export function limitsText(limits: { maxBytes: number; maxRows: number } | null | undefined): string {
  if (!limits) return 'Only .csv and .xlsx files are accepted.';
  return `Only .csv and .xlsx files, up to ${formatBytes(limits.maxBytes)} and ${formatCount(limits.maxRows)} data rows.`;
}

/** Entitlements that could authorise a manual publication: approved AND granting both manual ingestion and storage. */
export function eligibleEntitlements(row: Pick<BenchmarkOverviewRow, 'entitlements'> | null | undefined, asOfDate: string): EntitlementRightsView[] {
  if (!row) return [];
  return row.entitlements.filter((e) => e.status === 'approved' && e.rights.ingestManual === true && e.rights.storage === true && e.validFrom <= asOfDate && (e.validTo === null || e.validTo >= asOfDate));
}

export interface EntitlementGate {
  ok: boolean;
  message: string;
}

export function entitlementGate(row: Pick<BenchmarkOverviewRow, 'entitlements'> | null | undefined, asOfDate: string): EntitlementGate {
  if (!row) return { ok: false, message: 'Choose a benchmark first.' };
  const approved = row.entitlements.filter((e) => e.status === 'approved');
  if (approved.length === 0) return { ok: false, message: NO_ENTITLEMENT_MESSAGE };
  if (eligibleEntitlements(row, asOfDate).length === 0) {
    return { ok: false, message: `${NO_ENTITLEMENT_MESSAGE} An approved record exists, but it is expired, not yet in term, or does not grant both manual ingestion and storage.` };
  }
  return { ok: true, message: '' };
}

/** Variant/currency the operator confirmed versus the catalogue (inline mismatch error). */
export function identityMismatch(form: Pick<UploadFormState, 'returnVariant' | 'currencyCode'>, row: Pick<CatalogueRowView, 'returnVariant' | 'currencyCode' | 'label'> | null | undefined): string | null {
  if (!row) return null;
  if (!row.returnVariant || !row.currencyCode) return `${row.label} has no declared return type or currency in the catalogue, so nothing can be uploaded for it. Complete the catalogue entry first.`;
  if (form.returnVariant && form.returnVariant !== row.returnVariant) {
    return `You confirmed "${variantLabel(form.returnVariant)}" but the catalogue says ${row.label} is "${variantLabel(row.returnVariant)}". Price, total return and net total return are different series; choose the matching file or benchmark.`;
  }
  if (form.currencyCode.trim() && form.currencyCode.trim().toUpperCase() !== row.currencyCode.trim().toUpperCase()) {
    return `You confirmed currency ${form.currencyCode.trim().toUpperCase()} but the catalogue says ${row.label} is quoted in ${row.currencyCode.trim().toUpperCase()}.`;
  }
  return null;
}

export function isValidCurrency(v: string): boolean {
  return /^[A-Za-z]{3}$/.test(v.trim());
}

export function isIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export function isHttpUrl(v: string): boolean {
  return /^https?:\/\/[^\s/$.?#][^\s]*$/i.test(v.trim());
}

/** XLSX rule: an explicit sheet choice is REQUIRED; nothing is chosen for the operator. */
export function xlsxSheetRule(kind: FileKind | null, inspect: InspectState | null, sheetName: string): { required: boolean; ok: boolean; message: string | null } {
  if (kind !== 'xlsx') return { required: false, ok: true, message: null };
  if (!inspect || inspect.kind !== 'xlsx') return { required: true, ok: false, message: 'The workbook has not been inspected yet. Choose "Read the sheets" so you can pick the sheet to process.' };
  if (inspect.sheets.length === 0) return { required: true, ok: false, message: 'No sheets were found in the workbook.' };
  if (!sheetName) return { required: true, ok: false, message: 'Choose the sheet to process. The system never picks one for you.' };
  if (!inspect.sheets.some((s) => s.name === sheetName)) return { required: true, ok: false, message: 'The chosen sheet is not in this workbook. Choose one from the list.' };
  return { required: true, ok: true, message: null };
}

export interface SheetDisclosure {
  processed: string;
  otherNotProcessed: string[];
  chosenIsHidden: boolean;
  hiddenRowsText: string;
}

export function sheetDisclosure(inspect: InspectState | null, sheetName: string, includeHiddenRows: boolean): SheetDisclosure | null {
  if (!inspect || inspect.kind !== 'xlsx' || !sheetName) return null;
  const chosen = inspect.sheets.find((s) => s.name === sheetName);
  if (!chosen) return null;
  return {
    processed: chosen.name,
    otherNotProcessed: inspect.sheets.filter((s) => s.name !== chosen.name).map((s) => s.name),
    chosenIsHidden: chosen.state !== 'visible',
    hiddenRowsText: includeHiddenRows ? 'Rows hidden in the spreadsheet WILL be processed, and you will be asked to confirm that.' : 'Rows hidden in the spreadsheet will be skipped, and the preview lists which rows were skipped.',
  };
}

export function sheetStateLabel(state: SheetOption['state']): string {
  return state === 'visible' ? 'visible' : state === 'hidden' ? 'hidden' : 'very hidden';
}

export function columnMappingIssues(form: UploadFormState): string[] {
  if (form.shape !== 'provider_export') return [];
  const out: string[] = [];
  if (form.columnChoice === '') {
    out.push('Choose how the columns are identified: a known provider layout, or an explicit column mapping.');
  } else if (form.columnChoice === 'layout') {
    if (!form.providerLayoutId || !PROVIDER_LAYOUT_OPTIONS.some((l) => l.id === form.providerLayoutId)) out.push('Choose the provider layout.');
  } else {
    if (!form.dateColumn.trim()) out.push('Name the date column.');
    if (!form.valueColumn.trim()) out.push('Name the value (index level) column.');
    if (form.dateColumn.trim() && form.dateColumn.trim() === form.valueColumn.trim()) out.push('The date column and the value column must be different columns.');
  }
  return out;
}

/** Benchmarks the upload touches that are knowable before the file is read. */
export function involvedBenchmarkKeys(form: UploadFormState): string[] {
  const mapped = form.indexNameMap.filter((m) => m.indexName.trim() && m.benchmarkKey).map((m) => m.benchmarkKey);
  if (form.shape === 'single') return form.benchmarkKey ? [form.benchmarkKey] : [];
  if (form.shape === 'provider_export') return mapped.length > 0 ? Array.from(new Set(mapped)) : form.benchmarkKey ? [form.benchmarkKey] : [];
  return [];
}

export interface UploadContext {
  form: UploadFormState;
  rows: readonly BenchmarkOverviewRow[];
  caps: BenchmarkCapabilityFlags;
  asOfDate: string;
  file: UploadFileInfo | null;
  inspect: InspectState | null;
  maxBytes: number | null;
}

function rowFor(ctx: UploadContext, key: string): BenchmarkOverviewRow | undefined {
  return ctx.rows.find((r) => r.catalogue.benchmarkKey === key);
}

export type StepNumber = 1 | 2 | 3;

/** Reasons the given form step is not yet complete (empty array = complete). */
export function stepIssues(step: StepNumber, ctx: UploadContext): string[] {
  const f = ctx.form;
  const out: string[] = [];
  if (step === 1) {
    if (!f.shape) out.push('Choose the file shape.');
    const multiIndexProvider = f.shape === 'provider_export' && f.indexNameMap.some((m) => m.indexName.trim() && m.benchmarkKey);
    if (f.shape === 'single' || (f.shape === 'provider_export' && !multiIndexProvider)) {
      if (!f.benchmarkKey) out.push('Choose the benchmark. Only benchmarks that already exist in the catalogue can be chosen.');
      else if (!rowFor(ctx, f.benchmarkKey)) out.push('That benchmark is not in the catalogue.');
    }
    if (!f.returnVariant) out.push('Confirm the return type of the levels in the file (price, total return or net total return).');
    if (!f.currencyCode.trim()) out.push('Confirm the currency of the levels in the file.');
    else if (!isValidCurrency(f.currencyCode)) out.push('The currency must be a three-letter code such as INR.');
    for (const key of involvedBenchmarkKeys(f)) {
      const r = rowFor(ctx, key);
      const mm = identityMismatch(f, r?.catalogue);
      if (mm) out.push(mm);
    }
    return out;
  }
  if (step === 2) {
    if (f.sourceOwner.trim().length < 2) out.push('Enter the source owner or provider.');
    if (f.sourceReference.trim().length < 5) out.push('Enter the original source URL or delivery reference.');
    if (!f.historyClass) out.push('Choose whether the history is live, backtested, mixed or not known.');
    if (f.dataAsOf.trim() && typedDateToIso(f.dataAsOf) === null) out.push(`The data-as-of date must be a valid date (${DATE_TYPING_HELP}) or left empty.`);
    if (f.mode === 'correction') {
      if (!ctx.caps.correct) out.push('Corrections need the correction permission, which you do not have.');
      if (f.reason.trim().length < 20) out.push('A correction needs a written reason of at least 20 characters.');
    }
    const keys = involvedBenchmarkKeys(f);
    if (f.shape === 'single' || (f.shape === 'provider_export' && keys.length === 1)) {
      const r = rowFor(ctx, keys[0] ?? '');
      const gate = entitlementGate(r, ctx.asOfDate);
      if (!gate.ok) out.push(gate.message);
      else if (!f.entitlementId) out.push('Choose the approved entitlement that covers this upload.');
      else if (!eligibleEntitlements(r, ctx.asOfDate).some((e) => e.entitlementId === f.entitlementId)) out.push('The chosen entitlement is not an approved, in-term record that grants manual ingestion and storage for this benchmark.');
    } else {
      for (const k of keys) {
        const gate = entitlementGate(rowFor(ctx, k), ctx.asOfDate);
        if (!gate.ok) out.push(`${rowFor(ctx, k)?.catalogue.label ?? k}: ${gate.message}`);
      }
    }
    return out;
  }
  // step 3
  if (!ctx.caps.upload) out.push('You do not have the upload permission, so you cannot stage a file.');
  const fp = fileProblem(ctx.file, ctx.maxBytes);
  if (fp) out.push(fp);
  if (!f.dateFormat) out.push('Choose the date format used in the file. It is never guessed, because 03/04/2024 can mean two different days.');
  if (!f.numberLocale) out.push('Choose how numbers are written in the file (for example 12,345.67 or 12.345,67).');
  const kind = ctx.file ? fileKindFromName(ctx.file.name) : null;
  if (kind === 'csv' && (f.dateFormat === 'excel_1900' || f.dateFormat === 'excel_1904')) out.push('Excel date numbers only apply to .xlsx files. Choose the written date format used in the CSV.');
  const sheet = xlsxSheetRule(kind, ctx.inspect, f.sheetName);
  if (!sheet.ok && sheet.message) out.push(sheet.message);
  const hr = Number(f.headerRow);
  if (!Number.isInteger(hr) || hr < 1 || hr > 1000) out.push('The header row must be a whole number from 1 to 1000.');
  out.push(...columnMappingIssues(f));
  return out;
}

export function stepComplete(step: StepNumber, ctx: UploadContext): boolean {
  return stepIssues(step, ctx).length === 0;
}

/** May the operator be on `target`? Every earlier step must be complete. Step 4 (preview) exists only once a staged job exists. */
export function canEnterStep(target: 1 | 2 | 3 | 4 | 5, ctx: UploadContext, hasStagedPreview: boolean): boolean {
  if (target === 1) return true;
  if (target === 2) return stepComplete(1, ctx);
  if (target === 3) return stepComplete(1, ctx) && stepComplete(2, ctx);
  return hasStagedPreview;
}

export function canStage(ctx: UploadContext): { ok: boolean; reasons: string[] } {
  const reasons = [...stepIssues(1, ctx), ...stepIssues(2, ctx), ...stepIssues(3, ctx)];
  return { ok: reasons.length === 0, reasons };
}

/** Builds the exact request params. Returns reasons instead of a body when anything is incomplete: nothing is guessed. */
export function buildStageParams(ctx: UploadContext): { ok: true; params: StageUploadRequestParams } | { ok: false; reasons: string[] } {
  const gate = canStage(ctx);
  if (!gate.ok) return { ok: false, reasons: gate.reasons };
  const f = ctx.form;
  const keys = involvedBenchmarkKeys(f);
  const kind = ctx.file ? fileKindFromName(ctx.file.name) : null;
  const params: StageUploadRequestParams = {
    shape: f.shape as ShapeId,
    mode: f.mode,
    returnVariant: f.returnVariant as VariantId,
    currencyCode: f.currencyCode.trim().toUpperCase(),
    historyClass: f.historyClass as HistoryClassId,
    dateFormat: f.dateFormat as DateFormatId,
    numberLocale: f.numberLocale as NumberLocaleId,
    sourceOwner: f.sourceOwner.trim(),
    sourceReference: f.sourceReference.trim(),
    originalFileName: ctx.file?.name,
    dataAsOf: bodyDate(f.dataAsOf),
    reason: f.mode === 'correction' ? f.reason.trim() : null,
    headerRow: Number(f.headerRow),
  };
  if (keys.length === 1 && f.benchmarkKey) params.benchmarkKey = f.benchmarkKey;
  else if (f.shape === 'single') params.benchmarkKey = f.benchmarkKey;
  if (f.shape === 'provider_export') {
    if (f.columnChoice === 'layout') params.providerLayoutId = f.providerLayoutId;
    else {
      params.columnMap = { date: f.dateColumn.trim(), value: f.valueColumn.trim() };
      if (f.indexNameColumn.trim()) params.columnMap.indexName = f.indexNameColumn.trim();
    }
    const mapped = f.indexNameMap.filter((m) => m.indexName.trim() && m.benchmarkKey);
    if (mapped.length > 0) {
      params.indexNameToKey = Object.fromEntries(mapped.map((m) => [m.indexName.trim(), m.benchmarkKey]));
      delete params.benchmarkKey;
    }
  }
  if (kind === 'xlsx') {
    params.sheetName = f.sheetName;
    params.includeHiddenRows = f.includeHiddenRows;
  }
  if (keys.length === 1 && f.entitlementId) params.entitlementIds = { [keys[0]]: f.entitlementId };
  else if (keys.length > 1) {
    const ids: Record<string, string> = {};
    for (const k of keys) {
      const only = eligibleEntitlements(rowFor(ctx, k), ctx.asOfDate);
      if (only.length === 1) ids[k] = only[0].entitlementId;
    }
    if (Object.keys(ids).length > 0) params.entitlementIds = ids;
  }
  return { ok: true, params };
}

// ----------------------------------------------------------- preview / publish ---

/** Narrow runtime guard for a stored preview (ImportJobDetail.preview is `unknown`). A malformed preview is never trusted. */
export function asJobPreview(x: unknown): JobPreview | null {
  if (!x || typeof x !== 'object') return null;
  const p = x as Record<string, unknown>;
  const obj = (k: string) => p[k] !== null && typeof p[k] === 'object';
  if (typeof p.fileSha256 !== 'string' || typeof p.stagingDigest !== 'string') return null;
  if (!obj('mutation') || !obj('counts') || !Array.isArray(p.scope) || !Array.isArray(p.requiredAcknowledgements) || !Array.isArray(p.blockers) || !Array.isArray(p.issues)) return null;
  if (typeof p.hardErrorCount !== 'number') return null;
  return x as JobPreview;
}

export interface PublishInputs {
  caps: BenchmarkCapabilityFlags;
  mode: string;
  hardErrorCount: number;
  blockers: readonly string[];
  /** Server's per-benchmark eligibility roll-up. */
  eligible: boolean | null;
  requiredAcks: readonly string[];
  acknowledged: readonly string[];
  stagedByMe: boolean;
  selfPublishAck: boolean;
  /** False when no validated preview/staged job exists. */
  hasValidatedPreview: boolean;
}

export interface PublishDecision {
  /** Is the Publish control rendered at all (capability)? */
  visible: boolean;
  /** Is it clickable? Never true while any reason remains. */
  enabled: boolean;
  reasons: string[];
}

export const NOT_A_PUBLISHER_NOTICE = 'You can stage and review this upload; a user with the publish permission must publish it.';
export const NOT_A_CORRECTOR_NOTICE = 'You can stage and review this correction; a user with the correction permission must publish it.';

export function missingAcks(required: readonly string[], acknowledged: readonly string[]): string[] {
  return required.filter((a) => !acknowledged.includes(a));
}

export function publishDecision(i: PublishInputs): PublishDecision {
  if (!publishCapabilityFor(i.mode, i.caps)) {
    return { visible: false, enabled: false, reasons: [i.mode === 'correction' ? NOT_A_CORRECTOR_NOTICE : NOT_A_PUBLISHER_NOTICE] };
  }
  const reasons: string[] = [];
  if (!i.hasValidatedPreview) reasons.push('There is no validated preview to publish.');
  if (i.hardErrorCount > 0) reasons.push(`${formatCount(i.hardErrorCount)} hard validation error(s) remain. Nothing can be published until the file is corrected and uploaded again; there is no partial publication.`);
  for (const b of i.blockers) reasons.push(b);
  if (i.eligible === false) reasons.push('At least one benchmark has no approved entitlement that permits this publication.');
  const missing = missingAcks(i.requiredAcks, i.acknowledged);
  for (const m of missing) reasons.push(`Required confirmation not ticked: ${ackInfo(m).label}.`);
  if (i.stagedByMe && !i.selfPublishAck) reasons.push('You staged this upload yourself. Tick the self-publication confirmation to publish your own upload.');
  return { visible: true, enabled: reasons.length === 0, reasons };
}

export function buildPublishBody(source: { fileSha256: string; stagingDigest: string; mutation: { new: number; revive: number; identical: number; correction: number } }, acknowledged: readonly string[], requiredAcks: readonly string[], selfPublishAck: boolean, stagedByMe: boolean): PublishRequestBody {
  const body: PublishRequestBody = {
    expectedSha256: source.fileSha256,
    expectedDigest: source.stagingDigest,
    // The server compares "new" with rows_new + rows_revive (revived rows are new levels for a date that was retracted).
    expectedCounts: { new: source.mutation.new + source.mutation.revive, identical: source.mutation.identical, correction: source.mutation.correction },
    acknowledged: requiredAcks.filter((a) => acknowledged.includes(a)),
  };
  if (stagedByMe) body.selfPublishAck = selfPublishAck === true;
  return body;
}

/** A stored job's mutation counts, from the summary (no preview needed to build counts). */
export function mutationFromJob(job: Pick<ImportJobSummary, 'rowsNew' | 'rowsRevive' | 'rowsIdentical' | 'rowsCorrection'>): { new: number; revive: number; identical: number; correction: number } {
  return { new: job.rowsNew, revive: job.rowsRevive, identical: job.rowsIdentical, correction: job.rowsCorrection };
}

export function publishConfirmText(counts: { new: number; revive: number; identical: number; correction: number }, benchmarks: readonly string[], mode: string): string {
  const names = benchmarks.length > 0 ? benchmarks.join(', ') : 'the selected benchmark';
  const parts = [`${formatCount(counts.new + counts.revive)} new level(s)`, `${formatCount(counts.correction)} correction(s)`, `${formatCount(counts.identical)} identical level(s) skipped`];
  return `Publish ${mode === 'correction' ? 'this correction' : 'this history'} for ${names}: ${parts.join(', ')}. Publication is all or nothing and every change is recorded in the audit history.`;
}

// ------------------------------------------------------ job-row actions ---

export interface JobActions {
  canPublishVisible: boolean;
  canCancel: boolean;
  canRollback: boolean;
  canDownloadErrors: boolean;
  publishNotice: string;
}

export function jobActions(job: Pick<ImportJobSummary, 'status' | 'mode' | 'stagedByMe' | 'hardErrorTotal' | 'warningCount' | 'rolledBackAt'>, caps: BenchmarkCapabilityFlags): JobActions {
  const validated = job.status === 'validated';
  const publisher = publishCapabilityFor(job.mode, caps);
  return {
    canPublishVisible: validated && publisher,
    publishNotice: validated && !publisher ? (job.mode === 'correction' ? NOT_A_CORRECTOR_NOTICE : NOT_A_PUBLISHER_NOTICE) : '',
    // The database allows cancel for the staging admin, a publisher or a corrector.
    canCancel: ['staging', 'validated', 'failed', 'stale'].includes(job.status) && ((job.stagedByMe && caps.upload === true) || caps.publish === true || caps.correct === true),
    canRollback: job.status === 'published' && job.rolledBackAt === null && caps.correct === true,
    canDownloadErrors: caps.view === true && job.hardErrorTotal + job.warningCount > 0,
  };
}

export const ROLLBACK_EXPLAINER =
  'Rolling back restores the previous levels for dates this import corrected, and retracts the dates it added. Nothing is deleted: the full history, including this import, stays on record.';

// ---------------------------------------------------- response -> message ---

export interface ApiFailure {
  kind: 'unauthenticated' | 'forbidden' | 'not_found' | 'too_large' | 'invalid' | 'stale' | 'duplicate' | 'conflict' | 'unavailable' | 'error';
  message: string;
  /** True when the right next step is "upload the file again". */
  restart: boolean;
  retryable: boolean;
}

function serverText(body: unknown): string | null {
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>).error : null;
  return isSafeServerMessage(raw) ? raw : null;
}
function serverCode(body: unknown): string {
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>).code : null;
  return typeof raw === 'string' ? raw.toLowerCase() : '';
}

/** HTTP status (+ optional {error, code}) -> one plain sentence. Raw engine text is never shown (isSafeServerMessage). */
export function describeApiFailure(status: number, body: unknown, action: string): ApiFailure {
  const text = serverText(body);
  const code = serverCode(body);
  if (status === 401) return { kind: 'unauthenticated', message: 'Your session has ended. Sign in again, then repeat this.', restart: false, retryable: false };
  if (status === 403) return { kind: 'forbidden', message: text ?? `You do not have permission to ${action}. The server checks this on every request; ask an administrator who manages roles if you need it.`, restart: false, retryable: false };
  if (status === 404) return { kind: 'not_found', message: text ?? 'That item no longer exists. Reload the page to see the current list.', restart: false, retryable: false };
  if (status === 413) return { kind: 'too_large', message: text ?? 'The file is larger than the upload limit.', restart: false, retryable: false };
  if (status === 409) {
    if (code === '40001' || code === 'stale' || /stale|differs|out of date|changed after/i.test(text ?? '')) {
      return { kind: 'stale', message: 'The preview is out of date - upload the file again. Another import or change altered the stored levels, or the staged data changed, after you previewed it. Nothing was published.', restart: true, retryable: false };
    }
    if (code === '23505' || code === 'duplicate' || /already (been )?published|duplicate/i.test(text ?? '')) {
      return { kind: 'duplicate', message: text ?? 'This exact file was already published. Publishing it again would duplicate the import, so nothing was changed.', restart: false, retryable: false };
    }
    return { kind: 'conflict', message: text ?? 'This changed somewhere else, or the job is no longer in a state that allows this. Reload and check its current status.', restart: true, retryable: false };
  }
  if (status === 422 || status === 400) return { kind: 'invalid', message: text ?? 'Some of the submitted details are not valid. Correct them and try again. Nothing was changed.', restart: false, retryable: false };
  if (status === 503 || status === 502 || status === 504) return { kind: 'unavailable', message: text ?? 'The benchmark data service is unavailable right now. Nothing was changed. Try again shortly.', restart: false, retryable: true };
  return { kind: 'error', message: text ?? `Could not ${action}. Nothing was changed. Try again; if it keeps happening, report it with the time you saw it.`, restart: false, retryable: true };
}

export function describePublishSuccess(r: PublishResponse): { headline: string; lines: string[] } {
  const x = r.result;
  const lines = [
    `Levels written: ${formatCount(x.inserted)} new, ${formatCount(x.revived)} revived, ${formatCount(x.corrected)} corrected; ${formatCount(x.identicalSkipped)} identical skipped.`,
    `Date range: ${formatDate(x.dateFrom)} to ${formatDate(x.dateTo)}.`,
    `Batch reference: ${x.batchId}.`,
  ];
  if (r.alreadyPublished) return { headline: 'Already published. Nothing was written this time; this is the result of the earlier publication.', lines };
  return { headline: 'Published.', lines };
}

export function describeStageRejection(stage: string, problems: ReadonlyArray<{ code: string; message: string; rowNumber?: number }>): string {
  const where = stage === 'sheet' ? 'The sheet could not be used' : stage === 'layout' ? 'The columns could not be matched' : stage === 'parameters' ? 'Some details are missing or invalid' : stage === 'persist' ? 'The checked file could not be saved' : 'The file could not be read';
  const first = problems.slice(0, 3).map((p) => (p.rowNumber ? `Row ${p.rowNumber}: ${p.message}` : p.message));
  return `${where}. Nothing was staged or published. ${first.join(' ')}`.trim();
}

/** Server inspect answer -> state, tolerant of an absent/odd body (never trusted for control flow beyond display). */
export function toInspectState(body: unknown): InspectState | null {
  const b = body && typeof body === 'object' ? ((body as Record<string, unknown>).data ?? body) : null;
  if (!b || typeof b !== 'object') return null;
  const r = b as Record<string, unknown>;
  const kind = r.kind === 'csv' || r.kind === 'xlsx' ? r.kind : null;
  const sheets = Array.isArray(r.sheets)
    ? (r.sheets as unknown[]).flatMap((s) => {
        if (!s || typeof s !== 'object') return [];
        const o = s as Record<string, unknown>;
        if (typeof o.name !== 'string') return [];
        const state = o.state === 'hidden' || o.state === 'veryHidden' ? o.state : 'visible';
        return [{ name: o.name, index: typeof o.index === 'number' ? o.index : 0, state, rowCount: typeof o.rowCount === 'number' ? o.rowCount : null } as SheetOption];
      })
    : [];
  const problems = Array.isArray(r.problems)
    ? (r.problems as unknown[]).flatMap((p) => {
        if (!p || typeof p !== 'object') return [];
        const o = p as Record<string, unknown>;
        return typeof o.message === 'string' ? [{ code: typeof o.code === 'string' ? o.code : 'PROBLEM', message: o.message, rowNumber: typeof o.rowNumber === 'number' ? o.rowNumber : undefined }] : [];
      })
    : [];
  const header = Array.isArray(r.header) ? (r.header as unknown[]).filter((h): h is string => typeof h === 'string') : undefined;
  return { kind, sheets, problems, fileSha256: typeof r.fileSha256 === 'string' ? r.fileSha256 : '', bytes: typeof r.bytes === 'number' ? r.bytes : 0, header };
}

/** A list payload that may be an array, or an object holding the array. */
export function asArray<T>(data: unknown, ...keys: string[]): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    for (const k of keys) {
      const v = (data as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as T[];
    }
  }
  return [];
}

// ---------------------------------------------------- catalogue form ---

export interface CatalogueFormState {
  benchmarkKey: string;
  label: string;
  officialName: string;
  ownerName: string;
  officialIdentifier: string;
  assetClass: string;
  countryCode: string;
  currencyCode: string;
  returnType: string;
  returnVariant: VariantId | '';
  baseDate: string;
  baseValue: string;
  launchDate: string;
  historyStartDate: string;
  historyClass: HistoryClassId;
  backtestedThrough: string;
  calendarCode: string;
  methodologyUrl: string;
  sourceUrl: string;
  evidenceRef: string;
  evidenceRetrievedAt: string;
}

export function emptyCatalogueForm(): CatalogueFormState {
  return {
    benchmarkKey: '', label: '', officialName: '', ownerName: '', officialIdentifier: '', assetClass: '', countryCode: '', currencyCode: '', returnType: '', returnVariant: '', baseDate: '', baseValue: '', launchDate: '', historyStartDate: '', historyClass: 'unknown', backtestedThrough: '', calendarCode: '', methodologyUrl: '', sourceUrl: '', evidenceRef: '', evidenceRetrievedAt: '',
  };
}

export function catalogueFormFromRow(r: CatalogueRowView): CatalogueFormState {
  return {
    benchmarkKey: r.benchmarkKey,
    label: r.label,
    officialName: r.officialName ?? '',
    ownerName: r.ownerName ?? '',
    officialIdentifier: r.officialIdentifier ?? '',
    assetClass: r.assetClass ?? '',
    countryCode: r.countryCode ?? '',
    currencyCode: r.currencyCode ?? '',
    returnType: r.returnType ?? '',
    returnVariant: r.returnVariant ?? '',
    baseDate: formatDateInput(r.baseDate),
    baseValue: '',
    launchDate: formatDateInput(r.launchDate),
    historyStartDate: formatDateInput(r.historyStartDate),
    historyClass: r.historyClass,
    backtestedThrough: formatDateInput(r.backtestedThrough),
    calendarCode: '',
    methodologyUrl: r.methodologyUrl ?? '',
    sourceUrl: r.sourceUrl ?? '',
    evidenceRef: r.evidenceRef ?? '',
    evidenceRetrievedAt: formatDateInput(r.evidenceRetrievedAt),
  };
}

export const BENCHMARK_KEY_PATTERN = /^[A-Z0-9_]{3,64}$/;

/** A TRI is the total_return variant and a PRI is the price variant; other types may carry any variant (net TRI uses "Other"). */
export function returnTypeVariantMismatch(returnType: string, variant: string): string | null {
  if (returnType === 'TRI' && variant && variant !== 'total_return') return 'A TRI benchmark must use the "Total return" variant. For a net total return series choose the return type "Other".';
  if (returnType === 'PRI' && variant && variant !== 'price') return 'A PRI benchmark must use the "Price" variant.';
  return null;
}

/** Fields the database keeps frozen once a catalogue entry is verified. */
export function lockedWhenVerified(): ReadonlyArray<keyof CatalogueFormState> {
  return ['benchmarkKey', 'returnType', 'returnVariant', 'currencyCode', 'countryCode'];
}

export function validateCatalogueForm(f: CatalogueFormState): Record<string, string> {
  const e: Record<string, string> = {};
  if (!BENCHMARK_KEY_PATTERN.test(f.benchmarkKey)) e.benchmarkKey = 'The key must be 3 to 64 characters: capital letters A-Z, digits 0-9 and underscores only.';
  if (f.officialName.trim().length < 2) e.officialName = 'Enter the exact official name.';
  if (f.ownerName.trim().length < 2) e.ownerName = 'Enter the index owner.';
  if (f.officialIdentifier.trim().length > 100) e.officialIdentifier = 'The official identifier can be at most 100 characters.';
  if (!ASSET_CLASS_OPTIONS.some((o) => o.value === f.assetClass)) e.assetClass = 'Choose the asset class.';
  if (!/^[A-Za-z]{2}$/.test(f.countryCode.trim())) e.countryCode = 'Enter the two-letter country code, such as IN.';
  if (!isValidCurrency(f.currencyCode)) e.currencyCode = 'Enter the three-letter currency code, such as INR.';
  if (!RETURN_TYPE_OPTIONS.some((o) => o.value === f.returnType)) e.returnType = 'Choose the return type.';
  if (!f.returnVariant) e.returnVariant = 'Choose the exact variant: price, total return or net total return.';
  const mm = returnTypeVariantMismatch(f.returnType, f.returnVariant);
  if (mm) e.returnVariant = mm;
  for (const k of ['baseDate', 'launchDate', 'historyStartDate', 'backtestedThrough', 'evidenceRetrievedAt'] as const) {
    if (f[k].trim() && typedDateToIso(f[k]) === null) e[k] = `Use a valid date, ${DATE_TYPING_HELP}.`;
  }
  if (f.baseValue.trim() && !(Number.isFinite(Number(f.baseValue)) && Number(f.baseValue) > 0)) e.baseValue = 'The base value must be a positive number.';
  if ((f.historyClass === 'backtested' || f.historyClass === 'mixed') && !f.backtestedThrough.trim()) e.backtestedThrough = 'Say up to which date the history is backtested.';
  for (const k of ['methodologyUrl', 'sourceUrl'] as const) {
    if (f[k].trim() && !isHttpUrl(f[k])) e[k] = 'Enter a full web address starting with https://';
  }
  if (f.evidenceRef.trim().length < 5) e.evidenceRef = 'Say where the facts above come from (a document title or reference).';
  if (!f.evidenceRetrievedAt.trim()) e.evidenceRetrievedAt = 'Enter the date you retrieved the evidence.';
  return e;
}

export function buildCatalogueBody(f: CatalogueFormState): Record<string, string | number | null> {
  const t = (v: string) => (v.trim() === '' ? null : v.trim());
  return {
    benchmark_key: f.benchmarkKey.trim(),
    benchmark_label: f.label.trim() || f.officialName.trim(),
    official_name: f.officialName.trim(),
    owner_name: f.ownerName.trim(),
    official_identifier: t(f.officialIdentifier),
    asset_class: f.assetClass,
    country_code: t(f.countryCode.toUpperCase()),
    currency_code: f.currencyCode.trim().toUpperCase(),
    return_type: f.returnType,
    return_variant: f.returnVariant,
    base_date: bodyDate(f.baseDate),
    base_value: f.baseValue.trim() === '' ? null : Number(f.baseValue),
    launch_date: bodyDate(f.launchDate),
    history_start_date: bodyDate(f.historyStartDate),
    history_class: f.historyClass,
    backtested_through: bodyDate(f.backtestedThrough),
    calendar_code: t(f.calendarCode),
    methodology_url: t(f.methodologyUrl),
    source_url: t(f.sourceUrl),
    evidence_ref: f.evidenceRef.trim(),
    evidence_retrieved_at: bodyDate(f.evidenceRetrievedAt),
  };
}

export const MIN_NOTE = 10;
export const MIN_CORRECTION_REASON = 20;
export const MIN_APPROVAL_NOTE = 5;

export function noteProblem(v: string, min: number, what: string): string | null {
  return v.trim().length >= min ? null : `${what} must be at least ${min} characters.`;
}

export function canVerifyCatalogue(row: Pick<CatalogueRowView, 'catalogueStatus'>, caps: BenchmarkCapabilityFlags): boolean {
  return caps.catalogue === true && row.catalogueStatus === 'draft';
}

// -------------------------------------------------- entitlement form ---

export interface EntitlementFormState {
  benchmarkKey: string;
  kind: EntitlementRightsView['kind'] | '';
  rights: EntitlementRightsView['rights'];
  validFrom: string;
  validTo: string;
  dataFrom: string;
  dataTo: string;
  postExpiryStorage: EntitlementRightsView['postExpiryStorage'];
  postExpiryCalculation: boolean;
  postExpiryDisplay: boolean;
  evidenceReference: string;
  evidenceUrl: string;
  evidenceDocumentDate: string;
  evidenceRetrievedAt: string;
  attributionText: string;
  notes: string;
}

export function emptyEntitlementForm(): EntitlementFormState {
  return {
    benchmarkKey: '', kind: '',
    rights: { ingestManual: false, automation: false, storage: false, calculation: false, customerDisplay: false, reportExport: false },
    validFrom: '', validTo: '', dataFrom: '', dataTo: '', postExpiryStorage: 'unknown', postExpiryCalculation: false, postExpiryDisplay: false,
    evidenceReference: '', evidenceUrl: '', evidenceDocumentDate: '', evidenceRetrievedAt: '', attributionText: '', notes: '',
  };
}

export function validateEntitlementForm(f: EntitlementFormState): Record<string, string> {
  const e: Record<string, string> = {};
  if (!f.benchmarkKey) e.benchmarkKey = 'Choose the benchmark.';
  if (!f.kind) e.kind = 'Choose the kind of permission.';
  const r = f.rights;
  if (!Object.values(r).some(Boolean)) e.rights = 'Tick at least one right. A record that grants nothing has no purpose.';
  else if (r.calculation && !r.storage) e.rights = 'Calculation needs the storage right as well.';
  else if (r.customerDisplay && !r.calculation) e.rights = 'Customer display needs the calculation right as well.';
  else if (r.reportExport && !r.customerDisplay) e.rights = 'Report and export needs the customer display right as well.';
  else if (r.automation && !r.storage) e.rights = 'Automated ingestion needs the storage right as well.';
  const validFromIso = typedDateToIso(f.validFrom);
  if (validFromIso === null) e.validFrom = `Enter the date the permission starts (${DATE_TYPING_HELP}).`;
  if (f.validTo.trim()) {
    const validToIso = typedDateToIso(f.validTo);
    if (validToIso === null) e.validTo = `Use a valid date (${DATE_TYPING_HELP}), or leave empty if it has no end date.`;
    else if (validFromIso !== null && validToIso < validFromIso) e.validTo = 'The end date cannot be before the start date.';
  }
  for (const k of ['dataFrom', 'dataTo'] as const) if (f[k].trim() && typedDateToIso(f[k]) === null) e[k] = `Use a valid date (${DATE_TYPING_HELP}), or leave empty for no limit.`;
  if (!e.dataFrom && !e.dataTo && f.dataFrom.trim() && f.dataTo.trim() && (typedDateToIso(f.dataTo) as string) < (typedDateToIso(f.dataFrom) as string)) e.dataTo = 'The last data date cannot be before the first.';
  if (f.evidenceReference.trim().length < 5) e.evidenceReference = 'Give a document title or reference that supports this permission.';
  if (f.evidenceUrl.trim() && !isHttpUrl(f.evidenceUrl)) e.evidenceUrl = 'Enter a full web address starting with https://';
  if (f.kind === 'public_use_permission') {
    if (!f.evidenceUrl.trim()) e.evidenceUrl = 'A public-use permission needs the web address of the document that grants it.';
    if (typedDateToIso(f.evidenceDocumentDate) === null) e.evidenceDocumentDate = `A public-use permission needs the date of that document (${DATE_TYPING_HELP}).`;
    if (typedDateToIso(f.evidenceRetrievedAt) === null) e.evidenceRetrievedAt = `A public-use permission needs the date you retrieved that document (${DATE_TYPING_HELP}).`;
  } else {
    for (const k of ['evidenceDocumentDate', 'evidenceRetrievedAt'] as const) if (f[k].trim() && typedDateToIso(f[k]) === null) e[k] = `Use a valid date (${DATE_TYPING_HELP}), or leave empty.`;
  }
  return e;
}

export function buildEntitlementBody(f: EntitlementFormState, row: Pick<CatalogueRowView, 'id' | 'returnVariant' | 'currencyCode'>): Record<string, unknown> {
  const t = (v: string) => (v.trim() === '' ? null : v.trim());
  return {
    benchmark_id: row.id,
    entitlement_kind: f.kind,
    return_variant: row.returnVariant,
    currency_code: row.currencyCode,
    allow_manual_ingest: f.rights.ingestManual,
    allow_automation: f.rights.automation,
    allow_storage: f.rights.storage,
    allow_calculation: f.rights.calculation,
    allow_customer_display: f.rights.customerDisplay,
    allow_report_export: f.rights.reportExport,
    data_from: bodyDate(f.dataFrom),
    data_to: bodyDate(f.dataTo),
    valid_from: typedDateToIso(f.validFrom) ?? f.validFrom.trim(),
    valid_to: bodyDate(f.validTo),
    post_expiry_storage: f.postExpiryStorage,
    post_expiry_calculation: f.postExpiryCalculation,
    post_expiry_display: f.postExpiryDisplay,
    evidence_reference: f.evidenceReference.trim(),
    evidence_url: t(f.evidenceUrl),
    evidence_document_date: bodyDate(f.evidenceDocumentDate),
    evidence_retrieved_at: bodyDate(f.evidenceRetrievedAt),
    attribution_text: t(f.attributionText),
    notes: t(f.notes),
  };
}

export interface EntitlementActions {
  canApprove: boolean;
  needsSelfApprovalAck: boolean;
  canRevoke: boolean;
}

export function entitlementActions(e: Pick<EntitlementRightsView, 'status' | 'proposedByMe'>, caps: BenchmarkCapabilityFlags): EntitlementActions {
  return {
    canApprove: caps.entitlementApprove === true && e.status === 'draft',
    needsSelfApprovalAck: e.proposedByMe === true,
    canRevoke: caps.entitlementApprove === true && e.status !== 'revoked',
  };
}

export function canApproveEntitlementNow(a: { note: string; proposedByMe: boolean; selfApprovalAck: boolean }): { ok: boolean; reason: string } {
  const n = noteProblem(a.note, MIN_APPROVAL_NOTE, 'The approval note');
  if (n) return { ok: false, reason: n };
  if (a.proposedByMe && !a.selfApprovalAck) return { ok: false, reason: 'You proposed this record yourself. Tick the self-approval confirmation to approve your own proposal.' };
  return { ok: true, reason: '' };
}

// -------------------------------------------------------- mapping form ---

export interface MappingFormState {
  instrumentId: string;
  benchmarkKey: string;
  proposedBenchmarkName: string;
  relationshipType: 'primary' | 'secondary' | 'category_average';
  effectiveFrom: string;
  effectiveTo: string;
  evidenceSource: string;
  evidenceUrl: string;
  evidenceTitle: string;
  evidenceDocumentDate: string;
  evidenceRetrievedAt: string;
  evidenceExcerpt: string;
  resolutionMethod: string;
  confidence: string;
  ambiguityReason: string;
}

export function emptyMappingForm(): MappingFormState {
  return { instrumentId: '', benchmarkKey: '', proposedBenchmarkName: '', relationshipType: 'primary', effectiveFrom: '', effectiveTo: '', evidenceSource: '', evidenceUrl: '', evidenceTitle: '', evidenceDocumentDate: '', evidenceRetrievedAt: '', evidenceExcerpt: '', resolutionMethod: '', confidence: '', ambiguityReason: '' };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateMappingForm(f: MappingFormState): Record<string, string> {
  const e: Record<string, string> = {};
  if (!UUID_RE.test(f.instrumentId.trim())) e.instrumentId = 'Enter the instrument id (a UUID, as shown in the instrument record).';
  if (f.proposedBenchmarkName.trim().length < 3) e.proposedBenchmarkName = 'Enter the benchmark name exactly as the scheme document states it.';
  const effectiveFromIso = typedDateToIso(f.effectiveFrom);
  if (effectiveFromIso === null) e.effectiveFrom = `Enter the date the benchmark became effective (${DATE_TYPING_HELP}).`;
  if (f.effectiveTo.trim()) {
    const effectiveToIso = typedDateToIso(f.effectiveTo);
    if (effectiveToIso === null) e.effectiveTo = `Use a valid date (${DATE_TYPING_HELP}), or leave empty if still in force.`;
    else if (effectiveFromIso !== null && effectiveToIso < effectiveFromIso) e.effectiveTo = 'The end date cannot be before the start date.';
  }
  if (!EVIDENCE_SOURCE_OPTIONS.some((o) => o.value === f.evidenceSource)) e.evidenceSource = 'Choose the type of document.';
  if (!isHttpUrl(f.evidenceUrl)) e.evidenceUrl = 'Enter the full web address of the document, starting with https://';
  if (typedDateToIso(f.evidenceDocumentDate) === null) e.evidenceDocumentDate = `Enter the date of the document (${DATE_TYPING_HELP}).`;
  if (typedDateToIso(f.evidenceRetrievedAt) === null) e.evidenceRetrievedAt = `Enter the date you retrieved the document (${DATE_TYPING_HELP}).`;
  if (f.evidenceExcerpt.length > 400) e.evidenceExcerpt = 'The excerpt can be at most 400 characters.';
  if (!RESOLUTION_METHOD_OPTIONS.some((o) => o.value === f.resolutionMethod)) e.resolutionMethod = 'Choose how the benchmark was identified.';
  if (!CONFIDENCE_OPTIONS.some((o) => o.value === f.confidence)) e.confidence = 'Choose the confidence.';
  return e;
}

export function buildMappingBody(f: MappingFormState, benchmarkId: string | null): Record<string, string | null> {
  const t = (v: string) => (v.trim() === '' ? null : v.trim());
  return {
    instrument_id: f.instrumentId.trim(),
    benchmark_id: benchmarkId,
    proposed_benchmark_name: f.proposedBenchmarkName.trim(),
    relationship_type: f.relationshipType,
    effective_from: typedDateToIso(f.effectiveFrom) ?? f.effectiveFrom.trim(),
    effective_to: bodyDate(f.effectiveTo),
    evidence_source: f.evidenceSource,
    evidence_url: f.evidenceUrl.trim(),
    evidence_title: t(f.evidenceTitle),
    evidence_document_date: typedDateToIso(f.evidenceDocumentDate) ?? f.evidenceDocumentDate.trim(),
    evidence_retrieved_at: typedDateToIso(f.evidenceRetrievedAt) ?? f.evidenceRetrievedAt.trim(),
    evidence_excerpt: t(f.evidenceExcerpt),
    resolution_method: f.resolutionMethod,
    confidence: f.confidence,
    ambiguity_reason: t(f.ambiguityReason),
  };
}

export function canReviewMapping(p: { status: string }, caps: BenchmarkCapabilityFlags): boolean {
  return caps.catalogue === true && p.status === 'proposed';
}

export function reviewProblem(note: string): string | null {
  return noteProblem(note, MIN_NOTE, 'The review note');
}

/** Evidence links open in a new tab ONLY for http(s) addresses; anything else is shown as text. */
export function safeExternalUrl(u: string | null | undefined): string | null {
  return u && isHttpUrl(u) ? u.trim() : null;
}

// ------------------------------------------------------- ingestion form ---

export interface IngestionFormState {
  mode: 'disabled' | 'manual_import' | 'automated';
  sourceKey: string;
  adapterId: string;
  automationEnabled: boolean;
  publicationLagDays: string;
  reason: string;
}

export function ingestionFormFromRow(row: BenchmarkOverviewRow): IngestionFormState {
  const i = row.ingestion;
  return {
    mode: i?.mode ?? 'manual_import',
    sourceKey: '',
    adapterId: i?.adapterId ?? '',
    automationEnabled: i?.automationEnabled ?? false,
    publicationLagDays: String(i?.publicationLagDays ?? 1),
    reason: '',
  };
}

export const AUTOMATION_CONDITIONS =
  'Automation additionally needs ALL of these: an approved entitlement that grants the automation right, the environment flag, the global ingestion switch and the write switch. If any is missing the server refuses, and the benchmark stays on manual import.';

export function validateIngestionForm(f: IngestionFormState): Record<string, string> {
  const e: Record<string, string> = {};
  if (f.reason.trim().length < MIN_NOTE) e.reason = `The reason must be at least ${MIN_NOTE} characters.`;
  const lag = Number(f.publicationLagDays);
  if (!Number.isInteger(lag) || lag < 0 || lag > 30) e.publicationLagDays = 'The publication lag must be a whole number of days from 0 to 30.';
  if (f.automationEnabled && f.mode !== 'automated') e.automationEnabled = 'Automation can only be switched on when the mode is Automated.';
  if (f.mode === 'automated' && !f.adapterId.trim()) e.adapterId = 'Name the adapter that fetches this benchmark.';
  return e;
}

export function buildIngestionBody(f: IngestionFormState): Record<string, unknown> {
  const body: Record<string, unknown> = {
    mode: f.mode,
    automationEnabled: f.automationEnabled,
    publicationLagDays: Number(f.publicationLagDays),
    reason: f.reason.trim(),
  };
  if (f.sourceKey.trim()) body.sourceKey = f.sourceKey.trim();
  if (f.adapterId.trim()) body.adapterId = f.adapterId.trim();
  return body;
}

// ------------------------------------------------------------ overview ---

export function overviewIsUnavailable(o: { state: string } | null | undefined): boolean {
  return !!o && o.state !== 'ok';
}

export const TAB_IDS = ['overview', 'upload', 'jobs', 'catalogue', 'entitlements', 'mappings', 'ingestion'] as const;
export type TabId = (typeof TAB_IDS)[number];
export const TAB_LABELS: Readonly<Record<TabId, string>> = {
  overview: 'Overview',
  upload: 'Upload',
  jobs: 'Jobs',
  catalogue: 'Catalogue',
  entitlements: 'Entitlements',
  mappings: 'Mappings',
  ingestion: 'Ingestion',
};

/** Roving-tabindex keyboard handling for the ARIA tab pattern. */
export function nextTab(current: TabId, key: string): TabId | null {
  const i = TAB_IDS.indexOf(current);
  if (key === 'ArrowRight') return TAB_IDS[(i + 1) % TAB_IDS.length];
  if (key === 'ArrowLeft') return TAB_IDS[(i - 1 + TAB_IDS.length) % TAB_IDS.length];
  if (key === 'Home') return TAB_IDS[0];
  if (key === 'End') return TAB_IDS[TAB_IDS.length - 1];
  return null;
}


// ---------------------------------------------------------------------------
// Opened-panel reveal (scroll into view + keyboard focus). A panel that opens
// below the fold or after a long list must not look like "nothing happened".
// Pure decisions only; the component performs the scroll/focus.
// ---------------------------------------------------------------------------

/** Which action panel is open: null, 'propose', 'approve:<id>' or 'revoke:<id>' (each id is the entitlement's own). */
export type OpenPanelKey = string | null;

export function entitlementPanelKeys(form: unknown | null, action: { kind: 'approve' | 'revoke'; e: { entitlementId: string } } | null): { propose: OpenPanelKey; action: OpenPanelKey } {
  return { propose: form ? 'propose' : null, action: action ? `${action.kind}:${action.e.entitlementId}` : null };
}

/**
 * Reveal (scroll + focus) when a panel opens, a DIFFERENT one opens, or the user PRESSES the control again while
 * its panel is already open (so a press never looks like "nothing happened"). Never on close, re-render or typing.
 */
export function shouldRevealPanel(prev: OpenPanelKey, next: OpenPanelKey, pressedAgain = false): boolean {
  return next !== null && (next !== prev || pressedAgain);
}

/** Respect prefers-reduced-motion: no animated scrolling for users who asked for less motion. */
export function revealScrollBehavior(prefersReducedMotion: boolean): 'auto' | 'smooth' {
  return prefersReducedMotion ? 'auto' : 'smooth';
}
