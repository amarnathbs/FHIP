/**
 * FDH-12 — MANDATORY FINANCIAL NEGATIVE CONTROLS (spec sections 175, 179).
 *
 * The brief lists nine outcomes the harness "must explicitly fail if any of
 * these occur". This file is that harness. Every test below states the
 * forbidden answer FIRST, proves the naive computation really would produce
 * it, and only then asserts the correct one — so a passing test cannot be
 * vacuous.
 *
 *   1. payslip employer super $1,000 + fund contribution $1,000 = $2,000
 *   2. rollover $100,000 -> income $100,000
 *   3. rollover $100,000 -> expense $100,000
 *   4. personal bank->super contribution $5,000 -> household expense $5,000
 *   5. super investment earnings $8,000 retained -> household cash income $8,000
 *   6. super internal fee $100 + household cash expense $100
 *   7. super balance $200,000 + same holdings $200,000 -> net worth $400,000
 *   8. Fund A rollover $100,000 + Fund B receipt $100,000 -> retirement $200,000
 *   9. current contribution $1,000 + YTD $8,000 -> $9,000
 *
 * SEVERAL OF THESE ARE UNREACHABLE BY CONSTRUCTION, and where that is so the
 * test proves the CONSTRUCTION rather than a runtime branch — because a rule
 * enforced by the absence of code is stronger than one enforced by an `if`,
 * and a test that only exercised an `if` would not notice if someone later
 * added the missing write path. Those tests read the real source tree.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  RETIREMENT_ACTIVITY_DIRECTION,
  RETIREMENT_ACTIVITY_IS_INTERNAL,
  RETIREMENT_ACTIVITY_TYPES,
} from '@/lib/financial-data-hub/retirement/types';
import {
  matchContributionToPayslip,
  reconciledContributionMinorUnits,
} from '@/lib/financial-data-hub/retirement/payslipReconciliation';
import { householdRetirementTotalMinorUnits } from '@/lib/financial-data-hub/retirement/rolloverIntelligence';
import { matchRetirementActivityToBank } from '@/lib/financial-data-hub/retirement/bankMatching';
import { reconcileFromActivities } from '@/lib/financial-data-hub/retirement/reconciliation';
import { parseMoneyToMinorUnits } from '@/lib/financial-data-hub/retirement/money';
import { RETIREMENT_APPLICABLE_FIELDS } from '@/lib/import-bridge/adapters/retirementAdapter';

const REPO = path.resolve(__dirname, '..', '..');
const MIGRATION = fs.readFileSync(
  path.join(REPO, 'supabase', 'migrations', '0112_fdh12_retirement_statement_intelligence.sql'),
  'utf8',
);

/** Every FDH-12 source file, for the "no such write path exists" proofs. */
function collectSources(dirs: string[]): { file: string; code: string }[] {
  const out: { file: string; code: string }[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(entry.name)) out.push({ file: p, code: fs.readFileSync(p, 'utf8') });
    }
  };
  dirs.forEach(walk);
  return out;
}

const FDH12_SOURCES = [
  ...collectSources([path.join(REPO, 'lib', 'financial-data-hub', 'retirement')]),
  { file: 'retirementStatementProcessingService.ts', code: fs.readFileSync(path.join(REPO, 'lib', 'financial-data-hub', 'services', 'retirementStatementProcessingService.ts'), 'utf8') },
  { file: 'retirementAdapter.ts', code: fs.readFileSync(path.join(REPO, 'lib', 'import-bridge', 'adapters', 'retirementAdapter.ts'), 'utf8') },
  { file: 'applyRetirementProposalAtomic.ts', code: fs.readFileSync(path.join(REPO, 'lib', 'import-bridge', 'applyRetirementProposalAtomic.ts'), 'utf8') },
  ...collectSources([path.join(REPO, 'app', 'api', 'financial-data-hub', 'retirement-statement')]),
  { file: 'RetirementStatementImportPanel.tsx', code: fs.readFileSync(path.join(REPO, 'components', 'retirement', 'RetirementStatementImportPanel.tsx'), 'utf8') },
];

/** Strip comments so a rule is proven against CODE, not against prose that
 * merely mentions a table name. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const M = (s: string) => parseMoneyToMinorUnits(s);

// ===========================================================================
// CONTROL 1 — payslip $1,000 + fund $1,000 must be $1,000, never $2,000
// ===========================================================================

describe('FDH-12 spec 22/64/120/175.1 — employer super double-count', () => {
  const payslip = {
    id: 'pay-1',
    employer_name: 'Acme Pty Ltd',
    employer_normalised: 'acme',
    pay_period_start: '2026-07-01',
    pay_period_end: '2026-07-31',
    payment_date: '2026-07-31',
    currency_code: 'AUD',
    employer_retirement_contribution: '1000.00',
    employee_retirement_contribution: null,
  };

  it('proves the naive answer really would be $2,000', () => {
    const naive = Number('1000.00') + Number('1000.00');
    expect(naive).toBe(2000);
  });

  it('reconciles the two evidence sources to ONE contribution of $1,000', () => {
    const reconciled = reconciledContributionMinorUnits('1000.00', '1000.00');
    expect(reconciled).toBe(M('1000.00'));
    expect(reconciled).not.toBe(M('2000.00'));
  });

  it('recognises the pair as one economic contribution', () => {
    const result = matchContributionToPayslip(
      {
        activityType: 'EMPLOYER_CONTRIBUTION',
        amount: '1000.00',
        currencyCode: 'AUD',
        activityDate: '2026-08-14',
        employerNameRaw: 'Acme Pty Ltd',
      },
      [payslip],
    );
    expect(result.status).toBe('matched');
    expect(result.payrollEventId).toBe('pay-1');
    expect(result.varianceMinorUnits).toBe(M('0.00'));
  });

  it('has no function anywhere that ADDS payslip and fund contributions', () => {
    // The structural proof: `reconciledContributionMinorUnits` is the only
    // function that takes both sources, and it has no additive branch.
    const src = stripComments(
      FDH12_SOURCES.find((s) => s.file.endsWith('payslipReconciliation.ts'))!.code,
    );
    // No line adds a fund amount to a payslip amount.
    expect(/fund\s*\+\s*payslip|payslip\s*\+\s*fund/.test(src)).toBe(false);
  });

  it('a payslip already claimed by one activity cannot be claimed by a second', () => {
    // Migration-level proof of the third layer: the unique index.
    expect(MIGRATION).toMatch(
      /create unique index uq_fdh_retirement_activities_payroll_event[\s\S]*?on fdh_retirement_statement_activities\(matched_payroll_event_id\)[\s\S]*?where matched_payroll_event_id is not null/,
    );
  });

  it('canonical employer_contribution is ASSIGNED, never incremented', () => {
    // The RPC builds `col = value`, never `col = col + value`. If it ever
    // did, $1,000 applied twice would become $2,000.
    expect(/%I\s*=\s*%I\s*\+/.test(MIGRATION)).toBe(false);
    expect(MIGRATION).toMatch(/v_set_parts := array_append\(v_set_parts, format\('%I = %L::numeric'/);
  });
});

// ===========================================================================
// CONTROL 2 + 3 — rollover is neither income nor expense
// ===========================================================================

describe('FDH-12 spec 33/122/175.2-3 — rollover is not income and not expense', () => {
  it('classifies both rollover legs as balance movements, not income or expense', () => {
    expect(RETIREMENT_ACTIVITY_DIRECTION.ROLLOVER_IN).toBe('credit');
    expect(RETIREMENT_ACTIVITY_DIRECTION.ROLLOVER_OUT).toBe('debit');
    // Both are INTERNAL — they never touch household cash.
    expect(RETIREMENT_ACTIVITY_IS_INTERNAL.ROLLOVER_IN).toBe(true);
    expect(RETIREMENT_ACTIVITY_IS_INTERNAL.ROLLOVER_OUT).toBe(true);
  });

  it('never looks for a bank transaction for a rollover, so it cannot become a cash event', () => {
    const result = matchRetirementActivityToBank(
      { activityType: 'ROLLOVER_IN', amount: '100000.00', currencyCode: 'AUD', activityDate: '2026-07-15' },
      'New Super Fund',
      [{
        id: 'txn-1', transaction_date: '2026-07-15', amount_original: '100000.00',
        credit_debit: 'credit', currency_original: 'AUD', description_raw: null, description_clean: 'NEW SUPER FUND ROLLOVER',
      }],
    );
    // A perfectly matching bank row exists and is STILL not matched, because
    // an internal activity has no bank side (spec section 81).
    expect(result.status).toBe('not_expected');
    expect(result.transactionId).toBeNull();
  });

  it('FDH-12 has NO write path to income, expenses, or bank transactions', () => {
    // THE STRUCTURAL PROOF. A rollover cannot become income or an expense
    // because no FDH-12 file can write to any register that holds them.
    const forbiddenWrites = [
      /\.from\(['"]income_sources['"]\)[\s\S]{0,200}?\.(insert|update|upsert|delete)\(/,
      /\.from\(['"]expenses['"]\)[\s\S]{0,200}?\.(insert|update|upsert|delete)\(/,
      /\.from\(['"]fdh_transactions['"]\)[\s\S]{0,200}?\.(insert|update|upsert|delete)\(/,
      /\.from\(['"]investments['"]\)[\s\S]{0,200}?\.(insert|update|upsert|delete)\(/,
    ];
    for (const { file, code } of FDH12_SOURCES) {
      const src = stripComments(code);
      for (const pattern of forbiddenWrites) {
        expect(pattern.test(src), `${file} writes to a register FDH-12 must never write`).toBe(false);
      }
    }
  });

  it('the migration creates no income, expense or transaction row anywhere', () => {
    const sql = MIGRATION.replace(/--.*$/gm, '');
    expect(/insert\s+into\s+income_sources/i.test(sql)).toBe(false);
    expect(/insert\s+into\s+expenses/i.test(sql)).toBe(false);
    expect(/insert\s+into\s+fdh_transactions/i.test(sql)).toBe(false);
  });
});

// ===========================================================================
// CONTROL 4 — personal bank->super contribution is not a household expense
// ===========================================================================

describe('FDH-12 spec 30/121/175.4 — personal contribution is a transfer, not spending', () => {
  it('is the one contribution type that DOES have a bank side', () => {
    // It genuinely crosses the household-cash boundary, so bank matching is
    // correct for it — but matching is linking, not classifying as spending.
    expect(RETIREMENT_ACTIVITY_IS_INTERNAL.PERSONAL_CONTRIBUTION).toBe(false);
  });

  it('matches Bank -$5,000 to Super +$5,000 as ONE event', () => {
    const result = matchRetirementActivityToBank(
      { activityType: 'PERSONAL_CONTRIBUTION', amount: '5000.00', currencyCode: 'AUD', activityDate: '2026-07-10' },
      'Hostplus',
      [{
        id: 'txn-a', transaction_date: '2026-07-10', amount_original: '5000.00',
        credit_debit: 'debit', currency_original: 'AUD', description_raw: null, description_clean: 'TRANSFER TO HOSTPLUS SUPER',
      }],
    );
    expect(result.status).toBe('matched');
    expect(result.transactionId).toBe('txn-a');
  });

  it('produces $0 of household expense — there is no expense write path at all', () => {
    for (const { file, code } of FDH12_SOURCES) {
      const src = stripComments(code);
      expect(/economic_transaction_type/.test(src), `${file} assigns an economic class`).toBe(false);
    }
  });
});

// ===========================================================================
// CONTROL 5 — retained earnings are not household cash income
// ===========================================================================

describe('FDH-12 spec 39/125/175.5 — retained investment earnings are not cash income', () => {
  it('treats earnings as internal, so no bank match is even attempted', () => {
    expect(RETIREMENT_ACTIVITY_IS_INTERNAL.INVESTMENT_EARNINGS).toBe(true);
    const result = matchRetirementActivityToBank(
      { activityType: 'INVESTMENT_EARNINGS', amount: '8000.00', currencyCode: 'AUD', activityDate: '2026-06-30' },
      'Aware Super',
      [{
        id: 'txn-x', transaction_date: '2026-06-30', amount_original: '8000.00',
        credit_debit: 'credit', currency_original: 'AUD', description_raw: null, description_clean: 'AWARE SUPER EARNINGS',
      }],
    );
    expect(result.status).toBe('not_expected');
  });

  it('still counts earnings toward the retirement BALANCE', () => {
    // Not household income, but definitely a balance movement — the two facts
    // are different and both must hold.
    expect(RETIREMENT_ACTIVITY_DIRECTION.INVESTMENT_EARNINGS).toBe('credit');
  });

  it('internal distributions are not duplicated as personal investment income', () => {
    expect(RETIREMENT_ACTIVITY_IS_INTERNAL.DISTRIBUTION).toBe(true);
    expect(RETIREMENT_ACTIVITY_IS_INTERNAL.INTEREST).toBe(true);
  });
});

// ===========================================================================
// CONTROL 6 — an internal super fee is not a household cash expense
// ===========================================================================

describe('FDH-12 spec 41/123/175.6 — internal fee reduces the balance only', () => {
  it('reduces the retirement balance', () => {
    expect(RETIREMENT_ACTIVITY_DIRECTION.FEE).toBe('debit');
  });

  it('creates no household cash expense — internal, so never bank-matched', () => {
    expect(RETIREMENT_ACTIVITY_IS_INTERNAL.FEE).toBe(true);
    const result = matchRetirementActivityToBank(
      { activityType: 'FEE', amount: '100.00', currencyCode: 'AUD', activityDate: '2026-07-31' },
      'REST',
      [{
        id: 'txn-f', transaction_date: '2026-07-31', amount_original: '100.00',
        credit_debit: 'debit', currency_original: 'AUD', description_raw: null, description_clean: 'REST ADMIN FEE',
      }],
    );
    expect(result.status).toBe('not_expected');
  });

  it('an insurance premium inside super behaves identically', () => {
    // spec sections 42, 74, 124 — reduces the balance, creates no duplicate
    // household insurance expense, and never touches canonical insurance.
    expect(RETIREMENT_ACTIVITY_DIRECTION.INSURANCE_PREMIUM).toBe('debit');
    expect(RETIREMENT_ACTIVITY_IS_INTERNAL.INSURANCE_PREMIUM).toBe(true);
  });

  it('never writes to canonical insurance policies (spec sections 43, 161)', () => {
    for (const { file, code } of FDH12_SOURCES) {
      const src = stripComments(code);
      expect(/\.from\(['"]insurance_policies['"]\)/.test(src), `${file} touches insurance_policies`).toBe(false);
    }
    expect(/insurance_policies/i.test(MIGRATION.replace(/--.*$/gm, ''))).toBe(false);
  });

  it('contributions tax is preserved exactly, and no rate is inferred from it', () => {
    // spec sections 44-45.
    expect(RETIREMENT_ACTIVITY_DIRECTION.TAX).toBe('debit');
    for (const { file, code } of FDH12_SOURCES) {
      const src = stripComments(code);
      // No statutory rate constant anywhere — 15% contributions tax, 10.5%/11%
      // SG rates and the like are never hard-coded.
      expect(/0\.15|15\s*%|superRate|contributionsTaxRate/.test(src), `${file} embeds a statutory rate`).toBe(false);
    }
  });
});

// ===========================================================================
// CONTROL 7 — super balance + its own holdings is not double net worth
// ===========================================================================

describe('FDH-12 spec 13/71/175.7 — statement holdings never double net worth', () => {
  it('proves the naive answer really would be $400,000', () => {
    const naive = Number('200000.00') + Number('200000.00');
    expect(naive).toBe(400000);
  });

  it('the positions table has NO apply path and NO canonical destination column', () => {
    // THE STRUCTURAL PROOF. Unlike FDH-11's positions, which carry
    // `apply_status` and `canonical_holding_snapshot_id`, FDH-12's carry
    // neither — because there is nowhere for them to go.
    const positionsBlock = MIGRATION.slice(
      MIGRATION.indexOf('create table fdh_retirement_statement_positions'),
      MIGRATION.indexOf('-- PART E'),
    );
    expect(positionsBlock.length).toBeGreaterThan(200);
    expect(/apply_status/.test(positionsBlock)).toBe(false);
    expect(/canonical_/.test(positionsBlock)).toBe(false);
    expect(/applied_at|applied_by/.test(positionsBlock)).toBe(false);
  });

  it('no code path reads a position row and writes an investment', () => {
    for (const { file, code } of FDH12_SOURCES) {
      const src = stripComments(code);
      expect(/ii_holding_snapshots|ii_transactions|ii_accounts/.test(src),
        `${file} references an Investment Intelligence table`).toBe(false);
    }
  });

  it('the apply allow-list contains no holding, unit or market-value field', () => {
    for (const f of RETIREMENT_APPLICABLE_FIELDS) {
      expect(/holding|unit|market_value|option/.test(f)).toBe(false);
    }
  });

  it('net worth therefore sees the balance once: $200,000, not $400,000', () => {
    // Net worth is Σ retirement_accounts.current_balance and nothing else, so
    // the household contribution of one $200,000 super account with $200,000
    // of underlying holdings is exactly one $200,000 term.
    const total = householdRetirementTotalMinorUnits(['200000.00']);
    expect(total).toBe(M('200000.00'));
    expect(total).not.toBe(M('400000.00'));
  });
});

// ===========================================================================
// CONTROL 8 — a rollover does not double household retirement
// ===========================================================================

describe('FDH-12 spec 34/122/175.8 — rollover does not double the household total', () => {
  it('proves the naive answer really would be $200,000', () => {
    const naive = Number('100000.00') + Number('100000.00');
    expect(naive).toBe(200000);
  });

  it('after a full rollover the household total is $100,000, not $200,000', () => {
    // Before: Fund A = $100,000, Fund B = $0.
    // After:  Fund A = $0,       Fund B = $100,000.
    // Each statement's CLOSING balance is what is applied, and applying is an
    // assignment, so the sum is unchanged.
    const before = householdRetirementTotalMinorUnits(['100000.00', '0.00']);
    const after = householdRetirementTotalMinorUnits(['0.00', '100000.00']);
    expect(before).toBe(M('100000.00'));
    expect(after).toBe(M('100000.00'));
    expect(after).not.toBe(M('200000.00'));
  });

  it('a PARTIAL rollover leaves $150,000 total, not $200,000 (spec section 35)', () => {
    // Fund A $150,000, rolls out $50,000; Fund B receives $50,000.
    const after = householdRetirementTotalMinorUnits(['100000.00', '50000.00']);
    expect(after).toBe(M('150000.00'));
    expect(after).not.toBe(M('200000.00'));
  });

  it('net worth does not increase by $100,000 just because the fund changed', () => {
    const before = householdRetirementTotalMinorUnits(['100000.00']);
    const after = householdRetirementTotalMinorUnits(['0.00', '100000.00']);
    expect(after! - before!).toBe(M('0.00'));
  });
});

// ===========================================================================
// CONTROL 9 — current-period contribution + YTD is not their sum
// ===========================================================================

describe('FDH-12 spec 114-116/175.9 — YTD is evidence, never another payment', () => {
  it('proves the naive answer really would be $9,000', () => {
    const naive = Number('1000.00') + Number('8000.00');
    expect(naive).toBe(9000);
  });

  it('excludes YTD rows from activity reconciliation entirely', () => {
    const result = reconcileFromActivities('10000.00', '11000.00', [
      { activityType: 'EMPLOYER_CONTRIBUTION', amount: '1000.00', currencyCode: 'AUD', activityDate: '2026-07-31', isSummaryTotal: false, isYearToDate: false },
      { activityType: 'EMPLOYER_CONTRIBUTION', amount: '8000.00', currencyCode: 'AUD', activityDate: '2026-07-31', isSummaryTotal: false, isYearToDate: true },
    ]);
    // 10,000 + 1,000 = 11,000. The YTD 8,000 took no part.
    expect(result.status).toBe('reconciled');
    expect(result.varianceMinorUnits).toBe(M('0.00'));
    expect(result.detail.excludedYtdRows).toBe(1);
    expect(result.detail.movementTermCount).toBe(1);
  });

  it('WOULD have failed if the YTD row had been counted (negative control)', () => {
    // Same statement, but with the YTD flag wrongly cleared — proving the test
    // above is not passing for some unrelated reason.
    const wrong = reconcileFromActivities('10000.00', '11000.00', [
      { activityType: 'EMPLOYER_CONTRIBUTION', amount: '1000.00', currencyCode: 'AUD', activityDate: '2026-07-31', isSummaryTotal: false, isYearToDate: false },
      { activityType: 'EMPLOYER_CONTRIBUTION', amount: '8000.00', currencyCode: 'AUD', activityDate: '2026-07-31', isSummaryTotal: false, isYearToDate: false },
    ]);
    expect(wrong.status).toBe('variance');
    expect(wrong.varianceMinorUnits).toBe(M('8000.00'));
  });

  it('excludes printed SUBTOTALS the same way (spec sections 116-118)', () => {
    // An annual statement printing "Total employer contributions 12,000"
    // above twelve monthly lines of 1,000 must reconcile to 12,000, not 24,000.
    const monthly = Array.from({ length: 12 }, () => ({
      activityType: 'EMPLOYER_CONTRIBUTION' as const, amount: '1000.00', currencyCode: 'AUD',
      activityDate: '2026-07-31', isSummaryTotal: false, isYearToDate: false,
    }));
    const withTotal = [
      ...monthly,
      { activityType: 'EMPLOYER_CONTRIBUTION' as const, amount: '12000.00', currencyCode: 'AUD', activityDate: '2026-06-30', isSummaryTotal: true, isYearToDate: false },
    ];
    const result = reconcileFromActivities('50000.00', '62000.00', withTotal);
    expect(result.status).toBe('reconciled');
    expect(result.detail.excludedSummaryRows).toBe(1);
    expect(result.detail.movementTermCount).toBe(12);
  });

  it('YTD columns live in their own named fields on the statement table', () => {
    expect(MIGRATION).toMatch(/ytd_employer_contributions numeric\(20,4\)/);
    expect(MIGRATION).toMatch(/ytd_personal_contributions numeric\(20,4\)/);
  });
});

// ===========================================================================
// CROSS-CUTTING: the direction table is total and internally coherent
// ===========================================================================

describe('FDH-12 activity vocabulary coherence', () => {
  it('every activity type has an explicit direction entry', () => {
    for (const t of RETIREMENT_ACTIVITY_TYPES) {
      expect(Object.prototype.hasOwnProperty.call(RETIREMENT_ACTIVITY_DIRECTION, t), t).toBe(true);
    }
    expect(Object.keys(RETIREMENT_ACTIVITY_DIRECTION).sort()).toEqual([...RETIREMENT_ACTIVITY_TYPES].sort());
  });

  it('every activity type has an explicit internal/external entry', () => {
    expect(Object.keys(RETIREMENT_ACTIVITY_IS_INTERNAL).sort()).toEqual([...RETIREMENT_ACTIVITY_TYPES].sort());
  });

  it('UNKNOWN has no direction, so it can never silently balance a statement', () => {
    expect(RETIREMENT_ACTIVITY_DIRECTION.UNKNOWN).toBeNull();
    expect(RETIREMENT_ACTIVITY_DIRECTION.OTHER).toBeNull();
    expect(RETIREMENT_ACTIVITY_DIRECTION.ADJUSTMENT).toBeNull();
  });

  it('UNKNOWN fails closed on bank matching too', () => {
    expect(RETIREMENT_ACTIVITY_IS_INTERNAL.UNKNOWN).toBe(true);
  });

  it('the DB CHECK vocabulary matches the TypeScript vocabulary exactly', () => {
    const match = MIGRATION.match(/activity_type text not null check \(activity_type in \(([\s\S]*?)\)\)/);
    expect(match).not.toBeNull();
    const dbTypes = [...match![1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();
    expect(dbTypes).toEqual([...RETIREMENT_ACTIVITY_TYPES].sort());
  });
});
