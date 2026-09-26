/**
 * Migration 0213 (FDH-11 investment integrity, canonical-upload WP-12).
 *
 * 1. Static contract against the migration LEDGER (fast):
 *    - 0213 widens no shared CHECK (error_code / event_type belong to 0207);
 *    - the positions UPDATE guard it re-creates still guards EVERY column the
 *      0106 original guarded (derived from 0106's text, not restated), plus
 *      the new apply_rejected_reason;
 *    - no FDH-11 evidence table gains a foreign key to an ii_ table (0106's
 *      boundary rule; the same-tenant checks are trigger lookups);
 *    - the backfill claims service_role and clears the claim.
 * 2. Runtime proof: runs scripts/fdh11_0213_pglite_verification.mjs (real
 *    chain replay, anti-vacuity before, claims after, idempotent re-apply,
 *    true-NULL-role apply) and requires a clean exit with every check named.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const MIG = path.join(ROOT, 'supabase', 'migrations');
const read = (f: string) => readFileSync(path.join(MIG, f), 'utf8');
const M0213 = read('0213_fdh11_investment_integrity.sql');
const M0106 = read(readdirSync(MIG).find((f) => f.startsWith('0106'))!);
const stripComments = (s: string) => s.replace(/--[^\n]*/g, '');

function guardedColumns(sql: string, fn: string): string[] {
  const start = sql.indexOf(`create or replace function ${fn}()`);
  expect(start, `${fn} defined`).toBeGreaterThanOrEqual(0);
  const body = sql.slice(start, sql.indexOf('$$ language plpgsql', start));
  return [...stripComments(body).matchAll(/new\.([a-z_]+) is distinct from old\./g)].map((m) => m[1]).sort();
}

describe('migration 0213 -- static contract', () => {
  it('widens no shared CHECK constraint (those belong to 0207)', () => {
    const code = stripComments(M0213);
    expect(code).not.toMatch(/error_code_check/);
    expect(code).not.toMatch(/event_type_check/);
    expect(code).not.toMatch(/drop\s+constraint/i);
  });

  it('the re-created positions UPDATE guard keeps every column 0106 guarded, and adds apply_rejected_reason', () => {
    const before = guardedColumns(M0106, 'fdh11_investment_positions_assert_authoritative_write');
    const after = guardedColumns(M0213, 'fdh11_investment_positions_assert_authoritative_write');
    expect(before.length).toBeGreaterThan(5);
    for (const c of before) expect(after, `0213 dropped guarded column ${c}`).toContain(c);
    expect(after).toEqual([...before, 'apply_rejected_reason'].sort());
  });

  it('no other migration redefines that guard (0106 is its only predecessor)', () => {
    const redefiners = readdirSync(MIG)
      .filter((f) => f.endsWith('.sql') && f < '0213')
      .filter((f) => read(f).includes('create or replace function fdh11_investment_positions_assert_authoritative_write'));
    expect(redefiners.map((f) => f.slice(0, 4))).toEqual(['0106']);
  });

  it('adds no DB-level foreign key from an FDH-11 table to an ii_ table', () => {
    expect(/references\s+ii_/i.test(stripComments(M0213))).toBe(false);
  });

  it('the backfill claims service_role for its own transaction and clears it', () => {
    const code = stripComments(M0213);
    expect(code).toMatch(/set_config\('request\.jwt\.claim\.role', 'service_role', true\)/);
    expect(code).toMatch(/set_config\('request\.jwt\.claim\.role', '', true\)/);
    expect(code).toMatch(/where apply_status = 'not_applicable'/);
  });
});

describe('migration 0213 -- PGlite runtime proof', () => {
  it('scripts/fdh11_0213_pglite_verification.mjs passes every check (anti-vacuity, claims, re-apply, NULL-role apply)', () => {
    let out = '';
    let code = 0;
    try {
      out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'fdh11_0213_pglite_verification.mjs')], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      code = err.status ?? 1;
      out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
    const passes = out.split('\n').filter((l) => /^\s+PASS\s/.test(l)).length;
    const fails = out.split('\n').filter((l) => /^\s+FAIL\s/.test(l));
    expect(fails, fails.join('\n')).toEqual([]);
    expect(code, out.slice(-2000)).toBe(0);
    expect(passes).toBeGreaterThanOrEqual(46);
    expect(out).toMatch(/anti-vacuity \(INV-G5\): before 0213 an authenticated INSERT of an ALREADY-APPROVED statement/);
    expect(out).toMatch(/a forged authenticated INSERT with approval_status='approved' is REFUSED/);
    expect(out).toMatch(/pointing A's statement at B's ii account is REFUSED/);
  }, 900_000);
});
