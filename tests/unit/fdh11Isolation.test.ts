/**
 * FDH-11 — isolation, boundary and investment-boundary tests, following the
 * exact pattern `tests/unit/fdh1Isolation.test.ts` established. These read
 * the REAL source tree, not a comment.
 *
 * Guarantees checked:
 *   1. `lib/financial-data-hub/investment/` never imports Investment
 *      Intelligence code and never touches an `ii_*` table.
 *   2. Migration 0106 creates no table restating a canonical II entity, and
 *      no table/column matching the forbidden investment-ledger patterns.
 *   3. `lib/investment-import-bridge/` (the ONE approved bridge) is the only
 *      place outside `lib/financial-data-hub/` that references FDH-11's
 *      evidence tables — i.e. no engine, report or dashboard reaches into
 *      FDH-11's evidence tables directly.
 *   4. No FDH-11 code creates an `expense`/`ordinary_income` value anywhere.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  FDH_TABLES,
  FORBIDDEN_FDH_INVESTMENT_TABLE_PATTERNS,
  II_ENTITIES_FDH_MUST_NOT_RESTATE,
} from '@/lib/financial-data-hub/constants/tables';

const REPO_ROOT = path.resolve(__dirname, '../..');
const FDH_INVESTMENT_DIR = path.join(REPO_ROOT, 'lib/financial-data-hub/investment');
const BRIDGE_DIR = path.join(REPO_ROOT, 'lib/investment-import-bridge');
const MIGRATION_0106 = fs.readFileSync(
  path.join(REPO_ROOT, 'supabase/migrations/0106_fdh11_au_investment_statement_intelligence.sql'),
  'utf8',
);

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => {
      const i = l.indexOf('//');
      return i === -1 ? l : l.slice(0, i);
    })
    .join('\n');
}

const INVESTMENT_FILES = walk(FDH_INVESTMENT_DIR).filter((f) => /\.ts$/.test(f));
const INVESTMENT_CODE = INVESTMENT_FILES.map((f) => stripComments(fs.readFileSync(f, 'utf8')));

describe('FDH-11 Hub module (lib/financial-data-hub/investment/) never touches Investment Intelligence', () => {
  it('the module exists and is non-trivial', () => {
    expect(INVESTMENT_FILES.length).toBeGreaterThan(5);
  });

  it('imports no Investment Intelligence service or engine', () => {
    for (let i = 0; i < INVESTMENT_CODE.length; i += 1) {
      expect(
        /from ['"]@\/lib\/(services|engines)\/investment-intelligence/.test(INVESTMENT_CODE[i]),
        `${INVESTMENT_FILES[i]} imports Investment Intelligence code`,
      ).toBe(false);
    }
  });

  it('never queries an ii_ table', () => {
    for (let i = 0; i < INVESTMENT_CODE.length; i += 1) {
      expect(
        /\.from\(\s*['"`]ii_[a-z_]+['"`]/.test(INVESTMENT_CODE[i]),
        `${INVESTMENT_FILES[i]} queries an ii_ table directly`,
      ).toBe(false);
    }
  });

  it('imports no Supabase client at all — pure logic plus, at most, other Hub-internal shared primitives', () => {
    // The one exception is the Hub's own service-role processing service,
    // which is explicitly approved to use the admin client (mirrors every
    // prior FDH phase's own processing-service carve-out).
    const APPROVED_SUPABASE_FILES = [path.join(REPO_ROOT, 'lib/financial-data-hub/services/investmentStatementProcessingService.ts')];
    for (let i = 0; i < INVESTMENT_CODE.length; i += 1) {
      const usesSupabase = /adminClient|supabase\/admin|supabase\/server/.test(INVESTMENT_CODE[i]);
      if (!usesSupabase) continue;
      expect(APPROVED_SUPABASE_FILES.includes(INVESTMENT_FILES[i]), INVESTMENT_FILES[i]).toBe(true);
    }
  });

  it('creates no expense/ordinary_income financial-treatment value anywhere (spec sections 26-27, 98-99)', () => {
    for (let i = 0; i < INVESTMENT_CODE.length; i += 1) {
      expect(/'expense'|"expense"|'ordinary_income'|"ordinary_income"/.test(INVESTMENT_CODE[i]), INVESTMENT_FILES[i]).toBe(false);
    }
  });
});

describe('FDH-11 migration 0106 investment boundary', () => {
  it('creates no table restating a canonical Investment Intelligence entity', () => {
    for (const iiTable of II_ENTITIES_FDH_MUST_NOT_RESTATE) {
      const fdhEquivalent = iiTable.replace(/^ii_/, 'fdh_');
      expect((FDH_TABLES as readonly string[]).includes(fdhEquivalent), `FDH created ${fdhEquivalent}`).toBe(false);
    }
  });

  it('creates no holdings, securities, valuation, NAV, folio or portfolio table', () => {
    for (const table of FDH_TABLES) {
      for (const pattern of FORBIDDEN_FDH_INVESTMENT_TABLE_PATTERNS) {
        expect(table.includes(pattern), `FDH table ${table} matches forbidden pattern "${pattern}"`).toBe(false);
      }
    }
  });

  it('carries no DB-level foreign key to any ii_ table from an FDH-11 evidence table', () => {
    const body = MIGRATION_0106.slice(
      MIGRATION_0106.indexOf('create table fdh_investment_statements'),
      MIGRATION_0106.indexOf('-- PART G'),
    );
    expect(/references\s+ii_/i.test(body)).toBe(false);
  });

  it('touches ii_instrument_identifiers ONLY in the explicit, narrow, additive PART G extension', () => {
    const beforePartG = MIGRATION_0106.slice(0, MIGRATION_0106.indexOf('-- PART G'));
    expect(/\bii_[a-z_]+/.test(beforePartG.replace(/--[^\n]*/g, ''))).toBe(false);
  });

  it('is additive only — every ALTER widens a check constraint or adds a column, never drops one', () => {
    expect(/drop\s+column/i.test(MIGRATION_0106)).toBe(false);
    expect(/drop\s+table/i.test(MIGRATION_0106)).toBe(false);
  });
});

describe('FDH-11 bridge (lib/investment-import-bridge/) is the sole consumer of FDH-11 evidence tables outside the Hub', () => {
  it('no engine, report or dashboard queries fdh_investment_statement_* directly', () => {
    const offenders: string[] = [];
    for (const dir of ['lib/engines', 'lib/services', 'components', 'app']) {
      const root = path.join(REPO_ROOT, dir);
      for (const file of walk(root)) {
        if (!/\.(ts|tsx)$/.test(file)) continue;
        if (file.startsWith(FDH_INVESTMENT_DIR) || file.startsWith(BRIDGE_DIR)) continue;
        // API routes under app/api/financial-data-hub/ are the approved
        // orchestration surface (they call BOTH the Hub service and the
        // bridge, exactly like FDH-9/FDH-10's own routes do) — not a
        // violation, this is the intended composition point.
        if (file.includes(path.join('app', 'api', 'financial-data-hub'))) continue;
        // The Investments-tab import panel sends the table NAME as a plain
        // string value in a JSON request body to the API route above (e.g.
        // `{ table: 'fdh_investment_statement_positions' }`) — this is a
        // request parameter, not a direct table query; the same relationship
        // LiabilityImportPanel.tsx/PayslipImportPanel.tsx already have to
        // their own domain's table names.
        if (file === path.join(REPO_ROOT, 'components', 'investments', 'AuInvestmentStatementImportPanel.tsx')) continue;
        const src = fs.readFileSync(file, 'utf8');
        if (/fdh_investment_statement/.test(src)) offenders.push(file);
      }
    }
    expect(offenders, `unapproved direct access to FDH-11 evidence tables: ${offenders.join(', ')}`).toEqual([]);
  });
});
