/**
 * docs/financial-data-hub/po_run/DEV_apply_0218.sql (the PO's DEV apply of 0218) on the real migration
 * chain: it must carry 0218 verbatim, refuse outside DEV and before 0214, apply on a DEV-shaped database,
 * and be re-runnable. Each refusal is shown to leave 0218 absent (the guard is not decorative).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';

import { buildDb } from './support/fdh10LedgerPgliteHarness';
import { BEGIN_MARK, END_MARK, renderDevApply0218 } from '../../scripts/canonical_cert/build_dev_apply_0218.mjs';

const FILE = path.join(process.cwd(), 'docs/financial-data-hub/po_run/DEV_apply_0218.sql');
const MIGRATION = path.join(process.cwd(), 'supabase/migrations/0218_canonical_security_review_hardening.sql');

let db: PGlite;
const has0218 = async () => Number((await db.query<{ n: number }>(`select count(*)::int n from pg_trigger where tgname = 'trg_fdh_allocations_same_tenant_0218'`)).rows[0].n) === 1;
const run = async (sql: string): Promise<string | null> => {
  try { await db.exec(sql); return null; } catch (e) { await db.exec('rollback;').catch(() => undefined); return (e as Error).message; }
};
const policy = async (envs: string[]) => {
  await db.exec('delete from ii_nav_retention_policy;');
  for (const e of envs) await db.query(`insert into ii_nav_retention_policy (policy_version, changeover_date, environment) values ($1, '2026-09-21', $2)`, [`t-${e}`, e]);
};

beforeAll(async () => { db = await buildDb('0218'); }, 900_000);
afterAll(async () => { await db?.close(); });

describe('DEV_apply_0218.sql', () => {
  const file = fs.readFileSync(FILE, 'utf8');

  it('is current, BOM-free, and carries 0218 verbatim between its markers', () => {
    expect(file).toBe(renderDevApply0218(fs.readFileSync(MIGRATION, 'utf8')));
    expect(file.charCodeAt(0)).not.toBe(0xfeff);
    const body = file.slice(file.indexOf(BEGIN_MARK) + BEGIN_MARK.length + 1, file.indexOf(END_MARK) - 1);
    expect(body).toBe(fs.readFileSync(MIGRATION, 'utf8').replace(/\s+$/, ''));
    expect(file.indexOf('begin;')).toBeLessThan(file.indexOf(BEGIN_MARK));
    expect(file.lastIndexOf('commit;')).toBeGreaterThan(file.indexOf(END_MARK));
  });

  it('[NC] refuses on a database with a production policy row; 0218 stays absent', async () => {
    await policy(['dev', 'production']);
    expect(await run(file)).toMatch(/REFUSED: ii_nav_retention_policy has a production row/);
    expect(await has0218()).toBe(false);
  }, 120_000);

  it('[NC] refuses without a dev policy row; 0218 stays absent', async () => {
    await policy([]);
    expect(await run(file)).toMatch(/REFUSED: no dev row/);
    expect(await has0218()).toBe(false);
  }, 120_000);

  it('[NC] refuses when 0214 is not applied', async () => {
    await policy(['dev']);
    const without0214 = file.replace("to_regprocedure('public.fdh15_apply_asset_proposal(uuid, text, text[])')", "to_regprocedure('public.no_such_function_0214(uuid)')");
    expect(without0214).not.toBe(file);
    expect(await run(without0214)).toMatch(/REFUSED: 0214 is not applied/);
    expect(await has0218()).toBe(false);
  }, 120_000);

  it('applies on a DEV-shaped database (0207-0214 present, dev row only), and a second run is a no-op success', async () => {
    await policy(['dev']);
    expect(await run(file)).toBeNull();
    expect(await has0218()).toBe(true);
    expect(await run(file)).toBeNull();
    const anon = await db.query<{ ok: boolean }>(`select has_function_privilege('anon', 'fdh15_apply_asset_proposal(uuid, text, text[])', 'execute') ok`);
    expect(anon.rows[0].ok).toBe(false); // SR-04
  }, 300_000);
});
