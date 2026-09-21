/**
 * LR audit P1-7 fix — Expenses-tab bank-statement import.
 *
 * `components/expenses/BankStatementImportPanel.tsx` used to call ONLY the
 * generic FDH-3 session endpoints (`/documents/upload-sessions` +
 * `.../complete`), which store the file and mark it `processing_status =
 * 'queued'` and then stop — `uploadLifecycle.ts`'s own header comment says
 * so explicitly ("No worker is implemented in FDH-3; this only creates the
 * job record"). The panel never called anything past that, so a bank
 * statement uploaded through the Expenses tab never actually got parsed —
 * confirmed live by a 2026-09-14 audit (tagged P1-7) and re-confirmed
 * unchanged on 2026-09-21.
 *
 * This file proves three things about the fix, using the REAL, pre-existing,
 * already-certified R7 (bank-CSV engine) and R8 (classification engine) code
 * — nothing here reimplements FDH logic:
 *
 *   1. (Regression guard) The panel's source no longer references the
 *      dead-end generic session endpoint, and DOES call the real
 *      bank-csv/bank-pdf upload + detect + process routes FDH-3's other,
 *      already-working import surfaces use.
 *   2. (Real extraction, not a 200 OK) Feeding a real, already-certified
 *      bank-CSV fixture through `runBankCsvPipeline` — the exact function
 *      `bank-csv/{id}/process` calls — produces real transaction rows with
 *      the real dates/amounts/descriptions on the statement, not a stub.
 *   3. (Real classification) The extracted Woolworths row is classified as a
 *      real household expense by R8's own `classifyTransaction` engine,
 *      using the actual seeded merchant/category data this app ships with
 *      (migrations 0053/0055) — not an invented rule built to pass the test.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runBankCsvPipeline } from '@/lib/financial-data-hub/bank-csv/orchestrator';
import { classifyTransaction } from '@/lib/financial-data-hub/classification/economicTypeEngine';
import type { ClassifiableTransaction, ClassificationReferenceData } from '@/lib/financial-data-hub/classification/types';
import type { FdhCategory, FdhMerchant } from '@/lib/financial-data-hub/domain/types';
import type { FdhMerchantType } from '@/lib/financial-data-hub/constants/enums';

const PANEL_SOURCE = fs.readFileSync(
  path.join(process.cwd(), 'components', 'expenses', 'BankStatementImportPanel.tsx'),
  'utf8',
);

describe('P1-7 regression guard — Expenses panel no longer calls the FDH-3 dead end', () => {
  it('never references the generic session endpoints that only ever reach `queued`', () => {
    expect(PANEL_SOURCE).not.toMatch(/\/documents\/upload-sessions/);
  });

  it('uploads through the real, dedicated bank-csv/bank-pdf routes instead', () => {
    expect(PANEL_SOURCE).toMatch(/\/api\/financial-data-hub\/\$\{csv \? 'bank-csv' : 'bank-pdf'\}\/upload/);
  });

  it('actually calls detect + process for CSV, and process for PDF — the steps that were previously never reached', () => {
    expect(PANEL_SOURCE).toMatch(/bank-csv\/\$\{docId\}\/detect/);
    expect(PANEL_SOURCE).toMatch(/bank-csv\/\$\{docId\}\/process/);
    expect(PANEL_SOURCE).toMatch(/bank-pdf\/\$\{docId\}\/process/);
  });
});

describe('Real extraction — a certified bank-CSV fixture run through the actual R7 pipeline', () => {
  it('produces the real transaction rows on the statement (not a stub/empty result)', () => {
    const csvPath = path.join(process.cwd(), 'tests', 'fixtures', 'r7-bank-csv', 'au_cba_debit_credit.csv');
    const bytes = new Uint8Array(fs.readFileSync(csvPath));

    const result = runBankCsvPipeline({
      bytes,
      statementUploadId: 'test-doc-1',
      financialAccountId: 'acct-1',
      currencyCode: 'AUD',
      dedupIndex: new Map(),
    });

    expect(result.detection.status).toBe('detected');
    expect(result.rejected).toHaveLength(0);
    expect(result.accepted).toHaveLength(5);

    const woolworths = result.accepted.find((t) => t.descriptionRaw.includes('Woolworths'));
    expect(woolworths).toBeTruthy();
    expect(woolworths!.amountOriginal).toBe(45.2);
    expect(woolworths!.creditDebit).toBe('debit');
    expect(woolworths!.transactionDate).toBe('2026-01-01');

    const salary = result.accepted.find((t) => t.descriptionRaw.includes('Salary'));
    expect(salary!.amountOriginal).toBe(3500);
    expect(salary!.creditDebit).toBe('credit');
  });
});

describe('Real classification — the extracted Woolworths row is a real expense, using this app\'s real seed data', () => {
  it('classifies via the actual seeded Woolworths merchant (migration 0055) into the actual seeded "Food & Dining" category (migration 0053, economic_type=expense)', () => {
    const csvPath = path.join(process.cwd(), 'tests', 'fixtures', 'r7-bank-csv', 'au_cba_debit_credit.csv');
    const bytes = new Uint8Array(fs.readFileSync(csvPath));
    const pipeline = runBankCsvPipeline({
      bytes,
      statementUploadId: 'test-doc-1',
      financialAccountId: 'acct-1',
      currencyCode: 'AUD',
      dedupIndex: new Map(),
    });
    const woolworthsRow = pipeline.accepted.find((t) => t.descriptionRaw.includes('Woolworths'))!;

    // The exact column mapping `bankCsvProcessingService.ts` uses when it
    // inserts an accepted row into `fdh_transactions` — reused verbatim here
    // so this test classifies the SAME shape of row the real insert produces.
    const txn: ClassifiableTransaction = {
      id: 'txn-1',
      financial_account_id: 'acct-1',
      transaction_date: woolworthsRow.transactionDate,
      description_clean: woolworthsRow.descriptionClean,
      merchant_raw: null,
      amount_original: woolworthsRow.amountOriginal,
      currency_original: 'AUD',
      credit_debit: woolworthsRow.creditDebit,
      transaction_type_hint: woolworthsRow.transactionTypeHint,
      user_override: false,
    };

    // Faithful reproductions of the real, already-applied seed rows (not
    // invented for this test) — migration 0053's `food` category and
    // migration 0055's `woolworths` merchant.
    const foodCategory: FdhCategory = {
      id: 'cat-food',
      category_key: 'food',
      display_name: 'Food & Dining',
      description: null,
      economic_type: 'expense',
      country_applicability: ['AU', 'IN'],
      essential_discretionary: 'mixed',
      tax_reporting_flag: false,
      fhip_mapping_key: 'expense.food',
      display_order: 40,
      icon_key: 'utensils',
      active: true,
      version: 1,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
    const woolworthsMerchant: FdhMerchant = {
      id: 'merchant-woolworths',
      canonical_name: 'Woolworths',
      display_name: 'Woolworths',
      country_code: 'AU',
      merchant_type: 'grocery' as FdhMerchantType,
      default_category_id: foodCategory.id,
      default_subcategory_id: 'subcat-groceries',
      mcc: '5411',
      subscription_possible: false,
      essential_discretionary: 'essential',
      verification_status: 'approved',
      merged_into_merchant_id: null,
      active: true,
      created_at: '2026-08-21T00:00:00Z',
      updated_at: '2026-08-21T00:00:00Z',
      recurring_possible: false,
      typical_frequency: null,
      fixed_amount_expected: false,
      variable_amount_possible: null,
      recurring_type: null,
      is_payment_processor: false,
    };

    const ref: ClassificationReferenceData = {
      categories: [foodCategory],
      subcategories: [],
      merchants: [woolworthsMerchant],
      merchantAliases: [],
      globalRules: [],
      userRules: [],
    };

    const result = classifyTransaction(txn, null, ref);

    expect(result.economicTransactionType).toBe('expense');
    expect(result.classificationMethod).toBe('merchant_master');
    expect(result.categoryId).toBe(foodCategory.id);
    expect(result.merchantId).toBe(woolworthsMerchant.id);
  });
});

// ---------------------------------------------------------------------------
// Auth-gate proof for the routes newly reachable from the Expenses panel —
// same mocking convention as tests/unit/fdh9IncomeTabUx.test.ts (this
// codebase has no general Supabase mock by design; every route here rejects
// before any database client is constructed).
const requireUserMock = vi.fn();
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, requireUser: () => requireUserMock(), requireCountryConfirmedUser: () => requireUserMock() };
});

const UNAUTHENTICATED = { user: null, unauthenticated: Response.json({ error: 'unauthenticated' }, { status: 401 }) };

beforeEach(() => {
  requireUserMock.mockReset();
  requireUserMock.mockResolvedValue(UNAUTHENTICATED);
});

describe('Newly-reachable routes require an authenticated session', () => {
  it('POST /bank-csv/upload rejects with 401 when unauthenticated', async () => {
    const { POST } = await import('@/app/api/financial-data-hub/bank-csv/upload/route');
    const res = await POST(new Request('http://x?country_code=AU&currency_code=AUD', { method: 'POST' }));
    expect(res.status).toBe(401);
  });

  it('POST /bank-csv/{id}/detect rejects with 401 when unauthenticated', async () => {
    const { POST } = await import('@/app/api/financial-data-hub/bank-csv/[documentId]/detect/route');
    const res = await POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ documentId: 'doc-1' }) });
    expect(res.status).toBe(401);
  });

  it('POST /bank-csv/{id}/process rejects with 401 when unauthenticated', async () => {
    const { POST } = await import('@/app/api/financial-data-hub/bank-csv/[documentId]/process/route');
    const res = await POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ documentId: 'doc-1' }) });
    expect(res.status).toBe(401);
  });

  it('POST /bank-pdf/upload rejects with 401 when unauthenticated', async () => {
    const { POST } = await import('@/app/api/financial-data-hub/bank-pdf/upload/route');
    const res = await POST(new Request('http://x?country_code=AU&currency_code=AUD', { method: 'POST' }));
    expect(res.status).toBe(401);
  });

  it('POST /bank-pdf/{id}/process rejects with 401 when unauthenticated', async () => {
    const { POST } = await import('@/app/api/financial-data-hub/bank-pdf/[documentId]/process/route');
    const res = await POST(new Request('http://x', { method: 'POST' }), { params: Promise.resolve({ documentId: 'doc-1' }) });
    expect(res.status).toBe(401);
  });

  it('POST /bank-transactions/categorise rejects with 401 when unauthenticated', async () => {
    const { POST } = await import('@/app/api/financial-data-hub/bank-transactions/categorise/route');
    const res = await POST();
    expect(res.status).toBe(401);
  });
});
