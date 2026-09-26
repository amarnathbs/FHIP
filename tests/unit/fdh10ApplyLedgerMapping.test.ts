/**
 * WP-11 (G2): the certified FDH-10 economics are no longer dead code. The
 * ledger Apply (migration 0209) writes what `classifyStatementActivity` and
 * `decomposeLoanPayment` decide -- proven here at the SOURCE level (the SQL
 * CASE parsed out of the migration) for all ten activity types, and at the
 * DATABASE level by tests/unit/fdh10ApplyLedgerPglite.test.ts.
 *
 * Anti-vacuity: the parser is run against a deliberately mutated copy of the
 * SQL (PAYMENT -> expense) and must report the difference.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { LIABILITY_LEDGER_MAPPING, classifyStatementActivity, planCardStatementLedgerWrites, totalExpenseFromPlan } from '@/lib/financial-data-hub/liability/creditCardEconomics';
import { decomposeLoanPayment } from '@/lib/financial-data-hub/liability/repaymentDecomposition';
import { LIABILITY_ACTIVITY_TYPES } from '@/lib/financial-data-hub/liability/types';

const SQL = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/0209_fdh10_liability_apply_ledger.sql'), 'utf8');

function parseSqlMapping(sql: string): Record<string, { creditDebit: string; economicType: string }> {
  const block = /-- LEDGER_MAPPING_BEGIN[\s\S]*?-- LEDGER_MAPPING_END/.exec(sql);
  if (!block) throw new Error('LEDGER_MAPPING markers not found');
  const caseOf = (variable: string) => {
    const m = new RegExp(`${variable} := case v_act\\.activity_type([\\s\\S]*?)end;`).exec(block[0]);
    if (!m) throw new Error(`${variable} CASE not found`);
    return Object.fromEntries([...m[1].matchAll(/when '([A-Z_]+)' then '([a-z_]+)'/g)].map((x) => [x[1], x[2]]));
  };
  const cd = caseOf('v_cd');
  const type = caseOf('v_type');
  const out: Record<string, { creditDebit: string; economicType: string }> = {};
  for (const k of new Set([...Object.keys(cd), ...Object.keys(type)])) out[k] = { creditDebit: cd[k], economicType: type[k] };
  return out;
}

describe('the SQL ledger mapping equals the certified TypeScript economics', () => {
  const sqlMapping = parseSqlMapping(SQL);

  it('covers exactly the eight mappable activity types; ADJUSTMENT/OTHER are never mapped', () => {
    const mappable = LIABILITY_ACTIVITY_TYPES.filter((t) => LIABILITY_LEDGER_MAPPING[t] !== null);
    expect(Object.keys(sqlMapping).sort()).toEqual([...mappable].sort());
    expect(mappable).toHaveLength(8);
    expect(LIABILITY_LEDGER_MAPPING.ADJUSTMENT).toBeNull();
    expect(LIABILITY_LEDGER_MAPPING.OTHER).toBeNull();
  });

  it.each(LIABILITY_ACTIVITY_TYPES.filter((t) => LIABILITY_LEDGER_MAPPING[t] !== null))('%s: SQL == LIABILITY_LEDGER_MAPPING == classifyStatementActivity', (t) => {
    expect(sqlMapping[t]).toEqual(LIABILITY_LEDGER_MAPPING[t]);
    expect(LIABILITY_LEDGER_MAPPING[t]!.economicType).toBe(classifyStatementActivity(t));
  });

  it('ADJUSTMENT and OTHER classify as unknown, which the Apply never writes (BLOCKING_REVIEW or recorded as not counted)', () => {
    expect(classifyStatementActivity('ADJUSTMENT')).toBe('unknown');
    expect(classifyStatementActivity('OTHER')).toBe('unknown');
    expect(SQL).toContain("when a.activity_type in ('ADJUSTMENT', 'OTHER') and not coalesce(p_acknowledge_unclassified, false) then 'unclassified_line'");
    expect(SQL).toContain("set ledger_disposition = 'excluded_unclassified'");
  });

  it('a PAYMENT is never an expense and a drawdown is never income (the two controls the PO scrutinises most)', () => {
    expect(sqlMapping.PAYMENT.economicType).toBe('transfer');
    expect(sqlMapping.LOAN_ADVANCE.economicType).not.toBe('income');
    expect(Object.values(sqlMapping).some((m) => m.economicType === 'income')).toBe(false);
  });

  it('card oracle through the plan: purchases 200 + 20, repayment 220 -> expense 220, never 440', () => {
    const plan = planCardStatementLedgerWrites([
      { activityId: 'a', activityType: 'PURCHASE', amount: 200 },
      { activityId: 'b', activityType: 'PURCHASE', amount: 20 },
      { activityId: 'c', activityType: 'PAYMENT', amount: 220, matchedBankTransactionId: 'bank' },
    ]);
    expect(totalExpenseFromPlan(plan, 'AUD', [{ economicType: sqlMapping.PAYMENT.economicType as never, amount: 220 }])).toBe(220);
  });

  it('ANTI-VACUITY: a mutated SQL mapping (PAYMENT -> expense) is detected', () => {
    const mutated = parseSqlMapping(SQL.replace("when 'PAYMENT' then 'transfer'", "when 'PAYMENT' then 'expense'"));
    expect(mutated.PAYMENT.economicType).toBe('expense');
    expect(mutated.PAYMENT).not.toEqual(LIABILITY_LEDGER_MAPPING.PAYMENT);
  });
});

describe('the SQL allocation rule equals decomposeLoanPayment', () => {
  // The SQL (0209) inserts, in this order and only when > 0: principal as
  // debt_principal, interest as debt_interest, fee as fee -- and only for a
  // PAYMENT whose disclosed components sum exactly to the amount (the blocker
  // refuses component_mismatch; no component -> no split).
  function sqlRule(amount: number, p?: number, i?: number, f?: number) {
    const disclosed = p !== undefined || i !== undefined || f !== undefined;
    if (!disclosed) return { outcome: 'insufficient_evidence', allocations: [] as { economicType: string; amount: number }[] };
    if ((p ?? 0) + (i ?? 0) + (f ?? 0) !== amount) return { outcome: 'component_mismatch', allocations: [] };
    const allocations = [
      ...((p ?? 0) > 0 ? [{ economicType: 'debt_principal', amount: p! }] : []),
      ...((i ?? 0) > 0 ? [{ economicType: 'debt_interest', amount: i! }] : []),
      ...((f ?? 0) > 0 ? [{ economicType: 'fee', amount: f! }] : []),
    ];
    return { outcome: 'decomposed', allocations };
  }

  it('the SQL source really encodes that order and those guards', () => {
    const body = /-- A PAYMENT with disclosed components[\s\S]*?v_allocations := v_allocations \+ v_seq;/.exec(SQL)?.[0] ?? '';
    const order = [...body.matchAll(/values \(p_user, v_txn, v_seq, '([a-z_]+)'/g)].map((m) => m[1]);
    expect(order).toEqual(['debt_principal', 'debt_interest', 'fee']);
    expect(body).toContain('if coalesce(v_act.principal_component, 0) > 0 then');
    expect(SQL).toContain("then 'component_mismatch'");
  });

  it.each([
    [2000, 1550, 430, 20],
    [1000, 1000, undefined, undefined],
    [500, 0, 480, 20],
    [300, undefined, 300, undefined],
    [2000, 1500, 430, undefined],
    [700, undefined, undefined, undefined],
  ])('payment %s = %s / %s / %s', (amount, p, i, f) => {
    const certified = decomposeLoanPayment({ totalPayment: amount, principalComponent: p, interestComponent: i, feeComponent: f, currencyCode: 'AUD' });
    const sql = sqlRule(amount, p, i, f);
    expect(sql.outcome).toBe(certified.outcome);
    expect(sql.allocations).toEqual(certified.allocations);
  });

  it('the brief oracle: 2,000 -> principal 1,550 (liability) + cost of debt 450; never 2,000 or 2,450 expense', () => {
    const d = decomposeLoanPayment({ totalPayment: 2000, principalComponent: 1550, interestComponent: 430, feeComponent: 20, currencyCode: 'AUD' });
    expect(d.liabilityReductionTotal).toBe(1550);
    expect(d.expenseTotal).toBe(450);
    expect(d.allocations.reduce((s, a) => s + a.amount, 0)).toBe(2000);
  });
});
