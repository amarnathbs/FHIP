import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { emitAuditEvent } from '@/lib/services/investment-intelligence/audit';
import { iiSourceDocumentUploadMetaSchema } from '@/lib/validation/investment-intelligence';
import { validateUploadedFile, generateObjectKey, uploadSourceDocumentObject } from '@/lib/services/investment-intelligence/storage';
import { scanUploadedPdfForAdmission, uploadAdmissionFailureMessage } from '@/lib/services/investment-intelligence/uploadAdmission';
import { createHash } from 'crypto';
import { validateOwnerSelection } from '@/lib/ownership/validateOwnerSelection';
import {
  identicalUploadMessage,
  isMissingOwnerColumnError,
  legacyOwnerColumnsFor,
  ownerColumnsFor,
  verdictForIdenticalUpload,
} from '@/lib/services/investment-intelligence/uploadOwner';
import { startIiRealScan } from '@/lib/services/investment-intelligence/realScanAdmission';
import { scanRefusalHttp } from '@/lib/services/investment-intelligence/scanRefusal';
import { computeSourceDocumentCounts, EMPTY_SOURCE_DOCUMENT_COUNTS, type SourceDocumentCounts } from '@/lib/services/investment-intelligence/sourceDocumentEnrichment';
import { refuseUnlessFinancialImportAllowed } from '@/lib/entitlements/financialDataImport';
import { hasStoredFile } from '@/lib/services/investment-intelligence/caseLifecycle';
import { fetchAllRows } from '@/lib/services/investment-intelligence/pagination';

// Real upload path: multipart form-data with a "file" part and a "meta"
// JSON part. Service-role storage write happens only AFTER an
// authenticated, RLS-checked request has been validated here — never a
// direct client-to-bucket upload (spec section 14).
export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('ii_source_documents')
    .select('id, status, original_filename, document_type, uploaded_at, checksum, country_code, storage_path, storage_purged_at')
    .eq('user_id', user.id)
    .order('uploaded_at', { ascending: false });
  if (error) return bad(error.message);
  const documents = data ?? [];

  // 2026-09-28 fix, found live: Portfolio Truth status was ONLY visible
  // after clicking into a specific document's detail panel — a user had no
  // way to see "does anything here need attention" from the list itself.
  // Computed per-user (bounded: a household's own investment documents/
  // positions, not a scan of anything cross-tenant), the same discipline
  // reviewCentreData.ts already uses for its own per-user aggregates.
  const docIds = documents.map((d) => d.id as string);
  let countsByDoc = new Map<string, SourceDocumentCounts>();
  if (docIds.length > 0) {
    // Every read below is paged (fetchAllRows): PostgREST silently caps a plain select at 1,000 rows, and a count built from a
    // truncated read is a wrong count with no error anywhere (see pagination.ts).
    const [openCases, holdings, truthStatuses, publications] = await Promise.all([
      fetchAllRows<{ id: string; source_document_id: string | null }>(() =>
        supabase.from('ii_reconciliation_cases').select('id, source_document_id').eq('user_id', user.id).in('status', ['open', 'user_reviewing']).in('source_document_id', docIds).order('id', { ascending: true }),
      ),
      fetchAllRows<{ id: string; source_document_id: string | null; account_id: string; instrument_id: string }>(() =>
        supabase.from('ii_holding_snapshots').select('id, source_document_id, account_id, instrument_id').eq('user_id', user.id).in('source_document_id', docIds).order('id', { ascending: true }),
      ),
      fetchAllRows<{ id: string; account_id: string; instrument_id: string; status: string }>(() =>
        supabase.from('ii_portfolio_truth_status').select('id, account_id, instrument_id, status').eq('user_id', user.id).order('id', { ascending: true }),
      ),
      // "Previously processed" grouping (Statements & data list, 2026-09-29 fix) and the "ready to publish" count (29-10-2026 fix):
      // certified alone does not mean published — a position can sit fully certified for weeks waiting on the user's explicit
      // Publish click (R3, spec sections 41-42). A position is published when it has an ACTIVE `ii_fhip_publications` row. That
      // row is one-per-position and is made from the position's LATEST certified snapshot, which is frequently a snapshot of a
      // different (newer) statement than the one in this list. So it is matched on the POSITION (account + instrument), not on this
      // statement's snapshot id: matching on the snapshot id showed "17 ready to publish" for a statement whose 17 positions were
      // all published.
      fetchAllRows<{ id: string; canonical_position_id: string; account_id: string; instrument_id: string; status: string }>(() =>
        supabase.from('ii_fhip_publications').select('id, canonical_position_id, account_id, instrument_id, status').eq('user_id', user.id).eq('status', 'published').order('id', { ascending: true }),
      ),
    ]);

    countsByDoc = computeSourceDocumentCounts({
      openCases,
      holdings,
      truthStatuses,
      publications,
      // An archived statement is history: it is listed under "Processed statements", never as something to act on, and its open
      // issues are not counted into any "needs attention" signal on this list.
      archivedDocumentIds: new Set(documents.filter((d) => d.status === 'archived').map((d) => d.id as string)),
    });
  }

  // Document2 (4) WP-B: the raw file is temporary by design, so the screen must know whether it still exists before it
  // offers a password / Reprocess action. The storage path itself is never sent to the browser.
  const enriched = documents.map(({ storage_path, storage_purged_at, ...d }) => ({
    ...d,
    has_stored_file: hasStoredFile({ storagePath: (storage_path as string | null) ?? null, storagePurgedAt: (storage_purged_at as string | null) ?? null }),
    ...(countsByDoc.get(d.id as string) ?? EMPTY_SOURCE_DOCUMENT_COUNTS),
  }));
  return ok(enriched);
}

export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  // Premium Upload Entitlement (14-10-2026): a customer financial upload is a Premium capability. Refused here, before the body,
  // a document row, a credential, storage, a scan, a parser or a provider is touched. Server-authoritative; no client flag is read.
  const importDenied = await refuseUnlessFinancialImportAllowed(user.id, 'ii.source_document.upload');
  if (importDenied) return importDenied;

  const form = await req.formData().catch(() => null);
  if (!form) return bad('Expected multipart/form-data with "file" and "meta" fields', 422);

  const file = form.get('file');
  const metaRaw = form.get('meta');
  if (!(file instanceof File)) return bad('Missing file', 422);
  if (typeof metaRaw !== 'string') return bad('Missing meta', 422);

  let meta: unknown;
  try {
    meta = JSON.parse(metaRaw);
  } catch {
    return bad('Invalid meta JSON', 422);
  }
  const parsedMeta = iiSourceDocumentUploadMetaSchema.safeParse(meta);
  if (!parsedMeta.success) return badValidation(parsedMeta.error, 422);

  // Owner-before-upload (Phase 1): the owner is REQUIRED and validated server-side
  // against THIS user's own household members / entities and their authoritative
  // home country -- never against a country taken from this request. Checked
  // before the file is read, so a missing owner costs nothing.
  const ownerVerdict = await validateOwnerSelection(user.id, parsedMeta.data.owner, 'ii_cas');
  if (!ownerVerdict.ok) return bad(ownerVerdict.message, ownerVerdict.status, ownerVerdict.code);
  const owner = ownerVerdict.owner;

  const validation = validateUploadedFile({ filename: file.name, mimeType: file.type, sizeBytes: file.size });
  if (!validation.ok) return bad(validation.error!, 422);

  const bytes = new Uint8Array(await file.arrayBuffer());

  // Structural admission scan (2026-09-21 fix — see uploadAdmission.ts's own
  // header for the full "why here, why not the whole AIE admission
  // pipeline" reasoning): this upload surface had zero magic-byte/
  // structural check before this fix — only the extension/MIME/size shell
  // above. Runs BEFORE the file is written to storage or a
  // ii_source_documents row is created, so a rejected file is never
  // persisted and can never reach documentProcessing.ts's parsing or
  // AI-fallback path. Scoped to PDF only — CSV has no comparable structural
  // threat model in this codebase.
  if (file.type === 'application/pdf') {
    const admission = scanUploadedPdfForAdmission(bytes);
    if (!admission.ok) {
      await emitAuditEvent({
        userId: user.id,
        eventType: 'document_processing_failed',
        subjectType: 'ii_source_documents',
        subjectId: null,
        actorType: 'system',
        metadata: { reason: 'upload_admission_rejected', failureCode: admission.failureCode, structuralReasons: admission.reasons, originalFilename: file.name },
      });
      return bad(uploadAdmissionFailureMessage(admission.failureCode), 422, 'upload_admission_rejected');
    }
  }

  const checksum = createHash('sha256').update(bytes).digest('hex');

  const supabase = await createClient();

  // Re-upload detection (unique(user_id, checksum) where checksum is not
  // null) — deterministic, explainable behaviour for the identical file
  // uploaded twice (spec section 31).
  // Owner-before-upload (decision 6): the same bytes under a DIFFERENT owner is
  // refused, naming the first owner -- never silently ignored (the user's new
  // answer would be discarded) and never silently reassigned. `select('*')`, so
  // a database one migration behind simply has no owner columns on the row.
  let existing: Record<string, unknown> | null = null;
  {
    const wide = await supabase.from('ii_source_documents').select('*').eq('user_id', user.id).eq('checksum', checksum).maybeSingle();
    existing = (wide.data as Record<string, unknown> | null) ?? null;
  }
  if (existing) {
    const verdict = await verdictForIdenticalUpload(user.id, existing, owner);
    if (verdict.kind !== 'same_owner') {
      return Response.json(
        { error: 'identical_upload_different_owner', message: identicalUploadMessage(verdict, owner.label), existing_document_id: existing.id },
        { status: 409 },
      );
    }
    return ok({ id: existing.id, status: existing.status, deduplicated: true });
  }

  // Entity / joint owners need the 0236 owner columns. Probe BEFORE writing to
  // storage so a database one migration behind never stores a file whose owner
  // it cannot record. (A member-owned upload needs only the long-standing
  // owner_member_id column and still works.)
  if (owner.kind !== 'member') {
    const probe = await supabase.from('ii_source_documents').select('owner_role, owner_business_entity_id, owner_allocation').limit(1);
    if (probe.error && isMissingOwnerColumnError(probe.error.message)) {
      return bad('Choosing a trust, HUF, company or joint owner is not available yet on this system. Choose a person for now.', 503, 'owner_storage_unavailable');
    }
  }

  const objectKey = generateObjectKey(user.id, file.name);
  const { error: uploadErr } = await uploadSourceDocumentObject(objectKey, bytes, file.type);
  if (uploadErr) return bad(`Storage upload failed: ${uploadErr}`, 500);

  // Resolve source_id from source_key (reference lookup, not a write).
  let sourceId: string | null = null;
  {
    const { data: sourceRow } = await supabase.from('ii_sources').select('id').eq('source_key', 'manual').maybeSingle();
    sourceId = (sourceRow?.id as string) ?? null;
  }

  const baseRow = {
    user_id: user.id,
    country_code: parsedMeta.data.countryCode,
    source_id: sourceId,
    status: 'uploaded',
    checksum,
    storage_path: objectKey,
    original_filename: file.name,
    mime_type: file.type,
    file_size: file.size,
    document_type: parsedMeta.data.documentType,
    statement_period_start: parsedMeta.data.statementPeriodStart ?? null,
    statement_period_end: parsedMeta.data.statementPeriodEnd ?? null,
    statement_as_of_date: parsedMeta.data.statementAsOfDate ?? null,
  };
  let inserted = await supabase.from('ii_source_documents').insert({ ...baseRow, ...ownerColumnsFor(owner) }).select().single();
  // A member-owned upload survives a database that predates the 0236 columns.
  if (inserted.error && owner.kind === 'member' && isMissingOwnerColumnError(inserted.error.message)) {
    inserted = await supabase.from('ii_source_documents').insert({ ...baseRow, ...legacyOwnerColumnsFor(owner) }).select().single();
  }
  const { data: doc, error: insertErr } = inserted;
  if (insertErr || !doc) return bad(insertErr?.message ?? 'Could not record uploaded document', 500);

  await emitAuditEvent({
    userId: user.id,
    eventType: 'upload',
    subjectType: 'ii_source_documents',
    subjectId: doc.id as string,
    actorType: 'user',
    actorId: user.id,
    metadata: { sourceDocumentId: doc.id, originalFilename: file.name, fileSize: file.size, ownerKind: owner.kind, ownerRole: owner.ownerRole },
  });

  // AIE-1 final completion (2026-09-25): the real S3 + GuardDuty scan of the
  // exact stored bytes (see realScanAdmission.ts). A no-op while
  // AIE_REAL_MALWARE_SCAN_ENABLED is off. A pending verdict is resolved by the
  // /process call, which refuses to parse until the verdict is clean.
  const scan = await startIiRealScan({
    userId: user.id,
    sourceDocumentId: doc.id as string,
    storagePath: objectKey,
    bytes,
    contentType: file.type,
    contentHash: checksum,
    hasScanColumns: 'malware_scan_status' in (doc as object),
  });
  // WP-H2: three different refusals, three different words (scanRefusal.ts): a finding about the content (final, the stored copy is
  // deleted), a scan that could not finish or run (nothing is deleted, the next attempt scans again), and a scan still running.
  if (!scan.admitted && scan.reason !== 'pending') {
    const refusal = scanRefusalHttp(scan);
    return bad(refusal.message, refusal.status, refusal.code);
  }

  return ok({ ...doc, scan_pending: !scan.admitted });
}
