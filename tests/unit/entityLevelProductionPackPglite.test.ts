// The PO household cutover pack (production_pack/P0..P9) and the editor-run migration parts (sql_parts/), proved on the REAL migration ledger in an
// isolated in-memory Postgres (PGlite). EVIDENCE LABEL: "verified on an isolated PGlite replay". NOT DEV- or production-verified.
//
// The fixture is the production shape diagnosed by the read-only run of 17-10-2026 (AUD): fund ITEMISED with holdings 475,000 + 3,000 + 25,000 = 503,000,
// a stale typed net 138,000, the duplicate Retirement row "Other Retirement Assets" 133,000 owned by the SMSF, "Spouse Contribution" 0, an INACTIVE
// personal "SMSF property loan" 365,000, an INACTIVE SMSF-owned asset "Trust Assets" 495,000; personal assets 1,670,298 + investments 590,000,
// personal liabilities 600,000 + 700,000 + 85,857 (net 874,441).
// PO decision 17-10-2026: the SMSF loan is 370,000 -> fund net 133,000 -> family 1,007,441. (365,000 -> 138,000 -> 1,012,441 is tested as the parameter.)
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { buildSmsfBalanceSheet } from '@/lib/engines/entityBalanceSheet';
import { computeNetWorthLevels, type NetWorthRowInput } from '@/lib/engines/netWorthLevels';
import { expectSqlError, replayLedger, seedUser, MIG_DIR } from './support/entityLevelPgliteHarness';

const ROOT = path.resolve(__dirname, '..', '..');
const PACK = path.join(ROOT, 'docs', 'architecture', 'entity_level_assets_liabilities_2026-10-16');
const PROD = path.join(PACK, 'production_pack');
const PARTS = path.join(PACK, 'sql_parts');
const BK = ['retirement_accounts', 'smsf_funds', 'smsf_holdings', 'liabilities', 'property_liability_links', 'assets'];

let db: PGlite;
let n = 0;
type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v);
const sqlOf = (file: string, email: string, edits: [string, string][] = []) => {
  let s = fs.readFileSync(path.join(PROD, file), 'utf8').replace(/PUT_YOUR_LOGIN_EMAIL_HERE/g, email);
  for (const [a, c] of edits) {
    if (!s.includes(a)) throw new Error(`edit target not found: ${a}`);
    s = s.replace(a, c);
  }
  return s;
};

async function resetBackups() {
  for (const t of BK) await db.exec(`drop table if exists zz_bk_20261017_${t};`);
}

/** The production shape diagnosed on 17-10-2026. */
async function poHousehold(email: string): Promise<{ uid: string; fundId: string; raId: string; dupId: string }> {
  n += 1;
  const uid = `eeeeeeee-0000-0000-0000-${String(n).padStart(12, '0')}`;
  await seedUser(db, uid, email);
  const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
  await q(`insert into assets(user_id, asset_name, asset_class, current_value, currency_code, owner) values ($1,'Assets register','other',1670298,'AUD','self')`, [uid]);
  await q(`insert into investments(user_id, investment_name, investment_type, current_value, currency_code, owner) values ($1,'Investments','shares',590000,'AUD','self')`, [uid]);
  await q(`insert into liabilities(user_id, liability_name, debt_type, balance, currency_code, owner) values ($1,'Home loan','mortgage',600000,'AUD','self'),($1,'Investment loan','mortgage',700000,'AUD','joint'),($1,'Car loan','auto_loan',85857,'AUD','spouse')`, [uid]);
  // the fund, the way production holds it: itemised (detailed) with the three holdings
  await q(`insert into retirement_accounts(user_id, account_name, account_type, current_balance, currency_code, country_code, owner, master_item_key, is_active) values ($1,'SMSF','super',0,'AUD','AU','self','smsf',true)`, [uid]);
  const raId = ((await q(`select id from retirement_accounts where user_id=$1 and master_item_key='smsf'`, [uid])).rows[0] as Row).id as string;
  await q(`insert into smsf_funds(user_id, retirement_account_id, fund_name, mode, summary_balance, currency_code) values ($1,$2,'PO SMSF','detailed',null,'AUD')`, [uid, raId]);
  const fundId = ((await q(`select id from smsf_funds where user_id=$1`, [uid])).rows[0] as Row).id as string;
  await q(`insert into smsf_holdings(user_id, smsf_fund_id, holding_class, holding_type, holding_name, value, currency_code) values
    ($1,$2,'property','residential_property','250 Elizebth st Melbourne 3000 ',475000,'AUD'),
    ($1,$2,'cash','cash_account','Bank Australia',3000,'AUD'),
    ($1,$2,'cash','cash_account','Secured finance',25000,'AUD')`, [uid, fundId]);
  // the stale typed net written before the rule existed
  await db.exec('alter table smsf_funds disable trigger trg_smsf_funds_mode_rule;');
  await q(`update smsf_funds set summary_balance=138000, summary_balance_date='2026-09-01' where id=$1`, [fundId]);
  await db.exec('alter table smsf_funds enable trigger trg_smsf_funds_mode_rule;');
  const dup = (await q(`insert into retirement_accounts(user_id, account_name, account_type, current_balance, currency_code, country_code, owner, master_item_key, is_active) values ($1,'Other Retirement Assets','other',133000,'AUD','AU','smsf','other_retirement',true) returning id`, [uid])).rows[0] as Row;
  await q(`insert into retirement_accounts(user_id, account_name, account_type, current_balance, currency_code, country_code, owner, master_item_key, is_active) values ($1,'Spouse Contribution','super',0,'AUD','AU','spouse','spouse_contribution',true)`, [uid]);
  await q(`insert into liabilities(user_id, liability_name, debt_type, balance, currency_code, owner, is_active) values ($1,'SMSF property loan','mortgage',365000,'AUD','joint',false)`, [uid]);
  await q(`insert into assets(user_id, asset_name, asset_class, current_value, currency_code, owner, is_active) values ($1,'Trust Assets','other',495000,'AUD','smsf',false)`, [uid]);
  return { uid, fundId, raId, dupId: dup.id as string };
}

/** The family view, computed by the real engines from what is stored in the database. */
async function familyView(uid: string) {
  const q = async (sql: string) => (await db.query(sql, [uid])).rows as Row[];
  const rows: NetWorthRowInput[] = [];
  for (const r of await q(`select id, asset_name n, current_value v, owner from assets where user_id=$1 and is_active`)) rows.push({ id: r.id as string, register: 'assets', name: r.n as string, owner: r.owner as string, amountReporting: num(r.v), currencyCode: 'AUD' });
  for (const r of await q(`select id, investment_name n, current_value v, owner from investments where user_id=$1 and is_active`)) rows.push({ id: r.id as string, register: 'investments', name: r.n as string, owner: r.owner as string, amountReporting: num(r.v), currencyCode: 'AUD' });
  for (const r of await q(`select id, account_name n, current_balance v, owner, master_item_key k from retirement_accounts where user_id=$1 and is_active`)) rows.push({ id: r.id as string, register: 'retirement', name: r.n as string, owner: r.owner as string, masterItemKey: r.k as string, amountReporting: num(r.v), currencyCode: 'AUD' });
  for (const r of await q(`select id, liability_name n, balance v, owner from liabilities where user_id=$1 and is_active`)) rows.push({ id: r.id as string, register: 'liabilities', name: r.n as string, owner: r.owner as string, amountReporting: num(r.v), currencyCode: 'AUD' });
  const f = (await q(`select id, fund_name, mode, summary_balance, retirement_account_id from smsf_funds where user_id=$1 and is_active`))[0];
  const holdings = (await db.query(`select id, holding_name, holding_type, value from smsf_holdings where smsf_fund_id=$1 and is_active`, [f.id])).rows as Row[];
  const liabs = (await db.query(`select id, liability_name, liability_type, lender, balance from smsf_liabilities where smsf_fund_id=$1 and is_active`, [f.id])).rows as Row[];
  const sheet = buildSmsfBalanceSheet({
    fund: { id: f.id as string, name: f.fund_name as string, mode: f.mode as 'detailed' | 'summary', currency: 'AUD', retirementAccountId: f.retirement_account_id as string, typedNetReporting: f.summary_balance === null ? null : num(f.summary_balance), typedNetPresent: f.summary_balance !== null },
    reportingCurrency: 'AUD',
    holdings: holdings.map((h) => ({ id: h.id as string, name: h.holding_name as string, holdingType: h.holding_type as string, value: num(h.value), currency: 'AUD', valueReporting: num(h.value) })),
    liabilities: liabs.map((l) => ({ id: l.id as string, name: l.liability_name as string, type: l.liability_type as string, lender: (l.lender as string) ?? null, balance: num(l.balance), currency: 'AUD', balanceReporting: num(l.balance) })),
    linkedLoans: [],
  });
  return computeNetWorthLevels({ currency: 'AUD', rows, entitySheets: [sheet] });
}

beforeAll(async () => {
  db = await replayLedger();
}, 300_000);
afterAll(async () => {
  await db?.close();
});

describe('the cutover pack on the PO household (loan 370,000)', () => {
  const EMAIL = 'po-prod-shape@pg.test';
  let h: Awaited<ReturnType<typeof poHousehold>>;

  beforeAll(async () => {
    h = await poHousehold(EMAIL);
  });

  it('BEFORE the pack, with the new family view deployed: the fund counts at its 503,000 assets and the duplicate row is only listed, family 1,377,441 (this is why the pack runs BEFORE the deploy)', async () => {
    const l = await familyView(h.uid);
    expect(l.personal.total.net).toBe(874_441);
    expect(l.entities.blocks.find((b) => b.kind === 'smsf')?.included.net).toBe(503_000);
    expect(l.family.net).toBe(1_377_441);
    expect(l.entities.blocks.find((b) => b.kind === 'smsf')?.legacyRowsNotCounted?.net).toBe(133_000);
  });

  it('P0 diagnosis (read only) shows the fund row, the duplicate row, personal totals 2,260,298 and 1,385,857, and "SMSF recorded twice"', async () => {
    const rows = (await db.query(sqlOf('P0_diagnose_before_and_after_READ_ONLY.sql', EMAIL))).rows as Row[];
    const names = rows.map((r) => String(r.section));
    expect(names).toContain('DATA QUALITY: SMSF recorded twice');
    expect(num(rows.find((r) => String(r.section).startsWith('TOTAL personal assets'))?.amount)).toBe(2_260_298);
    expect(num(rows.find((r) => String(r.section).startsWith('TOTAL personal liabilities'))?.amount)).toBe(1_385_857);
  });

  it('P3 refuses without a backup, and changes nothing', async () => {
    await expectSqlError(db.exec(sqlOf('P3_cutover_apply.sql', EMAIL)), 'no backup found');
    await db.exec('rollback;').catch(() => undefined);
    expect((await db.query(`select count(*) c from smsf_liabilities where smsf_fund_id=$1`, [h.fundId])).rows[0]).toEqual({ c: 0 });
  });

  it('P1 backs up the exact rows behind row level security, and refuses to overwrite', async () => {
    await db.exec(sqlOf('P1_backup_exact_rows.sql', EMAIL));
    const counts = (await db.query(`select (select count(*) from zz_bk_20261017_retirement_accounts) r, (select count(*) from zz_bk_20261017_smsf_funds) f, (select count(*) from zz_bk_20261017_smsf_holdings) h, (select count(*) from zz_bk_20261017_liabilities) l, (select count(*) from zz_bk_20261017_assets) a`)).rows[0] as Row;
    expect([num(counts.r), num(counts.f), num(counts.h), num(counts.l), num(counts.a)]).toEqual([2, 1, 3, 1, 1]);
    const rls = (await db.query(`select count(*) c from pg_class where relname like 'zz_bk_20261017_%' and relrowsecurity`)).rows[0] as Row;
    expect(num(rls.c)).toBe(6);
    await expectSqlError(db.exec(sqlOf('P1_backup_exact_rows.sql', EMAIL)), 'backup left by an earlier run');
    await db.exec('rollback;').catch(() => undefined);
  });

  it('P2 preview lists what is retired (typed 138,000, duplicate 133,000), what is left alone (inactive 365,000 loan, inactive Trust Assets 495,000) and the result 503,000 - 370,000 = 133,000', async () => {
    const rows = (await db.query(sqlOf('P2_cutover_preview_READ_ONLY.sql', EMAIL))).rows as Row[];
    const by = (prefix: string) => rows.filter((r) => String(r.section).startsWith(prefix));
    expect(num(by('TO BE RETIRED: leftover typed')[0].amount)).toBe(138_000);
    expect(num(by('TO BE RETIRED: duplicate')[0].amount)).toBe(133_000);
    expect(num(by('LEFT ALONE: inactive personal loan')[0].amount)).toBe(365_000);
    expect(num(by('LEFT ALONE: inactive SMSF-owned asset')[0].amount)).toBe(495_000);
    expect(num(by('TO BE ADDED')[0].amount)).toBe(370_000);
    expect(num(by('RESULT: net')[0].amount)).toBe(133_000);
  });

  it('NEGATIVE CONTROLS: P3 refuses when the diagnosed values do not match (assets, duplicate total), and changes nothing', async () => {
    await expectSqlError(db.exec(sqlOf('P3_cutover_apply.sql', EMAIL, [['v_expected_assets numeric := 503000;', 'v_expected_assets numeric := 504000;']])), 'was expected, stop and run P2 again');
    await db.exec('rollback;').catch(() => undefined);
    await expectSqlError(db.exec(sqlOf('P3_cutover_apply.sql', EMAIL, [['v_expected_dup_total numeric := 133000;', 'v_expected_dup_total numeric := 134000;']])), 'duplicate row(s)');
    await db.exec('rollback;').catch(() => undefined);
    await expectSqlError(db.exec(sqlOf('P3_cutover_apply.sql', 'nobody@pg.test')), 'no such user');
    await db.exec('rollback;').catch(() => undefined);
    await expectSqlError(db.exec(sqlOf('P3_cutover_apply.sql', EMAIL, [['v_loan numeric := 370000;', 'v_loan numeric := 600000;']])), 'loan amount must be above zero');
    await db.exec('rollback;').catch(() => undefined);
    expect(num(((await db.query(`select count(*) c from smsf_liabilities where smsf_fund_id=$1`, [h.fundId])).rows[0] as Row).c)).toBe(0);
    expect(num(((await db.query(`select summary_balance from smsf_funds where id=$1`, [h.fundId])).rows[0] as Row).summary_balance)).toBe(138_000);
  });

  it('P3 applies with 370,000: fund liabilities 370,000, derived net 133,000, mirror 133,000, typed net retired, duplicate archived, two history rows, inactive rows untouched', async () => {
    await db.exec(sqlOf('P3_cutover_apply.sql', EMAIL));
    const f = (await db.query(`select summary_balance, detailed_net_value, mode from smsf_funds where id=$1`, [h.fundId])).rows[0] as Row;
    expect(f.mode).toBe('detailed');
    expect(f.summary_balance).toBeNull();
    expect(num(f.detailed_net_value)).toBe(133_000);
    expect(num(((await db.query(`select current_balance from retirement_accounts where id=$1`, [h.raId])).rows[0] as Row).current_balance)).toBe(133_000);
    expect(num(((await db.query(`select sum(balance) s from smsf_liabilities where smsf_fund_id=$1 and is_active`, [h.fundId])).rows[0] as Row).s)).toBe(370_000);
    expect(((await db.query(`select is_active from retirement_accounts where id=$1`, [h.dupId])).rows[0] as Row).is_active).toBe(false);
    const logs = (await db.query(`select action from entity_figure_mode_log where entity_id=$1 order by created_at, id`, [h.fundId])).rows as Row[];
    expect(logs.map((r) => r.action).sort()).toEqual(['adopt_register_rows', 'retire_typed_net']);
    const inactive = (await db.query(`select (select is_active from liabilities where user_id=$1 and liability_name='SMSF property loan') l, (select is_active from assets where user_id=$1 and asset_name='Trust Assets') a`, [h.uid])).rows[0] as Row;
    expect([inactive.l, inactive.a]).toEqual([false, false]);
  });

  it('after P3 the family view is personal 874,441 + SMSF 133,000 = 1,007,441, with no legacy row listed', async () => {
    const l = await familyView(h.uid);
    expect(l.personal.total.net).toBe(874_441);
    const smsf = l.entities.blocks.find((b) => b.kind === 'smsf')!;
    expect(smsf.entityTotals.totalAssets).toBe(503_000);
    expect(smsf.entityTotals.liabilities).toBe(370_000);
    expect(smsf.included.net).toBe(133_000);
    expect(l.family.net).toBe(1_007_441);
    expect(smsf.legacyRowsNotCounted).toBeNull();
    expect(l.dataStatus.smsfPossibleDoubleCount).toBeNull();
  });

  it('P4 verify reports the expected values', async () => {
    const rows = (await db.query(sqlOf('P4_verify_READ_ONLY.sql', EMAIL))).rows as Row[];
    const v = (name: string) => String(rows.find((r) => String(r.check_name).startsWith(name))?.value);
    expect(v('fund mode')).toBe('detailed');
    expect(v('typed net value')).toBe('empty');
    expect(num(v('assets of the fund'))).toBe(503_000);
    expect(num(v('liabilities of the fund'))).toBe(370_000);
    expect(num(v('derived net'))).toBe(133_000);
    expect(num(v('Retirement row'))).toBe(133_000);
    expect(num(v('active duplicate'))).toBe(0);
    expect(num(v('data quality'))).toBe(0);
    expect(num(v('history rows'))).toBe(2);
  });

  it('running P3 a second time is refused ("already applied") and changes nothing', async () => {
    await expectSqlError(db.exec(sqlOf('P3_cutover_apply.sql', EMAIL)), 'already applied');
    await db.exec('rollback;').catch(() => undefined);
    expect(num(((await db.query(`select count(*) c from smsf_liabilities where smsf_fund_id=$1`, [h.fundId])).rows[0] as Row).c)).toBe(1);
  });

  it('P9 rollback puts the fund back as backed up: typed net 138,000, duplicate active, no active fund liability, derived net 503,000', async () => {
    await db.exec(sqlOf('P9_rollback.sql', EMAIL));
    const f = (await db.query(`select summary_balance, detailed_net_value from smsf_funds where id=$1`, [h.fundId])).rows[0] as Row;
    expect(num(f.summary_balance)).toBe(138_000);
    expect(num(f.detailed_net_value)).toBe(503_000);
    expect(((await db.query(`select is_active from retirement_accounts where id=$1`, [h.dupId])).rows[0] as Row).is_active).toBe(true);
    expect(num(((await db.query(`select count(*) c from smsf_liabilities where smsf_fund_id=$1 and is_active`, [h.fundId])).rows[0] as Row).c)).toBe(0);
    // the trigger is back on after the rollback
    await expectSqlError(db.query(`update smsf_funds set summary_balance=1 where id=$1`, [h.fundId]), 'ENTITY_BOTH_REPRESENTATIONS');
  });
});

describe('the same pack with the stale loan amount 365,000 as the parameter', () => {
  it('fund net 138,000 and family 1,012,441 (the 5,000 between the two amounts is real money)', async () => {
    await resetBackups();
    const EMAIL = 'po-prod-shape-365@pg.test';
    const h = await poHousehold(EMAIL);
    await db.exec(sqlOf('P1_backup_exact_rows.sql', EMAIL));
    await db.exec(sqlOf('P3_cutover_apply.sql', EMAIL, [['v_loan numeric := 370000;', 'v_loan numeric := 365000;']]));
    expect(num(((await db.query(`select detailed_net_value from smsf_funds where id=$1`, [h.fundId])).rows[0] as Row).detailed_net_value)).toBe(138_000);
    const l = await familyView(h.uid);
    expect(l.personal.total.net).toBe(874_441);
    expect(l.family.net).toBe(1_012_441);
  });
});

describe('the DEV rehearsal fixture D1 builds the same shape, then the pack runs on it unchanged', () => {
  it('D1, P1, P3 on a fresh DEV test account: personal 874,441, family 1,007,441; D1 refuses a second run and a production-like account that already has a fund', async () => {
    await resetBackups();
    const EMAIL = 'dev-rehearsal@pg.test';
    n += 1;
    const uid = `eeeeeeee-0000-0000-0000-${String(n).padStart(12, '0')}`;
    await seedUser(db, uid, EMAIL);
    const d1 = fs.readFileSync(path.join(PACK, 'dev_pack', 'D1_build_po_shape_for_rehearsal.sql'), 'utf8').replace(/PUT_YOUR_LOGIN_EMAIL_HERE/g, EMAIL);
    await db.exec(d1);
    const before = await familyView(uid);
    expect(before.personal.total.net).toBe(874_441);
    await expectSqlError(db.exec(d1), 'already has an SMSF fund');
    await db.exec('rollback;').catch(() => undefined);
    await db.exec(sqlOf('P1_backup_exact_rows.sql', EMAIL));
    await db.exec(sqlOf('P3_cutover_apply.sql', EMAIL));
    const after = await familyView(uid);
    expect(after.personal.total.net).toBe(874_441);
    expect(after.family.net).toBe(1_007_441);
    const rows = (await db.query(sqlOf('P4_verify_READ_ONLY.sql', EMAIL))).rows as Row[];
    expect(num(rows.find((r) => String(r.check_name).startsWith('derived net'))?.value)).toBe(133_000);
    expect(num(rows.find((r) => String(r.check_name).startsWith('data quality'))?.value)).toBe(0);
    await resetBackups();
  });
});

describe('the migration parts the PO pastes into the SQL editor', () => {
  it('concatenated, the parts equal the migration bodies exactly (so they cannot drift)', () => {
    for (const num of ['0289', '0290']) {
      const mig = fs.readdirSync(MIG_DIR).find((f) => f.startsWith(`${num}_`))!;
      const lines = fs.readFileSync(path.join(MIG_DIR, mig), 'utf8').split('\n');
      const body = lines.slice(lines.findIndex((l) => l.trim() === 'begin;') + 1, lines.map((l) => l.trim()).lastIndexOf('commit;')).join('\n').trim();
      const parts = fs.readdirSync(PARTS).filter((f) => f.startsWith(`${num}_part`)).sort();
      expect(parts.length).toBeGreaterThanOrEqual(3);
      const joined = parts
        .map((f) => {
          const pl = fs.readFileSync(path.join(PARTS, f), 'utf8').split('\n');
          return pl.slice(pl.findIndex((l) => l.trim() === 'begin;') + 1, pl.map((l) => l.trim()).lastIndexOf('commit;')).join('\n').trim();
        })
        .join('\n\n');
      expect(joined.replace(/\s+/g, ' ')).toBe(body.replace(/\s+/g, ' '));
    }
  });

  it('run part by part (twice, as a re-run would) on a ledger that stops at 0285, they build the same objects and the rule works', async () => {
    // 0295 and later (work package C) build on 0289 and 0290, so a ledger that stops at 0285 skips them too: this test is about the phase 1 parts only.
    const db2 = await replayLedger({ skip: (f) => f.startsWith('0289_') || f.startsWith('0290_') || /^029[5-9]_/.test(f) });
    try {
      const parts = fs.readdirSync(PARTS).filter((f) => f.endsWith('.sql')).sort();
      expect(parts.map((p) => p.slice(0, 9))).toContain('0290_part');
      for (let pass = 0; pass < 2; pass += 1) for (const p of parts) await db2.exec(fs.readFileSync(path.join(PARTS, p), 'utf8'));
      const uid = 'ffffffff-0000-0000-0000-000000000001';
      await seedUser(db2, uid, 'parts@pg.test');
      await db2.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
      await db2.exec('set role authenticated;');
      const created = (await db2.query(`select * from smsf_create_fund('SMSF','Parts fund',null,null,'self','AUD','AU','detailed')`)).rows[0] as Row;
      await db2.exec('reset role;');
      expect(created.smsf_fund_id).toBeTruthy();
      await db2.exec(`insert into smsf_holdings(user_id, smsf_fund_id, holding_class, holding_type, holding_name, value, currency_code) values ('${uid}','${created.smsf_fund_id}','cash','cash','Cash',503000,'AUD');
                      insert into smsf_liabilities(user_id, smsf_fund_id, liability_name, balance, currency_code) values ('${uid}','${created.smsf_fund_id}','Loan',370000,'AUD');`);
      expect(num(((await db2.query(`select detailed_net_value from smsf_funds where id=$1`, [created.smsf_fund_id])).rows[0] as Row).detailed_net_value)).toBe(133_000);
      await expectSqlError(db2.query(`update smsf_funds set summary_balance=1 where id=$1`, [created.smsf_fund_id]), 'ENTITY_BOTH_REPRESENTATIONS');
    } finally {
      await db2.close();
    }
  }, 300_000);
});
