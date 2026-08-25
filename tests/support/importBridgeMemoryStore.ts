/**
 * FDH-9 — an in-memory `ImportBridgeStore` for certifying the apply guard.
 *
 * This harness deliberately MODELS THE DATABASE'S OWN GUARANTEES rather than
 * being a permissive stub, because a stub that says yes to everything cannot
 * certify a security boundary:
 *
 *   - every read is scoped by `user_id`, exactly as the Supabase store's
 *     `.eq('user_id', userId)` + RLS are (so a cross-tenant read returns null);
 *   - `claimProposal` is a genuine compare-and-swap;
 *   - `recordApplication` enforces `UNIQUE(proposal_id)`, the same constraint
 *     migration 0091 declares;
 *   - `updateEntity` refuses to touch a row owned by another user, mirroring
 *     the same-tenant triggers.
 *
 * It also records every canonical-register write, so a test can assert that a
 * flow performed EXACTLY ZERO writes — which is how the never-silent-write
 * negative controls are proved rather than asserted.
 */

import type { ImportBridgeStore, StoredProposal } from '@/lib/import-bridge/applyService';
import type { PersistedApplyMode } from '@/lib/import-bridge/types';

export interface MemoryIncomeRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  source_name: string;
  income_type: string;
  amount: number;
  net_amount: number | null;
  frequency: string;
  currency_code: string;
  owner: string;
  is_taxable: boolean;
  employer_name: string | null;
  notes: string | null;
  master_item_key: string | null;
  source_type: string;
  is_active: boolean;
  last_import_application_id?: string | null;
  last_imported_at?: string | null;
  updated_at?: string | null;
}

export interface RecordedApplication {
  id: string;
  userId: string;
  proposalId: string;
  targetDomain: string;
  targetEntityId: string;
  applyMode: PersistedApplyMode;
  appliedFields: string[];
  previousValues: Record<string, string | null>;
  newValues: Record<string, string | null>;
  sourcePayrollEventId: string | null;
}

/** Every mutation attempted against a canonical register. */
export interface RegisterWrite {
  kind: 'insert' | 'update' | 'provenance';
  userId: string;
  domain: string;
  entityId: string;
  payload: Record<string, unknown>;
}

export class ImportBridgeMemoryStore implements ImportBridgeStore {
  readonly proposals = new Map<string, StoredProposal>();
  readonly incomeRows = new Map<string, MemoryIncomeRow>();
  readonly applications: RecordedApplication[] = [];
  /** THE AUDIT THE NEGATIVE CONTROLS ASSERT ON. */
  readonly registerWrites: RegisterWrite[] = [];

  private seq = 0;

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  addProposal(proposal: StoredProposal): StoredProposal {
    this.proposals.set(proposal.id, { ...proposal, fields: proposal.fields.map((f) => ({ ...f })) });
    return this.proposals.get(proposal.id)!;
  }

  addIncome(row: MemoryIncomeRow): MemoryIncomeRow {
    this.incomeRows.set(row.id, { ...row });
    return this.incomeRows.get(row.id)!;
  }

  /** Snapshot of a row, for before/after comparison in a negative control. */
  snapshot(id: string): MemoryIncomeRow | undefined {
    const row = this.incomeRows.get(id);
    return row ? { ...row } : undefined;
  }

  // --- ImportBridgeStore ----------------------------------------------------

  async loadProposal(userId: string, proposalId: string): Promise<StoredProposal | null> {
    const proposal = this.proposals.get(proposalId);
    // Ownership scoping — a cross-tenant read finds nothing, exactly as RLS
    // plus `.eq('user_id', userId)` behaves against Postgres.
    if (!proposal || proposal.userId !== userId) return null;
    return { ...proposal, fields: proposal.fields.map((f) => ({ ...f })) };
  }

  async loadTargetRow(userId: string, domain: string, entityId: string): Promise<Record<string, unknown> | null> {
    if (domain !== 'income') return null;
    const row = this.incomeRows.get(entityId);
    if (!row || row.user_id !== userId) return null;
    return { ...row };
  }

  async claimProposal(userId: string, proposalId: string): Promise<boolean> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.userId !== userId) return false;
    if (proposal.status !== 'ready') return false;
    proposal.status = 'applied';
    return true;
  }

  async releaseProposal(userId: string, proposalId: string): Promise<void> {
    const proposal = this.proposals.get(proposalId);
    if (proposal && proposal.userId === userId) proposal.status = 'ready';
  }

  async dismissProposal(userId: string, proposalId: string): Promise<void> {
    const proposal = this.proposals.get(proposalId);
    if (proposal && proposal.userId === userId && proposal.status === 'ready') {
      proposal.status = 'dismissed';
    }
  }

  async createEntity(userId: string, domain: string, row: Record<string, unknown>): Promise<string> {
    if (domain !== 'income') throw new Error(`no register for ${domain}`);
    const id = this.nextId('income');
    const created: MemoryIncomeRow = {
      id,
      user_id: userId,
      source_name: String(row.source_name ?? ''),
      income_type: String(row.income_type ?? 'other'),
      amount: Number(row.amount ?? 0),
      net_amount: row.net_amount === undefined || row.net_amount === null ? null : Number(row.net_amount),
      frequency: String(row.frequency ?? 'monthly'),
      currency_code: String(row.currency_code ?? 'AUD'),
      owner: String(row.owner ?? 'self'),
      is_taxable: row.is_taxable !== false,
      employer_name: (row.employer_name as string | null) ?? null,
      notes: (row.notes as string | null) ?? null,
      master_item_key: (row.master_item_key as string | null) ?? null,
      source_type: String(row.source_type ?? 'manual'),
      is_active: row.is_active !== false,
      updated_at: new Date().toISOString(),
    };
    this.incomeRows.set(id, created);
    this.registerWrites.push({ kind: 'insert', userId, domain, entityId: id, payload: { ...row } });
    return id;
  }

  async updateEntity(userId: string, domain: string, entityId: string, patch: Record<string, unknown>): Promise<void> {
    if (domain !== 'income') throw new Error(`no register for ${domain}`);
    const row = this.incomeRows.get(entityId);
    // Same-tenant enforcement, mirroring migration 0091's triggers.
    if (!row || row.user_id !== userId) throw new Error('cross-tenant or missing target');
    Object.assign(row, patch, { updated_at: new Date().toISOString() });
    this.registerWrites.push({ kind: 'update', userId, domain, entityId, payload: { ...patch } });
  }

  async recordApplication(userId: string, input: Parameters<ImportBridgeStore['recordApplication']>[1]): Promise<string> {
    // UNIQUE(proposal_id) — the database-level idempotency guarantee.
    if (this.applications.some((a) => a.proposalId === input.proposalId)) {
      throw new Error('duplicate key value violates unique constraint "uq_fhip_import_applications_proposal"');
    }
    const id = this.nextId('application');
    this.applications.push({
      id,
      userId,
      proposalId: input.proposalId,
      targetDomain: input.targetDomain,
      targetEntityId: input.targetEntityId,
      applyMode: input.applyMode,
      appliedFields: [...input.appliedFields],
      previousValues: { ...input.previousValues },
      newValues: { ...input.newValues },
      sourcePayrollEventId: input.sourcePayrollEventId,
    });
    return id;
  }

  async stampProvenance(userId: string, domain: string, entityId: string, applicationId: string): Promise<void> {
    const row = this.incomeRows.get(entityId);
    if (!row || row.user_id !== userId) return;
    row.source_type = 'payslip_import';
    row.last_import_application_id = applicationId;
    row.last_imported_at = new Date().toISOString();
    this.registerWrites.push({ kind: 'provenance', userId, domain, entityId, payload: { applicationId } });
  }
}
