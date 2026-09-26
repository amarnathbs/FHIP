/**
 * WP-15 -- the Input Population Proposal service (server-only).
 *
 * Preview -> Compare -> User Approval -> Apply, exactly the import-bridge
 * contract (lib/import-bridge/types.ts):
 *   preview*    reads only; nothing is written.
 *   generate*   persists INERT proposals (fhip_import_proposals + fields),
 *               superseding any earlier ready ones for the same source, so
 *               two live proposals can never both be applied.
 *   apply*      ONE call to the atomic SECURITY DEFINER RPC of migration 0214
 *               (fdh15_apply_expense_proposals / fdh15_apply_asset_proposal);
 *               correctness (lock, compare-and-swap, staleness, allow-list,
 *               audit row, provenance) lives in the RPC, not here.
 *
 * Every read goes through the canonical read models (the same ledger, window,
 * FX and coverage the Expenses tab and Dashboard use), with the caller's
 * RLS-scoped client and an explicit user_id filter.
 */
import '@/lib/serverOnly';
import { resolveContext } from '@/lib/read-models/core/context';
import { fetchAllRows, type ReadModelClient } from '@/lib/read-models/core/paginate';
import { toUnavailable, type ReadModelUnavailable } from '@/lib/read-models/core/types';
import { computeAssets, loadAssetInputs, type BankAccountRow } from '@/lib/read-models/assets';
import {
  buildBankBalanceProposals,
  buildExpensePopulation,
  type AssetRowForProposal,
  type BankBalanceProposalItem,
  type ExpensePopulationResult,
  type PlannedItemRow,
  type PriorAssetProposal,
} from './populationProposals';
import type { ImportApplyErrorCode, ImportProposalDraft, UserApplyDecision } from './types';

/** The Supabase surface this service needs (cookie or test client). */
export type PopulationClient = ReadModelClient & {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export type ServiceResult<T> = ({ status: 'ok' } & T) | ReadModelUnavailable;

// ---------------------------------------------------------------------------
// (a) Planned expenses from actual averages
// ---------------------------------------------------------------------------

async function loadPlannedRows(userId: string, client: ReadModelClient): Promise<PlannedItemRow[]> {
  return fetchAllRows<PlannedItemRow>('expense_items', (from, to) =>
    client
      .from('expense_items')
      .select('id, expense_name, master_item_key, amount, frequency, currency_code, is_active, is_essential, owner, superseded_by_bank_import, updated_at')
      .eq('user_id', userId)
      .not('master_item_key', 'is', null)
      .order('id', { ascending: true })
      .range(from, to));
}

async function loadMasterLabels(client: ReadModelClient): Promise<Map<string, string>> {
  const rows = await fetchAllRows<{ item_key: string; item_label: string }>('master_financial_items', (from, to) =>
    client.from('master_financial_items').select('item_key, item_label').eq('category', 'expense').order('item_key', { ascending: true }).range(from, to));
  return new Map(rows.map((r) => [r.item_key, r.item_label]));
}

export async function previewExpensePopulation(userId: string, client: ReadModelClient, opts: { now?: Date } = {}): Promise<ServiceResult<ExpensePopulationResult>> {
  try {
    const ctx = await resolveContext(userId, { client, now: opts.now });
    const [ledger, plannedRows, masterLabels] = await Promise.all([ctx.ledger(), loadPlannedRows(userId, client), loadMasterLabels(client)]);
    return { status: 'ok', ...buildExpensePopulation({ ledger, plannedRows, fx: ctx.fx, masterLabels }) };
  } catch (error) {
    return toUnavailable(error, 'previewExpensePopulation');
  }
}

interface PersistSource {
  statementUploadId?: string | null;
  windowFrom?: string | null;
  windowTo?: string | null;
}

async function persistDraft(client: PopulationClient, userId: string, draft: ImportProposalDraft, source: PersistSource): Promise<string> {
  const { data, error } = await client
    .from('fhip_import_proposals')
    .insert({
      user_id: userId,
      target_domain: draft.targetDomain,
      source_kind: draft.sourceKind,
      source_statement_upload_id: source.statementUploadId ?? null,
      source_window_from: source.windowFrom ?? null,
      source_window_to: source.windowTo ?? null,
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
  const proposalId = (data as { id: string }).id;
  if (draft.fields.length > 0) {
    const { error: fieldError } = await client.from('fhip_import_proposal_fields').insert(
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
    if (fieldError) {
      // A proposal without its fields must never be applicable: close it.
      await client.from('fhip_import_proposals').update({ status: 'dismissed', dismissed_at: new Date().toISOString() }).eq('id', proposalId).eq('user_id', userId).eq('status', 'ready');
      throw new Error(fieldError.message);
    }
  }
  return proposalId;
}

export interface GeneratedExpenseProposals extends ExpensePopulationResult {
  proposalIds: Record<string, string>;
}

/**
 * Persists one inert proposal per planned item that would change (add or
 * update). Items that already match are shown, never persisted. Earlier
 * ready expense proposals are superseded first.
 */
export async function generateExpenseProposals(userId: string, client: PopulationClient, opts: { now?: Date } = {}): Promise<ServiceResult<GeneratedExpenseProposals>> {
  const preview = await previewExpensePopulation(userId, client, opts);
  if (preview.status !== 'ok') return preview;
  try {
    const { error } = await client
      .from('fhip_import_proposals')
      .update({ status: 'superseded' })
      .eq('user_id', userId)
      .eq('target_domain', 'expense')
      .eq('source_kind', 'bank_statement')
      .eq('status', 'ready');
    if (error) throw new Error(error.message);
    const proposalIds: Record<string, string> = {};
    for (const item of preview.items) {
      if (item.recommended === 'keep_existing') continue;
      proposalIds[item.masterItemKey] = await persistDraft(client, userId, item.draft, { windowFrom: preview.window.from, windowTo: preview.window.to });
    }
    return { ...preview, proposalIds };
  } catch {
    return { status: 'unavailable', reason: 'proposal_write_failed', source: 'fhip_import_proposals' };
  }
}

export interface ApplyDecision {
  proposalId: string;
  decision: UserApplyDecision;
  selectedFields?: string[];
}

export type ApplyOutcome =
  | { ok: true; results: { proposalId: string; outcome: 'applied' | 'kept_existing'; targetEntityId: string | null }[] }
  | { ok: false; code: ImportApplyErrorCode | 'SQL_ERROR'; error: string; proposalId?: string | null; field?: string | null; rolledBack?: boolean };

interface RpcOne {
  ok: boolean;
  code?: string;
  error?: string;
  outcome?: 'applied' | 'kept_existing';
  proposal_id?: string;
  target_entity_id?: string;
  field?: string;
  rolled_back?: boolean;
  results?: RpcOne[];
}

function refusal(r: RpcOne): ApplyOutcome {
  return {
    ok: false,
    code: (r.code as ImportApplyErrorCode | undefined) ?? 'WRITE_FAILED',
    error: r.error ?? 'The change could not be saved.',
    proposalId: r.proposal_id ?? null,
    field: r.field ?? null,
    rolledBack: Boolean(r.rolled_back),
  };
}

/** The batch is all-or-nothing (the RPC rolls every decision back on the first refusal). */
export async function applyExpenseProposals(client: PopulationClient, decisions: readonly ApplyDecision[]): Promise<ApplyOutcome> {
  const { data, error } = await client.rpc('fdh15_apply_expense_proposals', {
    p_decisions: decisions.map((d) => ({
      proposal_id: d.proposalId,
      decision: d.decision,
      ...(d.selectedFields && d.selectedFields.length > 0 ? { selected_fields: d.selectedFields } : {}),
    })),
  });
  if (error) return { ok: false, code: 'WRITE_FAILED', error: error.message };
  const r = data as RpcOne;
  if (!r?.ok) return refusal(r ?? { ok: false });
  return {
    ok: true,
    results: (r.results ?? []).map((x) => ({ proposalId: x.proposal_id ?? '', outcome: x.outcome ?? 'applied', targetEntityId: x.target_entity_id ?? null })),
  };
}

// ---------------------------------------------------------------------------
// (b) Bank balance -> cash asset
// ---------------------------------------------------------------------------

const ASSET_COLUMNS = 'id, asset_name, asset_class, master_item_key, current_value, currency_code, valuation_date, owner, is_active, source_type, source_financial_account_id, updated_at';

async function loadAssetRows(userId: string, client: ReadModelClient): Promise<AssetRowForProposal[]> {
  return fetchAllRows<AssetRowForProposal>('assets', (from, to) =>
    client.from('assets').select(ASSET_COLUMNS).eq('user_id', userId).order('id', { ascending: true }).range(from, to));
}

async function loadPriorAssetProposals(userId: string, client: ReadModelClient): Promise<PriorAssetProposal[]> {
  return fetchAllRows<PriorAssetProposal>('fhip_import_proposals', (from, to) =>
    client
      .from('fhip_import_proposals')
      .select('source_statement_upload_id, status')
      .eq('user_id', userId)
      .eq('target_domain', 'asset')
      .eq('source_kind', 'bank_statement')
      .order('id', { ascending: true })
      .range(from, to));
}

export async function previewBankBalances(
  userId: string,
  client: ReadModelClient,
  opts: { targetAssetIdByAccount?: ReadonlyMap<string, string> } = {},
): Promise<ServiceResult<{ reportingCurrency: string; items: BankBalanceProposalItem[] }>> {
  try {
    const ctx = await resolveContext(userId, { client });
    const bankAccounts = await fetchAllRows<BankAccountRow>('fdh_financial_accounts', (from, to) =>
      client.from('fdh_financial_accounts').select('id, account_type, display_name, currency_code, owner_role, liability_id').eq('user_id', userId).order('id', { ascending: true }).range(from, to));
    const inputs = await loadAssetInputs(userId, client, bankAccounts);
    const evidence = computeAssets({ ...inputs, fx: ctx.fx }).bankBalanceEvidence.accounts;
    const [assets, prior] = await Promise.all([loadAssetRows(userId, client), loadPriorAssetProposals(userId, client)]);
    return { status: 'ok', reportingCurrency: ctx.fx.reportingCurrency, items: buildBankBalanceProposals({ evidence, assets, prior, targetAssetIdByAccount: opts.targetAssetIdByAccount }) };
  } catch (error) {
    return toUnavailable(error, 'previewBankBalances');
  }
}

/**
 * Persists the proposal for ONE account (the user just asked to add or
 * update it), superseding any earlier ready proposal for that statement.
 */
export async function generateBankBalanceProposal(
  userId: string,
  client: PopulationClient,
  accountId: string,
  targetAssetId: string | null,
): Promise<ServiceResult<{ item: BankBalanceProposalItem; proposalId: string | null }>> {
  const preview = await previewBankBalances(userId, client, { targetAssetIdByAccount: targetAssetId ? new Map([[accountId, targetAssetId]]) : undefined });
  if (preview.status !== 'ok') return preview;
  const item = preview.items.find((i) => i.accountId === accountId);
  if (!item) return { status: 'unavailable', reason: 'account_not_found', source: 'fdh_financial_accounts' };
  if (!item.draft) return { status: 'ok', item, proposalId: null };
  try {
    const { error } = await client
      .from('fhip_import_proposals')
      .update({ status: 'superseded' })
      .eq('user_id', userId)
      .eq('target_domain', 'asset')
      .eq('source_statement_upload_id', item.statementUploadId)
      .eq('status', 'ready');
    if (error) throw new Error(error.message);
    const proposalId = await persistDraft(client, userId, item.draft, { statementUploadId: item.statementUploadId });
    return { status: 'ok', item, proposalId };
  } catch {
    return { status: 'unavailable', reason: 'proposal_write_failed', source: 'fhip_import_proposals' };
  }
}

export async function applyBankBalanceProposal(client: PopulationClient, request: ApplyDecision): Promise<ApplyOutcome> {
  const { data, error } = await client.rpc('fdh15_apply_asset_proposal', {
    p_proposal_id: request.proposalId,
    p_decision: request.decision,
    p_selected_fields: request.selectedFields && request.selectedFields.length > 0 ? request.selectedFields : null,
  });
  if (error) return { ok: false, code: 'WRITE_FAILED', error: error.message };
  const r = data as RpcOne;
  if (!r?.ok) return refusal(r ?? { ok: false });
  return { ok: true, results: [{ proposalId: request.proposalId, outcome: r.outcome ?? 'applied', targetEntityId: r.target_entity_id ?? null }] };
}
