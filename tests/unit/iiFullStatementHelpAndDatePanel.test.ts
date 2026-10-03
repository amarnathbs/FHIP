/**
 * Task B (PO 2026-10-03): the (!) button beside the statement Upload button
 * and its popup explaining how to get a FULL since-inception statement from
 * CAMS and KFintech.  Task A UI: the "needs investment date" row.
 *
 * The repo has no jsdom / testing-library (vitest runs in node), so nothing is
 * clicked here. This file proves:
 *   1. the two provider links live in ONE config module, are https and on the
 *      allowed domains, and a look-alike or http address is refused;
 *   2. what the user is shown (react-dom/server markup of the open dialog and
 *      the closed trigger), including the required wording and the link
 *      attributes;
 *   3. structural contracts for the accessibility behaviour the dialog
 *      implements (Escape, focus trap, focus return, aria), read from source.
 * Keyboard interaction itself (Tab cycling, Escape, focus return) is NOT
 * executed here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_STATEMENT_LINK_DOMAINS,
  CAMS_STATEMENT_REQUEST_URL,
  FULL_STATEMENT_DELIVERY,
  FULL_STATEMENT_HELP_INTRO,
  FULL_STATEMENT_PRIVACY,
  FULL_STATEMENT_STEPS,
  KFIN_STATEMENT_REQUEST_URL,
  STATEMENT_PROVIDERS,
  isAllowedStatementLink,
} from '@/lib/investment-intelligence/statementRequestLinks';
import { InfoDialog } from '@/components/ui/InfoDialog';
import { FullStatementHelp, FullStatementHelpContent } from '@/components/investment-intelligence/FullStatementHelp';
import { InvestmentDateRow, type InvestmentDateItemView } from '@/components/investment-intelligence/InvestmentDatePanel';

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

describe('statement request links (UNVERIFIED by the build side; the PO must check them)', () => {
  it('are named constants in one module, https, and on camsonline.com / kfintech.com only', () => {
    expect(ALLOWED_STATEMENT_LINK_DOMAINS).toEqual(['camsonline.com', 'kfintech.com']);
    for (const url of [CAMS_STATEMENT_REQUEST_URL, KFIN_STATEMENT_REQUEST_URL]) {
      expect(url.startsWith('https://')).toBe(true);
      expect(isAllowedStatementLink(url)).toBe(true);
    }
    expect(new URL(CAMS_STATEMENT_REQUEST_URL).hostname.endsWith('camsonline.com')).toBe(true);
    expect(new URL(KFIN_STATEMENT_REQUEST_URL).hostname.endsWith('kfintech.com')).toBe(true);
    expect(STATEMENT_PROVIDERS.map((p) => p.url)).toEqual([CAMS_STATEMENT_REQUEST_URL, KFIN_STATEMENT_REQUEST_URL]);
  });

  it('refuses http, look-alike hosts, other domains, credentials-in-URL tricks and junk', () => {
    expect(isAllowedStatementLink('http://www.camsonline.com/x')).toBe(false);
    expect(isAllowedStatementLink('https://camsonline.com.evil.example/x')).toBe(false);
    expect(isAllowedStatementLink('https://evilcamsonline.com/x')).toBe(false);
    expect(isAllowedStatementLink('https://www.camsonline.com@evil.example/x')).toBe(false);
    expect(isAllowedStatementLink('https://example.com')).toBe(false);
    expect(isAllowedStatementLink('javascript:alert(1)')).toBe(false);
    expect(isAllowedStatementLink('not a url')).toBe(false);
    expect(isAllowedStatementLink('https://mfs.kfintech.com/a')).toBe(true); // a subdomain of an allowed domain is fine
  });

  it('no other URL appears anywhere in the config module (no unverified address sneaks in)', () => {
    const src = read('lib/investment-intelligence/statementRequestLinks.ts');
    const urls = src.match(/https?:\/\/[^\s'"`)]+/g) ?? [];
    const allowedLiterals = new Set(['https://www.camsonline.com/Investors/Statements/Consolidated-Account-Statement', 'https://mfs.kfintech.com/investor/General/ConsolidatedAccountStatement']);
    for (const u of urls) expect(allowedLiterals.has(u)).toBe(true);
    expect(src).toContain('UNVERIFIED');
  });
});

describe('what the popup says', () => {
  it('covers what to choose, that it is emailed, the PDF password, and that FHIP never needs the login', () => {
    const text = [FULL_STATEMENT_HELP_INTRO, ...FULL_STATEMENT_STEPS, FULL_STATEMENT_DELIVERY, FULL_STATEMENT_PRIVACY].join(' ').toLowerCase();
    expect(text).toContain('consolidated account statement');
    expect(text).toContain('transactions');
    expect(text).toContain('summary');
    expect(text).toContain('since inception');
    expect(text).toContain('all folios');
    expect(text).toContain('emailed');
    expect(text).toContain('registered');
    expect(text).toContain('password');
    expect(text).toContain('pan');
    expect(text).toContain('never needs your cams or kfintech login');
  });

  it('makes no promise about timing', () => {
    const text = [FULL_STATEMENT_HELP_INTRO, ...FULL_STATEMENT_STEPS, FULL_STATEMENT_DELIVERY, FULL_STATEMENT_PRIVACY].join(' ');
    expect(text).not.toMatch(/\b(minutes?|hours?|within|instantly|immediately|seconds?|same day|shortly)\b/i);
  });

  it('the closed trigger is a real button with an accessible name and popup semantics, and the dialog is not in the page until opened', () => {
    const html = renderToStaticMarkup(createElement(FullStatementHelp));
    expect(html).toContain('<button');
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-label="How to get a full statement"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="dialog"');
  });

  it('the open dialog is labelled, modal, names both providers, and links open safely in a new tab with a plain note', () => {
    const html = renderToStaticMarkup(createElement(InfoDialog, { open: true, title: 'How to get your full statement', onClose: () => {} } as ComponentProps<typeof InfoDialog>, createElement(FullStatementHelpContent, { id: 'x' })));
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toMatch(/aria-labelledby="info-dialog-title-/);
    expect(html).toMatch(/aria-describedby="info-dialog-body-/);
    expect(html).toContain('Close');

    // The REAL popup body, as the user sees it.
    const body = renderToStaticMarkup(createElement(FullStatementHelpContent, { id: 'x' }));
    expect(body).toContain(`href="${CAMS_STATEMENT_REQUEST_URL}"`);
    expect(body).toContain(`href="${KFIN_STATEMENT_REQUEST_URL}"`);
    expect((body.match(/target="_blank"/g) ?? []).length).toBe(2);
    expect((body.match(/rel="noopener noreferrer"/g) ?? []).length).toBe(2);
    expect(body).toContain('CAMS investor services');
    expect(body).toContain('KFintech investor services');
    expect((body.match(/Opens the provider/g) ?? []).length).toBe(2);
    expect(body).toContain('since inception');
    expect(body).toContain('never needs your CAMS or KFintech login');
  });

  it('FullStatementHelp renders its links only through the allowed-link check, with rel/target and the opens-the-provider note', () => {
    const src = read('components/investment-intelligence/FullStatementHelp.tsx');
    expect(src).toContain('isAllowedStatementLink(p.url)');
    expect(src).toContain('target="_blank"');
    expect(src).toContain('rel="noopener noreferrer"');
    expect(src).toContain('EXTERNAL_LINK_NOTE');
    expect(src).toContain('STATEMENT_PROVIDERS.map');
  });

  it('is placed beside the Upload button on the statement upload screen', () => {
    const src = read('components/investment-intelligence/InvestmentIntelligenceClient.tsx');
    expect(src).toContain("import { FullStatementHelp } from './FullStatementHelp';");
    const upload = src.indexOf("{uploading ? 'Uploading…' : 'Upload'}");
    const help = src.indexOf('<FullStatementHelp />');
    const formEnd = src.indexOf('</form>', upload);
    expect(upload).toBeGreaterThan(0);
    expect(help).toBeGreaterThan(upload);
    expect(help).toBeLessThan(formEnd);
  });
});

describe('InfoDialog accessibility contract (read from source; interaction is not executed here)', () => {
  const src = read('components/ui/InfoDialog.tsx');
  it('closes on Escape', () => expect(src).toMatch(/e\.key === 'Escape'[\s\S]{0,120}onClose\(\)/));
  it('traps Tab and Shift+Tab inside the dialog', () => {
    expect(src).toContain("e.key !== 'Tab'");
    expect(src).toContain('e.shiftKey && active === first');
    expect(src).toContain('last.focus()');
    expect(src).toContain('first.focus()');
  });
  it('moves focus in on open and hands it back to the opener on close (only if it is still on the page)', () => {
    expect(src).toContain('closeRef.current?.focus()');
    expect(src).toContain('returnFocusRef.current = opener instanceof HTMLElement ? opener : null');
    expect(src).toContain('document.contains(opener2)');
    expect(src).toContain('opener2.focus()');
  });
  it('is labelled by its title and described by its body, with per-instance ids', () => {
    expect(src).toContain('aria-labelledby={titleId}');
    expect(src).toContain('aria-describedby={bodyId}');
    expect(src).toContain('useId()');
  });
  it('closes when the dimmed backdrop is clicked', () => expect(src).toContain('onClick={onClose}'));
});

// ---------------------------------------------------------------------------
// Task A UI: the "needs investment date" row
// ---------------------------------------------------------------------------
const item = (over: Partial<InvestmentDateItemView> = {}): InvestmentDateItemView => ({
  accountId: 'acc-1', instrumentId: 'ins-1', schemeName: 'Test Growth Fund', isin: null, maskedFolio: '******7890', institutionName: 'Test AMC',
  currencyCode: 'INR', units: 100, statementAsOfDate: '2026-09-04', statementValue: 15000, state: 'needs_date', investmentDate: null,
  navPrice: null, navDate: null, earliestKnownNavDate: '2013-01-01', ...over,
});
const row = (i: InvestmentDateItemView) => renderToStaticMarkup(createElement(InvestmentDateRow, { item: i, busy: false, serverError: null, onSave: () => {} }));

describe('InvestmentDateRow', () => {
  it('needs_date: says so, explains in words, and offers a labelled day-first text input with a worked example and a save button', () => {
    const html = row(item());
    expect(html).toContain('Needs investment date');
    expect(html).toContain('Date you invested');
    expect(html).toContain('placeholder="DD-MM-YYYY"');
    expect(html).toContain('type="text"'); // never a native date picker (it follows the browser locale)
    expect(html).not.toContain('type="date"');
    expect(html).toContain('like 01-10-2026');
    expect(html).toContain('Save date');
    expect(html).toContain('Everything else keeps working');
    expect(html).toContain('This fund has price history from 01-01-2013.');
    expect(html).toContain('04-09-2026');
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(html).toContain('<label');
  });

  it('shows dates day-first by country: dd-mm-yyyy for India, dd/mm/yyyy for Australia', () => {
    expect(row(item({ currencyCode: 'INR' }))).toContain('04-09-2026');
    expect(row(item({ currencyCode: 'AUD' }))).toContain('04/09/2026');
  });

  it('applied: shows the date you gave and the price used, says the cost is the fund price (not a statement figure), and offers to change it', () => {
    const html = row(item({ state: 'applied', investmentDate: '2024-03-14', navPrice: 40, navDate: '2024-03-14' }));
    expect(html).toContain('Investment date added by you');
    expect(html).toContain('14-03-2024');
    expect(html).toContain('not a figure from your statement');
    expect(html).toContain('Change date');
    expect(html).not.toContain('Save date');
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('awaiting price history: honest about what is pending', () => {
    const html = row(item({ state: 'awaiting_nav', investmentDate: '2024-03-14' }));
    expect(html).toContain('Date saved, waiting for price history');
    expect(html).toContain('14-03-2024');
  });

  it('shows the server\'s refusal in an alert tied to the input', () => {
    const html = renderToStaticMarkup(createElement(InvestmentDateRow, { item: item(), busy: false, serverError: 'The investment date cannot be in the future.', onSave: () => {} }));
    expect(html).toContain('role="alert"');
    expect(html).toContain('cannot be in the future');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toMatch(/aria-describedby="[^"]*-error/);
  });
});
