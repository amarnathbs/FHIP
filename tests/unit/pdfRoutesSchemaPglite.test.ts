/**
 * The PDF routes need NO migration. This proves it on a real Postgres engine (PGlite) with this repository's whole migration chain: every
 * value the PDF routes write already satisfies the existing CHECK constraints, triggers and the transition guard.
 *
 *   - upload rows: source_type pdf_native, mime application/pdf, every document type of the three classes;
 *   - every status edge the PDF resolvers use (queued -> rejected, queued -> failed), with every error code they store;
 *   - the verified-deletion purge sequence (pending -> in_progress -> purged) and its patch;
 *   - every audit event type they record;
 *   - the broker statement types and the retirement statement types the PDF readers write, including reconciliation `variance` and review `pending`;
 *   - a draft row for each class;
 *   - the REAL liability persist function (fdh10_persist_liability_statement) accepts the PDF reader's statement row and activities.
 * Negative control: a made-up error code and a made-up event type ARE refused (so this is not a database that accepts anything).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDb, Fdh10Harness } from './support/fdh10LedgerPgliteHarness';
import { buildStatementUploadPurgePatch } from '@/lib/financial-data-hub/domain/privacy';
import { PDF_FAILURE_ERROR_CODE } from '@/lib/financial-data-hub/pdf-statements';

let h: Fdh10Harness;
const U = '00000000-0000-4000-8000-0000000000a1';

beforeAll(async () => {
  h = new Fdh10Harness(await buildDb());
  await h.user(U);
}, 600_000);
afterAll(async () => { await h.db.close(); });

const DOC_TYPES = ['credit_card_statement', 'loan_statement', 'super_statement', 'epf_statement', 'investment_statement'] as const;

async function newUpload(documentType: string, country = 'AU', currency = 'AUD'): Promise<string> {
  return h.asService(async () => {
    const r = await h.one<{ id: string }>(
      `insert into fdh_statement_uploads (user_id, source_type, document_type, country_code, currency_code, mime_type, processing_status, raw_document_storage_reference)
       values ($1, 'pdf_native', $2, $3, $4, 'application/pdf', 'created', $5) returning id`,
      [U, documentType, country, currency, `${U}/${Math.random().toString(36).slice(2)}.bin`]);
    return r.id;
  });
}
async function walk(id: string, ...statuses: string[]) {
  await h.asService(async () => { for (const s of statuses) await h.db.query(`update fdh_statement_uploads set processing_status = $2 where id = $1`, [id, s]); });
}

describe('uploads, statuses, error codes, purge (every value the PDF resolvers write)', () => {
  it('a pdf_native upload of each class walks created -> uploaded -> validating -> queued', async () => {
    for (const t of DOC_TYPES) {
      const id = await newUpload(t, t === 'epf_statement' ? 'IN' : 'AU', t === 'epf_statement' ? 'INR' : 'AUD');
      await walk(id, 'uploaded', 'validating', 'queued');
      const r = await h.one<{ processing_status: string; source_type: string }>(`select processing_status, source_type from fdh_statement_uploads where id = $1`, [id]);
      expect(r).toMatchObject({ processing_status: 'queued', source_type: 'pdf_native' });
    }
  });

  it('every stored error code of the PDF outcomes is accepted, on the terminal refusal edge (queued -> rejected) and the failed edge (queued -> failed)', async () => {
    const codes = [...new Set(Object.values(PDF_FAILURE_ERROR_CODE))];
    expect(codes.length).toBeGreaterThanOrEqual(6);
    for (const code of codes) {
      for (const target of ['rejected', 'failed']) {
        const id = await newUpload('credit_card_statement');
        await walk(id, 'uploaded', 'validating', 'queued');
        await h.asService(() => h.db.query(`update fdh_statement_uploads set processing_status = $2, error_code = $3, review_status = 'pending' where id = $1`, [id, target, code]));
        const r = await h.one<{ processing_status: string; error_code: string }>(`select processing_status, error_code from fdh_statement_uploads where id = $1`, [id]);
        expect(r).toEqual({ processing_status: target, error_code: code });
      }
    }
  });

  it('NEGATIVE CONTROL: an unknown error code is refused by the same constraint (the database is not accepting everything)', async () => {
    const id = await newUpload('credit_card_statement');
    await walk(id, 'uploaded', 'validating', 'queued');
    await expect(h.asService(() => h.db.query(`update fdh_statement_uploads set error_code = 'not_a_real_code' where id = $1`, [id]))).rejects.toThrow(/error_code|check/i);
  });

  it('the verified-deletion sequence (pending -> in_progress -> purged with the privacy patch) is accepted, and a purged row keeps no storage reference', async () => {
    const id = await newUpload('super_statement');
    await walk(id, 'uploaded', 'validating', 'queued');
    const patch = buildStatementUploadPurgePatch(new Date().toISOString()) as Record<string, string | null>;
    await h.asService(async () => {
      await h.db.query(`update fdh_statement_uploads set raw_document_purge_status = 'pending', raw_document_purge_due_at = now(), purge_reason = 'pdf_statement_read_durable_result' where id = $1`, [id]);
      await h.db.query(`update fdh_statement_uploads set raw_document_purge_status = 'in_progress' where id = $1`, [id]);
      await h.db.query(
        `update fdh_statement_uploads set raw_document_storage_reference = $2, original_filename_sanitised = $3, raw_document_purge_status = $4, raw_document_purged_at = $5 where id = $1`,
        [id, patch.raw_document_storage_reference, patch.original_filename_sanitised, patch.raw_document_purge_status, patch.raw_document_purged_at]);
    });
    const r = await h.one<{ raw_document_purge_status: string; raw_document_storage_reference: string | null }>(`select raw_document_purge_status, raw_document_storage_reference from fdh_statement_uploads where id = $1`, [id]);
    expect(r).toEqual({ raw_document_purge_status: 'purged', raw_document_storage_reference: null });
  });
});

describe('audit events and drafts', () => {
  const EVENTS = [
    'pdf_native_extraction_started', 'document_purge_scheduled', 'document_purged',
    'liability_statement_extraction_completed', 'liability_statement_extraction_failed', 'liability_statement_ai_fallback_attempted', 'liability_statement_ai_fallback_not_usable',
    'retirement_statement_extraction_completed', 'retirement_statement_extraction_failed', 'retirement_statement_ai_fallback_attempted', 'retirement_statement_ai_fallback_not_usable', 'retirement_statement_routed_to_smsf',
    'investment_statement_extraction_completed', 'investment_statement_extraction_failed', 'investment_statement_ai_fallback_attempted', 'investment_statement_ai_fallback_not_usable',
  ];
  it('every audit event type the PDF routes record is accepted, with codes-and-counts metadata', async () => {
    const id = await newUpload('credit_card_statement');
    for (const e of EVENTS) {
      await h.asService(() => h.db.query(
        `insert into fdh_document_audit_events (user_id, document_id, event_type, actor_type, metadata) values ($1, $2, $3, 'system', $4::jsonb)`,
        [U, id, e, JSON.stringify({ source_format: 'pdf', layout: 'CARD-1' })]));
    }
    const n = await h.one<{ n: string }>(`select count(*)::text as n from fdh_document_audit_events where document_id = $1`, [id]);
    expect(Number(n.n)).toBeGreaterThanOrEqual(EVENTS.length);
  });
  it('NEGATIVE CONTROL: an event type that was never allowed is refused', async () => {
    const id = await newUpload('credit_card_statement');
    await expect(h.asService(() => h.db.query(`insert into fdh_document_audit_events (user_id, document_id, event_type, actor_type) values ($1, $2, 'liability_statement_pdf_read', 'system')`, [U, id]))).rejects.toThrow();
  });
  it('a pending draft row is accepted for each class, and only one pending draft per document', async () => {
    for (const [t, type] of [['credit_card_statement', 'liability_statement'], ['super_statement', 'retirement_statement'], ['investment_statement', 'investment_statement']] as const) {
      const id = await newUpload(t);
      await h.asService(() => h.db.query(`insert into fdh_ai_fallback_drafts (user_id, statement_upload_id, document_type, schema_name, schema_version, payload) values ($1, $2, $3, 's', '1', '{"sourceFormat":"pdf"}'::jsonb)`, [U, id, type]));
      await expect(h.asService(() => h.db.query(`insert into fdh_ai_fallback_drafts (user_id, statement_upload_id, document_type, schema_name, schema_version, payload) values ($1, $2, $3, 's', '1', '{}'::jsonb)`, [U, id, type]))).rejects.toThrow();
    }
  });
});

describe('evidence rows the PDF readers write', () => {
  it('broker statements: both PDF statement types, variance and the printed totals are accepted', async () => {
    for (const t of ['broker_holdings_statement', 'broker_transaction_statement']) {
      const id = await newUpload('investment_statement');
      await h.asService(() => h.db.query(
        `insert into fdh_investment_statements (user_id, statement_upload_id, statement_type, base_currency, institution_name, masked_account_identifier, statement_date, closing_portfolio_value, cash_balance, parser, parser_version, extraction_confidence, extraction_status, reconciliation_status, extraction_warnings)
         values ($1, $2, $3, 'AUD', 'Mulgrave Street Securities', '****4417', '2026-06-30', 137021.65, 1250.00, 'fdh_pdf_au_holdings_1', '1.0.0', 0.95, 'extracted', 'variance', '[]'::jsonb)`, [U, id, t]));
    }
    const n = await h.one<{ n: string }>(`select count(*)::text as n from fdh_investment_statements where parser = 'fdh_pdf_au_holdings_1'`);
    expect(Number(n.n)).toBe(2);
  });
  it('retirement statements: the three statement types the PDF reader picks, review pending, variance and a negative earnings string are accepted', async () => {
    for (const t of ['super_annual_statement', 'super_member_statement', 'account_based_pension_statement']) {
      const id = await newUpload('super_statement');
      await h.asService(() => h.db.query(
        `insert into fdh_retirement_statements (user_id, statement_upload_id, statement_type, retirement_jurisdiction, account_type, currency_code, fund_name, masked_account_identifier, opening_balance, closing_balance, investment_earnings, fees, parser, parser_version, extraction_confidence, extraction_status, reconciliation_status, review_status, smsf_classification)
         values ($1, $2, $3, 'AU', 'unknown', 'AUD', 'Banksia Industry Super Fund', '****5517', '48210.55', '59672.65', '-812.00', '385.20', 'fdh_pdf_retirement_1', '1.0.0', 0.95, 'extracted', 'variance', 'pending', 'not_smsf')`, [U, id, t]));
    }
    const n = await h.one<{ n: string }>(`select count(*)::text as n from fdh_retirement_statements where parser = 'fdh_pdf_retirement_1'`);
    expect(Number(n.n)).toBe(3);
  });
  it('the REAL liability persist function (migration 0208) writes the statement and activities of a PDF reading and moves the document to extracted', async () => {
    const id = await newUpload('credit_card_statement');
    await walk(id, 'uploaded', 'validating', 'queued');
    const statement = {
      user_id: U, statement_upload_id: id, statement_type: 'credit_card', facility_type: 'credit_card', country_code: 'AU', currency_code: 'AUD',
      institution_name: 'Wattlebird Credit Union', masked_identifier: '****4821', statement_period_start: '2026-07-01', statement_period_end: '2026-07-31',
      statement_date: '2026-07-31', due_date: '2026-08-25', opening_balance: 1250.4, closing_balance: 1407.8, credit_limit: 8000, minimum_payment: 35,
      opening_principal: null, closing_principal: null, interest_rate: null, purchases_total: 474.55, cash_advances_total: 200, interest_total: 27.85,
      fees_total: 4, payments_total: 500, refunds_total: 49, adjustments_total: null, drawdowns_total: null, capitalised_total: null, principal_repayments_total: null,
      reconciliation_status: 'reconciled', reconciliation_variance: 0, parser_name: 'fdh_pdf_card_1', parser_version: '1.0.0', extraction_confidence: 0.95,
      review_status: 'not_required', extraction_warnings: [],
    };
    const activities = [
      { activity_type: 'PURCHASE', activity_date: '2026-07-03', amount: 84.2, currency_code: 'AUD', description_raw: 'FICTIONAL GROCER', merchant_raw: null, principal_component: null, interest_component: null, fee_component: null, linked_transaction_id: null, bank_match_status: 'not_attempted', review_status: 'not_required', source_row_number: 1, gst_amount_raw: null, bank_match_candidate_ids: null },
      { activity_type: 'PAYMENT', activity_date: '2026-07-09', amount: 500, currency_code: 'AUD', description_raw: 'PAYMENT RECEIVED - THANK YOU', merchant_raw: null, principal_component: null, interest_component: null, fee_component: null, linked_transaction_id: null, bank_match_status: 'bank_evidence_not_available', review_status: 'not_required', source_row_number: 2, gst_amount_raw: null, bank_match_candidate_ids: null },
    ];
    const out = await h.asTenant(U, async () => (await h.db.query<{ r: Record<string, unknown> }>(`select fdh10_persist_liability_statement($1, $2::jsonb, $3::jsonb) as r`, [id, JSON.stringify(statement), JSON.stringify(activities)])).rows[0].r);
    expect(out).toMatchObject({ ok: true });
    const doc = await h.one<{ processing_status: string }>(`select processing_status from fdh_statement_uploads where id = $1`, [id]);
    expect(doc.processing_status).toBe('extracted');
    const st = await h.one<{ parser_name: string; reconciliation_status: string }>(`select parser_name, reconciliation_status from fdh_liability_statements where statement_upload_id = $1`, [id]);
    expect(st).toEqual({ parser_name: 'fdh_pdf_card_1', reconciliation_status: 'reconciled' });
    const acts = await h.one<{ n: string }>(`select count(*)::text as n from fdh_liability_statement_activities where user_id = $1 and statement_id in (select id from fdh_liability_statements where statement_upload_id = $2)`, [U, id]);
    expect(Number(acts.n)).toBe(2);
  });
});
