// NAV2 Stage 3: builds the SYNTHETIC genuine-format CAMS folio statements used by the journeys (the format the repo's own
// nav1-p4 fixture uses, parsed by the real camsFolioStatementParser). Every NAV is the real AMFI NAV stored on DEV for that date;
// the investor, PAN (never-real "PCQAL" prefix), folios and references are synthetic (prefix NAV2S3-). DEV read only.
//   npx tsx scripts/nav2_stage3/build_statements.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMinimalTextPdf } from '../../tests/support/buildMinimalPdf';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dmy = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return `${String(d).padStart(2, '0')}-${MONTHS[m - 1]}-${y}`; };
const fx = (v: number, dp: number) => v.toFixed(dp);
const inr = (v: number) => { const [i, f] = v.toFixed(2).split('.'); const l3 = i.slice(-3); const rest = i.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ','); return `${rest ? `${rest},` : ''}${l3}.${f}`; };
const r3 = (n: number) => Math.round(n * 1000) / 1000;

export interface FundDef { key: string; instrumentId: string; amc: string; name: string; isin: string; amfi: string }
export const FUNDS: Record<string, FundDef> = {
  A: { key: 'A', instrumentId: '575b7dc3-dc60-4218-8b75-5ef68c964afe', amc: 'HDFC Mutual Fund', name: 'HDFC Large Cap Fund - Direct Plan - Growth', isin: 'INF179K01YV8', amfi: '119018' },
  B: { key: 'B', instrumentId: '31a05b68-05f1-49d8-8d87-334e221e5740', amc: 'Nippon India Mutual Fund', name: 'Nippon India Large Cap Fund - Direct Plan - Growth', isin: 'INF204K01XI3', amfi: '118632' },
  C: { key: 'C', instrumentId: '70c403e9-a81a-43be-9bcf-b03edf88ec0f', amc: 'HDFC Mutual Fund', name: 'HDFC Corporate Bond Fund - Direct Plan - Growth', isin: 'INF179K01XD8', amfi: '118987' },
  E: { key: 'E', instrumentId: '37a3d60e-47db-4fb9-af8b-4a174dfa1f2f', amc: 'HDFC Mutual Fund', name: 'HDFC Flexi Cap Fund - Direct Plan - Growth', isin: 'INF179K01UT0', amfi: '118955' },
  D: { key: 'D', instrumentId: '2c5322cb-cb50-485c-8c9e-216b2dc6b580', amc: 'ICICI Prudential Mutual Fund', name: 'ICICI Prudential Gilt Fund - Direct Plan - Growth', isin: 'INF109K018C5', amfi: '120590' },
};

export interface TxnSpec { date: string; type: 'sip' | 'purchase' | 'redemption'; amount: number | 'all'; desc?: string }
export interface SchemeSpec { fund: string; folio: string; txns: TxnSpec[]; /** print THIS AMFI code instead of the fund's own (the identifier-mismatch case) */ amfiPrinted?: string }
export interface StatementSpec { id: string; tag: string; investor: string; pan: string; period: { from: string; to: string }; schemes: SchemeSpec[] }

const mfapiCache = new Map<string, Array<{ date: string; nav: number }>>();
async function mfapiNav(amfi: string, onOrBefore: string): Promise<{ date: string; nav: number }> {
  if (!mfapiCache.has(amfi)) {
    const res = await fetch(`https://api.mfapi.in/mf/${amfi}`);
    const j = (await res.json()) as { data: Array<{ date: string; nav: string }> };
    mfapiCache.set(amfi, j.data.map((r) => ({ date: r.date.split('-').reverse().join('-'), nav: Number(r.nav) })).sort((a, b) => (a.date < b.date ? -1 : 1)));
  }
  const rows = mfapiCache.get(amfi)!.filter((r) => r.date <= onOrBefore);
  if (!rows.length) throw new Error(`mfapi has no NAV for ${amfi} on or before ${onOrBefore}`);
  return rows[rows.length - 1];
}

async function navOn(db: any, instrumentId: string, onOrBefore: string, amfi?: string): Promise<{ date: string; nav: number }> {
  if (amfi && instrumentId === FUNDS.E.instrumentId) return mfapiNav(amfi, onOrBefore); // short stored history on DEV: AMFI's published NAV via mfapi.in
  const { data, error } = await db.from('ii_prices_nav').select('price_date, price').eq('instrument_id', instrumentId).lte('price_date', onOrBefore).order('price_date', { ascending: false }).limit(1);
  if (error || !data?.length) throw new Error(`no NAV for ${instrumentId} on or before ${onOrBefore}`);
  return { date: String(data[0].price_date).slice(0, 10), nav: Number(data[0].price) };
}

export async function buildStatement(db: any, spec: StatementSpec, outDir: string) {
  mkdirSync(outDir, { recursive: true });
  const lines: string[] = ['CAMS Consolidated Account Statement', `Statement Period : ${dmy(spec.period.from)} To ${dmy(spec.period.to)}`, ''];
  const expected: any = { id: spec.id, period: spec.period, schemes: [] };
  for (const s of spec.schemes) {
    const f = FUNDS[s.fund];
    lines.push(`Folio No: ${s.folio}`, `PAN: ${spec.pan}`, `Name: ${spec.investor}`, 'Holding Mode: SI', '');
    lines.push(`AMC Name: ${f.amc}`, `Scheme Name: ${f.name}`, `ISIN: ${f.isin}`, `AMFI Code: ${s.amfiPrinted ?? f.amfi}`, 'Registrar: CAMS', '');
    lines.push('Date          Description                              Amount(Rs.)      Units         NAV(Rs.)      Unit Balance');
    let bal = 0;
    const rows: any[] = [];
    let n = 0;
    for (const t of s.txns) {
      n++;
      const { date, nav } = await navOn(db, f.instrumentId, t.date, f.amfi);
      let units: number; let amount: number;
      if (t.type === 'redemption' && t.amount === 'all') { units = bal; amount = Math.round(units * nav * 100) / 100; }
      else { amount = t.amount as number; units = r3(amount / nav); }
      bal = r3(bal + (t.type === 'redemption' ? -units : units));
      const ref = `${spec.tag}-${s.fund}${String(n).padStart(3, '0')}`;
      const desc = t.desc ?? (t.type === 'sip' ? 'SIP Purchase' : t.type === 'purchase' ? 'Purchase' : 'Redemption');
      lines.push(`${dmy(date)}   ${desc.padEnd(38)}${inr(amount)}  ${fx(units, 3)}  ${fx(nav, 4)}  ${fx(bal, 3)} [Ref: ${ref}]`);
      rows.push({ date, type: t.type, amount, units, nav, balanceAfter: bal, ref });
    }
    lines.push('');
    const close = await navOn(db, f.instrumentId, spec.period.to, f.amfi);
    const value = Math.round(bal * close.nav * 100) / 100;
    lines.push(`Closing Unit Balance as on ${dmy(spec.period.to)} : ${fx(bal, 3)} Units   Valuation : Rs. ${inr(value)}   NAV as on ${dmy(spec.period.to)} : Rs. ${fx(close.nav, 4)}`, '');
    expected.schemes.push({ fund: s.fund, instrumentId: f.instrumentId, folio: s.folio, isin: f.isin, amfi: f.amfi, name: f.name, rows, closingUnits: bal, statementNav: close, statementValue: value });
  }
  writeFileSync(join(outDir, `${spec.id}.txt`), lines.join('\n'), 'utf8');
  // the helper puts one page of text at 12 pt leading from the top: more than ~60 lines run off the page and are lost, so long statements are paged
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += 55) pages.push(lines.slice(i, i + 55));
  writeFileSync(join(outDir, `${spec.id}.pdf`), buildMinimalTextPdf(pages));
  writeFileSync(join(outDir, `${spec.id}.expected.json`), JSON.stringify(expected, null, 2) + '\n', 'utf8');
  return expected;
}

const monthly = (from: string, count: number, amount: number): TxnSpec[] => {
  const out: TxnSpec[] = []; let [y, m] = from.split('-').map(Number);
  for (let i = 0; i < count; i++) { out.push({ date: `${y}-${String(m).padStart(2, '0')}-05`, type: 'sip', amount }); m++; if (m > 12) { m = 1; y++; } }
  return out;
};

export const STATEMENTS: StatementSpec[] = [
  // Journey 1 holder: A (over a year, monthly SIPs + a partial redemption), B (under a year, one lump sum), C (bought then fully redeemed)
  {
    id: 'nav2s3-holder', tag: 'NAV2S3H', investor: 'NAV TWO SYNTHETIC HOLDER', pan: 'PCQAL1101H', period: { from: '2024-08-01', to: '2026-09-18' },
    schemes: [
      { fund: 'A', folio: 'NAV2S3H-F1', txns: [...monthly('2024-10', 18, 5000), { date: '2026-06-10', type: 'redemption', amount: 12000 }] },
      { fund: 'B', folio: 'NAV2S3H-F2', txns: [{ date: '2026-04-15', type: 'purchase', amount: 120000 }] },
      { fund: 'C', folio: 'NAV2S3H-F3', txns: [{ date: '2024-08-12', type: 'purchase', amount: 80000 }, { date: '2025-12-01', type: 'redemption', amount: 'all' }] },
    ],
  },
  // Journey 2 / 5 second user: the SAME funds A and D (shared NAV history, no extra storage) with different amounts
  {
    id: 'nav2s3-other', tag: 'NAV2S3O', investor: 'NAV TWO SYNTHETIC OTHERHOLDER', pan: 'PCQAL1102O', period: { from: '2025-01-01', to: '2026-09-18' },
    schemes: [
      { fund: 'A', folio: 'NAV2S3O-F1', txns: [{ date: '2025-03-10', type: 'purchase', amount: 60000 }] },
      { fund: 'D', folio: 'NAV2S3O-F2', txns: [{ date: '2025-05-12', type: 'purchase', amount: 90000 }] },
    ],
  },
  // Journey 3: the "other" user also holds E (the fund whose NAV the correction journey changes; E is not in the PO's seed)
  {
    id: 'nav2s3-other-e', tag: 'NAV2S3Q', investor: 'NAV TWO SYNTHETIC OTHERHOLDER', pan: 'PCQAL1102O', period: { from: '2025-01-01', to: '2026-09-18' },
    schemes: [{ fund: 'E', folio: 'NAV2S3Q-F1', txns: [{ date: '2025-06-10', type: 'purchase', amount: 40000 }] }],
  },
  // Journey 6, ownership and valuation cases (one statement per owner kind)
  { id: 'nav2s3-own-self', tag: 'NAV2S3W1', investor: 'NAV TWO OWNERSHIP SELF', pan: 'PCQAL1104W', period: { from: '2025-01-01', to: '2026-09-18' }, schemes: [{ fund: 'A', folio: 'NAV2S3W1-F1', txns: [{ date: '2025-04-07', type: 'purchase', amount: 30000 }] }] },
  { id: 'nav2s3-own-spouse', tag: 'NAV2S3W2', investor: 'NAV TWO OWNERSHIP SPOUSE', pan: 'PCQAL1105W', period: { from: '2025-01-01', to: '2026-09-18' }, schemes: [{ fund: 'A', folio: 'NAV2S3W2-F1', txns: [{ date: '2025-07-07', type: 'purchase', amount: 20000 }] }] },
  { id: 'nav2s3-own-joint', tag: 'NAV2S3W3', investor: 'NAV TWO OWNERSHIP JOINT', pan: 'PCQAL1106W', period: { from: '2025-01-01', to: '2026-09-18' }, schemes: [{ fund: 'D', folio: 'NAV2S3W3-F1', txns: [{ date: '2025-08-11', type: 'purchase', amount: 60000 }] }] },
  { id: 'nav2s3-own-trust', tag: 'NAV2S3W4', investor: 'NAV TWO OWNERSHIP TRUST', pan: 'PCQAL1107W', period: { from: '2025-01-01', to: '2026-09-18' }, schemes: [{ fund: 'B', folio: 'NAV2S3W4-F1', txns: [{ date: '2025-09-08', type: 'purchase', amount: 70000 }] }] },
  { id: 'nav2s3-own-huf', tag: 'NAV2S3W5', investor: 'NAV TWO OWNERSHIP HUF', pan: 'PCQAL1108W', period: { from: '2025-01-01', to: '2026-09-18' }, schemes: [{ fund: 'C', folio: 'NAV2S3W5-F1', txns: [{ date: '2025-10-06', type: 'purchase', amount: 50000 }] }] },
  { id: 'nav2s3-own-company', tag: 'NAV2S3W6', investor: 'NAV TWO OWNERSHIP COMPANY', pan: 'PCQAL1109W', period: { from: '2025-01-01', to: '2026-09-18' }, schemes: [{ fund: 'D', folio: 'NAV2S3W6-F1', txns: [{ date: '2025-11-10', type: 'purchase', amount: 40000 }] }] },
  // Journey 5: a statement whose ISIN belongs to one fund (A) and whose AMFI code belongs to another (D): the identifiers disagree
  { id: 'nav2s3-wrong-pair', tag: 'NAV2S3X', investor: 'NAV TWO WRONGPAIR', pan: 'PCQAL1110X', period: { from: '2025-01-01', to: '2026-09-18' }, schemes: [{ fund: 'A', folio: 'NAV2S3X-F1', amfiPrinted: '120590', txns: [{ date: '2025-04-07', type: 'purchase', amount: 25000 }, { date: '2025-07-07', type: 'purchase', amount: 25000 }] }] },
  // Journey 5: a purchase so early that the required history (5 years before it) can never be loaded: the history gap case
  { id: 'nav2s3-early', tag: 'NAV2S3Y', investor: 'NAV TWO EARLYHOLDER', pan: 'PCQAL1111Y', period: { from: '2013-01-01', to: '2026-09-18' }, schemes: [{ fund: 'A', folio: 'NAV2S3Y-F1', txns: [{ date: '2013-03-04', type: 'purchase', amount: 15000 }] }] },
  // Journey 2b: ONE fund whose stored history on DEV is SHORT (E, from 05-08-2026): accepting this is the only thing that may make the planner fetch
  {
    id: 'nav2s3-spare-short', tag: 'NAV2S3S', investor: 'NAV TWO SYNTHETIC SPAREHOLDER', pan: 'PCQAL1103S', period: { from: '2025-01-01', to: '2026-09-18' },
    schemes: [{ fund: 'E', folio: 'NAV2S3S-F1', txns: [{ date: '2025-03-10', type: 'purchase', amount: 50000 }] }],
  },
];

if (require.main === module) {
  (async () => {
    const { db } = await import('./_lib.mjs');
    const out = join(__dirname, '..', '..', 'test-artifacts', 'nav2_stage3', 'statements');
    for (const s of STATEMENTS) {
      const e = await buildStatement(db, s, out);
      console.log(s.id, e.schemes.map((x: any) => `${x.fund}: ${x.rows.length} txns, closing ${x.closingUnits} units, value ${x.statementValue}`).join(' | '));
    }
  })().catch((e) => { console.error(e); process.exit(1); });
}
