/**
 * Document2 (4) WP-B (F13): the "Imported, not yet in Net Worth" warning must say where to resolve it, carry the exact statement,
 * use day-first dates, and CLEAR once the position is published (it is derived live, never dismissed).
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

import { selectInvestments } from '@/lib/read-models/investments';
import { importedNotInNetWorthActions } from '@/lib/investment-intelligence/importedNotInNetWorthLinks';
import { DashboardDataStatusNotice } from '@/components/dashboard/DashboardDataStatusNotice';
import { toCanonicalCashFlow } from '@/lib/services/dashboardCanonicalAdapter';
import { makeFakeSupabase, type Row } from './helpers/fakeSupabase';
import { profile, tables, USER } from './helpers/fixtures';

const snap = (id: string, acc: string, inst: string, date: string, value: number, extra: Row = {}): Row => ({
  id, user_id: USER, account_id: acc, instrument_id: inst, as_of_date: date, units: 10, value, currency_code: 'INR', created_at: `${date}T00:00:00Z`, ...extra,
});

describe('importedNotInNetWorthActions', () => {
  it('one India statement -> a link that opens THAT statement', () => {
    expect(importedNotInNetWorthActions({ documentIds: ['doc-1'], currencies: ['INR'] })).toEqual([
      { href: '/investment-intelligence/data?documentId=doc-1', label: 'Resolve and publish this statement' },
    ]);
  });
  it('several India statements -> the Statements & data list', () => {
    expect(importedNotInNetWorthActions({ documentIds: ['a', 'b'], currencies: ['INR'] })[0].href).toBe('/investment-intelligence/data');
  });
  it('an Australian broker import -> the Investments page; a mixed bucket offers both', () => {
    expect(importedNotInNetWorthActions({ documentIds: [], currencies: ['AUD'] })).toEqual([{ href: '/investments', label: 'Add to Net Worth on the Investments page' }]);
    const both = importedNotInNetWorthActions({ documentIds: ['d'], currencies: ['INR', 'AUD'] });
    expect(both.map((a) => a.href)).toEqual(['/investment-intelligence/data?documentId=d', '/investments']);
  });
  it('an unknown destination never yields a link to nowhere: it falls back to the Investments page', () => {
    expect(importedNotInNetWorthActions(null)).toEqual([{ href: '/investments', label: 'Add to Net Worth on the Investments page' }]);
  });
});

describe('the read model carries the statement, and the bucket clears after publishing', () => {
  it('unpublished holdings expose their source statement; once a publication row exists the bucket no longer counts it', async () => {
    const base = { investments: [] as Row[], ii_holding_snapshots: [snap('s1', 'acc1', 'hdfc', '2026-09-04', 92231, { source_document_id: 'doc-1' })] };
    const before = await selectInvestments(USER, { client: makeFakeSupabase(tables(profile(), { ...base, ii_fhip_publications: [] })).client });
    if (before.status !== 'ok') throw new Error('unavailable');
    expect(before.unpublished.count).toBe(1);
    expect(before.unpublished.holdings[0].sourceDocumentId).toBe('doc-1');

    // the person publishes the position: the bucket is recomputed from the live data and is empty
    const after = await selectInvestments(USER, { client: makeFakeSupabase(tables(profile(), { ...base, ii_fhip_publications: [{ user_id: USER, canonical_position_id: 's1', status: 'published' }] })).client });
    expect(after.status === 'ok' && after.unpublished.count).toBe(0);
  });

  it('the dashboard adapter passes the statement ids and currencies through for the call to action', async () => {
    const res = await selectInvestments(USER, { client: makeFakeSupabase(tables(profile(), { investments: [], ii_holding_snapshots: [snap('s1', 'acc1', 'hdfc', '2026-09-04', 92231, { source_document_id: 'doc-1' })], ii_fhip_publications: [] })).client });
    if (res.status !== 'ok') throw new Error('unavailable');
    const na = { status: 'unavailable', reason: 'x', source: 'x' };
    const cf = toCanonicalCashFlow({ status: 'ok', investments: res, income: na, expenses: na, liabilities: na, retirement: na, assets: na, ledger: na, window: { from: '2026-01-01', to: '2026-09-30', months: [] } } as never);
    expect(cf.importedNotInNetWorth?.where).toEqual({ documentIds: ['doc-1'], currencies: ['INR'] });
  });
});

describe('DashboardDataStatusNotice', () => {
  const status = (where: { documentIds: string[]; currencies: string[] } | undefined) =>
    ({
      unavailable: [], unconverted: { count: 0, byCurrency: {} }, netIncomeImplausible: [], retirementContributionFrequencyUnknown: 0,
      importedNotInNetWorth: { label: 'Imported, not yet in Net Worth', count: 16, total: 14060.55, ...(where ? { where } : {}) },
      publishedValuation: null, bankBalanceEvidence: null, possibleDuplicateIncomeCount: 0, costOfDebtMonthly: 0, netIncomeAssumed: null,
    }) as never;

  it('renders a real link to the exact statement next to the warning', () => {
    const html = renderToStaticMarkup(createElement(DashboardDataStatusNotice, { status: status({ documentIds: ['doc-1'], currencies: ['INR'] }), currency: 'AUD' }));
    expect(html).toContain('Imported, not yet in Net Worth: 16 holdings');
    expect(html).toContain('href="/investment-intelligence/data?documentId=doc-1"');
    expect(html).toContain('Resolve and publish this statement');
  });

  it('even without location data the warning still has a call to action (never a dead note)', () => {
    const html = renderToStaticMarkup(createElement(DashboardDataStatusNotice, { status: status(undefined), currency: 'AUD' }));
    expect(html).toContain('href="/investments"');
  });

  it('renders nothing when nothing is imported-but-not-counted (the warning clears after resolution)', () => {
    const empty = { ...(status(undefined) as object), importedNotInNetWorth: null } as never;
    expect(renderToStaticMarkup(createElement(DashboardDataStatusNotice, { status: empty, currency: 'AUD' }))).toBe('');
  });
});
