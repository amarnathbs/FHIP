// R6-FINAL live-DEV dispatch — real defect found and fixed: every disposal
// persistence attempt for ii_capital_gains_computations was silently
// failing a not-null foreign key against ii_tax_lots (which nothing ever
// populated). Confirmed live in DEV (see
// docs/investment-intelligence/R6_FINAL_LIVE_DEV_VERIFICATION.md,
// LIVE-R6-001-DB), fixed in taxRepository.ts via persistTaxLots() +
// deterministicLotId(). This test certifies deterministicLotId's pure
// properties hermetically (no live DEV, no I/O).

import { describe, it, expect } from 'vitest';
import { deterministicLotId } from '@/lib/services/investment-intelligence/taxRepository';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('deterministicLotId', () => {
  it('produces a syntactically valid RFC 4122 v5 UUID', () => {
    expect(deterministicLotId('lot:some-transaction-id')).toMatch(UUID_RE);
  });

  it('is deterministic: the SAME lot key always produces the SAME id (idempotency, Section 43)', () => {
    const a = deterministicLotId('lot:txn-abc-123');
    const b = deterministicLotId('lot:txn-abc-123');
    expect(a).toBe(b);
  });

  it('different lot keys produce different ids (no collision for distinct transactions)', () => {
    const a = deterministicLotId('lot:txn-1');
    const b = deterministicLotId('lot:txn-2');
    expect(a).not.toBe(b);
  });

  it('is sensitive to the full key, not just a prefix (two ids that share a prefix are still distinct)', () => {
    const a = deterministicLotId('lot:txn-100');
    const b = deterministicLotId('lot:txn-1000');
    expect(a).not.toBe(b);
  });
});
