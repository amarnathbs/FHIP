// Document2 (4) WP-J -- a configurable LARGE synthetic CAMS consolidated statement (many funds, many folios, long history), in the same
// structural shape as buildWphCas (which has one or two folios). Every value is invented. Deterministic: the same options give the
// same text, so a before/after oracle can compare runs.
//
// "Position" = one (folio, scheme) pair, the unit the Investment Intelligence pipeline reconciles and certifies.

export interface WpjPosition {
  folio: string;
  amc: string;
  scheme: string;
  isin: string;
  /** Closing unit balance as printed (3 decimals). */
  closingUnits: string;
  closingValue: string;
  txnCount: number;
}

export interface WpjCasOptions {
  positions: number;
  txnsPerPosition: number;
  /** Positions that share one folio number (several schemes under one folio, as a real CAS does). Default 2. */
  positionsPerFolio?: number;
  /** Digits that make folios, ISINs and scheme names unique to one run (so a run can never match a real instrument). Default "000001". */
  stamp?: string;
  periodStart?: string;
  periodEnd?: string;
  holderName?: string;
  /** Extra purchase lines appended to the LAST position only (an "extended" copy), each dated after the previous closing date. */
  extraTxnsOnLastPosition?: number;
}

export interface WpjCas {
  text: string;
  lines: string[];
  positions: WpjPosition[];
  totalTransactions: number;
  /** Folios the statement prints (distinct). */
  folios: string[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const AMCS = [
  'Prime Mutual Fund', 'Zenith Mutual Fund', 'Orbit Mutual Fund', 'Vertex Mutual Fund', 'Harbor Mutual Fund', 'Summit Mutual Fund',
  'Lotus Mutual Fund', 'Cedar Mutual Fund', 'Falcon Mutual Fund', 'Meridian Mutual Fund', 'Pioneer Mutual Fund', 'Banyan Mutual Fund',
];

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0');
}
function fmtDate(year: number, monthIdx: number, day: number): string {
  return `${pad(day, 2)}-${MONTHS[monthIdx]}-${year}`;
}
function money(scaled100: number): string {
  const s = (scaled100 / 100).toFixed(2);
  const [i, d] = s.split('.');
  return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${d}`;
}
function units3(scaled1000: number): string {
  return (scaled1000 / 1000).toFixed(3);
}

export function buildWpjLargeCas(opts: WpjCasOptions): WpjCas {
  const perFolio = opts.positionsPerFolio ?? 2;
  const stamp = (opts.stamp ?? '000001').replace(/[^0-9]/g, '0').padStart(6, '0').slice(-6);
  const stampLetters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K'].map((l, i) => (i < 10 ? l : l));
  const stamp3 = [Number(stamp.slice(0, 2)) % 10, Number(stamp.slice(2, 4)) % 10, Number(stamp.slice(4, 6)) % 10].map((d) => stampLetters[d]).join('');
  const holder = opts.holderName ?? 'Asha Rao';
  const lines: string[] = [
    'CAMS Consolidated Account Statement',
    `Statement Period : ${opts.periodStart ?? '01-Jan-2015'} To ${opts.periodEnd ?? '30-Sep-2026'}`,
    '',
  ];
  const positions: WpjPosition[] = [];
  const folios = new Set<string>();
  let totalTransactions = 0;
  for (let i = 0; i < opts.positions; i++) {
    const folioIdx = Math.floor(i / perFolio);
    const folio = `7${stamp}${pad(folioIdx, 4)}`;
    folios.add(folio);
    const amc = AMCS[folioIdx % AMCS.length];
    const scheme = `WPJ ${stamp} Fund ${pad(i, 4)} - Growth (Direct Plan)`;
    const isin = `INF${stamp3}${pad(i, 5)}1`;
    const isLast = i === opts.positions - 1;
    const txnCount = opts.txnsPerPosition + (isLast ? opts.extraTxnsOnLastPosition ?? 0 : 0);
    const price0 = 50 + (i % 7);
    let balance = 0; // scaled 1000
    let lastYear = 2015;
    let lastMonth = 0;
    const txnLines: string[] = [];
    for (let t = 0; t < txnCount; t++) {
      // one purchase a month starting January 2015, (i % 12) months of offset so positions do not all share a date
      const monthsFromStart = t + (i % 12);
      const year = 2015 + Math.floor(monthsFromStart / 12);
      const monthIdx = monthsFromStart % 12;
      lastYear = year;
      lastMonth = monthIdx;
      const units = 10 * (1 + (t % 5)) * 1000; // scaled 1000
      const price = price0 + (t % 3); // whole rupees
      const amount = Math.round((units / 1000) * price * 100); // scaled 100
      balance += units;
      txnLines.push(
        `${fmtDate(year, monthIdx, 10)}   ${money(amount)}         ${price.toFixed(4)}      ${units3(units)}     Purchase                             ${units3(balance)}   [Ref: WPJ-${stamp}-${pad(i, 4)}-${pad(t, 3)}]`,
      );
    }
    totalTransactions += txnCount;
    const closingNav = price0 + 3;
    const closingValueScaled100 = Math.round((balance / 1000) * closingNav * 100);
    const closingDate = fmtDate(lastYear, lastMonth, 28);
    positions.push({ folio, amc, scheme, isin, closingUnits: units3(balance), closingValue: money(closingValueScaled100), txnCount });
    lines.push(
      `Folio No: ${folio}`,
      'PAN: AAAAA1111A',
      `Name: ${holder}`,
      '',
      amc,
      `${scheme} - ISIN: ${isin}(Advisor: ARN00001) Registrar : CAMS`,
      '',
      'Date          Amount           Price        Units       Transaction Type                    Unit Balance',
      ...txnLines,
      '',
      `Closing Unit Balance as on ${closingDate} : ${units3(balance)} Units   Valuation : Rs. ${money(closingValueScaled100)}   NAV as on ${closingDate} : Rs. ${closingNav.toFixed(2)}`,
      '',
    );
  }
  return { text: lines.join('\n'), lines, positions, totalTransactions, folios: [...folios] };
}

/** Splits text lines into PDF pages of about `perPage` lines (the minimal PDF builder draws each page from a line array). */
export function paginateLines(lines: string[], perPage = 58): string[][] {
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  return pages.length > 0 ? pages : [['']];
}
