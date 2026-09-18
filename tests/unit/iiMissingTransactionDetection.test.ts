// Investment Intelligence — incremental statement upload (task 2026-09-17).
//
// Unit coverage for missingTransactionDetection.ts, using two synthetic
// statements for the same synthetic account: an "old" statement (already
// on file) and a "new" statement that is a superset/update of it, per the
// task's own verification requirement. Exercises duplicate (re-confirmed),
// new (this run's own), and missing (previously recorded, not re-confirmed)
// classification.
import { describe, it, expect } from 'vitest';
import { detectMissingTransactions, type MissingTransactionQueryClient, type PriorTransactionRow } from '@/lib/services/investment-intelligence/missingTransactionDetection';

const USER_ID = 'user-1';
const ACCOUNT_ID = 'account-1';
const INSTRUMENT_ID = 'instrument-1';
const NEW_SOURCE_DOC_ID = 'doc-new';

/** Minimal query-chain fake matching MissingTransactionQueryClient exactly —
 * deliberately narrower than the shared fakeSupabaseClient.ts double, since
 * this module's whole point is to depend on nothing but this narrow read
 * shape. */
function makeFakeAdmin(rows: PriorTransactionRow[]): MissingTransactionQueryClient {
  return {
    from(_table: string) {
      return {
        select(_cols: string) {
          let excludeSourceDoc: string | null = null;
          let excludeStatus: string | null = null;
          let gte: string | null = null;
          let lte: string | null = null;
          const chain = {
            eq(_c1: string, _v1: unknown) {
              return {
                eq(_c2: string, _v2: unknown) {
                  return {
                    eq(_c3: string, _v3: unknown) {
                      return {
                        neq(_c4: string, v4: unknown) {
                          excludeSourceDoc = v4 as string;
                          return {
                            neq(_c5: string, v5: unknown) {
                              excludeStatus = v5 as string;
                              return {
                                gte(_c6: string, v6: unknown) {
                                  gte = v6 as string;
                                  return {
                                    lte(_c7: string, v7: unknown) {
                                      lte = v7 as string;
                                      const filtered = rows.filter((r) => {
                                        const row = r as unknown as Record<string, unknown>;
                                        if (excludeSourceDoc && row.source_document_id === excludeSourceDoc) return false;
                                        if (excludeStatus && row.status === excludeStatus) return false;
                                        if (gte && r.transaction_date < gte) return false;
                                        if (lte && r.transaction_date > lte) return false;
                                        return true;
                                      });
                                      return Promise.resolve({ data: filtered, error: null });
                                    },
                                  };
                                },
                              };
                            },
                          };
                        },
                      };
                    },
                  };
                },
              };
            },
          };
          return chain;
        },
      };
    },
  };
}

function row(id: string, date: string, fingerprint: string, sourceDocumentId: string, status = 'parsed'): PriorTransactionRow & { source_document_id: string; status: string } {
  return {
    id,
    transaction_date: date,
    transaction_fingerprint: fingerprint,
    source_description: `txn ${id}`,
    gross_amount: 1000,
    source_document_id: sourceDocumentId,
    status,
  };
}

describe('detectMissingTransactions', () => {
  it('returns nothing when the statement has no declared coverage period', async () => {
    const admin = makeFakeAdmin([row('t1', '2021-01-01', 'fp-1', 'doc-old')]);
    const result = await detectMissingTransactions(
      admin,
      USER_ID,
      NEW_SOURCE_DOC_ID,
      [{ accountId: ACCOUNT_ID, instrumentId: INSTRUMENT_ID }],
      new Map(),
      null,
      null
    );
    expect(result).toEqual([]);
  });

  it('flags a previously-recorded transaction in-period whose fingerprint the new statement never re-confirmed', async () => {
    // Old statement recorded fp-1 (Jan) and fp-2 (Feb). New statement's own
    // parsed transactions this run only re-confirm fp-1 — fp-2 genuinely
    // vanished from the new statement's coverage.
    const admin = makeFakeAdmin([row('t1', '2021-01-15', 'fp-1', 'doc-old'), row('t2', '2021-02-15', 'fp-2', 'doc-old')]);
    const confirmed = new Map([[`${ACCOUNT_ID}:${INSTRUMENT_ID}`, new Set(['fp-1'])]]);
    const result = await detectMissingTransactions(
      admin,
      USER_ID,
      NEW_SOURCE_DOC_ID,
      [{ accountId: ACCOUNT_ID, instrumentId: INSTRUMENT_ID }],
      confirmed,
      '2021-01-01',
      '2021-03-01'
    );
    expect(result).toHaveLength(1);
    expect(result[0].missing.map((m) => m.id)).toEqual(['t2']);
  });

  it('does not flag anything when every prior in-period transaction was re-confirmed (pure superset re-upload)', async () => {
    const admin = makeFakeAdmin([row('t1', '2021-01-15', 'fp-1', 'doc-old'), row('t2', '2021-02-15', 'fp-2', 'doc-old')]);
    const confirmed = new Map([[`${ACCOUNT_ID}:${INSTRUMENT_ID}`, new Set(['fp-1', 'fp-2', 'fp-3-new'])]]);
    const result = await detectMissingTransactions(
      admin,
      USER_ID,
      NEW_SOURCE_DOC_ID,
      [{ accountId: ACCOUNT_ID, instrumentId: INSTRUMENT_ID }],
      confirmed,
      '2021-01-01',
      '2021-03-01'
    );
    expect(result).toEqual([]);
  });

  it('never considers a transaction from THIS SAME new document as missing (excluded by source_document_id)', async () => {
    // A row already attributed to the new document (e.g. from a retried
    // partial write) must never be flagged as "missing from" itself.
    const admin = makeFakeAdmin([row('t1', '2021-01-15', 'fp-1', NEW_SOURCE_DOC_ID)]);
    const result = await detectMissingTransactions(
      admin,
      USER_ID,
      NEW_SOURCE_DOC_ID,
      [{ accountId: ACCOUNT_ID, instrumentId: INSTRUMENT_ID }],
      new Map(),
      '2021-01-01',
      '2021-03-01'
    );
    expect(result).toEqual([]);
  });

  it('never considers an already-reversed transaction as missing', async () => {
    const admin = makeFakeAdmin([row('t1', '2021-01-15', 'fp-1', 'doc-old', 'reversed')]);
    const result = await detectMissingTransactions(
      admin,
      USER_ID,
      NEW_SOURCE_DOC_ID,
      [{ accountId: ACCOUNT_ID, instrumentId: INSTRUMENT_ID }],
      new Map(),
      '2021-01-01',
      '2021-03-01'
    );
    expect(result).toEqual([]);
  });

  it('ignores a prior transaction dated outside the new statement\'s coverage period', async () => {
    const admin = makeFakeAdmin([row('t1', '2019-01-15', 'fp-1', 'doc-old')]); // long before this statement's period
    const result = await detectMissingTransactions(
      admin,
      USER_ID,
      NEW_SOURCE_DOC_ID,
      [{ accountId: ACCOUNT_ID, instrumentId: INSTRUMENT_ID }],
      new Map(),
      '2021-01-01',
      '2021-03-01'
    );
    expect(result).toEqual([]);
  });
});
