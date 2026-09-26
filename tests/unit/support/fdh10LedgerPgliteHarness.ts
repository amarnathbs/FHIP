/**
 * WP-11 -- a real-Postgres (PGlite) harness for the FDH-10 ledger Apply.
 *
 * Replays this repository's own migration chain (the same technique as
 * tests/unit/aie1MalwareScanSweepSchedulerPglite.test.ts), with an optional
 * STOP before a named migration so a test can first observe the pre-fix
 * behaviour (the negative control) and then apply the fix on the SAME database.
 *
 * Seeding runs as the superuser with `service_role` claims (the r7 insert
 * block and the country gate let a trusted server writer through); every
 * call under test runs as `authenticated` with the tenant's own JWT, which is
 * how PostgREST calls an RPC.
 */
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SUPABASE_ROOT = path.resolve(HERE, '..', '..', '..', 'supabase');
export const MIG_DIR = path.join(SUPABASE_ROOT, 'migrations');
const SHIM = path.resolve(SUPABASE_ROOT, '..', 'scripts', 'db-rebuild-check', 'shim.sql');

export type Json = Record<string, unknown>;

export function migrationFiles(): string[] {
  return fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
}

export function migrationSql(file: string): string {
  return fs.readFileSync(path.join(MIG_DIR, file), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
}

/** Builds a database with every migration whose name sorts BEFORE `stopBefore` (all when omitted). */
export async function buildDb(stopBefore?: string): Promise<PGlite> {
  const db = await PGlite.create();
  await db.exec(fs.readFileSync(SHIM, 'utf8'));
  const seed = fs.readFileSync(path.join(SUPABASE_ROOT, 'seed.sql'), 'utf8');
  for (const f of migrationFiles()) {
    if (stopBefore && f >= stopBefore) break;
    await db.exec(migrationSql(f));
    if (f.startsWith('0001')) await db.exec(seed);
  }
  return db;
}

export class Fdh10Harness {
  constructor(readonly db: PGlite) {}

  async asService<T>(fn: () => Promise<T>): Promise<T> {
    await this.db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: 'service_role' })]);
    return fn();
  }

  async asTenant<T>(uid: string, fn: () => Promise<T>): Promise<T> {
    await this.db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
    await this.db.exec('set role authenticated;');
    try {
      return await fn();
    } finally {
      await this.db.exec('reset role;');
      await this.db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ role: 'service_role' })]);
    }
  }

  async one<T = Json>(sql: string, params: unknown[] = []): Promise<T> {
    const r = await this.db.query<T>(sql, params);
    return r.rows[0];
  }

  async all<T = Json>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.db.query<T>(sql, params)).rows;
  }

  async user(uid: string, country: 'AU' | 'IN' = 'AU'): Promise<string> {
    await this.asService(async () => {
      await this.db.query(`insert into auth.users(id, email) values ($1, $2) on conflict do nothing`, [uid, `${uid}@t.test`]);
      await this.db.query(
        `update user_profiles set country_of_residence=$2, country_confirmed_at=now(), country_source='USER_CONFIRMED', country_updated_at=now() where user_id=$1`,
        [uid, country],
      );
    });
    return uid;
  }

  /** A bank account with one approved statement covering [start, end]. */
  async bankAccount(uid: string, opts: { start?: string; end?: string; currency?: string } = {}): Promise<{ accountId: string; uploadId: string }> {
    return this.asService(async () => {
      const acc = await this.one<{ id: string }>(
        `insert into fdh_financial_accounts (user_id, account_type, country_code, currency_code, display_name)
         values ($1, 'transaction', 'AU', $2, 'Everyday') returning id`, [uid, opts.currency ?? 'AUD']);
      const up = await this.one<{ id: string }>(
        `insert into fdh_statement_uploads (user_id, source_type, document_type, country_code, currency_code, mime_type, processing_status,
                                            financial_account_id, statement_period_start, statement_period_end)
         values ($1, 'csv', 'bank_statement', 'AU', $2, 'text/csv', 'approved', $3, $4, $5) returning id`,
        [uid, opts.currency ?? 'AUD', acc.id, opts.start ?? '2026-08-01', opts.end ?? '2026-08-31']);
      return { accountId: acc.id, uploadId: up.id };
    });
  }

  async bankDebit(uid: string, bank: { accountId: string; uploadId: string }, amount: number, date: string, opts: { type?: string; approved?: boolean; currency?: string; description?: string; openLink?: boolean } = {}): Promise<string> {
    return this.asService(async () => {
      const approved = opts.approved ?? true;
      const t = await this.one<{ id: string }>(
        `insert into fdh_transactions (user_id, financial_account_id, statement_upload_id, transaction_date, amount_original, currency_original,
                                       credit_debit, economic_transaction_type, description_raw, description_clean,
                                       approval_status, approved_at, approved_by)
         values ($1, $2, $3, $4, $5, $6, 'debit', $7, $8, $8, $9, case when $9 = 'approved' then now() end, case when $9 = 'approved' then $1::uuid end)
         returning id`,
        [uid, bank.accountId, bank.uploadId, date, amount, opts.currency ?? 'AUD', opts.type ?? 'expense', opts.description ?? 'PAYMENT TO CARD', approved ? 'approved' : 'pending']);
      if (opts.openLink) {
        await this.db.query(
          `insert into fdh_transaction_links (user_id, transaction_id_from, transaction_id_to, link_type, confidence, status, created_by_method, user_confirmed)
           values ($1, $2, null, 'credit_card_settlement', 0.5, 'confirmed', 'algorithm', true)`, [uid, t.id]);
      }
      return t.id;
    });
  }

  /**
   * An APPROVED card/loan statement with its activities, and a READY proposal
   * for it (the state the Liabilities panel is in when the user clicks Apply).
   */
  async statementWithProposal(uid: string, spec: {
    statementType?: 'credit_card' | 'loan';
    facilityType?: string;
    currency?: string;
    periodStart?: string;
    periodEnd?: string;
    closing?: number;
    activities: Array<Json & { activity_type: string; amount: number; activity_date?: string }>;
    targetLiabilityId?: string | null;
    fields?: Array<{ field_name: string; value_kind: string; proposed_value: string | null; existing_value?: string | null; is_recommended?: boolean; requires_confirmation?: boolean }>;
    approved?: boolean;
  }): Promise<{ uploadId: string; statementId: string; proposalId: string; activityIds: string[] }> {
    const statementType = spec.statementType ?? 'credit_card';
    const currency = spec.currency ?? 'AUD';
    return this.asService(async () => {
      const up = await this.one<{ id: string }>(
        `insert into fdh_statement_uploads (user_id, source_type, document_type, country_code, currency_code, mime_type, processing_status)
         values ($1, 'csv', $2, 'AU', $3, 'text/csv', 'extracted') returning id`,
        [uid, statementType === 'credit_card' ? 'credit_card_statement' : 'loan_statement', currency]);
      const st = await this.one<{ id: string }>(
        `insert into fdh_liability_statements (user_id, statement_upload_id, statement_type, facility_type, country_code, currency_code,
            institution_name, masked_identifier, statement_period_start, statement_period_end, closing_balance, closing_principal,
            approval_status, approved_at, approved_by)
         values ($1, $2, $3, $4, 'AU', $5, 'Test Bank', 'xx1234', $6, $7, $8, $9, $10, case when $10 = 'approved' then now() end, case when $10 = 'approved' then $1::uuid end)
         returning id`,
        [uid, up.id, statementType, spec.facilityType ?? (statementType === 'credit_card' ? 'credit_card' : 'personal_loan'), currency,
          spec.periodStart ?? '2026-08-01', spec.periodEnd ?? '2026-08-31',
          statementType === 'credit_card' ? spec.closing ?? 1000 : null, statementType === 'loan' ? spec.closing ?? 20000 : null,
          spec.approved === false ? 'pending' : 'approved']);
      const activityIds: string[] = [];
      let row = 0;
      for (const a of spec.activities) {
        row += 1;
        const ins = await this.one<{ id: string }>(
          `insert into fdh_liability_statement_activities (user_id, statement_id, activity_type, activity_date, amount, currency_code,
              description_raw, merchant_raw, principal_component, interest_component, fee_component, linked_transaction_id,
              bank_match_status, bank_match_candidate_ids, source_row_number)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) returning id`,
          [uid, st.id, a.activity_type, a.activity_date ?? '2026-08-10', a.amount, currency,
            (a.description_raw as string | undefined) ?? `${a.activity_type} line ${row}`, (a.merchant_raw as string | undefined) ?? null,
            a.principal_component ?? null, a.interest_component ?? null, a.fee_component ?? null,
            a.linked_transaction_id ?? null, (a.bank_match_status as string | undefined) ?? 'not_attempted',
            (a.bank_match_candidate_ids as string[] | undefined) ?? null, row]);
        activityIds.push(ins.id);
      }
      const fields = spec.fields ?? [
        { field_name: 'liability_name', value_kind: 'text', proposed_value: statementType === 'credit_card' ? 'Test Card' : 'Test Loan' },
        { field_name: 'debt_type', value_kind: 'enum', proposed_value: statementType === 'credit_card' ? 'credit_card' : 'personal_loan' },
        { field_name: 'balance', value_kind: 'money', proposed_value: String(spec.closing ?? (statementType === 'credit_card' ? 1000 : 20000)) },
        { field_name: 'currency_code', value_kind: 'enum', proposed_value: currency },
        { field_name: 'country_code', value_kind: 'enum', proposed_value: 'AU' },
      ];
      const pr = await this.one<{ id: string }>(
        `insert into fhip_import_proposals (user_id, target_domain, source_kind, source_liability_statement_id, currency_code,
            target_entity_id, recommended_apply_mode, status)
         values ($1, 'liability', $2, $3, $4, $5, $6, 'ready') returning id`,
        [uid, statementType === 'credit_card' ? 'credit_card_statement' : 'loan_statement', st.id, currency,
          spec.targetLiabilityId ?? null, spec.targetLiabilityId ? 'update_existing' : 'add_new']);
      for (const f of fields) {
        await this.db.query(
          `insert into fhip_import_proposal_fields (user_id, proposal_id, field_name, value_kind, proposed_value, existing_value, is_recommended, requires_confirmation)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [uid, pr.id, f.field_name, f.value_kind, f.proposed_value, f.existing_value ?? null, f.is_recommended ?? true, f.requires_confirmation ?? false]);
      }
      return { uploadId: up.id, statementId: st.id, proposalId: pr.id, activityIds };
    });
  }

  async liability(uid: string, row: Json): Promise<string> {
    return this.asService(async () => (await this.one<{ id: string }>(
      `insert into liabilities (user_id, liability_name, debt_type, balance, monthly_repayment, currency_code, country_code, owner, minimum_payment)
       values ($1, $2, $3, $4, $5, $6, 'AU', $7, $8) returning id`,
      [uid, row.liability_name ?? 'Existing', row.debt_type ?? 'credit_card', row.balance ?? 500, row.monthly_repayment ?? 0,
        row.currency_code ?? 'AUD', row.owner ?? 'self', row.minimum_payment ?? null])).id);
  }

  async apply(uid: string, proposalId: string, decision: string, opts: { fields?: string[] | null; owner?: string | null; ack?: boolean } = {}): Promise<Json> {
    return this.asTenant(uid, async () => (await this.one<{ r: Json }>(
      `select fdh10_apply_liability_proposal($1::uuid, $2, $3::text[], $4, $5) r`,
      [proposalId, decision, opts.fields ?? null, opts.owner ?? null, opts.ack ?? false])).r);
  }

  /** The pre-0209 (0096) three-argument call shape. */
  async applyLegacy(uid: string, proposalId: string, decision: string, fields: string[] | null = null): Promise<Json> {
    return this.asTenant(uid, async () => (await this.one<{ r: Json }>(
      `select fdh10_apply_liability_proposal($1::uuid, $2, $3::text[]) r`, [proposalId, decision, fields])).r);
  }

  async count(sql: string, params: unknown[] = []): Promise<number> {
    return Number((await this.one<{ n: number | string }>(sql, params)).n);
  }

  /** PostgREST-shaped rows (via to_jsonb: numerics as numbers, dates as ISO strings) for the read models. */
  async readModelTables(uid: string): Promise<Record<string, Json[]>> {
    const userTables = [
      'fdh_financial_accounts', 'fdh_transactions', 'fdh_transaction_allocations', 'fdh_transaction_links', 'fdh_statement_uploads',
      'fdh_liability_statements', 'fdh_liability_statement_activities', 'fdh_payroll_events', 'fdh_investment_statement_activities',
      'fdh_investment_statements', 'fdh_retirement_statement_activities', 'fdh_retirement_statements', 'liabilities',
      'property_liability_links', 'expense_items', 'income_sources', 'assets', 'investments', 'retirement_accounts',
      'fhip_import_applications',
    ];
    const out: Record<string, Json[]> = {};
    await this.asService(async () => {
      for (const t of userTables) {
        out[t] = (await this.all<{ j: Json }>(`select to_jsonb(x) j from ${t} x where x.user_id = $1`, [uid])).map((r) => r.j);
      }
      out.fdh_categories = (await this.all<{ j: Json }>(`select to_jsonb(x) j from fdh_categories x`)).map((r) => r.j);
      out.fdh_subcategories = (await this.all<{ j: Json }>(`select to_jsonb(x) j from fdh_subcategories x`)).map((r) => r.j);
    });
    out.user_profiles = [{ user_id: uid, preferred_currency: 'AUD', country_of_residence: 'AU' }];
    out.forecast_global_assumptions = [{ assumption_key: 'fx_rate_aud_inr', assumption_value: 56, is_active: true, country_code: null }];
    return out;
  }
}
