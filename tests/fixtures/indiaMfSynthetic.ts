// SYNTHETIC household for the India Mutual Fund Investment Report — invented
// people, invented folios, invented NAVs. Used by the render check and the
// resolver tests; contains no real user data.
import type { IndiaMfReportInput, MfTransaction } from '@/lib/engines/investment-intelligence/indiaMfReport';

let n = 0;
function t(accountId: string, instrumentId: string, type: string, date: string, units: number | null, amount: number, extra: Partial<MfTransaction> = {}): MfTransaction {
  n += 1;
  return { id: `syn-${n}`, accountId, instrumentId, type, date, units, amount, pricePerUnit: units ? amount / units : null, status: 'parsed', sourceReference: null, ...extra };
}

export function syntheticIndiaMfInput(): IndiaMfReportInput {
  n = 0;
  const V = '2026-09-30';
  return {
    valuationDate: V,
    reportDate: V,
    accounts: [
      { id: 'a-self-1', folioNumber: '10234567/89', ownerMemberId: 'm-self', currencyCode: 'INR', countryCode: 'IN' },
      { id: 'a-self-2', folioNumber: '77012345', ownerMemberId: 'm-self', currencyCode: 'INR', countryCode: 'IN' },
      { id: 'a-joint', folioNumber: '5521009/01', ownerMemberId: 'm-self', currencyCode: 'INR', countryCode: 'IN' },
      { id: 'a-spouse', folioNumber: '3300871', ownerMemberId: 'm-spouse', currencyCode: 'INR', countryCode: 'IN' },
      { id: 'a-huf', folioNumber: '9081726', ownerMemberId: null, currencyCode: 'INR', countryCode: 'IN' },
      { id: 'a-none', folioNumber: '4410002', ownerMemberId: null, currencyCode: 'INR', countryCode: 'IN' },
    ],
    instruments: [
      { id: 'i-flexi', name: 'Sample Flexi Cap Fund - Direct Plan - Growth', isin: null, instrumentClass: 'mutual_fund' },
      { id: 'i-index', name: 'Sample Nifty 50 Index Fund - Direct Plan - Growth', isin: null, instrumentClass: 'mutual_fund' },
      { id: 'i-debt', name: 'Sample Short Duration Fund - Direct Plan - IDCW', isin: null, instrumentClass: 'mutual_fund' },
      { id: 'i-small', name: 'Sample Small Cap Fund - Regular Plan - Growth', isin: null, instrumentClass: 'mutual_fund' },
    ],
    transactions: [
      // Self, folio 1: complete history, SIP + lump sum + a switch out + dividend payout
      t('a-self-1', 'i-flexi', 'purchase', '2021-04-05', 1000, 100000),
      ...Array.from({ length: 12 }, (_, k) => t('a-self-1', 'i-flexi', 'sip', `2022-${String(k + 1).padStart(2, '0')}-05`, 50, 5500 + k * 40)),
      t('a-self-1', 'i-flexi', 'switch_out', '2024-06-10', 300, 52000),
      t('a-self-1', 'i-debt', 'switch_in', '2024-06-12', 4800, 51950),
      t('a-self-1', 'i-debt', 'dividend', '2025-03-28', null, 1800),
      // Self, folio 2: partial history (statement window opens with an opening balance), plus an SWP
      t('a-self-2', 'i-index', 'adjustment', '2023-04-01', 2500, 0, { sourceReference: 'OPENING_BALANCE' }),
      t('a-self-2', 'i-index', 'purchase', '2023-08-14', 400, 61000),
      t('a-self-2', 'i-index', 'swp', '2025-01-10', 60, 10800),
      t('a-self-2', 'i-index', 'swp', '2025-02-10', 55, 10100),
      // Joint folio 60/40 Self/Spouse
      t('a-joint', 'i-small', 'purchase', '2022-01-17', 2000, 100000),
      t('a-joint', 'i-small', 'bonus', '2024-02-12', 200, 0),
      // Spouse
      t('a-spouse', 'i-flexi', 'purchase', '2023-03-03', 600, 78000),
      t('a-spouse', 'i-flexi', 'redemption', '2025-12-01', 100, 17400),
      // HUF
      t('a-huf', 'i-index', 'purchase', '2020-07-20', 3000, 330000),
      t('a-huf', 'i-index', 'stp_out', '2024-09-02', 500, 90000),
      t('a-huf', 'i-debt', 'stp_in', '2024-09-04', 8600, 89900),
      // Folio with no owner at all
      t('a-none', 'i-flexi', 'purchase', '2024-11-11', 150, 24000),
    ],
    snapshots: [],
    navs: [
      { instrumentId: 'i-flexi', date: '2026-09-29', price: 188.4312 },
      { instrumentId: 'i-index', date: '2026-09-29', price: 212.0467 },
      { instrumentId: 'i-debt', date: '2026-09-29', price: 10.9341 },
      { instrumentId: 'i-small', date: '2026-09-29', price: 71.2208 },
    ],
    truth: [
      { accountId: 'a-self-2', instrumentId: 'i-index', status: 'certified_with_warnings', historyCompleteness: 'complete_from_known_opening_balance', unitVarianceWithinTolerance: true },
    ],
    allocations: [
      { accountId: 'a-joint', instrumentId: null, ownerMemberId: 'm-self', ownerEntityId: null, basisPoints: 6000, groupId: 'g-joint', status: 'active', effectiveFrom: null, effectiveTo: null },
      { accountId: 'a-joint', instrumentId: null, ownerMemberId: 'm-spouse', ownerEntityId: null, basisPoints: 4000, groupId: 'g-joint', status: 'active', effectiveFrom: null, effectiveTo: null },
      { accountId: 'a-huf', instrumentId: null, ownerMemberId: null, ownerEntityId: 'e-huf', basisPoints: 10000, groupId: 'g-huf', status: 'active', effectiveFrom: null, effectiveTo: null },
    ],
    members: [
      { id: 'm-self', fullName: 'Asha Rao', relationship: 'self' },
      { id: 'm-spouse', fullName: 'Ravi Rao', relationship: 'spouse' },
    ],
    entities: [{ id: 'e-huf', name: 'Rao Family HUF', entityType: 'huf' }],
    sensex: { date: '2026-09-30', value: 84021.5 },
    nifty: { date: '2026-09-30', value: 25760.35 },
  };
}
