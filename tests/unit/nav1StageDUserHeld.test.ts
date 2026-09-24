/**
 * NAV 1 Stage D — the hydration half of the shared "user-held" definition
 * (migration 0189).
 *
 * THE DEFECT. Retention (pc6_nav_row_is_candidate) and hydration
 * (fetchAcceptedDependencies) both protected / re-fetched an instrument only
 * when it had a CERTIFIED portfolio-truth statement. In production no
 * statement had ever certified, so retention would have deleted every held
 * instrument's history (proven on production: 17 of 17) and hydration would
 * never have fetched it back.
 *
 * The SQL half is proven by scripts/nav1_0189_pglite_verification.mjs,
 * which runs the broken function first as a negative control. This file
 * covers the TypeScript half: the pure mapper, the window it implies, and
 * source-level guards on the live wiring (vitest runs in `node` here, with
 * no live database -- the same precedent as fdh9PayslipCorrection.test.ts).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  determineHydrationRequirement,
  neededByAcceptedStatementHistory,
  userHeldInstrumentsToDependencies,
  type PolicyContext,
} from '@/lib/services/investment-intelligence/pc6/navRetentionPolicy';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');

const A = '11110000-0000-0000-0000-000000000001';
const B = '11110000-0000-0000-0000-000000000002';

describe('userHeldInstrumentsToDependencies', () => {
  it('turns every held instrument into an accepted dependency with no window', () => {
    const deps = userHeldInstrumentsToDependencies([A, B]);
    expect([...deps.keys()].sort()).toEqual([A, B]);
    for (const d of deps.values()) {
      expect(d.isAccepted).toBe(true);
      expect(d.historyCompleteness).toBeNull();
      expect(d.earliestTransactionDate).toBeNull();
      expect(d.certifiedAsOfDate).toBeNull();
    }
  });

  it('ignores duplicates and empty ids rather than throwing', () => {
    const deps = userHeldInstrumentsToDependencies([A, A, '', B]);
    expect(deps.size).toBe(2);
  });

  it('returns an empty map for no holdings (no instrument invented)', () => {
    expect(userHeldInstrumentsToDependencies([]).size).toBe(0);
  });
});

describe('what a held instrument implies', () => {
  const ctx: PolicyContext = {
    changeoverDate: '2026-09-21',
    acceptedDependencies: userHeldInstrumentsToDependencies([A]),
    benchmarkDependencies: new Map(),
    retentionHolds: new Map(),
    reportPinLookup: () => false,
  };

  it('hydration fetches it from INCEPTION -- matching retention keeping its entire history', () => {
    const req = determineHydrationRequirement(A, ctx, '2026-09-21');
    expect(req.required).toBe(true);
    expect(req.fromDate).toBeNull(); // null = from inception / earliest the provider has
    expect(req.reasons).toContain('accepted_statement_history');
  });

  it('retention keeps it on any date, including years before any transaction', () => {
    expect(neededByAcceptedStatementHistory({ instrumentId: A, navDate: '2008-01-01' }, ctx)).toBe(true);
  });

  it('an instrument nobody holds implies no hydration at all', () => {
    expect(determineHydrationRequirement(B, ctx, '2026-09-21').required).toBe(false);
  });
});

describe('the live hydration wiring uses the shared definition', () => {
  const LIVE = read('lib/services/investment-intelligence/pc6/selectiveHistoricalHydrationJobLive.ts');
  const body = LIVE.slice(
    LIVE.indexOf('async fetchAcceptedDependencies()'),
    LIVE.indexOf('async fetchBenchmarkDependencies()'),
  );

  it('reads held instruments from pc6_user_held_instrument_ids()', () => {
    expect(body).toContain("rpc('pc6_user_held_instrument_ids')");
  });

  it('no longer filters on certified statement status', () => {
    expect(body).not.toMatch(/\.in\(\s*'status'/);
  });

  it('pages the RPC with a unique order, so held instruments past 1000 are never silently dropped', () => {
    expect(body).toContain('fetchAllRows');
    expect(body).toContain(".order('instrument_id')");
  });
});

describe('migration 0189', () => {
  const SQL = read('supabase/migrations/0189_nav1_user_held_retention_definition.sql');
  const candidateFn = SQL.slice(SQL.indexOf('create or replace function pc6_nav_row_is_candidate'));

  it('the retention decision consults the shared user-held definition', () => {
    expect(candidateFn).toContain('pc6_instrument_is_user_held(p_instrument_id)');
  });

  it('the retention decision no longer requires a certified statement', () => {
    expect(candidateFn.slice(0, candidateFn.indexOf('$$;'))).not.toMatch(/status\s+in\s*\(\s*'certified'/);
  });
});

describe('the pre-0189 manifest generators cannot be mistaken for current ones', () => {
  // Both still encode the certified-only rule. Until they are rebuilt at
  // Stage D step D.10, the banner is the only thing standing between them
  // and a manifest that deletes users' history.
  for (const f of ['scripts/nav1_dev_retention_dryrun.mjs', 'scripts/pc6_nav1_retention_dryrun_manifest.sql']) {
    it(`${f} carries the SUPERSEDED banner`, () => {
      expect(read(f)).toContain('SUPERSEDED BY MIGRATION 0189');
    });
  }
});
