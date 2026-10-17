// Shared PGlite harness for the entity-level (SMSF itemised / net-only) database tests: replays the REAL migration ledger into an
// isolated in-memory Postgres and offers a role/claims switcher. EVIDENCE LABEL for everything built on it: "verified on an isolated
// PGlite replay", not DEV- or production-verified.
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..', '..');
export const MIG_DIR = path.join(ROOT, 'supabase', 'migrations');

export async function replayLedger(opts: { skip?: (file: string) => boolean } = {}): Promise<PGlite> {
  const db = await PGlite.create();
  await db.exec(fs.readFileSync(path.join(ROOT, 'scripts', 'db-rebuild-check', 'shim.sql'), 'utf8'));
  const seed = fs.readFileSync(path.join(ROOT, 'supabase', 'seed.sql'), 'utf8');
  const files = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql') && !(opts.skip?.(f) ?? false)).sort();
  for (const f of files) {
    await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
    if (f.startsWith('0001')) await db.exec(seed);
  }
  return db;
}

export async function seedUser(db: PGlite, id: string, email: string, country = 'AU'): Promise<void> {
  await db.exec(`insert into auth.users(id,email) values ('${id}','${email}');`);
  await db.exec(
    `insert into user_profiles(user_id, country_of_residence, country_confirmed_at) values ('${id}','${country}', now())
     on conflict (user_id) do update set country_of_residence='${country}', country_confirmed_at=now();`,
  );
}

/** Run `fn` as the given user with the authenticated role (RLS applies; auth.uid() = id). */
export async function asUser<T>(db: PGlite, uid: string, fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]);
  await db.exec('set role authenticated;');
  try {
    return await fn();
  } finally {
    await db.exec('reset role;');
    await db.query(`select set_config('request.jwt.claims', '', false)`);
  }
}

export async function expectSqlError(p: Promise<unknown>, fragment: string): Promise<void> {
  let message = '';
  try {
    await p;
  } catch (e) {
    message = (e as Error).message;
  }
  if (!message.includes(fragment)) throw new Error(`expected an error containing "${fragment}" but got "${message || 'no error'}"`);
}
