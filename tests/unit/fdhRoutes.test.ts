/**
 * WP-01 (k): the FDH route/API builders other packages link through. Pinned to
 * the exact paths the app already uses (BankStatementImportPanel's review link,
 * the Activity pages) and to the route files that exist under app/, so a
 * builder can never point at a page or endpoint that is not there.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { fdhApi, fdhPages } from '@/lib/import-bridge/fdhRoutes';

const ROOT = path.resolve(__dirname, '../..');

describe('fdhPages', () => {
  it('builds the statement review link the bank import panel already uses', () => {
    expect(fdhPages.statementReview('abc', 'expenses')).toBe('/financial-data-hub/review?statement=abc&from=expenses');
    expect(fdhPages.reviewQueue('expenses')).toBe('/financial-data-hub/review?from=expenses');
    expect(fdhPages.transactionReview('t1')).toBe('/financial-data-hub/review?transaction=t1');
  });

  it('URI-encodes every id', () => {
    expect(fdhPages.statementReview('a b&c')).toBe('/financial-data-hub/review?statement=a%20b%26c');
    expect(fdhApi.liabilityStatement('x/y')).toBe('/api/financial-data-hub/liability-statement/x%2Fy');
    expect(fdhPages.activityTransactions({ accountId: 'a?b' })).toBe('/financial-data-hub/activity/transactions?account_id=a%3Fb');
  });

  it('every page builder resolves to a real page under app/(app)', () => {
    const pages = [fdhPages.hub(), fdhPages.reviewQueue(), fdhPages.activity(), fdhPages.activityTransactions(), fdhPages.activitySpending(), fdhPages.activityIncome()];
    for (const href of pages) {
      const p = href.split('?')[0];
      expect(fs.existsSync(path.join(ROOT, 'app', '(app)', p, 'page.tsx')), `${p} has no page.tsx`).toBe(true);
    }
  });

  it('every API builder resolves to a real route under app/api', () => {
    const id = '[documentId]';
    const apis = [
      [fdhApi.document('X'), `financial-data-hub/documents/${id}`],
      [fdhApi.documentApprove('X'), `financial-data-hub/documents/${id}/approve`],
      [fdhApi.documentReviewSummary('X'), `financial-data-hub/documents/${id}/review-summary`],
      [fdhApi.documentApprovedSummary('X'), `financial-data-hub/documents/${id}/approved-summary`],
      [fdhApi.documentCategoryReview('X'), `financial-data-hub/documents/${id}/category-review`],
      [fdhApi.bankTransaction('X'), 'financial-data-hub/bank-transactions/[transactionId]'],
      [fdhApi.bankTransactions(), 'financial-data-hub/bank-transactions'],
      [fdhApi.payslip('X'), `financial-data-hub/payslip/${id}`],
      [fdhApi.liabilityStatement('X'), `financial-data-hub/liability-statement/${id}`],
      [fdhApi.retirementStatement('X'), `financial-data-hub/retirement-statement/${id}`],
      [fdhApi.investmentStatement('X'), `financial-data-hub/investment-statement/${id}`],
    ] as const;
    for (const [href, dir] of apis) {
      expect(href.startsWith('/api/financial-data-hub/')).toBe(true);
      expect(fs.existsSync(path.join(ROOT, 'app', 'api', dir, 'route.ts')), `${dir} has no route.ts`).toBe(true);
    }
  });
});
