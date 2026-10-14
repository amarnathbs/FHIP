/**
 * Premium Upload Entitlement -- the Free and Premium UI states (pages 51, 52, 61-66, 72, 92, 102, 192, 218).
 *
 * Rendered with react-dom/server (the repository's existing component-test technique), so the assertions are about the
 * real markup a browser would receive:
 *   - Free  : manual entry is present and primary; Import is a LOCKED Premium control with a text "Premium" pill, an
 *             accessible name that states the lock, and a link to the existing plan section; there is NO file input,
 *             NO document-type chooser and NO upload button anywhere on the Import surface;
 *   - unknown (entitlement still resolving) : a neutral "Checking your plan" state -- never an active file picker;
 *   - unavailable : an honest "try again" state, not a demand to pay;
 *   - Premium : the import control / form is active exactly as before, with no lock chrome.
 */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FINANCIAL_IMPORT_LOCK_COPY,
  FINANCIAL_IMPORT_UNAVAILABLE_COPY,
  accessViewFromDeniedBody,
  financialImportUpgradeHref,
  isFinancialImportDeniedBody,
} from '@/lib/entitlements/financialDataImportContract';
import { parseImportAccess } from '@/lib/entitlements/useFinancialImportAccess';
import { ImportLockedNotice } from '@/components/entitlements/ImportLockedNotice';
import { ImportLockedLink } from '@/components/entitlements/ImportLockedLink';
import { PremiumImportPill } from '@/components/entitlements/PremiumImportPill';

type View = { state: 'allowed' } | { state: 'premium_required' } | { state: 'unavailable' } | null;
const h = vi.hoisted(() => ({ access: null as View, noted: [] as unknown[] }));

vi.mock('@/lib/entitlements/useFinancialImportAccess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/useFinancialImportAccess')>();
  return { ...actual, useFinancialImportAccess: () => ({ access: h.access, noteResponse: (j: unknown) => { h.noted.push(j); return false; } }) };
});

// Page-level children that are not under test are stubbed; the manual-entry grid stub proves manual entry is rendered.
vi.mock('@/components/grid/FinancialDataGrid', () => ({
  FinancialDataGrid: ({ moduleKey, beforeGrid }: { moduleKey: string; beforeGrid?: ReactNode }) =>
    createElement('div', { 'data-testid': `manual-grid-${moduleKey}` }, 'Add / edit grid', beforeGrid),
}));
vi.mock('@/components/navigation/PageBackLink', () => ({ PageBackLink: () => null }));
vi.mock('@/lib/nav/useModuleWriteAvailability', () => ({ useModuleWriteAvailability: () => ({ available: true, resolved: true }) }));
vi.mock('@/components/income/ImportedIncomeActuals', () => ({ ImportedIncomeActuals: () => null }));
vi.mock('@/components/expenses/ImportedExpenseActuals', () => ({ ImportedExpenseActuals: () => null }));
vi.mock('@/components/expenses/PlannedFromActualProposal', () => ({ PlannedFromActualProposal: () => null }));
vi.mock('@/components/liabilities/LiabilityStatementHistory', () => ({ LiabilityStatementHistory: () => null }));
vi.mock('@/components/investments/InvestmentsSubNav', () => ({ InvestmentsSubNav: () => null }));
vi.mock('@/components/investments/ImportedInvestmentStatements', () => ({ ImportedInvestmentStatements: () => null }));
vi.mock('@/components/investments/PublishedFundValuations', () => ({ PublishedFundValuations: () => null }));
vi.mock('@/components/retirement/RetirementPlanningSection', () => ({ RetirementPlanningSection: () => null }));
vi.mock('@/components/retirement/smsf/SmsfSection', () => ({ SmsfSection: () => null }));
vi.mock('@/components/retirement/RetirementStatementHistory', () => ({ RetirementStatementHistory: () => null }));
vi.mock('@/components/financial-data-hub/StatementDetailsDrawer', () => ({ StatementDetailsDrawer: () => null }));
// The retirement page mounts its panel inline; the other pages mount it behind the Import button, so stub those panels.
vi.mock('@/components/income/PayslipImportPanel', () => ({ PayslipImportPanel: () => createElement('div', { 'data-testid': 'payslip-panel' }) }));
vi.mock('@/components/expenses/BankStatementImportPanel', () => ({ BankStatementImportPanel: () => createElement('div', { 'data-testid': 'bank-panel' }) }));
vi.mock('@/components/liabilities/LiabilityImportPanel', () => ({ LiabilityImportPanel: () => createElement('div', { 'data-testid': 'liability-panel' }) }));
vi.mock('@/components/investments/AuInvestmentStatementImportPanel', () => ({ AuInvestmentStatementImportPanel: () => createElement('div', { 'data-testid': 'au-panel' }) }));

beforeEach(() => {
  h.access = null;
  h.noted = [];
});

const html = (node: ReactNode) => renderToStaticMarkup(node as never);
const FILE_INPUT = /<input[^>]*type="file"/i;

describe('shared presentation', () => {
  it('the Premium pill carries the status in TEXT (not colour alone) and hides its icon from assistive tech', () => {
    const out = html(createElement(PremiumImportPill));
    expect(out).toContain('>Premium<');
    expect(out).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  it('locked notice: PO wording, manual-entry reassurance, upgrade link with domain context, NO input / button / chooser', () => {
    const out = html(createElement(ImportLockedNotice, { domain: 'income', label: 'Import from Payslip', state: 'premium_required' }));
    expect(out).toContain(FINANCIAL_IMPORT_LOCK_COPY);
    expect(out).toContain('Manual entry stays available on every plan.');
    expect(out).toContain(`href="${financialImportUpgradeHref('income')}"`);
    expect(out).toContain('href="/profile?from=import-income"');
    expect(out).toContain('aria-label="Import from Payslip is a Premium feature"');
    expect(out).toContain('>Premium<');
    expect(out).not.toMatch(/<input|<select|<textarea|<button|type="file"|accept=/i);
    expect(out).not.toMatch(/amber|caution|yellow/i); // the established violet Premium language, not warning amber
  });

  it('unavailable: asks to retry, does NOT demand payment or offer an upgrade link', () => {
    const out = html(createElement(ImportLockedNotice, { domain: 'expenses', label: 'Import bank statement', state: 'unavailable' }));
    expect(out).toContain(FINANCIAL_IMPORT_UNAVAILABLE_COPY);
    expect(out).not.toContain('href=');
    expect(out).not.toMatch(/<input|<button/i);
  });

  it('checking: a neutral status, no controls', () => {
    const out = html(createElement(ImportLockedNotice, { domain: 'expenses', label: 'x', state: 'checking' }));
    expect(out).toContain('role="status"');
    expect(out).toContain('Checking your plan');
    expect(out).not.toMatch(/<input|<button|href=/i);
  });

  it('locked link: a real link (keyboard reachable, not a dead disabled button) whose accessible name states the lock', () => {
    const out = html(createElement(ImportLockedLink, { domain: 'liabilities', label: 'Import Statement' }));
    expect(out).toMatch(/^<a /);
    expect(out).toContain('href="/profile?from=import-liabilities"');
    expect(out).toContain('aria-label="Import Statement - available on Premium. View Premium plans."');
    expect(out).toContain('>Premium<');
    expect(out).not.toContain('disabled');
    expect(out).not.toMatch(/<button|<input/i);
  });

  it('the access wire format fails closed in what is DRAWN too', () => {
    expect(parseImportAccess({ data: { import_access: 'allowed' } })).toEqual({ state: 'allowed' });
    expect(parseImportAccess({ data: { import_access: 'premium_required' } })).toEqual({ state: 'premium_required' });
    for (const junk of [null, {}, { data: {} }, { data: { import_access: 'ALLOWED' } }, { data: { import_access: true } }, { data: { enabled: true } }, 'allowed']) {
      expect(parseImportAccess(junk)).toEqual({ state: 'unavailable' });
    }
  });

  it('the unified refusal body is recognised from any panel and maps to the right view', () => {
    const premium = { error: FINANCIAL_IMPORT_LOCK_COPY, code: 'PREMIUM_REQUIRED', data: { allowed: false, reason: 'PREMIUM_REQUIRED', upgrade_available: true, upgrade_path: '/profile' } };
    const down = { error: 'x', code: 'ENTITLEMENT_UNAVAILABLE', data: { allowed: false, reason: 'ENTITLEMENT_UNAVAILABLE', upgrade_available: false, upgrade_path: null } };
    expect(isFinancialImportDeniedBody(premium)).toBe(true);
    expect(accessViewFromDeniedBody(premium as never)).toEqual({ state: 'premium_required' });
    expect(accessViewFromDeniedBody(down as never)).toEqual({ state: 'unavailable' });
    for (const other of [null, undefined, {}, { error: 'File too large.' }, { code: 'file_too_large' }, 'PREMIUM_REQUIRED']) expect(isFinancialImportDeniedBody(other)).toBe(false);
  });
});

describe('page-level Import control, per domain (Free / Premium / resolving)', () => {
  const PAGES = [
    { name: 'Income', load: () => import('@/app/(app)/income/page'), label: 'Import from Payslip', domain: 'income', module: 'INCOME' },
    { name: 'Expenses', load: () => import('@/app/(app)/expenses/page'), label: 'Import bank statement', domain: 'expenses', module: 'EXPENSES' },
    { name: 'Liabilities', load: () => import('@/app/(app)/liabilities/page'), label: 'Import Statement', domain: 'liabilities', module: 'LIABILITIES' },
    { name: 'Investments', load: () => import('@/app/(app)/investments/page'), label: 'Import Australian Investment Statement', domain: 'investments', module: 'INVESTMENTS' },
  ] as const;

  for (const p of PAGES) {
    describe(p.name, () => {
      it('Free: manual entry present; Import is the locked Premium link; no active import button', async () => {
        h.access = { state: 'premium_required' };
        const Page = (await p.load()).default;
        const out = html(createElement(Page));
        expect(out).toContain(`data-testid="manual-grid-${p.module}"`); // manual Add/Edit stays
        expect(out).toContain('data-testid="import-locked-link"');
        expect(out).toContain(`href="/profile?from=import-${p.domain}"`);
        expect(out).toContain('>Premium<');
        expect(out).not.toMatch(new RegExp(`<button[^>]*>${p.label}</button>`));
        expect(out).not.toMatch(FILE_INPUT);
      });

      it('Premium: the working Import button, no lock chrome', async () => {
        h.access = { state: 'allowed' };
        const out = html(createElement((await p.load()).default));
        expect(out).toContain(`data-testid="manual-grid-${p.module}"`);
        expect(out).toMatch(new RegExp(`<button[^>]*>${p.label}</button>`));
        expect(out).not.toContain('import-locked-link');
        expect(out).not.toContain('>Premium<');
      });

      it('resolving: manual entry present and the Import button is not replaced by a lock before the answer is known', async () => {
        h.access = null;
        const out = html(createElement((await p.load()).default));
        expect(out).toContain(`data-testid="manual-grid-${p.module}"`);
        expect(out).not.toContain('import-locked-link');
      });
    });
  }

  it('Retirement: the "Import statement" anchor shows the Premium pill for Free and the manual grid stays', async () => {
    const Page = (await import('@/app/(app)/retirement/page')).default;
    h.access = { state: 'premium_required' };
    const free = html(createElement(Page));
    expect(free).toContain('data-testid="manual-grid-RETIREMENT"');
    expect(free).toMatch(/href="#import-retirement-statement"[^>]*>[^<]*Import statement[^<]*<span[^>]*>[\s\S]*?>Premium</);
    h.access = { state: 'allowed' };
    const paid = html(createElement(Page));
    expect(paid).not.toContain('>Premium<');
  });
});

describe('import PANELS -- no active file picker unless the server said allowed (no fake upload, no flash-of-picker)', () => {
  // The real panels, rendered at the state a browser would paint first (effects have not run: upload-status unknown).
  // `active` = what only the ACTIVE import form contains: a file input, or (Liabilities) the statement-type chooser that precedes it.
  const FILE: RegExp = FILE_INPUT;
  const PANELS = [
    { name: 'Payslip (Income)', path: '@/components/income/PayslipImportPanel', exportName: 'PayslipImportPanel', props: { onClose: () => {} }, domain: 'income', active: FILE },
    { name: 'Bank statement (Expenses)', path: '@/components/expenses/BankStatementImportPanel', exportName: 'BankStatementImportPanel', props: { onClose: () => {} }, domain: 'expenses', active: FILE },
    { name: 'Credit card / loan (Liabilities)', path: '@/components/liabilities/LiabilityImportPanel', exportName: 'LiabilityImportPanel', props: { onClose: () => {} }, domain: 'liabilities', active: /Credit Card Statement/ },
    { name: 'Investment statement (Investments)', path: '@/components/investments/AuInvestmentStatementImportPanel', exportName: 'AuInvestmentStatementImportPanel', props: {}, domain: 'investments', active: FILE },
    { name: 'Retirement statement (Retirement)', path: '@/components/retirement/RetirementStatementImportPanel', exportName: 'RetirementStatementImportPanel', props: {}, domain: 'retirement', active: FILE },
  ] as const;

  // The page-level stubs above replace the four panels for the page tests; here the REAL panels are needed.
  for (const p of PANELS) {
    describe(p.name, () => {
      async function render() {
        const real = await vi.importActual<Record<string, unknown>>(p.path);
        return html(createElement(real[p.exportName] as never, p.props as never));
      }

      it('Free => locked Premium notice, upgrade link, NO file input, NO upload button', async () => {
        h.access = { state: 'premium_required' };
        const out = await render();
        expect(out).toContain('data-testid="import-locked"');
        expect(out).toContain(FINANCIAL_IMPORT_LOCK_COPY);
        expect(out).toContain(`href="/profile?from=import-${p.domain}"`);
        expect(out).not.toMatch(FILE_INPUT);
        expect(out).not.toMatch(p.active);
        expect(out).not.toMatch(/accept="\.?(pdf|csv|application)/i);
      });

      it('resolving => "Checking your plan", NO file input (never an active picker before the answer)', async () => {
        h.access = null;
        const out = await render();
        expect(out).toContain('Checking your plan');
        expect(out).not.toMatch(FILE_INPUT);
        expect(out).not.toMatch(p.active);
      });

      it('unavailable => retry wording, NO file input, no demand to pay', async () => {
        h.access = { state: 'unavailable' };
        const out = await render();
        expect(out).toContain(FINANCIAL_IMPORT_UNAVAILABLE_COPY);
        expect(out).not.toMatch(FILE_INPUT);
        expect(out).not.toMatch(p.active);
        expect(out).not.toContain('import-locked"');
      });

      it('Premium => the active import form (file input present), no lock chrome', async () => {
        h.access = { state: 'allowed' };
        const out = await render();
        expect(out).not.toContain('data-testid="import-locked"');
        expect(out).not.toContain('Checking your plan');
        expect(out).toMatch(p.active);
      });
    });
  }

  it('India CAS (Investment Intelligence data page): same four states', async () => {
    const real = await vi.importActual<{ InvestmentIntelligenceClient: never }>('@/components/investment-intelligence/InvestmentIntelligenceClient');
    const render = () => html(createElement(real.InvestmentIntelligenceClient as never, {} as never));
    h.access = { state: 'premium_required' };
    const free = render();
    expect(free).toContain('data-testid="import-locked"');
    expect(free).not.toMatch(FILE_INPUT);
    h.access = null;
    expect(render()).not.toMatch(FILE_INPUT);
    h.access = { state: 'unavailable' };
    expect(render()).not.toMatch(FILE_INPUT);
    h.access = { state: 'allowed' };
    const paid = render();
    expect(paid).toMatch(FILE_INPUT);
    expect(paid).not.toContain('data-testid="import-locked"');
  });
});
