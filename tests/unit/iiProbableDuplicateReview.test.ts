// Document2 D-5 (PO decision 2026-10-03): statement-vs-manual duplicates.
//
//   * Never block mutual-fund analysis because a statement entry and a manual
//     entry MAY overlap. Both are counted until the USER decides.
//   * Detection stays. A probable duplicate is a NON-BLOCKING highlight.
//   * The user chooses: keep both / accept the statement and remove my manual
//     entry / reject the statement entry. Nothing in their data changes until
//     they confirm; a removal is a soft, audited, reversible status change.
//
// NAMED NEGATIVE CONTROLS (each fails against the OLD behaviour; the report
// lists the exact failures seen when the old sources are put back):
//   NC-C1  OLD: an open cross-source conflict blocked certification
//          (severity 'high' counted as blocking).
//   NC-C2  OLD: the conflicting row was parked as 'review_required', so
//          analysis silently lost it until a human acted.
//   NC-C3  OLD: there was no way to remove a duplicate, nor to undo a choice.
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDb, type Row } from './support/inMemorySupabase';
import { countryRegistryFrom } from './support/countryRegistryFake';

const mockGetUser = vi.fn();
const mockUserFrom = vi.fn();
const mockAdminFrom = vi.fn();
const emitAuditEvent = vi.fn().mockResolvedValue(undefined);
const recertifyPosition = vi.fn().mockResolvedValue({ ok: true, error: null });
const openReconciliationCase = vi.fn();

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mockGetUser }, from: mockUserFrom }) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: mockAdminFrom }) }));
vi.mock('@/lib/services/investment-intelligence/audit', () => ({ emitAuditEvent: (...a: unknown[]) => emitAuditEvent(...a) }));
vi.mock('@/lib/services/investment-intelligence/documentProcessing', () => ({ recertifyPosition: (...a: unknown[]) => recertifyPosition(...a) }));
vi.mock('@/lib/services/investment-intelligence/reconciliationCases', () => ({ openReconciliationCase: (...a: unknown[]) => openReconciliationCase(...a) }));

import { GET, POST } from '@/app/api/investment-intelligence/reconciliation-cases/[id]/resolve-cross-source/route';
import {
  CROSS_SOURCE_INSERT_STATUS,
  CROSS_SOURCE_OPTION_COPY,
  CROSS_SOURCE_REVIEW_SEVERITY,
  classifyTransactionOrigin,
  filterCertificationBlockingCases,
  planCrossSourceDecision,
  planUndo,
  type CrossSourcePair,
} from '@/lib/services/investment-intelligence/crossSourceReviewPolicy';
import { earliestAcquiringByPosition, openUserDateSupersessionCases } from '@/lib/services/investment-intelligence/userDateSupersession';
import { EntryTable, describeEntryStatus } from '@/components/investment-intelligence/ProbableDuplicateReview';

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

// ---------------------------------------------------------------------------
// Pure policy
// ---------------------------------------------------------------------------
const stmt = (id: string, status = 'parsed') => ({ id, origin: 'statement' as const, status });
const man = (id: string, status = 'parsed') => ({ id, origin: 'manual' as const, status });

describe('classifyTransactionOrigin', () => {
  it('no source document, or a manual_entry_record document, is the user\'s own entry; anything else is a statement', () => {
    expect(classifyTransactionOrigin(null, null)).toBe('manual');
    expect(classifyTransactionOrigin('manual_entry_record', 'doc')).toBe('manual');
    expect(classifyTransactionOrigin('cas_statement', 'doc')).toBe('statement');
    expect(classifyTransactionOrigin(null, 'doc')).toBe('statement');
  });
});

describe('planCrossSourceDecision: what each of the three choices changes', () => {
  const pair: CrossSourcePair = { subject: stmt('S'), counterpart: man('M') };

  it('1. keep both changes nothing', () => {
    expect(planCrossSourceDecision('keep_both', pair)).toEqual({ ok: true, changes: [], resolutionMethod: 'user_kept_both' });
  });

  it('2. accept the statement and remove my manual entry: ONLY the manual entry is taken out, softly', () => {
    expect(planCrossSourceDecision('accept_statement_remove_manual', pair)).toEqual({
      ok: true, changes: [{ transactionId: 'M', from: 'parsed', to: 'reversed' }], resolutionMethod: 'user_accepted_statement_removed_manual',
    });
  });

  it('3. reject the statement entry: ONLY the statement entry is taken out, softly', () => {
    expect(planCrossSourceDecision('reject_statement', pair)).toEqual({
      ok: true, changes: [{ transactionId: 'S', from: 'parsed', to: 'reversed' }], resolutionMethod: 'user_rejected_statement',
    });
  });

  it('works whichever side is the newer entry (the manual entry can be the subject)', () => {
    const flipped: CrossSourcePair = { subject: man('M'), counterpart: stmt('S') };
    expect(planCrossSourceDecision('accept_statement_remove_manual', flipped)).toMatchObject({ ok: true, changes: [{ transactionId: 'M', to: 'reversed' }] });
    expect(planCrossSourceDecision('reject_statement', flipped)).toMatchObject({ ok: true, changes: [{ transactionId: 'S', to: 'reversed' }] });
  });

  it('options 2 and 3 are refused unless one side is a statement and the other a manual entry', () => {
    const twoStatements: CrossSourcePair = { subject: stmt('A'), counterpart: stmt('B') };
    expect(planCrossSourceDecision('accept_statement_remove_manual', twoStatements)).toMatchObject({ ok: false, code: 'not_statement_vs_manual' });
    expect(planCrossSourceDecision('reject_statement', twoStatements)).toMatchObject({ ok: false, code: 'not_statement_vs_manual' });
    expect(planCrossSourceDecision('reject_statement', { subject: stmt('A'), counterpart: null })).toMatchObject({ ok: false, code: 'not_statement_vs_manual' });
    expect(planCrossSourceDecision('keep_both', twoStatements)).toMatchObject({ ok: true });
  });

  it('a statement that covers a whole history cannot be rejected as one entry when the manual side is a typed investment date', () => {
    const userDate: CrossSourcePair = { subject: stmt('S'), counterpart: man('M'), kind: 'user_supplied_investment_date' };
    expect(planCrossSourceDecision('reject_statement', userDate)).toMatchObject({ ok: false, code: 'option_not_offered' });
    expect(planCrossSourceDecision('accept_statement_remove_manual', userDate)).toMatchObject({ ok: true, changes: [{ transactionId: 'M', to: 'reversed' }] });
  });

  it('a legacy row parked as review_required is brought back into analysis by a decision that keeps it', () => {
    const legacy: CrossSourcePair = { subject: stmt('S', 'review_required'), counterpart: man('M') };
    expect(planCrossSourceDecision('keep_both', legacy)).toMatchObject({ changes: [{ transactionId: 'S', from: 'review_required', to: 'parsed' }] });
    expect(planCrossSourceDecision('reject_statement', legacy)).toMatchObject({ changes: [{ transactionId: 'S', from: 'review_required', to: 'reversed' }] });
  });

  it('an entry that is already removed is not changed again', () => {
    expect(planCrossSourceDecision('accept_statement_remove_manual', { subject: stmt('S'), counterpart: man('M', 'reversed') })).toMatchObject({ ok: true, changes: [] });
  });

  it('every option has plain-language copy that says what it does to the figures', () => {
    for (const key of ['keep_both', 'accept_statement_remove_manual', 'reject_statement'] as const) {
      expect(CROSS_SOURCE_OPTION_COPY[key].label.length).toBeGreaterThan(5);
      expect(CROSS_SOURCE_OPTION_COPY[key].effect).toMatch(/figures|counted|changes/i);
    }
    expect(CROSS_SOURCE_OPTION_COPY.accept_statement_remove_manual.effect).toMatch(/bring it back/i);
  });
});

describe('planUndo', () => {
  it('reverses each recorded change, but only where the row is still in the state the decision left it', () => {
    const applied = [{ transactionId: 'M', from: 'parsed', to: 'reversed' }, { transactionId: 'X', from: 'parsed', to: 'reversed' }];
    const undo = planUndo(applied, new Map([['M', 'reversed'], ['X', 'parsed']]));
    expect(undo).toEqual([{ transactionId: 'M', from: 'reversed', to: 'parsed' }]);
  });
});

describe('NC-C1: an open cross-source conflict no longer blocks certification', () => {
  const cases = [
    { id: '1', discrepancy_type: 'cross_source_conflict', severity: 'high' },
    { id: '2', discrepancy_type: 'cross_source_review_required', severity: 'high' },
  ];
  // The OLD rule, verbatim in effect: any open case of severity blocking/high blocked.
  const oldBlocks = (list: Array<{ discrepancy_type: string }>) => list.length > 0;

  it('OLD behaviour reproduced: the two cases block', () => {
    expect(oldBlocks(cases)).toBe(true);
  });
  it('NEW behaviour: they are filtered out, so nothing blocks (even a legacy case already stored at high severity)', () => {
    expect(oldBlocks(filterCertificationBlockingCases(cases))).toBe(false);
  });
  it('detection is kept: other open cases still block exactly as before', () => {
    const mixed = [...cases, { id: '3', discrepancy_type: 'ambiguous_instrument', severity: 'blocking' }, { id: '4', discrepancy_type: 'transaction_unclassified', severity: 'high' }];
    expect(filterCertificationBlockingCases(mixed).map((c) => c.id)).toEqual(['3', '4']);
  });
  it('new cases are opened below the blocking set', () => {
    expect(['blocking', 'high']).not.toContain(CROSS_SOURCE_REVIEW_SEVERITY);
  });
});

describe('NC-C1/NC-C2 contract: the creation sites, read from source', () => {
  const documentProcessing = read('lib/services/investment-intelligence/documentProcessing.ts');
  const manualImporter = read('lib/services/investment-intelligence/manualImporter.ts');
  const certifyAu = read('lib/investment-import-bridge/certifyAuPosition.ts');

  it('a probable duplicate is inserted COUNTED, never parked as review_required', () => {
    expect(CROSS_SOURCE_INSERT_STATUS).toBe('parsed');
    for (const src of [documentProcessing, manualImporter]) {
      expect(src).toContain('CROSS_SOURCE_INSERT_STATUS');
      expect(src).not.toMatch(/status:\s*crossSource\w*\s*\?\s*'review_required'/);
      expect(src).not.toMatch(/=\s*'review_required'\s*;?\s*\n\s*\}\s*\n\s*\}/); // no "crossSourceStatus = 'review_required'" assignment
      expect(src).not.toContain("crossSourceStatus = 'review_required'");
    }
  });

  it('the case is opened at the non-blocking severity, never high', () => {
    for (const src of [documentProcessing, manualImporter]) {
      const idx = src.indexOf("'cross_source_conflict' : 'cross_source_review_required'");
      expect(idx).toBeGreaterThan(0);
      const window = src.slice(idx, idx + 200);
      expect(window).toContain('severity: CROSS_SOURCE_REVIEW_SEVERITY');
      expect(window).not.toContain("severity: 'high'");
    }
  });

  it('certification (India and AU) filters cross-source cases out of the blocking set', () => {
    expect(documentProcessing).toContain('filterCertificationBlockingCases(openBlockingCasesRaw ?? [])');
    expect(certifyAu).toContain('filterCertificationBlockingCases(');
  });

  it('the review screen no longer offers the old two-button "same transaction?" question', () => {
    const review = read('components/investment-intelligence/ReviewCentreClient.tsx');
    expect(review).toContain('ProbableDuplicateReview');
    expect(review).not.toContain('Yes, same transaction');
  });
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------
const USER = 'user-1';
const CASE = 'case-1';

function seed(opts: { caseOverrides?: Partial<Row>; txns?: Row[]; docs?: Row[]; inputs?: Row[] } = {}) {
  const db = createInMemoryDb();
  db.reset({
    user_profiles: [{ user_id: USER, country_of_residence: 'AU', country_confirmed_at: '2026-08-29T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true }],
    ii_reconciliation_cases: [
      {
        id: CASE, user_id: USER, status: 'open', discrepancy_type: 'cross_source_conflict', severity: 'medium',
        discrepancy_details: { matchedFields: ['transactionDate'], differingFields: ['grossAmount'], rationale: 'amount differs', newTransactionId: 'T-STMT' },
        evidence: { comparedTransactionIds: ['T-MAN'] },
        ...opts.caseOverrides,
      },
    ],
    ii_transactions: opts.txns ?? [
      { id: 'T-STMT', user_id: USER, account_id: 'acc-1', instrument_id: 'ins-1', status: 'parsed', transaction_date: '2026-03-10', transaction_type: 'purchase', units: 10, gross_amount: 1000, source_document_id: 'doc-stmt', source_reference: 'CAMS-1' },
      { id: 'T-MAN', user_id: USER, account_id: 'acc-1', instrument_id: 'ins-1', status: 'parsed', transaction_date: '2026-03-11', transaction_type: 'purchase', units: 10, gross_amount: 1001, source_document_id: 'doc-man', source_reference: null },
    ],
    ii_source_documents: opts.docs ?? [
      { id: 'doc-stmt', user_id: USER, document_type: 'cas_statement', original_filename: 'cams-statement.pdf' },
      { id: 'doc-man', user_id: USER, document_type: 'manual_entry_record', original_filename: 'manual.json' },
    ],
    ii_investment_date_inputs: opts.inputs ?? [],
  });
  mockUserFrom.mockImplementation((table: string) => countryRegistryFrom(table) ?? db.client.from(table));
  mockAdminFrom.mockImplementation((table: string) => db.client.from(table));
  return db;
}

const post = (body: unknown, caseId = CASE) => POST(new Request('http://t/x', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: caseId }) });
const get = (caseId = CASE) => GET(new Request('http://t/x'), { params: Promise.resolve({ id: caseId }) });
const status = (db: ReturnType<typeof seed>, id: string) => db.tables.ii_transactions.find((t) => t.id === id)!.status;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: { id: USER, email: 'u@example.com' } } });
});

describe('POST resolve-cross-source: the three choices', () => {
  it('1. keep both: the case is resolved, no transaction is touched, no hard delete exists anywhere', async () => {
    const db = seed();
    const res = await post({ decision: 'keep_both' });
    expect(res.status).toBe(200);
    expect(db.tables.ii_reconciliation_cases[0]).toMatchObject({ status: 'resolved', resolution_method: 'user_kept_both', resolved_by: USER, resolved_by_actor_type: 'user' });
    expect(status(db, 'T-STMT')).toBe('parsed');
    expect(status(db, 'T-MAN')).toBe('parsed');
    expect(db.writes.filter((w) => w.table === 'ii_transactions')).toHaveLength(0);
    expect(db.writes.filter((w) => w.kind === 'delete')).toHaveLength(0);
    expect(emitAuditEvent.mock.calls.map((c) => c[0].eventType)).toEqual(['reconciliation_case_resolved']);
  });

  it('NC-C3 / 2. accept the statement and remove my manual entry: refused WITHOUT confirmation, and nothing is written', async () => {
    const db = seed();
    const res = await post({ decision: 'accept_statement_remove_manual' });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('confirmation_required');
    expect(db.writes).toHaveLength(0);
    expect(emitAuditEvent).not.toHaveBeenCalled();
  });

  it('2. with confirmation: the manual entry is soft-removed (kept, status reversed), the statement stays, and it is audited', async () => {
    const db = seed();
    const res = await post({ decision: 'accept_statement_remove_manual', confirm: true });
    expect(res.status).toBe(200);
    expect(status(db, 'T-MAN')).toBe('reversed');
    expect(status(db, 'T-STMT')).toBe('parsed');
    expect(db.tables.ii_transactions).toHaveLength(2); // nothing deleted
    expect(db.writes.filter((w) => w.kind === 'delete')).toHaveLength(0);

    const c = db.tables.ii_reconciliation_cases[0];
    expect(c).toMatchObject({ status: 'resolved', resolution_method: 'user_accepted_statement_removed_manual' });
    expect((c.discrepancy_details as Record<string, unknown>).appliedChanges).toEqual([{ transactionId: 'T-MAN', from: 'parsed', to: 'reversed' }]);

    const events = emitAuditEvent.mock.calls.map((x) => x[0]);
    expect(events.map((e) => e.eventType)).toEqual(['reconciliation_case_resolved', 'user_correction']);
    expect(events[1]).toMatchObject({ userId: USER, actorType: 'user', actorId: USER, metadata: { kind: 'probable_duplicate_decision', decision: 'accept_statement_remove_manual', changes: [{ transactionId: 'T-MAN', to: 'reversed' }] } });
    expect(recertifyPosition).toHaveBeenCalledWith(USER, 'acc-1', 'ins-1');
  });

  it('3. reject the statement entry (with confirmation): the statement entry is soft-removed, the manual one stays', async () => {
    const db = seed();
    expect((await post({ decision: 'reject_statement' })).status).toBe(422);
    const res = await post({ decision: 'reject_statement', confirm: true });
    expect(res.status).toBe(200);
    expect(status(db, 'T-STMT')).toBe('reversed');
    expect(status(db, 'T-MAN')).toBe('parsed');
    expect(db.tables.ii_reconciliation_cases[0].resolution_method).toBe('user_rejected_statement');
  });

  it('works when the MANUAL entry is the newer one (case about the manual row)', async () => {
    const db = seed({ caseOverrides: { discrepancy_details: { newTransactionId: 'T-MAN' }, evidence: { comparedTransactionIds: ['T-STMT'] } } });
    expect((await post({ decision: 'accept_statement_remove_manual', confirm: true })).status).toBe(200);
    expect(status(db, 'T-MAN')).toBe('reversed');
    expect(status(db, 'T-STMT')).toBe('parsed');
  });

  it('a pair of two statements cannot be "accept statement / reject statement"-ed, but keep both works', async () => {
    const db = seed({ docs: [{ id: 'doc-stmt', user_id: USER, document_type: 'cas_statement' }, { id: 'doc-man', user_id: USER, document_type: 'cas_statement' }] });
    const res = await post({ decision: 'accept_statement_remove_manual', confirm: true });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('not_statement_vs_manual');
    expect(db.writes.filter((w) => w.table === 'ii_transactions')).toHaveLength(0);
    expect((await post({ decision: 'keep_both' })).status).toBe(200);
  });

  it('an ambiguous case (several candidates) needs the user to say which one; then it proceeds', async () => {
    const db = seed({
      caseOverrides: { evidence: { comparedTransactionIds: ['T-MAN', 'T-MAN-2'] } },
      txns: [
        { id: 'T-STMT', user_id: USER, account_id: 'acc-1', instrument_id: 'ins-1', status: 'parsed', transaction_date: '2026-03-10', transaction_type: 'purchase', units: 10, gross_amount: 1000, source_document_id: 'doc-stmt', source_reference: 'CAMS-1' },
        { id: 'T-MAN', user_id: USER, account_id: 'acc-1', instrument_id: 'ins-1', status: 'parsed', transaction_date: '2026-03-11', transaction_type: 'purchase', units: 10, gross_amount: 1001, source_document_id: 'doc-man', source_reference: null },
        { id: 'T-MAN-2', user_id: USER, account_id: 'acc-1', instrument_id: 'ins-1', status: 'parsed', transaction_date: '2026-03-12', transaction_type: 'purchase', units: 10, gross_amount: 1002, source_document_id: 'doc-man', source_reference: null },
      ],
    });
    const unsure = await post({ decision: 'accept_statement_remove_manual', confirm: true });
    expect(unsure.status).toBe(422);
    expect((await unsure.json()).error).toBe('choose_counterpart');
    expect(db.writes).toHaveLength(0);

    expect((await post({ decision: 'accept_statement_remove_manual', confirm: true, counterpartTransactionId: 'T-MAN-2' })).status).toBe(200);
    expect(status(db, 'T-MAN-2')).toBe('reversed');
    expect(status(db, 'T-MAN')).toBe('parsed');
    // A counterpart id that is not one of the recorded candidates is refused, not trusted.
    seed({ caseOverrides: { evidence: { comparedTransactionIds: ['T-MAN', 'T-MAN-2'] } } });
    expect((await post({ decision: 'keep_both', counterpartTransactionId: 'not-a-candidate' })).status).toBe(422);
  });

  it('repeating the recorded decision is a no-op success; a different one needs an undo first (409)', async () => {
    const db = seed();
    await post({ decision: 'accept_statement_remove_manual', confirm: true });
    const writesBefore = db.writes.length;
    const again = await post({ decision: 'accept_statement_remove_manual', confirm: true });
    expect(again.status).toBe(200);
    expect((await again.json()).data.alreadyResolved).toBe(true);
    expect(db.writes.length).toBe(writesBefore);
    expect((await post({ decision: 'keep_both' })).status).toBe(409);
  });
});

describe('POST resolve-cross-source: undo makes every removal reversible', () => {
  it('NC-C3: undo puts the removed entry back, reopens the case, and audits it', async () => {
    const db = seed();
    await post({ decision: 'accept_statement_remove_manual', confirm: true });
    expect(status(db, 'T-MAN')).toBe('reversed');

    const res = await post({ decision: 'undo' });
    expect(res.status).toBe(200);
    expect(status(db, 'T-MAN')).toBe('parsed');
    const c = db.tables.ii_reconciliation_cases[0];
    expect(c).toMatchObject({ status: 'open', resolved_at: null, resolution_method: null, resolved_by: null });
    const details = c.discrepancy_details as Record<string, unknown>;
    expect(details.userDecision).toBeUndefined();
    expect(details.appliedChanges).toBeUndefined();
    expect(details.decisionHistory).toMatchObject([{ decision: 'accept_statement_remove_manual' }]);
    expect(emitAuditEvent.mock.calls.at(-1)![0].metadata).toMatchObject({ kind: 'probable_duplicate_decision_undone', undoneDecision: 'accept_statement_remove_manual' });

    // and the user can now choose again
    expect((await post({ decision: 'reject_statement', confirm: true })).status).toBe(200);
    expect(status(db, 'T-STMT')).toBe('reversed');
  });

  it('undo with nothing decided is refused', async () => {
    seed();
    const res = await post({ decision: 'undo' });
    expect(res.status).toBe(409);
  });

  it('undo never overwrites a row that has changed since (guarded by the status it expects)', async () => {
    const db = seed();
    await post({ decision: 'accept_statement_remove_manual', confirm: true });
    db.tables.ii_transactions.find((t) => t.id === 'T-MAN')!.status = 'parsed'; // changed elsewhere meanwhile
    const res = await post({ decision: 'undo' });
    expect(res.status).toBe(200);
    expect(status(db, 'T-MAN')).toBe('parsed');
    expect(db.tables.ii_reconciliation_cases[0].status).toBe('open');
  });
});

describe('resolve-cross-source: tenancy', () => {
  it('401 when unauthenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    seed();
    expect((await post({ decision: 'keep_both' })).status).toBe(401);
    expect((await get()).status).toBe(401);
  });

  it('another user\'s case is a 404 for both GET and POST, and writes nothing', async () => {
    const db = seed({ caseOverrides: { user_id: 'someone-else' } });
    expect((await post({ decision: 'accept_statement_remove_manual', confirm: true })).status).toBe(404);
    expect((await get()).status).toBe(404);
    expect(db.writes).toHaveLength(0);
  });

  it('a recorded transaction that belongs to someone else is never touched', async () => {
    const db = seed({
      txns: [
        { id: 'T-STMT', user_id: USER, account_id: 'acc-1', instrument_id: 'ins-1', status: 'parsed', transaction_date: '2026-03-10', transaction_type: 'purchase', units: 10, gross_amount: 1000, source_document_id: 'doc-stmt', source_reference: 'CAMS-1' },
        { id: 'T-MAN', user_id: 'someone-else', account_id: 'acc-9', instrument_id: 'ins-1', status: 'parsed', transaction_date: '2026-03-11', transaction_type: 'purchase', units: 10, gross_amount: 1001, source_document_id: 'doc-man', source_reference: null },
      ],
    });
    const res = await post({ decision: 'accept_statement_remove_manual', confirm: true });
    expect(res.status).toBe(404);
    expect(db.tables.ii_transactions.find((t) => t.id === 'T-MAN')!.status).toBe('parsed');
    expect(db.writes.filter((w) => w.table === 'ii_transactions')).toHaveLength(0);
  });

  it('a case type this route does not own is refused', async () => {
    seed({ caseOverrides: { discrepancy_type: 'ambiguous_instrument' } });
    expect((await post({ decision: 'keep_both' })).status).toBe(422);
  });
});

describe('GET resolve-cross-source: what the Review screen shows', () => {
  it('returns both entries with a plain source name, and offers options 2 and 3 only for statement-vs-manual', async () => {
    seed();
    const body = (await (await get()).json()).data;
    expect(body.status).toBe('open');
    expect(body.subject).toMatchObject({ transactionId: 'T-STMT', origin: 'statement', sourceName: 'cams-statement.pdf', amount: 1000 });
    expect(body.candidates[0]).toMatchObject({ transactionId: 'T-MAN', origin: 'manual', sourceName: 'Your manual entry' });
    expect(body.offered).toEqual({ keep_both: true, accept_statement_remove_manual: true, reject_statement: true });
  });

  it('offers only keep both when both entries are statements', async () => {
    seed({ docs: [{ id: 'doc-stmt', user_id: USER, document_type: 'cas_statement' }, { id: 'doc-man', user_id: USER, document_type: 'cas_statement' }] });
    expect((await (await get()).json()).data.offered).toEqual({ keep_both: true, accept_statement_remove_manual: false, reject_statement: false });
  });

  it('exposes the decision and whether it can be undone once resolved', async () => {
    seed();
    await post({ decision: 'keep_both' });
    const body = (await (await get()).json()).data;
    expect(body).toMatchObject({ status: 'resolved', decision: 'keep_both', canUndo: true });
  });
});

// ---------------------------------------------------------------------------
// D-3 x D-5: a typed investment date vs a later statement with real history
// ---------------------------------------------------------------------------
describe('a user-supplied investment date is a manual entry in this review', () => {
  const userDateTxns = [
    { id: 'T-STMT', user_id: USER, account_id: 'acc-1', instrument_id: 'ins-1', status: 'parsed', transaction_date: '2024-03-10', transaction_type: 'purchase', units: 5, gross_amount: 500, source_document_id: 'doc-stmt', source_reference: 'CAMS-1' },
    { id: 'T-DATE', user_id: USER, account_id: 'acc-1', instrument_id: 'ins-1', status: 'parsed', transaction_date: '2024-03-14', transaction_type: 'purchase', units: 100, gross_amount: 4000, source_document_id: null, source_reference: 'USER_INVESTMENT_DATE:in-1' },
  ];
  const caseOverrides = { discrepancy_details: { kind: 'user_supplied_investment_date', newTransactionId: 'T-STMT', derivedTransactionId: 'T-DATE' }, evidence: { comparedTransactionIds: ['T-DATE'] } };
  const inputs = [{ id: 'in-1', user_id: USER, derived_transaction_id: 'T-DATE', status: 'applied' }];

  it('GET marks the kind and does not offer "reject the statement entry" (the statement carries the whole history)', async () => {
    seed({ txns: userDateTxns, caseOverrides, inputs });
    const body = (await (await get()).json()).data;
    expect(body.kind).toBe('user_supplied_investment_date');
    expect(body.candidates[0]).toMatchObject({ origin: 'manual', isUserSuppliedInvestmentDate: true });
    expect(body.offered).toMatchObject({ keep_both: true, accept_statement_remove_manual: true, reject_statement: false });
  });

  it('accepting the statement removes the typed date\'s purchase AND closes its input; undo brings both back', async () => {
    const db = seed({ txns: userDateTxns, caseOverrides, inputs });
    expect((await post({ decision: 'reject_statement', confirm: true })).status).toBe(422);
    expect((await post({ decision: 'accept_statement_remove_manual', confirm: true })).status).toBe(200);
    expect(status(db, 'T-DATE')).toBe('reversed');
    expect(db.tables.ii_investment_date_inputs[0]).toMatchObject({ status: 'superseded', supersede_reason: 'statement_history_accepted' });

    expect((await post({ decision: 'undo' })).status).toBe(200);
    expect(status(db, 'T-DATE')).toBe('parsed');
    expect(db.tables.ii_investment_date_inputs[0]).toMatchObject({ status: 'applied', supersede_reason: null });
  });
});

describe('openUserDateSupersessionCases: asks, never removes', () => {
  const stmtRows = [
    { id: 'S2', accountId: 'acc-1', instrumentId: 'ins-1', type: 'sip', date: '2024-05-01' },
    { id: 'S1', accountId: 'acc-1', instrumentId: 'ins-1', type: 'purchase', date: '2024-03-10' },
    { id: 'S3', accountId: 'acc-1', instrumentId: 'ins-1', type: 'redemption', date: '2020-01-01' }, // not acquiring
  ];

  it('picks the earliest ACQUIRING statement transaction per position', () => {
    expect(earliestAcquiringByPosition(stmtRows).get('acc-1:ins-1')!.id).toBe('S1');
  });

  function seedSupersession(extra: Record<string, Row[]> = {}) {
    const db = createInMemoryDb();
    db.reset({
      ii_investment_date_inputs: [{ id: 'in-1', user_id: USER, account_id: 'acc-1', instrument_id: 'ins-1', status: 'applied', derived_transaction_id: 'T-DATE' }],
      ii_transactions: [{ id: 'T-DATE', user_id: USER, status: 'parsed', transaction_date: '2024-03-14' }],
      ii_reconciliation_cases: [],
      ...extra,
    });
    return db;
  }

  it('opens ONE non-blocking probable-duplicate case that points at the typed date, and changes no transaction', async () => {
    const db = seedSupersession();
    openReconciliationCase.mockResolvedValue('case-new');
    const res = await openUserDateSupersessionCases({ db: db.client as never, userId: USER, sourceDocumentId: 'doc-stmt', statementTransactions: stmtRows });
    expect(res.opened).toBe(1);
    const arg = openReconciliationCase.mock.calls[0];
    expect(arg[0]).toBe(USER);
    expect(arg[1]).toMatchObject({ discrepancyType: 'cross_source_review_required', severity: 'medium', sourceDocumentId: 'doc-stmt', evidence: { comparedTransactionIds: ['T-DATE'], newTransactionId: 'S1' } });
    expect(arg[1].details).toMatchObject({ kind: 'user_supplied_investment_date', newTransactionId: 'S1', derivedTransactionId: 'T-DATE' });
    expect(db.writes).toHaveLength(0); // the helper itself writes nothing; the case is opened through the shared helper
  });

  it('does not ask twice, and does not ask when the typed date is already removed or there is none', async () => {
    openReconciliationCase.mockResolvedValue('case-new');
    const already = seedSupersession({ ii_reconciliation_cases: [{ id: 'c', user_id: USER, status: 'open', discrepancy_details: { derivedTransactionId: 'T-DATE' } }] });
    expect((await openUserDateSupersessionCases({ db: already.client as never, userId: USER, sourceDocumentId: 'd', statementTransactions: stmtRows })).opened).toBe(0);

    const removed = seedSupersession({ ii_transactions: [{ id: 'T-DATE', user_id: USER, status: 'reversed' }] });
    expect((await openUserDateSupersessionCases({ db: removed.client as never, userId: USER, sourceDocumentId: 'd', statementTransactions: stmtRows })).opened).toBe(0);

    const none = seedSupersession({ ii_investment_date_inputs: [] });
    expect((await openUserDateSupersessionCases({ db: none.client as never, userId: USER, sourceDocumentId: 'd', statementTransactions: stmtRows })).opened).toBe(0);

    const otherUser = seedSupersession({ ii_investment_date_inputs: [{ id: 'in-1', user_id: 'someone-else', account_id: 'acc-1', instrument_id: 'ins-1', status: 'applied', derived_transaction_id: 'T-DATE' }] });
    expect((await openUserDateSupersessionCases({ db: otherUser.client as never, userId: USER, sourceDocumentId: 'd', statementTransactions: stmtRows })).opened).toBe(0);
  });

  it('a statement with no acquiring transactions (a holdings-only re-upload) opens nothing', async () => {
    const db = seedSupersession();
    openReconciliationCase.mockClear();
    const res = await openUserDateSupersessionCases({ db: db.client as never, userId: USER, sourceDocumentId: 'd', statementTransactions: [stmtRows[2]] });
    expect(res.opened).toBe(0);
    expect(openReconciliationCase).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The review UI: markup the user is shown
// ---------------------------------------------------------------------------
describe('ProbableDuplicateReview markup', () => {
  const entries = [
    { transactionId: 'a', origin: 'statement' as const, date: '2026-03-10', type: 'purchase', units: 10, amount: 1000, status: 'parsed', sourceName: 'cams-statement.pdf' },
    { transactionId: 'b', origin: 'manual' as const, date: '2026-03-11', type: 'purchase', units: 10, amount: 1001, status: 'reversed', sourceName: 'Your manual entry' },
  ];

  it('says in words whether each entry is counted, with dates day-first (India dd-mm-yyyy, Australia dd/mm/yyyy), never ISO', () => {
    const inr = renderToStaticMarkup(createElement(EntryTable, { entries, currencyCode: 'INR' }));
    expect(inr).toContain('10-03-2026');
    expect(inr).toContain('Counted in your figures');
    expect(inr).toContain('Removed from your figures (kept on record)');
    expect(inr).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    const aud = renderToStaticMarkup(createElement(EntryTable, { entries, currencyCode: 'AUD' }));
    expect(aud).toContain('10/03/2026');
    expect(aud).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('is an accessible table (caption, column headers with scope)', () => {
    const html = renderToStaticMarkup(createElement(EntryTable, { entries, currencyCode: 'INR' }));
    expect(html).toContain('<caption');
    expect(html.match(/scope="col"/g)!.length).toBeGreaterThanOrEqual(6);
  });

  it('describes every status in words, including a legacy parked one', () => {
    expect(describeEntryStatus('parsed')).toMatch(/counted/i);
    expect(describeEntryStatus('review_required')).toMatch(/left out/i);
    expect(describeEntryStatus('reversed')).toMatch(/removed/i);
  });

  it('the banner and the panel exist and are mounted on the Data and Overview pages', () => {
    for (const page of ['app/(app)/investment-intelligence/page.tsx', 'app/(app)/investment-intelligence/data/page.tsx']) {
      const src = read(page);
      expect(src).toContain('<ProbableDuplicateBanner />');
      expect(src).toContain('<InvestmentDatePanel />');
    }
  });
});
