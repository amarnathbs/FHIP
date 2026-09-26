/**
 * Financial Data Hub route and API path builders (WP-01 (k)).
 *
 * WHY THIS FILE EXISTS. tests/unit/fdh1Isolation.test.ts flags every file
 * outside the FDH module whose text contains the FDH path segment, and each
 * new UI surface that links to a statement (Expenses "Actual (imported)",
 * Liabilities / Retirement / Income statement details, Investments imports)
 * would otherwise need its own allow-list entry. This file is allow-listed
 * ONCE; every other package builds its links and fetch URLs through it.
 *
 * Pure string builders only: no imports, no data access, safe on the client.
 * Every id is URI-encoded.
 */

const BASE_PAGE = '/financial-data-hub';
const BASE_API = '/api/financial-data-hub';

/** Where the user came from, so the FDH page can offer "Back to <tab>". */
export type FdhReturnTab = 'expenses' | 'income' | 'liabilities' | 'investments' | 'retirement' | 'assets' | 'dashboard';

const enc = encodeURIComponent;
const withFrom = (href: string, from?: FdhReturnTab) => (from ? `${href}${href.includes('?') ? '&' : '?'}from=${enc(from)}` : href);

export const fdhPages = {
  hub: () => BASE_PAGE,
  /** The statement review workspace (category review + approval). */
  statementReview: (statementUploadId: string, from?: FdhReturnTab) =>
    withFrom(`${BASE_PAGE}/review?statement=${enc(statementUploadId)}`, from),
  /** One transaction inside the review workspace. */
  transactionReview: (transactionId: string, from?: FdhReturnTab) =>
    withFrom(`${BASE_PAGE}/review?transaction=${enc(transactionId)}`, from),
  reviewQueue: (from?: FdhReturnTab) => withFrom(`${BASE_PAGE}/review`, from),
  activity: () => `${BASE_PAGE}/activity`,
  activityTransactions: (filter: { accountId?: string } = {}) =>
    filter.accountId ? `${BASE_PAGE}/activity/transactions?account_id=${enc(filter.accountId)}` : `${BASE_PAGE}/activity/transactions`,
  activitySpending: () => `${BASE_PAGE}/activity/spending`,
  activityIncome: () => `${BASE_PAGE}/activity/income`,
} as const;

export const fdhApi = {
  document: (documentId: string) => `${BASE_API}/documents/${enc(documentId)}`,
  documentApprove: (documentId: string) => `${BASE_API}/documents/${enc(documentId)}/approve`,
  documentReviewSummary: (documentId: string) => `${BASE_API}/documents/${enc(documentId)}/review-summary`,
  documentApprovedSummary: (documentId: string) => `${BASE_API}/documents/${enc(documentId)}/approved-summary`,
  documentCategoryReview: (documentId: string) => `${BASE_API}/documents/${enc(documentId)}/category-review`,
  bankTransaction: (transactionId: string) => `${BASE_API}/bank-transactions/${enc(transactionId)}`,
  bankTransactions: () => `${BASE_API}/bank-transactions`,
  payslip: (documentId: string) => `${BASE_API}/payslip/${enc(documentId)}`,
  liabilityStatement: (documentId: string) => `${BASE_API}/liability-statement/${enc(documentId)}`,
  retirementStatement: (documentId: string) => `${BASE_API}/retirement-statement/${enc(documentId)}`,
  investmentStatement: (documentId: string) => `${BASE_API}/investment-statement/${enc(documentId)}`,
  // WP-13: the Retirement tab's statement history (paged list) and the
  // user's confirmation of a matched bank payment on one statement line.
  retirementStatements: (page = 1, pageSize = 10) => `${BASE_API}/retirement-statement?page=${enc(String(page))}&page_size=${enc(String(pageSize))}`,
  retirementStatementBankLeg: (documentId: string) => `${BASE_API}/retirement-statement/${enc(documentId)}/bank-leg`,
} as const;
