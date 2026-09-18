// Investment Intelligence — Performance tab Holdings drilldown (2026-09-17).
//
// Unit coverage for transactionLedger.ts's running-balance recomputation and
// XIRR cash-flow assembly. Verifies the two "reuse, don't reinvent" claims
// the module's own header comment makes:
//   1. Unit-balance sign follows reconciliation.ts's unitDeltaForTransaction
//      exactly (a purchase adds units, a redemption subtracts, matching the
//      SAME rule the certified reconciliation engine uses).
//   2. XIRR cash-flow sign follows analyticsRepository.ts's own
//      OUTFLOW_TYPES/INFLOW_TYPES classification (purchase = negative,
//      redemption = positive), and the resulting XIRR is computed by the
//      real xirr() engine, not a re-derivation.
import { describe, it, expect } from 'vitest';
import { buildTransactionLedger, XIRR_METHODOLOGY_NOTE } from '@/lib/services/investment-intelligence/transactionLedger';
import { makeFakeSupabase } from './support/fakeSupabaseClient';

const USER_ID = 'user-1';
const ACCOUNT_ID = 'account-1';
const INSTRUMENT_ID = 'instrument-1';

function baseTables(overrides: { transactions?: Record<string, unknown>[]; snapshot?: Record<string, unknown> | null } = {}) {
  return {
    ii_accounts: [{ id: ACCOUNT_ID, user_id: USER_ID, folio_number: 'FOLIO-001', currency_code: 'INR' }],
    ii_instruments: [{ id: INSTRUMENT_ID, instrument_name: 'Test Flexi Cap Fund' }],
    ii_transactions:
      overrides.transactions ?? [
        {
          id: 'txn-1',
          user_id: USER_ID,
          account_id: ACCOUNT_ID,
          instrument_id: INSTRUMENT_ID,
          transaction_type: 'purchase',
          transaction_date: '2020-01-01',
          gross_amount: 10000,
          units: 500,
          price_per_unit: 20,
          source_description: 'Purchase',
          status: 'parsed',
        },
        {
          id: 'txn-2',
          user_id: USER_ID,
          account_id: ACCOUNT_ID,
          instrument_id: INSTRUMENT_ID,
          transaction_type: 'redemption',
          transaction_date: '2021-01-01',
          gross_amount: 6000,
          units: 200,
          price_per_unit: 30,
          source_description: 'Redemption',
          status: 'parsed',
        },
      ],
    ii_holding_snapshots:
      overrides.snapshot === undefined
        ? [{ user_id: USER_ID, account_id: ACCOUNT_ID, instrument_id: INSTRUMENT_ID, as_of_date: '2022-01-01', units: 300, value: 12000 }]
        : overrides.snapshot
          ? [overrides.snapshot]
          : [],
  };
}

describe('buildTransactionLedger — running balance', () => {
  it('accumulates units per unitDeltaForTransaction sign convention: purchase adds, redemption subtracts', async () => {
    const { client } = makeFakeSupabase(baseTables());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ledger = await buildTransactionLedger(client as any, USER_ID, ACCOUNT_ID, INSTRUMENT_ID);
    expect(ledger).not.toBeNull();
    expect(ledger!.rows).toHaveLength(2);
    expect(ledger!.rows[0].unitBalanceAfter).toBeCloseTo(500, 6); // purchase: 0 + 500
    expect(ledger!.rows[1].unitBalanceAfter).toBeCloseTo(300, 6); // redemption: 500 - 200
  });

  it('assigns XIRR cash-flow sign per analyticsRepository convention: purchase negative, redemption positive', async () => {
    const { client } = makeFakeSupabase(baseTables());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ledger = await buildTransactionLedger(client as any, USER_ID, ACCOUNT_ID, INSTRUMENT_ID);
    expect(ledger!.rows[0].xirrCashFlow).toBe(-10000);
    expect(ledger!.rows[1].xirrCashFlow).toBe(6000);
  });

  it('appends a positive terminal "Closing market value" row from the latest holding snapshot', async () => {
    const { client } = makeFakeSupabase(baseTables());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ledger = await buildTransactionLedger(client as any, USER_ID, ACCOUNT_ID, INSTRUMENT_ID);
    expect(ledger!.terminal).not.toBeNull();
    expect(ledger!.terminal!.description).toBe('Closing market value');
    expect(ledger!.terminal!.amount).toBe(12000);
    expect(ledger!.terminal!.date).toBe('2022-01-01');
  });

  it('computes a real XIRR from the assembled cash flows, in the shared CalculationOutcome shape the modal actually reads', async () => {
    // Regression test for a real bug found live: this used to assert
    // ledger.investorXirr.status === 'ok' (the raw xirr() engine's own
    // vocabulary) and ledger.investorXirr.rate directly — which passed here
    // but silently disagreed with TransactionDetailModal.tsx, which reads
    // the shared CalculationOutcome contract (status === 'CALCULATED',
    // value.rate) that every other calculated metric in this feature uses.
    // A real, successfully-computed XIRR (11.797%, reproduced from the
    // Product Owner's own real B92/Aditya Birla statement) showed
    // "XIRR: Not available" in production because of exactly this mismatch.
    const { client } = makeFakeSupabase(baseTables());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ledger = await buildTransactionLedger(client as any, USER_ID, ACCOUNT_ID, INSTRUMENT_ID);
    expect(ledger!.investorXirr.status).toBe('CALCULATED');
    expect(typeof ledger!.investorXirr.value?.rate).toBe('number');
  });

  it('excludes reversed/review_required rows from the XIRR cash-flow list but still shows them in the ledger', async () => {
    const transactions = [
      ...baseTables().ii_transactions,
      {
        id: 'txn-3',
        user_id: USER_ID,
        account_id: ACCOUNT_ID,
        instrument_id: INSTRUMENT_ID,
        transaction_type: 'purchase',
        transaction_date: '2021-06-01',
        gross_amount: 1000,
        units: 40,
        price_per_unit: 25,
        source_description: 'Disputed duplicate purchase',
        status: 'review_required',
      },
    ];
    const { client } = makeFakeSupabase(baseTables({ transactions }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ledger = await buildTransactionLedger(client as any, USER_ID, ACCOUNT_ID, INSTRUMENT_ID);
    expect(ledger!.rows).toHaveLength(3);
    const disputed = ledger!.rows.find((r) => r.transactionId === 'txn-3')!;
    expect(disputed.excludedFromXirr).toBe(true);
    expect(disputed.xirrCashFlow).toBeNull();
    // Running balance still includes it (append-only ledger — never hidden from the balance itself).
    expect(disputed.unitBalanceAfter).toBeCloseTo(340, 6); // 300 (post-redemption) + 40
  });

  it('returns null for an account/instrument pair that does not belong to this user', async () => {
    const { client } = makeFakeSupabase(baseTables());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ledger = await buildTransactionLedger(client as any, 'someone-else', ACCOUNT_ID, INSTRUMENT_ID);
    expect(ledger).toBeNull();
  });

  it('exposes the exact Notes-tab XIRR methodology wording', async () => {
    const { client } = makeFakeSupabase(baseTables());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ledger = await buildTransactionLedger(client as any, USER_ID, ACCOUNT_ID, INSTRUMENT_ID);
    expect(ledger!.methodologyNote).toBe(XIRR_METHODOLOGY_NOTE);
  });
});
