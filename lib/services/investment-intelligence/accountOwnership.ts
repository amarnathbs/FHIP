/**
 * Investment Intelligence -- account ownership (I/O). 2026-10-01.
 *
 * The persistence half of `ownerModel.ts`. See that file's header for the
 * storage design: `ii_accounts.owner_member_id` stays "the sole member owner"
 * (NULL for entity / joint), and an entity or joint owner lives ONLY in the
 * single ACTIVE `ii_ownership_allocation` group (migration 0153).
 *
 * WHAT AN OWNER CHANGE DOES
 *   1. validates nothing itself -- the caller passes a `ValidatedOwner` that
 *      `validateOwnerSelection()` produced from rows loaded for THIS user;
 *   2. refuses (409) to move an already-published account under an entity
 *      owner (it would keep counting in personal Net Worth);
 *   3. records a NEW allocation group when the result is an entity / joint
 *      owner, or when an allocation group already existed (never edits one in
 *      place -- `recordAllocationGroup` supersedes and inserts, K.18);
 *   4. keeps `owner_member_id` consistent with the result;
 *   5. resolves the open owner-exception cases the choice is allowed to
 *      resolve (merging the evidence already on the case, never overwriting it);
 *   6. writes ONE `user_correction` audit event (ids and basis points only).
 *
 * WHAT IT NEVER DOES: move, delete or recompute holdings, transactions,
 * snapshots, tax lots or publications. Ownership is attribution, not data.
 *
 * IDEMPOTENT. Replaying the same change compares the requested ownership with
 * the EFFECTIVE current one and writes no new allocation group when they are
 * equal. (It still heals a stale `owner_member_id` pointer and resolves any
 * still-open case, so a retry after a half-completed attempt finishes the job.)
 * A truly concurrent double submit is not serialised by the database --
 * see the report's open items.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminClient } from '@/lib/supabase/admin';
import { getUserFullExperienceHomeCountry } from '@/lib/services/jurisdiction';
import { recordAllocationGroup } from '@/lib/pc5/allocationStore';
import { emitAuditEvent } from './audit';
import {
  caseTypesResolvedBy,
  deriveAccountOwnership,
  ownershipAuditShape,
  ownershipBlocksPersonalPublication,
  resolutionMethodFor,
  sameOwnership,
  validatedOwnerToOwnership,
  type AccountOwnership,
  type ActiveAllocationRow,
  type OwnerChoiceContext,
  type OwnerChoiceEntity,
  type OwnerChoiceMember,
  type OwnerFailure,
  type ValidatedOwner,
} from './ownerModel';

type Db = Pick<SupabaseClient, 'from'>;

const ALLOCATION_ROW_COLUMNS = 'owner_member_id, owner_business_entity_id, allocation_basis_points, ii_instrument_id, status';

export interface LoadedAccountOwnership {
  accountId: string;
  pointerMemberId: string | null;
  ownership: AccountOwnership;
  hasActiveAllocationGroup: boolean;
}

/** Effective ownership of one account, or null when the account is not this user's. */
export async function loadAccountOwnership(client: Db, userId: string, accountId: string): Promise<LoadedAccountOwnership | null> {
  const { data: account } = await client.from('ii_accounts').select('id, owner_member_id').eq('id', accountId).eq('user_id', userId).maybeSingle();
  if (!account) return null;
  const { data: rows } = await client.from('ii_ownership_allocation').select(ALLOCATION_ROW_COLUMNS).eq('user_id', userId).eq('ii_account_id', accountId).eq('status', 'active');
  const active = (rows ?? []) as ActiveAllocationRow[];
  const pointerMemberId = (account.owner_member_id as string | null) ?? null;
  return { accountId, pointerMemberId, ownership: deriveAccountOwnership(pointerMemberId, active), hasActiveAllocationGroup: active.some((r) => (r.ii_instrument_id ?? null) === null) };
}

/**
 * Which of these accounts already have an owner DECISION recorded as an entity
 * / joint allocation (so `owner_member_id = null` does NOT mean "unresolved").
 * Used by the readers that previously tested `!owner_member_id`.
 */
export async function loadDecidedOwnershipAccountIds(client: Db, userId: string, accountIds: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (accountIds.length === 0) return out;
  const { data } = await client.from('ii_ownership_allocation').select('ii_account_id, ii_instrument_id').eq('user_id', userId).eq('status', 'active').in('ii_account_id', [...accountIds]);
  for (const r of (data ?? []) as { ii_account_id: string; ii_instrument_id: string | null }[]) {
    if ((r.ii_instrument_id ?? null) === null) out.add(r.ii_account_id);
  }
  return out;
}

/** Accounts with ANY active entity share. Their holdings must never be offered to personal Net Worth. */
export async function loadEntityOwnedAccountIds(client: Db, userId: string): Promise<Set<string>> {
  const out = new Set<string>();
  const { data } = await client.from('ii_ownership_allocation').select('ii_account_id, owner_business_entity_id, ii_instrument_id').eq('user_id', userId).eq('status', 'active');
  for (const r of (data ?? []) as { ii_account_id: string; owner_business_entity_id: string | null; ii_instrument_id: string | null }[]) {
    if (r.owner_business_entity_id && (r.ii_instrument_id ?? null) === null) out.add(r.ii_account_id);
  }
  return out;
}

/**
 * The owners this user may pick from, loaded SERVER-SIDE and filtered by
 * user_id in the query. `userClient` is the request-scoped client used for the
 * authoritative home-country read (user_profiles), exactly as
 * `app/api/business-entities/route.ts` does for the HUF gate -- the country is
 * never read from the request.
 */
export async function loadOwnerChoiceContext(userId: string, userClient: Db): Promise<OwnerChoiceContext> {
  const admin = createAdminClient();
  const [{ data: members }, { data: entities }, homeCountry] = await Promise.all([
    admin.from('household_members').select('id, full_name, relationship, is_active').eq('user_id', userId).order('created_at', { ascending: true }),
    admin.from('business_entities').select('id, name, entity_type, is_active').eq('user_id', userId).order('created_at', { ascending: true }),
    getUserFullExperienceHomeCountry(userId, userClient as SupabaseClient),
  ]);
  return { members: (members ?? []) as OwnerChoiceMember[], entities: (entities ?? []) as OwnerChoiceEntity[], homeCountry };
}

export interface ApplyOwnerChangeParams {
  userId: string;
  accountId: string;
  owner: ValidatedOwner;
  /** True when this change is an amendment from the Resolutions tab. */
  amend: boolean;
  /** The reconciliation case being resolved / amended, for the audit trail. */
  caseId?: string | null;
  nowIso?: string;
}

export type ApplyOwnerChangeResult =
  | {
      ok: true;
      changed: boolean;
      before: AccountOwnership;
      after: AccountOwnership;
      resolvedCaseIds: string[];
      allocationGroupId: string | null;
      /** The account already has a published position: its owner LABEL in Net Worth updates only when it is re-published. */
      republishRecommended: boolean;
    }
  | OwnerFailure;

const writeFailed = (message: string): OwnerFailure => ({ ok: false, status: 500, code: 'OWNER_WRITE_FAILED', message });

export async function applyAccountOwnerChange(params: ApplyOwnerChangeParams): Promise<ApplyOwnerChangeResult> {
  const { userId, accountId, owner } = params;
  const admin = createAdminClient();
  const nowIso = params.nowIso ?? new Date().toISOString();

  const current = await loadAccountOwnership(admin, userId, accountId);
  if (!current) return { ok: false, status: 404, code: 'ACCOUNT_NOT_FOUND', message: 'Account not found.' };
  const before = current.ownership;
  const after = validatedOwnerToOwnership(owner);
  const unchanged = sameOwnership(before, after);

  const { data: activePublications } = await admin.from('ii_fhip_publications').select('id').eq('user_id', userId).eq('account_id', accountId).eq('status', 'published').limit(1);
  const hasPublication = (activePublications ?? []).length > 0;

  // ENTITY SEPARATION (PO ruling 2026-09-21): a position already published to
  // personal Net Worth must not be silently re-owned by an entity -- it would
  // keep being counted there. The user unpublishes first, on purpose.
  if (!unchanged && ownershipBlocksPersonalPublication(after) && hasPublication) {
    return {
      ok: false,
      status: 409,
      code: 'ACCOUNT_PUBLISHED_UNPUBLISH_FIRST',
      message: 'This account is already counted in your personal Net Worth. Unpublish its positions first (Statements & data), then assign it to a trust, HUF or company.',
    };
  }

  let allocationGroupId: string | null = null;
  if (!unchanged) {
    // Entity / joint results ALWAYS live in an allocation group. A plain member
    // result only needs one when an earlier group exists, so the old split is
    // superseded (kept as history) instead of lingering as the active truth.
    const needsAllocationGroup = owner.kind !== 'member' || current.hasActiveAllocationGroup;
    if (needsAllocationGroup) {
      const written = await recordAllocationGroup({ userId, iiAccountId: accountId, entries: owner.entries, ownerRole: owner.ownerRole, source: 'user' });
      if (!written.ok) {
        if (written.reason === 'invalid_allocation') {
          return { ok: false, status: 422, code: 'JOINT_ALLOCATION_INVALID', message: 'The shares could not be saved because they do not add up to exactly 100%.', reason: written.detail };
        }
        // `ii_ownership_allocation` (migration 0153) is not applied in every
        // environment. Say so plainly instead of a generic failure.
        if (/ii_ownership_allocation/i.test(written.detail) && /(does not exist|schema cache|could not find)/i.test(written.detail)) {
          return { ok: false, status: 503, code: 'OWNERSHIP_FEATURE_NOT_AVAILABLE', message: 'Trust, HUF, company and joint ownership are not available in this environment yet. Nothing was changed.' };
        }
        return writeFailed('Could not record the new owner. Nothing was changed.');
      }
      allocationGroupId = written.allocationGroupId;
    }
  }

  // Keep the sole-member pointer consistent with the effective result (also
  // heals a pointer left stale by an interrupted earlier attempt).
  if (current.pointerMemberId !== owner.pointerMemberId) {
    const { error: pointerErr } = await admin.from('ii_accounts').update({ owner_member_id: owner.pointerMemberId }).eq('id', accountId).eq('user_id', userId);
    if (pointerErr) return writeFailed('Could not update the account owner.');
  }

  // Resolve the open owner-exception cases this choice is allowed to resolve.
  // ADMIN CLIENT, deliberately: `discrepancy_details` is a system-authoritative
  // column (migration 0087 refuses an `authenticated` write to it). Ownership
  // of the account and of every owner id was verified before this point.
  const types = caseTypesResolvedBy(owner.kind);
  const { data: openCases, error: openCasesErr } = await admin
    .from('ii_reconciliation_cases')
    .select('id, discrepancy_type, discrepancy_details')
    .eq('user_id', userId)
    .eq('subject_type', 'account')
    .eq('subject_id', accountId)
    .in('discrepancy_type', [...types])
    .eq('status', 'open');
  if (openCasesErr) return writeFailed('The owner was saved, but its open issues could not be checked. Retry to finish.');

  const beforeShape = ownershipAuditShape(before);
  const afterShape = ownershipAuditShape(after);
  const method = resolutionMethodFor(owner.kind, params.amend);
  const resolvedCaseIds: string[] = [];
  for (const c of (openCases ?? []) as { id: string; discrepancy_type: string; discrepancy_details: Record<string, unknown> | null }[]) {
    const mergedDetails: Record<string, unknown> = {
      ...(c.discrepancy_details ?? {}),
      resolvedOwner: afterShape,
      previousOwner: beforeShape,
      ...(owner.kind === 'member' ? { resolvedOwnerMemberId: owner.pointerMemberId } : {}),
    };
    const { error: resolveErr } = await admin
      .from('ii_reconciliation_cases')
      .update({ status: 'resolved', resolved_at: nowIso, resolution_method: method, resolved_by: userId, resolved_by_actor_type: 'user', discrepancy_details: mergedDetails })
      .eq('id', c.id)
      .eq('status', 'open'); // race guard: only this row, only if still open
    if (!resolveErr) {
      resolvedCaseIds.push(c.id);
      await emitAuditEvent({
        userId,
        eventType: 'reconciliation_case_resolved',
        subjectType: 'ii_reconciliation_cases',
        subjectId: c.id,
        actorType: 'user',
        actorId: userId,
        metadata: { discrepancyType: c.discrepancy_type, resolutionMethod: method, accountId },
      });
    }
  }

  // ONE audit event per accepted request that actually did something. Ids and
  // basis points only: never a name, PAN, folio or account number.
  if (!unchanged || resolvedCaseIds.length > 0) {
    await emitAuditEvent({
      userId,
      eventType: 'user_correction',
      subjectType: 'ii_accounts',
      subjectId: accountId,
      actorType: 'user',
      actorId: userId,
      metadata: {
        field: 'ownership',
        before: beforeShape,
        after: afterShape,
        changed: !unchanged,
        origin: params.amend ? 'resolutions_amend' : 'review',
        resolvedCaseCount: resolvedCaseIds.length,
        allocationGroupId,
        ...(params.caseId ? { caseId: params.caseId } : {}),
      },
    });
  }

  return { ok: true, changed: !unchanged, before, after, resolvedCaseIds, allocationGroupId, republishRecommended: !unchanged && hasPublication };
}
