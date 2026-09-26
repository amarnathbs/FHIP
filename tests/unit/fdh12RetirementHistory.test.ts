/**
 * WP-13 -- retirement statement EVIDENCE is user-visible (GAP-RET-03/04),
 * nothing the reader skips vanishes (GAP-RET-05), and a later bank statement
 * re-links a super contribution without ever stripping an existing link
 * (GAP-RET-07, the post-bank-approval seam).
 *
 * Negative controls: every `describe` below fails on the base branch
 * (feature/canonical-upload-foundation @ f79374f) -- the history component,
 * list route, warnings module and matcher entry do not exist there, the review
 * rendered only 11 header fields, the summary reader kept only the LAST fee
 * line and dropped unrecognised labels silently, and a re-run of the bank
 * matcher nulled an activity's own link. See the WP-13 report for the run.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// A small PostgREST-shaped in-memory client: filters applied for real, the
// 1000-row cap enforced on un-ranged selects, count/head supported, every
// request recorded (so user scoping can be asserted).
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  requests: [] as { table: string; filters: string[]; range: [number, number] | null }[],
  updates: [] as { table: string; patch: Record<string, unknown> }[],
  user: { id: 'user-a' } as { id: string } | null,
}));

function query(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  const names: string[] = [];
  const orders: { col: string; asc: boolean; nullsFirst: boolean }[] = [];
  let range: [number, number] | null = null;
  let head = false;
  let count = false;
  let patch: Row | null = null;
  const run = () => {
    h.requests.push({ table, filters: names, range });
    let rows = (h.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    if (patch) {
      for (const r of rows) Object.assign(r, patch);
      h.updates.push({ table, patch });
      return { data: rows, error: null, count: null };
    }
    if (orders.length) {
      rows = [...rows].sort((a, b) => {
        for (const o of orders) {
          const av = a[o.col]; const bv = b[o.col];
          if (av === bv) continue;
          if (av === null || av === undefined) return o.nullsFirst ? -1 : 1;
          if (bv === null || bv === undefined) return o.nullsFirst ? 1 : -1;
          return (String(av) < String(bv) ? -1 : 1) * (o.asc ? 1 : -1);
        }
        return 0;
      });
    }
    const total = rows.length;
    if (head) return { data: null, error: null, count: total };
    rows = range ? rows.slice(range[0], range[1] + 1) : rows.slice(0, 1000);
    return { data: rows, error: null, count: count ? total : null };
  };
  const chain: Record<string, unknown> = {
    select: (_c?: string, o?: { count?: string; head?: boolean }) => { head = !!o?.head; count = !!o?.count; return chain; },
    update: (p: Row) => { patch = p; return chain; },
    eq: (c: string, v: unknown) => { names.push(`${c}=${String(v)}`); filters.push((r) => r[c] === v); return chain; },
    neq: (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return chain; },
    in: (c: string, vs: unknown[]) => { names.push(`${c} in`); filters.push((r) => vs.includes(r[c])); return chain; },
    is: (c: string, v: null) => { filters.push((r) => (r[c] ?? null) === v); return chain; },
    not: (c: string, _op: string, v: null) => { filters.push((r) => (r[c] ?? null) !== v); return chain; },
    order: (col: string, o?: { ascending?: boolean; nullsFirst?: boolean }) => { orders.push({ col, asc: o?.ascending !== false, nullsFirst: o?.nullsFirst === true }); return chain; },
    range: (a: number, b: number) => { range = [a, b]; return chain; },
    maybeSingle: async () => { const r = run(); return { data: (r.data as Row[] | null)?.[0] ?? null, error: null }; },
    single: async () => { const r = run(); return { data: (r.data as Row[] | null)?.[0] ?? null, error: null }; },
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => { try { return Promise.resolve(res(run())); } catch (e) { return rej ? rej(e) : Promise.reject(e); } },
  };
  return chain;
}
const client = { from: (t: string) => query(t), rpc: vi.fn() };

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => client }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => client }));
vi.mock('@/lib/financial-data-hub/services/auditLog', () => ({ recordDocumentAuditEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    requireCountryConfirmedUser: async () => (h.user ? { user: h.user, unauthenticated: null } : { user: null, unauthenticated: actual.bad('unauthenticated', 401) }),
  };
});

import { GET as listStatements } from '@/app/api/financial-data-hub/retirement-statement/route';
import {
  RetirementStatementHistoryView,
  normaliseRetirementHistory,
  STATEMENT_HEADER_FIELDS,
} from '@/components/retirement/RetirementStatementHistory';
import { detectRetirementCsvFormat } from '@/lib/financial-data-hub/retirement/detection';
import { extractRetirementStatement } from '@/lib/financial-data-hub/retirement/extraction';
import { structureExtractionWarnings } from '@/lib/financial-data-hub/retirement/warnings';
import { matchRetirementActivitiesToBank, rematchRetirementActivitiesAfterBankApproval } from '@/lib/financial-data-hub/services/retirementStatementProcessingService';
import { POST_BANK_APPROVAL_MATCHERS } from '@/lib/import-bridge/postBankApprovalMatchers';

const REPO = path.resolve(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const bytes = (text: string) => new TextEncoder().encode(text);

const A = 'user-a';
const B = 'user-b';

/** A statement row exactly as PostgREST returns it (numeric -> string). */
function statementRow(id: string, over: Row = {}): Row {
  return {
    id, user_id: A, statement_upload_id: `doc-${id}`, statement_type: 'super_annual_statement', retirement_jurisdiction: 'AU',
    account_type: 'industry_super', fund_name: 'Hostplus', nickname: null, masked_account_identifier: '****4821', currency_code: 'AUD',
    statement_date: '2026-07-10', statement_start_date: '2025-07-01', statement_end_date: '2026-06-30',
    opening_balance: '100000.0000', closing_balance: '113500.0000', employer_contributions: '12000.0000', personal_contributions: '2000.0000',
    salary_sacrifice: '3100.0000', government_contributions: '500.0000', rollovers_in: '25000.0000', rollovers_out: '4000.0000',
    withdrawals: '1500.0000', pension_payments: '900.0000', investment_earnings: '7000.0000', fees: '820.0000',
    insurance_premiums: '640.0000', tax: '1800.0000', ytd_employer_contributions: '12000.0000', ytd_personal_contributions: '2000.0000',
    extraction_status: 'extracted', reconciliation_status: 'reconciled', reconciliation_variance: null, account_match_status: 'matched',
    canonical_account_id: 'acc-1', retirement_member_id: null, smsf_classification: 'not_smsf', approval_status: 'approved', review_status: 'not_required',
    extraction_warnings: [{ code: 'summed_summary_lines', count: 2, detail: 'fees' }, { code: 'unrecognised_summary_label', detail: 'Admin fee rebate' }],
    created_at: '2026-07-11T00:00:00Z',
    ...over,
  };
}
function activityRow(id: string, statementId: string, over: Row = {}): Row {
  return {
    id, user_id: A, statement_id: statementId, activity_type: 'PERSONAL_CONTRIBUTION', activity_date: '2026-03-10',
    effective_period_start: null, effective_period_end: null, amount: '500.0000', currency_code: 'AUD',
    description_raw: 'BPAY member contribution', employer_name_raw: null, is_summary_total: false, is_year_to_date: false,
    payslip_match_status: 'not_attempted', payslip_match_variance: null, bank_match_status: 'matched', linked_transaction_id: 'txn-500',
    bank_leg_confirmed_at: null, bank_leg_confirmed_type: null, rollover_match_status: 'not_attempted', duplicate_of_activity_id: null,
    source_row_number: 1, ...over,
  };
}
function positionRow(id: string, statementId: string, over: Row = {}): Row {
  return {
    id, user_id: A, statement_id: statementId, option_name_raw: 'High Growth', asset_class_raw: 'Diversified', ticker_raw: 'HG01',
    isin: 'AU0000HG0001', units: '1234.567890', unit_price: '97.210000', market_value: '120000.0000', currency_code: 'AUD',
    valuation_date: '2026-06-30', source_row_number: 1, ...over,
  };
}

beforeEach(() => {
  h.requests.length = 0;
  h.updates.length = 0;
  h.user = { id: A };
});

// ===========================================================================
describe('GAP-RET-03: GET /api/financial-data-hub/retirement-statement (paged, user-scoped history)', () => {
  function seed() {
    const s1 = statementRow('s1');
    const s2 = statementRow('s2', { fund_name: 'Old Fund', statement_end_date: '2025-06-30', statement_start_date: '2024-07-01', canonical_account_id: 'acc-2' });
    const pending = statementRow('s-pending', { approval_status: 'pending' });
    const foreign = statementRow('s-foreign', { user_id: B, fund_name: 'Someone else' });
    // 1,001 activity lines on s1: the list must return ALL of them.
    const acts = Array.from({ length: 1001 }, (_, i) => activityRow(`a${String(i).padStart(5, '0')}`, 's1', {
      activity_type: 'EMPLOYER_CONTRIBUTION', linked_transaction_id: null, bank_match_status: 'not_expected',
      employer_name_raw: 'Acme Pty Ltd', description_raw: `SG ${i}`, source_row_number: i + 1,
    }));
    acts.push(activityRow('a-contrib', 's1', { source_row_number: 2000 }));
    h.tables = {
      fdh_retirement_statements: [s1, s2, pending, foreign],
      fdh_retirement_statement_activities: [...acts, activityRow('a-foreign', 's-foreign', { user_id: B })],
      fdh_retirement_statement_positions: [positionRow('p1', 's1'), positionRow('p2', 's1', { option_name_raw: 'Balanced', market_value: '80000.0000' })],
      fhip_import_applications: [{ id: 'app-1', user_id: A, source_retirement_statement_id: 's1', target_entity_id: 'acc-1', apply_mode: 'update_existing', applied_fields: ['current_balance'], applied_at: '2026-07-12T01:00:00Z' }],
      fhip_import_proposals: [{ id: 'prop-2', user_id: A, source_retirement_statement_id: 's2', status: 'dismissed' }],
      fdh_transactions: [{ id: 'txn-500', user_id: A, transaction_date: '2026-03-11', description_clean: 'BPAY HOSTPLUS', amount_original: '500.00', currency_original: 'AUD', credit_debit: 'debit' }],
      retirement_accounts: [{ id: 'acc-1', user_id: A, account_name: 'Hostplus Balanced' }, { id: 'acc-2', user_id: A, account_name: 'Old Fund' }],
    };
  }

  it('returns only the caller\'s APPROVED statements, newest period first, with every line (1,001 + 1) and every holding', async () => {
    seed();
    const res = await listStatements(new Request('http://x/api/financial-data-hub/retirement-statement?page=1&page_size=10'));
    expect(res.status).toBe(200);
    const json = await res.json();
    const page = normaliseRetirementHistory(json);
    expect(page.items.map((i) => i.statement.id)).toEqual(['s1', 's2']);
    expect(page.total).toBe(2);
    expect(page.hasMore).toBe(false);
    const s1 = page.items[0];
    expect(s1.activities).toHaveLength(1002);
    expect(s1.positions.map((p) => p.option_name_raw)).toEqual(['High Growth', 'Balanced']);
    expect(s1.outcome).toBe('applied');
    expect(s1.accountName).toBe('Hostplus Balanced');
    expect(page.items[1].outcome).toBe('kept_existing');
    const contrib = s1.activities.find((a) => a.id === 'a-contrib')!;
    expect(contrib.bank_leg).toMatchObject({ id: 'txn-500', description_clean: 'BPAY HOSTPLUS', transaction_date: '2026-03-11' });
    // Every read is scoped to the caller.
    for (const r of h.requests) expect(r.filters, `${r.table} read without user scope`).toContain(`user_id=${A}`);
    expect(JSON.stringify(json)).not.toContain('Someone else');
  });

  it('pages: page_size is capped at 20 and has_more is honest', async () => {
    seed();
    h.tables.fdh_retirement_statements.push(...Array.from({ length: 25 }, (_, i) => statementRow(`bulk-${String(i).padStart(2, '0')}`, { statement_end_date: `2020-01-${String(i + 1).padStart(2, '0')}` })));
    const p1 = normaliseRetirementHistory(await (await listStatements(new Request('http://x/r?page=1&page_size=500'))).json());
    expect(p1.items).toHaveLength(20);
    expect(p1.total).toBe(27);
    expect(p1.hasMore).toBe(true);
    const p2 = normaliseRetirementHistory(await (await listStatements(new Request('http://x/r?page=2&page_size=20'))).json());
    expect(p2.items).toHaveLength(7);
    expect(p2.hasMore).toBe(false);
    expect(new Set([...p1.items, ...p2.items].map((i) => i.statement.id)).size).toBe(27);
  });

  it('refuses an unauthenticated caller', async () => {
    seed();
    h.user = null;
    const res = await listStatements(new Request('http://x/r'));
    expect(res.status).toBe(401);
  });
});

// ===========================================================================
describe('GAP-RET-03/04: the history (and review) shows EVERY persisted field', () => {
  function render(over: Row = {}, acts: Row[] = [activityRow('a1', 's1')], poss: Row[] = [positionRow('p1', 's1')]) {
    const page = normaliseRetirementHistory({ data: { statements: [{ statement: statementRow('s1', over), activities: acts.map((a) => ({ ...a, bank_leg: { id: 'txn-500', transaction_date: '2026-03-11', description_clean: 'BPAY HOSTPLUS', amount_original: '500.00', currency_original: 'AUD', credit_debit: 'debit' } })), positions: poss, account_name: 'Hostplus Balanced', application: { applied_at: '2026-07-12T01:00:00Z' }, outcome: 'applied' }], page: 1, page_size: 10, total: 1, has_more: false } });
    return renderToStaticMarkup(createElement(RetirementStatementHistoryView, { items: page.items, total: 1, hasMore: false, onConfirmBankLeg: () => undefined }));
  }

  it('renders every header total, including salary sacrifice, government, rollovers in/out, withdrawals, pension and YTD', () => {
    const html = render();
    const expected: [string, string][] = [
      ['Opening balance', '$100,000.00'], ['Closing balance', '$113,500.00'], ['Employer contributions', '$12,000.00'],
      ['Personal contributions', '$2,000.00'], ['Salary sacrifice', '$3,100.00'], ['Government contributions', '$500.00'],
      ['Rollovers in', '$25,000.00'], ['Rollovers out', '$4,000.00'], ['Withdrawals', '$1,500.00'], ['Pension payments', '$900.00'],
      ['Investment earnings', '$7,000.00'], ['Fees', '$820.00'], ['Insurance premiums', '$640.00'], ['Tax', '$1,800.00'],
      ['Employer contributions (year to date)', '$12,000.00'], ['Personal contributions (year to date)', '$2,000.00'],
    ];
    expect(STATEMENT_HEADER_FIELDS.map((f) => f.label)).toEqual(expected.map(([l]) => l));
    for (const [label, value] of expected) {
      expect(html, label).toContain(`<dt class="text-muted">${label}</dt><dd>${value}`);
    }
    for (const t of ['Hostplus', '****4821', '2026-07-10', '2025-07-01 to 2026-06-30', 'Applied to “Hostplus Balanced” on 2026-07-12']) expect(html).toContain(t);
  });

  it('an absent figure reads "Not shown on statement", never $0', () => {
    const html = render({ salary_sacrifice: null, withdrawals: null });
    expect(html).toContain('<dt class="text-muted">Salary sacrifice</dt><dd>Not shown on statement');
    expect(html).toContain('<dt class="text-muted">Withdrawals</dt><dd>Not shown on statement');
    expect(html).not.toContain('<dt class="text-muted">Salary sacrifice</dt><dd>$0.00');
  });

  it('renders every activity column: description, employer, payslip / bank (with the bank payment) / rollover match, and the confirm action', () => {
    const html = render({}, [
      activityRow('a1', 's1'),
      activityRow('a2', 's1', { activity_type: 'EMPLOYER_CONTRIBUTION', employer_name_raw: 'Acme Pty Ltd', description_raw: 'SG July', payslip_match_status: 'matched', bank_match_status: 'not_expected', linked_transaction_id: null }),
      activityRow('a3', 's1', { activity_type: 'ROLLOVER_IN', description_raw: 'Rollover from Old Fund', rollover_match_status: 'matched', bank_match_status: 'not_expected', linked_transaction_id: null }),
    ]);
    for (const col of ['Date', 'What happened', 'Description', 'Employer', 'Amount', 'Payslip', 'Bank payment', 'Rollover']) expect(html).toContain(`>${col}</th>`);
    for (const t of ['BPAY member contribution', 'Acme Pty Ltd', 'SG July', 'Rollover from Old Fund', 'Paired with the other fund', 'Not paid through your bank', 'BPAY HOSTPLUS', 'Confirm: this bank payment went into my super']) {
      expect(html, t).toContain(t);
    }
  });

  it('a confirmed bank leg says how it is counted, and offers no second confirmation', () => {
    const html = render({}, [activityRow('a1', 's1', { bank_leg_confirmed_at: '2026-07-12T00:00:00Z', bank_leg_confirmed_type: 'transfer' })]);
    expect(html).toContain('Confirmed — this bank payment counts as a transfer, not spending or income');
    expect(html).not.toContain('Confirm: this bank payment went into my super');
  });

  it('renders holdings in super with every column, labelled "not added to Net Worth"', () => {
    const html = render();
    expect(html).toContain('Holdings in super — not added to Net Worth');
    for (const col of ['Investment option', 'Asset class', 'Code', 'ISIN', 'Units', 'Unit price', 'Value', 'Valued on']) expect(html).toContain(`>${col}</th>`);
    for (const t of ['High Growth', 'Diversified', 'HG01', 'AU0000HG0001', '1234.567890', '97.210000', '$120,000.00', '2026-06-30']) expect(html).toContain(t);
  });

  it('renders the parser warnings (GAP-RET-05)', () => {
    const html = render();
    expect(html).toContain('Several lines were added together: fees (2)');
    expect(html).toContain('Not recognised: Admin fee rebate');
  });

  it('the review panel renders the SAME component, and the Retirement tab mounts the history and an Import link', () => {
    const panel = read('components/retirement/RetirementStatementImportPanel.tsx');
    expect(panel).toContain('<RetirementStatementDetails');
    expect(panel).toMatch(/normaliseRetirementStatement\(body\.statement\)/);
    const page = read('app/(app)/retirement/page.tsx');
    expect(page).toContain('<RetirementStatementHistory');
    expect(page).toContain('href="#import-retirement-statement"');
    expect(panel).toContain('id="import-retirement-statement"');
    // Built through the allow-listed route builder, never a raw FDH path.
    expect(read('components/retirement/RetirementStatementHistory.tsx')).not.toContain('financial-data-hub');
  });
});

// ===========================================================================
describe('GAP-RET-05: the summary reader drops nothing silently', () => {
  const P = '2025-07-01 to 2026-06-30';
  const csv = (...lines: string[]) => bytes(['Item,Amount,Period', ...lines].join('\n'));
  const extract = (b: Uint8Array) => {
    const r = extractRetirementStatement(detectRetirementCsvFormat(b), { currencyCode: 'AUD', jurisdiction: 'AU' });
    if (!r.ok) throw new Error(r.error);
    return r.extraction;
  };

  it('"Administration fee" $50 + "Indirect cost" $30 are BOTH fees: $80.00, and the summing is recorded', () => {
    const ex = extract(csv(`Opening balance,1000.00,${P}`, `Administration fee,50.00,${P}`, `Indirect cost,30.00,${P}`, `Closing balance,920.00,${P}`));
    expect(ex.fees).toBe('80.00');
    expect(ex.fees).not.toBe('30.00'); // the base branch kept only the last line
    expect(ex.warnings).toContain('summed_summary_lines:fees:2');
  });

  it('an unrecognised label is counted and named, never dropped silently', () => {
    const ex = extract(csv(`Closing balance,920.00,${P}`, `Loyalty bonus credit,12.00,${P}`));
    expect(ex.warnings).toContain('unrecognised_summary_rows:1');
    expect(ex.warnings).toContain('unrecognised_summary_label=Loyalty bonus credit');
  });

  it('two DIFFERENT closing balances are never added: the first is kept and the conflict recorded', () => {
    const ex = extract(csv(`Closing balance,920.00,${P}`, `Account balance,925.00,${P}`));
    expect(ex.closingBalance).toBe('920.00');
    expect(ex.warnings).toContain('conflicting_balance_lines:closingBalance');
  });

  it('warnings are persisted as structured {code, count?, detail?} evidence', () => {
    expect(structureExtractionWarnings(['unreadable_amount_rows_skipped:3', 'summed_summary_lines:fees:2', 'unrecognised_summary_label=Loyalty bonus credit', 'date_format_not_inferable'])).toEqual([
      { code: 'unreadable_amount_rows_skipped', count: 3 },
      { code: 'summed_summary_lines', count: 2, detail: 'fees' },
      { code: 'unrecognised_summary_label', detail: 'Loyalty bonus credit' },
      { code: 'date_format_not_inferable' },
    ]);
    expect(structureExtractionWarnings(Array.from({ length: 60 }, (_, i) => `w${i}`))).toHaveLength(51);
  });

  it('the processing service writes extraction_warnings and refuses to report a partly-saved statement as a success', () => {
    const src = read('lib/financial-data-hub/services/retirementStatementProcessingService.ts');
    expect(src).toContain('extraction_warnings: structureExtractionWarnings(ex.warnings)');
    expect(src).toMatch(/if \(actErr\) await failPartialEvidence\(/);
    expect(src).toMatch(/if \(posErr\) await failPartialEvidence\(/);
    expect(src).not.toMatch(/if \(!actErr\) activitiesExtracted/);
  });
});

// ===========================================================================
describe('GAP-RET-07: bank re-match after a LATER bank approval (post-bank-approval seam)', () => {
  const stmt = (over: Row = {}) => statementRow('s1', { fund_name: 'Hostplus', ...over });
  const bank = (id: string, over: Row = {}): Row => ({ id, user_id: A, amount_original: '500.00', transaction_date: '2026-03-11', description_clean: 'BPAY HOSTPLUS SUPER', description_raw: null, credit_debit: 'debit', currency_original: 'AUD', ...over });

  it('WP-13 registered exactly one matcher', () => {
    expect(POST_BANK_APPROVAL_MATCHERS.filter((m) => m.ownerWp === 'WP-13').map((m) => m.id)).toEqual(['wp13_retirement_bank_rematch']);
  });

  it('re-running the match never strips an activity of its OWN link (the base code nulled it)', async () => {
    h.tables = {
      fdh_retirement_statements: [stmt()],
      fdh_retirement_statement_activities: [activityRow('a1', 's1', { linked_transaction_id: 'txn-500', bank_match_status: 'matched' })],
      fdh_transactions: [bank('txn-500')],
    };
    const r = await matchRetirementActivitiesToBank(A, 's1');
    const a1 = h.tables.fdh_retirement_statement_activities[0];
    expect(r.error).toBeNull();
    expect(a1.bank_match_status).toBe('matched');
    expect(a1.linked_transaction_id).toBe('txn-500');
    expect(r.newlyMatched).toBe(0);
  });

  it('a user-confirmed leg is never re-derived, even if its bank line vanished', async () => {
    h.tables = {
      fdh_retirement_statements: [stmt()],
      fdh_retirement_statement_activities: [activityRow('a1', 's1', { linked_transaction_id: 'txn-500', bank_match_status: 'matched', bank_leg_confirmed_at: '2026-07-01T00:00:00Z', bank_leg_confirmed_type: 'transfer' })],
      fdh_transactions: [],
    };
    await matchRetirementActivitiesToBank(A, 's1');
    expect(h.tables.fdh_retirement_statement_activities[0]).toMatchObject({ linked_transaction_id: 'txn-500', bank_match_status: 'matched' });
    expect(h.updates.filter((u) => u.table === 'fdh_retirement_statement_activities')).toHaveLength(0);
  });

  it('a bank statement approved AFTER the super statement links the still-unmatched contribution (links only, never reclassifies)', async () => {
    h.tables = {
      fdh_retirement_statements: [stmt(), statementRow('s-smsf', { smsf_classification: 'routed_to_smsf', extraction_status: 'extracted' }), statementRow('s-b', { user_id: B })],
      fdh_retirement_statement_activities: [
        activityRow('a1', 's1', { linked_transaction_id: null, bank_match_status: 'bank_evidence_not_available' }),
        activityRow('a-other', 's1', { activity_type: 'PENSION_PAYMENT', linked_transaction_id: 'txn-p', bank_match_status: 'matched', amount: '900.0000' }),
        activityRow('a-smsf', 's-smsf', { linked_transaction_id: null, bank_match_status: 'no_match' }),
        activityRow('a-b', 's-b', { user_id: B, linked_transaction_id: null, bank_match_status: 'no_match' }),
      ],
      fdh_transactions: [bank('txn-500'), bank('txn-p', { credit_debit: 'credit', amount_original: '900.00', description_clean: 'HOSTPLUS PENSION' }), bank('txn-b', { user_id: B })],
    };
    const out = await rematchRetirementActivitiesAfterBankApproval(A);
    const byId = Object.fromEntries(h.tables.fdh_retirement_statement_activities.map((a) => [a.id as string, a]));
    expect(out).toEqual({ statements: 1, linked: 1 });
    expect(byId.a1).toMatchObject({ bank_match_status: 'matched', linked_transaction_id: 'txn-500' });
    expect(byId['a-other']).toMatchObject({ bank_match_status: 'matched', linked_transaction_id: 'txn-p' });
    expect(byId['a-smsf']).toMatchObject({ bank_match_status: 'no_match', linked_transaction_id: null });
    expect(byId['a-b']).toMatchObject({ bank_match_status: 'no_match', linked_transaction_id: null });
    // Linking never touches the bank leg itself.
    expect(h.updates.some((u) => u.table === 'fdh_transactions')).toBe(false);
    const again = await rematchRetirementActivitiesAfterBankApproval(A);
    expect(again.linked).toBe(0);
  });
});
