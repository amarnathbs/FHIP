// Fund analytics: SEVERAL reports as ONE print document (PO decision 20-10-2026) -- the address rules, the title, the page rules, the markup, and the print page's
// ownership / Premium / cap refusals.
//
// UNIT-TESTED here: lib/reports/fundAnalyticsCombinedPrint.ts, components/reports/FundAnalyticsCombinedPrintDocument.tsx (server-rendered markup) and
// app/(print)/reports/fund-analytics/print/page.tsx (with mocked sign-in and report store). The REAL page count, fill per page and "Page n of N" continuity of a
// combined PDF are measured in Chromium by scripts/print/faPrintLayoutCheck.ts --combined (see docs/reports/FUND_ANALYTICS_GENERATE_ALL_ONE_PDF_REPORT_2026-10-20.md).
//
// NAMED NEGATIVE CONTROLS (the guard is removed in a copy and the same check is shown to FAIL on it):
//   NC-CP1  an address parser with no cap lets 5 ids through;
//   NC-CP2  a page that does not refuse when ANY report is missing (a foreign id) would show the others (the source scan flags it);
//   NC-CP3  a page that does not pass the signed-in user's id to the report reader would read another person's report (the source scan flags it);
//   NC-CP4  a document that kept each report's own `html{--fa-print-version}` rule would print the LAST report's version line on every page (the markup check flags it);
//   NC-CP5  a title that is not made file-name safe would keep a character Windows rejects.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FundAnalyticsPrintDocument from '@/components/reports/FundAnalyticsPrintDocument';
import FundAnalyticsCombinedPrintDocument from '@/components/reports/FundAnalyticsCombinedPrintDocument';
import { FUND_ANALYTICS_TITLE_FALLBACK, fundAnalyticsPrintTitle } from '@/lib/reports/fundAnalyticsPrintTitle';
import { COMBINED_MAX_REPORTS, combinedIntroLine, combinedPageName, combinedPageRulesCss, combinedPrintHref, combinedPrintTitle, parseCombinedIds } from '@/lib/reports/fundAnalyticsCombinedPrint';
import { isPrintTitleFileNameSafe } from '@/lib/reports/printDocumentTitle';
import { versionMadeLinePrint } from '@/lib/engines/nav2/reportWording';
import { buildPrintFixture } from '../../scripts/nav2_print_fixtures';

const mockGetUser = vi.fn();
const mockCanView = vi.fn();
const mockGet = vi.fn();
const notFoundSpy = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); }, notFound: () => notFoundSpy() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mockGetUser } }) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ __admin: true }) }));
vi.mock('@/lib/services/entitlements', () => ({ canViewPremiumReport: (...a: unknown[]) => mockCanView(...a) }));
vi.mock('@/lib/services/investment-intelligence/nav2/fundAnalyticsReportService', async (orig) => {
  const actual = await orig<typeof import('@/lib/services/investment-intelligence/nav2/fundAnalyticsReportService')>();
  return { ...actual, getFundAnalyticsReport: (...a: unknown[]) => mockGet(...a) };
});
vi.mock('@/lib/services/investment-intelligence/nav2/fundAnalyticsRenderToken', () => ({ resolveNav2RenderToken: vi.fn() }));

import FundAnalyticsPrintPage, { generateMetadata } from '@/app/(print)/reports/fund-analytics/print/page';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';
const E = '55555555-5555-4555-8555-555555555555';
const FOREIGN = '99999999-9999-4999-8999-999999999999';

describe('the address: ?ids=', () => {
  it('reads one to four ids, in the order given, each once', () => {
    expect(parseCombinedIds(A)).toEqual([A]);
    expect(parseCombinedIds(`${A},${B}`)).toEqual([A, B]);
    expect(parseCombinedIds(`${B},${A},${C},${D}`)).toEqual([B, A, C, D]);
    expect(parseCombinedIds(`${A},${A},${B}`)).toEqual([A, B]);
    expect(parseCombinedIds(` ${A.toUpperCase()} , ${B} `)).toEqual([A, B]);
  });
  it('REFUSES (null): nothing, an empty entry, a value that is not an id, a repeated parameter, and more than the cap of 4', () => {
    expect(COMBINED_MAX_REPORTS).toBe(4);
    for (const bad of [undefined, null, '', ',', `${A},`, `,${A}`, `${A},,${B}`, 'abc', `${A},not-an-id`, `${A};${B}`, `${A} ${B}`, `${A},${B},${C},${D},${E}`, [A, B] as never, `${A}'--`, '../../etc/passwd']) {
      expect(parseCombinedIds(bad as never), String(bad)).toBeNull();
    }
  });
  it('NC-CP1: a parser with no cap lets five ids through (the cap check catches it)', () => {
    const noCap = (raw: string) => raw.split(',').map((p) => p.trim());
    const five = `${A},${B},${C},${D},${E}`;
    expect(parseCombinedIds(five)).toBeNull();
    expect(noCap(five).length).toBeGreaterThan(COMBINED_MAX_REPORTS);
  });
  it('the address the screen opens carries the ids, print=1 and the viewer time zone', () => {
    expect(combinedPrintHref([A, B], 'Australia/Sydney')).toBe(`/reports/fund-analytics/print?ids=${A},${B}&print=1&tz=Australia%2FSydney`);
    expect(combinedPrintHref([A, B], null)).toBe(`/reports/fund-analytics/print?ids=${A},${B}&print=1`);
    expect(parseCombinedIds(new URL(`http://t${combinedPrintHref([A, B], 'Asia/Kolkata')}`).searchParams.get('ids'))).toEqual([A, B]);
  });
});

describe('the title (the default file name of Save as PDF)', () => {
  it('"FHIP Fund Analytics - October 2026 - Versions 4 and 5": month in words, versions ascending', () => {
    expect(combinedPrintTitle([{ asOfDate: '2026-10-20', versionNumber: 4 }, { asOfDate: '2026-10-20', versionNumber: 5 }])).toBe('FHIP Fund Analytics - October 2026 - Versions 4 and 5');
    expect(combinedPrintTitle([{ asOfDate: '2026-10-20', versionNumber: 6 }, { asOfDate: '2026-10-20', versionNumber: 4 }, { asOfDate: '2026-10-20', versionNumber: 5 }])).toBe('FHIP Fund Analytics - October 2026 - Versions 4, 5 and 6');
    expect(combinedPrintTitle([1, 2, 3, 4].map((v) => ({ asOfDate: '2026-10-20', versionNumber: v })))).toBe('FHIP Fund Analytics - October 2026 - Versions 1, 2, 3 and 4');
  });
  it('the month is the latest as-at month of the reports (never made up); one report gives the single report\'s own title', () => {
    expect(combinedPrintTitle([{ asOfDate: '2026-09-30', versionNumber: 4 }, { asOfDate: '2026-10-01', versionNumber: 5 }])).toBe('FHIP Fund Analytics - October 2026 - Versions 4 and 5');
    expect(combinedPrintTitle([{ asOfDate: '2026-10-20', versionNumber: 4 }])).toBe(fundAnalyticsPrintTitle('2026-10-20', 4));
  });
  it('a missing or malformed part falls back to the plain name; it is always file-name safe and never contains a numeric date', () => {
    for (const bad of [[], [{ asOfDate: null, versionNumber: 4 }, { asOfDate: '2026-10-20', versionNumber: 5 }], [{ asOfDate: '2026-13-20', versionNumber: 4 }, { asOfDate: '2026-10-20', versionNumber: 5 }], [{ asOfDate: '2026-10-20', versionNumber: 0 }, { asOfDate: '2026-10-20', versionNumber: 5 }], [{ asOfDate: '2026-10-20', versionNumber: 1.5 }, { asOfDate: '2026-10-20', versionNumber: 5 }]]) {
      expect(combinedPrintTitle(bad as never), JSON.stringify(bad)).toBe(FUND_ANALYTICS_TITLE_FALLBACK);
    }
    const t = combinedPrintTitle([{ asOfDate: '2026-10-20', versionNumber: 4 }, { asOfDate: '2026-10-20', versionNumber: 5 }]);
    expect(isPrintTitleFileNameSafe(t)).toBe(true);
    expect(t).not.toMatch(/\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{4}-\d{2}-\d{2}/);
  });
  it('NC-CP5: a title with an unsafe character is not file-name safe, so the check can fail', () => {
    expect(isPrintTitleFileNameSafe('FHIP Fund Analytics - Versions 4/5')).toBe(false);
    expect(isPrintTitleFileNameSafe('FHIP Fund Analytics: Versions 4 and 5')).toBe(false);
  });
});

describe('the one line at the start', () => {
  it('says how many reports, how many funds, and that funds are compared only within the same report', () => {
    expect(combinedIntroLine(2, 17)).toBe('This document combines 2 reports covering your 17 funds. Funds are compared only within the same report.');
    expect(combinedIntroLine(3, 1)).toContain('your 1 fund.');
  });
});

describe('the page rules', () => {
  const lines = ['Version 4, made 20-10-2026, 11:08 am UTC', 'Version 5, made 20-10-2026, 11:09 am UTC'];
  const css = combinedPageRulesCss(lines);
  it('one named page per report, each with ITS OWN version line; reports 2+ start on a fresh page', () => {
    expect(combinedPageName(1)).toBe('fa1');
    expect(css).toContain('@page fa1{');
    expect(css).toContain('@page fa2{');
    expect(css).toContain(`content:"${lines[0]}"`);
    expect(css).toContain(`content:"${lines[1]}"`);
    expect(css.indexOf(lines[0])).toBeLessThan(css.indexOf('@page fa2'));
    expect(css).toContain('.fa-combined-part-1{page:fa1}');
    expect(css).toContain('.fa-combined-part-2{page:fa2;break-before:page;page-break-before:always}');
    expect(css.startsWith('@media print{')).toBe(true);
  });
  it('the page counter is the document\'s own: "Page n of N" on every named page', () => {
    expect(count(css, "content:'Page ' counter(page) ' of ' counter(pages)")).toBe(2);
  });
  it('size, margins, fonts and the other margin boxes are exactly those of @page fa in app/globals.css (so a combined page looks like a single report page)', () => {
    const braces = (text: string, from: number): string => {
      let depth = 0;
      for (let i = text.indexOf('{', from); i < text.length; i++) {
        if (text[i] === '{') depth += 1;
        if (text[i] === '}' && --depth === 0) return text.slice(text.indexOf('{', from), i + 1);
      }
      throw new Error('unbalanced');
    };
    const norm = (t: string) => t.replace(/\s+/g, '').replace(/"/g, "'").replace(/;}/g, '}').replace(/'Segoe UI'/g, "'SegoeUI'");
    // the version box differs on purpose (the single document reads a page-wide variable, a combined part has its own line): compare the rest
    const withoutVersionBox = (t: string) => t.replace(/@top-right\{[^}]*\}/, '@top-right{}');
    const globals = read('app/globals.css');
    const fa = norm(braces(globals, globals.indexOf('@page fa {')));
    const mine = norm(braces(css, css.indexOf('@page fa1{')));
    expect(withoutVersionBox(mine)).toBe(withoutVersionBox(fa));
    expect(fa).toContain('@top-right{content:var(--fa-print-version');
    expect(mine).toContain("@top-right{content:'Version4,made20-10-2026,11:08amUTC'");
  });
  it('a character that could end the rule or the element is removed from a version line', () => {
    const bad = combinedPageRulesCss(['Version 1 "}</style><script>alert(1)</script>']);
    expect(bad).not.toContain('</style>');
    expect(bad).not.toContain('<script>');
    expect((bad.match(/"/g) ?? []).length).toBe(2);
  });
});

describe('the combined document (markup)', () => {
  const r1 = buildPrintFixture({ funds: 4 }).report;
  // the fixture generator names funds and ids the same way every time: make report 2 a DIFFERENT set of funds (as a second batch is), so mixing would show
  const r2raw = buildPrintFixture({ funds: 2 }).report;
  const r2 = JSON.parse(r2raw.schemes.reduce((json, sc) => json.split(sc.instrumentId).join(`batch2-${sc.instrumentId}`), JSON.stringify(r2raw)).split('"schemeName":"').join('"schemeName":"Second batch ')) as typeof r2raw;
  const v1 = { versionNumber: 4, createdAt: '2026-10-20T01:08:00.000Z' };
  const v2 = { versionNumber: 5, createdAt: '2026-10-20T01:09:00.000Z' };
  const parts = [{ report: r1, version: v1 }, { report: r2, version: v2 }];
  const html = renderToStaticMarkup(createElement(FundAnalyticsCombinedPrintDocument, { parts, timeZone: 'Asia/Kolkata' }));

  it('the explanation is printed ONCE, at the start, before the first report', () => {
    const intro = 'This document combines 2 reports covering your 6 funds. Funds are compared only within the same report.';
    expect(count(html, intro)).toBe(1);
    expect(html.indexOf(intro)).toBeLessThan(html.indexOf('class="fa-doc"'));
    expect(html.indexOf(intro)).toBeLessThan(html.indexOf('<h1>Fund analytics report</h1>'));
  });
  it('each report is the UNCHANGED single document: its markup appears verbatim, in order, and nothing of it is merged or dropped', () => {
    const single = (r: typeof r1, v: typeof v1) => renderToStaticMarkup(createElement(FundAnalyticsPrintDocument, { report: r, version: v, timeZone: 'Asia/Kolkata', combinedPart: true }));
    const s1 = single(r1, v1);
    const s2 = single(r2, v2);
    expect(html).toContain(s1);
    expect(html).toContain(s2);
    expect(html.indexOf(s1)).toBeLessThan(html.indexOf(s2));
    expect(count(html, 'class="fa-cover"')).toBe(2);
    expect(count(html, 'Comparing your funds')).toBe(2); // each report keeps its OWN comparison
    expect(count(html, 'data-fa-comparison=')).toBe(2);
    // the funds of report 1 are not in report 2's markup and vice versa (no mixing): compare the part markup
    const part2 = html.slice(html.indexOf('data-fa-part="2"'));
    for (const s of r1.schemes) if (!r2.schemes.some((x) => x.instrumentId === s.instrumentId)) expect(part2).not.toContain(`>${s.schemeName}<`);
  });
  it('part 2 starts on a fresh page and each part sits on its own named page', () => {
    expect(html).toContain('fa-combined-part fa-combined-part-1');
    expect(html).toContain('fa-combined-part fa-combined-part-2');
    expect(html).toContain('@page fa1{');
    expect(html).toContain('@page fa2{');
    expect(html).toContain('break-before:page');
  });
  it('the running header names each report\'s own version, in the viewer\'s time zone', () => {
    expect(html).toContain(`content:"${versionMadeLinePrint(4, v1.createdAt, r1.displayCurrency, 'Asia/Kolkata')}"`);
    expect(html).toContain(`content:"${versionMadeLinePrint(5, v2.createdAt, r2.displayCurrency, 'Asia/Kolkata')}"`);
  });
  it('NC-CP4: no part sets the single document\'s page-wide version variable (it would be the LAST report\'s line on every page); the single document still does', () => {
    expect(html).not.toContain('--fa-print-version');
    const alone = renderToStaticMarkup(createElement(FundAnalyticsPrintDocument, { report: r1, version: v1 }));
    expect(alone).toContain('--fa-print-version');
    const broken = renderToStaticMarkup(createElement(FundAnalyticsPrintDocument, { report: r1, version: v1, combinedPart: false }));
    expect(broken).toContain('--fa-print-version'); // what the combined part would print without the flag
  });
  it('the print stylesheet lets the named page of a part win over the single document\'s own page: ".fa-combined-part .fa-doc { page: auto }"', () => {
    expect(read('app/globals.css')).toMatch(/\.fa-combined-part \.fa-doc \{ page: auto; \}/);
  });
  it('a single document is byte-for-byte what it was (the new prop defaults off)', () => {
    const a = renderToStaticMarkup(createElement(FundAnalyticsPrintDocument, { report: r1, version: v1 }));
    const b = renderToStaticMarkup(createElement(FundAnalyticsPrintDocument, { report: r1, version: v1, combinedPart: false }));
    expect(a).toBe(b);
  });
});

// ---- the print page ---------------------------------------------------------------------------------------------------------------------------
const mk = (id: string, userId: string, versionNumber: number, funds: number) => {
  const { report } = buildPrintFixture({ funds });
  return { userId, id, found: { summary: { id, versionNumber, asOfDate: '2026-10-20', schemeCount: funds, createdAt: '2026-10-20T01:08:00.000Z', periodChoice: 'all_history' }, report, manifestChecksum: 'a'.repeat(64) } };
};
const store = new Map<string, ReturnType<typeof mk>['found']>();
const seed = (...rows: ReturnType<typeof mk>[]) => {
  store.clear();
  for (const r of rows) store.set(`${r.userId}|${r.id}`, r.found);
};

type PageEl = { props: { children: Array<{ type: unknown; props: Record<string, unknown> }> } };
const page = (sp: Record<string, unknown>) => FundAnalyticsPrintPage({ searchParams: Promise.resolve(sp) as never });

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: { id: 'me' } } });
  mockCanView.mockResolvedValue(true);
  // the real reader filters by user id: another user's report is "not found"
  mockGet.mockImplementation(async (_client: unknown, userId: string, id: string) => store.get(`${userId}|${id}`) ?? null);
  seed(mk(A, 'me', 4, 3), mk(B, 'me', 5, 2), mk(C, 'me', 6, 1), mk(D, 'me', 7, 1), mk(E, 'me', 8, 1), mk(FOREIGN, 'someone-else', 9, 2));
});

describe('the print page, ?ids= (ownership, Premium, cap)', () => {
  it('two of the person\'s own reports render as one combined document, in the order given; every report is read with the signed-in user\'s id', async () => {
    const el = (await page({ ids: `${A},${B}`, print: '1' })) as unknown as PageEl;
    const [toolbar, doc] = el.props.children;
    expect(toolbar.props.autoPrint).toBe(true);
    expect(toolbar.props.documentTitle).toBe('FHIP Fund Analytics - October 2026 - Versions 4 and 5');
    expect((doc.props.parts as Array<{ version: { versionNumber: number } }>).map((p) => p.version.versionNumber)).toEqual([4, 5]);
    expect(mockGet.mock.calls.map((c) => c.slice(1))).toEqual([['me', A], ['me', B]]);
  });
  it('NC-F-ownership: ONE foreign id among the person\'s own refuses the whole page (404), the same as an unknown id, and shows none of the others', async () => {
    await expect(page({ ids: `${A},${FOREIGN}` })).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(page({ ids: `${FOREIGN},${A}` })).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(page({ ids: `${A},77777777-7777-4777-8777-777777777777` })).rejects.toThrow('NEXT_NOT_FOUND'); // unknown id: same refusal
    await expect(page({ ids: FOREIGN })).rejects.toThrow('NEXT_NOT_FOUND');
  });
  it('more than 4 ids, a malformed id and a repeated parameter are refused BEFORE any report is read', async () => {
    for (const ids of [`${A},${B},${C},${D},${E}`, `${A},nope`, [A, B], '']) {
      mockGet.mockClear();
      await expect(page({ ids })).rejects.toThrow('NEXT_NOT_FOUND');
      expect(mockGet).not.toHaveBeenCalled();
    }
  });
  it('exactly 4 ids are allowed', async () => {
    const el = (await page({ ids: `${A},${B},${C},${D}` })) as unknown as PageEl;
    expect((el.props.children[1].props.parts as unknown[]).length).toBe(4);
    expect(el.props.children[0].props.documentTitle).toBe('FHIP Fund Analytics - October 2026 - Versions 4, 5, 6 and 7');
  });
  it('a free user gets the 404 before anything is read; no session redirects to the login page', async () => {
    mockCanView.mockResolvedValue(false);
    await expect(page({ ids: `${A},${B}` })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockGet).not.toHaveBeenCalled();
    mockCanView.mockResolvedValue(true);
    mockGetUser.mockResolvedValue({ data: { user: null } });
    await expect(page({ ids: `${A},${B}` })).rejects.toThrow('REDIRECT:/login');
  });
  it('the title for the browser comes from generateMetadata: combined for own ids, the plain name for anything refused (no information about the ids)', async () => {
    const own = await generateMetadata({ searchParams: Promise.resolve({ ids: `${A},${B}` }) });
    expect(own.title).toEqual({ absolute: 'FHIP Fund Analytics - October 2026 - Versions 4 and 5' });
    for (const ids of [`${A},${FOREIGN}`, `${A},${B},${C},${D},${E}`, 'junk']) {
      expect((await generateMetadata({ searchParams: Promise.resolve({ ids }) })).title).toEqual({ absolute: FUND_ANALYTICS_TITLE_FALLBACK });
    }
  });
  it('the single-report path (?id=) is unchanged', async () => {
    const el = (await page({ id: A, print: '1' })) as unknown as PageEl;
    expect(el.props.children[1].type).toBe(FundAnalyticsPrintDocument);
    expect(el.props.children[0].props.documentTitle).toBeUndefined();
    expect((await generateMetadata({ searchParams: Promise.resolve({ id: A }) })).title).toEqual({ absolute: fundAnalyticsPrintTitle('2026-10-20', 4) });
    await expect(page({ id: FOREIGN })).rejects.toThrow('NEXT_NOT_FOUND');
  });
});

describe('the print page source guards (with negative controls)', () => {
  const page_src = read('app/(print)/reports/fund-analytics/print/page.tsx');
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  /** What a safe combined branch must contain; returns the guards that are missing. */
  const missingGuards = (src: string): string[] => {
    const c = code(src);
    const out: string[] = [];
    if (!/getFundAnalyticsReport\(supabase, userId, rid\)/.test(c) || !/getOwnReports\(supabase, user\.id, parseCombinedIds\(ids\)\)/.test(c)) out.push('reads with the signed-in user id');
    if (!/found\.every\(/.test(c)) out.push('refuses when ANY report is missing');
    if (!/if \(!own\) notFound\(\);/.test(c)) out.push('404 on a refused set');
    if (!/if \(!ids\) return null;/.test(c)) out.push('a refused address reads nothing');
    if (!/canViewPremiumReport\(user\.id, supabase\)\)\) notFound\(\);\s*const own/.test(c)) out.push('Premium before reading');
    return out;
  };
  it('the real page has every guard', () => {
    expect(missingGuards(page_src)).toEqual([]);
  });
  it('the token branch (the headless renderer) is untouched: it comes first, mentions no ids, and still resolves the single-use token', () => {
    const c = code(page_src);
    const tokenBranch = c.slice(c.indexOf('if (token) {'), c.indexOf('const supabase = await createClient();', c.indexOf('if (token) {')));
    expect(tokenBranch.length).toBeGreaterThan(50);
    expect(tokenBranch).not.toContain('ids');
    expect(tokenBranch).toContain('resolveNav2RenderToken(admin, token)');
    expect(c.indexOf('if (token) {')).toBeLessThan(c.indexOf('if (ids !== undefined) {', c.indexOf('if (token) {')));
  });
  it('NC-CP2: without the "ANY report missing" refusal the guard check fails', () => {
    const mutated = page_src.replace('found.every((f): f is OwnReport => f !== null) ? (found as OwnReport[]) : null', '(found.filter((f): f is OwnReport => f !== null))');
    expect(mutated).not.toBe(page_src);
    expect(missingGuards(mutated)).toContain('refuses when ANY report is missing');
  });
  it('NC-CP3: reading with some other user id (or none) fails the guard check', () => {
    const mutated = page_src.replace('getFundAnalyticsReport(supabase, userId, rid)', 'getFundAnalyticsReport(supabase, rid, rid)');
    expect(missingGuards(mutated)).toContain('reads with the signed-in user id');
  });
  it('a page without the Premium check before reading fails the guard check', () => {
    const mutated = page_src.replace('if (!(await canViewPremiumReport(user.id, supabase))) notFound();\n    const own', 'const own');
    expect(mutated).not.toBe(page_src);
    expect(missingGuards(mutated)).toContain('Premium before reading');
  });
});
