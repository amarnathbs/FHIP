/**
 * FHIP Input Data Import Bridge — the Supabase implementation of the store
 * port.
 *
 * The ONLY file in the bridge that knows table names. Everything else works
 * against `ImportBridgeStore`, which is what lets the guard logic in
 * `applyService.ts` be certified adversarially without a database.
 *
 * EVERY QUERY IS SCOPED `.eq('user_id', userId)` ON TOP OF RLS. That is
 * belt-and-braces on purpose: RLS is the guarantee, the explicit filter is the
 * one a reader can see, and migration 0091's same-tenant triggers are the
 * third layer that holds even against the service role.
 */

import { createClient } from '@/lib/supabase/server';
import type { ImportBridgeStore, StoredProposal } from './applyService';
import type {
  ImportProposalDraft,
  ImportTargetDomain,
  ImportValueKind,
  PersistedApplyMode,
  ProposedField,
} from './types';

/**
 * Domain -> canonical register. FAILS CLOSED: a domain without an entry here
 * cannot be written at all, so a future adapter must consciously add itself
 * rather than inheriting write access by accident. The database triggers in
 * migration 0091 enforce the same rule independently.
 */
const DOMAIN_TABLES: Partial<Record<ImportTargetDomain, string>> = {
  income: 'income_sources',
  // FDH-10 addition (spec sections 6, 50-58) — the liability branch of the
  // FDH-9 bridge's same-tenant guards (migration 0096 Part G) and its own
  // typed atomic-apply RPC (`fdh10_apply_liability_proposal`) are what
  // actually enforce write authority; this entry only lets the ordinary
  // (non-apply) read paths — `loadTargetRow` for the preview/compare screen —
  // resolve the table name.
  liability: 'liabilities',
  // FDH-12 addition (spec sections 104, 55-60) — the retirement branch. As
  // with liability, this entry only lets the ordinary (non-apply) read paths
  // — `loadTargetRow` for the preview/compare screen — resolve the table name.
  // Write authority is enforced by `fdh12_apply_retirement_proposal()`
  // (migration 0112 PART I) and its own nine-column `v_allowed` array, not by
  // the presence of this line.
  retirement: 'retirement_accounts',
};

function tableFor(domain: string): string {
  const table = DOMAIN_TABLES[domain as ImportTargetDomain];
  if (!table) throw new Error(`import-bridge: domain ${domain} has no implemented register`);
  return table;
}

/** Provenance columns, per domain. Income mirrors `investments`' R3 pattern. */
const PROVENANCE_BY_DOMAIN: Partial<Record<ImportTargetDomain, (applicationId: string) => Record<string, unknown>>> = {
  income: (applicationId) => ({
    source_type: 'payslip_import',
    last_import_application_id: applicationId,
    last_imported_at: new Date().toISOString(),
  }),
  liability: (applicationId) => ({
    source_type: 'liability_statement_import',
    last_import_application_id: applicationId,
    last_imported_at: new Date().toISOString(),
  }),
  retirement: (applicationId) => ({
    source_type: 'retirement_statement_import',
    last_import_application_id: applicationId,
    last_imported_at: new Date().toISOString(),
  }),
};

export function makeSupabaseImportBridgeStore(): ImportBridgeStore {
  return {
    async loadProposal(userId, proposalId): Promise<StoredProposal | null> {
      const supabase = await createClient();
      const { data, error } = await supabase
        .from('fhip_import_proposals')
        .select('id, user_id, target_domain, source_kind, source_payroll_event_id, target_entity_id, status, currency_code')
        .eq('id', proposalId)
        .eq('user_id', userId)
        .maybeSingle();
      if (error || !data) return null;

      const { data: fieldRows } = await supabase
        .from('fhip_import_proposal_fields')
        .select('field_name, value_kind, proposed_value, existing_value, is_recommended, requires_confirmation, confidence, reason_code')
        .eq('proposal_id', proposalId)
        .eq('user_id', userId);

      const fields: ProposedField[] = (fieldRows ?? []).map((r) => ({
        fieldName: r.field_name as string,
        valueKind: r.value_kind as ImportValueKind,
        proposedValue: (r.proposed_value as string | null) ?? null,
        existingValue: (r.existing_value as string | null) ?? null,
        isRecommended: Boolean(r.is_recommended),
        requiresConfirmation: Boolean(r.requires_confirmation),
        confidence: (r.confidence as number | null) ?? undefined,
        reasonCode: (r.reason_code as string | null) ?? 'unspecified',
      }));

      return {
        id: data.id as string,
        userId: data.user_id as string,
        targetDomain: data.target_domain as string,
        sourceKind: data.source_kind as string,
        sourcePayrollEventId: (data.source_payroll_event_id as string | null) ?? null,
        targetEntityId: (data.target_entity_id as string | null) ?? null,
        status: data.status as string,
        currencyCode: (data.currency_code as string | null) ?? null,
        fields,
      };
    },

    async loadTargetRow(userId, domain, entityId) {
      const supabase = await createClient();
      const { data, error } = await supabase
        .from(tableFor(domain))
        .select('*')
        .eq('id', entityId)
        .eq('user_id', userId)
        .maybeSingle();
      if (error || !data) return null;
      return data as Record<string, unknown>;
    },

    async claimProposal(userId, proposalId) {
      const supabase = await createClient();
      // Compare-and-swap: the `.eq('status','ready')` is what makes this
      // atomic. A second concurrent apply matches zero rows and is refused.
      const { data, error } = await supabase
        .from('fhip_import_proposals')
        .update({ status: 'applied', applied_at: new Date().toISOString() })
        .eq('id', proposalId)
        .eq('user_id', userId)
        .eq('status', 'ready')
        .select('id');
      if (error) return false;
      return (data?.length ?? 0) === 1;
    },

    async releaseProposal(userId, proposalId) {
      const supabase = await createClient();
      await supabase
        .from('fhip_import_proposals')
        .update({ status: 'ready', applied_at: null })
        .eq('id', proposalId)
        .eq('user_id', userId);
    },

    async dismissProposal(userId, proposalId) {
      const supabase = await createClient();
      await supabase
        .from('fhip_import_proposals')
        .update({ status: 'dismissed', dismissed_at: new Date().toISOString() })
        .eq('id', proposalId)
        .eq('user_id', userId)
        .eq('status', 'ready');
    },

    async createEntity(userId, domain, row) {
      const supabase = await createClient();
      const { data, error } = await supabase
        .from(tableFor(domain))
        .insert({ ...row, user_id: userId })
        .select('id')
        .single();
      if (error || !data) throw new Error(error?.message ?? 'could not create the entry');
      return data.id as string;
    },

    async updateEntity(userId, domain, entityId, patch) {
      const supabase = await createClient();
      const { error } = await supabase
        .from(tableFor(domain))
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', entityId)
        .eq('user_id', userId);
      if (error) throw new Error(error.message);
    },

    async recordApplication(userId, input) {
      const supabase = await createClient();
      const { data, error } = await supabase
        .from('fhip_import_applications')
        .insert({
          user_id: userId,
          proposal_id: input.proposalId,
          target_domain: input.targetDomain,
          target_entity_id: input.targetEntityId,
          apply_mode: input.applyMode satisfies PersistedApplyMode,
          applied_fields: input.appliedFields,
          previous_values: input.previousValues,
          new_values: input.newValues,
          source_payroll_event_id: input.sourcePayrollEventId,
          applied_by: userId,
        })
        .select('id')
        .single();
      if (error || !data) throw new Error(error?.message ?? 'could not record the import');
      return data.id as string;
    },

    async stampProvenance(userId, domain, entityId, applicationId) {
      const builder = PROVENANCE_BY_DOMAIN[domain as ImportTargetDomain];
      if (!builder) return;
      const supabase = await createClient();
      await supabase
        .from(tableFor(domain))
        .update(builder(applicationId))
        .eq('id', entityId)
        .eq('user_id', userId);
    },
  };
}

/**
 * Persist a freshly generated proposal.
 *
 * Kept separate from the store port because generation is not part of the
 * apply security boundary — a proposal is inert, so creating one needs no
 * compare-and-swap, no staleness gate and no allow-list.
 *
 * SUPERSESSION: any earlier 'ready' proposal for the same payroll event is
 * marked superseded first, so regenerating a preview cannot leave two live
 * proposals that could each be applied (spec section 34).
 */
export async function persistProposal(
  userId: string,
  draft: ImportProposalDraft,
  sourcePayrollEventId: string | null,
): Promise<string> {
  const supabase = await createClient();

  if (sourcePayrollEventId) {
    await supabase
      .from('fhip_import_proposals')
      .update({ status: 'superseded' })
      .eq('user_id', userId)
      .eq('source_payroll_event_id', sourcePayrollEventId)
      .eq('status', 'ready');
  }

  const { data, error } = await supabase
    .from('fhip_import_proposals')
    .insert({
      user_id: userId,
      target_domain: draft.targetDomain,
      source_kind: draft.sourceKind,
      source_payroll_event_id: sourcePayrollEventId,
      currency_code: draft.currencyCode,
      target_entity_id: draft.targetEntityId,
      target_entity_updated_at: draft.targetEntityUpdatedAt,
      recommended_apply_mode: draft.recommendedApplyMode,
      duplicate_of_entity_id: draft.duplicateOfEntityId,
      status: 'ready',
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(error?.message ?? 'could not create the proposal');

  const proposalId = data.id as string;
  if (draft.fields.length > 0) {
    const { error: fieldError } = await supabase.from('fhip_import_proposal_fields').insert(
      draft.fields.map((f) => ({
        user_id: userId,
        proposal_id: proposalId,
        field_name: f.fieldName,
        value_kind: f.valueKind,
        proposed_value: f.proposedValue,
        existing_value: f.existingValue,
        is_recommended: f.isRecommended,
        requires_confirmation: f.requiresConfirmation,
        confidence: f.confidence ?? null,
        reason_code: f.reasonCode,
      })),
    );
    if (fieldError) throw new Error(fieldError.message);
  }

  return proposalId;
}

/**
 * FDH-10 sibling of `persistProposal` for the LIABILITY domain (spec sections
 * 19-20, 41, 53-58). A small, deliberate duplication rather than widening
 * `persistProposal` with a union "source ref" parameter — the two functions
 * write to different provenance columns (`source_payroll_event_id` vs
 * `source_liability_statement_id`) on the SAME `fhip_import_proposals` table,
 * and `fdh10_apply_liability_proposal()` (migration 0096 Part I) reads
 * `v_proposal.source_liability_statement_id` directly when writing
 * `fhip_import_applications`, so this column must be populated at generation
 * time for correct provenance — never left null for a liability proposal.
 *
 * SUPERSESSION mirrors `persistProposal`: any earlier 'ready' proposal for the
 * same liability statement is marked superseded first, so regenerating a
 * comparison can never leave two live, independently-applicable proposals for
 * one statement (spec section 34's discipline, same as income).
 */
export async function persistRetirementProposal(
  userId: string,
  draft: ImportProposalDraft,
  sourceRetirementStatementId: string,
): Promise<string> {
  const supabase = await createClient();

  // SUPERSESSION mirrors the income and liability paths: any earlier 'ready'
  // proposal for the same retirement statement is marked superseded first, so
  // regenerating a comparison can never leave two live, independently
  // applicable proposals for one statement. Without this, "Apply" could be
  // pressed twice on two different proposals and update the same account
  // twice — the duplicate-apply hazard spec section 106 rules out.
  await supabase
    .from('fhip_import_proposals')
    .update({ status: 'superseded' })
    .eq('user_id', userId)
    .eq('source_retirement_statement_id', sourceRetirementStatementId)
    .eq('status', 'ready');

  const { data, error } = await supabase
    .from('fhip_import_proposals')
    .insert({
      user_id: userId,
      target_domain: draft.targetDomain,
      source_kind: draft.sourceKind,
      source_retirement_statement_id: sourceRetirementStatementId,
      currency_code: draft.currencyCode,
      target_entity_id: draft.targetEntityId,
      target_entity_updated_at: draft.targetEntityUpdatedAt,
      recommended_apply_mode: draft.recommendedApplyMode,
      duplicate_of_entity_id: draft.duplicateOfEntityId,
      status: 'ready',
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(error?.message ?? 'could not create the proposal');

  const proposalId = data.id as string;
  if (draft.fields.length > 0) {
    const { error: fieldError } = await supabase.from('fhip_import_proposal_fields').insert(
      draft.fields.map((f) => ({
        user_id: userId,
        proposal_id: proposalId,
        field_name: f.fieldName,
        value_kind: f.valueKind,
        proposed_value: f.proposedValue,
        existing_value: f.existingValue,
        is_recommended: f.isRecommended,
        requires_confirmation: f.requiresConfirmation,
        confidence: f.confidence ?? null,
        reason_code: f.reasonCode,
      })),
    );
    if (fieldError) throw new Error(fieldError.message);
  }

  return proposalId;
}

export async function persistLiabilityProposal(
  userId: string,
  draft: ImportProposalDraft,
  sourceLiabilityStatementId: string,
): Promise<string> {
  const supabase = await createClient();

  await supabase
    .from('fhip_import_proposals')
    .update({ status: 'superseded' })
    .eq('user_id', userId)
    .eq('source_liability_statement_id', sourceLiabilityStatementId)
    .eq('status', 'ready');

  const { data, error } = await supabase
    .from('fhip_import_proposals')
    .insert({
      user_id: userId,
      target_domain: draft.targetDomain,
      source_kind: draft.sourceKind,
      source_liability_statement_id: sourceLiabilityStatementId,
      currency_code: draft.currencyCode,
      target_entity_id: draft.targetEntityId,
      target_entity_updated_at: draft.targetEntityUpdatedAt,
      recommended_apply_mode: draft.recommendedApplyMode,
      duplicate_of_entity_id: draft.duplicateOfEntityId,
      status: 'ready',
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(error?.message ?? 'could not create the proposal');

  const proposalId = data.id as string;
  if (draft.fields.length > 0) {
    const { error: fieldError } = await supabase.from('fhip_import_proposal_fields').insert(
      draft.fields.map((f) => ({
        user_id: userId,
        proposal_id: proposalId,
        field_name: f.fieldName,
        value_kind: f.valueKind,
        proposed_value: f.proposedValue,
        existing_value: f.existingValue,
        is_recommended: f.isRecommended,
        requires_confirmation: f.requiresConfirmation,
        confidence: f.confidence ?? null,
        reason_code: f.reasonCode,
      })),
    );
    if (fieldError) throw new Error(fieldError.message);
  }

  return proposalId;
}
