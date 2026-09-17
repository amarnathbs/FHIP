/**
 * M12C §8.2 — READ-ONLY structural taxonomy of the production CAS parse run's
 * `unparseable_transaction_row` findings.
 *
 * READ-ONLY. HTTP GET only. No POST/PATCH/DELETE/RPC/DDL/DML anywhere.
 *
 * PRIVACY: this script reads the parse run's `warnings` / `errors` JSON, which
 * embeds the *raw source line* of each unparsed row. Those lines can carry a
 * folio number, a PAN, a holder name or a scheme name. **Not one raw line is
 * ever printed.** Every line is reduced, in-process, to a STRUCTURAL SHAPE
 * CLASS (a digit/letter/punctuation skeleton and a set of boolean structural
 * predicates) and only the per-class COUNTS are printed. The single example
 * emitted per class is a redacted skeleton, never the source text: every digit
 * becomes `9`, every letter run becomes `A`, so nothing identifying survives.
 *
 * Purpose: decide, on evidence rather than on PC4's hand tally, whether each of
 * the 251 findings is genuinely non-economic — i.e. whether ANY of them is
 * date-led and money-shaped (which would be a real economic omission and must
 * stay severity `error`).
 *
 * Usage:  node scripts/m12c_pc4_warning_taxonomy_probe.mjs [dev|prod]
 */
import fs from 'node:fs';

const TARGET = (process.argv[2] ?? 'prod').toLowerCase();

const envPath = ['.env.local', 'D:/FHIP/.env.local'].find((p) => fs.existsSync(p));
if (!envPath) throw new Error('no .env.local found');
const text = fs.readFileSync(envPath, 'utf8').replace(/^\uFEFF/, '');
const env = {};
for (const raw of text.split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
}

const DEV_BASE = 'https://vqycarelcoijzwlpkpcz.supabase.co';
const PROD_BASE = (env.PRODUCTION_SUPABASE_URL ?? '').replace(/\/$/, '');
if (!PROD_BASE) throw new Error('PRODUCTION_SUPABASE_URL absent');
if (PROD_BASE === DEV_BASE) throw new Error('SAFETY: production url equals dev url');

const BASE = TARGET === 'dev' ? DEV_BASE : PROD_BASE;
const KEY = TARGET === 'dev' ? env.SUPABASE_SERVICE_ROLE_KEY : env.PRODUCTION_SUPABASE_SERVICE_ROLE_KEY;

async function get(q) {
  const res = await fetch(`${BASE}/rest/v1/${q}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    let b = null;
    try {
      b = await res.json();
    } catch {
      /* ignore */
    }
    return { ok: false, code: b?.code ?? res.status, message: b?.message ?? null };
  }
  return { ok: true, data: await res.json() };
}

/** Reduce any source line to a non-identifying skeleton. */
function skeleton(s) {
  return s
    .replace(/[0-9]/g, '9')
    .replace(/[A-Za-z]+/g, 'A')
    .replace(/9+/g, '9')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/**
 * The structural predicates that decide economic materiality. These are the
 * SAME predicates the parser-side fix uses, so the evidence here and the code
 * there cannot drift.
 */
// A CAMS transaction row ALWAYS begins with its date, at the start of the
// line — every row grammar in camsParser.ts (TXN_ROW_RE, ALT_TXN_ROW_RE,
// ALT_FEE_ROW_RE, ALT_FEE_ROW_SPLIT_DATE_AMOUNT_RE, ALT_TXN_ROW_WRAPPED_*) is
// `^`-anchored on the date. A date appearing MID-LINE is prose.
const LEADING_DATE_RE = /^\(?\d{1,2}-[A-Za-z]{3}-\d{4}/;
const ANY_DATE_RE = /\b\d{1,2}-[A-Za-z]{3}-\d{4}\b/;
// Money as this layout prints it: at least two decimal places, and NOT
// immediately followed by `%` (a percentage is a rate, never an amount).
// MUST stay character-identical to camsParser.ts's MONEY_SHAPED_RE, or the
// evidence this probe produces and the behaviour of the shipped classifier
// would be measuring two different things. `\d+` (not `\d{1,3}`) on the leading
// run is load-bearing: this layout prints amounts both ungrouped (`3000.00`)
// and in Indian lakh grouping (`1,23,456.78`).
const MONEY_RE = /(?<![.\d])\(?-?\d+(?:,\d{2,3})*\.\d{2,6}\)?(?![.\d%])/;
const PAGE_RE = /\bpage\s+\d+\s+of\s+\d+\b/i;
const URL_OR_EMAIL_RE = /(https?:\/\/|www\.|@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/;

function classify(line) {
  const t = line.trim();
  const leadingDate = LEADING_DATE_RE.test(t);
  const anyDate = ANY_DATE_RE.test(t);
  const hasMoney = MONEY_RE.test(t);
  if (leadingDate && hasMoney) return 'A1_LEADING_DATE_AND_MONEY__ECONOMIC_CANDIDATE';
  if (leadingDate && !hasMoney) return 'A2_LEADING_DATE_NO_MONEY';
  if (anyDate && hasMoney) return 'B1_MIDLINE_DATE_AND_MONEY__PROSE';
  if (anyDate) return 'B2_MIDLINE_DATE_ONLY__PROSE';
  if (hasMoney) return 'C_MONEY_ONLY_NO_DATE';
  if (PAGE_RE.test(t)) return 'D_PAGE_FOOTER';
  if (URL_OR_EMAIL_RE.test(t)) return 'E_URL_OR_EMAIL';
  if (!/\d/.test(t)) return 'F_NO_DIGIT_AT_ALL';
  return 'G_DIGITS_BUT_NO_DATE_NO_MONEY';
}

console.log(`=== M12C §8.2 — ${TARGET.toUpperCase()} parse-run finding taxonomy (READ-ONLY) ===\n`);

const neg = await get('ii_document_parse_runs?select=zz_no_such_column_m12c&limit=1');
console.log(`NEGATIVE CONTROL : ${neg.ok ? 'FAILED — returned rows' : `PASS (${neg.code})`}\n`);

const runs = await get(
  'ii_document_parse_runs?select=id,run_status,parser_code,parser_version,source_detected,source_confidence,accounts_found,schemes_found,transactions_found,holdings_found,warnings,errors,started_at,completed_at&order=started_at.desc&limit=40',
);
if (!runs.ok) throw new Error(`probe failed: ${runs.code} ${runs.message}`);

console.log(`parse runs returned : ${runs.data.length}`);
const byStatus = {};
for (const r of runs.data) byStatus[r.run_status] = (byStatus[r.run_status] ?? 0) + 1;
console.log(`run_status breakdown: ${JSON.stringify(byStatus)}\n`);

const target = runs.data.find((r) => (r.transactions_found ?? 0) > 0);
if (!target) {
  console.log('No run with transactions found.');
  process.exit(0);
}

console.log(`--- the final successful run ---`);
console.log(`id                 : ${target.id.slice(0, 8)}`);
console.log(`started/completed  : ${target.started_at} / ${target.completed_at}`);
console.log(`parser             : ${target.parser_code}@${target.parser_version}`);
console.log(`detected/confidence: ${target.source_detected} / ${target.source_confidence}`);
console.log(`accounts/schemes/txns/holdings: ${target.accounts_found}/${target.schemes_found}/${target.transactions_found}/${target.holdings_found}`);

for (const bucket of ['warnings', 'errors']) {
  const arr = Array.isArray(target[bucket]) ? target[bucket] : [];
  console.log(`\n=== ${bucket}: ${arr.length} entries ===`);
  const byCodeSev = {};
  for (const w of arr) {
    const k = `${w.code}/${w.severity}`;
    byCodeSev[k] = (byCodeSev[k] ?? 0) + 1;
  }
  console.log(`by code/severity   : ${JSON.stringify(byCodeSev)}`);

  const unparseable = arr.filter((w) => w.code === 'unparseable_transaction_row');
  if (unparseable.length === 0) continue;

  // The parser's message format for this code embeds the raw line. Recover the
  // line WITHOUT printing it.
  const classes = {};
  const examples = {};
  let recovered = 0;
  for (const w of unparseable) {
    const msg = String(w.message ?? '');
    const m = /"([\s\S]*)"\s*$/.exec(msg) ?? /:\s*([\s\S]*)$/.exec(msg);
    const line = m ? m[1] : msg;
    recovered += m ? 1 : 0;
    const cls = classify(line);
    classes[cls] = (classes[cls] ?? 0) + 1;
    if (!examples[cls]) examples[cls] = skeleton(line);
  }
  console.log(`\nunparseable_transaction_row : ${unparseable.length}`);
  console.log(`raw line recovered from msg : ${recovered}/${unparseable.length}`);
  console.log(`\nSTRUCTURAL SHAPE CLASSES (counts only; example is a redacted skeleton)`);
  for (const [k, v] of Object.entries(classes).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(4)}  ${k.padEnd(38)}  e.g. ${examples[k]}`);
  }
  const economic = classes['A1_LEADING_DATE_AND_MONEY__ECONOMIC_CANDIDATE'] ?? 0;
  console.log(`\n>>> ECONOMIC CANDIDATES (leading date AND money on one line): ${economic}`);
  console.log(`>>> STRUCTURALLY NON-ECONOMIC                               : ${unparseable.length - economic}`);

  // --- adjacency analysis for the bare-leading-date class ------------------
  // A line carrying ONLY a date could be the leading fragment of a real
  // transaction row that pdf-parse split. The decisive test is what sits
  // immediately next to it: if the neighbour is itself an unparsed
  // no-digit marker line (`*** ... ***`), the pair is a lifecycle marker,
  // not a money row. `lineHint` gives the source line index.
  const byLine = new Map();
  for (const w of unparseable) {
    const msg = String(w.message ?? '');
    const m = /"([\s\S]*)"\s*$/.exec(msg) ?? /:\s*([\s\S]*)$/.exec(msg);
    const line = m ? m[1] : msg;
    if (typeof w.lineHint === 'number') byLine.set(w.lineHint, { line, cls: classify(line) });
  }
  const bare = [...byLine.entries()].filter(([, v]) => v.cls === 'A2_LEADING_DATE_NO_MONEY');
  if (bare.length > 0) {
    console.log(`\nADJACENCY for the ${bare.length} bare-leading-date findings (by lineHint):`);
    const neigh = {};
    let bothNeighboursUnparsed = 0;
    for (const [ln] of bare) {
      const prev = byLine.get(ln - 1);
      const next = byLine.get(ln + 1);
      const k = `prev=${prev ? prev.cls : 'PARSED_OR_ABSENT'} | next=${next ? next.cls : 'PARSED_OR_ABSENT'}`;
      neigh[k] = (neigh[k] ?? 0) + 1;
      if (prev && next) bothNeighboursUnparsed += 1;
    }
    for (const [k, v] of Object.entries(neigh).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
    console.log(`  both neighbours also unparsed: ${bothNeighboursUnparsed}/${bare.length}`);
    console.log(`  distinct redacted skeletons in this class:`);
    const sk = {};
    for (const [, v] of bare) sk[skeleton(v.line)] = (sk[skeleton(v.line)] ?? 0) + 1;
    for (const [k, v] of Object.entries(sk).sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`     ${String(v).padStart(4)}  "${k}"  (len class ${v})`);
    console.log(`  character-length distribution:`);
    const lens = {};
    for (const [, v] of bare) {
      const L = v.line.trim().length;
      const bucket = L <= 12 ? '<=12 (a bare date, nothing else)' : L <= 30 ? '13-30' : L <= 60 ? '31-60' : '>60';
      lens[bucket] = (lens[bucket] ?? 0) + 1;
    }
    console.log(`     ${JSON.stringify(lens)}`);
  }
}

console.log('\n=== end — zero writes performed ===');
