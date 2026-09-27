/**
 * GOLDEN PAIR GP-H1 (found live on DEV, 2026-09-27) -- on the REAL migration chain (PGlite).
 *
 * After a card/loan statement is APPLIED, its rows form a cycle of ON DELETE SET NULL / CASCADE references
 * guarded by the import-bridge triggers, which have no role exemption:
 *   liabilities.last_import_application_id -> fhip_import_applications (set null; liabilities guard 0096 F.3)
 *   fdh_liability_statements.liability_id  -> liabilities              (set null; statements guard 0209 B)
 *   fhip_import_applications.proposal_id   -> fhip_import_proposals    (cascade; the application owner
 *                                              trigger (0214 E.2) then finds no proposal)
 * Live on DEV the service role could delete none of the 12 rows two applied statements left (the residue
 * ledger tried every order, 12 passes). This file pins: (1) every single-row delete is refused; (2) the
 * guarded one-transaction cleanup the PO can run works; (3) deleting the auth user (account deletion)
 * still works, so this is a test-cleanup / row-level-deletion hazard, not an account-deletion outage.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDb, Fdh10Harness } from './support/fdh10LedgerPgliteHarness';

let h: Fdh10Harness;
const U = '00000000-0000-4000-8000-00000000a0a1';
const U2 = '00000000-0000-4000-8000-00000000a0a2';
let ids: { liability: string; proposal: string; application: string; statement: string; upload: string };

async function tryDelete(sql: string, params: unknown[]): Promise<string> {
  try {
    await h.asService(async () => h.db.query(sql, params));
    return 'deleted';
  } catch (e) {
    return `refused: ${(e as Error).message.slice(0, 120)}`;
  }
}

async function appliedLoanChain(uid: string) {
  await h.user(uid);
  const bank = await h.bankAccount(uid);
  const debit = await h.bankDebit(uid, bank, 2000, '2026-08-15', { type: 'transfer' });
  const s = await h.statementWithProposal(uid, {
    statementType: 'loan',
    activities: [{ activity_type: 'PAYMENT', amount: 2000, activity_date: '2026-08-15', principal_component: 1550, interest_component: 430, fee_component: 20, bank_match_status: 'matched', linked_transaction_id: debit }],
  });
  const r = await h.apply(uid, s.proposalId, 'add_new', { fields: ['liability_name', 'debt_type', 'balance', 'currency_code', 'country_code'], owner: 'self' });
  expect(r).toMatchObject({ ok: true, outcome: 'applied' });
  const app = await h.one<{ id: string; target_entity_id: string }>(`select id, target_entity_id from fhip_import_applications where proposal_id = $1`, [s.proposalId]);
  return { liability: app.target_entity_id, proposal: s.proposalId, application: app.id, statement: s.statementId, upload: s.uploadId };
}

beforeAll(async () => {
  h = new Fdh10Harness(await buildDb());
  ids = await appliedLoanChain(U);
}, 600_000);
afterAll(async () => { await h?.db.close(); });

describe('GP-H1: an applied liability statement chain', () => {
  it('cannot be removed row by row, even by the service role (live DEV: 12 rows stuck)', async () => {
    const outcomes = {
      liability: await tryDelete('delete from liabilities where id = $1', [ids.liability]),
      application: await tryDelete('delete from fhip_import_applications where id = $1', [ids.application]),
      proposal: await tryDelete('delete from fhip_import_proposals where id = $1', [ids.proposal]),
      statement: await tryDelete('delete from fdh_liability_statements where id = $1', [ids.statement]),
      upload: await tryDelete('delete from fdh_statement_uploads where id = $1', [ids.upload]),
    };
    for (const [k, v] of Object.entries(outcomes)) expect(v, k).toMatch(/^refused/);
  });

  it('the guarded PO cleanup works: internal-write setting, applications first, one transaction', async () => {
    expect(await h.count(`select count(*) n from liabilities where id = $1`, [ids.liability])).toBe(1);
    await h.asService(async () => h.db.exec(`
      begin;
      select set_config('fhip.import_bridge_internal_write', 'true', true);
      delete from fhip_import_applications where id = '${ids.application}';
      delete from liabilities where id = '${ids.liability}';
      delete from fdh_liability_statements where id = '${ids.statement}';
      delete from fhip_import_proposals where id = '${ids.proposal}';
      delete from fdh_statement_uploads where id = '${ids.upload}';
      commit;`));
    expect(await h.count(`select count(*) n from liabilities where id = $1`, [ids.liability])).toBe(0);
    expect(await h.count(`select count(*) n from fhip_import_applications where id = $1`, [ids.application])).toBe(0);
    expect(await h.count(`select count(*) n from fdh_liability_statements where id = $1`, [ids.statement])).toBe(0);
  });

  it('account deletion (delete of the auth user) still removes an applied chain', async () => {
    const c = await appliedLoanChain(U2);
    expect(await tryDelete('delete from auth.users where id = $1', [U2])).toBe('deleted');
    expect(await h.count(`select count(*) n from liabilities where id = $1`, [c.liability])).toBe(0);
  });
});
