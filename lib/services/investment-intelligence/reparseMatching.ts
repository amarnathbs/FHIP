// Investment Intelligence -- matching a re-read statement to the rows the SAME statement already wrote (Document2 (4) WP-H3, 25-10-2026).
//
// THE DEFECT (found on production after a replacement copy was reprocessed). A transaction is recognised as already recorded only by its
// fingerprint, a hash over source, account, fund, date, type, amount, UNITS, NAV and source reference. Real CAS lines carry no reference,
// and the fingerprint includes exactly the fields a parser fix legitimately corrects (units, NAV, type). Re-reading the same document with
// a corrected parser therefore produced a different fingerprint for the same real transaction, nothing matched, and a second copy was
// inserted next to the first (plus a second source link). The unique index on source_reference cannot help: it only covers rows that have one.
//
// THE RULE. Within ONE document, a re-read line that matches no fingerprint is looked up by its natural key: (account, fund, date, signed
// amount). Each stored row can be claimed by at most one re-read line (a multiset match, so two genuine same-day same-amount lines stay two).
//   * same economics (type, units, NAV)            -> it is the same row: link, insert nothing.
//   * a row a person corrected or settled          -> the person's decision stands: link, insert nothing.
//   * system-read row whose details the corrected  -> the corrected line REPLACES it: a new row (status `corrected`,
//     parse now reads differently                     `corrects_transaction_id` = the old row) and the old row becomes `reversed`
//                                                     (the existing soft, audited, reversible exclusion every ledger reader honours).
// A line with no stored twin is genuinely new and is inserted as before. Cross-document matching is unchanged (cross-source identity).

export interface StoredDocTransaction {
  id: string;
  account_id: string;
  instrument_id: string;
  transaction_date: string;
  gross_amount: number | string;
  transaction_type: string;
  units: number | string | null;
  price_per_unit: number | string | null;
  status: string;
  transaction_fingerprint: string | null;
  corrects_transaction_id?: string | null;
}

/** Statuses that are in the figures today. `reversed` is already out of them and is never matched. */
export const COUNTED_TRANSACTION_STATUSES = new Set(['parsed', 'reconciled', 'corrected']);

const money = (v: number | string): string => Number(v).toFixed(2);
const sixDp = (v: number | string | null): string | null => (v === null || v === undefined ? null : Number(v).toFixed(6));

export function naturalKey(accountId: string, instrumentId: string, dateIso: string, amount: number | string): string {
  return `${accountId}|${instrumentId}|${dateIso}|${money(amount)}`;
}

export interface ReReadLine {
  accountId: string;
  instrumentId: string;
  dateIso: string;
  amount: string; // 2 dp decimal string
  type: string;
  units: string | null;
  navPerUnit: string | null;
}

/** True when the stored row already says exactly what the re-read line says. */
export function sameEconomics(stored: Pick<StoredDocTransaction, 'transaction_type' | 'units' | 'price_per_unit'>, line: Pick<ReReadLine, 'type' | 'units' | 'navPerUnit'>): boolean {
  return stored.transaction_type === line.type && sixDp(stored.units) === sixDp(line.units) && sixDp(stored.price_per_unit) === sixDp(line.navPerUnit);
}

export type ReReadDecision =
  | { kind: 'link_existing'; existingId: string; reason: 'same_economics' | 'person_decision_stands' }
  | { kind: 'supersede'; existingId: string; changed: string[] }
  | { kind: 'insert_new' };

export class NaturalKeyPool {
  private readonly pool = new Map<string, StoredDocTransaction[]>();

  /** `claimedIds` = rows already matched exactly by fingerprint in this run; they can never be matched again. */
  constructor(rows: readonly StoredDocTransaction[], claimedIds: ReadonlySet<string>) {
    for (const r of rows) {
      if (!COUNTED_TRANSACTION_STATUSES.has(r.status) || claimedIds.has(r.id)) continue;
      const key = naturalKey(r.account_id, r.instrument_id, r.transaction_date, r.gross_amount);
      const list = this.pool.get(key) ?? [];
      list.push(r);
      this.pool.set(key, list);
    }
    // deterministic: oldest id first, so the same input always pairs the same way
    for (const list of this.pool.values()) list.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Claims and returns the stored twin of a re-read line, or null. */
  take(line: ReReadLine): StoredDocTransaction | null {
    const list = this.pool.get(naturalKey(line.accountId, line.instrumentId, line.dateIso, line.amount));
    return list && list.length > 0 ? (list.shift() as StoredDocTransaction) : null;
  }

  get unclaimedCount(): number {
    let n = 0;
    for (const l of this.pool.values()) n += l.length;
    return n;
  }
}

export function decideReRead(stored: StoredDocTransaction, line: ReReadLine, personSettledIds: ReadonlySet<string>): ReReadDecision {
  if (sameEconomics(stored, line)) return { kind: 'link_existing', existingId: stored.id, reason: 'same_economics' };
  // Only a row the system alone wrote may be replaced. Anything a person touched, or that is already a correction, stands.
  if (personSettledIds.has(stored.id) || stored.status !== 'parsed') return { kind: 'link_existing', existingId: stored.id, reason: 'person_decision_stands' };
  const changed: string[] = [];
  if (stored.transaction_type !== line.type) changed.push('type');
  if (sixDp(stored.units) !== sixDp(line.units)) changed.push('units');
  if (sixDp(stored.price_per_unit) !== sixDp(line.navPerUnit)) changed.push('price');
  return { kind: 'supersede', existingId: stored.id, changed };
}
