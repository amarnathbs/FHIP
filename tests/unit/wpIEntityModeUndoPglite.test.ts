// DOCUMENT2 (4) WP-I, entity mode switch Undo: migration 0299 (business_entity_undo_last_switch) on a real Postgres (PGlite) replay of the REAL migration
// ledger, driven as the real `authenticated` role with row level security and auth.uid(). EVIDENCE LABEL: PGLITE-VERIFIED (an isolated in-memory replay).
// NOT DEV-verified and NOT production-verified: the PO applies 0299 on DEV first.
//
// DECISION RECORDED BY THIS TEST. Switching a Company, Family Trust or HUF between itemised and net value only is NOT presentation: an itemised entity is counted
// at its derived net (assets less liabilities), a net value only entity at its typed net, so the switch moves the number that reaches the family figure.
// It therefore needs a safe Undo, consistent with the SMSF one (preview first, what the user had is kept, history kept, never both counted).
//
// HAND ORACLE (AUD): Family Trust itemised: assets 1,000,000, liabilities 400,000, derived net 600,000. Switch to net value only 650,000 (variance +50,000).
// Undo: back to itemised at 600,000. Company net value only 250,000 switched to itemised 400,000 less 50,000 = 350,000, undone back to 250,000.
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asUser, expectSqlError, replayLedger, seedUser } from './support/entityLevelPgliteHarness';
import { hazards } from './support/sqlEditorHazards';

const MIGRATION = path.resolve(__dirname, '..', '..', 'supabase', 'migrations', '0299_business_entity_undo_last_switch.sql');

let db: PGlite;
let n = 0;
type Row = Record<string, unknown>;
type Json = Record<string, unknown>;
const uid = () => `cccccccc-0000-0000-0000-${String(++n).padStart(12, '0')}`;
const num = (v: unknown) => Number(v);
const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as Row[];

async function newUser(label: string): Promise<string> {
  const id = uid();
  await seedUser(db, id, `${label}${n}@pg.test`, 'AU');
  return id;
}
/** An itemised entity with the given assets and liabilities (inserted as the user, so row level security applies). */
async function itemisedEntity(u: string, type: 'company' | 'family_trust', assets: number[], liabilities: number[]): Promise<string> {
  const id = await asUser(db, u, async () => (await db.query(`insert into business_entities(user_id, entity_type, name, currency_code, ownership_percentage, valuation_mode, summary_net_asset_value) values ($1,$2,'Entity ' || $2,'AUD',100,'detailed',null) returning id`, [u, type])).rows[0] as Row).then((r) => r.id as string);
  for (const [i, v] of assets.entries()) await asUser(db, u, async () => db.query(`insert into business_entity_assets(user_id, business_entity_id, label, asset_type, value, currency_code) values ($1,$2,$3,'property',$4,'AUD')`, [u, id, `Asset ${i + 1}`, v]));
  for (const [i, v] of liabilities.entries()) await asUser(db, u, async () => db.query(`insert into business_entity_liabilities(user_id, business_entity_id, label, liability_type, value, currency_code) values ($1,$2,$3,'other_loan',$4,'AUD')`, [u, id, `Loan ${i + 1}`, v]));
  return id;
}
async function netOnlyEntity(u: string, type: 'company' | 'family_trust', net: number): Promise<string> {
  return asUser(db, u, async () => (await db.query(`insert into business_entities(user_id, entity_type, name, currency_code, ownership_percentage, valuation_mode, summary_net_asset_value) values ($1,$2,'Entity ' || $2,'AUD',100,'summary',$3) returning id`, [u, type, net])).rows[0] as Row).then((r) => r.id as string);
}
const switchTo = (u: string, id: string, to: 'detailed' | 'summary', opts: { assets?: unknown[]; liabilities?: unknown[]; net?: number | null; confirm: boolean }) =>
  asUser(db, u, async () => ((await db.query(`select business_entity_switch_mode($1,$2,$3::jsonb,$4::jsonb,$5,$6) v`, [id, to, JSON.stringify(opts.assets ?? []), JSON.stringify(opts.liabilities ?? []), opts.net ?? null, opts.confirm])).rows[0] as { v: Json }).v);
const undo = (u: string, id: string, confirm: boolean) =>
  asUser(db, u, async () => ((await db.query(`select business_entity_undo_last_switch($1,$2) v`, [id, confirm])).rows[0] as { v: Json }).v);
const state = async (id: string) => {
  const e = (await q(`select valuation_mode, summary_net_asset_value from business_entities where id=$1`, [id]))[0];
  const a = await q(`select count(*) filter (where is_active)::int act, count(*)::int total from business_entity_assets where business_entity_id=$1`, [id]);
  const l = await q(`select count(*) filter (where is_active)::int act, count(*)::int total from business_entity_liabilities where business_entity_id=$1`, [id]);
  const derived = num((await q(`select business_entity_derived_net($1) d`, [id]))[0].d);
  return { mode: e.valuation_mode as string, typed: e.summary_net_asset_value === null ? null : num(e.summary_net_asset_value), activeAssets: a[0].act as number, totalAssets: a[0].total as number, activeLiabs: l[0].act as number, totalLiabs: l[0].total as number, derived };
};
const log = async (id: string) => q(`select id, action, from_mode, to_mode, net_before, net_after, variance, undoes_log_id, retired_representation from entity_figure_mode_log where entity_id=$1 order by created_at, id`, [id]);

beforeAll(async () => {
  db = await replayLedger();
}, 400_000);
afterAll(async () => {
  await db?.close();
});

describe('migration 0299: file hygiene', () => {
  it('is editor safe and additive (one function, no table, no column, no deletion)', () => {
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    expect(hazards(sql)).toEqual([]);
    const code = sql.toLowerCase().replace(/--.*$/gm, '');
    expect(code).not.toMatch(/create\s+table|drop\s+table|alter\s+table|truncate|delete\s+from/);
    expect(code.match(/create or replace function/g)).toHaveLength(1);
  });
});

describe('undo of a switch to net value only (Family Trust, itemised 600,000 -> net value only 650,000)', () => {
  it('previews first (nothing changes), then restores the itemised lines, clears the typed net and keeps the history', async () => {
    const u = await newUser('a');
    const id = await itemisedEntity(u, 'family_trust', [1_000_000], [400_000]);
    expect((await state(id)).derived).toBe(600_000);

    const sw = await switchTo(u, id, 'summary', { net: 650_000, confirm: true });
    expect(sw).toMatchObject({ status: 'applied', net_before: 600_000, net_after: 650_000, variance: 50_000 });
    const afterSwitch = await state(id);
    expect(afterSwitch).toMatchObject({ mode: 'summary', typed: 650_000, activeAssets: 0, activeLiabs: 0, totalAssets: 1, totalLiabs: 1 });

    // PREVIEW: reports the effect and changes nothing.
    const preview = await undo(u, id, false);
    expect(preview).toMatchObject({ status: 'preview', undoes: 'to_net_only', to_mode: 'detailed', net_before: 650_000, net_after: 600_000, variance: -50_000 });
    expect(preview.will_restore).toEqual({ assets: 1, liabilities: 1 });
    expect(await state(id)).toEqual(afterSwitch);
    expect(await log(id)).toHaveLength(1);

    // CONFIRM.
    const applied = await undo(u, id, true);
    expect(applied).toMatchObject({ status: 'applied', undid: 'to_net_only', net_before: 650_000, net_after: 600_000, variance: -50_000 });
    const after = await state(id);
    // Exactly one way is counted: itemised 600,000, no typed net, the SAME two lines (not copies), nothing deleted.
    expect(after).toMatchObject({ mode: 'detailed', typed: null, activeAssets: 1, activeLiabs: 1, totalAssets: 1, totalLiabs: 1, derived: 600_000 });
    // History kept: the switch and the undo, linked, with the typed net that was retired kept in the undo row.
    const h = await log(id);
    expect(h.map((r) => r.action)).toEqual(['to_net_only', 'undo']);
    expect(h[1].undoes_log_id).toBe(h[0].id);
    expect((h[1].retired_representation as Json).typed_net).toBe(650_000);
    // The register of violations stays empty: the either or rule holds.
    expect(await asUser(db, u, async () => q(`select * from business_entity_mode_rule_violations()`))).toHaveLength(0);
  });

  it('a second undo is refused (the newest history row is no longer a switch), and a fresh switch afterwards works', async () => {
    const u = await newUser('b');
    const id = await itemisedEntity(u, 'family_trust', [1_000_000], [400_000]);
    await switchTo(u, id, 'summary', { net: 650_000, confirm: true });
    await undo(u, id, true);
    await expectSqlError(undo(u, id, true), 'cannot be undone here');
    const again = await switchTo(u, id, 'summary', { net: 700_000, confirm: true });
    expect(again).toMatchObject({ status: 'applied', net_before: 600_000, net_after: 700_000 });
    expect((await state(id)).typed).toBe(700_000);
  });
});

describe('undo of a switch to itemised (Company, net value only 250,000 -> itemised 400,000 less 50,000)', () => {
  it('archives every active line (kept, not deleted), restores the typed net, never counts both', async () => {
    const u = await newUser('c');
    const id = await netOnlyEntity(u, 'company', 250_000);
    const sw = await switchTo(u, id, 'detailed', { assets: [{ label: 'Premises', value: 400_000, currency_code: 'AUD', asset_type: 'property' }], liabilities: [{ label: 'Bank loan', value: 50_000, currency_code: 'AUD', liability_type: 'other_loan' }], confirm: true });
    expect(sw).toMatchObject({ status: 'applied', net_before: 250_000, net_after: 350_000 });
    // The person then adds one more asset before changing their mind.
    await asUser(db, u, async () => db.query(`insert into business_entity_assets(user_id, business_entity_id, label, asset_type, value, currency_code) values ($1,$2,'Added later','other',10000,'AUD')`, [u, id]));
    expect((await state(id)).derived).toBe(360_000);

    const preview = await undo(u, id, false);
    expect(preview).toMatchObject({ status: 'preview', undoes: 'to_itemised', to_mode: 'summary', net_before: 360_000, net_after: 250_000 });
    expect(preview.will_archive).toEqual({ assets: 2, liabilities: 1 }); // the person sees how many lines would be archived
    expect(await state(id)).toMatchObject({ mode: 'detailed', activeAssets: 2, activeLiabs: 1, typed: null });

    const applied = await undo(u, id, true);
    expect(applied).toMatchObject({ status: 'applied', undid: 'to_itemised', net_after: 250_000 });
    const after = await state(id);
    expect(after).toMatchObject({ mode: 'summary', typed: 250_000, activeAssets: 0, activeLiabs: 0, totalAssets: 2, totalLiabs: 1 });
    expect(after.derived).toBe(0); // the archived lines are not counted: 250,000 is counted once
    const h = await log(id);
    expect(h.map((r) => r.action)).toEqual(['to_itemised', 'undo']);
    const kept = h[1].retired_representation as { assets: Json[]; liabilities: Json[] };
    expect(kept.assets.map((a) => a.label).sort()).toEqual(['Added later', 'Premises']);
    expect(kept.liabilities.map((l) => l.label)).toEqual(['Bank loan']);
    expect(await asUser(db, u, async () => q(`select * from business_entity_mode_rule_violations()`))).toHaveLength(0);
  });
});

describe('guards', () => {
  it('nothing to undo on an entity that was never switched', async () => {
    const u = await newUser('d');
    const id = await itemisedEntity(u, 'family_trust', [100], []);
    await expectSqlError(undo(u, id, false), 'cannot be undone here');
  });

  it('TWO-USER ISOLATION: another person cannot preview or undo this entity (answers as not found) and it is untouched', async () => {
    const a = await newUser('e');
    const b = await newUser('f');
    const id = await itemisedEntity(a, 'family_trust', [1_000_000], [400_000]);
    await switchTo(a, id, 'summary', { net: 650_000, confirm: true });
    const before = await state(id);
    await expectSqlError(undo(b, id, false), 'not found');
    await expectSqlError(undo(b, id, true), 'not found');
    expect(await state(id)).toEqual(before);
    expect(await log(id)).toHaveLength(1);
  });

  it('an unauthenticated session is refused', async () => {
    const a = await newUser('g');
    const id = await itemisedEntity(a, 'family_trust', [1], []);
    await db.exec('reset role;');
    await expectSqlError(db.query(`select business_entity_undo_last_switch($1,true)`, [id]) as Promise<unknown>, 'not authenticated');
  });

  it('NEGATIVE CONTROL: without the function the undo is impossible by the switch route alone (switching back needs the retired values re-typed, and the typed net is lost)', async () => {
    const u = await newUser('h');
    const id = await itemisedEntity(u, 'family_trust', [1_000_000], [400_000]);
    await switchTo(u, id, 'summary', { net: 650_000, confirm: true });
    // The only other way back is a fresh itemised switch: it RE-TYPES the lines (new rows) and archives nothing it should keep, so the originals stay archived and the
    // line count grows. That is the gap the Undo closes.
    await switchTo(u, id, 'detailed', { assets: [{ label: 'Retyped', value: 1_000_000, currency_code: 'AUD' }], liabilities: [{ label: 'Retyped loan', value: 400_000, currency_code: 'AUD' }], confirm: true });
    const s = await state(id);
    expect(s.totalAssets).toBe(2); // the original line plus a retyped copy
    expect(s.activeAssets).toBe(1);
  });
});
