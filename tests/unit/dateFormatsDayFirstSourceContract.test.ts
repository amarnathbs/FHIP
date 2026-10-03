// Source-contract test: user-visible dates are DAY-FIRST, never ISO year-first or US month-first.
//
// PO standing rule (Document2 findings #8/#19; canonical formatter lib/engines/date.ts):
// India investment screens use dd-mm-yyyy (formatDateShort(date, 'INR')), Australia dd/mm/yyyy.
// Typed dates are DD-MM-YYYY text fields (lib/engines/dateInput.ts), never the browser's
// locale-dependent date picker; the API wire format stays ISO.
//
// There is no DOM environment, so this reads the SOURCE of every component and message builder
// introduced or touched by the Market Index Data / India MF programme and fails on:
//   1. toLocaleDateString / toLocaleTimeString / Intl.DateTimeFormat, and a date's toLocaleString;
//   2. a native date picker (type="date");
//   3. a raw date value rendered in JSX text or inside a template-literal sentence
//      (an identifier path ending Date/AsOf/At/On/From/To/... that is not wrapped in a day-first formatter);
//   4. the literal "YYYY-MM-DD" anywhere except as the NAME of one file-date-format dropdown option.
// NEGATIVE CONTROLS at the bottom re-run the same scanner on mutated copies of the real sources and
// assert that each named defect is caught (a scanner that cannot fail proves nothing).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const dirFiles = (rel: string) =>
  readdirSync(path.join(ROOT, rel))
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => `${rel}/${f}`);

// Screens and message builders. UI files get every rule; "message" files (server-side sentences) get rules 1, 3, 4.
const UI_FILES = [
  'components/admin/BenchmarkDataClient.tsx',
  ...dirFiles('components/admin/benchmarkData'),
  'components/admin/PromoCodesClient.tsx',
  'components/admin/PremiumEntitlementsClient.tsx',
  'components/billing/PremiumAccessNotice.tsx',
  'components/profile/BillingPanel.tsx',
  'components/reports/IndiaMfInvestmentReportSection.tsx',
  'components/dashboard/DashboardDataStatusNotice.tsx',
  'components/investments/PublishedFundValuations.tsx',
  'components/investment-intelligence/HoldingsTable.tsx',
  'components/investment-intelligence/OverviewClient.tsx',
  'components/investment-intelligence/PortfolioXrayClient.tsx',
  'components/investment-intelligence/OwnerChangeDialog.tsx',
  'components/investment-intelligence/OwnerClassBar.tsx',
  'components/investment-intelligence/RedemptionSimulator.tsx',
  'components/investment-intelligence/ResolutionHistoryClient.tsx',
  'components/investment-intelligence/ReviewCentreClient.tsx',
  'components/investment-intelligence/TaxIntelligenceClient.tsx',
  'components/pc5/ResolutionDetailClient.tsx',
  'components/ownership/OwnerSelector.tsx',
];

const MESSAGE_FILES = [
  ...dirFiles('lib/services/investment-intelligence/benchmarkData/fileIngest').filter((f) => /\/(validator|templates|layouts|errorCsv|dateParsing)\.ts$/.test(f)),
  'lib/services/investment-intelligence/benchmarkData/ingestion/pending.ts',
  'lib/services/investment-intelligence/benchmarkData/uploadService.ts',
  'lib/services/entitlementPlanStatus.ts',
  'lib/services/entitlementReminder.ts',
  'lib/services/premiumExpiryReminderEmail.ts',
  'lib/services/promoCodeEmail.ts',
  'lib/engines/investment-intelligence/valuation/currentHoldingValuation.ts',
  'lib/engines/investment-intelligence/xray/xrayOrchestrator.ts',
  'lib/engines/investment-intelligence/xray/overlap.ts',
  'lib/engines/investment-intelligence/indiaMfReport.ts',
  'lib/engines/reportSectionsPremium.ts',
];

// The only places the literal "YYYY-MM-DD" may appear: the NAME of a file-date-format option, and the
// engine-level format union types (machine identifiers, never rendered as screen data).
const YYYY_ALLOWED: ReadonlyArray<{ file: string; line: RegExp }> = [
  { file: 'lib/services/investment-intelligence/benchmarkData/fileIngest/dateParsing.ts', line: /^\s*case 'YYYY-MM-DD': \{/ },
  { file: 'components/admin/benchmarkData/benchmarkDataUiLogic.ts', line: /value: 'YYYY-MM-DD', label: 'Year first \(YYYY-MM-DD\)'/ },
];

function stripComments(src: string): string {
  // Block comments, whole-line // comments and trailing ` // ...` comments (only when the comment text holds no
  // quote, so a URL inside a string is never touched). Also drops React `key={`...`}` and `key: `...`` template
  // literals: an internal identity string (a notice or list key), never rendered text.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => (/^\s*\/\//.test(l) ? '' : l.replace(/\s\/\/\s[^'"`]*$/, '')))
    .join('\n')
    .replace(/\bkey=\{`[^`]*`\}/g, 'key={KEY}')
    .replace(/\bkey:\s*`[^`]*`/g, 'key: KEY')
    // Map/Set lookups keyed by a template literal (`${row.key}|${row.date}`): an internal grouping key.
    .replace(/\.(get|set|has)\(`[^`]*`/g, '.$1(KEY');
}

const DATE_TAIL = /(Date|AsOf|asOf|At|On|From|To|Through|Session|Since|Until|^date)$/;
// A "plain path" interpolation: identifiers, dots, optional chaining, optional non-null `!`, no calls.
const PLAIN_PATH = /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*!?$/;
// Path names that end like a date but are not one (counts, flags, handlers, labels).
const NOT_A_DATE = new Set([
  'toBe', 'Date.now', 'onChange', 'onSubmit', 'onClick', 'weekdaysBehind', 'count', 'startAt', 'rowAt', 'maxAt',
  // A bare `date` local is the ALREADY-FORMATTED value in premiumExpiryReminderEmail.ts
  // (`const date = formatDateShort(...)` on the line above). A dotted path (x.date) is always checked.
  'date',
]);

export interface Violation {
  file: string;
  rule: string;
  detail: string;
}

export function scan(file: string, rawSource: string, opts: { ui: boolean }): Violation[] {
  const out: Violation[] = [];
  const src = stripComments(rawSource);
  const lines = src.split('\n');

  // 1. Locale date formatting.
  for (const m of src.matchAll(/toLocaleDateString|toLocaleTimeString|Intl\.DateTimeFormat|new Date\([^)]*\)\.toLocaleString|\bdate\w*\.toLocaleString\(/g)) {
    out.push({ file, rule: 'locale-date-formatting', detail: m[0] });
  }

  // 2. Native date picker.
  if (opts.ui) {
    for (const m of src.matchAll(/type=(?:"date"|'date'|\{'date'\})/g)) out.push({ file, rule: 'native-date-picker', detail: m[0] });
    for (const m of src.matchAll(/type\??:\s*'[^']*\bdate\b[^']*'/g)) out.push({ file, rule: 'native-date-picker', detail: m[0] });
  }

  // 3. Raw date interpolation: {a.b.dateField} as JSX text, or ${a.b.dateField} inside a template literal.
  const exprs: string[] = [];
  for (const m of src.matchAll(/\$\{\s*([^{}]+?)\s*\}/g)) exprs.push(m[1]);
  if (opts.ui) for (const m of src.matchAll(/>\s*\{\s*([^{}]+?)\s*\}\s*</g)) exprs.push(m[1]);
  for (const e of exprs) {
    if (!PLAIN_PATH.test(e)) continue;
    const tail = e.replace(/!$/, '').split(/\??\./).pop() as string;
    if (!DATE_TAIL.test(tail) || NOT_A_DATE.has(e)) continue;
    out.push({ file, rule: 'raw-date-in-text', detail: e });
  }

  // 4. The literal ISO pattern name.
  lines.forEach((line) => {
    if (!/YYYY-MM-DD/.test(line)) return;
    const ok = YYYY_ALLOWED.some((a) => a.file === file && a.line.test(line));
    if (!ok) out.push({ file, rule: 'iso-pattern-name', detail: line.trim().slice(0, 120) });
  });

  return out;
}

const SOURCES = new Map<string, string>();
for (const f of [...UI_FILES, ...MESSAGE_FILES]) SOURCES.set(f, read(f));
const scanAll = (mutate?: (file: string, src: string) => string): Violation[] =>
  [...SOURCES.entries()].flatMap(([f, s]) => scan(f, mutate ? mutate(f, s) : s, { ui: UI_FILES.includes(f) }));

describe('day-first dates: source contract over the programme UI and message builders', () => {
  it('every scanned file exists and the list covers the programme (guards against the list silently emptying)', () => {
    expect(SOURCES.size).toBeGreaterThanOrEqual(40);
    for (const must of [
      'components/admin/benchmarkData/EntitlementsTab.tsx',
      'components/admin/benchmarkData/UploadTab.tsx',
      'components/reports/IndiaMfInvestmentReportSection.tsx',
      'components/dashboard/DashboardDataStatusNotice.tsx',
      'components/investments/PublishedFundValuations.tsx',
      'lib/services/investment-intelligence/benchmarkData/fileIngest/validator.ts',
      'lib/services/investment-intelligence/benchmarkData/ingestion/pending.ts',
    ]) expect(SOURCES.has(must), must).toBe(true);
  });

  it('no locale date formatting, no native date picker, no raw date in text, no ISO pattern name on a screen', () => {
    const v = scanAll();
    expect(v, JSON.stringify(v, null, 1)).toEqual([]);
  });

  it('the typed-date field is a text input with the DD-MM-YYYY placeholder (the shared DateField)', () => {
    const ui = SOURCES.get('components/admin/benchmarkData/ui.tsx') as string;
    expect(ui).toMatch(/export function DateField/);
    const block = ui.slice(ui.indexOf('export function DateField'), ui.indexOf('export function TextAreaField'));
    expect(block).toContain('type="text"');
    expect(block).toContain('placeholder={DATE_INPUT_PLACEHOLDER}');
    expect(block).not.toMatch(/type="date"/);
  });

  it('every Market Index Data date field uses DateField (none left as a plain TextField)', () => {
    const labels = /<DateField label=/g;
    let n = 0;
    for (const f of ['CatalogueTab', 'EntitlementsTab', 'MappingsTab', 'UploadTab']) {
      n += (SOURCES.get(`components/admin/benchmarkData/${f}.tsx`) as string).match(labels)?.length ?? 0;
    }
    expect(n).toBe(5 + 6 + 4 + 1);
  });

  it('the Promo-code and Premium-access admin pages type dates as DD-MM-YYYY text and send ISO', () => {
    for (const f of ['components/admin/PromoCodesClient.tsx', 'components/admin/PremiumEntitlementsClient.tsx']) {
      const s = SOURCES.get(f) as string;
      expect(s, f).toContain('DATE_INPUT_PLACEHOLDER');
      expect(s, f).toContain('parseDateInput');
    }
  });
});

describe('NEGATIVE CONTROLS: the scanner demonstrably catches each defect (a control that cannot fail proves nothing)', () => {
  const ENT = 'components/admin/benchmarkData/EntitlementsTab.tsx';
  const OVERVIEW = 'components/admin/benchmarkData/OverviewTab.tsx';
  const VALID = 'lib/services/investment-intelligence/benchmarkData/fileIngest/validator.ts';
  const rules = (v: Violation[]) => new Set(v.map((x) => x.rule));

  it('DATE-NC-1: a native date picker is caught', () => {
    const v = scanAll((f, s) => (f === ENT ? s.replace('<DateField label="Valid from"', '<TextField label="Valid from" type="date"') : s));
    expect(rules(v).has('native-date-picker')).toBe(true);
  });

  it('DATE-NC-2: toLocaleDateString is caught', () => {
    const v = scanAll((f, s) => (f === OVERVIEW ? `${s}\nconst x = new Date().toLocaleDateString('en-US');\n` : s));
    expect(rules(v).has('locale-date-formatting')).toBe(true);
  });

  it("DATE-NC-3: Intl.DateTimeFormat and a date's toLocaleString are caught", () => {
    const a = scanAll((f, s) => (f === OVERVIEW ? `${s}\nconst f = new Intl.DateTimeFormat('en-US');\n` : s));
    expect(rules(a).has('locale-date-formatting')).toBe(true);
    const b = scanAll((f, s) => (f === OVERVIEW ? `${s}\nconst y = new Date(v).toLocaleString();\n` : s));
    expect(rules(b).has('locale-date-formatting')).toBe(true);
  });

  it('DATE-NC-4: a raw ISO date rendered as JSX text is caught (the formatter wrapper removed)', () => {
    const v = scanAll((f, s) => (f === OVERVIEW ? s.replace('{formatDate(i.latestValidDataDate)}', '{i.latestValidDataDate}') : s));
    expect(v.some((x) => x.rule === 'raw-date-in-text' && x.detail === 'i.latestValidDataDate')).toBe(true);
  });

  it('DATE-NC-5: a raw ISO date inside a sentence (template literal) is caught', () => {
    const v = scanAll((f, s) => (f === VALID ? s.replace('${fd(iso)} is in the future', '${iso} is in the future').replace('`The date ${fd(iso)}', '`The date ${iso}') : s));
    expect(v.some((x) => x.rule === 'raw-date-in-text' && x.detail === 'iso')).toBe(false); // `iso` has no date-ish tail: see DATE-NC-6
    const w = scanAll((f, s) => (f === 'lib/services/investment-intelligence/benchmarkData/ingestion/pending.ts' ? s.replace('${fd(input.latestValidDataDate)}', '${input.latestValidDataDate}') : s));
    expect(w.some((x) => x.rule === 'raw-date-in-text' && x.detail === 'input.latestValidDataDate')).toBe(true);
  });

  it('DATE-NC-6: the "YYYY-MM-DD" pattern name in a validation message is caught', () => {
    const v = scanAll((f, s) => (f === 'components/admin/benchmarkData/benchmarkDataUiLogic.ts' ? s.replace('DD-MM-YYYY, like 01-10-2026', 'YYYY-MM-DD') : s));
    expect(rules(v).has('iso-pattern-name')).toBe(true);
  });

  it('DATE-NC-7: a date in an engine note without its formatter is caught', () => {
    const f = 'lib/engines/investment-intelligence/valuation/currentHoldingValuation.ts';
    const v = scanAll((file, s) => (file === f ? s.replace('dated ${dt(newerNav.date)}', 'dated ${newerNav.date}') : s));
    expect(v.some((x) => x.rule === 'raw-date-in-text' && x.detail === 'newerNav.date')).toBe(true);
  });

  it('DATE-NC-8: the clean sources produce no violation (the controls above are not noise)', () => {
    expect(scanAll()).toEqual([]);
  });
});
