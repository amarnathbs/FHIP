/**
 * The Liability, Retirement and Australian-investment import screens must SAY what the server will do with a PDF.
 *
 * Production 20-10-2026: the screens said "Statement file (PDF or CSV)" while the per-class PDF route switch was unset (OFF), so a
 * user was invited to upload a PDF and then refused. The words and the file chooser now follow the switch:
 *   OFF -> CSV only (the pre-PDF-routes wording) and no PDF in the chooser's `accept`;
 *   ON  -> "PDF or CSV" and a chooser that offers both.
 * The switch is resolved on the SERVER (GET /api/financial-data-hub/upload-status -> data.pdf_routes), never exposed to the
 * client bundle, and the screen fails closed. The upload route's refusal is unchanged (covered by pdfRoutesRoutes.test.ts).
 *
 * Rendered with react-dom/server (the repository's component-test technique), so the assertions are on real markup.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuInvestmentStatementFileField,
  AuInvestmentUploadIntro,
  LiabilityStatementFileField,
  LiabilityUploadIntro,
  RetirementStatementFileField,
} from '@/components/financial-data-hub/PdfAwareStatementCopy';
import {
  PDF_ROUTES_FIELD,
  parsePdfRouteVisible,
  statementFileAccept,
  statementFileLabel,
} from '@/lib/financial-data-hub/pdf-statements/uiVisibility';
import { PDF_ROUTE_FLAG_NAMES, type PdfStatementClass } from '@/lib/financial-data-hub/pdf-statements/flags';

vi.setConfig({ testTimeout: 60_000 });

const h = vi.hoisted(() => ({ authed: true }));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    requireCountryConfirmedUser: async () =>
      h.authed
        ? { user: { id: 'user-1' }, unauthenticated: null }
        : { user: null, unauthenticated: Response.json({ error: 'Unauthenticated' }, { status: 401 }) },
  };
});
vi.mock('@/lib/entitlements/financialDataImport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/financialDataImport')>();
  return { ...actual, financialImportAccessView: async () => ({ state: 'allowed' }) };
});

const noop = () => {};
const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const acceptOf = (html: string) => /accept="([^"]*)"/.exec(html)?.[1] ?? '';

const render = {
  liabilityIntro: (on: boolean, card = false) => renderToStaticMarkup(createElement(LiabilityUploadIntro, { pdfRouteEnabled: on, isCreditCard: card })),
  liabilityField: (on: boolean) => renderToStaticMarkup(createElement(LiabilityStatementFileField, { pdfRouteEnabled: on, onChange: noop })),
  retirementField: (on: boolean) => renderToStaticMarkup(createElement(RetirementStatementFileField, { pdfRouteEnabled: on, onChange: noop })),
  auIntro: (on: boolean) => renderToStaticMarkup(createElement(AuInvestmentUploadIntro, { pdfRouteEnabled: on })),
  auField: (on: boolean) => renderToStaticMarkup(createElement(AuInvestmentStatementFileField, { pdfRouteEnabled: on, onChange: noop })),
};

describe('parsePdfRouteVisible: fail closed', () => {
  const classes: PdfStatementClass[] = ['liability', 'retirement', 'au_investment'];
  it.each(classes)('%s: only the literal boolean true for that class is visible', (cls) => {
    const body = (v: unknown) => ({ data: { [PDF_ROUTES_FIELD]: { [cls]: v } } });
    expect(parsePdfRouteVisible(body(true), cls)).toBe(true);
    for (const v of [false, 'true', 1, null, undefined, {}, []]) expect(parsePdfRouteVisible(body(v), cls)).toBe(false);
  });
  it('a missing, null, malformed or failed-request body is "not visible" for every class', () => {
    for (const cls of classes) {
      for (const json of [null, undefined, {}, { data: {} }, { data: { pdf_routes: null } }, { data: { pdf_routes: 'yes' } }, { data: { pdf_routes: true } }, { data: { enabled: true } }, 'x', 7]) {
        expect(parsePdfRouteVisible(json, cls)).toBe(false);
      }
    }
  });
  it('one class being on does not switch another class on', () => {
    const json = { data: { pdf_routes: { liability: true, retirement: false, au_investment: false } } };
    expect(parsePdfRouteVisible(json, 'liability')).toBe(true);
    expect(parsePdfRouteVisible(json, 'retirement')).toBe(false);
    expect(parsePdfRouteVisible(json, 'au_investment')).toBe(false);
  });
});

describe('Liabilities: words and file chooser follow the switch', () => {
  it('OFF: CSV only, no PDF offered anywhere', () => {
    const intro = render.liabilityIntro(false);
    const field = render.liabilityField(false);
    expect(intro).toContain('statement (CSV) and FHIP will extract');
    expect(intro).toContain('loan');
    expect(field).toContain('Statement file (CSV)');
    expect(acceptOf(field)).toBe('text/csv,.csv');
    // negative control: nothing PDF-shaped survives while the route is off
    for (const html of [intro, field]) {
      expect(html).not.toContain('PDF');
      expect(html).not.toContain('pdf');
    }
  });
  it('ON: PDF or CSV, and the chooser offers both', () => {
    const intro = render.liabilityIntro(true, true);
    const field = render.liabilityField(true);
    expect(intro).toContain('credit card');
    expect(intro).toContain('statement (PDF or CSV) and FHIP will extract');
    expect(field).toContain('Statement file (PDF or CSV)');
    expect(acceptOf(field)).toBe('application/pdf,.pdf,text/csv,.csv');
  });
  it('the credit-card variant keeps its noun when OFF', () => {
    expect(render.liabilityIntro(false, true)).toContain('credit card statement (CSV)');
  });
});

describe('Retirement: words and file chooser follow the switch', () => {
  it('OFF: CSV only, the earlier "CSV exports only" coverage note, no PDF in accept', () => {
    const field = render.retirementField(false);
    expect(field).toContain('Statement file (CSV)');
    expect(field).not.toContain('PDF or CSV');
    expect(acceptOf(field)).toBe('.csv,text/csv');
    expect(field).toContain('CSV exports only in this release');
    expect(field).not.toContain('A PDF is read');
    expect(field).not.toContain('read by AI');
  });
  it('ON: PDF or CSV and the PDF coverage note', () => {
    const field = render.retirementField(true);
    expect(field).toContain('Statement file (PDF or CSV)');
    expect(acceptOf(field)).toBe('application/pdf,.pdf,.csv,text/csv');
    expect(field).toContain('A PDF is read for the balances and movements it prints');
    expect(field).not.toContain('CSV exports only');
  });
});

describe('Australian investments: words and file chooser follow the switch', () => {
  it('OFF: CSV only, the earlier wording, no PDF in accept', () => {
    const intro = render.auIntro(false);
    const field = render.auField(false);
    expect(intro).toContain('portfolio-holdings CSV and FHIP will extract');
    expect(intro).toContain('FHIP currently reads two generic Australian CSV layouts');
    expect(intro).not.toContain('PDF or CSV');
    expect(intro).not.toContain('A PDF is deleted');
    expect(intro).not.toContain('read by AI');
    expect(field).toContain('Statement file (CSV)');
    expect(field).not.toContain('PDF or CSV');
    expect(acceptOf(field)).toBe('text/csv,.csv');
  });
  it('ON: PDF or CSV and a chooser that offers both', () => {
    const intro = render.auIntro(true);
    const field = render.auField(true);
    expect(intro).toContain('statement (PDF or CSV) and FHIP will extract');
    expect(intro).toContain('A PDF is deleted as soon as its details are saved');
    expect(field).toContain('Statement file (PDF or CSV)');
    expect(acceptOf(field)).toBe('application/pdf,.pdf,text/csv,.csv');
  });
});

describe('helpers', () => {
  it('every class: OFF accept has no pdf, ON accept has pdf; label follows', () => {
    for (const cls of ['liability', 'retirement', 'au_investment'] as const) {
      expect(statementFileAccept(cls, false)).not.toMatch(/pdf/i);
      expect(statementFileAccept(cls, true)).toMatch(/application\/pdf/);
      expect(statementFileAccept(cls, true)).toMatch(/\.pdf/);
      expect(statementFileAccept(cls, true)).toMatch(/\.csv/);
      expect(statementFileAccept(cls, false)).toMatch(/\.csv/);
    }
    expect(statementFileLabel(false)).toBe('Statement file (CSV)');
    expect(statementFileLabel(true)).toBe('Statement file (PDF or CSV)');
  });
  it('the helper module reads no environment and the copy component has no env or NEXT_PUBLIC', () => {
    const src = read('lib/financial-data-hub/pdf-statements/uiVisibility.ts');
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/NEXT_PUBLIC/);
    expect(read('components/financial-data-hub/PdfAwareStatementCopy.tsx')).not.toMatch(/process\.env|NEXT_PUBLIC/);
  });
});

describe('the panels use the switch-aware pieces and fail closed', () => {
  const panels: Array<[string, PdfStatementClass, string[]]> = [
    ['components/liabilities/LiabilityImportPanel.tsx', 'liability', ['LiabilityUploadIntro', 'LiabilityStatementFileField']],
    ['components/retirement/RetirementStatementImportPanel.tsx', 'retirement', ['RetirementStatementFileField']],
    ['components/investments/AuInvestmentStatementImportPanel.tsx', 'au_investment', ['AuInvestmentUploadIntro', 'AuInvestmentStatementFileField']],
  ];
  it.each(panels)('%s', (file, cls, pieces) => {
    const src = read(file);
    // no hard-coded PDF wording or PDF accept left in the panel itself
    expect(src).not.toContain('Statement file (PDF or CSV)');
    expect(src).not.toMatch(/accept="[^"]*pdf/i);
    expect(src).not.toMatch(/statement \(PDF or CSV\)/);
    for (const piece of pieces) expect(src).toContain(`<${piece} pdfRouteEnabled={pdfRouteEnabled}`);
    // starts CSV-only, is set from the server read for THIS class, reset on failure, and never from an env variable
    expect(src).toContain('const [pdfRouteEnabled, setPdfRouteEnabled] = useState(false);');
    expect(src).toContain(`setPdfRouteEnabled(parsePdfRouteVisible(json, '${cls}'))`);
    expect(src).toContain('setPdfRouteEnabled(false);');
    expect(src).not.toMatch(/NEXT_PUBLIC|process\.env/);
  });
  it('the untouched screens (bank, payslip) do not use the switch-aware copy', () => {
    expect(read('components/expenses/BankStatementImportPanel.tsx')).not.toContain('PdfAwareStatementCopy');
    expect(read('components/income/PayslipImportPanel.tsx')).not.toContain('PdfAwareStatementCopy');
  });
});

describe('GET /api/financial-data-hub/upload-status reports the three switches (server-resolved)', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    h.authed = true;
    for (const name of Object.values(PDF_ROUTE_FLAG_NAMES)) saved[name] = process.env[name];
  });
  afterEach(() => {
    for (const [name, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[name];
      else process.env[name] = v;
    }
  });
  const get = async () => {
    const { GET } = await import('@/app/api/financial-data-hub/upload-status/route');
    return (await (await GET()).json()).data as { import_access: string; pdf_routes: Record<string, boolean> };
  };

  it('unset (the production default) -> every class false, so the screens say CSV only', async () => {
    for (const name of Object.values(PDF_ROUTE_FLAG_NAMES)) delete process.env[name];
    const data = await get();
    expect(data.pdf_routes).toEqual({ liability: false, retirement: false, au_investment: false });
    expect(data.import_access).toBe('allowed');
    for (const cls of ['liability', 'retirement', 'au_investment'] as const) {
      expect(parsePdfRouteVisible({ data }, cls)).toBe(false);
    }
  });
  it('each class follows only its own switch, and only the literal string true turns it on', async () => {
    process.env[PDF_ROUTE_FLAG_NAMES.liability] = 'true';
    process.env[PDF_ROUTE_FLAG_NAMES.retirement] = '1';
    delete process.env[PDF_ROUTE_FLAG_NAMES.au_investment];
    expect((await get()).pdf_routes).toEqual({ liability: true, retirement: false, au_investment: false });
    process.env[PDF_ROUTE_FLAG_NAMES.liability] = 'TRUE';
    process.env[PDF_ROUTE_FLAG_NAMES.au_investment] = 'true';
    expect((await get()).pdf_routes).toEqual({ liability: false, retirement: false, au_investment: true });
  });
  it('an unauthenticated caller learns nothing', async () => {
    h.authed = false;
    const { GET } = await import('@/app/api/financial-data-hub/upload-status/route');
    const res = await GET();
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).not.toContain('pdf_routes');
  });
});
