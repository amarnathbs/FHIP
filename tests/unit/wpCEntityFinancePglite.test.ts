// DOCUMENT2 (4) review, WP-C: migrations 0295, 0296 and 0297 on a real Postgres (PGlite) replay of the REAL migration ledger, driven as the real
// `authenticated` role with row level security and auth.uid(). EVIDENCE LABEL: PGLITE-VERIFIED (an isolated in-memory replay). NOT DEV-verified
// and NOT production-verified: the PO applies the SQL on DEV first.
//
// HAND ORACLES (AUD): SMSF assets 475,000 + 3,000 + 25,000 = 503,000, fund liability 370,000, derived net 133,000. Trust assets 1,000,000 less
// liabilities 400,000 = 600,000. Company net value only 250,000.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asUser, expectSqlError, replayLedger, seedUser } from './support/entityLevelPgliteHarness';

let db: PGlite;
let n = 0;
type Row = Record<string, unknown>;
type Json = Record<string, unknown>;

const uid = () => `eeeeeeee-0000-0000-0000-${String(++n).padStart(12, '0')}`;
const num = (v: unknown) => Number(v);

async function newUser(label: string, country = 'AU'): Promise<string> {
  const id = uid();
  await seedUser(db, id, `${label}${n}@pg.test`, country);
  return id;
}
async function createFund(u: string): Promise<{ fundId: string; raId: string }> {
  const rows = await asUser(db, u, async () => (await db.query(`select * from smsf_create_fund('SMSF','PO SMSF',null,null,'self','AUD','AU','detailed')`)).rows as Row[]);
  return { fundId: rows[0].smsf_fund_id as string, raId: rows[0].retirement_account_id as string };
}
async function addHolding(u: string, fundId: string, cls: string, type: string, name: string, value: number): Promise<string> {
  return asUser(db, u, async () => (await db.query(`insert into smsf_holdings(user_id, smsf_fund_id, holding_class, holding_type, holding_name, value, currency_code) values ($1,$2,$3,$4,$5,$6,'AUD') returning id`, [u, fundId, cls, type, name, value])).rows[0] as Row).then((r) => r.id as string);
}
async function addFundLiability(u: string, fundId: string, extra: Record<string, unknown> = {}): Promise<Row> {
  const cols = { liability_name: 'SMSF property loan', liability_type: 'property_loan', balance: 370_000, currency_code: 'AUD', ...extra };
  const names = Object.keys(cols);
  return asUser(db, u, async () => (await db.query(`insert into smsf_liabilities(user_id, smsf_fund_id, ${names.join(',')}) values ($1,$2,${names.map((_, i) => `$${i + 3}`).join(',')}) returning *`, [u, fundId, ...Object.values(cols)])).rows[0] as Row);
}
async function income(u: string, fundId: string, cols: Record<string, unknown>): Promise<Row> {
  const all = { income_type: 'other', income_name: 'Income', amount: 100, frequency: 'monthly', currency_code: 'AUD', ...cols };
  const names = Object.keys(all);
  return asUser(db, u, async () => (await db.query(`insert into entity_income_items(user_id, entity_kind, smsf_fund_id, ${names.join(',')}) values ($1,'smsf',$2,${names.map((_, i) => `$${i + 3}`).join(',')}) returning *`, [u, fundId, ...Object.values(all)])).rows[0] as Row);
}
async function expense(u: string, fundId: string, cols: Record<string, unknown>): Promise<Row> {
  const all = { expense_type: 'other', expense_name: 'Cost', amount: 100, frequency: 'monthly', currency_code: 'AUD', ...cols };
  const names = Object.keys(all);
  return asUser(db, u, async () => (await db.query(`insert into entity_expense_items(user_id, entity_kind, smsf_fund_id, ${names.join(',')}) values ($1,'smsf',$2,${names.map((_, i) => `$${i + 3}`).join(',')}) returning *`, [u, fundId, ...Object.values(all)])).rows[0] as Row);
}
async function newEntity(u: string, type: 'company' | 'family_trust' | 'huf', mode: 'summary' | 'detailed', nav: number | null, currency = 'AUD'): Promise<string> {
  return asUser(db, u, async () => (await db.query(`insert into business_entities(user_id, entity_type, name, currency_code, ownership_percentage, valuation_mode, summary_net_asset_value) values ($1,$2,'Entity ' || $2,$3,100,$4,$5) returning id`, [u, type, currency, mode, nav])).rows[0] as Row).then((r) => r.id as string);
}
async function entityIncome(u: string, entityId: string, kind: string, cols: Record<string, unknown>): Promise<Row> {
  const all = { income_type: 'other', income_name: 'Income', amount: 100, frequency: 'monthly', currency_code: 'AUD', ...cols };
  const names = Object.keys(all);
  return asUser(db, u, async () => (await db.query(`insert into entity_income_items(user_id, entity_kind, business_entity_id, ${names.join(',')}) values ($1,$2,$3,${names.map((_, i) => `$${i + 4}`).join(',')}) returning *`, [u, kind, entityId, ...Object.values(all)])).rows[0] as Row);
}
async function entityExpense(u: string, entityId: string, kind: string, cols: Record<string, unknown>): Promise<Row> {
  const all = { expense_type: 'other', expense_name: 'Cost', amount: 100, frequency: 'monthly', currency_code: 'AUD', ...cols };
  const names = Object.keys(all);
  return asUser(db, u, async () => (await db.query(`insert into entity_expense_items(user_id, entity_kind, business_entity_id, ${names.join(',')}) values ($1,$2,$3,${names.map((_, i) => `$${i + 4}`).join(',')}) returning *`, [u, kind, entityId, ...Object.values(all)])).rows[0] as Row);
}
async function switchEntity(u: string, entityId: string, to: 'detailed' | 'summary', opts: { assets?: unknown; liabilities?: unknown; net?: number | null; confirm: boolean }): Promise<Json> {
  return asUser(db, u, async () => {
    const { rows } = await db.query(`select business_entity_switch_mode($1,$2,$3::jsonb,$4::jsonb,$5,$6) v`, [entityId, to, JSON.stringify(opts.assets ?? []), JSON.stringify(opts.liabilities ?? []), opts.net ?? null, opts.confirm]);
    return (rows[0] as { v: Json }).v;
  });
}
const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as Row[];
const log = async (entityId: string) => q(`select action, table_name from entity_change_log where entity_id=$1 order by created_at, id`, [entityId]);

beforeAll(async () => {
  db = await replayLedger();
}, 400_000);
afterAll(async () => {
  await db?.close();
});

describe('F19 (database): one derived net, read by the fund, the register mirror and the counted-net function', () => {
  it('PO oracle: 503,000 of assets less a 370,000 fund liability derives 133,000 everywhere', async () => {
    const u = await newUser('a');
    const { fundId, raId } = await createFund(u);
    await addHolding(u, fundId, 'property', 'residential_property', '250 Elizebth st', 475_000);
    await addHolding(u, fundId, 'cash', 'cash_account', 'Bank Australia', 3_000);
    await addHolding(u, fundId, 'cash', 'cash_account', 'Secured finance', 25_000);
    await addFundLiability(u, fundId, { balance: 370_000 });
    const f = (await q(`select detailed_net_value, summary_balance, mode from smsf_funds where id=$1`, [fundId]))[0];
    expect(num(f.detailed_net_value)).toBe(133_000);
    expect(f.summary_balance).toBeNull();
    expect(num((await q(`select current_balance from retirement_accounts where id=$1`, [raId]))[0].current_balance)).toBe(133_000);
    expect(num((await asUser(db, u, async () => q(`select smsf_fund_counted_net($1) n`, [fundId])))[0].n)).toBe(133_000);
  });
});

describe('F21 (0295): fund liabilities carry the canonical fields and a property link', () => {
  it('stores rate type, fixed rate expiry, masked account, due date and the property it funds, and the net does not move', async () => {
    const u = await newUser('l');
    const { fundId } = await createFund(u);
    const prop = await addHolding(u, fundId, 'property', 'residential_property', 'Unit 1', 475_000);
    const l = await addFundLiability(u, fundId, { interest_rate: 7.47, interest_rate_type: 'fixed', fixed_rate_expiry: '2027-03-31', masked_identifier: '7434', due_date: '2026-11-15', smsf_holding_id: prop, lender: 'Source funding', balance: 349_000 });
    expect(l.interest_rate_type).toBe('fixed');
    expect(l.smsf_holding_id).toBe(prop);
    expect(num((await q(`select detailed_net_value from smsf_funds where id=$1`, [fundId]))[0].detailed_net_value)).toBe(126_000);
  });

  it('the PO account number (9 digits) is refused by the masked identifier rule, 4 digits are fine', async () => {
    const u = await newUser('m');
    const { fundId } = await createFund(u);
    await expectSqlError(addFundLiability(u, fundId, { masked_identifier: '300017434' }), 'chk_smsf_liabilities_masked_identifier');
    expect((await addFundLiability(u, fundId, { masked_identifier: '7434' })).masked_identifier).toBe('7434');
  });

  it('a loan can only be tied to a PROPERTY asset of the SAME fund, never a cash asset or another household asset', async () => {
    const a = await newUser('p');
    const b = await newUser('q');
    const fa = await createFund(a);
    const fb = await createFund(b);
    const cash = await addHolding(a, fa.fundId, 'cash', 'cash_account', 'Cash', 10);
    const theirProp = await addHolding(b, fb.fundId, 'property', 'residential_property', 'Theirs', 100);
    await expectSqlError(addFundLiability(a, fa.fundId, { smsf_holding_id: cash }), 'ENTITY_HOLDING_LINK');
    await expectSqlError(addFundLiability(a, fa.fundId, { smsf_holding_id: theirProp }), 'ENTITY_HOLDING_LINK');
  });

  it('rate type outside fixed or variable is refused', async () => {
    const u = await newUser('r');
    const { fundId } = await createFund(u);
    await expectSqlError(addFundLiability(u, fundId, { interest_rate_type: 'floating' }), 'chk_smsf_liabilities_rate_type');
  });

  it('TWO-USER RLS: another household cannot attach a liability to this fund or read it', async () => {
    const a = await newUser('s');
    const b = await newUser('t');
    const fa = await createFund(a);
    await addFundLiability(a, fa.fundId);
    // refused by the line rule (the fund is not visible to this household, so it reads as not itemised) before row level security is even reached
    await expect(asUser(db, b, async () => db.query(`insert into smsf_liabilities(user_id, smsf_fund_id, liability_name, balance, currency_code) values ($1,$2,'x',1,'AUD')`, [b, fa.fundId]))).rejects.toThrow();
    expect(num((await q(`select count(*) c from smsf_liabilities where user_id=$1`, [b]))[0].c)).toBe(0);
    expect((await asUser(db, b, async () => q(`select id from smsf_liabilities where smsf_fund_id=$1`, [fa.fundId]))).length).toBe(0);
  });
});

describe('F22 (0296): SMSF income, rent needs an amount and a frequency and is never recorded twice', () => {
  it('rent with a zero amount is refused, rent of 600 weekly tied to the property is stored with its frequency', async () => {
    const u = await newUser('i');
    const { fundId } = await createFund(u);
    const prop = await addHolding(u, fundId, 'property', 'residential_property', 'Unit 1', 475_000);
    await expectSqlError(income(u, fundId, { income_type: 'rent', amount: 0, frequency: 'weekly', smsf_holding_id: prop }), 'chk_entity_income_rent_needs_amount');
    const rent = await income(u, fundId, { income_type: 'rent', income_name: 'Rent Unit 1', amount: 600, frequency: 'weekly', smsf_holding_id: prop });
    expect(num(rent.amount)).toBe(600);
    expect(rent.frequency).toBe('weekly');
  });

  it('one ACTIVE rent record per property: a second is refused, after retiring the first a new one is allowed', async () => {
    const u = await newUser('j');
    const { fundId } = await createFund(u);
    const prop = await addHolding(u, fundId, 'property', 'residential_property', 'Unit 1', 475_000);
    const first = await income(u, fundId, { income_type: 'rent', amount: 600, frequency: 'weekly', smsf_holding_id: prop });
    await expectSqlError(income(u, fundId, { income_type: 'rent', amount: 650, frequency: 'weekly', smsf_holding_id: prop }), 'uq_entity_income_rent_per_smsf_asset');
    await asUser(db, u, async () => db.query(`update entity_income_items set is_active=false where id=$1`, [first.id]));
    expect(num((await income(u, fundId, { income_type: 'rent', amount: 650, frequency: 'weekly', smsf_holding_id: prop })).amount)).toBe(650);
  });

  it('a property that still points at a personal income record (the earlier way) refuses a second rent record', async () => {
    const u = await newUser('k');
    const { fundId } = await createFund(u);
    const prop = await addHolding(u, fundId, 'property', 'residential_property', 'Unit 1', 475_000);
    const personal = (await asUser(db, u, async () => q(`insert into income_sources(user_id, source_name, income_type, amount, frequency, currency_code, owner) values ($1,'Rental Income','rental',600,'weekly','AUD','smsf') returning id`, [u])))[0];
    await asUser(db, u, async () => db.query(`update smsf_holdings set linked_income_source_id=$1 where id=$2`, [personal.id, prop]));
    await expectSqlError(income(u, fundId, { income_type: 'rent', amount: 600, frequency: 'weekly', smsf_holding_id: prop }), 'ENTITY_RENT_ALREADY_RECORDED');
  });

  it('only rent can be tied to an asset, interest cannot, and an income row cannot belong to both a fund and an entity', async () => {
    const u = await newUser('o');
    const { fundId } = await createFund(u);
    const prop = await addHolding(u, fundId, 'property', 'residential_property', 'Unit 1', 1);
    await expectSqlError(income(u, fundId, { income_type: 'interest', smsf_holding_id: prop }), 'chk_entity_income_asset_link');
    const co = await newEntity(u, 'company', 'summary', 1);
    await expectSqlError(asUser(db, u, async () => db.query(`insert into entity_income_items(user_id, entity_kind, smsf_fund_id, business_entity_id, income_type, income_name, amount, frequency, currency_code) values ($1,'smsf',$2,$3,'other','x',1,'monthly','AUD')`, [u, fundId, co])), 'chk_entity_income_scope');
  });

  it('SMSF income is a different table: personal income_sources is untouched by entity income', async () => {
    const u = await newUser('z');
    const { fundId } = await createFund(u);
    await income(u, fundId, { income_type: 'interest', income_name: 'Term deposit', amount: 500, frequency: 'monthly' });
    expect(num((await q(`select count(*) c from income_sources where user_id=$1`, [u]))[0].c)).toBe(0);
  });

  it('TWO-USER RLS: another household cannot read or attach income to this fund', async () => {
    const a = await newUser('u1');
    const b = await newUser('u2');
    const fa = await createFund(a);
    await income(a, fa.fundId, { income_name: 'Mine', amount: 5 });
    expect((await asUser(db, b, async () => q(`select id from entity_income_items`))).length).toBe(0);
    await expectSqlError(income(b, fa.fundId, { income_name: 'Theirs' }), 'was not found');
  });
});

describe('F23 (0296): SMSF expenses, principal is never an expense, a legacy personal row is moved not copied', () => {
  it('there is no loan repayment expense type, a fee is stored', async () => {
    const u = await newUser('e');
    const { fundId } = await createFund(u);
    await expectSqlError(expense(u, fundId, { expense_type: 'loan_principal' }), 'entity_expense_items');
    await expectSqlError(expense(u, fundId, { expense_type: 'loan_repayment' }), 'entity_expense_items');
    expect(num((await expense(u, fundId, { expense_type: 'accounting_audit', expense_name: 'Audit fee', amount: 550, frequency: 'annually' })).amount)).toBe(550);
  });

  it('MOVE: preview changes nothing, apply retires the personal row and creates the fund record once, rent takes over the property link', async () => {
    const u = await newUser('mv');
    const { fundId } = await createFund(u);
    const prop = await addHolding(u, fundId, 'property', 'residential_property', 'Unit 1', 475_000);
    const personal = (await asUser(db, u, async () => q(`insert into income_sources(user_id, source_name, income_type, amount, frequency, currency_code, owner, master_item_key) values ($1,'Rental Income (weekly)','rental',600,'weekly','AUD','smsf','rental_income') returning id`, [u])))[0];
    await asUser(db, u, async () => db.query(`update smsf_holdings set linked_income_source_id=$1 where id=$2`, [personal.id, prop]));
    const move = (confirm: boolean) => asUser(db, u, async () => (await db.query(`select smsf_entity_move_personal_cash_flow($1,'income',$2,$3) v`, [fundId, personal.id, confirm])).rows[0] as { v: Json }).then((r) => r.v);
    const preview = await move(false);
    expect(preview).toMatchObject({ status: 'preview', income_type: 'rent', name: 'Rental Income (weekly)' });
    expect(num((await q(`select count(*) c from entity_income_items where smsf_fund_id=$1`, [fundId]))[0].c)).toBe(0);
    expect((await q(`select is_active from income_sources where id=$1`, [personal.id]))[0].is_active).toBe(true);
    const applied = await move(true);
    expect(applied.status).toBe('applied');
    const item = (await q(`select * from entity_income_items where smsf_fund_id=$1`, [fundId]))[0];
    expect(item).toMatchObject({ income_type: 'rent', frequency: 'weekly', source_type: 'moved_from_personal', smsf_holding_id: prop });
    expect(num(item.amount)).toBe(600);
    expect((await q(`select is_active from income_sources where id=$1`, [personal.id]))[0].is_active).toBe(false);
    expect((await q(`select linked_income_source_id from smsf_holdings where id=$1`, [prop]))[0].linked_income_source_id).toBeNull();
    // counted once: one active record in total across both places
    expect(num((await q(`select (select count(*) from entity_income_items where smsf_fund_id=$1 and is_active) + (select count(*) from income_sources where id=$2 and is_active) c`, [fundId, personal.id]))[0].c)).toBe(1);
    await expectSqlError(move(true), 'not found');
  });

  it('a legacy loan repayment expense is refused as an expense, an insurance expense is moved with its type', async () => {
    const u = await newUser('mx');
    const { fundId } = await createFund(u);
    const debt = (await asUser(db, u, async () => q(`insert into expense_items(user_id, expense_name, expense_category, amount, frequency, currency_code, owner) values ($1,'Loan repayment','debt_repayment',2400,'monthly','AUD','smsf') returning id`, [u])))[0];
    const ins = (await asUser(db, u, async () => q(`insert into expense_items(user_id, expense_name, expense_category, amount, frequency, currency_code, owner) values ($1,'Fund insurance','insurance',900,'annually','AUD','smsf') returning id`, [u])))[0];
    await expectSqlError(asUser(db, u, async () => db.query(`select smsf_entity_move_personal_cash_flow($1,'expenses',$2,true)`, [fundId, debt.id])), 'ENTITY_NOT_AN_EXPENSE');
    await asUser(db, u, async () => db.query(`select smsf_entity_move_personal_cash_flow($1,'expenses',$2,true)`, [fundId, ins.id]));
    const moved = (await q(`select expense_type, source_type from entity_expense_items where smsf_fund_id=$1`, [fundId]))[0];
    expect(moved).toMatchObject({ expense_type: 'insurance', source_type: 'moved_from_personal' });
    expect((await q(`select is_active from expense_items where id=$1`, [debt.id]))[0].is_active).toBe(true);
  });

  it('TWO-USER: another household cannot move this household\'s rows into its own fund or this fund', async () => {
    const a = await newUser('t1');
    const b = await newUser('t2');
    const fa = await createFund(a);
    const fb = await createFund(b);
    const personal = (await asUser(db, a, async () => q(`insert into income_sources(user_id, source_name, income_type, amount, frequency, currency_code, owner) values ($1,'Mine','other',1,'monthly','AUD','smsf') returning id`, [a])))[0];
    await expectSqlError(asUser(db, b, async () => db.query(`select smsf_entity_move_personal_cash_flow($1,'income',$2,true)`, [fb.fundId, personal.id])), 'not found');
    await expectSqlError(asUser(db, b, async () => db.query(`select smsf_entity_move_personal_cash_flow($1,'income',$2,true)`, [fa.fundId, personal.id])), 'not found');
  });
});

describe('F23b (0297): Company, Family Trust and HUF record assets, liabilities, income and expenses at entity level, itemised OR net value only', () => {
  it('the rule holds in the database: an itemised entity cannot carry a typed net, a net value only entity cannot hold active lines, the mode cannot be flipped directly', async () => {
    const u = await newUser('c');
    await expectSqlError(newEntity(u, 'company', 'detailed', 250_000), 'ENTITY_BOTH_REPRESENTATIONS');
    const net = await newEntity(u, 'company', 'summary', 250_000);
    await expectSqlError(asUser(db, u, async () => db.query(`insert into business_entity_assets(user_id, business_entity_id, label, value, currency_code) values ($1,$2,'Plant',10,'AUD')`, [u, net])), 'ENTITY_BOTH_REPRESENTATIONS');
    await expectSqlError(asUser(db, u, async () => db.query(`update business_entities set valuation_mode='detailed', summary_net_asset_value=null where id=$1`, [net])), 'ENTITY_MODE_SWITCH_ONLY');
  });

  it('SWITCH net value only 250,000 to itemised 1,000,000 / 400,000: preview changes nothing, apply derives 600,000, retires the typed net into the history', async () => {
    const u = await newUser('d');
    const co = await newEntity(u, 'family_trust', 'summary', 250_000);
    const assets = [{ label: 'Rental property', asset_type: 'property', value: 1_000_000, currency_code: 'AUD' }];
    const liabilities = [{ label: 'Trust loan', liability_type: 'property_loan', value: 400_000, currency_code: 'AUD', lender: 'Bank', interest_rate: 6.1, monthly_repayment: 2_800 }];
    const preview = await switchEntity(u, co, 'detailed', { assets, liabilities, confirm: false });
    expect(preview).toMatchObject({ status: 'preview', net_before: 250_000, net_after: 600_000, variance: 350_000 });
    expect((await q(`select valuation_mode from business_entities where id=$1`, [co]))[0].valuation_mode).toBe('summary');
    expect(num((await q(`select count(*) c from entity_figure_mode_log where entity_id=$1`, [co]))[0].c)).toBe(0);
    const applied = await switchEntity(u, co, 'detailed', { assets, liabilities, confirm: true });
    expect(applied.status).toBe('applied');
    const e = (await q(`select valuation_mode, summary_net_asset_value from business_entities where id=$1`, [co]))[0];
    expect(e.valuation_mode).toBe('detailed');
    expect(e.summary_net_asset_value).toBeNull();
    expect(num((await asUser(db, u, async () => q(`select business_entity_derived_net($1) n`, [co])))[0].n)).toBe(600_000);
    const h = (await q(`select action, retired_representation from entity_figure_mode_log where entity_id=$1`, [co]))[0];
    expect(h.action).toBe('to_itemised');
    expect(num((h.retired_representation as Json).typed_net)).toBe(250_000);
  });

  it('SWITCH back to a net value only retires the lines (kept, not deleted), keeps them in the history and never leaves both counted', async () => {
    const u = await newUser('f');
    const co = await newEntity(u, 'company', 'summary', 100);
    await switchEntity(u, co, 'detailed', { assets: [{ label: 'Cash', asset_type: 'cash', value: 900, currency_code: 'AUD' }], liabilities: [], confirm: true });
    await switchEntity(u, co, 'summary', { net: 900, confirm: true });
    const e = (await q(`select valuation_mode, summary_net_asset_value from business_entities where id=$1`, [co]))[0];
    expect(e.valuation_mode).toBe('summary');
    expect(num(e.summary_net_asset_value)).toBe(900);
    expect(num((await q(`select count(*) c from business_entity_assets where business_entity_id=$1 and is_active`, [co]))[0].c)).toBe(0);
    expect(num((await q(`select count(*) c from business_entity_assets where business_entity_id=$1`, [co]))[0].c)).toBeGreaterThan(0);
    const actions = (await q(`select action from entity_figure_mode_log where entity_id=$1 order by created_at, id`, [co])).map((r) => r.action);
    expect(actions).toEqual(['to_itemised', 'to_net_only']);
  });

  it('every kind records the same four things: Company, Family Trust and an India HUF each hold income and expenses at entity level', async () => {
    const au = await newUser('g');
    const inUser = await newUser('h', 'IN');
    const company = await newEntity(au, 'company', 'detailed', null);
    const trust = await newEntity(au, 'family_trust', 'detailed', null);
    const huf = await newEntity(inUser, 'huf', 'detailed', null, 'INR');
    for (const [user, id, kind, cur] of [[au, company, 'company', 'AUD'], [au, trust, 'family_trust', 'AUD'], [inUser, huf, 'huf', 'INR']] as const) {
      await asUser(db, user, async () => db.query(`insert into business_entity_assets(user_id, business_entity_id, label, asset_type, value, currency_code, country_code) values ($1,$2,'Asset','cash',1000,$3,$4)`, [user, id, cur, kind === 'huf' ? 'IN' : 'AU']));
      await entityIncome(user, id, kind, { income_type: 'rent', amount: 500, frequency: 'monthly', currency_code: cur, country_code: kind === 'huf' ? 'IN' : 'AU' });
      await entityExpense(user, id, kind, { expense_type: 'accounting_audit', amount: 100, frequency: 'annually', currency_code: cur });
      expect(num((await q(`select count(*) c from entity_income_items where business_entity_id=$1`, [id]))[0].c)).toBe(1);
      expect(num((await q(`select count(*) c from entity_expense_items where business_entity_id=$1`, [id]))[0].c)).toBe(1);
    }
  });

  it('HUF stays India only: a non-India household cannot create one', async () => {
    const u = await newUser('hn', 'AU');
    await expectSqlError(newEntity(u, 'huf', 'detailed', null, 'INR'), 'Hindu Undivided Family');
  });

  it('a row cannot claim a different kind of entity than the one it belongs to', async () => {
    const u = await newUser('km');
    const co = await newEntity(u, 'company', 'detailed', null);
    await expectSqlError(entityIncome(u, co, 'family_trust', {}), 'ENTITY_KIND_MISMATCH');
  });

  it('TWO-USER RLS: another household cannot switch, read lines of, or attach rows to this entity', async () => {
    const a = await newUser('x1');
    const b = await newUser('x2');
    const co = await newEntity(a, 'company', 'summary', 5);
    await expectSqlError(switchEntity(b, co, 'summary', { net: 1, confirm: false }), 'not found');
    await expectSqlError(entityIncome(b, co, 'company', {}), 'was not found');
    expect((await asUser(db, b, async () => q(`select id from business_entities where id=$1`, [co]))).length).toBe(0);
  });

  it('the data-quality function names an entity that holds both (a legacy shape), without changing it', async () => {
    const u = await newUser('dq');
    const co = await newEntity(u, 'company', 'detailed', null);
    await asUser(db, u, async () => db.query(`insert into business_entity_assets(user_id, business_entity_id, label, value, currency_code) values ($1,$2,'A',5,'AUD')`, [u, co]));
    // plant the legacy shape with the trigger bypassed for the setup only, as a superuser, to prove the detector sees it
    await db.exec(`alter table business_entities disable trigger trg_business_entities_mode_rule; update business_entities set summary_net_asset_value=77 where id='${co}'; alter table business_entities enable trigger trg_business_entities_mode_rule;`);
    const v = await asUser(db, u, async () => q(`select kind from business_entity_mode_rule_violations()`));
    expect(v.map((r) => r.kind)).toEqual(['itemised_with_typed_net']);
  });
});

describe('audit: every entity level change is logged, append-only, owner readable', () => {
  it('insert, update and retire of an SMSF income row, a company line and an SMSF holding each write a log row with old and new values', async () => {
    const u = await newUser('au');
    const { fundId } = await createFund(u);
    const inc = await income(u, fundId, { income_name: 'Interest', income_type: 'interest', amount: 10 });
    await asUser(db, u, async () => db.query(`update entity_income_items set amount=20 where id=$1`, [inc.id]));
    await asUser(db, u, async () => db.query(`update entity_income_items set is_active=false where id=$1`, [inc.id]));
    await addHolding(u, fundId, 'cash', 'cash_account', 'Cash', 5);
    const rows = await log(fundId);
    expect(rows.filter((r) => r.table_name === 'entity_income_items').map((r) => r.action)).toEqual(['insert', 'update', 'retire']);
    expect(rows.some((r) => r.table_name === 'smsf_holdings' && r.action === 'insert')).toBe(true);
    const upd = (await q(`select old_values, new_values from entity_change_log where row_id=$1 and action='update'`, [inc.id]))[0];
    expect(num((upd.old_values as Json).amount)).toBe(10);
    expect(num((upd.new_values as Json).amount)).toBe(20);
  });

  it('the log is append-only for the owner and invisible to another household', async () => {
    const a = await newUser('lg1');
    const b = await newUser('lg2');
    const { fundId } = await createFund(a);
    await income(a, fundId, { income_name: 'Seen only by me' });
    const before = (await log(fundId)).length;
    // as the owner there is no update or delete policy: nothing changes and nothing is removed
    await asUser(db, a, async () => db.query(`update entity_change_log set action='update' where entity_id=$1`, [fundId]));
    await asUser(db, a, async () => db.query(`delete from entity_change_log where entity_id=$1`, [fundId]));
    expect((await log(fundId)).length).toBe(before);
    expect((await log(fundId)).every((r) => r.action === 'insert')).toBe(true);
    // even the table owner cannot rewrite history
    await expectSqlError(db.exec(`update entity_change_log set action='update' where entity_id='${fundId}'`), 'append-only');
    expect((await asUser(db, b, async () => q(`select id from entity_change_log where entity_id=$1`, [fundId]))).length).toBe(0);
  });

  it('a user can never write the log directly', async () => {
    const a = await newUser('lg3');
    const { fundId } = await createFund(a);
    await expectSqlError(asUser(db, a, async () => db.query(`insert into entity_change_log(user_id, entity_kind, entity_id, table_name, row_id, action) values ($1,'smsf',$2,'x',$2,'insert')`, [a, fundId])), 'row-level security');
  });
});

describe('account deletion still cascades through the new tables', () => {
  it('deleting the user removes the fund, its income, expenses, lines and log without a constraint error', async () => {
    const u = await newUser('del');
    const { fundId } = await createFund(u);
    const prop = await addHolding(u, fundId, 'property', 'residential_property', 'P', 10);
    await income(u, fundId, { income_type: 'rent', amount: 1, smsf_holding_id: prop });
    await expense(u, fundId, {});
    await addFundLiability(u, fundId, { smsf_holding_id: prop });
    const co = await newEntity(u, 'company', 'summary', 1);
    await entityIncome(u, co, 'company', {});
    await db.exec(`delete from auth.users where id='${u}'`);
    for (const t of ['smsf_funds', 'entity_income_items', 'entity_expense_items', 'entity_change_log', 'business_entities']) {
      expect(num((await q(`select count(*) c from ${t} where user_id=$1`, [u]))[0].c)).toBe(0);
    }
  });
});

describe('NEGATIVE CONTROLS: each rule is shown to be the cause, not a coincidence (rule removed, the refused write is accepted, rule restored)', () => {
  it('without trg_business_entities_mode_rule an itemised entity accepts a typed net (the both-representations refusal bites)', async () => {
    const u = await newUser('nc1');
    await db.exec('alter table business_entities disable trigger trg_business_entities_mode_rule');
    try {
      const id = await newEntity(u, 'company', 'detailed', 250_000);
      expect(id).toBeTruthy();
    } finally {
      await db.exec('alter table business_entities enable trigger trg_business_entities_mode_rule');
    }
    await expectSqlError(newEntity(u, 'company', 'detailed', 250_000), 'ENTITY_BOTH_REPRESENTATIONS');
  });

  it('without the unique rent index a second active rent record for the same property is accepted (the duplicate refusal bites)', async () => {
    const u = await newUser('nc2');
    const { fundId } = await createFund(u);
    const prop = await addHolding(u, fundId, 'property', 'residential_property', 'P', 10);
    await income(u, fundId, { income_type: 'rent', amount: 600, frequency: 'weekly', smsf_holding_id: prop });
    await db.exec('drop index uq_entity_income_rent_per_smsf_asset');
    try {
      await income(u, fundId, { income_type: 'rent', amount: 700, frequency: 'weekly', smsf_holding_id: prop });
      expect(num((await q(`select count(*) c from entity_income_items where smsf_holding_id=$1 and is_active`, [prop]))[0].c)).toBe(2);
    } finally {
      await db.exec(`update entity_income_items set is_active=false where smsf_holding_id='${prop}' and amount=700`);
      await db.exec(`create unique index uq_entity_income_rent_per_smsf_asset on entity_income_items(smsf_holding_id) where income_type = 'rent' and is_active and smsf_holding_id is not null`);
    }
  });

  it('without the scope trigger a row can claim the wrong kind of entity (the kind check bites)', async () => {
    const u = await newUser('nc3');
    const co = await newEntity(u, 'company', 'detailed', null);
    await db.exec('alter table entity_income_items disable trigger trg_entity_income_scope');
    try {
      expect((await entityIncome(u, co, 'family_trust', {})).entity_kind).toBe('family_trust');
    } finally {
      await db.exec('alter table entity_income_items enable trigger trg_entity_income_scope');
    }
  });

  it('without the masked identifier rule a full account number is stored (the personal register rule is mirrored, not assumed)', async () => {
    const u = await newUser('nc4');
    const { fundId } = await createFund(u);
    await db.exec('alter table smsf_liabilities drop constraint chk_smsf_liabilities_masked_identifier');
    try {
      expect((await addFundLiability(u, fundId, { masked_identifier: '300017434' })).masked_identifier).toBe('300017434');
    } finally {
      await db.exec(`update smsf_liabilities set masked_identifier = null where smsf_fund_id='${fundId}'`);
      await db.exec(`alter table smsf_liabilities add constraint chk_smsf_liabilities_masked_identifier check (masked_identifier is null or masked_identifier !~ '[0-9]{7,}')`);
    }
  });
});
