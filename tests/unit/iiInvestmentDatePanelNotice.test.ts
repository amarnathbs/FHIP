// The date panel's plain-words status after a save, and the "Check again" retry
// for an answer that is waiting for price history (PO 2026-10-03). Markup only:
// the repo has no jsdom, so clicking is not executed here.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InvestmentDateRow, type InvestmentDateItemView } from '@/components/investment-intelligence/InvestmentDatePanel';
import { NAV_STATUS_MESSAGE, navStatusFor } from '@/lib/services/investment-intelligence/investmentDateService';

const item = (over: Partial<InvestmentDateItemView> = {}): InvestmentDateItemView => ({
  accountId: 'acc-1', instrumentId: 'ins-1', schemeName: 'Test Growth Fund', isin: null, maskedFolio: null, institutionName: null,
  currencyCode: 'INR', units: 100, statementAsOfDate: '2026-09-04', statementValue: 15000, state: 'awaiting_nav', investmentDate: '2024-03-14',
  navPrice: null, navDate: null, earliestKnownNavDate: null, ...over,
});
const row = (i: InvestmentDateItemView, notice?: string | null) => renderToStaticMarkup(createElement(InvestmentDateRow, { item: i, busy: false, serverError: null, notice, onSave: () => {} }));

describe('NAV status words', () => {
  it('maps the outcome to applied / waiting for NAV data / failed, never raw codes', () => {
    expect(navStatusFor('applied', null)).toBe('applied');
    expect(navStatusFor('awaiting_nav', 'no_data')).toBe('waiting_for_nav');
    expect(navStatusFor('awaiting_nav', 'rate_limited')).toBe('waiting_for_nav');
    expect(navStatusFor('awaiting_nav', 'failed')).toBe('failed');
    expect(navStatusFor('awaiting_nav', null)).toBe('waiting_for_nav');
  });
  it('the waiting and failed messages both say we will keep trying, and none contains a date or an id', () => {
    expect(NAV_STATUS_MESSAGE.waiting_for_nav).toContain('We will keep trying');
    expect(NAV_STATUS_MESSAGE.failed).toContain('We will keep trying');
    for (const m of Object.values(NAV_STATUS_MESSAGE)) expect(m).not.toMatch(/\d{2,4}-\d{2}-\d{2,4}|[0-9a-f]{8}-/);
  });
});

describe('InvestmentDateRow: waiting for price history', () => {
  it('shows the saved date day-first, offers Check again, and shows the server\'s plain message', () => {
    const html = row(item(), NAV_STATUS_MESSAGE.waiting_for_nav);
    expect(html).toContain('Date saved, waiting for price history');
    expect(html).toContain('14-03-2024');
    expect(html).toContain('Check again');
    expect(html).toContain('We will keep trying');
    expect(html).toContain('role="status"');
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
  it('an applied answer has no Check again; a needs-date row has none either', () => {
    expect(row(item({ state: 'applied', navPrice: 40, navDate: '2024-03-14' }))).not.toContain('Check again');
    expect(row(item({ state: 'needs_date', investmentDate: null }))).not.toContain('Check again');
  });
  it('no message is shown when there is none', () => {
    expect(row(item())).not.toContain('role="status"');
  });
});
