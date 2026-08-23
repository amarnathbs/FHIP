import { withRunningBalance, pan } from './fixtureHelpers.mjs';

function mk(id, title, periodStart, periodEnd, folios, notes) {
  return { id, title, periodStart, periodEnd, folios, notes };
}

// --- 1. Source detection, single folio, single AMC, single scheme, regular/growth, lumpsum ---
const k1 = (() => {
  const { transactions, closingUnits } = withRunningBalance(0, [
    { date: '2025-02-03', description: 'Purchase - Lumpsum', expectedType: 'purchase', amount: 20000, units: 143.68, nav: 139.22, ref: 'KTXN0001', indianFormat: true },
  ]);
  return mk('kfin-source-detection-basic', 'Source detection, single folio, single AMC, single scheme, regular plan, growth, lumpsum purchase', '2025-01-01', '2025-06-30', [
    {
      folioNumber: '7654321/00',
      pan: pan(101),
      name: 'ANIL KUMAR',
      holdingMode: 'Single',
      schemes: [
        {
          amc: 'SBI Mutual Fund',
          schemeName: 'SBI Bluechip Fund - Growth (Regular Plan)',
          isin: 'INF200K01UP0',
          amfiCode: '103504',
          transactions,
          closing: { asOf: '2025-06-30', units: closingUnits, value: 22164.66, nav: 154.3, indianFormat: true },
        },
      ],
    },
  ]);
})();

// --- 2. Multi-scheme, single folio, multi-AMC ---
const k2 = (() => {
  const t1 = withRunningBalance(0, [{ date: '2025-01-12', description: 'Purchase - Lumpsum', expectedType: 'purchase', amount: 18000, units: 66.42, nav: 271.0, ref: 'KTXN0101' }]);
  const t2 = withRunningBalance(0, [{ date: '2025-01-18', description: 'Purchase - Lumpsum', expectedType: 'purchase', amount: 22000, units: 183.6, nav: 119.83, ref: 'KTXN0102' }]);
  return mk('kfin-multi-scheme-single-folio', 'Single folio holding schemes from two different AMCs', '2025-01-01', '2025-06-30', [
    {
      folioNumber: '7654322/00',
      pan: pan(102),
      name: 'SUNITA RAO',
      holdingMode: 'Single',
      schemes: [
        {
          amc: 'SBI Mutual Fund',
          schemeName: 'SBI Bluechip Fund - Growth (Regular Plan)',
          isin: 'INF200K01UP0',
          amfiCode: '103504',
          transactions: t1.transactions,
          closing: { asOf: '2025-06-30', units: t1.closingUnits, value: 20500.5, nav: 308.6 },
        },
        {
          amc: 'HDFC Mutual Fund',
          schemeName: 'HDFC Flexi Cap Fund - Growth (Regular Plan)',
          isin: 'INF179K01YX6',
          amfiCode: '118835',
          transactions: t2.transactions,
          closing: { asOf: '2025-06-30', units: t2.closingUnits, value: 24100.7, nav: 131.3 },
        },
      ],
    },
  ]);
})();

// --- 3. Multiple folios ---
const k3 = (() => {
  const t1 = withRunningBalance(0, [{ date: '2025-02-08', description: 'Purchase - Lumpsum', expectedType: 'purchase', amount: 8000, units: 66.8, nav: 119.76, ref: 'KTXN0201' }]);
  const t2 = withRunningBalance(0, [{ date: '2025-03-08', description: 'Purchase - Lumpsum', expectedType: 'purchase', amount: 9000, units: 32.6, nav: 276.07, ref: 'KTXN0202' }]);
  return mk('kfin-multi-folio', 'Two independent folios for the same investor', '2025-01-01', '2025-06-30', [
    {
      folioNumber: '7654323/00',
      pan: pan(103),
      name: 'RAVI KRISHNAN',
      holdingMode: 'Single',
      schemes: [
        {
          amc: 'HDFC Mutual Fund',
          schemeName: 'HDFC Flexi Cap Fund - Growth (Regular Plan)',
          isin: 'INF179K01YX6',
          amfiCode: '118835',
          transactions: t1.transactions,
          closing: { asOf: '2025-06-30', units: t1.closingUnits, value: 8800.5, nav: 131.7 },
        },
      ],
    },
    {
      folioNumber: '7654324/00',
      pan: pan(103),
      name: 'RAVI KRISHNAN',
      holdingMode: 'Single',
      schemes: [
        {
          amc: 'SBI Mutual Fund',
          schemeName: 'SBI Bluechip Fund - Growth (Regular Plan)',
          isin: 'INF200K01UP0',
          amfiCode: '103504',
          transactions: t2.transactions,
          closing: { asOf: '2025-06-30', units: t2.closingUnits, value: 10050.2, nav: 308.6 },
        },
      ],
    },
  ]);
})();

// --- 4. SIP history ---
const k4 = (() => {
  const dates = ['2025-01-07', '2025-02-07', '2025-03-07', '2025-04-07', '2025-05-07', '2025-06-07'];
  const navs = [271.0, 268.4, 275.9, 280.1, 285.55, 290.12];
  const raw = dates.map((date, i) => ({ date, description: 'SIP Instalment', expectedType: 'sip', amount: 4000, units: Math.round((4000 / navs[i]) * 1000) / 1000, nav: navs[i], ref: `KSIP000${i + 1}` }));
  const { transactions, closingUnits } = withRunningBalance(0, raw);
  return mk('kfin-sip-history', 'Six-month SIP purchase history, single scheme', '2025-01-01', '2025-06-30', [
    {
      folioNumber: '7654325/00',
      pan: pan(104),
      name: 'MANOJ TIWARI',
      holdingMode: 'Single',
      schemes: [
        {
          amc: 'SBI Mutual Fund',
          schemeName: 'SBI Bluechip Fund - Growth (Regular Plan)',
          isin: 'INF200K01UP0',
          amfiCode: '103504',
          transactions,
          closing: { asOf: '2025-06-30', units: closingUnits, value: Math.round(closingUnits * 290.12 * 100) / 100, nav: 290.12 },
        },
      ],
    },
  ]);
})();

// --- 5. Redemption ---
const k5 = (() => {
  const { transactions, closingUnits } = withRunningBalance(250, [
    { date: '2025-05-02', description: 'Redemption - Normal', expectedType: 'redemption', amount: 6000, units: 43.62, nav: 137.55, ref: 'KRED0001' },
  ]);
  return mk('kfin-redemption', 'Partial redemption reducing a pre-existing holding', '2025-01-01', '2025-06-30', [
    {
      folioNumber: '7654326/00',
      pan: pan(105),
      name: 'GEETA SHARMA',
      holdingMode: 'Single',
      schemes: [
        {
          amc: 'HDFC Mutual Fund',
          schemeName: 'HDFC Flexi Cap Fund - Growth (Regular Plan)',
          isin: 'INF179K01YX6',
          amfiCode: '118835',
          transactions,
          closing: { asOf: '2025-06-30', units: closingUnits, value: Math.round(closingUnits * 131.7 * 100) / 100, nav: 131.7 },
        },
      ],
    },
  ]);
})();

// --- 6. Switch pair ---
const k6 = (() => {
  const out1 = withRunningBalance(80, [{ date: '2025-04-11', description: 'Switch Out To Nippon India Small Cap Fund', expectedType: 'switch_out', amount: 9000, units: 68.35, nav: 131.68, ref: 'KSW0001OUT' }]);
  const in1 = withRunningBalance(0, [{ date: '2025-04-11', description: 'Switch In From HDFC Flexi Cap Fund', expectedType: 'switch_in', amount: 9000, units: 77.86, nav: 115.6, ref: 'KSW0001IN' }]);
  return mk('kfin-switch-pair', 'Switch-out of one scheme paired with switch-in to another, same folio/date', '2025-01-01', '2025-06-30', [
    {
      folioNumber: '7654327/00',
      pan: pan(106),
      name: 'AMIT SINGH',
      holdingMode: 'Single',
      schemes: [
        {
          amc: 'HDFC Mutual Fund',
          schemeName: 'HDFC Flexi Cap Fund - Growth (Regular Plan)',
          isin: 'INF179K01YX6',
          amfiCode: '118835',
          transactions: out1.transactions,
          closing: { asOf: '2025-06-30', units: out1.closingUnits, value: Math.round(out1.closingUnits * 131.7 * 100) / 100, nav: 131.7 },
        },
        {
          amc: 'Nippon India Mutual Fund',
          schemeName: 'Nippon India Small Cap Fund - Growth (Regular Plan)',
          isin: 'INF204K01UP8',
          amfiCode: '118779',
          transactions: in1.transactions,
          closing: { asOf: '2025-06-30', units: in1.closingUnits, value: Math.round(in1.closingUnits * 112.4 * 100) / 100, nav: 112.4 },
        },
      ],
    },
  ]);
})();

// --- 7. IDCW dividend + reinvestment (also the rule-precedence adversarial case: description contains BOTH "dividend" and "reinvest") ---
const k7 = (() => {
  const { transactions, closingUnits } = withRunningBalance(400, [
    { date: '2025-02-25', description: 'Dividend Payout', expectedType: 'dividend', amount: 600, units: 0, nav: 41.2, ref: 'KDIV0001' },
    { date: '2025-05-25', description: 'Dividend Reinvestment', expectedType: 'reinvestment', amount: 540, units: 12.1, nav: 44.63, ref: 'KDIV0002' },
  ]);
  return mk('kfin-idcw-dividend-and-reinvestment', 'IDCW dividend payout (no unit impact) and dividend reinvestment (unit impact) — rule-precedence case', '2025-01-01', '2025-06-30', [
    {
      folioNumber: '7654328/00',
      pan: pan(107),
      name: 'POOJA MENON',
      holdingMode: 'Single',
      schemes: [
        {
          amc: 'Kotak Mutual Fund',
          schemeName: 'Kotak Emerging Equity Fund - IDCW (Regular Plan)',
          isin: 'INF174K01LT0',
          amfiCode: '112308',
          transactions,
          closing: { asOf: '2025-06-30', units: closingUnits, value: Math.round(closingUnits * 45.5 * 100) / 100, nav: 45.5 },
        },
      ],
    },
  ]);
})();

// --- 8. Direct vs Regular plan ---
const k8 = (() => {
  const d = withRunningBalance(0, [{ date: '2025-01-22', description: 'Purchase - Lumpsum', expectedType: 'purchase', amount: 15000, units: 111.6, nav: 134.4, ref: 'KDR0001D' }]);
  const r = withRunningBalance(0, [{ date: '2025-01-22', description: 'Purchase - Lumpsum', expectedType: 'purchase', amount: 15000, units: 107.85, nav: 139.08, ref: 'KDR0001R' }]);
  return mk('kfin-direct-vs-regular-plan', 'Direct-plan and Regular-plan variants of the same scheme, held as distinct instruments', '2025-01-01', '2025-06-30', [
    {
      folioNumber: '7654329/00',
      pan: pan(108),
      name: 'KIRAN BHAT',
      holdingMode: 'Single',
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

// --- 9. STP pair ---
const k9 = (() => {
  const out1 = withRunningBalance(200, [{ date: '2025-03-01', description: 'STP Out To Mirae Asset Large Cap Fund', expectedType: 'stp_out', amount: 4000, units: 29.11, nav: 137.4, ref: 'KSTP0001OUT' }]);
  const in1 = withRunningBalance(0, [{ date: '2025-03-01', description: 'STP In From SBI Bluechip Fund', expectedType: 'stp_in', amount: 4000, units: 25.6, nav: 156.25, ref: 'KSTP0001IN' }]);
  return mk('kfin-stp-pair', 'Systematic Transfer Plan out of one scheme into another', '2025-01-01', '2025-06-30', [
    {
      folioNumber: '7654330/00',
      pan: pan(109),
      name: 'DIVYA NAIDU',
      holdingMode: 'Single',
      schemes: [
        {
          amc: 'SBI Mutual Fund',
          schemeName: 'SBI Bluechip Fund - Growth (Regular Plan)',
          isin: 'INF200K01UP0',
          amfiCode: '103504',
          transactions: out1.transactions,
          closing: { asOf: '2025-06-30', units: out1.closingUnits, value: Math.round(out1.closingUnits * 308.6 * 100) / 100, nav: 308.6 },
        },
        {
          amc: 'Mirae Asset Mutual Fund',
          schemeName: 'Mirae Asset Large Cap Fund - Growth (Regular Plan)',
          isin: 'INF769K01AY9',
          amfiCode: '118826',
          transactions: in1.transactions,
          closing: { asOf: '2025-06-30', units: in1.closingUnits, value: Math.round(in1.closingUnits * 152.3 * 100) / 100, nav: 152.3 },
        },
      ],
    },
  ]);
})();

// --- 10. SWP ---
const k10 = (() => {
  const dates = ['2025-02-15', '2025-03-15', '2025-04-15'];
  const raw = dates.map((date, i) => ({ date, description: 'SWP Instalment', expectedType: 'swp', amount: 3000, units: 10.9 + i * 0.15, nav: 275 - i * 2, ref: `KSWP000${i + 1}` }));
  const { transactions, closingUnits } = withRunningBalance(400, raw);
  return mk('kfin-swp', 'Systematic Withdrawal Plan, three monthly instalments', '2025-01-01', '2025-06-30', [
    {
      folioNumber: '7654331/00',
      pan: pan(110),
      name: 'ARUN NAIR',
      holdingMode: 'Single',
      schemes: [
        {
          amc: 'HDFC Mutual Fund',
          schemeName: 'HDFC Flexi Cap Fund - Growth (Regular Plan)',
          isin: 'INF179K01YX6',
          amfiCode: '118835',
          transactions,
          closing: { asOf: '2025-06-30', units: closingUnits, value: Math.round(closingUnits * 131.7 * 100) / 100, nav: 131.7 },
        },
      ],
    },
  ]);
})();

// --- 11. Fractional units + large Indian-formatted values ---
const k11 = (() => {
  const { transactions, closingUnits } = withRunningBalance(0, [
    { date: '2025-01-14', description: 'Purchase - Lumpsum', expectedType: 'purchase', amount: 2000000, units: 6482.315, nav: 308.512, ref: 'KLG0001', indianFormat: true },
    { date: '2025-04-14', description: 'Purchase - Lumpsum', expectedType: 'purchase', amount: 1560000.75, units: 4890.221, nav: 318.99, ref: 'KLG0002', indianFormat: true },
  ]);
  return mk('kfin-fractional-units-large-values', 'Large Indian-comma-formatted amounts with fractional (3-decimal) units', '2025-01-01', '2025-06-30', [
    {
      folioNumber: '7654332/00',
      pan: pan(111),
      name: 'VARUN MALHOTRA',
      holdingMode: 'Single',
      schemes: [
        {
          amc: 'SBI Mutual Fund',
          schemeName: 'SBI Bluechip Fund - Growth (Regular Plan)',
          isin: 'INF200K01UP0',
          amfiCode: '103504',
          transactions,
          closing: { asOf: '2025-06-30', units: closingUnits, value: Math.round(closingUnits * 330.4 * 100) / 100, nav: 330.4, indianFormat: true },
        },
      ],
    },
  ]);
})();

// --- 12. Reversal + partial history ---
const k12 = (() => {
  const { transactions, closingUnits } = withRunningBalance(60, [
    { date: '2025-03-18', description: 'Purchase - Lumpsum', expectedType: 'purchase', amount: 4000, units: 29.4, nav: 136.05, ref: 'KREV0001' },
    { date: '2025-03-20', description: 'Purchase Reversed', expectedType: 'reversal', amount: 4000, units: 29.4, nav: 136.05, ref: 'KREV0002' },
  ]);
  return mk('kfin-reversal-partial-history', 'A purchase reversed two days later; statement opens with a pre-existing balance not explained within it (partial history)', '2025-03-01', '2025-06-30', [
    {
      folioNumber: '7654333/00',
      pan: pan(112),
      name: 'SHWETA AGARWAL',
      holdingMode: 'Single',
      schemes: [
        {
          amc: 'HDFC Mutual Fund',
          schemeName: 'HDFC Flexi Cap Fund - Growth (Regular Plan)',
          isin: 'INF179K01YX6',
          amfiCode: '118835',
          transactions,
          closing: { asOf: '2025-06-30', units: closingUnits, value: Math.round(closingUnits * 131.7 * 100) / 100, nav: 131.7 },
        },
      ],
    },
  ]);
})();

// --- 13. Certified, complete-from-inception, multi-page-length transaction list ---
const k13 = (() => {
  const dates = ['2025-01-06', '2025-01-21', '2025-02-06', '2025-02-21', '2025-03-06', '2025-03-21', '2025-04-06', '2025-04-21', '2025-05-06', '2025-05-21', '2025-06-06', '2025-06-21'];
  const raw = dates.map((date, i) => ({
    date,
    description: i % 2 === 0 ? 'SIP Instalment' : 'Purchase - Lumpsum',
    expectedType: i % 2 === 0 ? 'sip' : 'purchase',
    amount: 3500,
    units: Math.round((3500 / (270 + i * 2)) * 1000) / 1000,
    nav: 270 + i * 2,
    ref: `KMP${String(i + 1).padStart(4, '0')}`,
  }));
  const { transactions, closingUnits } = withRunningBalance(0, raw);
  return mk('kfin-certified-multi-page', 'Complete-from-inception history, twelve transactions (multiple transaction pages), reconciling exactly', '2025-01-01', '2025-06-30', [
    {
      folioNumber: '7654334/00',
      pan: pan(113),
      name: 'NIKHIL DESHPANDE',
      holdingMode: 'Single',
      schemes: [
        {
          amc: 'SBI Mutual Fund',
          schemeName: 'SBI Bluechip Fund - Growth (Regular Plan)',
          isin: 'INF200K01UP0',
          amfiCode: '103504',
          transactions,
          closing: { asOf: '2025-06-30', units: closingUnits, value: Math.round(closingUnits * 294 * 100) / 100, nav: 294 },
        },
      ],
    },
  ]);
})();

// --- 14/15. Overlapping-period statement pair for incremental-import/dedup tests ---
const k14 = (() => {
  const { transactions, closingUnits } = withRunningBalance(0, [
    { date: '2025-01-11', description: 'Purchase - Lumpsum', expectedType: 'purchase', amount: 12000, units: 44.28, nav: 271.0, ref: 'KOVL0001' },
    { date: '2025-02-11', description: 'SIP Instalment', expectedType: 'sip', amount: 4000, units: 14.7, nav: 272.1, ref: 'KOVL0002' },
    { date: '2025-03-11', description: 'SIP Instalment', expectedType: 'sip', amount: 4000, units: 14.5, nav: 275.86, ref: 'KOVL0003' },
  ]);
  return mk('kfin-overlap-jan-mar', 'Statement 1 of an incremental-import pair: Jan-Mar', '2025-01-01', '2025-03-31', [
    {
      folioNumber: '7654335/00',
      pan: pan(114),
      name: 'HARSH VARDHAN',
      holdingMode: 'Single',
      schemes: [
        {
          amc: 'SBI Mutual Fund',
          schemeName: 'SBI Bluechip Fund - Growth (Regular Plan)',
          isin: 'INF200K01UP0',
          amfiCode: '103504',
          transactions,
          closing: { asOf: '2025-03-31', units: closingUnits, value: Math.round(closingUnits * 275.86 * 100) / 100, nav: 275.86 },
        },
      ],
    },
  ]);
})();

const k15 = (() => {
  const { transactions, closingUnits } = withRunningBalance(0, [
    { date: '2025-01-11', description: 'Purchase - Lumpsum', expectedType: 'purchase', amount: 12000, units: 44.28, nav: 271.0, ref: 'KOVL0001' },
    { date: '2025-02-11', description: 'SIP Instalment', expectedType: 'sip', amount: 4000, units: 14.7, nav: 272.1, ref: 'KOVL0002' },
    { date: '2025-03-11', description: 'SIP Instalment', expectedType: 'sip', amount: 4000, units: 14.5, nav: 275.86, ref: 'KOVL0003' },
    { date: '2025-04-11', description: 'SIP Instalment', expectedType: 'sip', amount: 4000, units: 14.2, nav: 281.69, ref: 'KOVL0004' },
    { date: '2025-05-11', description: 'SIP Instalment', expectedType: 'sip', amount: 4000, units: 13.9, nav: 287.77, ref: 'KOVL0005' },
    { date: '2025-06-11', description: 'SIP Instalment', expectedType: 'sip', amount: 4000, units: 13.6, nav: 294.12, ref: 'KOVL0006' },
  ]);
  return mk('kfin-overlap-jan-jun', 'Statement 2 of an incremental-import pair: cumulative Jan-Jun (Jan-Mar transactions repeated + Apr-Jun new)', '2025-01-01', '2025-06-30', [
    {
      folioNumber: '7654335/00',
      pan: pan(114),
      name: 'HARSH VARDHAN',
      holdingMode: 'Single',
      schemes: [
        {
          amc: 'SBI Mutual Fund',
          schemeName: 'SBI Bluechip Fund - Growth (Regular Plan)',
          isin: 'INF200K01UP0',
          amfiCode: '103504',
          transactions,
          closing: { asOf: '2025-06-30', units: closingUnits, value: Math.round(closingUnits * 294.12 * 100) / 100, nav: 294.12 },
        },
      ],
    },
  ]);
})();

export const KFIN_SCENARIOS = [k1, k2, k3, k4, k5, k6, k7, k8, k9, k10, k11, k12, k13, k14, k15];
