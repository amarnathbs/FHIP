// Entity-level assets/liabilities design (16-10-2026): the PO-household SQL pack, run against the REAL migration ledger replayed into an
// isolated in-memory Postgres (PGlite). EVIDENCE LABEL: "verified on an isolated PGlite replay", NOT DEV- or production-verified.
//
// Fixture = the PO household (AUD), hand-calculated:
//   personal assets register 1,670,298 + investments 590,000 = 2,260,298; personal liabilities 600,000 + 700,000 + 85,857 = 1,385,857;
//   SMSF fund row 503,000 (owner self, master item 'smsf'); "Other Retirement Assets" 133,000 (owner smsf);
//   no SMSF liability.  Personal net worth 2,260,298 - 1,385,857 = 874,441.  Real SMSF net = 503,000 - 370,000 = 133,000.
//   Family net worth once the fund counts ONCE at its net = 874,441 + 133,000 = 1,007,441.
//
// Negative controls (each proven to bite): the apply script is run against a wrong-amount fixture and against a missing user (must refuse,
// changing nothing); the diagnosis is run against the corrected shape (the "twice" finding must disappear).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const MIG_DIR = path.join(ROOT, 'supabase', 'migrations');
const SHIM = path.join(ROOT, 'scripts', 'db-rebuild-check', 'shim.sql');
const PACK = path.join(ROOT, 'docs', 'architecture', 'entity_level_assets_liabilities_2026-10-16');
const EMAIL = 'po-household@pg.test';
const U = 'cccccccc-0000-0000-0000-000000000001';

const sql = (name: string, email = EMAIL) => fs.readFileSync(path.join(PACK, name), 'utf8').replace(/PUT_YOUR_LOGIN_EMAIL_HERE/g, email);

let db: PGlite;

type Row = Record<string, unknown>;
const diag = async (email = EMAIL): Promise<Row[]> => (await db.query(sql('01_diagnose_entity_rows_READ_ONLY.sql', email))).rows as Row[];
const bySection = (rows: Row[], s: string) => rows.filter((r) => r.section === s);
const total = (rows: Row[], startsWith: string) => Number(rows.find((r) => String(r.section).startsWith(startsWith))?.amount ?? NaN);

async function seedHousehold(userId: string, email: string, fundBalance = 503_000) {
  await db.exec(`insert into auth.users(id,email) values ('${userId}','${email}');`);
  await db.exec(`insert into user_profiles(user_id, country_of_residence, country_confirmed_at) values ('${userId}','AU', now()) on conflict (user_id) do update set country_of_residence='AU', country_confirmed_at=now();`);
  const asset = (n: string, v: number, owner = 'self') =>
    `insert into assets(user_id, asset_name, asset_class, current_value, currency_code, owner) values ('${userId}','${n}','other',${v},'AUD','${owner}');`;
  const inv = (n: string, v: number) =>
    `insert into investments(user_id, investment_name, investment_type, current_value, currency_code, owner) values ('${userId}','${n}','shares',${v},'AUD','self');`;
  const liab = (n: string, v: number, owner: string) =>
    `insert into liabilities(user_id, liability_name, debt_type, balance, currency_code, owner) values ('${userId}','${n}','mortgage',${v},'AUD','${owner}');`;
  await db.exec(
    [
      asset('House', 960_298, 'self'),
      asset('Car and contents', 710_000, 'joint'),
      inv('Shares', 590_000),
      liab('Home loan', 600_000, 'self'),
      liab('Investment loan', 700_000, 'joint'),
      liab('Car loan', 85_857, 'spouse'),
      // The SMSF fund row exactly as smsf_create_fund() writes it (owner self, master item smsf) plus its smsf_funds row.
      `insert into retirement_accounts(user_id, account_name, account_type, current_balance, currency_code, country_code, owner, master_item_key, is_active)
         values ('${userId}','SMSF','super',${fundBalance},'AUD','AU','self','smsf',true);`,
      `insert into smsf_funds(user_id, retirement_account_id, fund_name, mode, summary_balance, currency_code)
         select '${userId}', id, 'PO SMSF', 'summary', ${fundBalance}, 'AUD' from retirement_accounts where user_id='${userId}' and master_item_key='smsf';`,
      `insert into retirement_accounts(user_id, account_name, account_type, current_balance, currency_code, country_code, owner, master_item_key, is_active)
         values ('${userId}','Other Retirement Assets','other',133000,'AUD','AU','smsf','other_retirement',true);`,
    ].join('\n'),
  );
}

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(fs.readFileSync(SHIM, 'utf8'));
  const seed = fs.readFileSync(path.join(ROOT, 'supabase', 'seed.sql'), 'utf8');
  const files = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
    if (f.startsWith('0001')) await db.exec(seed);
  }
  await seedHousehold(U, EMAIL);
}, 300_000);

afterAll(async () => {
  await db?.close();
});

describe('01 diagnosis (read only) on the PO household', () => {
  it('lists the fund row 503,000 (owner self) and Other Retirement Assets 133,000 (owner smsf), and flags the SMSF as recorded twice', async () => {
    const rows = await diag();
    const ret = bySection(rows, 'retirement register (all rows)');
    const fund = ret.find((r) => r.master_item_key === 'smsf');
    const other = ret.find((r) => r.name === 'Other Retirement Assets');
    expect(Number(fund?.amount)).toBe(503_000);
    expect(fund?.owner).toBe('self');
    expect(Number(other?.amount)).toBe(133_000);
    expect(other?.owner).toBe('smsf');
    expect(String(fund?.detail)).toContain('SMSF FUND ROW');
    const twice = bySection(rows, 'DATA QUALITY: SMSF recorded twice');
    expect(twice).toHaveLength(1);
    expect(Number(twice[0].amount)).toBe(636_000);
  });

  it('personal totals match the PO figures: assets + investments 2,260,298, liabilities 1,385,857, no SMSF debt; net 874,441', async () => {
    const rows = await diag();
    const assets = total(rows, 'TOTAL personal assets');
    const liabilities = total(rows, 'TOTAL personal liabilities');
    expect(assets).toBe(2_260_298);
    expect(liabilities).toBe(1_385_857);
    expect(assets - liabilities).toBe(874_441);
    expect(rows.find((r) => String(r.section).startsWith('TOTAL SMSF-related liabilities'))).toBeUndefined();
    // The family figure with the fund counted once at its real net (asset 503,000 - loan 370,000):
    expect(assets - liabilities + (503_000 - 370_000)).toBe(1_007_441);
  });

  it('is read only: row counts are unchanged and it is a single select', async () => {
    const before = ((await db.query(`select (select count(*) from retirement_accounts) a, (select count(*) from smsf_funds) b`)).rows[0]) as Row;
    await diag();
    const after = ((await db.query(`select (select count(*) from retirement_accounts) a, (select count(*) from smsf_funds) b`)).rows[0]) as Row;
    expect(after).toEqual(before);
    const text = sql('01_diagnose_entity_rows_READ_ONLY.sql').replace(/--.*$/gm, '');
    expect(text).not.toMatch(/\b(insert|update|delete|drop|alter|truncate|create)\b/i);
  });

  it('only ever shows the named user: another household is invisible', async () => {
    const other = 'cccccccc-0000-0000-0000-000000000002';
    await seedHousehold(other, 'someone-else@pg.test', 111_111);
    const rows = await diag();
    expect(rows.some((r) => Number(r.amount) === 111_111)).toBe(false);
    const theirs = await diag('someone-else@pg.test');
    expect(Number(bySection(theirs, 'retirement register (all rows)').find((r) => r.master_item_key === 'smsf')?.amount)).toBe(111_111);
  });

  it('a user that does not exist returns nothing, not an error', async () => {
    expect(await diag('nobody@pg.test')).toEqual([]);
  });
});

describe('02-04 interim option A: preview, apply, rollback', () => {
  it('02 previews exactly one row: the 503,000 owner-self fund row', async () => {
    const { rows } = await db.query(sql('02_interim_option_a_PREVIEW_READ_ONLY.sql'));
    expect(rows).toHaveLength(1);
    expect(Number((rows[0] as Row).current_balance)).toBe(503_000);
  });

  it('NEGATIVE CONTROL: 03 refuses when the expected amount does not match the fund row, and changes nothing', async () => {
    const wrong = sql('03_interim_option_a_APPLY.sql').replace('v_expected numeric := 503000;', 'v_expected numeric := 504000;');
    expect(wrong).not.toBe(sql('03_interim_option_a_APPLY.sql'));
    let message = '';
    try {
      await db.exec(wrong);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('expected exactly 1 active SMSF fund row');
    await db.exec('rollback;').catch(() => undefined);
    expect(((await db.query(`select to_regclass('public.zz_backup_20261016_retirement_accounts') as t`)).rows[0] as Row).t).toBeNull();
    expect(Number(((await db.query(`select current_balance from retirement_accounts where user_id='${U}' and master_item_key='smsf'`)).rows[0] as Row).current_balance)).toBe(503_000);
  });

  it('NEGATIVE CONTROL: 03 refuses for an unknown e-mail', async () => {
    let message = '';
    try {
      await db.exec(sql('03_interim_option_a_APPLY.sql', 'nobody@pg.test'));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('no such user');
    await db.exec('rollback;').catch(() => undefined);
  });

  it('03 archives the fund row and its fund, keeps copies behind row level security; the diagnosis then no longer says "twice"; 133,000 stays', async () => {
    await db.exec(sql('03_interim_option_a_APPLY.sql'));
    const fund = (await db.query(`select is_active from retirement_accounts where user_id='${U}' and master_item_key='smsf'`)).rows[0] as Row;
    expect(fund.is_active).toBe(false);
    expect(((await db.query(`select is_active from smsf_funds where user_id='${U}'`)).rows[0] as Row).is_active).toBe(false);
    expect(Number(((await db.query(`select count(*) c from zz_backup_20261016_retirement_accounts`)).rows[0] as Row).c)).toBe(1);
    const rls = (await db.query(`select relrowsecurity from pg_class where relname in ('zz_backup_20261016_retirement_accounts','zz_backup_20261016_smsf_funds')`)).rows as Row[];
    expect(rls).toHaveLength(2);
    expect(rls.every((r) => r.relrowsecurity === true)).toBe(true);
    const rows = await diag();
    expect(bySection(rows, 'DATA QUALITY: SMSF recorded twice')).toHaveLength(0);
    const other = (await db.query(`select current_balance, is_active from retirement_accounts where user_id='${U}' and account_name='Other Retirement Assets'`)).rows[0] as Row;
    expect(Number(other.current_balance)).toBe(133_000);
    expect(other.is_active).toBe(true);
  });

  it('03 cannot be run twice over the same backup', async () => {
    let message = '';
    try {
      await db.exec(sql('03_interim_option_a_APPLY.sql'));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message.length).toBeGreaterThan(0);
    await db.exec('rollback;').catch(() => undefined);
  });

  it('04 restores the fund row exactly (active, 503,000) and the diagnosis flags "twice" again', async () => {
    await db.exec(sql('04_interim_option_a_ROLLBACK.sql'));
    const fund = (await db.query(`select is_active, current_balance from retirement_accounts where user_id='${U}' and master_item_key='smsf'`)).rows[0] as Row;
    expect(fund.is_active).toBe(true);
    expect(Number(fund.current_balance)).toBe(503_000);
    expect(((await db.query(`select is_active from smsf_funds where user_id='${U}'`)).rows[0] as Row).is_active).toBe(true);
    expect(bySection(await diag(), 'DATA QUALITY: SMSF recorded twice')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The PO household's REAL production shape (diagnosis 01b reported by the coordinator, 17-10-2026): fund in DETAILED mode, summary_balance
// 138,000, holdings 475,000 + 3,000 + 25,000 = 503,000, the personal "SMSF property loan" (joint, 365,000) INACTIVE and NOT linked, so the
// fund's own net computes to 503,000. The interim path using only the existing UI: add the loan (balance 0), link it to the fund in the SMSF
// section, then enter the loan amount. These tests run the real triggers and functions of migration 0084 (and its successors).
// ---------------------------------------------------------------------------------------------------------------------------------
describe('interim path (existing UI only): link the SMSF loan so the fund net computes', () => {
  const V = 'cccccccc-0000-0000-0000-000000000003';
  let fundId = '';
  let fundRow = '';
  let loanId = '';
  const fundBalance = async () => Number(((await db.query(`select current_balance from retirement_accounts where id='${fundRow}'`)).rows[0] as Row).current_balance);
  const fundNet = async () => Number(((await db.query(`select detailed_net_value from smsf_funds where id='${fundId}'`)).rows[0] as Row).detailed_net_value);

  beforeAll(async () => {
    await db.exec(`insert into auth.users(id,email) values ('${V}','prod-shape@pg.test');`);
    await db.exec(`insert into user_profiles(user_id, country_of_residence, country_confirmed_at) values ('${V}','AU', now()) on conflict (user_id) do update set country_of_residence='AU', country_confirmed_at=now();`);
    await db.exec(`insert into retirement_accounts(user_id, account_name, account_type, current_balance, currency_code, country_code, owner, master_item_key, is_active)
      values ('${V}','SMSF','super',138000,'AUD','AU','self','smsf',true);`);
    fundRow = ((await db.query(`select id from retirement_accounts where user_id='${V}' and master_item_key='smsf'`)).rows[0] as Row).id as string;
    await db.exec(`insert into smsf_funds(user_id, retirement_account_id, fund_name, mode, summary_balance, currency_code) values ('${V}','${fundRow}','PO SMSF','summary',138000,'AUD');`);
    fundId = ((await db.query(`select id from smsf_funds where user_id='${V}'`)).rows[0] as Row).id as string;
    const holding = (cls: string, type: string, name: string, v: number) =>
      `insert into smsf_holdings(user_id, smsf_fund_id, holding_class, holding_type, holding_name, value, currency_code) values ('${V}','${fundId}','${cls}','${type}','${name}',${v},'AUD');`;
    // The original loan, active and linked, so the fund could be switched to Detailed with a zero variance (503,000 - 365,000 = 138,000).
    await db.exec(`insert into liabilities(user_id, liability_name, debt_type, balance, currency_code, owner) values ('${V}','SMSF property loan','mortgage',365000,'AUD','joint');`);
    loanId = ((await db.query(`select id from liabilities where user_id='${V}'`)).rows[0] as Row).id as string;
    await db.exec(`insert into property_liability_links(user_id, linked_retirement_id, liability_id, link_type) values ('${V}','${fundRow}','${loanId}','smsf_property_loan');`);
    await db.exec([holding('property', 'residential_property', '250 Elizebth st Melbourne 3000', 475_000), holding('cash', 'cash_account', 'Bank Australia', 3_000), holding('cash', 'cash_account', 'Secured finance', 25_000)].join('\n'));
    await db.exec(`select smsf_switch_to_detailed('${fundId}');`);
  }, 60_000);

  it('baseline = the production shape after the loan went inactive and unlinked: mode detailed, summary 138,000, net 503,000', async () => {
    expect(await fundBalance()).toBe(138_000);
    await db.exec(`update liabilities set is_active=false where id='${loanId}';`);
    await db.exec(`update property_liability_links set is_active=false where liability_id='${loanId}';`);
    const f = (await db.query(`select mode, summary_balance, detailed_net_value from smsf_funds where id='${fundId}'`)).rows[0] as Row;
    expect(f.mode).toBe('detailed');
    expect(Number(f.summary_balance)).toBe(138_000);
    expect(Number(f.detailed_net_value)).toBe(503_000);
    expect(await fundBalance()).toBe(503_000);
  });

  it('adding the loan with balance 0 and NOT yet linked changes nothing in the fund (still 503,000)', async () => {
    await db.exec(`insert into liabilities(user_id, liability_name, debt_type, balance, currency_code, owner) values ('${V}','SMSF property loan (new)','mortgage',0,'AUD','smsf');`);
    loanId = ((await db.query(`select id from liabilities where user_id='${V}' and liability_name='SMSF property loan (new)'`)).rows[0] as Row).id as string;
    expect(await fundBalance()).toBe(503_000);
  });

  it('linking it (still balance 0) keeps 503,000; then entering 365,000 makes the fund net 138,000 (the retirement row follows)', async () => {
    await db.exec(`insert into property_liability_links(user_id, linked_retirement_id, liability_id, link_type) values ('${V}','${fundRow}','${loanId}','smsf_property_loan');`);
    expect(await fundBalance()).toBe(503_000);
    await db.exec(`update liabilities set balance=365000 where id='${loanId}';`);
    expect(await fundNet()).toBe(138_000);
    expect(await fundBalance()).toBe(138_000);
  });

  it('with the confirmed 370,000 the fund net is 133,000', async () => {
    await db.exec(`update liabilities set balance=370000 where id='${loanId}';`);
    expect(await fundNet()).toBe(133_000);
    expect(await fundBalance()).toBe(133_000);
  });

  it('NEGATIVE CONTROL: an UNLINKED loan of 370,000 would NOT reduce the fund (it stays 503,000); the link is what does it', async () => {
    await db.exec(`update property_liability_links set is_active=false where liability_id='${loanId}';`);
    expect(await fundBalance()).toBe(503_000);
    await db.exec(`update property_liability_links set is_active=true where liability_id='${loanId}';`);
    expect(await fundBalance()).toBe(133_000);
  });

  it('the Summary value stays 138,000 in Detailed mode (cosmetic "Difference" of -5,000 against 370,000; not an error)', async () => {
    const f = (await db.query(`select summary_balance from smsf_funds where id='${fundId}'`)).rows[0] as Row;
    expect(Number(f.summary_balance)).toBe(138_000);
  });
});
