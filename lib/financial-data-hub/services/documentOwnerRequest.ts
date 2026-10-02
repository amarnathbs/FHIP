/**
 * Owner-before-upload (Phase 2) -- the shared owner handling for every FDH upload
 * that is not the bank pair: payslip, credit card / loan (liability), retirement
 * and AU investment statements, and the generic upload-session route.
 *
 * ONE PLACE FOR THE RULES, so the routes cannot drift apart:
 *   1. the owner is REQUIRED and validated (lib/ownership validateOwnerSelection,
 *      flow-specific policy) BEFORE the file is read or a document row is created;
 *   2. it is recorded on the document (owner_* columns on fdh_statement_uploads) --
 *      its own tolerant update, so a database one migration behind (no 0236 columns)
 *      never loses the document itself;
 *   3. the identical file uploaded again under a DIFFERENT owner is refused (PO
 *      decision 6), scoped strictly to this user and to the same document types;
 *   4. the owner chosen at upload is the DEFAULT, and the LOCK, at the canonical-write
 *      gate (approve / apply / account match): a request that names a different
 *      owner is refused (409), an absent one takes the document's -- so a later
 *      step cannot quietly re-own what the user said before uploading.
 *
 * It never reads the file's contents, parses anything, or touches canonical data.
 */

import { bad } from '@/lib/api';
import { createAdminClient } from '@/lib/supabase/admin';
import { validateOwnerSelection, type ResolvedOwner } from '@/lib/ownership/validateOwnerSelection';
import { documentOwnerKey } from '@/lib/ownership/documentOwnerKey';
import { readOwnerSelectionParam, OWNER_SELECTION_QUERY_PARAM, type OwnerFlow } from '@/lib/ownership/ownerSelection';
import { sha256Hex } from '../domain/fileValidation';

/** Which owner policy a document type is held to. null = no financial canonical effect (no owner asked). */
export const OWNER_FLOW_FOR_DOCUMENT_TYPE: Record<string, OwnerFlow | null> = {
  bank_statement: 'bank',
  payslip: 'payslip',
  credit_card_statement: 'liability',
  loan_statement: 'liability',
  super_statement: 'retirement',
  epf_statement: 'retirement',
  nps_statement: 'retirement',
  investment_statement: 'au_investment',
  tax_document: null,
  other: null,
};

export type UploadOwnerResult = { ok: true; owner: ResolvedOwner } | { ok: false; response: Response };

/** Validates a raw owner value for a flow. A refusal is a ready HTTP response. Injectable for tests. */
export async function resolveUploadOwner(
  userId: string,
  raw: unknown,
  flow: OwnerFlow,
  validate: typeof validateOwnerSelection = validateOwnerSelection,
): Promise<UploadOwnerResult> {
  const verdict = await validate(userId, raw, flow);
  if (!verdict.ok) return { ok: false, response: bad(verdict.message, verdict.status, verdict.code) };
  return { ok: true, owner: verdict.owner };
}

/** The owner from the `owner` query parameter (the shape the bank routes already use). */
export function resolveUploadOwnerFromUrl(userId: string, url: URL, flow: OwnerFlow): Promise<UploadOwnerResult> {
  return resolveUploadOwner(userId, readOwnerSelectionParam(url.searchParams.get(OWNER_SELECTION_QUERY_PARAM)), flow);
}

export function ownerKeyOfResolved(owner: ResolvedOwner): string | null {
  return documentOwnerKey({
    role: owner.ownerRole,
    memberId: owner.ownerMemberId,
    entityId: owner.ownerBusinessEntityId,
    allocations: owner.allocations?.map((a) => ({ ownerMemberId: a.ownerMemberId ?? null, ownerBusinessEntityId: a.ownerBusinessEntityId ?? null, basisPoints: a.basisPoints })) ?? null,
  });
}

export function ownerKeyOfRow(row: Record<string, unknown>): string | null {
  const alloc = row.owner_allocation as Array<{ ownerMemberId?: string; ownerBusinessEntityId?: string; basisPoints: number }> | null | undefined;
  return documentOwnerKey({
    role: row.owner_role as string | null | undefined,
    memberId: (row.owner_member_id as string | null | undefined) ?? null,
    entityId: (row.owner_business_entity_id as string | null | undefined) ?? null,
    allocations: Array.isArray(alloc) ? alloc : null,
  });
}

export type RecordDocumentOwnerOutcome = 'recorded' | 'unavailable' | 'failed';

/** Writes the owner onto the document. Tolerant of a database without 0236. Scoped to the caller. */
export async function recordDocumentOwner(userId: string, documentId: string, owner: ResolvedOwner): Promise<RecordDocumentOwnerOutcome> {
  const admin = createAdminClient();
  const { error } = await admin
    .from('fdh_statement_uploads')
    .update({
      owner_member_id: owner.ownerMemberId,
      owner_business_entity_id: owner.ownerBusinessEntityId,
      owner_role: owner.ownerRole,
      owner_selection_source: 'user_selected',
      owner_allocation: owner.allocations
        ? owner.allocations.map((a) => ({ ...(a.ownerMemberId ? { ownerMemberId: a.ownerMemberId } : { ownerBusinessEntityId: a.ownerBusinessEntityId }), basisPoints: a.basisPoints }))
        : null,
    })
    .eq('id', documentId)
    .eq('user_id', userId);
  if (!error) return 'recorded';
  return /owner_(role|member_id|business_entity_id|selection_source|allocation)/.test(error.message) && /(column|schema cache|does not exist)/i.test(error.message) ? 'unavailable' : 'failed';
}

export class DocumentOwnerConflictError extends Error {
  readonly code = 'identical_upload_different_owner' as const;
  constructor(readonly existingDocumentId: string, readonly existingOwnerRole: string) {
    super(
      `This exact file was already uploaded under a different owner (${existingOwnerRole}). It was not uploaded again. ` +
        'If the first owner was wrong, delete that upload and upload it again; otherwise choose the same owner as before.',
    );
    this.name = 'DocumentOwnerConflictError';
  }
}

/**
 * PO decision 6, for every FDH flow: the same bytes uploaded again under a DIFFERENT
 * owner is refused, naming the first owner's role -- never silently ignored, never
 * silently reassigned. STRICTLY USER-SCOPED (`.eq('user_id')`): another user's identical
 * file is invisible. A rejected / failed earlier copy is a retry; an earlier copy with no
 * recorded owner cannot contradict the choice.
 */
export async function assertNoIdenticalDocumentWithDifferentOwner(
  userId: string,
  bytes: Uint8Array,
  documentTypes: readonly string[],
  owner: ResolvedOwner,
): Promise<void> {
  await assertNoIdenticalDocumentWithDifferentOwnerKey(userId, bytes, documentTypes, ownerKeyOfResolved(owner), null);
}

/** The same rule, for a document whose owner is already stored (the generic complete step). */
export async function assertNoIdenticalDocumentWithDifferentOwnerKey(
  userId: string,
  bytes: Uint8Array,
  documentTypes: readonly string[],
  selected: string | null,
  excludeDocumentId: string | null,
): Promise<void> {
  const admin = createAdminClient();
  const { data: rows } = await admin
    .from('fdh_statement_uploads')
    .select('*')
    .eq('user_id', userId)
    .in('document_type', [...documentTypes])
    .eq('file_hash', sha256Hex(bytes))
    .order('created_at', { ascending: true })
    .limit(20);
  for (const row of (rows ?? []) as Array<Record<string, unknown>>) {
    if (row.id === excludeDocumentId) continue;
    if (row.processing_status === 'failed' || row.processing_status === 'rejected') continue;
    const existing = ownerKeyOfRow(row);
    if (existing && existing !== selected) throw new DocumentOwnerConflictError(row.id as string, row.owner_role as string);
  }
}

export function documentOwnerConflictResponse(e: unknown): Response | null {
  if (!(e instanceof DocumentOwnerConflictError)) return null;
  return Response.json({ error: e.code, message: e.message, existing_document_id: e.existingDocumentId, existing_owner_role: e.existingOwnerRole }, { status: 409 });
}

export interface StoredDocumentOwner {
  ownerRole: string;
  ownerMemberId: string | null;
  allocations: Array<{ ownerMemberId?: string; ownerBusinessEntityId?: string; basisPoints: number }> | null;
}

/** The owner chosen at upload for one document of this user, or null (legacy / unset / another user's). */
export async function getDocumentOwner(userId: string, documentId: string): Promise<StoredDocumentOwner | null> {
  const admin = createAdminClient();
  const { data } = await admin.from('fdh_statement_uploads').select('*').eq('id', documentId).eq('user_id', userId).maybeSingle();
  const row = (data ?? null) as Record<string, unknown> | null;
  if (!row || row.owner_selection_source !== 'user_selected' || !row.owner_role) return null;
  const alloc = row.owner_allocation as StoredDocumentOwner['allocations'];
  return { ownerRole: row.owner_role as string, ownerMemberId: (row.owner_member_id as string | null) ?? null, allocations: Array.isArray(alloc) ? alloc : null };
}

export type OwnerGate = { ok: true; role: string | null } | { ok: false; status: 409; code: 'owner_differs_from_upload'; message: string };

/**
 * The canonical-write gate: the document's owner is the DEFAULT and the LOCK.
 * `requestedRole` absent -> the document's; present and different -> refused; no document
 * owner (a legacy document) -> unchanged behaviour (the requested role, possibly null).
 */
export function reconcileRequestedOwner(doc: StoredDocumentOwner | null, requestedRole: string | null | undefined): OwnerGate {
  if (!doc) return { ok: true, role: requestedRole ?? null };
  if (!requestedRole) return { ok: true, role: doc.ownerRole };
  if (requestedRole !== doc.ownerRole) {
    return { ok: false, status: 409, code: 'owner_differs_from_upload', message: 'This document was uploaded for a different owner. To change who it belongs to, delete it and upload it again with the right owner.' };
  }
  return { ok: true, role: doc.ownerRole };
}

/** The upload owner of the document a LIABILITY proposal came from (null when unknown / legacy / not this user's). */
export async function getLiabilityProposalDocumentOwner(userId: string, proposalId: string): Promise<StoredDocumentOwner | null> {
  const admin = createAdminClient();
  const { data: proposal } = await admin.from('fhip_import_proposals').select('source_liability_statement_id').eq('id', proposalId).eq('user_id', userId).maybeSingle();
  const statementId = (proposal as { source_liability_statement_id?: string | null } | null)?.source_liability_statement_id;
  if (!statementId) return null;
  const { data: statement } = await admin.from('fdh_liability_statements').select('statement_upload_id').eq('id', statementId).eq('user_id', userId).maybeSingle();
  const documentId = (statement as { statement_upload_id?: string | null } | null)?.statement_upload_id;
  return documentId ? getDocumentOwner(userId, documentId) : null;
}
