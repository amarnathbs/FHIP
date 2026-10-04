// Deterministic text-pattern pass: find the declared Tier-1 and additional benchmark lines in the text of a
// factsheet / SID. PURE: no I/O. This runs FIRST; the AI pass is only ever used when this one fails.
//
// Design rules:
//   * Conservative. A line that merely contains the word "benchmark" is not a declaration; only an explicit
//     label ("Benchmark:", "First Tier Benchmark:", "Tier 1 benchmark", "As per AMFI Tier I benchmark -",
//     "Additional benchmark:", "AB:") introduces a value, and the value must look like an index name (and not
//     like a riskometer cell).
//   * Two different Tier-1 answers in one document = 'ambiguous', never "pick one".
//   * The document must NAME the scheme; for a multi-scheme document only the text around the scheme's name
//     is searched.
//   * Dates are day-first (dd/mm/yyyy, dd-mm-yyyy) as every Indian fund-house document prints them.
//
// Performance / return figures are never read: the extractor only ever looks at benchmark NAME lines.

import { classifyBenchmark, sameBenchmark } from './benchmarkClassifier';
import type { DeclaredExtraction, ExtractedBenchmark, ExtractedDate, PatternOutcome } from './types';

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
const pad = (n: number) => String(n).padStart(2, '0');

function validYmd(y: number, m: number, d: number): boolean {
  return y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m);
}

/** Every date found in `s` (day-first for numeric forms), in text order. Month-only mentions are listed only when no full date exists. */
export function findAllDates(s: string): ExtractedDate[] {
  const found: Array<{ index: number; date: ExtractedDate }> = [];
  // dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy
  for (const m of s.matchAll(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\b/g)) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    const y = Number(m[3]);
    if (validYmd(y, mo, d)) found.push({ index: m.index ?? 0, date: { iso: `${y}-${pad(mo)}-${pad(d)}`, precision: 'day' } });
  }
  // 30 April 2026, 30th April, 2026
  for (const m of s.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/g)) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (mo && validYmd(Number(m[3]), mo, Number(m[1]))) found.push({ index: m.index ?? 0, date: { iso: `${m[3]}-${pad(mo)}-${pad(Number(m[1]))}`, precision: 'day' } });
  }
  // April 30, 2026
  for (const m of s.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g)) {
    const mo = MONTHS[m[1].toLowerCase()];
    if (mo && validYmd(Number(m[3]), mo, Number(m[2]))) found.push({ index: m.index ?? 0, date: { iso: `${m[3]}-${pad(mo)}-${pad(Number(m[2]))}`, precision: 'day' } });
  }
  if (found.length > 0) return found.sort((a, b) => a.index - b.index).map((f) => f.date);
  // March 2026
  const months: Array<{ index: number; date: ExtractedDate }> = [];
  for (const m of s.matchAll(/\b([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/g)) {
    const mo = MONTHS[m[1].toLowerCase()];
    if (mo && validYmd(Number(m[2]), mo, 1)) months.push({ index: m.index ?? 0, date: { iso: `${m[2]}-${pad(mo)}-01`, precision: 'month' } });
  }
  return months.sort((a, b) => a.index - b.index).map((f) => f.date);
}

/** The first date found in `s` (day-first for numeric forms), or null. */
export function findFirstDate(s: string): ExtractedDate | null {
  return findAllDates(s)[0] ?? null;
}

/** The date the DOCUMENT is dated. Labelled forms only; the returns-table footnote "as at" is the weakest and tried last. */
export function findDocumentDate(text: string): ExtractedDate | null {
  const groups: RegExp[] = [
    /report\s+as\s+on\s*[:\-]?\s*([^\n]{0,40})/gi,
    /month[\s-]*end(?:ed)?(?:\s+date)?\s*[:\-]?\s*([^\n]{0,40})/gi,
    /(?:scheme\s+information\s+document|key\s+information\s+memorandum|\bSID\b|\bKIM\b|addendum|fund\s+facts|factsheet)[^\n]{0,60}?\bdated\s*[:\-]?\s*([^\n]{0,40})/gi,
    /\bdated\s*[:\-]?\s*([^\n]{0,40})/gi,
    /fund\s+facts\s*[-–:]?\s*([A-Za-z]{3,9}\.?\s*\d{4})/gi,
    /(?:data\s+)?as\s+(?:on|of|at)\s*[:\-]?\s*([^\n]{0,40})/gi,
  ];
  for (const re of groups) {
    for (const m of text.matchAll(re)) {
      const d = findFirstDate(m[1] ?? '');
      if (d) return d;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scheme presence / windows
// ---------------------------------------------------------------------------

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A tolerant regex for a scheme name: case-insensitive, "&" == "and", any run of spaces/punctuation between words. */
export function schemeNameRegex(name: string): RegExp {
  const tokens = name
    .replace(/&/g, ' and ')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => (t.toLowerCase() === 'and' ? '(?:and|&)' : escapeRe(t)));
  return new RegExp(tokens.join('[^A-Za-z0-9]+'), 'gi');
}

const MULTI_SCHEME_WINDOW = 3_500;

/** The text to search: the whole document for a single-scheme document, else the windows after each mention of the scheme. */
export function relevantText(text: string, schemeName: string | readonly string[], scope: 'single_scheme' | 'multi_scheme'): { present: boolean; text: string } {
  // A scheme can be RENAMED (ICICI Prudential Dividend Yield Equity Fund became ... Dividend Yield Fund on 26-08-2026): a
  // document may use the current name or a former one, so any registered name counts as naming the scheme.
  const names = (typeof schemeName === 'string' ? [schemeName] : [...schemeName]).filter((n) => n.trim().length >= 3);
  const hits = names.flatMap((n) => [...text.matchAll(schemeNameRegex(n))]).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (hits.length === 0) return { present: false, text: '' };
  if (scope === 'single_scheme') return { present: true, text };
  const windows: string[] = [];
  let lastEnd = -1;
  for (const h of hits) {
    const start = h.index ?? 0;
    if (start < lastEnd) continue;
    windows.push(text.slice(start, start + MULTI_SCHEME_WINDOW));
    lastEnd = start + MULTI_SCHEME_WINDOW;
  }
  return { present: true, text: windows.join('\n\n=====\n\n') };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

interface LabelHit {
  tier: 1 | 2;
  start: number;
  end: number;
  label: string;
}

const SEP = String.raw`\s*[:\-–—]\s*`;
const TIER2: RegExp[] = [
  new RegExp(String.raw`additional\s+benchmarks?(?:\s*\([^)\n]*\))?${SEP}`, 'gi'),
  new RegExp(String.raw`tier[\s-]*(?:2|ii|two)\s+benchmarks?(?:\s*\([^)\n]*\))?${SEP}`, 'gi'),
  new RegExp(String.raw`second\s+tier\s+benchmarks?${SEP}`, 'gi'),
  new RegExp(String.raw`^[ \t]*AB${SEP}`, 'gim'),
];
const TIER1: RegExp[] = [
  new RegExp(String.raw`(?:first|1st)\s+tier\s+benchmarks?${SEP}`, 'gi'),
  new RegExp(String.raw`tier[\s-]*(?:1|i|one)\s+benchmarks?(?:\s*\([^)\n]*\))?${SEP}`, 'gi'),
  new RegExp(String.raw`as\s+per\s+amfi\s+tier[\s-]*(?:1|i)\s+benchmarks?(?:\s+i\.?e\.?)?(?:${SEP}|\s+)`, 'gi'),
  new RegExp(String.raw`^[ \t]*benchmarks?(?:\s+index)?(?:\s*\((?:total\s+returns?\s+index|tri)\))?${SEP}`, 'gim'),
  new RegExp(String.raw`^[ \t]*benchmarks?(?:\s+index)?(?:\s*\((?:total\s+returns?\s+index|tri)\))?(?:\t+|[ ]{3,})(?=\S)`, 'gim'),
  new RegExp(String.raw`^[ \t]*B${SEP}`, 'gm'),
];

function labelHits(text: string): LabelHit[] {
  const hits: LabelHit[] = [];
  const claimed: Array<[number, number]> = [];
  const overlaps = (s: number, e: number) => claimed.some(([a, b]) => s < b && e > a);
  // Tier-2 labels first so "Additional benchmark:" is never read as a Tier-1 "benchmark:".
  for (const [tier, res] of [[2, TIER2], [1, TIER1]] as const) {
    for (const re of res) {
      for (const m of text.matchAll(re)) {
        const start = m.index ?? 0;
        const end = start + m[0].length;
        if (overlaps(start, end)) continue;
        // A Tier-1 "benchmark:" immediately preceded by "additional " / "tier 2 " belongs to Tier-2.
        if (tier === 1 && /(?:additional|tier[\s-]*(?:2|ii|two)|second\s+tier)\s*$/i.test(text.slice(Math.max(0, start - 20), start))) continue;
        claimed.push([start, end]);
        hits.push({ tier, start, end, label: m[0] });
      }
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

const VARIANT_IN_LABEL = /\((total\s+returns?\s+index|tri)\)/i;

function variantHintFromLabel(label: string): ExtractedBenchmark['variantHint'] {
  if (VARIANT_IN_LABEL.test(label)) return 'total_return';
  return null;
}

const INDEXISH = /\b(nifty|sensex|bse|nse|crisil|index|indices|tri|ntr|s&p|msci|ftse|gold|silver|price|composite|dow|nasdaq|hang\s+seng|russell)\b/i;
const NOT_A_NAME = /^(?:risk|riskometer|risk-o-meter|very\s+high|moderately|moderate|low\b|high\b|n\/?a\b|nil\b|none\b|not\s+applicable)/i;

/** Pure: does this look like a benchmark NAME (and not a riskometer cell, a sentence, or noise)? */
export function plausibleBenchmarkName(s: string): boolean {
  const t = s.trim();
  if (t.length < 3 || t.length > 260) return false;
  if (!/[A-Za-z]/.test(t)) return false;
  if (NOT_A_NAME.test(t) || /riskometer|risk-o-meter/i.test(t)) return false;
  if (!INDEXISH.test(t)) return false;
  // A full prose sentence is not a name.
  if (t.split(/\s+/).length > 45) return false;
  return true;
}

const EFFECTIVE_RE = /\(?\s*(?:w\.?\s?e\.?\s?f\.?|with\s+effect\s+from|effective\s+(?:from|date)?)\s*[:\-]?\s*([^)\n]{0,40})\)?/i;

/** Strip the trailing "(w.e.f. 31 October 2023)" remark and return it separately. */
export function splitEffectiveRemark(value: string): { name: string; effective: ExtractedDate | null } {
  const m = EFFECTIVE_RE.exec(value);
  if (!m) return { name: value.trim(), effective: null };
  const effective = findFirstDate(m[1] ?? '');
  if (!effective) return { name: value.trim(), effective: null };
  const name = (value.slice(0, m.index) + value.slice((m.index ?? 0) + m[0].length)).trim();
  return { name, effective };
}

function tidy(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\s*[|•]+\s*$/g, '')
    .replace(/[\s;,]+$/g, '')
    .replace(/\.\s*$/g, '')
    .trim();
}

/** The value after a label: the rest of the line, joined with a continuation line when the statement is clearly unfinished. */
function valueAfter(text: string, hit: LabelHit, nextStart: number): { value: string; span: string } {
  const limit = Math.min(nextStart, hit.end + 500);
  const region = text.slice(hit.end, limit);
  const lines = region.split(/\r?\n/);
  // A table cell can put the value on the line after its label.
  const skip = (lines[0] ?? '').trim() === '' && (lines[1] ?? '').trim() !== '' ? 1 : 0;
  let value = lines[skip] ?? '';
  let used = skip + 1;
  while (used < lines.length && used < 4) {
    const nextLine = (lines[used] ?? '').trim();
    const cur = value.trim();
    if (!nextLine) break;
    // A composite statement ("45% X + 40% Y + 10% ...") that has not reached its closing full stop / bracket continues on the next line.
    const compositeInProgress = /%/.test(cur) && /\+/.test(cur) && !/[.)]$/.test(cur);
    const unfinished = /[+(,]$/.test(cur) || /^\+/.test(nextLine) || /^\(?\s*w\.?\s?e\.?\s?f/i.test(nextLine) || compositeInProgress || (/\d\s*%[^+]*$/.test(cur) && /^\+?\s*\d+(\.\d+)?\s*%/.test(nextLine));
    if (!unfinished) break;
    value += ` ${nextLine}`;
    used++;
  }
  return { value, span: `${hit.label}${value}` };
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

export interface PatternInput {
  text: string;
  schemeName: string;
  /** Former / alternative names the document may use for the same scheme (renames). */
  schemeAliases?: readonly string[];
  scope: 'single_scheme' | 'multi_scheme';
}

export function extractWithPatterns(input: PatternInput): PatternOutcome {
  const rel = relevantText(input.text, [input.schemeName, ...(input.schemeAliases ?? [])], input.scope);
  if (!rel.present) return { status: 'not_found', reason: 'The document does not name the scheme.', schemeNamePresent: false };

  const hits = labelHits(rel.text);
  const tier1: Array<{ b: ExtractedBenchmark; effective: ExtractedDate | null; span: string }> = [];
  const tier2: ExtractedBenchmark[] = [];
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    const next = hits[i + 1]?.start ?? rel.text.length;
    const { value, span } = valueAfter(rel.text, hit, next);
    const { name, effective } = splitEffectiveRemark(tidy(value));
    const cleaned = tidy(name);
    if (!plausibleBenchmarkName(cleaned)) continue;
    const b: ExtractedBenchmark = { raw: cleaned, variantHint: variantHintFromLabel(hit.label) };
    if (hit.tier === 1) tier1.push({ b, effective, span });
    else tier2.push(b);
  }

  if (tier1.length === 0) return { status: 'not_found', reason: 'No explicit Tier-1 / "Benchmark" label with a plausible index name was found.', schemeNamePresent: true };

  // All Tier-1 candidates must be the SAME benchmark.
  const first = classifyBenchmark(tier1[0].b.raw);
  const distinct = tier1.filter((c) => !sameBenchmark(first, classifyBenchmark(c.b.raw)));
  if (distinct.length > 0) {
    return { status: 'ambiguous', reason: 'The document states more than one different Tier-1 benchmark.', candidates: [...new Set(tier1.map((c) => c.b.raw))].slice(0, 5), schemeNamePresent: true };
  }
  // Prefer the candidate that carries a variant hint or an effective date (the most complete statement of the same benchmark).
  const best = tier1.find((c) => c.effective) ?? tier1.find((c) => c.b.variantHint) ?? tier1[0];
  const effectiveFromStated = tier1.find((c) => c.effective)?.effective ?? null;
  const hint = tier1.find((c) => c.b.variantHint)?.b.variantHint ?? null;

  // Additional benchmarks: distinct, never the Tier-1 itself.
  const additional: ExtractedBenchmark[] = [];
  for (const b of tier2) {
    const c = classifyBenchmark(b.raw);
    if (sameBenchmark(first, c)) continue;
    if (additional.some((x) => sameBenchmark(classifyBenchmark(x.raw), c))) continue;
    additional.push(b);
  }

  const extraction: DeclaredExtraction = {
    schemeNamePresent: true,
    tier1: { raw: best.b.raw, variantHint: hint },
    additional: additional.slice(0, 3),
    effectiveFromStated,
    documentDate: findDocumentDate(input.text),
    excerpt: clip(best.span, 400),
  };
  return { status: 'found', extraction };
}
