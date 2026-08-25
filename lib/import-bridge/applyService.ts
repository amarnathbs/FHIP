/**
 * FHIP Input Data Import Bridge — the GUARDED APPLY.
 *
 * This is the only function in the platform that turns imported evidence into
 * a canonical Input Data mutation, and it is the security boundary for the
 * whole feature. Everything before it — uploading, parsing, reconciling, bank
 * matching, approving the payroll evidence, generating and previewing the
 * proposal — changes nothing in any register (spec sections 6, 31, 58).
 *
 * ===========================================================================
 * WHAT THIS FUNCTION VERIFIES, INDEPENDENTLY, EVERY TIME (spec section 47)
 * ===========================================================================
 *
 * "UI confirmation is not authorization."
 *
 *   1. AUTHENTICATED USER — the caller supplies a `userId` that came from
 *      `requireUser()`, never from the request body.
 *   2. PROPOSAL OWNERSHIP — the proposal is loaded scoped to that user. A
 *      Tenant-B request for a Tenant-A proposal finds nothing.
 *   3. TARGET OWNERSHIP — the target Income row is loaded scoped to that user
 *      too. A forged `target_income_id` belonging to another tenant is not
 *      found, and the database's own same-tenant triggers (migration 0091)
 *      would reject the write even if this check were bypassed.
 *   4. PROPOSAL STILL CURRENT — value-level staleness comparison.
 *   5. SELECTED FIELDS VALID — intersected with the adapter's allow-list, so
 *      no forbidden column can be mutated.
 *   6. NOT ALREADY APPLIED — an atomic compare-and-swap on the proposal's
 *      status, backed by a UNIQUE constraint in the database.
 *
 * ===========================================================================
 * THE STORE PORT
 * ===========================================================================
 *
 * Data access is behind `ImportBridgeStore` so that this guard logic can be
 * certified directly, against adversarial inputs, without a database — see
 * `tests/unit/fdh9IncomeBridge.test.ts`. The Supabase implementation lives in
 * `supabaseStore.ts` and is the only thing that knows about tables.
 */

import type {
  ImportDomainAdapter,
  ImportApplyErrorCode,
  PersistedApplyMode,
  ProposedField,
  UserApplyDecision,
} from './types';
import {
  buildAuditSnapshot,
  buildPatch,
  detectStaleness,
  resolveSelectedFields,
  type StalenessReport,
} from './proposalEngine';

export interface StoredProposal {
  id: string;
  userId: string;
  targetDomain: string;
  sourceKind: string;
  sourcePayrollEventId: string | null;
  targetEntityId: string | null;
  status: string;
  currencyCode: string | null;
  fields: ProposedField[];
}

export interface ApplyRequest {
  proposalId: string;
  decision: UserApplyDecision;
  /** Field names the user ticked. Ignored for `keep_existing`. */
  selectedFields: string[];
}

export interface ApplySuccess {
  ok: true;
  outcome: 'applied' | 'kept_existing';
  applyMode: PersistedApplyMode | null;
  targetEntityId: string | null;
  applicationId: string | null;
  appliedFields: string[];
}

export interface ApplyFailure {
  ok: false;
  code: ImportApplyErrorCode;
  error: string;
  /** Present for STALE_PROPOSAL, so the UI can show a refreshed comparison
   * rather than a bare refusal (spec section 48). */
  staleness?: StalenessReport;
  details?: unknown;
}

export type ApplyResult = ApplySuccess | ApplyFailure;

/** Everything the apply path needs from persistence. */
export interface ImportBridgeStore {
  /** MUST be scoped to `userId` — ownership is enforced here. */
  loadProposal(userId: string, proposalId: string): Promise<StoredProposal | null>;
  /** MUST be scoped to `userId`. Returns the live column values. */
  loadTargetRow(userId: string, domain: string, entityId: string): Promise<Record<string, unknown> | null>;
  /** Atomic compare-and-swap: only succeeds if the proposal is still 'ready'. */
  claimProposal(userId: string, proposalId: string): Promise<boolean>;
  /** Undo the claim if the subsequent write failed. */
  releaseProposal(userId: string, proposalId: string): Promise<void>;
  /** Mark the proposal dismissed — the KEEP EXISTING path. Writes NOTHING to
   * any canonical register. */
  dismissProposal(userId: string, proposalId: string): Promise<void>;

  createEntity(userId: string, domain: string, row: Record<string, unknown>): Promise<string>;
  updateEntity(userId: string, domain: string, entityId: string, patch: Record<string, unknown>): Promise<void>;

  recordApplication(userId: string, input: {
    proposalId: string;
    targetDomain: string;
    targetEntityId: string;
    applyMode: PersistedApplyMode;
    appliedFields: string[];
    previousValues: Record<string, string | null>;
    newValues: Record<string, string | null>;
    sourcePayrollEventId: string | null;
  }): Promise<string>;

  /** Stamp provenance onto the canonical row (spec sections 41, 51). */
  stampProvenance(userId: string, domain: string, entityId: string, applicationId: string): Promise<void>;
}

function fail(code: ImportApplyErrorCode, error: string, extra?: Partial<ApplyFailure>): ApplyFailure {
  return { ok: false, code, error, ...extra };
}

export async function applyImportProposal<TEvidence, TExisting>(
  store: ImportBridgeStore,
  adapter: ImportDomainAdapter<TEvidence, TExisting>,
  userId: string,
  request: ApplyRequest,
  newRowDefaults: () => Record<string, unknown>,
): Promise<ApplyResult> {
  // --- 2. Proposal ownership ------------------------------------------------
  const proposal = await store.loadProposal(userId, request.proposalId);
  if (!proposal || proposal.userId !== userId) {
    // Deliberately the same answer for "does not exist" and "belongs to
    // someone else" — a cross-tenant probe learns nothing from the response.
    return fail('PROPOSAL_NOT_FOUND', 'That import proposal could not be found.');
  }
  if (proposal.targetDomain !== adapter.domain) {
    return fail('PROPOSAL_NOT_ACTIONABLE', 'That proposal is for a different part of your data.');
  }

  // --- KEEP EXISTING: no write of any kind (spec section 59) ----------------
  if (request.decision === 'keep_existing') {
    if (proposal.status !== 'ready') {
      return fail('PROPOSAL_NOT_ACTIONABLE', 'That proposal is no longer open.');
    }
    await store.dismissProposal(userId, proposal.id);
    return {
      ok: true, outcome: 'kept_existing', applyMode: null,
      targetEntityId: proposal.targetEntityId, applicationId: null, appliedFields: [],
    };
  }

  if (proposal.status !== 'ready') {
    return fail(
      proposal.status === 'applied' ? 'ALREADY_APPLIED' : 'PROPOSAL_NOT_ACTIONABLE',
      proposal.status === 'applied'
        ? 'This proposal has already been applied to your income.'
        : 'That proposal is no longer open.',
    );
  }

  // --- Apply mode -----------------------------------------------------------
  const mode: PersistedApplyMode =
    request.decision === 'add_new' ? 'add_new'
      : request.decision === 'update_existing' ? 'update_existing'
        : 'apply_selected_fields';

  if (mode !== 'add_new' && !proposal.targetEntityId) {
    return fail('INVALID_APPLY_MODE', 'There is no existing entry to update.');
  }

  // --- 5. Selected fields ---------------------------------------------------
  // `update_existing` means "apply everything proposed"; the two selective
  // modes take the user's tick list. Either way the result passes through the
  // same allow-list filter.
  const requested = mode === 'update_existing' && request.selectedFields.length === 0
    ? proposal.fields.map((f) => f.fieldName)
    : request.selectedFields;

  const { selected, forbidden, unknown } = resolveSelectedFields(
    proposal.fields, requested, adapter.applicableFields,
  );
  if (forbidden.length > 0) {
    return fail('FORBIDDEN_FIELD', `These fields cannot be changed by an import: ${forbidden.join(', ')}.`, { details: { forbidden } });
  }
  if (unknown.length > 0) {
    return fail('FORBIDDEN_FIELD', `These fields are not part of this proposal: ${unknown.join(', ')}.`, { details: { unknown } });
  }
  if (selected.length === 0) {
    return fail('NO_FIELDS_SELECTED', 'Choose at least one detail to apply.');
  }

  const validation = adapter.validateApply(mode, proposal.fields, selected.map((f) => f.fieldName));
  if (!validation.ok) {
    return fail('DOMAIN_VALIDATION_FAILED', validation.error);
  }

  // --- 3 + 4. Target ownership and staleness --------------------------------
  let liveRow: Record<string, unknown> | null = null;
  if (mode !== 'add_new') {
    liveRow = await store.loadTargetRow(userId, adapter.domain, proposal.targetEntityId!);
    if (!liveRow) {
      return fail('TARGET_NOT_FOUND', 'The income entry this proposal refers to could not be found.');
    }
    const staleness = detectStaleness(selected, liveRow, adapter.serialise.bind(adapter));
    if (staleness.stale) {
      return fail(
        'STALE_PROPOSAL',
        'Your income details changed after this proposal was prepared, so it was not applied. Review the updated comparison.',
        { staleness },
      );
    }
  }

  // --- 6. Atomic claim ------------------------------------------------------
  // Done BEFORE the write, so two concurrent applies cannot both proceed. The
  // UNIQUE(proposal_id) constraint on fhip_import_applications is the second,
  // database-level guarantee behind the same rule (spec section 34).
  const claimed = await store.claimProposal(userId, proposal.id);
  if (!claimed) {
    return fail('ALREADY_APPLIED', 'This proposal has already been applied to your income.');
  }

  try {
    const patch = buildPatch(selected, adapter.coerce.bind(adapter));
    const audit = buildAuditSnapshot(selected);

    let targetEntityId: string;
    if (mode === 'add_new') {
      targetEntityId = await store.createEntity(userId, adapter.domain, {
        ...newRowDefaults(),
        ...patch,
      });
    } else {
      targetEntityId = proposal.targetEntityId!;
      await store.updateEntity(userId, adapter.domain, targetEntityId, patch);
    }

    const applicationId = await store.recordApplication(userId, {
      proposalId: proposal.id,
      targetDomain: adapter.domain,
      targetEntityId,
      applyMode: mode,
      appliedFields: audit.appliedFields,
      previousValues: audit.previousValues,
      newValues: audit.newValues,
      sourcePayrollEventId: proposal.sourcePayrollEventId,
    });

    await store.stampProvenance(userId, adapter.domain, targetEntityId, applicationId);

    return {
      ok: true, outcome: 'applied', applyMode: mode,
      targetEntityId, applicationId, appliedFields: audit.appliedFields,
    };
  } catch (err) {
    // The claim is released so a genuine transient failure does not
    // permanently strand the user's proposal in 'applied' with nothing
    // written.
    await store.releaseProposal(userId, proposal.id).catch(() => undefined);
    return fail('WRITE_FAILED', err instanceof Error ? err.message : 'The change could not be saved.');
  }
}
