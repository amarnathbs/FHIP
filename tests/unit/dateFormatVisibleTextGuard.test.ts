// Repo-wide GUARD (PO review 06-10-2026, finding F13): NO year-first ISO wording, month-first wording, native browser date picker or
// browser-locale date formatting may reach a screen, a placeholder, a hint, a message, a PDF or an e-mail.
//
// PO rule: "I asked to change the date format globally to India or Australia but seeing this format (YYYY-MM-DD) ... there is no user
// from the country who use this format, please make sure that you don't use this format at any place across the application."
// Day-first everywhere: dd-mm-yyyy for India, dd/mm/yyyy for Australia (lib/engines/date.ts formatDateShort / formatDateInText /
// dateFormatKeyForCountry; typed dates: lib/engines/dateInput.ts and components/ui/DateInput.tsx). Machine formats stay ISO inside
// request bodies, files, API field names and the database: those exact lines are the explicit allow-lists below.
//
// The scanner walks ALL of app/, components/ and lib/ and fails on:
//   iso-label              yyyy-mm-dd / yyyy/mm/dd / mm/dd/yyyy / mm-dd-yyyy wording (any case) in code (labels, placeholders, hints, messages)
//   native-date-picker     <input type="date"> (renders in the browser's locale, often month-first)
//   locale-date-formatting toLocaleDateString / Intl.DateTimeFormat / new Date(..).toLocaleString() showing a day or any date-time
//   iso-rendered-in-jsx    a raw ISO value rendered in JSX text: {...toISOString().slice(0, 10)} / {...toISOString().split('T')[0]}
// NEGATIVE CONTROLS re-run the scanner on mutated copies of the real sources (the exact labels the PO reported) and require each to
// be caught: a scanner that cannot fail proves nothing.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

export interface Violation {
  file: string;
  rule: 'iso-label' | 'native-date-picker' | 'locale-date-formatting' | 'iso-rendered-in-jsx' | 'raw-date-in-jsx';
  detail: string;
}

/** Machine-format tokens NOBODY reads: a file-format identifier, an AI prompt line, a URL template. Exact lines only, each re-checked. */
export const ALLOWED_MACHINE_TOKENS: ReadonlyArray<{ file: string; line: RegExp; why: string }> = [
  { file: 'lib/financial-data-hub/bank-csv/dateFormats.ts', line: /'YYYY-MM-DD'/, why: 'date-format identifier of a bank CSV file (parser input, never rendered)' },
  { file: 'lib/financial-data-hub/bank-csv/adapters/genericAdapters.ts', line: /dateFormat: 'YYYY-MM-DD'/, why: 'adapter declares the format its file uses' },
  { file: 'lib/financial-data-hub/investment/csvExtraction.ts', line: /parseDateWithFormat\(rawValuation, 'YYYY-MM-DD'\)/, why: 'parser input' },
  { file: 'lib/services/investment-intelligence/benchmarkData/apiTypes.ts', line: /dateFormat: 'YYYY-MM-DD' \|/, why: 'API field value type' },
  { file: 'lib/services/investment-intelligence/benchmarkData/routeSupport.ts', line: /z\.enum\(\['YYYY-MM-DD'/, why: 'API field value enum' },
  { file: 'lib/services/investment-intelligence/benchmarkData/fileIngest/types.ts', line: /\| 'YYYY-MM-DD'/, why: 'format identifier union' },
  { file: 'lib/services/investment-intelligence/benchmarkData/fileIngest/dateParsing.ts', line: /case 'YYYY-MM-DD': \{/, why: 'parser branch for that file format' },
  { file: 'components/admin/benchmarkData/benchmarkDataUiLogic.ts', line: /value: 'YYYY-MM-DD', label: 'Year first \(year, month, day\)'/, why: 'option VALUE (an identifier); the label a person reads is in words' },
  { file: 'components/admin/benchmarkData/benchmarkDataUiLogic.ts', line: /value: 'MM\/DD\/YYYY', label: 'Month first, US style \(month, day, year\)'/, why: 'option VALUE (an identifier) for a US-layout upload file; the label a person reads is in words' },
  { file: 'lib/financial-data-hub/bank-csv/dateFormats.ts', line: /'MM\/DD\/YYYY'/, why: 'date-format identifier of a bank CSV file (parser input, never rendered)' },
  { file: 'lib/services/investment-intelligence/benchmarkData/fileIngest/dateParsing.ts', line: /case 'MM\/DD\/YYYY':/, why: 'parser branch for that file format' },
  { file: 'lib/services/investment-intelligence/benchmarkData/fileIngest/types.ts', line: /\| 'MM\/DD\/YYYY'/, why: 'format identifier union' },
  { file: 'lib/services/investment-intelligence/marketIndex/dailyFeed.ts', line: /\{YYYY-MM-DD\}/, why: 'URL template token substituted before the request' },
];

/** Files whose locale/Intl use is the canonical formatter or a machine date-part reader, not a screen. */
export const ALLOWED_LOCALE_FILES: ReadonlyArray<{ file: string; why: string }> = [
  { file: 'lib/engines/date.ts', why: 'the canonical day-first formatter: it takes only the 12-hour time from toLocaleTimeString' },
  { file: 'lib/read-models/core/window.ts', why: 'reads year/month/day PARTS in a named time zone (formatToParts) for a window, never shown' },
  { file: 'lib/services/investment-intelligence/pc6/referenceDataQualityView.ts', why: 'reads year/month/day/hour/minute PARTS in a named time zone (formatToParts) and assembles the day-first dd-mm-yyyy text itself; the locale string is never shown' },
];

export function stripComments(s: string): string {
  const out: string[] = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (s[j] === '\\') {
          j += 2;
          continue;
        }
        if (s[j] === c) break;
        if (c !== '`' && s[j] === '\n') break;
        j += 1;
      }
      out.push(s.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (s.startsWith('//', i)) {
      let j = s.indexOf('\n', i);
      if (j < 0) j = n;
      out.push(' '.repeat(j - i));
      i = j;
      continue;
    }
    if (s.startsWith('/*', i)) {
      let j = s.indexOf('*/', i);
      j = j < 0 ? n : j + 2;
      out.push(s.slice(i, j).replace(/[^\n]/g, ' '));
      i = j;
      continue;
    }
    out.push(c);
    i += 1;
  }
  return out.join('');
}

function callArgs(src: string, open: number): string {
  let depth = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '(') depth += 1;
    else if (src[k] === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, k);
    }
  }
  return src.slice(open + 1);
}

// year-first (yyyy-mm-dd, yyyy/mm/dd) and month-first (mm/dd/yyyy, mm-dd-yyyy) wording, any case, spaces tolerated.
const ISO_WORDS = /yyyy\s*[-/.]\s*mm\s*[-/.]\s*dd|\bmm\s*[-/.]\s*dd\s*[-/.]\s*yyyy/i;

const RAW_DATE_TAIL = /(Date|AsOf|asOf|At|On|Through|Since|Until)$/;
/** Identifiers that end like a date but are not one, or already hold a formatted string. Exact names. */
const RAW_DATE_OK: ReadonlyArray<{ file: string; expr: string; why: string }> = [
  { file: 'components/reports/ReportPreview.tsx', expr: 'd.disposalDate', why: 'taxTableRows() (lib/engines/reportTaxTable.ts) already formats it day-first with formatDateShort' },
];

export function scan(file: string, rawSource: string): Violation[] {
  const out: Violation[] = [];
  const src = stripComments(rawSource);

  src.split('\n').forEach((line) => {
    if (!ISO_WORDS.test(line)) return;
    if (ALLOWED_MACHINE_TOKENS.some((a) => a.file === file && a.line.test(line))) return;
    out.push({ file, rule: 'iso-label', detail: line.trim().slice(0, 140) });
  });

  if (/\.tsx$/.test(file)) {
    for (const m of src.matchAll(/type\s*=\s*\{?\s*(?:"date"|'date')/g)) out.push({ file, rule: 'native-date-picker', detail: m[0] });
    // an ISO string rendered straight into JSX text
    for (const m of src.matchAll(/>[^<>{}]*\{[^{}<>]*toISOString\(\)\.(?:slice\(\s*0\s*,\s*10\s*\)|split\(\s*['"]T['"]\s*\)\s*\[\s*0\s*\])[^{}<>]*\}\s*</g)) out.push({ file, rule: 'iso-rendered-in-jsx', detail: m[0].slice(0, 100) });
  }

  // a raw stored date value shown as text: JSX text `{row.asOfDate}` / `As at {x.createdAt}` that is not wrapped in a day-first formatter
  if (/\.tsx$/.test(file)) {
    for (const m of src.matchAll(/(?<![=\w$.)\]])\{\s*([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)\s*\}(?!\s*(?:=|from|:))/g)) {
      const tail = m[1].split(/\??\./).pop() as string;
      if (RAW_DATE_TAIL.test(tail) && !RAW_DATE_OK.some((a) => a.file === file && a.expr === m[1])) out.push({ file, rule: 'raw-date-in-jsx', detail: m[1] });
    }
  }

  if (!ALLOWED_LOCALE_FILES.some((a) => a.file === file)) {
    for (const m of src.matchAll(/toLocale(Date|Time)String\s*\(|Intl\.DateTimeFormat\s*\(/g)) {
      const args = callArgs(src, (m.index as number) + m[0].length - 1);
      const showsDay = /\bday\b/.test(args);
      const isTime = m[1] === 'Time';
      const monthYearOnly = /\bmonth\b/.test(args) && !showsDay;
      const ok = isTime ? !/\b(day|month|year)\b/.test(args) : monthYearOnly;
      if (!ok) out.push({ file, rule: 'locale-date-formatting', detail: `${m[0]}${args.slice(0, 80).replace(/\s+/g, ' ')})` });
    }
    for (const m of src.matchAll(/new Date\([^)]*\)\.toLocaleString\(/g)) out.push({ file, rule: 'locale-date-formatting', detail: m[0] });
  }
  return out;
}

function walk(rel: string, acc: string[]): string[] {
  for (const e of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      walk(r, acc);
    } else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) acc.push(r);
  }
  return acc;
}

const FILES = ['app', 'components', 'lib'].flatMap((d) => walk(d, []));
const SOURCES = new Map<string, string>(FILES.map((f) => [f, read(f)]));
const scanAll = (mutate?: (file: string, src: string) => string): Violation[] => [...SOURCES.entries()].flatMap(([f, s]) => scan(f, mutate ? mutate(f, s) : s));

/** A mutation that must actually change the file (a control that changes nothing would prove nothing). */
function mutateOne(file: string, from: string | RegExp, to: string): (f: string, s: string) => string {
  return (f, s) => {
    if (f !== file) return s;
    const next = s.replace(from, to);
    if (next === s) throw new Error(`the control did not change ${file}: ${String(from)}`);
    return next;
  };
}

describe('F13 guard: no ISO / month-first date wording and no browser-locale dates anywhere a person can read them', () => {
  it('walks the whole of app/, components/ and lib/ (guards against the walk silently emptying)', () => {
    expect(FILES.length).toBeGreaterThan(700);
    for (const must of ['components/resources/money-update/MoneyUpdateEditor.tsx', 'components/admin/ReferenceDataQualityClient.tsx', 'lib/engines/date.ts', 'app/api/investment-intelligence/xray/route.ts']) {
      expect(SOURCES.has(must), must).toBe(true);
    }
  });

  it('no yyyy-mm-dd wording, no native date picker, no day-bearing locale date, no ISO rendered in JSX', () => {
    const v = scanAll();
    expect(v, JSON.stringify(v, null, 1)).toEqual([]);
  });

  it('every machine-token allowance still matches a real line in its file (the list cannot go stale or be widened silently)', () => {
    for (const a of ALLOWED_MACHINE_TOKENS) {
      expect(existsSync(path.join(ROOT, a.file)), a.file).toBe(true);
      const code = stripComments(SOURCES.get(a.file) ?? '');
      expect(code.split('\n').some((l) => ISO_WORDS.test(l) && a.line.test(l)), `${a.file}: ${a.why}`).toBe(true);
    }
    for (const a of ALLOWED_LOCALE_FILES) expect(existsSync(path.join(ROOT, a.file)), a.file).toBe(true);
  });

  it('a dynamic <input type={field.type}> (the financial grid) routes its date fields to the day-first DateInput, never to a native date picker', () => {
    const offenders = [...SOURCES].filter(([f, src]) => /\.tsx$/.test(f) && /type=\{\s*f\.type\s*\}/.test(stripComments(src)) && !/f\.type === 'date'[\s\S]{0,200}<DateInput/.test(stripComments(src))).map(([f]) => f);
    expect(offenders).toEqual([]);
    expect(SOURCES.get('components/grid/FinancialDataGrid.tsx')).toMatch(/f\.type === 'date'/);
  });

  it('every raw-date allowance still matches a real use in its file', () => {
    for (const a of RAW_DATE_OK) expect((SOURCES.get(a.file) ?? '').includes(`{${a.expr}}`), `${a.file}: ${a.why}`).toBe(true);
  });

  it('the Money Update Event Date field the PO reported shows the day-first placeholder', () => {
    const src = SOURCES.get('components/resources/money-update/MoneyUpdateEditor.tsx') as string;
    expect(src).toContain('<DateTextField label="Event Date"');
    expect(stripComments(src)).not.toMatch(/YYYY-MM-DD/i);
    const field = SOURCES.get('components/resources/editor/FormField.tsx') as string;
    expect(field).toContain('<DateInput');
    expect(SOURCES.get('components/ui/DateInput.tsx') as string).toContain('placeholder={DATE_INPUT_PLACEHOLDER}');
  });
});

describe('NEGATIVE CONTROLS: the scanner demonstrably catches each defect (each mutation changes a real source)', () => {
  const MU = 'components/resources/money-update/MoneyUpdateEditor.tsx';

  it('DATEGUARD-NC-1: the exact placeholder from the PO screenshot (Money Update Event Date, YYYY-MM-DD) fails', () => {
    const v = scanAll(mutateOne(MU, '<DateTextField label="Event Date"', '<TextField placeholder="YYYY-MM-DD" label="Event Date"'));
    expect(v.some((x) => x.file === MU && x.rule === 'iso-label')).toBe(true);
  });

  it('DATEGUARD-NC-2: other separators, cases and the month-first form are caught (YYYY/MM/DD, Yyyy-Mm-Dd, mm/dd/yyyy)', () => {
    expect(scan('components/x.tsx', 'const a = "Use YYYY/MM/DD";').length).toBe(1);
    expect(scan('components/x.tsx', 'const a = "Use Yyyy-Mm-Dd";').length).toBe(1);
    expect(scan('components/x.tsx', 'const a = "Use mm/dd/yyyy";').length).toBe(1);
    expect(scan('components/x.tsx', '// only a comment says yyyy-mm-dd\nconst a = 1;').length).toBe(0);
  });

  it('DATEGUARD-NC-3: a native date picker is caught', () => {
    expect(scan('components/x.tsx', 'const a = <input type="date" />;').some((x) => x.rule === 'native-date-picker')).toBe(true);
  });

  it('DATEGUARD-NC-4: a locale-formatted day and a bare toLocaleDateString() are caught; month-and-year and time-only are not', () => {
    expect(scan('components/x.tsx', "const a = d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });").some((x) => x.rule === 'locale-date-formatting')).toBe(true);
    expect(scan('components/x.tsx', 'const a = d.toLocaleDateString();').some((x) => x.rule === 'locale-date-formatting')).toBe(true);
    expect(scan('components/x.tsx', 'const a = new Date(v).toLocaleString();').some((x) => x.rule === 'locale-date-formatting')).toBe(true);
    expect(scan('components/x.tsx', "const a = d.toLocaleDateString('en-AU', { month: 'short', year: 'numeric' });").length).toBe(0);
    expect(scan('components/x.tsx', "const a = d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });").length).toBe(0);
  });

  it('DATEGUARD-NC-5: an ISO string rendered straight into JSX text (the old "Last updated" line on the legal pages) is caught', () => {
    expect(scan('app/x/page.tsx', 'const a = <p>Last updated: {new Date().toISOString().slice(0, 10)}</p>;').some((x) => x.rule === 'iso-rendered-in-jsx')).toBe(true);
    expect(scan('app/x/page.tsx', "const a = <p>{new Date().toISOString().split('T')[0]}</p>;").some((x) => x.rule === 'iso-rendered-in-jsx')).toBe(true);
    expect(scan('app/x/page.tsx', 'const a = { when: new Date().toISOString().slice(0, 10) };').length).toBe(0); // machine value, not shown
  });

  it('DATEGUARD-NC-6: the machine-token allowance is exact: a NEW iso label in an allowed file still fails', () => {
    const f = 'lib/financial-data-hub/bank-csv/dateFormats.ts';
    const v = scanAll((file, s) => (file === f ? `${s}\nexport const HELP = 'Type the date as yyyy-mm-dd';\n` : s));
    expect(v.some((x) => x.file === f && x.rule === 'iso-label')).toBe(true);
  });

  it('DATEGUARD-NC-7: the clean sources produce no violation (the controls above are not noise)', () => {
    expect(scanAll()).toEqual([]);
  });
});
