// Document2 (4) WP-H3 -- the pure rules for matching a re-read line to the rows the same document already wrote (reparseMatching.ts).
import { describe, expect, it } from 'vitest';
import { NaturalKeyPool, decideReRead, naturalKey, sameEconomics, type ReReadLine, type StoredDocTransaction } from '@/lib/services/investment-intelligence/reparseMatching';

const row = (id: string, over: Partial<StoredDocTransaction> = {}): StoredDocTransaction => ({
  id,
  account_id: 'acc',
  instrument_id: 'ins',
  transaction_date: '2015-11-09',
  gross_amount: '1000.00',
  transaction_type: 'sip',
  units: '6.562000',
  price_per_unit: '152.389900',
  status: 'parsed',
  transaction_fingerprint: `fp-${id}`,
  ...over,
});
const line = (over: Partial<ReReadLine> = {}): ReReadLine => ({ accountId: 'acc', instrumentId: 'ins', dateIso: '2015-11-09', amount: '1000.00', type: 'sip', units: '6.562', navPerUnit: '152.3899', ...over });

describe('natural key', () => {
  it('is account, fund, date and amount to the paisa, whatever the representation', () => {
    expect(naturalKey('a', 'i', '2015-11-09', 1000)).toBe(naturalKey('a', 'i', '2015-11-09', '1000.00'));
    expect(naturalKey('a', 'i', '2015-11-09', 1000)).not.toBe(naturalKey('a', 'i', '2015-11-09', 1000.01));
    expect(naturalKey('a', 'i', '2015-11-09', 1000)).not.toBe(naturalKey('a', 'i', '2015-11-10', 1000));
    expect(naturalKey('a', 'i', '2015-11-09', 1000)).not.toBe(naturalKey('a', 'j', '2015-11-09', 1000));
    expect(naturalKey('a', 'i', '2015-11-09', 1000)).not.toBe(naturalKey('a', 'i', '2015-11-09', -1000)); // a purchase and its reversal are two lines
  });
});

describe('sameEconomics', () => {
  it('compares type, units and NAV at six decimals; null equals null only', () => {
    expect(sameEconomics(row('a'), line())).toBe(true);
    expect(sameEconomics(row('a'), line({ units: '66.562' }))).toBe(false);
    expect(sameEconomics(row('a'), line({ navPerUnit: '15.23899' }))).toBe(false);
    expect(sameEconomics(row('a'), line({ type: 'purchase' }))).toBe(false);
    expect(sameEconomics(row('a', { units: null, price_per_unit: null }), line({ units: null, navPerUnit: null }))).toBe(true);
    expect(sameEconomics(row('a', { units: null }), line())).toBe(false);
  });
});

describe('NaturalKeyPool', () => {
  it('pairs each line with at most one stored row (multiset): two stored + two re-read pair twice, a third re-read line finds nothing', () => {
    const pool = new NaturalKeyPool([row('b'), row('a')], new Set());
    expect(pool.take(line())?.id).toBe('a'); // deterministic: smallest id first
    expect(pool.take(line())?.id).toBe('b');
    expect(pool.take(line())).toBeNull();
  });
  it('NEGATIVE CONTROL: a row already matched exactly by fingerprint can never be claimed by another line', () => {
    const rows = [row('a'), row('b')];
    const pool = new NaturalKeyPool(rows, new Set(['a']));
    expect(pool.take(line())?.id).toBe('b'); // without the exclusion this would be 'a', the row another line owns
    expect(pool.take(line())).toBeNull();
    const broken = new NaturalKeyPool(rows, new Set());
    expect(broken.take(line())?.id).toBe('a'); // what the exclusion prevents
  });
  it('rows already reversed are never matched; a corrected row is', () => {
    const pool = new NaturalKeyPool([row('a', { status: 'reversed' }), row('b', { status: 'corrected' })], new Set());
    expect(pool.take(line())?.id).toBe('b');
    expect(pool.take(line())).toBeNull();
  });
  it('a different date, amount, fund or account finds nothing', () => {
    const pool = new NaturalKeyPool([row('a')], new Set());
    for (const other of [line({ dateIso: '2015-11-10' }), line({ amount: '1000.01' }), line({ instrumentId: 'x' }), line({ accountId: 'x' })]) expect(pool.take(other)).toBeNull();
    expect(pool.unclaimedCount).toBe(1);
  });
});

describe('decideReRead', () => {
  it('same details -> link, insert nothing', () => {
    expect(decideReRead(row('a'), line(), new Set())).toEqual({ kind: 'link_existing', existingId: 'a', reason: 'same_economics' });
  });
  it('a system row whose details a corrected parse changes -> replaced, naming what changed', () => {
    expect(decideReRead(row('a', { units: '65.62' }), line(), new Set())).toEqual({ kind: 'supersede', existingId: 'a', changed: ['units'] });
    expect(decideReRead(row('a', { transaction_type: 'purchase', price_per_unit: '1.0' }), line(), new Set())).toEqual({ kind: 'supersede', existingId: 'a', changed: ['type', 'price'] });
  });
  it("a person's decision stands: a row the person corrected, or that is not plainly parsed, is linked and never replaced", () => {
    expect(decideReRead(row('a', { units: '65.62' }), line(), new Set(['a']))).toMatchObject({ kind: 'link_existing', reason: 'person_decision_stands' });
    expect(decideReRead(row('a', { units: '65.62', status: 'reconciled' }), line(), new Set())).toMatchObject({ kind: 'link_existing', reason: 'person_decision_stands' });
    expect(decideReRead(row('a', { units: '65.62', status: 'corrected' }), line(), new Set())).toMatchObject({ kind: 'link_existing', reason: 'person_decision_stands' });
  });
});
