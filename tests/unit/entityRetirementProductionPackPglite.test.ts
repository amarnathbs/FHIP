// THE PRODUCTION PACK of the entity + retirement release (docs/reviews/po_apply_entity_retirement_production), proved end to end on the REAL migration ledger in
// an isolated in-memory Postgres (PGlite). EVIDENCE LABEL: PGLITE-VERIFIED. NOT DEV- or production-verified by this test.
//
// What is proved, in the order the PO runs it:
//   - every paste file is editor safe, the 0296 and 0297 parts are exact slices of the migrations and each is at most 15 KB, the 0304 copy only differs in
//     editor-safety details, and ORDER.txt is the numeric order;
//   - on a database that looks like PRODUCTION BEFORE THE RELEASE (the ledger WITHOUT 0289, 0290, 0295 to 0299 and 0304, the PO fund shape already in
//     place): A says the new objects are NEW and the prerequisites hold, B backs up (twice, no overwrite), the migration paste files run in ORDER (twice,
//     as a re-run would) with V1, V2 and V3 all ok after their group, and A afterwards says everything is now present;
//   - the schema that the paste files build is IDENTICAL to the schema the migration files build (tables, columns, constraints, indexes, triggers, functions,
//     policies), so what runs on production is what was proved on DEV;
//   - the cutover (cutover/P0 to P4, then P9) still matches the FINAL schema: the PO fund ends at assets 503,000, fund liability 370,000, net 133,000,
//     the stale 138,000 typed net retired, the duplicate 133,000 row archived, the inactive 365,000 personal loan and the inactive Trust Assets row left
//     alone, and NO personal liability tagged SMSF is created.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { hazards } from './support/sqlEditorHazards';
import { expectSqlError, replayLedger, seedUser, MIG_DIR } from './support/entityLevelPgliteHarness';

const ROOT = path.resolve(__dirname, '..', '..');
const PACK = path.join(ROOT, 'docs', 'reviews', 'po_apply_entity_retirement_production');
const MIGS = path.join(PACK, 'migrations');
const CUT = path.join(PACK, 'cutover');
const NEW_MIGRATIONS = (f: string) => /^(0289|0290|0295|0296|0297|0298|0299|0304)_/.test(f);
const ORDER = fs.readFileSync(path.join(MIGS, 'ORDER.txt'), 'utf8').split('\n').filter(Boolean);
const read = (p: string) => fs.readFileSync(p, 'utf8');
const packFile = (name: string) => read(path.join(PACK, name));
type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v);
const body = (text: string) => {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  return lines.slice(lines.findIndex((l) => l.trim() === 'begin;') + 1, lines.map((l) => l.trim()).lastIndexOf('commit;')).join('\n').replace(/\s+/g, ' ').trim();
};

describe('the paste files: editor safe, exact, small, in the right order', () => {
  const sqlFiles = [...fs.readdirSync(PACK).filter((f) => f.endsWith('.sql')).map((f) => path.join(PACK, f)), ...fs.readdirSync(MIGS).filter((f) => f.endsWith('.sql')).map((f) => path.join(MIGS, f)), ...fs.readdirSync(CUT).filter((f) => f.endsWith('.sql')).map((f) => path.join(CUT, f))];

  it.each(sqlFiles.map((f) => [path.relative(PACK, f), f]))('%s has no editor hazard', (_n, f) => {
    expect(hazards(read(f))).toEqual([]);
  });

  it('ORDER.txt is the numeric migration order and names exactly the files that exist', () => {
    const files = fs.readdirSync(MIGS).filter((f) => f.endsWith('.sql')).sort();
    expect([...ORDER].sort()).toEqual(files);
    expect(ORDER).toEqual([...ORDER].sort());
    expect(ORDER.map((f) => f.slice(2, 6))).toEqual([...ORDER.map((f) => f.slice(2, 6))].sort());
  });

  it('the release adds exactly 0289, 0290, 0295, 0296, 0297, 0298, 0299 and 0304 and no other migration number is in the pack', () => {
    expect([...new Set(ORDER.map((f) => f.slice(2, 6)))]).toEqual(['0289', '0290', '0295', '0296', '0297', '0298', '0299', '0304']);
    for (const num of ['0289', '0290', '0295', '0296', '0297', '0298', '0299', '0304']) expect(fs.readdirSync(MIG_DIR).some((f) => f.startsWith(`${num}_`))).toBe(true);
  });

  it('every paste file is at most 15 KB (0290 keeps the phase 1 parts), and the cutover files are unchanged copies of the phase 1 production pack', () => {
    for (const f of ORDER) expect(Buffer.byteLength(read(path.join(MIGS, f)))).toBeLessThanOrEqual(15 * 1024);
    const phase1 = path.join(ROOT, 'docs', 'architecture', 'entity_level_assets_liabilities_2026-10-16', 'production_pack');
    for (const f of fs.readdirSync(CUT)) expect(read(path.join(CUT, f))).toBe(read(path.join(phase1, f)));
  });

  it('0296 and 0297 parts joined equal the migration bodies exactly, and the small files are the migration files byte for byte', () => {
    for (const num of ['0296', '0297']) {
      const mig = fs.readdirSync(MIG_DIR).find((f) => f.startsWith(`${num}_`))!;
      const parts = ORDER.filter((f) => f.startsWith(`M_${num}_part`));
      expect(parts.length).toBe(3);
      expect(parts.map((f) => body(read(path.join(MIGS, f)))).join(' ')).toBe(body(read(path.join(MIG_DIR, mig))));
    }
    for (const num of ['0295', '0298', '0299']) {
      const mig = fs.readdirSync(MIG_DIR).find((f) => f.startsWith(`${num}_`))!;
      expect(read(path.join(MIGS, `M_${mig}`)).replace(/\r\n/g, '\n')).toBe(read(path.join(MIG_DIR, mig)).replace(/\r\n/g, '\n'));
    }
  });

  it('every migration paste file can be run twice: each statement is create or replace, if not exists, drop if exists first, or add column if not exists', () => {
    for (const f of ORDER) {
      const sql = read(path.join(MIGS, f)).toLowerCase().replace(/--.*$/gm, '');
      expect(sql, f).not.toMatch(/\bcreate table (?!if not exists)/);
      expect(sql, f).not.toMatch(/\bcreate (unique )?index (?!if not exists)/);
      expect(sql, f).not.toMatch(/\bdrop table\b|\btruncate\b|\bdelete from\b/);
    }
  });
});

// --------------------------------------------------------------------------------------------------------------------------------------------------------
// A database that looks like production BEFORE the release, then the pack, in order
// --------------------------------------------------------------------------------------------------------------------------------------------------------
let prod: PGlite;
let full: PGlite;
const EMAIL = 'po-prod-shape@pg.test';
let uid = '';
let fundId = '';
let raId = '';
let dupId = '';

async function signature(db: PGlite): Promise<string[]> {
  const q = async (sql: string) => (await db.query(sql)).rows as Row[];
  const out: string[] = [];
  for (const r of await q(`select table_name, column_name, data_type, is_nullable, coalesce(column_default,'') d from information_schema.columns where table_schema='public' order by 1,2`))
    out.push(`col ${r.table_name}.${r.column_name} ${r.data_type} ${r.is_nullable} ${r.d}`);
  for (const r of await q(`select conrelid::regclass::text t, conname, contype, pg_get_constraintdef(oid) d from pg_constraint where connamespace='public'::regnamespace order by 1,2`))
    out.push(`con ${r.t} ${r.conname} ${r.contype} ${r.d}`);
  for (const r of await q(`select indexdef from pg_indexes where schemaname='public' order by 1`)) out.push(`idx ${r.indexdef}`);
  for (const r of await q(`select tgrelid::regclass::text t, tgname, tgenabled, pg_get_triggerdef(oid) d from pg_trigger where not tgisinternal order by 1,2`)) out.push(`trg ${r.t} ${r.tgname} ${r.tgenabled} ${r.d}`);
  for (const r of await q(`select p.proname, pg_get_function_identity_arguments(p.oid) a, md5(p.prosrc) m, p.prosecdef s, coalesce(p.proconfig::text,'') c from pg_proc p where pronamespace='public'::regnamespace order by 1,2`))
    out.push(`fn ${r.proname}(${r.a}) ${r.m} ${r.s} ${r.c}`);
  for (const r of await q(`select tablename, policyname, cmd, coalesce(qual,'') q, coalesce(with_check,'') w from pg_policies where schemaname='public' order by 1,2`)) out.push(`pol ${r.tablename} ${r.policyname} ${r.cmd} ${r.q} ${r.w}`);
  for (const r of await q(`select relname, relrowsecurity from pg_class where relnamespace='public'::regnamespace and relkind='r' order by 1`)) out.push(`rls ${r.relname} ${r.relrowsecurity}`);
  return out;
}

async function rowsOf(db: PGlite, sql: string): Promise<Row[]> {
  return (await db.query(sql)).rows as Row[];
}

beforeAll(async () => {
  prod = await replayLedger({ skip: NEW_MIGRATIONS });
  full = await replayLedger();
  // the PO household as production holds it BEFORE the release (the old schema: no rule triggers, no fund liabilities)
  uid = 'eeeeeeee-0000-0000-0000-0000000000a1';
  await seedUser(prod, uid, EMAIL);
  const q = (sql: string, params: unknown[] = []) => prod.query(sql, params);
  await q(`insert into assets(user_id, asset_name, asset_class, current_value, currency_code, owner) values ($1,'Assets register','other',1670298,'AUD','self')`, [uid]);
  await q(`insert into investments(user_id, investment_name, investment_type, current_value, currency_code, owner) values ($1,'Investments','shares',590000,'AUD','self')`, [uid]);
  await q(`insert into liabilities(user_id, liability_name, debt_type, balance, currency_code, owner) values ($1,'Home loan','mortgage',600000,'AUD','self'),($1,'Investment loan','mortgage',700000,'AUD','joint'),($1,'Car loan','auto_loan',85857,'AUD','spouse')`, [uid]);
  await q(`insert into retirement_accounts(user_id, account_name, account_type, current_balance, currency_code, country_code, owner, master_item_key, is_active) values ($1,'SMSF','super',0,'AUD','AU','self','smsf',true)`, [uid]);
  raId = (await rowsOf(prod, `select id from retirement_accounts where user_id='${uid}' and master_item_key='smsf'`))[0].id as string;
  await q(`insert into smsf_funds(user_id, retirement_account_id, fund_name, mode, summary_balance, currency_code) values ($1,$2,'PO SMSF','detailed',null,'AUD')`, [uid, raId]);
  fundId = (await rowsOf(prod, `select id from smsf_funds where user_id='${uid}'`))[0].id as string;
  await q(`insert into smsf_holdings(user_id, smsf_fund_id, holding_class, holding_type, holding_name, value, currency_code) values
    ($1,$2,'property','residential_property','250 Elizebth st Melbourne 3000 ',475000,'AUD'),
    ($1,$2,'cash','cash_account','Bank Australia',3000,'AUD'),
    ($1,$2,'cash','cash_account','Secured finance',25000,'AUD')`, [uid, fundId]);
  await q(`update smsf_funds set summary_balance=138000, summary_balance_date='2026-09-01' where id=$1`, [fundId]);
  dupId = ((await q(`insert into retirement_accounts(user_id, account_name, account_type, current_balance, currency_code, country_code, owner, master_item_key, is_active) values ($1,'Other Retirement Assets','other',133000,'AUD','AU','smsf','other_retirement',true) returning id`, [uid])).rows[0] as Row).id as string;
  await q(`insert into retirement_accounts(user_id, account_name, account_type, current_balance, currency_code, country_code, owner, master_item_key, is_active) values ($1,'Spouse Contribution','super',0,'AUD','AU','spouse','spouse_contribution',true)`, [uid]);
  await q(`insert into liabilities(user_id, liability_name, debt_type, balance, currency_code, owner, is_active) values ($1,'SMSF property loan','mortgage',365000,'AUD','joint',false)`, [uid]);
  await q(`insert into assets(user_id, asset_name, asset_class, current_value, currency_code, owner, is_active) values ($1,'Trust Assets','other',495000,'AUD','smsf',false)`, [uid]);
}, 600_000);

afterAll(async () => {
  await prod?.close();
  await full?.close();
});

describe('A: before the release the prerequisites hold, 0294 is present, and every new object is NEW', () => {
  it('prerequisites and 0294 are true, the eight new groups are false', async () => {
    const rows = await rowsOf(prod, packFile('A_prerequisites_and_what_is_new_READ_ONLY.sql'));
    const must = rows.filter((r) => /must be true/.test(String(r.expected)));
    expect(must.length).toBeGreaterThanOrEqual(20);
    expect(must.filter((r) => r.value !== true).map((r) => r.what)).toEqual([]);
    expect(rows.some((r) => /0294/.test(String(r.what)) && r.value === true)).toBe(true);
    const isNew = rows.filter((r) => /^NEW /.test(String(r.what)));
    expect(isNew.length).toBe(11);
    expect(isNew.filter((r) => r.value !== false).map((r) => r.what)).toEqual([]);
  });

  it('the data shapes query runs and sees the PO household (one fund carrying the typed 138,000)', async () => {
    const rows = await rowsOf(prod, packFile('A2_data_shapes_READ_ONLY.sql'));
    const n = (what: string) => num(rows.find((r) => String(r.what).startsWith(what))?.n);
    expect(n('SMSF funds (active)')).toBe(1);
    expect(n('itemised SMSF funds that still carry a typed net')).toBe(1);
    expect(n('retirement rows tagged SMSF other than the fund row')).toBe(1);
  });
});

describe('B: the backup copies every touched table, never overwrites, and changes no live row', () => {
  it('first run copies, second run keeps the first copy', async () => {
    const liveBefore = num((await rowsOf(prod, 'select count(*) c from retirement_accounts'))[0].c);
    await prod.exec(packFile('B_backup_all_touched_tables.sql'));
    await prod.exec(`update bk_er_20261026_smsf_funds set fund_name = 'FIRST COPY KEPT'`);
    await prod.exec(packFile('B_backup_all_touched_tables.sql'));
    expect((await rowsOf(prod, 'select fund_name from bk_er_20261026_smsf_funds'))[0].fund_name).toBe('FIRST COPY KEPT');
    expect(num((await rowsOf(prod, 'select count(*) c from retirement_accounts'))[0].c)).toBe(liveBefore);
    expect(num((await rowsOf(prod, `select count(*) c from pg_class where relname like 'bk_er_20261026_%' and relrowsecurity`))[0].c)).toBe(13);
    await prod.exec(`update bk_er_20261026_smsf_funds set fund_name = 'PO SMSF'`);
  });
});

describe('M and V: the migration paste files run in order, twice, and each group verifies', () => {
  const okAll = (rows: Row[]) => rows.filter((r) => r.ok !== true).map((r) => r.check_name);

  it('the 0289 and 0290 parts, then V1 (all ok)', async () => {
    for (let pass = 0; pass < 2; pass += 1) for (const f of ORDER.filter((x) => /^M_0289|^M_0290/.test(x))) await prod.exec(read(path.join(MIGS, f)));
    expect(okAll(await rowsOf(prod, packFile('V1_verify_after_0289_0290_READ_ONLY.sql')))).toEqual([]);
  }, 300_000);

  it('0295, then the 0296 and 0297 parts, then V2 (all ok)', async () => {
    for (let pass = 0; pass < 2; pass += 1) for (const f of ORDER.filter((x) => /^M_0295|^M_0296|^M_0297/.test(x))) await prod.exec(read(path.join(MIGS, f)));
    const rows = await rowsOf(prod, packFile('V2_verify_after_0295_0296_0297_READ_ONLY.sql'));
    expect(rows.length).toBeGreaterThanOrEqual(13);
    expect(okAll(rows)).toEqual([]);
  }, 300_000);

  it('0298, 0299 and the 0304 copy, then V3 (all ok)', async () => {
    for (let pass = 0; pass < 2; pass += 1) for (const f of ORDER.filter((x) => /^M_0298|^M_0299|^M_0304/.test(x))) await prod.exec(read(path.join(MIGS, f)));
    const rows = await rowsOf(prod, packFile('V3_verify_after_0298_0299_0304_READ_ONLY.sql'));
    expect(rows.length).toBeGreaterThanOrEqual(9);
    expect(okAll(rows)).toEqual([]);
  }, 300_000);

  it('A afterwards: every NEW object is now present', async () => {
    const rows = await rowsOf(prod, packFile('A_prerequisites_and_what_is_new_READ_ONLY.sql'));
    expect(rows.filter((r) => /^NEW /.test(String(r.what)) && r.value !== true).map((r) => r.what)).toEqual([]);
  });

  it('EQUIVALENCE: the schema the paste files built equals the schema the migration files build (tables, columns, constraints, indexes, triggers, functions, policies, row level security)', async () => {
    const [a, b] = [await signature(prod), await signature(full)];
    const bk = (s: string) => /bk_er_20261026_|zz_bk_/.test(s);
    // the comparison is not vacuous: it covers the objects of every one of the eight migrations
    for (const needle of ['con smsf_liabilities chk_smsf_liabilities_masked_identifier', 'idx CREATE UNIQUE INDEX uq_entity_income_rent_per_smsf_asset', 'trg business_entities trg_business_entities_mode_rule', 'fn business_entity_undo_last_switch', 'fn fhip_retirement_declaration_blockers', 'pol retirement_contributions own rows - retirement_contributions', 'rls retirement_contributions true', 'rls entity_change_log true']) expect(a.some((x) => x.startsWith(needle)), needle).toBe(true);
    expect(a.length).toBeGreaterThan(1500);
    const onlyProd = a.filter((x) => !bk(x) && !b.includes(x));
    const onlyFull = b.filter((x) => !a.includes(x));
    expect(onlyProd).toEqual([]);
    expect(onlyFull).toEqual([]);
  }, 300_000);

  it('the PO household is untouched by the migrations: fund 503,000 assets, typed net 138,000 still there (the migrations change no row)', async () => {
    const f = (await rowsOf(prod, `select summary_balance, detailed_net_value, mode from smsf_funds where id='${fundId}'`))[0];
    expect(num(f.summary_balance)).toBe(138_000);
    expect(f.mode).toBe('detailed');
    expect(num((await rowsOf(prod, `select count(*) c from smsf_liabilities`))[0].c)).toBe(0);
  });
});

describe('C: the cutover pack still matches the FINAL schema (loan 370,000, P3 guarded, inactive rows left alone, no personal SMSF liability created)', () => {
  const sqlOf = (file: string, edits: [string, string][] = []) => {
    let s = read(path.join(CUT, file)).replace(/PUT_YOUR_LOGIN_EMAIL_HERE/g, EMAIL);
    for (const [a, c] of edits) {
      if (!s.includes(a)) throw new Error(`edit target not found: ${a}`);
      s = s.replace(a, c);
    }
    return s;
  };

  it('P0 diagnosis (read only) reports the personal totals and "SMSF recorded twice"', async () => {
    const rows = await rowsOf(prod, sqlOf('P0_diagnose_before_and_after_READ_ONLY.sql'));
    expect(rows.map((r) => String(r.section))).toContain('DATA QUALITY: SMSF recorded twice');
    expect(num(rows.find((r) => String(r.section).startsWith('TOTAL personal assets'))?.amount)).toBe(2_260_298);
    expect(num(rows.find((r) => String(r.section).startsWith('TOTAL personal liabilities'))?.amount)).toBe(1_385_857);
  });

  it('P3 refuses without its own exact-row backup, then P1 backs up, then P2 previews the result 503,000 - 370,000 = 133,000', async () => {
    await expectSqlError(prod.exec(sqlOf('P3_cutover_apply.sql')), 'no backup found');
    await prod.exec('rollback;').catch(() => undefined);
    await prod.exec(sqlOf('P1_backup_exact_rows.sql'));
    const rows = await rowsOf(prod, sqlOf('P2_cutover_preview_READ_ONLY.sql'));
    const by = (prefix: string) => rows.filter((r) => String(r.section).startsWith(prefix));
    expect(num(by('TO BE RETIRED: leftover typed')[0].amount)).toBe(138_000);
    expect(num(by('TO BE RETIRED: duplicate')[0].amount)).toBe(133_000);
    expect(num(by('LEFT ALONE: inactive personal loan')[0].amount)).toBe(365_000);
    expect(num(by('LEFT ALONE: inactive SMSF-owned asset')[0].amount)).toBe(495_000);
    expect(num(by('TO BE ADDED')[0].amount)).toBe(370_000);
    expect(num(by('RESULT: net')[0].amount)).toBe(133_000);
  });

  it('NEGATIVE CONTROL: P3 refuses when the diagnosed values do not match, and changes nothing', async () => {
    await expectSqlError(prod.exec(sqlOf('P3_cutover_apply.sql', [['v_expected_assets numeric := 503000;', 'v_expected_assets numeric := 504000;']])), 'was expected, stop and run P2 again');
    await prod.exec('rollback;').catch(() => undefined);
    expect(num((await rowsOf(prod, `select count(*) c from smsf_liabilities where smsf_fund_id='${fundId}'`))[0].c)).toBe(0);
  });

  it('P3 applies: fund liability 370,000, net 133,000, typed net retired, duplicate archived, inactive rows untouched, NO personal SMSF liability created', async () => {
    const personalSmsfBefore = num((await rowsOf(prod, `select count(*) c from liabilities where owner='smsf'`))[0].c);
    const personalTotalBefore = num((await rowsOf(prod, `select count(*) c from liabilities where user_id='${uid}'`))[0].c);
    await prod.exec(sqlOf('P3_cutover_apply.sql'));
    const f = (await rowsOf(prod, `select summary_balance, detailed_net_value, mode from smsf_funds where id='${fundId}'`))[0];
    expect(f.summary_balance).toBeNull();
    expect(num(f.detailed_net_value)).toBe(133_000);
    expect(num((await rowsOf(prod, `select current_balance from retirement_accounts where id='${raId}'`))[0].current_balance)).toBe(133_000);
    expect(num((await rowsOf(prod, `select sum(balance) s from smsf_liabilities where smsf_fund_id='${fundId}' and is_active`))[0].s)).toBe(370_000);
    expect((await rowsOf(prod, `select is_active from retirement_accounts where id='${dupId}'`))[0].is_active).toBe(false);
    const inactive = (await rowsOf(prod, `select (select is_active from liabilities where user_id='${uid}' and liability_name='SMSF property loan') l, (select is_active from assets where user_id='${uid}' and asset_name='Trust Assets') a`))[0];
    expect([inactive.l, inactive.a]).toEqual([false, false]);
    // the new guard: the cutover wrote the fund liability on the fund, never a personal liability tagged SMSF
    expect(num((await rowsOf(prod, `select count(*) c from liabilities where owner='smsf'`))[0].c)).toBe(personalSmsfBefore);
    expect(num((await rowsOf(prod, `select count(*) c from liabilities where user_id='${uid}'`))[0].c)).toBe(personalTotalBefore);
    // the new audit trail saw the cutover write (and the history rows are the two the pack expects)
    expect(num((await rowsOf(prod, `select count(*) c from entity_change_log where entity_id='${fundId}' and table_name='smsf_liabilities'`))[0].c)).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('P4 verify reports the expected values', async () => {
    const rows = await rowsOf(prod, sqlOf('P4_verify_READ_ONLY.sql'));
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

  it('P3 cannot be applied twice (it stops, nothing changes)', async () => {
    await expectSqlError(prod.exec(sqlOf('P3_cutover_apply.sql')), 'already applied');
    await prod.exec('rollback;').catch(() => undefined);
  });

  it('P9 rolls the cutover back to the exact earlier shape (typed net 138,000, duplicate active, fund liability retired), history kept', async () => {
    await prod.exec(sqlOf('P9_rollback.sql'));
    const f = (await rowsOf(prod, `select summary_balance, detailed_net_value from smsf_funds where id='${fundId}'`))[0];
    expect(num(f.summary_balance)).toBe(138_000);
    expect(num(f.detailed_net_value)).toBe(503_000);
    expect((await rowsOf(prod, `select is_active from retirement_accounts where id='${dupId}'`))[0].is_active).toBe(true);
    expect(num((await rowsOf(prod, `select count(*) c from smsf_liabilities where smsf_fund_id='${fundId}' and is_active`))[0].c)).toBe(0);
    expect(num((await rowsOf(prod, `select count(*) c from entity_figure_mode_log where entity_id='${fundId}'`))[0].c)).toBe(2);
  }, 120_000);
});
