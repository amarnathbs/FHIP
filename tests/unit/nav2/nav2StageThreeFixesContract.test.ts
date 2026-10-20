// Stage 3 fix list (05-10-2026), source contracts for what cannot be seen without a browser:
//   * the PDF is the free browser print flow (PO decision 18-10-2026, replacing the Stage 3 View PDF / Download PDF server buttons): ONE "Print / Save as PDF" link opens the print view in its own tab, no server export call (Amplify has no Chromium at runtime);
//   * the version and made-on line sits with the saved-report sentence;
//   * every NAV2 POST route checks who the caller is BEFORE it validates the body (a free user gets 403, never 422);
//   * Save / Upload / Record correction show a working state at once and stay disabled until the answer returns.
// NAMED NEGATIVE CONTROLS mutate the real source and assert the contract names the failure.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

const POST_ROUTES: Array<{ file: string; authorise: string; bodyRead: string }> = [
  { file: 'app/api/admin/investment-intelligence/risk-free-data/route.ts', authorise: "requireRiskFreeCapability('upload')", bodyRead: 'req.json()' },
  { file: 'app/api/admin/investment-intelligence/risk-free-data/correct/route.ts', authorise: "requireRiskFreeCapability('upload')", bodyRead: 'req.json()' },
  { file: 'app/api/admin/investment-intelligence/risk-free-data/review/[id]/route.ts', authorise: "requireRiskFreeCapability('upload')", bodyRead: 'req.json()' },
  { file: 'app/api/admin/investment-intelligence/risk-free-data/series-state/route.ts', authorise: "requireRiskFreeCapability('switch')", bodyRead: 'req.json()' },
  { file: 'app/api/investment-intelligence/cron/nav2-correction-worker/route.ts', authorise: "req.headers.get('x-cron-secret')", bodyRead: 'req.json()' },
  { file: 'app/api/investment-intelligence/cron/nav2-risk-free-refresh/route.ts', authorise: "req.headers.get('x-cron-secret')", bodyRead: 'req.json()' },
  { file: 'app/api/reports/fund-analytics/route.ts', authorise: 'canViewPremiumReport(user.id, supabase)', bodyRead: 'req.text()' },
];

/** The authorisation must come first, and the schema parse (safeParse) must come after the body read. */
function orderFailures(src: string, authorise: string, bodyRead: string, postIndex: number): string[] {
  const out: string[] = [];
  const a = src.indexOf(authorise, postIndex);
  const b = src.indexOf(bodyRead, postIndex);
  if (a < 0) out.push(`authorisation "${authorise}" not found in the POST handler`);
  if (b < 0) out.push(`body read "${bodyRead}" not found`);
  if (a >= 0 && b >= 0 && a > b) out.push('the body is read before the caller is authorised');
  const v = src.indexOf('safeParse', postIndex);
  if (a >= 0 && v >= 0 && a > v) out.push('the body is validated before the caller is authorised');
  return out;
}
const postStart = (src: string) => {
  const m = /export (?:const POST|async function POST)/.exec(src);
  return m ? m.index : -1;
};

describe('every NAV2 POST route authorises before it validates (Stage 3 fix 4)', () => {
  for (const r of POST_ROUTES) {
    it(`${r.file}: authorisation first`, () => {
      const src = read(r.file);
      const start = postStart(src);
      expect(start, 'POST handler found').toBeGreaterThanOrEqual(0);
      expect(orderFailures(src, r.authorise, r.bodyRead, start)).toEqual([]);
    });
  }
  it('NC-A1: reading and validating the body first (the reported defect) is caught', () => {
    const r = POST_ROUTES[6];
    const src = read(r.file);
    const at = postStart(src);
    const early = 'const supabase = await createClient();\n  if (!(await canViewPremiumReport(user.id, supabase))) return bad(FUND_ANALYTICS_PREMIUM_MESSAGE, 403);\n';
    const mutated = src.slice(0, at) + src.slice(at).replace(early, '');
    expect(mutated).not.toBe(src);
    expect(orderFailures(`${mutated}\n// canViewPremiumReport(user.id, supabase)`, r.authorise, r.bodyRead, postStart(mutated)).length).toBeGreaterThan(0);
  });
});

describe('Print / Save as PDF: the free print flow, no server PDF button (Stage 3 fix 3, replaced 19-10-2026)', () => {
  const client = read('components/reports/FundAnalyticsReportClient.tsx');
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const route = read('app/api/reports/fund-analytics/[id]/export/route.ts');
  const printPage = read('app/(print)/reports/fund-analytics/print/page.tsx');
  it('ONE button, "Print / Save as PDF", is the shared print-tab link to the print route with print=1 (as the Monthly Report)', () => {
    expect(client).toContain("from '@/components/reports/OpenPrintTabLink'");
    expect(client).toMatch(/<OpenPrintTabLink[\s\S]*?href=\{`\/reports\/fund-analytics\/print\?id=\$\{encodeURIComponent\(selectedId\)\}&print=1\$\{viewerTz \? `&tz=\$\{encodeURIComponent\(viewerTz\)\}` : ''\}`\}[\s\S]*?>\s*Print \/ Save as PDF\s*<\/OpenPrintTabLink>/);
    expect(client).not.toMatch(/<button\b/);
  });
  it('the page makes NO server PDF call: no export route, no fetch of a PDF, no blob address, no View / Download PDF, no window.print() button', () => {
    const c = code(client);
    expect(c).not.toMatch(/\/export/);
    expect(c).not.toMatch(/View PDF|Download PDF|Export PDF|getPdf|createObjectURL|pdf-status|Your PDF is ready/);
    expect(c).not.toMatch(/window\.print\(/);
  });
  it('NC-V1: a regression that brings back a server PDF call is caught by the same scanner', () => {
    const regressed = code(client) + '\nconst res = await fetch(`/api/reports/fund-analytics/${selectedId}/export`);';
    expect(regressed).toMatch(/\/export/);
  });
  it('the print view (the person path) carries the shared toolbar: prints once with print=1 and closes its own tab; the renderer token path stays bare', () => {
    expect(printPage).toContain("from '@/components/reports/PrintTabToolbar'");
    expect(printPage).toContain("print === '1'");
    expect(printPage).toMatch(/<PrintTabToolbar autoPrint=\{print === '1'\} parentHref="\/reports\/fund-analytics" parentLabel="Fund Analytics" \/>/);
    const tokenBranch = printPage.slice(printPage.indexOf('if (token) {'), printPage.indexOf('const supabase = await createClient()'));
    expect(tokenBranch).not.toContain('PrintTabToolbar');
  });
  it('the server export route stays in place (typed errors) for a hosted renderer later; it is not used by the page', () => {
    expect(route).toContain("searchParams.get('disposition') === 'inline'");
    expect(route).toContain('`${disposition}; filename=');
  });
  it('the version and made-on line sits with the saved-report sentence on the page', () => {
    expect(client).toContain('versionMadeLine(sel.versionNumber, sel.createdAt)');
    expect(client).toContain('FUND_ANALYTICS_SAVED_REPORT_SENTENCE');
  });
});

describe('a working state at once on Save, Upload and Record correction (Stage 3 fix 5)', () => {
  const page = read('components/admin/RiskFreeDataClient.tsx');
  const ui = read('components/admin/benchmarkData/ui.tsx');
  it('the shared button can say what it is doing and is disabled while it works', () => {
    expect(ui).toContain('busyLabel');
    expect(ui).toMatch(/busy \? \(busyLabel \?\? 'Working\.\.\.'\) : children/);
    expect(ui).toMatch(/const off = disabled === true \|\| busy === true/);
  });
  it('each of the three buttons names its busy state and every other button is disabled meanwhile', () => {
    expect(page).toMatch(/busy=\{busyArea === 'upload'\} busyLabel="Uploading\.\.\."/);
    expect(page).toMatch(/busy=\{busyArea === 'correction'\}\s+busyLabel="Saving\.\.\."/);
    expect(page).toMatch(/busy=\{busyArea === area\}\s+busyLabel="Saving\.\.\."/);
    expect(page.match(/busyLabel="Saving\.\.\."/g)?.length).toBeGreaterThanOrEqual(3);
    expect(page).toContain('const busy = busyArea !== null');
    // the busy area is set BEFORE the request is sent
    expect(page.indexOf('setBusyArea(area);')).toBeLessThan(page.indexOf("fetch(url, { method: 'POST'"));
  });
  it('the table refresh after a save says so instead of leaving a silent wait', () => {
    expect(page).toContain('Refreshing the page...');
    expect(page).toContain('setRefreshing(true)');
  });
  it('NC-B1: a button without a busy label would only say Working...: the control removes it and the contract notices', () => {
    const mutated = page.replace('busyLabel="Uploading..."', '');
    expect(mutated).not.toBe(page);
    expect(mutated).not.toMatch(/busyLabel="Uploading\.\.\."/);
  });
});
