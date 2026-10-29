/**
 * RENDER evidence for the bulk "Choose a category" UI (2026-10-29), without a browser.
 *
 * The real StatementCategoryReview component is server-rendered (react-dom/server) with its state seeded to the screen the PO
 * reported: a review payload produced by the REAL category-review route over the in-memory database, 60 lines that need a
 * category (so the card list is paged), one with a suggested category, dates exactly as the API returns them (yyyy-mm-dd).
 * Hooks are seeded by call order (see HOOK ORDER below); effects do not run in a server render, so this proves what the
 * component DRAWS for a given state, not click handling. Click handling is covered by the pure-logic and route tests;
 * a real browser click-through was NOT PERFORMED (see the report).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- the seeded state is raw JSON */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createFakeDb, type FakeDb } from '../support/fdhFakeSupabase';
import { CAT, STATEMENT_A, TXN, USER_A, seedAll } from '../support/fdhCategoryReviewFixture';

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, seed: [] as unknown[] }));

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db.sessionClient(USER_A) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.adminClient() }));
vi.mock('@/lib/api', async (importOriginal) => ({ ...(await importOriginal<object>()), requireCountryConfirmedUser: async () => ({ user: { id: USER_A } }) }));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  let call = 0;
  const useState = (initial: unknown) => {
    const i = call;
    call += 1;
    if (i < h.seed.length && h.seed[i] !== undefined) return [h.seed[i], () => undefined];
    return [typeof initial === 'function' ? (initial as () => unknown)() : initial, () => undefined];
  };
  return { ...actual, default: { ...actual, useState }, useState, useEffect: () => undefined, __reset: () => { call = 0; } };
});

vi.setConfig({ testTimeout: 60000 });

const CATEGORIES = [
  { id: CAT.income, label: 'Income', economicType: 'income' },
  { id: CAT.housing, label: 'Housing', economicType: 'expense' },
  { id: CAT.transfer, label: 'Own-Account Transfer', economicType: 'transfer' },
];

beforeEach(() => {
  h.db = createFakeDb();
  seedAll(h.db);
});

async function reviewPayload() {
  const route = await import('@/app/api/financial-data-hub/documents/[documentId]/category-review/route');
  const res: Response = await route.GET(new Request('http://local/x'), { params: Promise.resolve({ documentId: STATEMENT_A }) });
  return (await res.json()).data;
}

async function render(seedByName: Record<string, unknown>) {
  // HOOK ORDER of StatementCategoryReview's useState calls (top of the component).
  const order = ['review', 'loading', 'loadError', 'busy', 'announcement', 'actionError', 'choices', 'remember', 'selected', 'cardPage', 'bulkCategory', 'bulkRemember', 'confirm', 'bulkResult'];
  h.seed = order.map((k) => seedByName[k]);
  ((await import('react')) as any).__reset();
  const { StatementCategoryReview } = await import('@/app/(app)/financial-data-hub/review/StatementCategoryReview');
  return renderToStaticMarkup(
    React.createElement(StatementCategoryReview, { statementId: STATEMENT_A, categories: CATEGORIES, backHref: '/expenses', backLabel: 'Back to Expenses', fromParam: 'expenses' }),
  );
}

describe('RENDER: the screen the PO reported, with the bulk tools', () => {
  it('shows the bulk panel, a checkbox per card, day-first dates, suggested category, Remember and Save on every card', async () => {
    const review = await reviewPayload();
    const base = { review, loading: false, loadError: null, busy: null, announcement: '', actionError: null, choices: {}, remember: {}, cardPage: 1, bulkCategory: '', bulkRemember: false, confirm: null, bulkResult: null };
    const html = await render({ ...base, selected: new Set<string>() });

    expect(html).toContain('Choose a category for many at once');
    expect(html).toContain('Select all on this page (4)');
    expect(html).toContain('0 transactions selected');
    expect(html).toContain('Clear selection');
    // One checkbox per card, plus Remember and Save kept on each card.
    expect((html.match(/id="select-/g) ?? []).length).toBe(4);
    expect((html.match(/Remember this payee next time/g) ?? []).length).toBe(4);
    expect((html.match(/Save category/g) ?? []).length).toBe(4);
    // The suggestion stays visible on the card.
    expect(html).toContain('(suggested: Own-Account Transfer)');
    // Same payee appears twice in the fixture: the "select all like this" shortcut is offered.
    expect(html).toContain('Select all 2 like this');
    // Dates: dd/mm/yyyy, never yyyy-mm-dd.
    expect(html).toMatch(/\d{2}\/\d{2}\/\d{4}/);
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    // The summary and the explicit approval steps are still there.
    expect(html).toContain('waiting for your approval');
    expect(html).toContain('Approve everything');
    expect(html).toContain('Nothing is approved');
  });

  it('with two cards ticked it offers the one-category apply and the suggested convenience, and the confirmation states count and category', async () => {
    const review = await reviewPayload();
    const ids = [TXN.rent, TXN.toSavings];
    const base = { review, loading: false, loadError: null, busy: null, announcement: '', actionError: null, choices: {}, remember: {}, cardPage: 1, bulkRemember: true, bulkResult: null };
    const html = await render({ ...base, selected: new Set(ids), bulkCategory: CAT.housing, confirm: 'category' });
    expect(html).toContain('2 transactions selected, 1 with a suggested category');
    expect(html).toContain('Category for all selected');
    expect(html).toContain('Apply category to 2 selected transactions');
    expect(html).toContain('Apply the suggested category to the 1 selected that has one');
    expect(html).toContain('Set the category &quot;Housing&quot; on 2 transactions?');
    expect(html).toContain('Nothing is approved');
    expect(html).toContain('Each payee will also be remembered for next time.');
    expect(html).toContain('Yes, set 2 transactions to Housing');
    expect(html).toContain('Cancel');
    expect((html.match(/checked=""/g) ?? []).length).toBeGreaterThanOrEqual(3); // two card boxes + the Remember box
  });

  it('after a partly failed bulk save it lists exactly which lines failed and why, and the card list is paged by "Page"', async () => {
    const review = await reviewPayload();
    // 60 lines need a category: the list is paged and the control says Page, not lines.
    const many = Array.from({ length: 60 }, (_, i) => ({ ...review.needs_decision[0], id: `f9000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, description: `Synthetic Payee ${i}` }));
    const big = { ...review, needs_decision: many, counts: { ...review.counts, needs_decision: 60 } };
    const result = { failed: [{ transaction_id: many[0].id, description: 'Synthetic Payee 0', code: 'already_approved', message: 'Already approved. Reopen the statement to change it.' }] };
    const base = { review: big, loading: false, loadError: null, busy: null, announcement: '', actionError: null, choices: {}, remember: {}, selected: new Set<string>(), bulkCategory: '', bulkRemember: false, confirm: null, bulkResult: result };
    const html = await render({ ...base, cardPage: 2 });
    expect(html).toContain('Page 2 of 2, transactions 51 to 60 of 60');
    expect(html).toContain('>Previous page</button>');
    expect(html).toContain('>Next page</button>');
    expect(html).toContain('1 transaction could not be set. The others were saved.');
    expect(html).toContain('Synthetic Payee 0: Already approved. Reopen the statement to change it.');
    expect(html).toContain('Select all on this page (10)');
    expect(html).toContain('Select all 60 that need a category');
  });
});
