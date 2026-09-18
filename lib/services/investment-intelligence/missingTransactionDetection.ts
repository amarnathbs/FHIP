// Investment Intelligence — incremental statement upload (task 2026-09-17).
//
// Detects previously-recorded transactions that a NEW statement's own
// coverage window should have re-confirmed but didn't. Extracted out of
// documentProcessing.ts's processSourceDocument() (step 6.5) into its own
// module so this logic is directly unit-testable with a fake admin client,
// rather than only reachable through the full parse/resolve/certify
// pipeline.
//
// ii_transactions is append-only/immutable by design (0033's header
// comment) — a "missing" transaction found here is NEVER deleted or
// updated. It is surfaced as an explicit 'transaction_missing_from_
// restatement' reconciliation case via the caller-supplied
// `openReconciliationCase`, the same "flag for a human, never
// auto-resolve" convention this codebase already uses for every other kind
// of discrepancy (ambiguous_instrument, transaction_unclassified, etc).
//
// Scope is deliberately conservative (see the task's own final report for
// why this is the safe choice rather than a guess): only positions the new
// statement actually PRINTS A HOLDING LINE FOR are checked — that reliably
// means "this statement covers this position as of its own as-of date",
// the same signal documentProcessing.ts's own evaluatePositionAndCertify()
// already treats as authoritative. A position with zero transactions in a
// period is not, by itself, evidence of anything missing. And only when
// the statement declares an explicit coverage period is any comparison
// attempted at all — without a stated window there is no honest way to
// tell "genuinely no activity" apart from "this document simply doesn't
// cover that far back".

export interface CoveredPosition {
  accountId: string;
  instrumentId: string;
}

export interface PriorTransactionRow {
  id: string;
  transaction_date: string;
  transaction_fingerprint: string;
  source_description: string | null;
  gross_amount: number;
}

/** The narrow slice of a Supabase admin client this module needs — enough
 * to unit test against a fake without pulling in the full client type. */
export interface MissingTransactionQueryClient {
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: unknown): {
        eq(col: string, val: unknown): {
          eq(col: string, val: unknown): {
            neq(col: string, val: unknown): {
              neq(col: string, val: unknown): {
                gte(col: string, val: unknown): {
                  lte(col: string, val: unknown): PromiseLike<{ data: PriorTransactionRow[] | null; error: { message: string } | null }>;
                };
              };
            };
          };
        };
      };
    };
  };
}

export interface MissingTransactionCase {
  accountId: string;
  instrumentId: string;
  missing: PriorTransactionRow[];
}

/**
 * Given the positions this new statement covers (from its own printed
 * holding lines) and the set of transaction fingerprints this run's OWN
 * parsed transactions confirmed per position, finds every previously
 * recorded, non-reversed transaction dated within the statement's coverage
 * period whose fingerprint was NOT re-confirmed. Pure with respect to the
 * caller-supplied query client — issues reads only, never a write.
 */
export async function detectMissingTransactions(
  admin: MissingTransactionQueryClient,
  userId: string,
  sourceDocumentId: string,
  coveredPositions: CoveredPosition[],
  confirmedFingerprintsByPosition: Map<string, Set<string>>,
  periodStartIso: string | null,
  periodEndIso: string | null
): Promise<MissingTransactionCase[]> {
  if (!periodStartIso || !periodEndIso) return [];

  const results: MissingTransactionCase[] = [];
  for (const { accountId, instrumentId } of coveredPositions) {
    const confirmed = confirmedFingerprintsByPosition.get(`${accountId}:${instrumentId}`) ?? new Set<string>();

    const { data: priorTxns } = await admin
      .from('ii_transactions')
      .select('id, transaction_date, transaction_fingerprint, source_description, gross_amount')
      .eq('user_id', userId)
      .eq('account_id', accountId)
      .eq('instrument_id', instrumentId)
      .neq('source_document_id', sourceDocumentId)
      .neq('status', 'reversed')
      .gte('transaction_date', periodStartIso)
      .lte('transaction_date', periodEndIso);

    const missing = (priorTxns ?? []).filter((row) => !confirmed.has(row.transaction_fingerprint));
    if (missing.length > 0) results.push({ accountId, instrumentId, missing });
  }
  return results;
}
