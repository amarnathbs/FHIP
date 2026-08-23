import { withRunningBalance, pan } from './fixtureHelpers.mjs';

function mk(id, title, periodStart, periodEnd, folios, notes) {
  return { id, title, periodStart, periodEnd, folios, notes };
}

// --- 1. Source detection, single folio, single AMC, single scheme, direct/growth, lumpsum purchase ---
const s1 = (() => {
  const { transactions, closingUnits } = withRunningBalance(0, [
    { date: '2025-02-01', description: 'Purchase', expectedType: 'purchase', amount: 10000, units: 83.5, nav: 119.7605, ref: 'TXN0001', indianFormat: true },
  ]);
  return mk('cams-source-detection-basic', 'Source detection, single folio, single AMC, single scheme, direct plan, growth, lumpsum purchase', '2025-01-01', '2025-06-30', [
    {
      folioNumber: '1201040000123',
      pan: pan(1),
      name: 'RAHUL SHARMA',
      holdingMode: 'SI',
      schemes: [
        {
          amc: 'HDFC Mutual Fund',
          schemeName: 'HDFC Flexi Cap Fund - Growth (Direct Plan)',
          isin: 'INF179K01YW8',
          amfiCode: '118834',
          transactions,
          closing: { asOf: '2025-06-30', units: closingUnits, value: 11264.15, nav: 134.9, indianFormat: true },
        },
      ],
    },
  ]);
})();

// --- 2. Multi-scheme, single folio, multi-AMC ---
const s2 = (() => {
  const t1 = withRunningBalance(0, [{ date: '2025-01-10', description: 'Purchase', expectedType: 'purchase', amount: 20000, units: 166.94, nav: 119.79, ref: 'TXN0101' }]);
  const t2 = withRunningBalance(0, [{ date: '2025-01-15', description: 'Purchase', expectedType: 'purchase', amount: 15000, units: 62.1, nav: 241.55, ref: 'TXN0102' }]);
  return mk('cams-multi-scheme-single-folio', 'Single folio holding schemes from two different AMCs', '2025-01-01', '2025-06-30', [
    {
      folioNumber: '1201040000200',
      pan: pan(2),
      name: 'PRIYA NAIR',
      holdingMode: 'SI',
      schemes: [
        {
          amc: 'HDFC Mutual Fund',
          schemeName: 'HDFC Flexi Cap Fund - Growth (Direct Plan)',
          isin: 'INF179K01YW8',
          amfiCode: '118834',
          transactions: t1.transactions,
          closing: { asOf: '2025-06-30', units: t1.closingUnits, value: 22500.9, nav: 134.8 },
        },
        {
          amc: 'SBI Mutual Fund',
          schemeName: 'SBI Bluechip Fund - Growth (Regular Plan)',
          isin: 'INF200K01UP0',
          amfiCode: '103504',
          transactions: t2.transactions,
          closing: { asOf: '2025-06-30', units: t2.closingUnits, value: 16400.3, nav: 264.1 },
        },
      ],
    },
  ]);
})();

// --- 3. Multiple folios (same investor, two folios) ---
const s3 = (() => {
  const t1 = withRunningBalance(0, [{ date: '2025-02-05', description: 'Purchase', expectedType: 'purchase', amount: 5000, units: 41.75, nav: 119.76, ref: 'TXN0201' }]);
  const t2 = withRunningBalance(0, [{ date: '2025-03-05', description: 'Purchase', expectedType: 'purchase', amount: 12000, units: 45.4, nav: 264.32, ref: 'TXN0202' }]);
  return mk('cams-multi-folio', 'Two independent folios for the same investor', '2025-01-01', '2025-06-30', [
    {
      folioNumber: '1201040000301',
      pan: pan(3),
      name: 'ANITA DESAI',
      holdingMode: 'SI',
      schemes: [
        {
          amc: 'HDFC Mutual Fund',
          schemeName: 'HDFC Flexi Cap Fund - Growth (Direct Plan)',
          isin: 'INF179K01YW8',
          amfiCode: '118834',
          transactions: t1.transactions,
          closing: { asOf: '2025-06-30', units: t1.closingUnits, value: 5628.0, nav: 134.8 },
        },
      ],
    },
    {
      folioNumber: '1201040000302',
      pan: pan(3),
      name: 'ANITA DESAI',
      holdingMode: 'SI',
      schemes: [
        {
          amc: 'SBI Mutual Fund',
          schemeName: 'SBI Bluechip Fund - Growth (Regular Plan)',
          isin: 'INF200K01UP0',
          amfiCode: '103504',
          transactions: t2.transactions,
          closing: { asOf: '2025-06-30', units: t2.closingUnits, value: 11989.0, nav: 264.1 },
        },
      ],
    },
  ]);
})();

// --- 4. SIP history (6 monthly instalments) ---
const s4 = (() => {
  const months = ['2025-01-05', '2025-02-05', '2025-03-05', '2025-04-05', '2025-05-05', '2025-06-05'];
  const navs = [119.76, 120.5, 118.9, 122.3, 125.1, 124.63];
  const raw = months.map((date, i) => ({ date, description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: Math.round((5000 / navs[i]) * 1000) / 1000, nav: navs[i], ref: `SIP000${i + 1}` }));
  const { transactions, closingUnits } = withRunningBalance(0, raw);
  return mk('cams-sip-history', 'Six-month SIP purchase history, single scheme', '2025-01-01', '2025-06-30', [
    {
      folioNumber: '1201040000400',
      pan: pan(4),
      name: 'VIKRAM RAO',
      holdingMode: 'SI',
      schemes: [
        {
          amc: 'Axis Mutual Fund',
          schemeName: 'Axis Small Cap Fund - Growth (Direct Plan)',
          isin: 'INF846K01EW2',
          amfiCode: '135944',
          transactions,
          closing: { asOf: '2025-06-30', units: closingUnits, value: Math.round(closingUnits * 124.63 * 100) / 100, nav: 124.63 },
        },
      ],
    },
  ]);
})();

// --- 5. Redemption (partial) ---
const s5 = (() => {
  const { transactions, closingUnits } = withRunningBalance(200, [
    { date: '2025-04-15', description: 'Redemption', expectedType: 'redemption', amount: 5000, units: 38.109, nav: 131.2, ref: 'RED0001' },
  ]);
  return mk('cams-redemption', 'Partial redemption reducing a pre-existing holding', '2025-01-01', '2025-06-30', [
    {
      folioNumber: '1201040000500',
      pan: pan(5),
      name: 'SUNIL MEHTA',
      holdingMode: 'SI',
      schemes: [
        {
          amc: 'HDFC Mutual Fund',
          schemeName: 'HDFC Flexi Cap Fund - Growth (Direct Plan)',
          isin: 'INF179K01YW8',
          amfiCode: '118834',
          transactions,
          closing: { asOf: '2025-06-30', units: closingUnits, value: Math.round(closingUnits * 134.9 * 100) / 100, nav: 134.9 },
        },
      ],
    },
  ]);
})();

// --- 6. Switch pair (switch-out of one scheme, switch-in to another, same folio, same day) ---
const s6 = (() => {
  const out1 = withRunningBalance(100, [{ date: '2025-03-10', description: 'Switch Out To SBI Bluechip Fund', expectedType: 'switch_out', amount: 12000, units: 89.66, nav: 133.83, ref: 'SW0001OUT' }]);
  const in1 = withRunningBalance(0, [{ date: '2025-03-10', description: 'Switch In From HDFC Flexi Cap Fund', expectedType: 'switch_in', amount: 12000, units: 45.4, nav: 264.32, ref: 'SW0001IN' }]);
  return mk('cams-switch-pair', 'Switch-out of one scheme paired with switch-in to another, same folio/date', '2025-01-01', '2025-06-30', [
    {
      folioNumber: '1201040000600',
      pan: pan(6),
      name: 'DEEPA IYER',
      holdingMode: 'SI',
      schemes: [
        {
          amc: 'HDFC Mutual Fund',
          schemeName: 'HDFC Flexi Cap Fund - Growth (Direct Plan)',
          isin: 'INF179K01YW8',
          amfiCode: '118834',
          transactions: out1.transactions,
          closing: { asOf: '2025-06-30', units: out1.closingUnits, value: Math.round(out1.closingUnits * 134.9 * 100) / 100, nav: 134.9 },
        },
        {
          amc: 'SBI Mutual Fund',
          schemeName: 'SBI Bluechip Fund - Growth (Regular Plan)',
          isin: 'INF200K01UP0',
          amfiCode: '103504',
          transactions: in1.transactions,
          closing: { asOf: '2025-06-30', units: in1.closingUnits, value: Math.round(in1.closingUnits * 264.1 * 100) / 100, nav: 264.1 },
        },
      ],
    },
  ]);
})();

// --- 7. IDCW dividend (payout, no unit impact) + IDCW reinvestment (unit impact) ---
const s7 = (() => {
  const { transactions, closingUnits } = withRunningBalance(500, [
    { date: '2025-02-20', description: 'IDCW Payout', expectedType: 'dividend', amount: 750, units: 0, nav: 45.2, ref: 'DIV0001' },
    { date: '2025-05-20', description: 'IDCW Reinvestment', expectedType: 'reinvestment', amount: 620, units: 13.5, nav: 45.93, ref: 'DIV0002' },
  ]);
  // dividend payout row prints units as 0 (cash-only, no unit column value) — expected parser treats units=0 (a real zero, not null, since our CAS grammar always requires 4 numeric columns).
  return mk('cams-idcw-dividend-and-reinvestment', 'IDCW dividend payout (no unit impact) and IDCW reinvestment (unit impact)', '2025-01-01', '2025-06-30', [
    {
      folioNumber: '1201040000700',
      pan: pan(7),
      name: 'KAVYA REDDY',
      holdingMode: 'SI',
      schemes: [
        {
          amc: 'Kotak Mutual Fund',
          schemeName: 'Kotak Emerging Equity Fund - IDCW (Regular Plan)',
          isin: 'INF174K01LS2',
          amfiCode: '112307',
          transactions,
          closing: { asOf: '2025-06-30', units: closingUnits, value: Math.round(closingUnits * 46.1 * 100) / 100, nav: 46.1 },
        },
      ],
    },
  ]);
})();

// --- 8. Direct vs Regular plan — two DISTINCT instrument rows for conceptually the same underlying fund ---
const s8 = (() => {
  const d = withRunningBalance(0, [{ date: '2025-01-20', description: 'Purchase', expectedType: 'purchase', amount: 10000, units: 74.4, nav: 134.4, ref: 'DR0001D' }]);
  const r = withRunningBalance(0, [{ date: '2025-01-20', description: 'Purchase', expectedType: 'purchase', amount: 10000, units: 71.9, nav: 139.08, ref: 'DR0001R' }]);
  return mk('cams-direct-vs-regular-plan', 'Direct-plan and Regular-plan variants of the same scheme, held as distinct instruments', '2025-01-01', '2025-06-30', [
    {
      folioNumber: '1201040000800',
      pan: pan(8),
      name: 'ARJUN KAPOOR',
      holdingMode: 'SI',
      schemes: [
        {
          amc: 'ICICI Prudential Mutual Fund',
          schemeName: 'ICICI Prudential Nifty 50 Index Fund - Growth (Direct Plan)',
          isin: 'INF109K01VQ1',
          amfiCode: '120716',
          transactions: d.transactions,
          closing: { asOf: '2025-06-30', units: d.closingUnits, value: Math.round(d.closingUnits * 143.2 * 100) / 100, nav: 143.2 },
        },
        {
          amc: 'ICICI Prudential Mutual Fund',
          schemeName: 'ICICI Prudential Nifty 50 Index Fund - Growth (Regular Plan)',
          isin: 'INF109K01VR9',
          amfiCode: '120717',
          transactions: r.transactions,
          closing: { asOf: '2025-06-30', units: r.closingUnits, value: Math.round(r.closingUnits * 138.5 * 100) / 100, nav: 138.5 },
        },
      ],
    },
  ]);
})();

// --- 9. STP pair (STP-out of one scheme, STP-in to another) ---
const s9 = (() => {
  const out1 = withRunningBalance(150, [{ date: '2025-02-01', description: 'STP Out To Nippon India Small Cap Fund', expectedType: 'stp_out', amount: 3000, units: 22.42, nav: 133.83, ref: 'STP0001OUT' }]);
  const in1 = withRunningBalance(0, [{ date: '2025-02-01', description: 'STP In From HDFC Flexi Cap Fund', expectedType: 'stp_in', amount: 3000, units: 27.2, nav: 110.29, ref: 'STP0001IN' }]);
  return mk('cams-stp-pair', 'Systematic Transfer Plan out of one scheme into another', '2025-01-01', '2025-06-30', [
    {
      folioNumber: '1201040000900',
      pan: pan(9),
      name: 'MEERA PILLAI',
      holdingMode: 'SI',
      schemes: [
        {
          amc: 'HDFC Mutual Fund',
          schemeName: 'HDFC Flexi Cap Fund - Growth (Direct Plan)',
          isin: 'INF179K01YW8',
          amfiCode: '118834',
          transactions: out1.transactions,
          closing: { asOf: '2025-06-30', units: out1.closingUnits, value: Math.round(out1.closingUnits * 134.9 * 100) / 100, nav: 134.9 },
        },
        {
          amc: 'Nippon India Mutual Fund',
          schemeName: 'Nippon India Small Cap Fund - Growth (Direct Plan)',
          isin: 'INF204K01UN3',
          amfiCode: '118778',
          transactions: in1.transactions,
          closing: { asOf: '2025-06-30', units: in1.closingUnits, value: Math.round(in1.closingUnits * 115.6 * 100) / 100, nav: 115.6 },
        },
      ],
    },
  ]);
})();

// --- 10. SWP (systematic withdrawal, three instalments) ---
const s10 = (() => {
  const dates = ['2025-02-01', '2025-03-01', '2025-04-01'];
  const raw = dates.map((date, i) => ({ date, description: 'SWP Withdrawal', expectedType: 'swp', amount: 2000, units: 15.2 + i * 0.1, nav: 131.5 - i, ref: `SWP000${i + 1}` }));
  const { transactions, closingUnits } = withRunningBalance(300, raw);
  return mk('cams-swp', 'Systematic Withdrawal Plan, three monthly instalments', '2025-01-01', '2025-06-30', [
    {
      folioNumber: '1201040001000',
      pan: pan(10),
      name: 'ROHAN JOSHI',
      holdingMode: 'SI',
      schemes: [
        {
          amc: 'SBI Mutual Fund',
          schemeName: 'SBI Bluechip Fund - Growth (Regular Plan)',
          isin: 'INF200K01UP0',
          amfiCode: '103504',
          transactions,
          closing: { asOf: '2025-06-30', units: closingUnits, value: Math.round(closingUnits * 264.1 * 100) / 100, nav: 264.1 },
        },
      ],
    },
  ]);
})();

// --- 11. Fractional units + large Indian-comma-formatted values ---
const s11 = (() => {
  const { transactions, closingUnits } = withRunningBalance(0, [
    { date: '2025-01-08', description: 'Purchase', expectedType: 'purchase', amount: 1250000, units: 8734.567, nav: 143.129, ref: 'LG0001', indianFormat: true },
    { date: '2025-04-08', description: 'Purchase', expectedType: 'purchase', amount: 875000.5, units: 5678.912, nav: 154.111, ref: 'LG0002', indianFormat: true },
  ]);
  return mk('cams-fractional-units-large-values', 'Large Indian-comma-formatted amounts with fractional (3-decimal) units', '2025-01-01', '2025-06-30', [
    {
      folioNumber: '1201040001100',
      pan: pan(11),
      name: 'SANJAY GUPTA',
      holdingMode: 'SI',
      schemes: [
        {
          amc: 'Mirae Asset Mutual Fund',
          schemeName: 'Mirae Asset Large Cap Fund - Growth (Direct Plan)',
          isin: 'INF769K01AX1',
          amfiCode: '118825',
          transactions,
          closing: { asOf: '2025-06-30', units: closingUnits, value: Math.round(closingUnits * 160.5 * 100) / 100, nav: 160.5, indianFormat: true },
        },
      ],
    },
  ]);
})();

// --- 12. Reversal + partial history (no opening balance, mid-history statement) ---
const s12 = (() => {
  const { transactions, closingUnits } = withRunningBalance(120, [
    // opening 120 units is NOT explained by any transaction in this statement — this is the "partial history / missing opening" scenario
    { date: '2025-03-12', description: 'Purchase', expectedType: 'purchase', amount: 5000, units: 37.2, nav: 134.4, ref: 'REV0001' },
    { date: '2025-03-14', description: 'Purchase - Reversed', expectedType: 'reversal', amount: 5000, units: 37.2, nav: 134.4, ref: 'REV0002' },
  ]);
  return mk('cams-reversal-partial-history', 'A purchase reversed two days later; statement opens with a pre-existing balance not explained within it (partial history)', '2025-03-01', '2025-06-30', [
    {
      folioNumber: '1201040001200',
      pan: pan(12),
      name: 'NEHA VERMA',
      holdingMode: 'SI',
      schemes: [
        {
          amc: 'HDFC Mutual Fund',
          schemeName: 'HDFC Flexi Cap Fund - Growth (Direct Plan)',
          isin: 'INF179K01YW8',
          amfiCode: '118834',
          transactions,
          closing: { asOf: '2025-06-30', units: closingUnits, value: Math.round(closingUnits * 134.9 * 100) / 100, nav: 134.9 },
        },
      ],
    },
  ]);
})();

// --- 13. Certified, complete-from-inception, multi-page-length transaction list ---
const s13 = (() => {
  const dates = ['2025-01-05', '2025-01-20', '2025-02-05', '2025-02-20', '2025-03-05', '2025-03-20', '2025-04-05', '2025-04-20', '2025-05-05', '2025-05-20', '2025-06-05', '2025-06-20'];
  const raw = dates.map((date, i) => ({
    date,
    description: i % 2 === 0 ? 'SIP Purchase' : 'Purchase',
    expectedType: i % 2 === 0 ? 'sip' : 'purchase',
    amount: 3000,
    units: Math.round((3000 / (120 + i)) * 1000) / 1000,
    nav: 120 + i,
    ref: `MP${String(i + 1).padStart(4, '0')}`,
  }));
  const { transactions, closingUnits } = withRunningBalance(0, raw);
  return mk('cams-certified-multi-page', 'Complete-from-inception history, twelve transactions (multiple transaction pages), reconciling exactly', '2025-01-01', '2025-06-30', [
    {
      folioNumber: '1201040001300',
      pan: pan(13),
      name: 'ISHITA BOSE',
      holdingMode: 'SI',
      schemes: [
        {
          amc: 'Axis Mutual Fund',
          schemeName: 'Axis Small Cap Fund - Growth (Direct Plan)',
          isin: 'INF846K01EW2',
          amfiCode: '135944',
          transactions,
          closing: { asOf: '2025-06-30', units: closingUnits, value: Math.round(closingUnits * 131 * 100) / 100, nav: 131 },
        },
      ],
    },
  ]);
})();

// --- 14/15. Overlapping-period statement pair (Jan-Mar, then cumulative Jan-Jun) for incremental-import/dedup tests ---
const s14 = (() => {
  const { transactions, closingUnits } = withRunningBalance(0, [
    { date: '2025-01-10', description: 'Purchase', expectedType: 'purchase', amount: 10000, units: 83.5, nav: 119.76, ref: 'OVL0001' },
    { date: '2025-02-10', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 41.2, nav: 121.36, ref: 'OVL0002' },
    { date: '2025-03-10', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 40.5, nav: 123.46, ref: 'OVL0003' },
  ]);
  return mk('cams-overlap-jan-mar', 'Statement 1 of an incremental-import pair: Jan-Mar', '2025-01-01', '2025-03-31', [
    {
      folioNumber: '1201040001400',
      pan: pan(14),
      name: 'TARUN CHOPRA',
      holdingMode: 'SI',
      schemes: [
        {
          amc: 'HDFC Mutual Fund',
          schemeName: 'HDFC Flexi Cap Fund - Growth (Direct Plan)',
          isin: 'INF179K01YW8',
          amfiCode: '118834',
          transactions,
          closing: { asOf: '2025-03-31', units: closingUnits, value: Math.round(closingUnits * 123.9 * 100) / 100, nav: 123.9 },
        },
      ],
    },
  ]);
})();

const s15 = (() => {
  // Cumulative statement: same three Jan-Mar transactions (identical refs -> must dedup) PLUS three new Apr-Jun transactions.
  const { transactions, closingUnits } = withRunningBalance(0, [
    { date: '2025-01-10', description: 'Purchase', expectedType: 'purchase', amount: 10000, units: 83.5, nav: 119.76, ref: 'OVL0001' },
    { date: '2025-02-10', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 41.2, nav: 121.36, ref: 'OVL0002' },
    { date: '2025-03-10', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 40.5, nav: 123.46, ref: 'OVL0003' },
    { date: '2025-04-10', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 39.8, nav: 125.63, ref: 'OVL0004' },
    { date: '2025-05-10', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 38.9, nav: 128.53, ref: 'OVL0005' },
    { date: '2025-06-10', description: 'SIP Purchase', expectedType: 'sip', amount: 5000, units: 38.1, nav: 131.23, ref: 'OVL0006' },
  ]);
  return mk('cams-overlap-jan-jun', 'Statement 2 of an incremental-import pair: cumulative Jan-Jun (Jan-Mar transactions repeated + Apr-Jun new)', '2025-01-01', '2025-06-30', [
    {
      folioNumber: '1201040001400',
      pan: pan(14),
      name: 'TARUN CHOPRA',
      holdingMode: 'SI',
      schemes: [
        {
          amc: 'HDFC Mutual Fund',
          schemeName: 'HDFC Flexi Cap Fund - Growth (Direct Plan)',
          isin: 'INF179K01YW8',
          amfiCode: '118834',
          transactions,
          closing: { asOf: '2025-06-30', units: closingUnits, value: Math.round(closingUnits * 134.9 * 100) / 100, nav: 134.9 },
        },
      ],
    },
  ]);
})();

export const CAMS_SCENARIOS = [s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12, s13, s14, s15];
