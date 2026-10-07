// Repo-wide source guard: NO year-first ISO date wording or browser-locale date rendering may reach a screen.
//
// PO standing rule (lib/engines/dateInput.ts, lib/engines/date.ts): every date a person reads or types is DAY-FIRST (dd-mm-yyyy for India,
// dd/mm/yyyy for Australia). The wire format stays ISO inside request bodies, file contents and API field names, but never in text.
// tests/unit/dateFormatsDayFirstSourceContract.test.ts guards the programme's curated screens; THIS test walks all of app/, components/
// and lib/ and fails on:
//   iso-label              the words yyyy-mm-dd / YYYY-MM-DD / yyyy/mm/dd (any case) in code (a label, placeholder, hint, error message,
//                          help text, tooltip). Comments are ignored. Machine-format tokens are allowed ONLY on the exact lines listed in
//                          ALLOWED_MACHINE_TOKENS (file format identifiers, an AI prompt, a URL template) and every entry is checked to
//                          still match, so the list cannot go stale or widen silently;
//   native-date-picker     <input type="date"> (renders in the browser's locale, often month-first);
//   locale-date-formatting toLocaleDateString / toLocaleTimeString / Intl.DateTimeFormat / new Date(...).toLocaleString() that would show a
//                          day, or any date-time in the browser's locale. A month-and-year label ("Oct 2026") is not a day-bearing date and is
//                          allowed; a time-only call is allowed.
// NEGATIVE CONTROLS re-run the same scanner on mutated copies of the real sources (the exact labels that were reported on the live DEV
// page, and a native picker, and a locale-formatted day) and assert each is caught: a scanner that cannot fail proves nothing.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

export interface Violation {
  file: string;
  rule: 'iso-label' | 'native-date-picker' | 'locale-date-formatting';
  detail: string;
}

/** Machine-format tokens that are NOT shown to anyone: a file-format identifier, an AI prompt line, a URL template token. Exact lines only. */
const ALLOWED_MACHINE_TOKENS: ReadonlyArray<{ file: string; line: RegExp; why: string }> = [
  { file: 'lib/financial-data-hub/bank-csv/dateFormats.ts', line: /'YYYY-MM-DD'/, why: 'date-format identifier of a bank CSV file (parser input, never rendered)' },
  { file: 'lib/financial-data-hub/bank-csv/adapters/genericAdapters.ts', line: /dateFormat: 'YYYY-MM-DD'/, why: 'adapter declares the format its file uses' },
  { file: 'lib/financial-data-hub/investment/csvExtraction.ts', line: /parseDateWithFormat\(rawValuation, 'YYYY-MM-DD'\)/, why: 'parser input' },
  { file: 'lib/services/investment-intelligence/benchmarkData/apiTypes.ts', line: /dateFormat: 'YYYY-MM-DD' \|/, why: 'API field value type' },
  { file: 'lib/services/investment-intelligence/benchmarkData/routeSupport.ts', line: /z\.enum\(\['YYYY-MM-DD'/, why: 'API field value enum' },
  { file: 'lib/services/investment-intelligence/benchmarkData/fileIngest/types.ts', line: /\| 'YYYY-MM-DD'/, why: 'format identifier union' },
  { file: 'lib/services/investment-intelligence/benchmarkData/fileIngest/dateParsing.ts', line: /case 'YYYY-MM-DD': \{/, why: 'parser branch for that file format' },
  { file: 'components/admin/benchmarkData/benchmarkDataUiLogic.ts', line: /value: 'YYYY-MM-DD', label: 'Year first \(year, month, day\)'/, why: 'option VALUE (an identifier); the label a person reads is day-neutral' },
  { file: 'lib/services/investment-intelligence/marketIndex/dailyFeed.ts', line: /\{YYYY-MM-DD\}/, why: 'URL template token substituted before the request' },
  { file: 'lib/services/investment-intelligence/nav2/rbiAiReader.ts', line: /auctionDate \(the release date as yyyy-mm-dd/, why: 'instruction to the AI model; its answer is machine-read' },
  { file: 'lib/services/investment-intelligence/factsheetReader/aiExtractor.ts', line: /Dates are ISO yyyy-mm-dd/, why: 'instruction to the AI model; its answer is machine-read' },
];

/** Files whose locale/Intl use is the canonical formatter or a machine date-part reader, not a screen. */
const ALLOWED_LOCALE_FILES: ReadonlyArray<{ file: string; why: string }> = [
  { file: 'lib/engines/date.ts', why: 'the canonical day-first formatter: it takes only the 12-hour time from toLocaleTimeString' },
  { file: 'lib/read-models/core/window.ts', why: 'reads year/month/day PARTS in a named time zone (formatToParts) for a window, never shown' },
];

function stripComments(s: string): string {
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

/** The text between the "(" at `open` and its matching ")". */
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

const ISO_WORDS = /yyyy\s*[-/.]\s*mm\s*[-/.]\s*dd/i;

export function scan(file: string, rawSource: string): Violation[] {
  const out: Violation[] = [];
  const src = stripComments(rawSource);

  // 1. ISO wording in code (labels, placeholders, hints, messages).
  src.split('\n').forEach((line) => {
    if (!ISO_WORDS.test(line)) return;
    if (ALLOWED_MACHINE_TOKENS.some((a) => a.file === file && a.line.test(line))) return;
    out.push({ file, rule: 'iso-label', detail: line.trim().slice(0, 140) });
  });

  // 2. Native date picker.
  if (/\.tsx$/.test(file)) {
    for (const m of src.matchAll(/type\s*=\s*\{?\s*(?:"date"|'date')/g)) out.push({ file, rule: 'native-date-picker', detail: m[0] });
  }

  // 3. Browser-locale date rendering.
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
const rulesOf = (v: Violation[]) => new Set(v.map((x) => x.rule));

/** A mutation that must actually change the file (a control that changes nothing would prove nothing). */
function mutateOne(file: string, from: string | RegExp, to: string): (f: string, s: string) => string {
  return (f, s) => {
    if (f !== file) return s;
    const next = s.replace(from, to);
    if (next === s) throw new Error(`the control did not change ${file}: ${String(from)}`);
    return next;
  };
}

describe('repo-wide: no ISO date wording and no browser-locale dates on a screen', () => {
  it('walks the whole of app/, components/ and lib/ (guards against the walk silently emptying)', () => {
    expect(FILES.length).toBeGreaterThan(800);
    for (const must of ['components/admin/RiskFreeDataClient.tsx', 'components/admin/Nav2MonitoringClient.tsx', 'components/reports/FundAnalyticsReportClient.tsx', 'lib/services/investment-intelligence/nav2/riskFreeCsv.ts', 'app/api/investment-intelligence/xray/route.ts']) {
      expect(SOURCES.has(must), must).toBe(true);
    }
  });

  it('no yyyy-mm-dd wording, no native date picker, no day-bearing locale date anywhere', () => {
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

  it('the NAV2 admin and report screens carry the DD-MM-YYYY placeholder and hint through the shared date fields', () => {
    const risk = SOURCES.get('components/admin/RiskFreeDataClient.tsx') as string;
    expect(risk).toContain('<DateField');
    expect(risk).toContain("checkVerifiedThrough");
    expect(risk).toContain('checkCorrection');
    expect(/yyyy/i.test(risk.replace(/\/\/.*$/gm, ''))).toBe(false);
  });
});

describe('NEGATIVE CONTROLS: the scanner demonstrably catches each defect (each mutation changes a real source)', () => {
  const RISK = 'components/admin/RiskFreeDataClient.tsx';

  it('DATEWIDE-NC-1: the exact old Verified-through label from the live DEV page fails', () => {
    const v = scanAll(mutateOne(RISK, 'label="Verified through (optional)"', 'label="Verified through (yyyy-mm-dd, for the repo rate: the day it was last confirmed complete)"'));
    expect(v.some((x) => x.file === RISK && x.rule === 'iso-label')).toBe(true);
  });

  it('DATEWIDE-NC-2: the exact old placeholder="yyyy-mm-dd" fails', () => {
    const v = scanAll(mutateOne(RISK, 'label="Verified through (optional)"', 'label="Verified through (optional)" placeholder="yyyy-mm-dd"'));
    expect(v.some((x) => x.file === RISK && x.rule === 'iso-label')).toBe(true);
  });

  it('DATEWIDE-NC-3: the exact old correction label "Date (yyyy-mm-dd)" fails', () => {
    const v = scanAll(mutateOne(RISK, '<DateField label="Date"', '<DateField label="Date (yyyy-mm-dd)"'));
    expect(v.some((x) => x.file === RISK && x.rule === 'iso-label')).toBe(true);
  });

  it('DATEWIDE-NC-4: the old server messages that told the operator to type yyyy-mm-dd fail', () => {
    const a = scanAll(mutateOne('lib/services/investment-intelligence/nav2/riskFreeUploadService.ts', '`The "verified through" date is not a real date. ${DATE_INPUT_HINT}`', "'The \"verified through\" date is not a real date (use yyyy-mm-dd).'"));
    expect(a.some((x) => x.rule === 'iso-label')).toBe(true);
    const b = scanAll(mutateOne('lib/services/investment-intelligence/nav2/riskFreeCsv.ts', '`The date on this line is not a real calendar date. ${DATE_INPUT_HINT}`', "'The date on this line is not a real calendar date (use yyyy-mm-dd or day-first dd-mm-yyyy).'"));
    expect(b.some((x) => x.rule === 'iso-label')).toBe(true);
  });

  it('DATEWIDE-NC-5: the old import-panel field labels (Payslip, Liability) and the resources editor placeholders fail', () => {
    expect(rulesOf(scanAll(mutateOne('components/income/PayslipImportPanel.tsx', "'Pay period start'", "'Pay period start (YYYY-MM-DD)'"))).has('iso-label')).toBe(true);
    expect(rulesOf(scanAll(mutateOne('components/liabilities/LiabilityImportPanel.tsx', "'Statement date'", "'Statement date (YYYY-MM-DD)'"))).has('iso-label')).toBe(true);
    expect(rulesOf(scanAll(mutateOne('components/resources/editor/MetadataSidebar.tsx', '<DateTextField label="Expires At (optional)"', '<TextField placeholder="YYYY-MM-DD" label="Expires At (optional)"'))).has('iso-label')).toBe(true);
  });

  it('DATEWIDE-NC-6: the other separators and cases are caught too (YYYY/MM/DD, Yyyy-Mm-Dd)', () => {
    expect(scan('components/x.tsx', 'const a = "Use YYYY/MM/DD";').length).toBe(1);
    expect(scan('components/x.tsx', 'const a = "Use Yyyy-Mm-Dd";').length).toBe(1);
    expect(scan('components/x.tsx', '// only a comment says yyyy-mm-dd\nconst a = 1;').length).toBe(0);
  });

  it('DATEWIDE-NC-7: a native date picker is caught', () => {
    const f = 'app/(app)/goals/new/GoalCreationWizard.tsx';
    const v = scanAll(mutateOne(f, '<DateInput showHint', '<input type="date"'));
    expect(v.some((x) => x.file === f && x.rule === 'native-date-picker')).toBe(true);
  });

  it('DATEWIDE-NC-8: a locale-formatted day (the old ReportPreview / account-closure pattern) is caught', () => {
    const f = 'components/reports/ReportPreview.tsx';
    const v = scanAll(mutateOne(f, 'formatDateShort(c.due_date, currency)', "new Date(c.due_date).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })"));
    expect(v.some((x) => x.file === f && x.rule === 'locale-date-formatting')).toBe(true);
    const g = scanAll(mutateOne('components/profile/CloseAccountPanel.tsx', "formatDateShort(active.requested_at, 'AUD')", "new Date(active.requested_at).toLocaleDateString('en-AU', { year: 'numeric', month: 'short', day: 'numeric' })"));
    expect(g.some((x) => x.rule === 'locale-date-formatting')).toBe(true);
  });

  it('DATEWIDE-NC-9: a date-time in the browser locale (new Date(x).toLocaleString()) and a bare toLocaleDateString() are caught', () => {
    expect(scan('components/x.tsx', 'const a = new Date(v).toLocaleString();').some((x) => x.rule === 'locale-date-formatting')).toBe(true);
    expect(scan('components/x.tsx', 'const a = d.toLocaleDateString();').some((x) => x.rule === 'locale-date-formatting')).toBe(true);
  });

  it('DATEWIDE-NC-10: a month-and-year label and a time-only call are NOT flagged (the scanner is not over-eager)', () => {
    expect(scan('components/x.tsx', "const a = d.toLocaleDateString('en-AU', { month: 'short', year: 'numeric' });").length).toBe(0);
    expect(scan('components/x.tsx', "const a = d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });").length).toBe(0);
  });

  it('DATEWIDE-NC-11: the machine-token allowance is exact: a NEW iso label in an allowed file still fails', () => {
    const f = 'lib/financial-data-hub/bank-csv/dateFormats.ts';
    const v = scanAll((file, s) => (file === f ? `${s}\nexport const HELP = 'Type the date as yyyy-mm-dd';\n` : s));
    expect(v.some((x) => x.file === f && x.rule === 'iso-label')).toBe(true);
  });

  it('DATEWIDE-NC-12: the clean sources produce no violation (the controls above are not noise)', () => {
    expect(scanAll()).toEqual([]);
  });
});
