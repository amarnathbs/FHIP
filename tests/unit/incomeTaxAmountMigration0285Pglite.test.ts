/**
 * PGLITE-VERIFIED: migration 0285 adds income_sources.tax_amount with a CHECK (0 <= tax <= amount), is idempotent,
 * and changes no existing row. Negative control: the same inserts WITHOUT the migration's constraint succeed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const MIGRATION = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/0285_income_sources_tax_amount.sql'), 'utf8');
const BASE = `create table public.income_sources (id serial primary key, amount numeric(18,2) not null, net_amount numeric(18,2));
insert into public.income_sources (amount, net_amount) values (196994.48, 3975.43);`;

describe('migration 0285 income_sources.tax_amount', () => {
  it('adds a nullable column, keeps existing rows unchanged, enforces 0 <= tax <= amount, and is idempotent', async () => {
    const db = new PGlite();
    await db.exec(BASE);
    await db.exec(MIGRATION);
    await db.exec(MIGRATION); // second run: no error
    const row = await db.query<{ amount: string; net_amount: string; tax_amount: string | null }>('select amount, net_amount, tax_amount from public.income_sources');
    expect(row.rows).toEqual([{ amount: '196994.48', net_amount: '3975.43', tax_amount: null }]);
    await db.exec('insert into public.income_sources (amount, tax_amount) values (1000, 1000)'); // equal is allowed
    await db.exec('insert into public.income_sources (amount, tax_amount) values (1000, 0)');
    await expect(db.exec('insert into public.income_sources (amount, tax_amount) values (1000, 1000.01)')).rejects.toThrow(/income_sources_tax_amount_range/);
    await expect(db.exec('insert into public.income_sources (amount, tax_amount) values (1000, -1)')).rejects.toThrow(/income_sources_tax_amount_range/);
    await expect(db.exec('update public.income_sources set tax_amount = 999999 where id = 1')).rejects.toThrow(/income_sources_tax_amount_range/);
  }, 60_000);

  it('negative control: without the migration the over-gross tax is not rejected (the column does not even exist)', async () => {
    const db = new PGlite();
    await db.exec(BASE);
    await expect(db.exec('insert into public.income_sources (amount, tax_amount) values (1000, 1001)')).rejects.toThrow(/tax_amount/);
  }, 60_000);
});
