// Market Index Data - the entitlement record as the Admin API returns it (one mapper for the overview and the entitlements list).
//
// Migration 0280 added the Edit option's columns. Until it is applied on a database, selecting them fails with "column does not exist";
// the loader below then repeats the read with the 0241 columns only and reports edit as unsupported, so the whole Market Index Data
// screen never goes dark just because the application was deployed before the SQL was run (the SQL is applied by hand).
import type { EntitlementRightsView } from './apiTypes';

/** The columns that exist since migration 0241. */
export const ENTITLEMENT_BASE_COLUMNS =
  'id, benchmark_id, entitlement_kind, status, allow_manual_ingest, allow_automation, allow_storage, allow_calculation, allow_customer_display, allow_report_export, data_from, data_to, valid_from, valid_to, post_expiry_storage, evidence_reference, evidence_url, created_by, approved_at';

/** The columns migration 0280 adds, and the editable ones the 0241 overview did not select. */
export const ENTITLEMENT_EDIT_COLUMNS =
  'post_expiry_calculation, post_expiry_display, evidence_document_date, evidence_retrieved_at, attribution_text, notes, supersedes_entitlement_id, superseded_by, superseded_at, revision_reason, edit_count, created_at, revoked_at, revoked_reason';

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** Map one database row. `userId` only decides proposedByMe; no other identity leaves the server. */
export function mapEntitlementRow(r: Row, userId: string, editSupported: boolean): EntitlementRightsView {
  const view: EntitlementRightsView = {
    entitlementId: r.id as string,
    kind: r.entitlement_kind as EntitlementRightsView['kind'],
    status: r.status as EntitlementRightsView['status'],
    rights: {
      ingestManual: r.allow_manual_ingest === true,
      automation: r.allow_automation === true,
      storage: r.allow_storage === true,
      calculation: r.allow_calculation === true,
      customerDisplay: r.allow_customer_display === true,
      reportExport: r.allow_report_export === true,
    },
    dataFrom: str(r.data_from),
    dataTo: str(r.data_to),
    validFrom: r.valid_from as string,
    validTo: str(r.valid_to),
    postExpiryStorage: r.post_expiry_storage as EntitlementRightsView['postExpiryStorage'],
    evidenceReference: r.evidence_reference as string,
    evidenceUrl: str(r.evidence_url),
    proposedByMe: r.created_by === userId,
    approvedAt: str(r.approved_at),
  };
  if (editSupported) {
    view.edit = {
      supersedesId: str(r.supersedes_entitlement_id),
      supersededById: str(r.superseded_by),
      supersededAt: str(r.superseded_at),
      revisionReason: str(r.revision_reason),
      editCount: typeof r.edit_count === 'number' ? r.edit_count : 0,
      createdAt: str(r.created_at),
      endedAt: str(r.revoked_at),
      endedReason: str(r.revoked_reason),
      postExpiryCalculation: r.post_expiry_calculation === true,
      postExpiryDisplay: r.post_expiry_display === true,
      evidenceDocumentDate: str(r.evidence_document_date),
      evidenceRetrievedAt: str(r.evidence_retrieved_at),
      attributionText: str(r.attribution_text),
      notes: str(r.notes),
    };
  }
  return view;
}

type DbError = { code?: string; message?: string } | null;
const isMissingColumn = (e: DbError) => Boolean(e && (e.code === '42703' || /column .* does not exist|Could not find the .* column/i.test(e.message ?? '')));

/**
 * Run a read with the full column list and, when only the 0280 columns are missing, again with the 0241 list.
 * Any other error is returned unchanged (never turned into an empty success).
 */
export async function readEntitlements<T>(
  run: (columns: string) => PromiseLike<{ data: T | null; error: DbError }>,
  extraSelect = ''
): Promise<{ data: T | null; error: DbError; editSupported: boolean }> {
  const full = await run(`${ENTITLEMENT_BASE_COLUMNS}, ${ENTITLEMENT_EDIT_COLUMNS}${extraSelect}`);
  if (!full.error) return { ...full, editSupported: true };
  if (!isMissingColumn(full.error)) return { ...full, editSupported: false };
  const legacy = await run(`${ENTITLEMENT_BASE_COLUMNS}${extraSelect}`);
  return { ...legacy, editSupported: false };
}
