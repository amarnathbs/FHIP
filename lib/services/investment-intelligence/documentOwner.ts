/**
 * Owner-before-upload (Phase 1) -- Investment Intelligence: how the owner the
 * user chose BEFORE uploading a statement reaches the accounts that statement
 * creates or touches.
 *
 * THE DOCUMENT OWNER IS ONE ANSWER FOR THE WHOLE STATEMENT (PO decision 1: a
 * CAS is per PAN, so every folio on it belongs to the same owner). Per-folio
 * adjustments happen afterwards in Resolutions / the Tax tab; nothing here
 * splits a statement per folio.
 *
 * WHERE THE OWNER LIVES
 *   - ii_source_documents.owner_member_id / owner_business_entity_id /
 *     owner_role / owner_allocation (migration 0230+): the owner of the
 *     DOCUMENT, exactly as chosen (and, for a joint statement, the split).
 *   - ii_accounts.owner_member_id: the single-member owner of an account (what
 *     publication reads). Set for a member-owned statement.
 *   - ii_ownership_allocation (0153, reused as-is): the owner breakdown of an
 *     ACCOUNT in basis points. Written for an entity-owned statement (one
 *     entity at 10000) and for a joint statement (the split). This table was
 *     chosen over a second per-document allocation table on purpose: it is
 *     keyed by ii_account_id, it already enforces one owner kind per row, it
 *     is amendment-safe (supersede, never edit), and PC5's Resolutions UI
 *     already reads it. The document keeps only the JSON of what the user
 *     chose (`owner_allocation`), so the intent survives even if an account's
 *     allocation is later amended.
 *
 * AN EXISTING ACCOUNT'S OWNER IS NEVER SILENTLY OVERWRITTEN (PO decision 2).
 * The same folio can already exist from an earlier statement. If that account
 * has no owner yet, the chosen owner is filled in. If it already has the same
 * owner, nothing changes. If it has a DIFFERENT owner, it is left exactly as
 * it was and the difference is recorded in `ii_source_documents.owner_review`
 * as a conflict the user must explicitly confirm (confirmOwnerChange).
 *
 * HOLDER-NAME EVIDENCE IS ADVISORY NOW. For a new upload the user has named an
 * owner, so owner_unmatched can no longer arise, and a printed holder name that
 * does not match the chosen member is a NON-BLOCKING warning recorded in
 * `owner_review.warnings` -- not a blocking ii_reconciliation_case. Old cases
 * keep working unchanged.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { recordAllocationGroup, listActiveAllocations } from '@/lib/pc5/allocationStore';
import type { Pc5AllocationEntry } from '@/lib/pc5/types';
import { emitAuditEvent } from './audit';
import { matchStatementOwner, type Pc5HouseholdMemberForMatching } from '@/lib/aie/adapters/investment-intelligence/ownerMatching';
import type { ParsedAccountRecord } from './parsers/types';

type Admin = ReturnType<typeof createAdminClient>;

export interface DocumentOwner {
  kind: 'member' | 'entity' | 'joint';
  ownerRole: string;
  ownerMemberId: string | null;
  ownerBusinessEntityId: string | null;
  /** Joint split in basis points (kind = 'joint'). */
  allocations: Pc5AllocationEntry[] | null;
}

export interface OwnerConflict {
  accountId: string;
  folioNumber: string | null;
  institutionName: string | null;
  existingOwner: string;
  selectedOwner: string;
}

export interface OwnerWarning {
  accountId: string;
  kind: 'holder_name_mismatch' | 'holder_matches_other_member' | 'statement_prints_joint_holding';
  maskedHolderName: string | null;
  message: string;
}

export interface OwnerReview {
  conflicts: OwnerConflict[];
  warnings: OwnerWarning[];
  /** Folios the user confirmed are SOLELY owned although the statement prints a joint
   * holding ("this is not joint"). Kept so a reprocess does not warn again. */
  acknowledgedSoleOwner?: string[];
  /** Folios whose owner was filled in or set from this statement. */
  appliedAccountIds: string[];
  /** The signature of the owner chosen at upload. A confirmation must echo it, so a stale
   * screen (or a caller that never saw the target) cannot change an owner. */
  targetSignature?: string | null;
}

/** The owner the user chose at upload, or null for a legacy / unset document
 * (which keep the old owner_unmatched / owner_mismatch behaviour). */
export function readDocumentOwner(doc: Record<string, unknown>): DocumentOwner | null {
  if (doc.owner_selection_source !== 'user_selected') return null;
  const role = doc.owner_role as string | null | undefined;
  if (!role) return null;
  const memberId = (doc.owner_member_id as string | null | undefined) ?? null;
  const entityId = (doc.owner_business_entity_id as string | null | undefined) ?? null;
  const alloc = doc.owner_allocation as Array<{ ownerMemberId?: string; ownerBusinessEntityId?: string; basisPoints: number }> | null | undefined;
  if (role === 'joint') {
    if (!Array.isArray(alloc) || alloc.length < 2) return null;
    return { kind: 'joint', ownerRole: role, ownerMemberId: null, ownerBusinessEntityId: null, allocations: alloc.map((a) => ({ ...a })) as Pc5AllocationEntry[] };
  }
  if (entityId) return { kind: 'entity', ownerRole: role, ownerMemberId: null, ownerBusinessEntityId: entityId, allocations: null };
  if (memberId) return { kind: 'member', ownerRole: role, ownerMemberId: memberId, ownerBusinessEntityId: null, allocations: null };
  return null;
}

/** A canonical, order-independent signature of an owner, so two owners can be
 * compared without caring how they are stored. */
export function ownerSignature(
  parts: { memberId?: string | null; entityId?: string | null; allocations?: ReadonlyArray<{ ownerMemberId?: string | null; ownerBusinessEntityId?: string | null; basisPoints: number }> | null },
): string | null {
  const alloc = parts.allocations ?? [];
  if (alloc.length > 1) {
    return `joint:${alloc
      .map((a) => `${a.ownerMemberId ? `member:${a.ownerMemberId}` : `entity:${a.ownerBusinessEntityId}`}=${a.basisPoints}`)
      .sort()
      .join(',')}`;
  }
  if (alloc.length === 1) {
    const a = alloc[0];
    return a.ownerMemberId ? `member:${a.ownerMemberId}` : a.ownerBusinessEntityId ? `entity:${a.ownerBusinessEntityId}` : null;
  }
  if (parts.entityId) return `entity:${parts.entityId}`;
  if (parts.memberId) return `member:${parts.memberId}`;
  return null;
}

export function signatureOfDocumentOwner(o: DocumentOwner): string | null {
  return ownerSignature({ memberId: o.ownerMemberId, entityId: o.ownerBusinessEntityId, allocations: o.allocations });
}

/** PURE. What to do with an account whose current owner signature is `existing`. */
export function planAccountOwner(existing: string | null, selected: string | null): 'apply' | 'noop' | 'conflict' {
  if (!selected) return 'noop';
  if (!existing) return 'apply';
  return existing === selected ? 'noop' : 'conflict';
}

/** What the allocation rows for this account should be to express `owner`
 * (member-owned accounts are expressed by ii_accounts.owner_member_id alone,
 * unless an allocation already exists, in which case it is superseded). */
function allocationEntriesFor(owner: DocumentOwner): Pc5AllocationEntry[] {
  if (owner.kind === 'joint') return owner.allocations ?? [];
  if (owner.kind === 'entity') return [{ ownerBusinessEntityId: owner.ownerBusinessEntityId as string, basisPoints: 10000 }];
  return [{ ownerMemberId: owner.ownerMemberId as string, basisPoints: 10000 }];
}

export async function setAccountOwner(userId: string, accountId: string, owner: DocumentOwner, hadAllocations: boolean, admin: Admin = createAdminClient()): Promise<{ ok: boolean; error: string | null }> {
  const { error } = await admin
    .from('ii_accounts')
    .update({ owner_member_id: owner.kind === 'member' ? owner.ownerMemberId : null })
    .eq('id', accountId)
    .eq('user_id', userId);
  if (error) return { ok: false, error: error.message };

  // Entity / joint owners live in the allocation table. A member-owned account
  // only needs one when an earlier allocation must be superseded.
  if (owner.kind !== 'member' || hadAllocations) {
    const written = await recordAllocationGroup({
      userId,
      iiAccountId: accountId,
      entries: allocationEntriesFor(owner),
      ownerRole: owner.ownerRole,
      source: 'user',
    });
    if (!written.ok) return { ok: false, error: written.detail };
  }
  return { ok: true, error: null };
}

export async function ownerNames(userId: string, admin: Admin): Promise<Map<string, string>> {
  const [{ data: members }, { data: entities }] = await Promise.all([
    admin.from('household_members').select('id, full_name').eq('user_id', userId),
    admin.from('business_entities').select('id, name').eq('user_id', userId),
  ]);
  const map = new Map<string, string>();
  for (const m of members ?? []) map.set(`member:${m.id as string}`, ((m.full_name as string | null) ?? '').trim() || 'A household member');
  for (const e of entities ?? []) map.set(`entity:${e.id as string}`, ((e.name as string | null) ?? '').trim() || 'An entity');
  return map;
}

export function labelOfSignature(sig: string | null, names: Map<string, string>): string {
  if (!sig) return 'no owner';
  if (sig.startsWith('joint:')) {
    const parts = sig.slice('joint:'.length).split(',').map((p) => {
      const [key, bp] = p.split('=');
      return `${names.get(key) ?? 'Unknown'} ${(Number(bp) / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
    });
    return `Joint (${parts.join(', ')})`;
  }
  return names.get(sig) ?? 'Unknown';
}

export interface ApplyAccount {
  accountId: string;
  /** True when this run created the account (nothing existed to conflict with). */
  created: boolean;
  folioNumber: string | null;
  institutionName: string | null;
}

/**
 * Applies the document owner to every account the statement resolved. Never
 * overwrites an existing, different owner (see the header). Safe to call twice
 * for the same document: a second call finds the owner already in place.
 */
export async function applyDocumentOwnerToAccounts(
  userId: string,
  documentId: string,
  owner: DocumentOwner,
  accounts: readonly ApplyAccount[],
): Promise<OwnerReview> {
  const admin = createAdminClient();
  const selected = signatureOfDocumentOwner(owner);
  const review: OwnerReview = { conflicts: [], warnings: [], appliedAccountIds: [], targetSignature: selected };
  let names: Map<string, string> | null = null;

  for (const acc of accounts) {
    if (acc.created) {
      // resolveOrCreateAccount already stored a member owner on the new row; an
      // entity / joint owner needs its allocation written now.
      if (owner.kind !== 'member') {
        const set = await setAccountOwner(userId, acc.accountId, owner, false, admin);
        if (!set.ok) throw new Error(`could not record the owner on a new account: ${set.error}`);
      }
      review.appliedAccountIds.push(acc.accountId);
      continue;
    }

    const [{ data: row }, allocations] = await Promise.all([
      admin.from('ii_accounts').select('owner_member_id').eq('id', acc.accountId).eq('user_id', userId).maybeSingle(),
      listActiveAllocations(userId, acc.accountId),
    ]);
    const existing = ownerSignature({
      memberId: (row?.owner_member_id as string | null | undefined) ?? null,
      allocations: allocations.map((a) => ({ ownerMemberId: a.ownerMemberId, ownerBusinessEntityId: a.ownerBusinessEntityId, basisPoints: a.allocationBasisPoints })),
    });
    const plan = planAccountOwner(existing, selected);
    if (plan === 'noop') continue;
    if (plan === 'apply') {
      const set = await setAccountOwner(userId, acc.accountId, owner, allocations.length > 0, admin);
      if (!set.ok) throw new Error(`could not record the owner on an existing account: ${set.error}`);
      review.appliedAccountIds.push(acc.accountId);
      continue;
    }
    names ??= await ownerNames(userId, admin);
    review.conflicts.push({
      accountId: acc.accountId,
      folioNumber: acc.folioNumber,
      institutionName: acc.institutionName,
      existingOwner: labelOfSignature(existing, names),
      selectedOwner: labelOfSignature(selected, names),
    });
  }

  if (review.conflicts.length > 0) {
    await emitAuditEvent({
      userId,
      eventType: 'user_correction',
      subjectType: 'ii_source_documents',
      subjectId: documentId,
      actorType: 'system',
      metadata: { field: 'account_owner', outcome: 'kept_existing_owner_pending_confirmation', conflictCount: review.conflicts.length },
    });
  }
  return review;
}

/** Writes the review onto the document (own update; tolerant of a database one
 * migration behind -- the review is advisory, never load-bearing). */
export async function saveOwnerReview(userId: string, documentId: string, review: OwnerReview): Promise<void> {
  const admin = createAdminClient();
  await admin.from('ii_source_documents').update({ owner_review: review }).eq('id', documentId).eq('user_id', userId);
}

/**
 * The user's EXPLICIT confirmation (POST .../confirm-owner): apply the
 * document's owner to the listed conflicted accounts. Only accounts that are
 * recorded as conflicts on THIS document, and that belong to this user, can be
 * changed -- a caller cannot use this to re-own an arbitrary account.
 */
export async function confirmOwnerChange(
  userId: string,
  documentId: string,
  accountIds: readonly string[],
  /** The target owner the user was shown (PO-OBU-05: explicit, never assumed). */
  targetSignature: string | null,
): Promise<{ ok: true; changed: string[]; remainingConflicts: number } | { ok: false; status: 404 | 409 | 422 | 500; message: string }> {
  const admin = createAdminClient();
  const { data: doc } = await admin.from('ii_source_documents').select('*').eq('id', documentId).eq('user_id', userId).maybeSingle();
  if (!doc) return { ok: false, status: 404, message: 'Document not found.' };
  const owner = readDocumentOwner(doc as Record<string, unknown>);
  if (!owner) return { ok: false, status: 409, message: 'This document has no owner chosen at upload, so there is nothing to confirm. Set the owner on the folio from Resolutions instead.' };
  const review = ((doc as Record<string, unknown>).owner_review as OwnerReview | null) ?? null;
  const conflicts = review?.conflicts ?? [];
  const wanted = new Set(accountIds);
  const targets = conflicts.filter((c) => wanted.has(c.accountId));
  if (targets.length === 0) return { ok: false, status: 422, message: 'None of those folios are waiting for an owner confirmation on this document.' };
  // The confirmation must name the owner it was shown. Each folio is decided on its own:
  // only the listed folios change, every other conflicted folio stays exactly as it was.
  if (!targetSignature || targetSignature !== signatureOfDocumentOwner(owner)) {
    return { ok: false, status: 409, message: 'The owner shown to you no longer matches this statement. Reload and choose again.' };
  }

  const changed: string[] = [];
  for (const t of targets) {
    const allocations = await listActiveAllocations(userId, t.accountId);
    const set = await setAccountOwner(userId, t.accountId, owner, allocations.length > 0, admin);
    if (!set.ok) return { ok: false, status: 500, message: 'Could not change the owner of one of the folios. Nothing further was changed.' };
    changed.push(t.accountId);
    await emitAuditEvent({
      userId,
      eventType: 'user_correction',
      subjectType: 'ii_accounts',
      subjectId: t.accountId,
      actorType: 'user',
      actorId: userId,
      metadata: { field: 'account_owner', outcome: 'owner_change_confirmed_at_upload', sourceDocumentId: documentId, previousOwner: t.existingOwner, newOwner: t.selectedOwner },
    });
  }
  const remaining = conflicts.filter((c) => !changed.includes(c.accountId));
  await saveOwnerReview(userId, documentId, { conflicts: remaining, warnings: review?.warnings ?? [], appliedAccountIds: [...(review?.appliedAccountIds ?? []), ...changed] });
  return { ok: true, changed, remainingConflicts: remaining.length };
}

export interface DocumentOwnerSummary {
  /** True when the owner was chosen at upload (owner_selection_source = 'user_selected'). */
  chosenAtUpload: boolean;
  ownerRole: string | null;
  label: string | null;
  review: OwnerReview | null;
}

/** What the statement detail shows: who this document was filed under, and any
 * non-blocking owner warnings / pending owner-change confirmations. */
export async function describeDocumentOwner(userId: string, row: Record<string, unknown> | null): Promise<DocumentOwnerSummary> {
  const empty: DocumentOwnerSummary = { chosenAtUpload: false, ownerRole: null, label: null, review: null };
  if (!row) return empty;
  const owner = readDocumentOwner(row);
  if (!owner) return { ...empty, ownerRole: (row.owner_role as string | null | undefined) ?? null };
  const names = await ownerNames(userId, createAdminClient());
  const sig = signatureOfDocumentOwner(owner);
  return {
    chosenAtUpload: true,
    ownerRole: owner.ownerRole,
    label: labelOfSignature(sig, names),
    review: (row.owner_review as OwnerReview | null | undefined) ?? null,
  };
}

/**
 * PURE. Compares each folio's PRINTED holder evidence with the owner the user
 * chose and returns NON-BLOCKING warnings. Reuses PC5's own deterministic
 * `matchStatementOwner` (no fuzzy auto-matching) -- the same function the
 * legacy owner_mismatch case used -- but the outcome is advice, not a block:
 * the holdings are filed under the owner the user chose either way.
 */
export function computeHolderNameWarnings(input: {
  declaredOwnerMemberId: string;
  assignments: ReadonlyArray<{ folioNumber: string | null; accountId: string | null }>;
  parsedAccounts: readonly ParsedAccountRecord[];
  members: readonly Pc5HouseholdMemberForMatching[];
}): OwnerWarning[] {
  const recordByFolio = new Map<string, ParsedAccountRecord>();
  for (const acc of input.parsedAccounts) {
    const key = acc.folioNumber ?? '__no_folio__';
    if (!recordByFolio.has(key)) recordByFolio.set(key, acc);
  }
  const warnings: OwnerWarning[] = [];
  for (const assignment of input.assignments) {
    const record = recordByFolio.get(assignment.folioNumber ?? '__no_folio__');
    if (!assignment.accountId || !record) continue; // no printed holder evidence for this folio -- nothing to compare
    const outcome = matchStatementOwner(
      { holderName: record.holderName, jointHolders: record.jointHolders, holdingModeRaw: record.holdingModeRaw },
      [...input.members],
    );
    if (outcome.kind === 'no_owner_evidence') continue; // the document is silent -- not a mismatch
    if (outcome.kind === 'exact_match' && outcome.memberId === input.declaredOwnerMemberId) continue; // agrees with the user
    if (outcome.kind === 'joint_holding') {
      warnings.push({ accountId: assignment.accountId, kind: 'statement_prints_joint_holding', maskedHolderName: outcome.maskedHolderName, message: 'This statement prints a joint holding, but you chose a single owner. The holdings were filed under the owner you chose.' });
    } else if (outcome.kind === 'exact_match') {
      warnings.push({ accountId: assignment.accountId, kind: 'holder_matches_other_member', maskedHolderName: outcome.maskedHolderName, message: 'The holder name printed on this statement matches a different household member than the owner you chose. The holdings were filed under the owner you chose.' });
    } else {
      warnings.push({ accountId: assignment.accountId, kind: 'holder_name_mismatch', maskedHolderName: outcome.maskedHolderName, message: 'The holder name printed on this statement does not match the owner you chose. The holdings were filed under the owner you chose.' });
    }
  }
  return warnings;
}

/** Drops a printed-joint-holding warning for folios the user already confirmed are sole-owned. */
export function withoutAcknowledgedWarnings(warnings: readonly OwnerWarning[], acknowledged: readonly string[] | undefined): OwnerWarning[] {
  const ack = new Set(acknowledged ?? []);
  return warnings.filter((w) => !(w.kind === 'statement_prints_joint_holding' && ack.has(w.accountId)));
}

/**
 * The user's EXPLICIT confirmation that a folio the statement prints as joint is
 * really solely owned by the owner they chose ("this is not joint"). It only
 * dismisses the advisory warning for folios that carry it on THIS document -- the
 * account's owner is not touched (it was filed under the chosen owner already).
 */
export async function confirmSoleOwner(
  userId: string,
  documentId: string,
  accountIds: readonly string[],
): Promise<{ ok: true; acknowledged: string[]; remainingWarnings: number } | { ok: false; status: 404 | 409 | 422; message: string }> {
  const admin = createAdminClient();
  const { data: doc } = await admin.from('ii_source_documents').select('*').eq('id', documentId).eq('user_id', userId).maybeSingle();
  if (!doc) return { ok: false, status: 404, message: 'Document not found.' };
  const owner = readDocumentOwner(doc as Record<string, unknown>);
  if (!owner || owner.kind !== 'member') return { ok: false, status: 409, message: 'This document was not filed under a single owner, so there is no joint holding to dismiss.' };
  const review = ((doc as Record<string, unknown>).owner_review as OwnerReview | null) ?? null;
  const wanted = new Set(accountIds);
  const targets = (review?.warnings ?? []).filter((w) => w.kind === 'statement_prints_joint_holding' && wanted.has(w.accountId));
  if (targets.length === 0) return { ok: false, status: 422, message: 'None of those folios are waiting for a joint-holding confirmation on this document.' };
  const acknowledged = [...new Set([...(review?.acknowledgedSoleOwner ?? []), ...targets.map((t) => t.accountId)])];
  const warnings = (review?.warnings ?? []).filter((w) => !(w.kind === 'statement_prints_joint_holding' && wanted.has(w.accountId)));
  await saveOwnerReview(userId, documentId, { ...(review ?? { conflicts: [], appliedAccountIds: [] }), conflicts: review?.conflicts ?? [], warnings, appliedAccountIds: review?.appliedAccountIds ?? [], acknowledgedSoleOwner: acknowledged });
  for (const t of targets) {
    await emitAuditEvent({
      userId,
      eventType: 'user_correction',
      subjectType: 'ii_accounts',
      subjectId: t.accountId,
      actorType: 'user',
      actorId: userId,
      metadata: { field: 'joint_holding_warning', outcome: 'confirmed_sole_owner', sourceDocumentId: documentId },
    });
  }
  return { ok: true, acknowledged: targets.map((t) => t.accountId), remainingWarnings: warnings.length };
}
