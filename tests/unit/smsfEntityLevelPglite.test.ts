// SMSF entity-level assets AND liabilities, itemised OR net value only (migrations 0289, 0290): real-Postgres (PGlite) proof on the REAL
// migration ledger, driven as the real `authenticated` role with RLS and auth.uid().
// EVIDENCE LABEL: "verified on an isolated PGlite replay". Not DEV- or production-verified.
//
// HAND ORACLES (AUD): holdings 475,000 + 3,000 + 25,000 = 503,000; liability 370,000; derived net 133,000. A net-only fund of 133,000 is
// the same 133,000. Typed net 138,000 against the same itemised set is a variance of -5,000.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asUser, expectSqlError, replayLedger, seedUser } from './support/entityLevelPgliteHarness';

let db: PGlite;
let n = 0;
type Row = Record<string, unknown>;
type Json = Record<string, unknown>;

const uid = () => `dddddddd-0000-0000-0000-${String(++n).padStart(12, '0')}`;
const num = (v: unknown) => Number(v);

async function newUser(label: string): Promise<string> {
  const id = uid();
  await seedUser(db, id, `${label}${n}@pg.test`);
  return id;
}
async function createFund(u: string, mode: 'detailed' | 'summary', net: number | null = null): Promise<{ fundId: string; raId: string }> {
  const rows = await asUser(db, u, async () => (await db.query(`select * from smsf_create_fund('SMSF','PO SMSF',$1,null,'self','AUD','AU',$2)`, [net, mode])).rows as Row[]);
  return { fundId: rows[0].smsf_fund_id as string, raId: rows[0].retirement_account_id as string };
}
const balance = async (raId: string) => num(((await db.query(`select current_balance from retirement_accounts where id=$1`, [raId])).rows[0] as Row).current_balance);
const fundRow = async (fundId: string) => (await db.query(`select * from smsf_funds where id=$1`, [fundId])).rows[0] as Row;
const ASSETS = [
  { holding_class: 'property', holding_type: 'residential_property', holding_name: '250 Elizebth st Melbourne 3000', value: 475_000, currency_code: 'AUD' },
  { holding_class: 'cash', holding_type: 'cash_account', holding_name: 'Bank Australia', value: 3_000, currency_code: 'AUD' },
  { holding_class: 'cash', holding_type: 'cash_account', holding_name: 'Secured finance', value: 25_000, currency_code: 'AUD' },
];
const LOAN = (balanceAmount = 370_000) => [{ liability_name: 'SMSF property loan', liability_type: 'property_loan', lender: 'Example Bank', balance: balanceAmount, interest_rate: 6.2, monthly_repayment: 2_400, currency_code: 'AUD' }];
async function addAssets(u: string, fundId: string) {
  await asUser(db, u, async () => {
    for (const a of ASSETS) {
      await db.query(`insert into smsf_holdings(user_id, smsf_fund_id, holding_class, holding_type, holding_name, value, currency_code) values ($1,$2,$3,$4,$5,$6,$7)`, [u, fundId, a.holding_class, a.holding_type, a.holding_name, a.value, a.currency_code]);
    }
  });
}
async function addLoan(u: string, fundId: string, amount = 370_000) {
  await asUser(db, u, async () => {
    await db.query(`insert into smsf_liabilities(user_id, smsf_fund_id, liability_name, liability_type, balance, currency_code) values ($1,$2,'SMSF property loan','property_loan',$3,'AUD')`, [u, fundId, amount]);
  });
}
async function switchMode(u: string, fundId: string, to: 'detailed' | 'summary', opts: { assets?: unknown; liabilities?: unknown; net?: number | null; confirm: boolean }): Promise<Json> {
  return asUser(db, u, async () => {
    const { rows } = await db.query(`select smsf_entity_switch_mode($1,$2,$3::jsonb,$4::jsonb,$5,null,$6) v`, [fundId, to, JSON.stringify(opts.assets ?? []), JSON.stringify(opts.liabilities ?? []), opts.net ?? null, opts.confirm]);
    return (rows[0] as { v: Json }).v;
  });
}
const logCount = async (fundId: string) => num(((await db.query(`select count(*) c from entity_figure_mode_log where entity_id=$1`, [fundId])).rows[0] as Row).c);

beforeAll(async () => {
  db = await replayLedger();
}, 300_000);
afterAll(async () => {
  await db?.close();
});

describe('itemised fund: assets and liabilities entered, net derived', () => {
  it('a fund created itemised starts with no typed net and a zero balance', async () => {
    const u = await newUser('a');
    const { fundId, raId } = await createFund(u, 'detailed');
    const f = await fundRow(fundId);
    expect(f.mode).toBe('detailed');
    expect(f.summary_balance).toBeNull();
    expect(await balance(raId)).toBe(0);
  });

  it('PO oracle: holdings 475,000 + 3,000 + 25,000 less the loan 370,000 derives a net of 133,000, and the fund row follows', async () => {
    const u = await newUser('b');
    const { fundId, raId } = await createFund(u, 'detailed');
    await addAssets(u, fundId);
    expect(await balance(raId)).toBe(503_000);
    await addLoan(u, fundId, 370_000);
    expect(num((await fundRow(fundId)).detailed_net_value)).toBe(133_000);
    expect(await balance(raId)).toBe(133_000);
  });

  it('editing or archiving the loan re-derives the net (365,000 gives 138,000; archived gives 503,000)', async () => {
    const u = await newUser('c');
    const { fundId, raId } = await createFund(u, 'detailed');
    await addAssets(u, fundId);
    await addLoan(u, fundId, 370_000);
    await asUser(db, u, () => db.query(`update smsf_liabilities set balance=365000 where smsf_fund_id=$1`, [fundId]));
    expect(await balance(raId)).toBe(138_000);
    await asUser(db, u, () => db.query(`update smsf_liabilities set is_active=false where smsf_fund_id=$1`, [fundId]));
    expect(await balance(raId)).toBe(503_000);
  });

  it('a fund that owes more than it owns shows a NEGATIVE derived net (no clamp)', async () => {
    const u = await newUser('neg');
    const { fundId, raId } = await createFund(u, 'detailed');
    await asUser(db, u, () => db.query(`insert into smsf_holdings(user_id, smsf_fund_id, holding_class, holding_type, holding_name, value, currency_code) values ($1,$2,'cash','cash','Cash',100000,'AUD')`, [u, fundId]));
    await addLoan(u, fundId, 150_000);
    const f = await fundRow(fundId);
    expect(num(f.detailed_net_value)).toBe(-50_000);
    expect(num(((await db.query(`select smsf_fund_counted_net($1) v`, [fundId])).rows[0] as Row).v)).toBe(-50_000);
    // the Retirement-register mirror cannot hold a negative (CHECK >= 0 since migration 0003), so it is floored at zero
    expect(await balance(raId)).toBe(0);
  });
});

describe('the either-or rule in the database', () => {
  it('an itemised fund REJECTS a typed net value', async () => {
    const u = await newUser('d');
    const { fundId } = await createFund(u, 'detailed');
    await expectSqlError(asUser(db, u, () => db.query(`update smsf_funds set summary_balance=133000 where id=$1`, [fundId])), 'ENTITY_BOTH_REPRESENTATIONS');
    expect((await fundRow(fundId)).summary_balance).toBeNull();
  });

  it('a net-value-only fund REJECTS an asset line and a liability line', async () => {
    const u = await newUser('e');
    const { fundId, raId } = await createFund(u, 'summary', 133_000);
    expect(await balance(raId)).toBe(133_000);
    await expectSqlError(
      asUser(db, u, () => db.query(`insert into smsf_holdings(user_id, smsf_fund_id, holding_class, holding_type, holding_name, value, currency_code) values ($1,$2,'cash','cash','Cash',1,'AUD')`, [u, fundId])),
      'ENTITY_BOTH_REPRESENTATIONS',
    );
    await expectSqlError(
      asUser(db, u, () => db.query(`insert into smsf_liabilities(user_id, smsf_fund_id, liability_name, balance, currency_code) values ($1,$2,'Loan',1,'AUD')`, [u, fundId])),
      'ENTITY_BOTH_REPRESENTATIONS',
    );
    expect(await balance(raId)).toBe(133_000);
  });

  it('the recording mode cannot be flipped by a direct update (only through the switch function)', async () => {
    const u = await newUser('f');
    const { fundId } = await createFund(u, 'summary', 10);
    await expectSqlError(asUser(db, u, () => db.query(`update smsf_funds set mode='detailed', summary_balance=null where id=$1`, [fundId])), 'ENTITY_MODE_SWITCH_ONLY');
    expect((await fundRow(fundId)).mode).toBe('summary');
  });

  it('NEGATIVE CONTROL: with the rule trigger removed the same typed net IS accepted (so the rejection above is the rule, nothing else)', async () => {
    const u = await newUser('g');
    const { fundId } = await createFund(u, 'detailed');
    await db.exec('alter table smsf_funds disable trigger trg_smsf_funds_mode_rule;');
    try {
      await db.query(`update smsf_funds set summary_balance=133000 where id=$1`, [fundId]);
      expect(num((await fundRow(fundId)).summary_balance)).toBe(133_000);
    } finally {
      await db.exec('alter table smsf_funds enable trigger trg_smsf_funds_mode_rule;');
    }
  });

  it('NEGATIVE CONTROL: with the line trigger removed an asset IS accepted on a net-only fund', async () => {
    const u = await newUser('h');
    const { fundId } = await createFund(u, 'summary', 50);
    await db.exec('alter table smsf_holdings disable trigger trg_smsf_holdings_mode_rule;');
    try {
      await db.query(`insert into smsf_holdings(user_id, smsf_fund_id, holding_class, holding_type, holding_name, value, currency_code) values ($1,$2,'cash','cash','Cash',1,'AUD')`, [u, fundId]);
      expect(num(((await db.query(`select count(*) c from smsf_holdings where smsf_fund_id=$1`, [fundId])).rows[0] as Row).c)).toBe(1);
    } finally {
      await db.exec('alter table smsf_holdings enable trigger trg_smsf_holdings_mode_rule;');
    }
  });

  it('the data-quality function lists a fund holding both representations', async () => {
    const u = await newUser('i');
    const { fundId } = await createFund(u, 'detailed');
    await db.exec('alter table smsf_funds disable trigger trg_smsf_funds_mode_rule;');
    await db.query(`update smsf_funds set summary_balance=138000 where id=$1`, [fundId]);
    await db.exec('alter table smsf_funds enable trigger trg_smsf_funds_mode_rule;');
    const rows = await asUser(db, u, async () => (await db.query(`select * from smsf_mode_rule_violations()`)).rows as Row[]);
    expect(rows.map((r) => r.kind)).toEqual(['itemised_with_typed_net']);
    // ordinary maintenance of that legacy row is still allowed (the rule acts on a change of the mode or the typed net only)
    await asUser(db, u, () => db.query(`update smsf_funds set notes='kept' where id=$1`, [fundId]));
  });
});

describe('switch: preview-first, atomic, with history and undo', () => {
  it('net-only 133,000 to itemised (503,000 assets, 370,000 loan): preview changes NOTHING, confirm applies, variance 0, typed net kept in the log', async () => {
    const u = await newUser('j');
    const { fundId, raId } = await createFund(u, 'summary', 133_000);
    const preview = await switchMode(u, fundId, 'detailed', { assets: ASSETS, liabilities: LOAN(370_000), confirm: false });
    expect(preview.status).toBe('preview');
    expect(num(preview.net_before)).toBe(133_000);
    expect(num(preview.net_after)).toBe(133_000);
    expect(num(preview.variance)).toBe(0);
    expect((await fundRow(fundId)).mode).toBe('summary');
    expect(num(((await db.query(`select count(*) c from smsf_holdings where smsf_fund_id=$1`, [fundId])).rows[0] as Row).c)).toBe(0);
    expect(await logCount(fundId)).toBe(0);

    const applied = await switchMode(u, fundId, 'detailed', { assets: ASSETS, liabilities: LOAN(370_000), confirm: true });
    expect(applied.status).toBe('applied');
    const f = await fundRow(fundId);
    expect(f.mode).toBe('detailed');
    expect(f.summary_balance).toBeNull();
    expect(await balance(raId)).toBe(133_000);
    const log = (await db.query(`select * from entity_figure_mode_log where entity_id=$1`, [fundId])).rows[0] as Row;
    expect(log.action).toBe('to_itemised');
    expect(num((log.retired_representation as Json).typed_net)).toBe(133_000);
    expect(num(log.variance)).toBe(0);
  });

  it('a switch whose derived net differs from the typed net reports the variance before it applies (typed 138,000 vs derived 133,000 = -5,000)', async () => {
    const u = await newUser('k');
    const { fundId, raId } = await createFund(u, 'summary', 138_000);
    const preview = await switchMode(u, fundId, 'detailed', { assets: ASSETS, liabilities: LOAN(370_000), confirm: false });
    expect(num(preview.variance)).toBe(-5_000);
    expect(await balance(raId)).toBe(138_000);
  });

  it('itemised to net-only: lines are ARCHIVED (not deleted), the typed net is set, the history keeps the lines, only the net is counted', async () => {
    const u = await newUser('l');
    const { fundId, raId } = await createFund(u, 'detailed');
    await addAssets(u, fundId);
    await addLoan(u, fundId, 370_000);
    const r = await switchMode(u, fundId, 'summary', { net: 133_000, confirm: true });
    expect(r.status).toBe('applied');
    const f = await fundRow(fundId);
    expect(f.mode).toBe('summary');
    expect(num(f.summary_balance)).toBe(133_000);
    expect(await balance(raId)).toBe(133_000);
    expect(num(((await db.query(`select count(*) c from smsf_holdings where smsf_fund_id=$1 and is_active`, [fundId])).rows[0] as Row).c)).toBe(0);
    expect(num(((await db.query(`select count(*) c from smsf_holdings where smsf_fund_id=$1`, [fundId])).rows[0] as Row).c)).toBe(3);
    const log = (await db.query(`select * from entity_figure_mode_log where entity_id=$1`, [fundId])).rows[0] as Row;
    expect(log.action).toBe('to_net_only');
    expect(((log.retired_representation as Json).retired_holding_ids as unknown[]).length).toBe(3);
  });

  it('undo restores the previous representation and never leaves both counted; a newer change blocks the undo', async () => {
    const u = await newUser('m');
    const { fundId, raId } = await createFund(u, 'detailed');
    await addAssets(u, fundId);
    await addLoan(u, fundId, 370_000);
    await switchMode(u, fundId, 'summary', { net: 133_000, confirm: true });
    const undo = await asUser(db, u, async () => (await db.query(`select smsf_entity_undo_last_switch($1,true) v`, [fundId])).rows[0] as { v: Json });
    expect(undo.v.status).toBe('applied');
    const f = await fundRow(fundId);
    expect(f.mode).toBe('detailed');
    expect(f.summary_balance).toBeNull();
    expect(await balance(raId)).toBe(133_000);
    expect(num(((await db.query(`select count(*) c from smsf_holdings where smsf_fund_id=$1 and is_active`, [fundId])).rows[0] as Row).c)).toBe(3);
    // the undo itself is the newest history row, so a second undo is refused
    await expectSqlError(asUser(db, u, () => db.query(`select smsf_entity_undo_last_switch($1,true)`, [fundId])), 'cannot be undone here');
  });

  it('undo of net-only to itemised returns the typed net and archives the inserted lines', async () => {
    const u = await newUser('n');
    const { fundId, raId } = await createFund(u, 'summary', 133_000);
    await switchMode(u, fundId, 'detailed', { assets: ASSETS, liabilities: LOAN(370_000), confirm: true });
    await asUser(db, u, () => db.query(`select smsf_entity_undo_last_switch($1,true)`, [fundId]));
    const f = await fundRow(fundId);
    expect(f.mode).toBe('summary');
    expect(num(f.summary_balance)).toBe(133_000);
    expect(await balance(raId)).toBe(133_000);
    expect(num(((await db.query(`select count(*) c from smsf_holdings where smsf_fund_id=$1 and is_active`, [fundId])).rows[0] as Row).c)).toBe(0);
  });

  it('refuses a switch to the mode the fund already has, an empty itemised set, and a missing net', async () => {
    const u = await newUser('o');
    const { fundId } = await createFund(u, 'summary', 5);
    await expectSqlError(switchMode(u, fundId, 'summary', { net: 5, confirm: true }), 'already recorded that way');
    await expectSqlError(switchMode(u, fundId, 'detailed', { confirm: true }), 'at least one asset or liability');
    const v = await createFund(await newUser('o2'), 'detailed');
    const u2 = ((await db.query(`select user_id from smsf_funds where id=$1`, [v.fundId])).rows[0] as Row).user_id as string;
    await expectSqlError(switchMode(u2, v.fundId, 'summary', { confirm: true }), 'enter the net value');
  });

  it('the two earlier staged-switch functions now refuse and point at the new one', async () => {
    const u = await newUser('p');
    const { fundId } = await createFund(u, 'summary', 5);
    await expectSqlError(asUser(db, u, () => db.query(`select smsf_switch_to_detailed($1)`, [fundId])), 'smsf_entity_switch_mode');
    await expectSqlError(asUser(db, u, () => db.query(`select smsf_switch_to_summary($1, 1, current_date)`, [fundId])), 'smsf_entity_switch_mode');
  });
});

describe('tenant isolation', () => {
  it('another household cannot switch, undo, move or adopt on this fund, nor attach lines to it', async () => {
    const a = await newUser('iso-a');
    const b = await newUser('iso-b');
    const { fundId } = await createFund(a, 'summary', 133_000);
    await expectSqlError(switchMode(b, fundId, 'detailed', { assets: ASSETS, confirm: true }), 'not found');
    await expectSqlError(asUser(db, b, () => db.query(`select smsf_entity_undo_last_switch($1,true)`, [fundId])), 'not found');
    await expectSqlError(asUser(db, b, () => db.query(`select smsf_entity_adopt_register_rows($1, array['00000000-0000-0000-0000-000000000000']::uuid[], true)`, [fundId])), 'not found');
    // refused either by the line rule (the fund is invisible to B, so it cannot be itemised) or by row level security: never accepted
    await expectSqlError(
      asUser(db, b, () => db.query(`insert into smsf_liabilities(user_id, smsf_fund_id, liability_name, balance, currency_code) values ($1,$2,'x',1,'AUD')`, [b, fundId])),
      'ENTITY_BOTH_REPRESENTATIONS',
    );
    expect(num(((await db.query(`select count(*) c from smsf_liabilities where smsf_fund_id=$1`, [fundId])).rows[0] as Row).c)).toBe(0);
    expect((await fundRow(fundId)).mode).toBe('summary');
    // an unauthenticated caller (no claims) is refused
    await expectSqlError(db.query(`select smsf_entity_switch_mode($1,'detailed','[]'::jsonb,'[]'::jsonb,null,null,true)`, [fundId]), 'not authenticated');
  });

  it('the history is readable by its owner only, cannot be updated, and cannot be deleted by the owner', async () => {
    const a = await newUser('hist-a');
    const b = await newUser('hist-b');
    const { fundId } = await createFund(a, 'summary', 133_000);
    await switchMode(a, fundId, 'detailed', { assets: ASSETS, liabilities: LOAN(), confirm: true });
    expect(await asUser(db, a, async () => (await db.query(`select * from entity_figure_mode_log`)).rows.length)).toBe(1);
    expect(await asUser(db, b, async () => (await db.query(`select * from entity_figure_mode_log`)).rows.length)).toBe(0);
    await expectSqlError(db.query(`update entity_figure_mode_log set net_after=0 where entity_id=$1`, [fundId]), 'append-only');
    await asUser(db, a, () => db.query(`delete from entity_figure_mode_log where entity_id=$1`, [fundId]));
    expect(await logCount(fundId)).toBe(1);
  });

  it('deleting the user cascades through the fund, lines and history without error', async () => {
    const a = await newUser('del');
    const { fundId } = await createFund(a, 'summary', 133_000);
    await switchMode(a, fundId, 'detailed', { assets: ASSETS, liabilities: LOAN(), confirm: true });
    await db.exec(`delete from auth.users where id='${a}';`);
    expect(await logCount(fundId)).toBe(0);
  });
});

describe('legacy shapes: the PO fund as it is in production (itemised with a stale typed net 138,000, a linked personal loan, a duplicate register row)', () => {
  async function legacyFund(): Promise<{ u: string; fundId: string; raId: string; loanId: string; dupId: string }> {
    const u = await newUser('legacy');
    const { fundId, raId } = await createFund(u, 'detailed');
    await addAssets(u, fundId);
    // the stale typed net, as production holds it (written before the rule existed)
    await db.exec('alter table smsf_funds disable trigger trg_smsf_funds_mode_rule;');
    await db.query(`update smsf_funds set summary_balance=138000 where id=$1`, [fundId]);
    await db.exec('alter table smsf_funds enable trigger trg_smsf_funds_mode_rule;');
    // the personal loan linked as the fund's property loan (the earlier way), at the PO's confirmed 370,000
    const loan = (await db.query(`insert into liabilities(user_id, liability_name, debt_type, balance, currency_code, owner) values ($1,'SMSF property loan','mortgage',370000,'AUD','joint') returning id`, [u])).rows[0] as Row;
    await db.query(`insert into property_liability_links(user_id, linked_retirement_id, liability_id, link_type) values ($1,$2,$3,'smsf_property_loan')`, [u, raId, loan.id]);
    // the duplicate hand-typed register row
    const dup = (await db.query(`insert into retirement_accounts(user_id, account_name, account_type, current_balance, currency_code, country_code, owner, master_item_key, is_active) values ($1,'Other Retirement Assets','other',133000,'AUD','AU','smsf','other_retirement',true) returning id`, [u])).rows[0] as Row;
    return { u, fundId, raId, loanId: loan.id as string, dupId: dup.id as string };
  }

  it('the legacy fund still derives 503,000 - 370,000 = 133,000 through the linked loan', async () => {
    const { raId } = await legacyFund();
    expect(await balance(raId)).toBe(133_000);
  });

  it('retire_typed_net: preview, then apply; the typed 138,000 is kept in the log and the counted net does not move', async () => {
    const { u, fundId, raId } = await legacyFund();
    const p = await asUser(db, u, async () => (await db.query(`select smsf_entity_retire_typed_net($1,false) v`, [fundId])).rows[0] as { v: Json });
    expect(p.v.status).toBe('preview');
    expect(num(p.v.typed_net)).toBe(138_000);
    expect(num((await fundRow(fundId)).summary_balance)).toBe(138_000);
    await asUser(db, u, () => db.query(`select smsf_entity_retire_typed_net($1,true)`, [fundId]));
    expect((await fundRow(fundId)).summary_balance).toBeNull();
    expect(await balance(raId)).toBe(133_000);
    const log = (await db.query(`select * from entity_figure_mode_log where entity_id=$1 and action='retire_typed_net'`, [fundId])).rows[0] as Row;
    expect(num((log.retired_representation as Json).typed_net)).toBe(138_000);
    const left = await asUser(db, u, async () => (await db.query(`select * from smsf_mode_rule_violations()`)).rows as Row[]);
    expect(left).toEqual([]);
  });

  it('move_linked_loan: the loan becomes the fund\'s own liability; the net is 133,000 before AND after (counted once); the personal row and link are retired', async () => {
    const { u, fundId, raId, loanId } = await legacyFund();
    const p = await asUser(db, u, async () => (await db.query(`select smsf_entity_move_linked_loan($1,$2,false) v`, [fundId, loanId])).rows[0] as { v: Json });
    expect(p.v.status).toBe('preview');
    expect(num(p.v.variance)).toBe(0);
    expect(await balance(raId)).toBe(133_000);
    expect(num(((await db.query(`select count(*) c from smsf_liabilities where smsf_fund_id=$1`, [fundId])).rows[0] as Row).c)).toBe(0);
    await asUser(db, u, () => db.query(`select smsf_entity_move_linked_loan($1,$2,true)`, [fundId, loanId]));
    expect(await balance(raId)).toBe(133_000);
    const sl = (await db.query(`select balance, liability_type from smsf_liabilities where smsf_fund_id=$1 and is_active`, [fundId])).rows as Row[];
    expect(sl).toHaveLength(1);
    expect(num(sl[0].balance)).toBe(370_000);
    expect(((await db.query(`select is_active from liabilities where id=$1`, [loanId])).rows[0] as Row).is_active).toBe(false);
    expect(num(((await db.query(`select count(*) c from property_liability_links where liability_id=$1 and is_active`, [loanId])).rows[0] as Row).c)).toBe(0);
  });

  it('adopt_register_rows: the duplicate 133,000 row is archived with a log entry; the fund net is untouched', async () => {
    const { u, fundId, raId, dupId } = await legacyFund();
    const p = await asUser(db, u, async () => (await db.query(`select smsf_entity_adopt_register_rows($1, array[$2]::uuid[], false) v`, [fundId, dupId])).rows[0] as { v: Json });
    expect(p.v.status).toBe('preview');
    expect(num(p.v.register_total)).toBe(133_000);
    expect(((await db.query(`select is_active from retirement_accounts where id=$1`, [dupId])).rows[0] as Row).is_active).toBe(true);
    await asUser(db, u, () => db.query(`select smsf_entity_adopt_register_rows($1, array[$2]::uuid[], true)`, [fundId, dupId]));
    expect(((await db.query(`select is_active from retirement_accounts where id=$1`, [dupId])).rows[0] as Row).is_active).toBe(false);
    expect(await balance(raId)).toBe(133_000);
    // the fund record itself can never be archived through this function
    await expectSqlError(asUser(db, u, () => db.query(`select smsf_entity_adopt_register_rows($1, array[$2]::uuid[], true)`, [fundId, raId])), 'qualify');
  });
});

describe('smsf_create_fund reuses an archived fund row', () => {
  it('after the fund is archived, creating again brings the same rows back instead of failing on the unique key', async () => {
    const u = await newUser('reuse');
    const first = await createFund(u, 'detailed');
    await addAssets(u, first.fundId);
    await db.exec(`update smsf_funds set is_active=false where id='${first.fundId}'; update retirement_accounts set is_active=false where id='${first.raId}';`);
    const again = await createFund(u, 'detailed');
    expect(again.raId).toBe(first.raId);
    expect(again.fundId).toBe(first.fundId);
    expect(await balance(first.raId)).toBe(503_000);
    // creating while one is active is refused
    await expectSqlError(asUser(db, u, () => db.query(`select * from smsf_create_fund('SMSF','x',null,null,'self','AUD','AU','detailed')`)), 'already have an SMSF fund');
  });

  it('a user outside Australia still cannot create a fund (the AU gate of migration 0084 is intact)', async () => {
    const u = uid();
    await seedUser(db, u, 'india@pg.test', 'IN');
    await expectSqlError(asUser(db, u, () => db.query(`select * from smsf_create_fund('SMSF','x',null,null,'self','AUD','AU','detailed')`)), 'only available to users whose home jurisdiction');
  });
});

describe('entity-free households are unchanged', () => {
  it('a user with no fund: the new functions find nothing, the violation list is empty, no row is created anywhere', async () => {
    const u = await newUser('free');
    expect(await asUser(db, u, async () => (await db.query(`select * from smsf_mode_rule_violations()`)).rows.length)).toBe(0);
    expect(num(((await db.query(`select count(*) c from retirement_accounts where user_id=$1`, [u])).rows[0] as Row).c)).toBe(0);
    expect(num(((await db.query(`select count(*) c from entity_figure_mode_log where user_id=$1`, [u])).rows[0] as Row).c)).toBe(0);
  });
});
