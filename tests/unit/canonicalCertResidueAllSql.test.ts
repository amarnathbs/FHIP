/**
 * Stage-3 consolidation: the COMBINED DEV residue SQL for the PO
 * (scripts/canonical_cert/dev_residue_ALL_for_PO.sql) is rendered by
 * renderResidueSql(). This test runs that SAME renderer's output on the REAL
 * migration chain (PGlite, 0001..0218) against synthetic applied card chains
 * in the state the DEV cleanup left them (every row with a user column the
 * service role could delete is gone; the guarded chain remains, GP-H1), and
 * proves each safety property by making it fail:
 *
 *   - happy path: guard passes, fixture rows restored, every chain row deleted, one transaction;
 *   - [NC] a 'production' ii_nav_retention_policy row      -> REFUSED, nothing changed;
 *   - [NC] no 'dev' policy row                             -> REFUSED, nothing changed;
 *   - [NC] a row owned by a NON-synthetic user             -> REFUSED, nothing changed;
 *   - [NC] a wrong expected count (an id that is not there) -> REFUSED, nothing changed;
 *   - [NC] the same deletes WITHOUT the internal-write GUC  -> refused by the import-bridge guards.
 * Plus: the committed file is exactly what the builder renders from the four certifier files (not stale).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildDb, Fdh10Harness } from './support/fdh10LedgerPgliteHarness';
import { buildSpec, renderResidueSql } from '../../scripts/canonical_cert/build_dev_residue_all_sql.mjs';

let h: Fdh10Harness;
let n = 0;

interface Chain { uid: string; application: string; proposal: string; liability: string; statement: string; account: string; upload: string; retirement: string }

async function appliedChain(email: (uid: string) => string): Promise<Chain> {
  n += 1;
  const uid = `00000000-0000-4000-8000-0000000c${String(n).padStart(4, '0')}`;
  await h.asService(async () => { await h.db.query(`insert into auth.users(id, email) values ($1, $2)`, [uid, email(uid)]); });
  await h.user(uid);
  const bank = await h.bankAccount(uid);
  const debit = await h.bankDebit(uid, bank, 220, '2026-08-20', { type: 'transfer' });
  const s = await h.statementWithProposal(uid, {
    statementType: 'credit_card',
    activities: [
      { activity_type: 'PURCHASE', amount: 200, activity_date: '2026-08-03' },
      { activity_type: 'PAYMENT', amount: 220, activity_date: '2026-08-20', bank_match_status: 'matched', linked_transaction_id: debit },
    ],
  });
  const r = await h.apply(uid, s.proposalId, 'add_new', { fields: ['liability_name', 'debt_type', 'balance', 'currency_code', 'country_code'], owner: 'self' });
  expect(r).toMatchObject({ ok: true, outcome: 'applied' });
  return h.asService(async () => {
    const app = await h.one<{ id: string; target_entity_id: string }>(`select id, target_entity_id from fhip_import_applications where proposal_id = $1`, [s.proposalId]);
    const acc = await h.one<{ id: string }>(`select id from fdh_financial_accounts where user_id = $1 and liability_id = $2`, [uid, app.target_entity_id]);
    // A fixture retirement account an Apply stamped with this application (range C's shape): the file must
    // restore it BEFORE the application delete would null its link through the guarded FK action.
    const ret = await h.one<{ id: string }>(
      `insert into retirement_accounts (user_id, account_name, account_type, current_balance, employer_contribution, contribution_frequency, currency_code, country_code, master_item_key)
       values ($1, 'Industry Super', 'industry_super', 9600, 524.40, 'monthly', 'AUD', 'AU', 'industry_super') returning id`, [uid]);
    await h.db.exec(`begin; select set_config('fhip.import_bridge_internal_write', 'true', true);
      update retirement_accounts set source_type = 'retirement_statement_import', last_import_application_id = '${app.id}', last_imported_at = now(), current_balance = 12345 where id = '${ret.id}';
      commit;`);
    // The DEV cleanup had already removed everything with a user column it could delete (verified on DEV:
    // 0 dependents) -- reproduce that state.
    await h.db.exec(`delete from fdh_liability_statement_activities where user_id = '${uid}';
      delete from fdh_transaction_links where user_id = '${uid}';
      delete from fdh_transaction_allocations where user_id = '${uid}';
      delete from fdh_transactions where user_id = '${uid}' and financial_account_id = '${acc.id}';
      delete from fhip_import_proposal_fields where proposal_id = '${s.proposalId}';`);
    return { uid, application: app.id, proposal: s.proposalId, liability: app.target_entity_id, statement: s.statementId, account: acc.id, upload: s.uploadId, retirement: ret.id };
  });
}

function specFor(chains: Chain[], extraIds: string[] = []) {
  return {
    title: 'test',
    sections: chains.map((c, i) => ({
      label: `chain ${i}`,
      preUpdates: [
        { table: 'retirement_accounts', id: c.retirement, userId: c.uid, expect: 1, set: "source_type = 'manual', last_import_application_id = null, last_imported_at = null, current_balance = 9600" },
        { table: 'liabilities', id: c.liability, userId: c.uid, expect: 1, set: 'last_import_application_id = null' },
      ],
      deletes: [
        { table: 'fhip_import_applications', userId: c.uid, ids: [c.application, ...(i === 0 ? extraIds : [])] },
        { table: 'fhip_import_proposals', userId: c.uid, ids: [c.proposal] },
        { table: 'fdh_liability_statements', userId: null, ids: [c.statement] },
        { table: 'fdh_financial_accounts', userId: c.uid, ids: [c.account] },
        { table: 'liabilities', userId: c.uid, ids: [c.liability] },
        { table: 'fdh_statement_uploads', userId: c.uid, ids: [c.upload] },
      ],
    })),
  };
}

async function remaining(c: Chain): Promise<number> {
  return h.asService(async () => h.count(
    `select (select count(*) from fhip_import_applications where id = $1) + (select count(*) from fhip_import_proposals where id = $2)
          + (select count(*) from liabilities where id = $3) + (select count(*) from fdh_liability_statements where id = $4)
          + (select count(*) from fdh_financial_accounts where id = $5) + (select count(*) from fdh_statement_uploads where id = $6) n`,
    [c.application, c.proposal, c.liability, c.statement, c.account, c.upload]));
}

/** Runs the file as the SQL editor would (one script); returns the error message, or null on success. */
async function runFile(sql: string): Promise<string | null> {
  return h.asService(async () => {
    try {
      await h.db.exec(sql);
      return null;
    } catch (e) {
      await h.db.exec('rollback;').catch(() => undefined);
      return (e as Error).message;
    }
  });
}

const setPolicy = async (envs: string[]) => h.asService(async () => {
  await h.db.exec('delete from ii_nav_retention_policy;');
  for (const e of envs) await h.db.query(`insert into ii_nav_retention_policy (policy_version, changeover_date, environment) values ($1, '2026-09-21', $2)`, [`test-${e}`, e]);
});

const synthetic = (uid: string) => `${uid.slice(-8)}@example.test`;

beforeAll(async () => { h = new Fdh10Harness(await buildDb()); }, 900_000);
afterAll(async () => { await h?.db.close(); });

describe('combined DEV residue SQL (renderResidueSql) on the real migration chain', () => {
  it('the committed file is exactly what the builder renders from the four certifier files', () => {
    const committed = fs.readFileSync(path.join(process.cwd(), 'scripts/canonical_cert/dev_residue_ALL_for_PO.sql'), 'utf8');
    expect(committed).toBe(renderResidueSql(buildSpec()));
    expect(committed.charCodeAt(0)).not.toBe(0xfeff); // no BOM (the Supabase SQL editor rejects it)
    expect(committed).toMatch(/environment = 'production'/);
    const spec = buildSpec();
    const steps = spec.sections.reduce((k, s) => k + ('preUpdates' in s ? s.preUpdates.length : 0) + s.deletes.length, 0);
    expect(steps).toBe(31); // 2 restores + 29 table deletes (A 6, B 6, C 6, D 5, consolidation recheck 6)
    expect(committed.match(/get diagnostics n = row_count/g)?.length).toBe(steps);
  });

  it('[NC] a production policy row -> REFUSED, nothing changed', async () => {
    const c = await appliedChain(synthetic);
    await setPolicy(['dev', 'production']);
    expect(await runFile(renderResidueSql(specFor([c])))).toMatch(/REFUSED: ii_nav_retention_policy has a production row/);
    expect(await remaining(c)).toBe(6);
  }, 300_000);

  it('[NC] no dev policy row -> REFUSED, nothing changed', async () => {
    const c = await appliedChain(synthetic);
    await setPolicy([]);
    expect(await runFile(renderResidueSql(specFor([c])))).toMatch(/REFUSED: no dev row/);
    expect(await remaining(c)).toBe(6);
  }, 300_000);

  it('[NC] a row owned by a non-synthetic user -> REFUSED, nothing changed', async () => {
    const c = await appliedChain((uid) => `${uid.slice(-8)}@realperson.com`);
    await setPolicy(['dev']);
    expect(await runFile(renderResidueSql(specFor([c])))).toMatch(/REFUSED \(chain 0\)/);
    expect(await remaining(c)).toBe(6);
  }, 300_000);

  it('[NC] a wrong expected count -> REFUSED, and the transaction leaves every row (incl. the restore) untouched', async () => {
    const c = await appliedChain(synthetic);
    await setPolicy(['dev']);
    expect(await runFile(renderResidueSql(specFor([c], ['00000000-0000-4000-8000-00000000dead'])))).toMatch(/REFUSED \(chain 0\): fhip_import_applications -- 1 synthetic-owned rows present \(expected 2\)/);
    expect(await remaining(c)).toBe(6);
    const ret = await h.asService(async () => h.one<{ source_type: string }>(`select source_type from retirement_accounts where id = $1`, [c.retirement]));
    expect(ret.source_type).toBe('retirement_statement_import');
  }, 300_000);

  it('[NC] without the internal-write GUC the same deletes are refused by the import-bridge guards', async () => {
    const c = await appliedChain(synthetic);
    await setPolicy(['dev']);
    const noGuc = renderResidueSql(specFor([c])).replace(/^select set_config\('fhip\.import_bridge_internal_write', 'true', true\);$/m, '');
    expect(noGuc).not.toMatch(/import_bridge_internal_write', 'true'/);
    expect(await runFile(noGuc)).not.toBeNull();
    expect(await remaining(c)).toBe(6);
  }, 300_000);

  it('happy path: two chains, guard passes, fixture rows restored, 12 chain rows deleted in one transaction', async () => {
    const a = await appliedChain(synthetic);
    const b = await appliedChain(synthetic);
    await setPolicy(['dev']);
    expect(await runFile(renderResidueSql(specFor([a, b])))).toBeNull();
    expect(await remaining(a)).toBe(0);
    expect(await remaining(b)).toBe(0);
    const ret = await h.asService(async () => h.one<{ source_type: string; last_import_application_id: string | null; current_balance: string }>(
      `select source_type, last_import_application_id, current_balance from retirement_accounts where id = $1`, [a.retirement]));
    expect(ret).toMatchObject({ source_type: 'manual', last_import_application_id: null });
    expect(Number(ret.current_balance)).toBe(9600);
  }, 600_000);
});
