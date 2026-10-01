// BENCH-1 Phase 2 - the JSON contract between the Benchmark Data Admin API
// (app/api/admin/investment-intelligence/benchmark-data/**) and its UI
// (components/admin/BenchmarkDataClient.tsx). Types only: no runtime code, so
// both sides import it freely. Every successful response is wrapped by the
// repository's `ok()` helper as `{ data: <body> }`; every denial is an explicit
// 401 / 403 / 4xx `{ error, code? }` - never a 200 with an empty body
// (Admin Architecture Standard sections 4 and 8).
import type { BenchmarkCapabilityFlags } from './guards';
import type { PendingImportTask } from './ingestion/pending';
import type { ImportJobDetail, ImportJobSummary } from './publishService';
import type { JobPreview } from './uploadService';
import type { UploadLimits } from './fileIngest/types';

export type { BenchmarkCapabilityFlags, PendingImportTask, ImportJobDetail, ImportJobSummary, JobPreview };

export interface CatalogueRowView {
  id: string;
  benchmarkKey: string;
  label: string;
  officialName: string | null;
  ownerName: string | null;
  officialIdentifier: string | null;
  assetClass: string | null;
  returnType: string | null;
  returnVariant: 'price' | 'total_return' | 'net_total_return' | null;
  currencyCode: string | null;
  countryCode: string | null;
  baseDate: string | null;
  launchDate: string | null;
  historyStartDate: string | null;
  historyClass: 'live' | 'backtested' | 'mixed' | 'unknown';
  backtestedThrough: string | null;
  methodologyUrl: string | null;
  sourceUrl: string | null;
  evidenceRef: string | null;
  evidenceRetrievedAt: string | null;
  catalogueStatus: 'draft' | 'verified' | 'deprecated';
  lifecycleStatus: string;
  /** Coarse legacy summary ONLY (ii_benchmarks.licence_status); never a gate. */
  licenceStatusSummary: string;
}

export interface CoverageView {
  firstDate: string | null;
  lastDate: string | null;
  rowCount: number;
}

export interface IngestionView {
  mode: 'disabled' | 'manual_import' | 'automated';
  automationEnabled: boolean;
  adapterId: string | null;
  publicationLagDays: number;
  latestValidDataDate: string | null;
  completenessWatermark: string | null;
  lastAttemptAt: string | null;
  lastSuccessfulRunAt: string | null;
  lastManualImportAt: string | null;
  lastRunStatus: string | null;
  consecutiveFailures: number;
}

export interface DemandView {
  requiredFrom: string;
  requiredFromInvestor: string | null;
  requiredTo: string;
  schemeCount: number;
  familyCount: number;
  computedAt: string;
}

export interface EntitlementRightsView {
  entitlementId: string;
  kind: 'public_use_permission' | 'commercial_licence';
  status: 'draft' | 'approved' | 'revoked';
  rights: { ingestManual: boolean; automation: boolean; storage: boolean; calculation: boolean; customerDisplay: boolean; reportExport: boolean };
  dataFrom: string | null;
  dataTo: string | null;
  validFrom: string;
  validTo: string | null;
  postExpiryStorage: 'retain' | 'delete' | 'unknown';
  evidenceReference: string;
  evidenceUrl: string | null;
  proposedByMe: boolean;
  approvedAt: string | null;
}

export interface BenchmarkOverviewRow {
  catalogue: CatalogueRowView;
  coverage: CoverageView;
  ingestion: IngestionView | null;
  demand: DemandView | null;
  /** The honest data-state of this benchmark for the Admin table: no_data / history_missing / stale / current / blocked_no_entitlement. */
  dataState: 'no_data' | 'history_missing' | 'stale' | 'current' | 'blocked_no_entitlement';
  entitlements: EntitlementRightsView[];
  pending: PendingImportTask | null;
}

export interface OverviewResponse {
  state: 'ok' | 'unavailable';
  /** Present when state is 'unavailable' (for example migration 0239 not applied). */
  reason?: string;
  asOfDate: string;
  capabilities: BenchmarkCapabilityFlags;
  limits: UploadLimits;
  rows: BenchmarkOverviewRow[];
  recentJobs: ImportJobSummary[];
  pendingImports: PendingImportTask[];
  switches: { globalIngestion: boolean; writeIngestion: boolean; environmentFlag: boolean; effectivelyEnabled: boolean };
  /** Always the plain statement that no benchmark is automated unless every gate holds. */
  automationNotice: string;
}

export interface MappingProposalView {
  id: string;
  instrumentId: string;
  instrumentName: string | null;
  benchmarkKey: string | null;
  proposedBenchmarkName: string;
  relationshipType: 'primary' | 'secondary' | 'category_average';
  effectiveFrom: string;
  effectiveTo: string | null;
  evidenceSource: string;
  evidenceUrl: string;
  evidenceTitle: string | null;
  evidenceDocumentDate: string;
  evidenceRetrievedAt: string;
  evidenceExcerpt: string | null;
  resolutionMethod: string;
  confidence: string;
  ambiguityReason: string | null;
  status: 'proposed' | 'approved' | 'rejected' | 'superseded';
  autoPublished: boolean;
  reviewNote: string | null;
}

/** POST .../upload (multipart): the stage + validate step. Body field `params` is JSON of this shape; `file` is the file. */
export interface StageUploadRequestParams {
  shape: 'single' | 'multi' | 'provider_export';
  mode: 'new_history' | 'correction';
  benchmarkKey?: string;
  providerLayoutId?: string;
  columnMap?: { date?: string; value?: string; benchmarkKey?: string; indexName?: string };
  indexNameToKey?: Record<string, string>;
  returnVariant: 'price' | 'total_return' | 'net_total_return';
  currencyCode: string;
  historyClass: 'live' | 'backtested' | 'mixed' | 'unknown';
  dateFormat: 'YYYY-MM-DD' | 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'DD-MM-YYYY' | 'DD-MMM-YYYY' | 'DD MMM YYYY' | 'excel_1900' | 'excel_1904';
  numberLocale: 'plain' | 'en' | 'in' | 'eu';
  sheetName?: string;
  headerRow?: number;
  includeHiddenRows?: boolean;
  sourceOwner: string;
  sourceReference: string;
  originalFileName?: string;
  dataAsOf?: string | null;
  reason?: string | null;
  entitlementIds?: Record<string, string>;
}

export type StageUploadResponse =
  | { status: 'staged'; jobId: string; canPublish: boolean; preview: JobPreview }
  | { status: 'rejected'; stage: 'inspection' | 'sheet' | 'layout' | 'parameters' | 'persist'; problems: Array<{ code: string; message: string; rowNumber?: number }>; sheets?: Array<{ name: string; index: number; state: 'visible' | 'hidden' | 'veryHidden'; rowCount: number | null }>; fileSha256: string };

/** POST .../jobs/[id]/publish body. */
export interface PublishRequestBody {
  expectedSha256: string;
  expectedDigest: string;
  expectedCounts: { new: number; identical: number; correction: number };
  acknowledged: string[];
  selfPublishAck?: boolean;
}

export interface PublishResponse {
  alreadyPublished: boolean;
  result: { jobId: string; batchId: string; inserted: number; revived: number; corrected: number; identicalSkipped: number; dateFrom: string; dateTo: string };
}
