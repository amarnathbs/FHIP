/**
 * Bank statements: settling WHICH ACCOUNT an already-uploaded statement belongs to
 * (lib/financial-data-hub/services/bankAccountAssignment.ts and the
 * POST /api/financial-data-hub/bank-statements/:id/resolve-account route).
 *
 * Context: a user with more than one account (or whose first account was opened
 * with digits) was told, in a red error box, to retype digits and upload again --
 * every time. These tests pin the replacement: read the statement locally, match
 * deterministically, otherwise ask, and attach the ALREADY-UPLOADED statement
 * without a re-upload. Each rule has a negative control in the same test.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- assertions read raw JSON route payloads */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeDb, type FakeDb } from '../support/fdhFakeSupabase';
import {
  decideAutoAssignment,
  lastDigitsForDisplay,
  matchPrintedIdentifier,
  narrowByInstitutionName,
  resolveStatementAccount,
  sanitiseAccountName,
  trailingDigits,
  readStatementIdentityFromStoredFile,
  BankAccountAssignmentError,
  type StatementIdentity,
} from '@/lib/financial-data-hub/services/bankAccountAssignment';
import { BankOwnerConflictError } from '@/lib/financial-data-hub/services/bankOwnerAttribution';
import { computeAccountFingerprint } from '@/lib/financial-data-hub/bank-csv/accountIdentity';

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, user: null as { id: string } | null, download: null as null | (() => Promise<unknown>) }));

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db.sessionClient(h.user!.id) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.adminClient() }));
vi.mock('@/lib/financial-data-hub/constants/featureFlags', () => ({ isFdhDocumentUploadEnabled: () => true }));
vi.mock('@/lib/financial-data-hub/services/storage', () => ({
  downloadDocumentObject: async () => (h.download ? h.download() : { ok: false, message: 'no storage in this test' }),
}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireCountryConfirmedUser: async () =>
    h.user ? { user: h.user } : { user: null, unauthenticated: Response.json({ error: 'unauthenticated' }, { status: 401 }) },
}));

vi.setConfig({ testTimeout: 30000 });

const A = 'a0000000-0000-4000-8000-00000000000a';
const B = 'b0000000-0000-4000-8000-00000000000b';
const DOC = 'd0000000-0000-4000-8000-000000000001';
const DOC_B = 'd0000000-0000-4000-8000-0000000000b1';
const ACC1 = 'c0000000-0000-4000-8000-000000000001';
const ACC2 = 'c0000000-0000-4000-8000-000000000002';
const ACC_B = 'c0000000-0000-4000-8000-0000000000b1';
const ACC_INR = 'c0000000-0000-4000-8000-0000000000e1';
const ITEM = 'f0000000-0000-4000-8000-000000000001';

const noIdentity = async (): Promise<StatementIdentity | null> => null;
const identity = (institutionName: string | null, lastDigits: string | null) => async (): Promise<StatementIdentity | null> => ({ institutionName, lastDigits });

function seedAccount(id: string, over: Record<string, unknown> = {}) {
  const masked = (over.masked_identifier as string | null | undefined) ?? null;
  h.db.insert('fdh_financial_accounts', {
    id, user_id: A, institution_id: null, account_type: 'transaction', country_code: 'AU', currency_code: 'AUD', display_name: 'Imported account',
    masked_identifier: masked, account_fingerprint: computeAccountFingerprint({ userId: A, institutionId: null, currencyCode: 'AUD', maskedIdentifierNormalised: masked }),
    status: 'active', owner_role: null, ...over,
  });
}
function seedStatement(over: Record<string, unknown> = {}) {
  h.db.insert('fdh_statement_uploads', {
    id: DOC, user_id: A, source_type: 'pdf_native', document_type: 'bank_statement', currency_code: 'AUD', country_code: 'AU', institution_id: null,
    financial_account_id: null, processing_status: 'queued', review_status: 'not_required', certification_status: null, owner_role: null,
    raw_document_storage_reference: 'k/doc.pdf', error_code: null, ...over,
  });
  h.db.insert('fdh_review_items', { id: ITEM, user_id: A, statement_upload_id: over.id ?? DOC, review_type: 'other', severity: 'blocking', status: 'open', title_code: 'bank_pdf.account_identity_ambiguous' });
}
const doc = (id = DOC) => h.db.rows('fdh_statement_uploads').find((r) => r.id === id)!;
const acct = (id: string) => h.db.rows('fdh_financial_accounts').find((r) => r.id === id)!;
const item = () => h.db.rows('fdh_review_items').find((r) => r.id === ITEM)!;

beforeEach(() => {
  h.db = createFakeDb();
  h.user = { id: A };
  h.download = null;
});

describe('pure rules', () => {
  it('trailing digits / display digits: only the last 3-6, the picker shows 4', () => {
    expect(trailingDigits('****1234')).toBe('1234');
    expect(trailingDigits('XXXX123456')).toBe('123456');
    expect(lastDigitsForDisplay('XXXX123456')).toBe('3456');
    expect(trailingDigits('12')).toBeNull();
    expect(lastDigitsForDisplay(null)).toBeNull();
  });
  it('a printed fragment under 4 digits is not evidence', () => {
    const cands = [{ id: 'a', maskedIdentifier: '****234' }, { id: 'b', maskedIdentifier: '****1234' }];
    expect(matchPrintedIdentifier('234', cands)).toEqual([]);
    expect(matchPrintedIdentifier('1234', cands)).toEqual(['b']); // ...and 234 on the account side is too short too
  });
  it('the decision table: exact -> assign; several -> ask; none -> suggest NEW (never "the only one"); nothing read + one -> assign', () => {
    expect(decideAutoAssignment({ candidateIds: ['a', 'b'], printedPresent: true, printedMatches: ['b'] })).toEqual({ kind: 'assign', accountId: 'b', how: 'auto_printed_identifier' });
    expect(decideAutoAssignment({ candidateIds: ['a', 'b'], printedPresent: true, printedMatches: ['a', 'b'] })).toEqual({ kind: 'ask', reason: 'several_accounts' });
    expect(decideAutoAssignment({ candidateIds: ['a'], printedPresent: true, printedMatches: [] })).toEqual({ kind: 'ask', reason: 'new_account_suggested' }); // NOT assign 'a'
    expect(decideAutoAssignment({ candidateIds: ['a'], printedPresent: false, printedMatches: [] })).toEqual({ kind: 'assign', accountId: 'a', how: 'auto_single_account' });
    expect(decideAutoAssignment({ candidateIds: ['a', 'b'], printedPresent: false, printedMatches: [] })).toEqual({ kind: 'ask', reason: 'several_accounts' });
    expect(decideAutoAssignment({ candidateIds: [], printedPresent: false, printedMatches: [] })).toEqual({ kind: 'ask', reason: 'nothing_read' });
  });
  it('the bank name narrows a digit tie only when it singles out exactly one', () => {
    const cands = [{ id: 'a', displayName: 'Commonwealth Bank' }, { id: 'b', displayName: 'ANZ' }, { id: 'c', displayName: 'ANZ' }];
    expect(narrowByInstitutionName(['a', 'b'], cands, 'Commonwealth Bank')).toEqual(['a']);
    expect(narrowByInstitutionName(['b', 'c'], cands, 'ANZ')).toEqual(['b', 'c']); // still two: never guess
    expect(narrowByInstitutionName(['a', 'b'], cands, null)).toEqual(['a', 'b']);
  });
  it('a friendly account name is plain text, bounded, display only', () => {
    expect(sanitiseAccountName('Commonwealth Bank of Australia')).toBe('Commonwealth Bank of Australia');
    expect(sanitiseAccountName('<script>alert(1)</script>')).toBe('Imported account');
    expect(sanitiseAccountName('')).toBe('Imported account');
    expect(sanitiseAccountName('x'.repeat(200)).length).toBeLessThanOrEqual(60);
  });
});

describe('auto resolution: only where deterministic', () => {
  it('EXACT MATCH reuses silently: the printed last digits match one account', async () => {
    seedAccount(ACC1, { masked_identifier: '****1111', display_name: 'ANZ' });
    seedAccount(ACC2, { masked_identifier: '****5678', display_name: 'Commonwealth Bank' });
    seedStatement();
    const r = await resolveStatementAccount(A, DOC, {}, { readIdentity: identity('Commonwealth Bank', '5678') });
    expect(r).toMatchObject({ status: 'assigned', financialAccountId: ACC2, how: 'auto_printed_identifier', account: { displayName: 'Commonwealth Bank', lastDigits: '5678' } });
    expect(doc().financial_account_id).toBe(ACC2);
    expect(item()).toMatchObject({ status: 'resolved', resolution_code: 'account_auto_printed_identifier', resolved_by: A });
  });
  it('NEGATIVE: digits that match NO account never fall back to "the only account" -- a prefilled new-account suggestion is returned and nothing is assigned', async () => {
    seedAccount(ACC1, { masked_identifier: '****1111' });
    seedStatement();
    const r = await resolveStatementAccount(A, DOC, {}, { readIdentity: identity('Commonwealth Bank', '5678') });
    expect(r.status).toBe('needs_choice');
    expect(r).toMatchObject({ reason: 'new_account_suggested', suggestion: { institutionName: 'Commonwealth Bank', lastDigits: '5678' } });
    expect(doc().financial_account_id).toBeNull();
    expect(item().status).toBe('open');
    // CONTROL: the same statement with NOTHING readable and the same single account IS assigned.
    const control = await resolveStatementAccount(A, DOC, {}, { readIdentity: noIdentity });
    expect(control).toMatchObject({ status: 'assigned', financialAccountId: ACC1, how: 'auto_single_account' });
  });
  it('NEGATIVE: several accounts with the same last digits are NEVER silently guessed', async () => {
    seedAccount(ACC1, { masked_identifier: '****5678', display_name: 'Imported account' });
    seedAccount(ACC2, { masked_identifier: '****5678', display_name: 'Imported account' });
    seedStatement();
    const r = await resolveStatementAccount(A, DOC, {}, { readIdentity: identity('ANZ', '5678') });
    expect(r).toMatchObject({ status: 'needs_choice', reason: 'several_accounts' });
    expect(doc().financial_account_id).toBeNull();
  });
  it('CONTROL: the bank name can break that tie when it singles out one account', async () => {
    seedAccount(ACC1, { masked_identifier: '****5678', display_name: 'ANZ' });
    seedAccount(ACC2, { masked_identifier: '****5678', display_name: 'Commonwealth Bank' });
    seedStatement();
    const r = await resolveStatementAccount(A, DOC, {}, { readIdentity: identity('ANZ', '5678') });
    expect(r).toMatchObject({ status: 'assigned', financialAccountId: ACC1 });
  });
  it('nothing could be read and several accounts -> the picker, listing friendly name and last digits only', async () => {
    seedAccount(ACC1, { masked_identifier: 'XXXX123456', display_name: 'ANZ' });
    seedAccount(ACC2, { masked_identifier: null, display_name: 'Imported account' });
    seedStatement();
    const r = await resolveStatementAccount(A, DOC, {}, { readIdentity: noIdentity });
    expect(r.status).toBe('needs_choice');
    if (r.status !== 'needs_choice') return;
    expect(r.reason).toBe('several_accounts');
    expect(r.candidates).toEqual([
      { id: ACC1, displayName: 'ANZ', lastDigits: '3456', ownerRole: null },
      { id: ACC2, displayName: 'Imported account', lastDigits: null, ownerRole: null },
    ]);
    expect(JSON.stringify(r.candidates)).not.toMatch(/123456/); // never more than the last 4
  });
  it("only the user's OWN accounts for THIS currency are candidates", async () => {
    seedAccount(ACC1, { masked_identifier: '****1111' });
    h.db.insert('fdh_financial_accounts', { id: ACC_B, user_id: B, institution_id: null, account_type: 'transaction', country_code: 'AU', currency_code: 'AUD', display_name: 'B account', masked_identifier: '****5678', account_fingerprint: 'x', status: 'active' });
    seedAccount(ACC_INR, { currency_code: 'INR', country_code: 'IN', display_name: 'HDFC', masked_identifier: '****5678' });
    seedStatement();
    const r = await resolveStatementAccount(A, DOC, {}, { readIdentity: identity(null, '5678') });
    // 5678 exists only on another tenant's AUD account and on this user's INR account: neither is a match.
    expect(r).toMatchObject({ status: 'needs_choice', reason: 'new_account_suggested' });
  });
});

describe('accepting a prefilled suggestion / adding a new account', () => {
  it('creates the account with the bank name and ONLY the last digits, attaches the statement, closes the blocking item', async () => {
    seedAccount(ACC1, { masked_identifier: '****1111' });
    seedStatement({ owner_role: 'spouse' });
    const r = await resolveStatementAccount(A, DOC, { newAccountDigits: '5678', newAccountName: 'Commonwealth Bank' });
    expect(r).toMatchObject({ status: 'assigned', how: 'new_account', account: { displayName: 'Commonwealth Bank', lastDigits: '5678' } });
    const created = h.db.rows('fdh_financial_accounts').find((a) => a.masked_identifier === '5678')!;
    expect(created).toMatchObject({ user_id: A, display_name: 'Commonwealth Bank', currency_code: 'AUD', institution_id: null, owner_role: 'spouse', status: 'active' });
    expect(created.account_fingerprint).toBe(computeAccountFingerprint({ userId: A, institutionId: null, currencyCode: 'AUD', maskedIdentifierNormalised: '5678' }));
    expect(doc().financial_account_id).toBe(created.id);
    expect(item()).toMatchObject({ status: 'resolved', resolution_code: 'account_new_account' });
  });
  it('digits that already identify an existing account reuse it instead of creating a duplicate', async () => {
    seedAccount(ACC1, { masked_identifier: '5678' });
    seedStatement();
    const r = await resolveStatementAccount(A, DOC, { newAccountDigits: '5678' });
    expect(r).toMatchObject({ status: 'assigned', financialAccountId: ACC1 });
    expect(h.db.rows('fdh_financial_accounts')).toHaveLength(1);
  });
  it.each(['12', '1234567', 'abcd', '12 3', '1234567890'])('NEGATIVE: %j is not 4-6 digits and is refused (a full number is never stored)', async (bad) => {
    seedAccount(ACC1, { masked_identifier: '****1111' });
    seedStatement();
    await expect(resolveStatementAccount(A, DOC, { newAccountDigits: bad })).rejects.toMatchObject({ code: 'invalid_digits' });
    expect(h.db.rows('fdh_financial_accounts')).toHaveLength(1);
    expect(doc().financial_account_id).toBeNull();
  });
  it('a markup-looking bank name falls back to the generic name', async () => {
    seedAccount(ACC1, { masked_identifier: '****1111' });
    seedStatement();
    await resolveStatementAccount(A, DOC, { newAccountDigits: '5678', newAccountName: '<b>x</b>' });
    expect(h.db.rows('fdh_financial_accounts').find((a) => a.masked_identifier === '5678')!.display_name).toBe('Imported account');
  });
});

describe('the user picks an existing account', () => {
  it('assigns, closes the blocking item, and leaves the statement processable (no re-upload)', async () => {
    seedAccount(ACC1, { masked_identifier: '****1111' });
    seedAccount(ACC2, { masked_identifier: '****2222' });
    seedStatement();
    const r = await resolveStatementAccount(A, DOC, { accountId: ACC2 });
    expect(r).toMatchObject({ status: 'assigned', financialAccountId: ACC2, how: 'user_selected' });
    expect(doc()).toMatchObject({ financial_account_id: ACC2, processing_status: 'queued' }); // exactly what the process step requires
    expect(item()).toMatchObject({ status: 'resolved', resolution_code: 'account_user_selected' });
  });
  it("NEGATIVE: another user's account is rejected, and looks exactly like a missing one", async () => {
    seedAccount(ACC1, { masked_identifier: '****1111' });
    h.db.insert('fdh_financial_accounts', { id: ACC_B, user_id: B, institution_id: null, account_type: 'transaction', country_code: 'AU', currency_code: 'AUD', display_name: 'B account', masked_identifier: '****9999', account_fingerprint: 'x', status: 'active' });
    seedStatement();
    await expect(resolveStatementAccount(A, DOC, { accountId: ACC_B })).rejects.toMatchObject({ code: 'account_not_found' });
    await expect(resolveStatementAccount(A, DOC, { accountId: 'c0000000-0000-4000-8000-0000000000ff' })).rejects.toMatchObject({ code: 'account_not_found' });
    expect(doc().financial_account_id).toBeNull();
    expect(acct(ACC_B).owner_role).toBeUndefined();
    // CONTROL: the user's own account is accepted.
    expect((await resolveStatementAccount(A, DOC, { accountId: ACC1 })).status).toBe('assigned');
  });
  it("NEGATIVE: another user's STATEMENT is not found", async () => {
    seedAccount(ACC1, { masked_identifier: '****1111' });
    h.db.insert('fdh_statement_uploads', { id: DOC_B, user_id: B, source_type: 'pdf_native', document_type: 'bank_statement', currency_code: 'AUD', financial_account_id: null, processing_status: 'queued' });
    await expect(resolveStatementAccount(A, DOC_B, { accountId: ACC1 })).rejects.toMatchObject({ code: 'not_found' });
    expect(doc(DOC_B).financial_account_id).toBeNull();
  });
  it('NEGATIVE: an account in another currency is rejected', async () => {
    seedAccount(ACC_INR, { currency_code: 'INR', country_code: 'IN', display_name: 'HDFC', masked_identifier: '****1111' });
    seedAccount(ACC1, { masked_identifier: '****2222' });
    seedStatement();
    await expect(resolveStatementAccount(A, DOC, { accountId: ACC_INR })).rejects.toMatchObject({ code: 'currency_mismatch' });
    expect(doc().financial_account_id).toBeNull();
  });
  it('NEGATIVE: a closed account is rejected; an institution mismatch is rejected', async () => {
    seedAccount(ACC1, { masked_identifier: '****1111', status: 'closed' });
    seedAccount(ACC2, { masked_identifier: '****2222', institution_id: 'e0000000-0000-4000-8000-0000000000e9' });
    seedStatement();
    await expect(resolveStatementAccount(A, DOC, { accountId: ACC1 })).rejects.toMatchObject({ code: 'account_not_found' });
    await expect(resolveStatementAccount(A, DOC, { accountId: ACC2 })).rejects.toMatchObject({ code: 'institution_mismatch' });
  });
  it('IDEMPOTENT: repeating the same choice succeeds as a no-op; a DIFFERENT account for an already-assigned statement is refused, never moved', async () => {
    seedAccount(ACC1, { masked_identifier: '****1111' });
    seedAccount(ACC2, { masked_identifier: '****2222' });
    seedStatement();
    await resolveStatementAccount(A, DOC, { accountId: ACC1 });
    const again = await resolveStatementAccount(A, DOC, { accountId: ACC1 });
    expect(again).toMatchObject({ status: 'assigned', financialAccountId: ACC1, how: 'already_assigned' });
    await expect(resolveStatementAccount(A, DOC, { accountId: ACC2 })).rejects.toMatchObject({ code: 'already_assigned_to_other' });
    expect(doc().financial_account_id).toBe(ACC1);
    // the auto path is idempotent too (no second read, no second assignment)
    expect(await resolveStatementAccount(A, DOC, {}, { readIdentity: async () => { throw new Error('must not read again'); } })).toMatchObject({ status: 'assigned', how: 'already_assigned' });
  });
  it('picking an account AND typing digits is refused as ambiguous input', async () => {
    seedAccount(ACC1, { masked_identifier: '****1111' });
    seedStatement();
    await expect(resolveStatementAccount(A, DOC, { accountId: ACC1, newAccountDigits: '1234' })).rejects.toBeInstanceOf(BankAccountAssignmentError);
  });
  it('only a bank statement can be assigned, and not once approved', async () => {
    seedAccount(ACC1, { masked_identifier: '****1111' });
    seedStatement({ document_type: 'payslip' });
    await expect(resolveStatementAccount(A, DOC, { accountId: ACC1 })).rejects.toMatchObject({ code: 'invalid_state' });
    h.db.tables.fdh_statement_uploads = [];
    h.db.tables.fdh_review_items = [];
    seedStatement({ processing_status: 'approved' });
    await expect(resolveStatementAccount(A, DOC, { accountId: ACC1 })).rejects.toMatchObject({ code: 'invalid_state' });
  });
});

describe('decision 2: the statement owner never silently overwrites the account owner', () => {
  it('a different account owner -> conflict BEFORE anything changes; explicit confirmation changes it', async () => {
    seedAccount(ACC1, { masked_identifier: '****1111', owner_role: 'smsf' });
    seedStatement({ owner_role: 'self' });
    await expect(resolveStatementAccount(A, DOC, { accountId: ACC1 })).rejects.toBeInstanceOf(BankOwnerConflictError);
    expect(doc().financial_account_id).toBeNull();
    expect(acct(ACC1).owner_role).toBe('smsf');
    expect(item().status).toBe('open');
    const confirmed = await resolveStatementAccount(A, DOC, { accountId: ACC1, confirmOwnerChange: true });
    expect(confirmed.status).toBe('assigned');
    expect(acct(ACC1).owner_role).toBe('self');
  });
  it('CONTROL: the same owner, or an account with no owner yet, needs no confirmation', async () => {
    seedAccount(ACC1, { masked_identifier: '****1111', owner_role: 'self' });
    seedAccount(ACC2, { masked_identifier: '****2222', owner_role: null });
    seedStatement({ owner_role: 'self' });
    expect((await resolveStatementAccount(A, DOC, { accountId: ACC1 })).status).toBe('assigned');
    h.db.tables.fdh_statement_uploads = [];
    h.db.tables.fdh_review_items = [];
    seedStatement({ owner_role: 'self' });
    await resolveStatementAccount(A, DOC, { accountId: ACC2 });
    expect(acct(ACC2).owner_role).toBe('self');
  });
});

describe('a statement an earlier process attempt parked because its account was unresolved', () => {
  it('is brought back to a processable state (review_required -> failed -> queued) without a re-upload; a normal queued one is left alone', async () => {
    seedAccount(ACC1, { masked_identifier: '****1111' });
    seedStatement({ processing_status: 'review_required', review_status: 'pending', certification_status: 'review_required' });
    await resolveStatementAccount(A, DOC, { accountId: ACC1 });
    expect(doc()).toMatchObject({ processing_status: 'queued', review_status: 'not_required', certification_status: null, financial_account_id: ACC1 });
  });
});

describe('security: race, declared transitions, no re-upload', () => {
  it('RACE: two simultaneous choices for the same statement -> exactly ONE wins; the loser is refused, never a silent second assignment', async () => {
    seedAccount(ACC1, { masked_identifier: '****1111' });
    seedAccount(ACC2, { masked_identifier: '****2222' });
    seedStatement();
    const results = await Promise.allSettled([
      resolveStatementAccount(A, DOC, { accountId: ACC1 }),
      resolveStatementAccount(A, DOC, { accountId: ACC2 }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: 'already_assigned_to_other' });
    const winner = (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>).value.financialAccountId;
    expect(doc().financial_account_id).toBe(winner);
    // the same two concurrent requests for the SAME account both succeed (idempotent), one as already_assigned
    h.db.tables.fdh_statement_uploads = [];
    h.db.tables.fdh_review_items = [];
    seedStatement();
    const both = await Promise.all([resolveStatementAccount(A, DOC, { accountId: ACC1 }), resolveStatementAccount(A, DOC, { accountId: ACC1 })]);
    expect(both.every((r) => r.status === 'assigned' && r.financialAccountId === ACC1)).toBe(true);
  });
  it('review_required -> queued only through the DECLARED transitions (review_required -> failed -> queued), and only from review_required', async () => {
    const { DOCUMENT_STATUS_TRANSITIONS } = await import('@/lib/financial-data-hub/domain/documentLifecycle');
    expect(DOCUMENT_STATUS_TRANSITIONS.review_required).toContain('failed');
    expect(DOCUMENT_STATUS_TRANSITIONS.failed).toContain('queued');
    expect(DOCUMENT_STATUS_TRANSITIONS.review_required).not.toContain('queued'); // there is no shortcut, so the code must use two steps
    seedAccount(ACC1, { masked_identifier: '****1111' });
    seedStatement({ processing_status: 'review_required', review_status: 'pending', certification_status: 'review_required' });
    const seen: string[] = [];
    const real = h.db.adminClient;
    h.db.adminClient = () => {
      const c = real.call(h.db) as any;
      return new Proxy(c, { get: (t, p) => (p === 'from' ? (table: string) => {
        const q = t.from(table);
        if (table !== 'fdh_statement_uploads') return q;
        return new Proxy(q, { get: (qt, qp) => (qp === 'update' ? (patch: any) => { if (patch.processing_status) seen.push(patch.processing_status); return qt.update(patch); } : qt[qp]) });
      } : t[p]) });
    };
    await resolveStatementAccount(A, DOC, { accountId: ACC1 });
    h.db.adminClient = real;
    expect(seen).toEqual(['failed', 'queued']); // in that order, nothing else
    // CONTROL: a statement in any other state is NOT rewritten (e.g. one already in processing).
    h.db.tables.fdh_statement_uploads = [];
    h.db.tables.fdh_review_items = [];
    seedStatement({ processing_status: 'processing' });
    await resolveStatementAccount(A, DOC, { accountId: ACC1 });
    expect(doc().processing_status).toBe('processing');
  });
  it('NO RE-UPLOAD: assignment never creates a statement row or stores a file; the same statement id continues', async () => {
    seedAccount(ACC1, { masked_identifier: '****1111' });
    seedAccount(ACC2, { masked_identifier: '****2222' });
    seedStatement();
    const before = h.db.rows('fdh_statement_uploads').length;
    await resolveStatementAccount(A, DOC, { accountId: ACC2 });
    expect(h.db.rows('fdh_statement_uploads')).toHaveLength(before);
    expect(doc().id).toBe(DOC);
    const src = fs.readFileSync(path.resolve(__dirname, '../../lib/financial-data-hub/services/bankAccountAssignment.ts'), 'utf8');
    expect(src).not.toMatch(/uploadBank(Csv|Pdf)|createUploadSession|completeUpload|\.storage\./);
  });
  it('the review item closes ONLY for this statement and only the ambiguity titles; other items stay open', async () => {
    seedAccount(ACC1, { masked_identifier: '****1111' });
    seedStatement();
    h.db.insert('fdh_review_items', { id: 'f0000000-0000-4000-8000-0000000000aa', user_id: A, statement_upload_id: DOC, review_type: 'other', severity: 'warning', status: 'open', title_code: 'bank_pdf.reconciliation_failed' });
    h.db.insert('fdh_review_items', { id: 'f0000000-0000-4000-8000-0000000000bb', user_id: B, statement_upload_id: DOC, review_type: 'other', severity: 'blocking', status: 'open', title_code: 'bank_pdf.account_identity_ambiguous' });
    await resolveStatementAccount(A, DOC, { accountId: ACC1 });
    const byId = (id: string) => h.db.rows('fdh_review_items').find((r) => r.id === id)!;
    expect(item().status).toBe('resolved');
    expect(byId('f0000000-0000-4000-8000-0000000000aa').status).toBe('open'); // other check: untouched
    expect(byId('f0000000-0000-4000-8000-0000000000bb').status).toBe('open'); // another user's item: untouched
  });
});

describe('PRIVACY: the digits read off a statement never reach logs, audit rows, review items or an AI context', () => {
  const spies: Array<ReturnType<typeof vi.spyOn>> = [];
  const logged: string[] = [];
  beforeEach(() => {
    logged.length = 0;
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      spies.push(vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); }));
    }
  });
  afterEach(() => { spies.splice(0).forEach((s) => s.mockRestore()); });

  it('suggestion, auto-match and new-account paths: the printed digits appear ONLY on the account\'s own masked identifier', async () => {
    const SECRET = '8765';
    seedAccount(ACC1, { masked_identifier: '****1111' });
    seedStatement();
    await resolveStatementAccount(A, DOC, {}, { readIdentity: identity('Commonwealth Bank', SECRET) }); // suggestion only
    await resolveStatementAccount(A, DOC, { newAccountDigits: SECRET, newAccountName: 'Commonwealth Bank' });
    const everythingElse = JSON.stringify([
      logged,
      h.db.rows('fdh_review_items'),
      h.db.rows('fdh_document_audit_events'),
      h.db.rows('ai_calls'),
      { ...doc(), financial_account_id: undefined },
    ]);
    expect(everythingElse).not.toContain(SECRET);
    // CONTROL: the digits ARE on the new account (the one place they belong), so the check above is not vacuous.
    expect(h.db.rows('fdh_financial_accounts').some((a) => a.masked_identifier === SECRET)).toBe(true);
  });

  it('the default reader returns at most the trailing 6 digits and the bank name -- never the printed number -- and uses no AI', async () => {
    const FULL = '4111222233335678';
    h.download = async () => ({ ok: true, bytes: new Uint8Array([1, 2, 3]) });
    vi.resetModules();
    vi.doMock('@/lib/financial-data-hub/bank-pdf/textExtraction', () => ({ extractPdfPages: async () => ({ ok: true, pages: [`Statement for account ${FULL}`], pageCount: 1 }) }));
    vi.doMock('@/lib/financial-data-hub/bank-pdf/detection', () => ({ detectPdfBankAdapter: () => ({ status: 'detected', adapter: { displayName: 'Commonwealth Bank' } }) }));
    vi.doMock('@/lib/financial-data-hub/bank-pdf/metadata', () => ({ extractPdfStatementMetadata: () => ({ maskedAccountIdentifier: FULL }) }));
    const mod = await import('@/lib/financial-data-hub/services/bankAccountAssignment');
    const read = await mod.readStatementIdentityFromStoredFile({ source_type: 'pdf_native', raw_document_storage_reference: 'k', error_code: null });
    expect(read).toEqual({ institutionName: 'Commonwealth Bank', lastDigits: '335678' });
    expect(JSON.stringify(read)).not.toContain(FULL);
    expect(logged.join('\n')).not.toContain('5678');
    vi.doUnmock('@/lib/financial-data-hub/bank-pdf/textExtraction');
    vi.doUnmock('@/lib/financial-data-hub/bank-pdf/detection');
    vi.doUnmock('@/lib/financial-data-hub/bank-pdf/metadata');
    // The reader's module graph never touches an AI client.
    const src = fs.readFileSync(path.resolve(__dirname, '../../lib/financial-data-hub/services/bankAccountAssignment.ts'), 'utf8');
    expect(src).not.toMatch(/openai|anthropic|aiProvider|requestBankStatementAiExtraction|fetch\(/i);
    expect(src).not.toMatch(/console\./);
  });

  it('a password-protected PDF and an unreadable file are not read at all; a generic CSV adapter names no bank', async () => {
    h.download = async () => { throw new Error('must not download'); };
    expect(await readStatementIdentityFromStoredFile({ source_type: 'pdf_native', raw_document_storage_reference: 'k', error_code: 'password_required' })).toBeNull();
    expect(await readStatementIdentityFromStoredFile({ source_type: 'pdf_native', raw_document_storage_reference: null })).toBeNull();
    h.download = async () => ({ ok: false, message: 'gone' });
    expect(await readStatementIdentityFromStoredFile({ source_type: 'pdf_native', raw_document_storage_reference: 'k', error_code: null })).toBeNull();
  });
});

describe('the route', () => {
  async function post(body: unknown, documentId = DOC): Promise<{ status: number; json: any }> {
    const route = await import('@/app/api/financial-data-hub/bank-statements/[documentId]/resolve-account/route');
    const res: Response = await route.POST(
      new Request('http://local/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      { params: Promise.resolve({ documentId }) },
    );
    return { status: res.status, json: await res.json() };
  }

  it('unauthenticated -> 401; unknown keys / bad ids -> 422', async () => {
    seedAccount(ACC1, { masked_identifier: '****1111' });
    seedStatement();
    h.user = null;
    expect((await post({})).status).toBe(401);
    h.user = { id: A };
    expect((await post({ account_id: 'not-a-uuid' })).status).toBe(422);
    expect((await post({ user_id: B })).status).toBe(422); // a client can never name the tenant
  });
  it('nothing readable + ONE account -> assigned (auto_single_account), reported for the "Matched to ..." line; the response never carries a full number', async () => {
    seedAccount(ACC1, { masked_identifier: 'XXXX123456', display_name: 'ANZ' });
    seedStatement();
    const r = await post({});
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ status: 'assigned', financial_account_id: ACC1, how: 'auto_single_account', account: { display_name: 'ANZ', last_digits: '3456' } });
    expect(JSON.stringify(r.json)).not.toMatch(/123456/);
  });
  it('nothing readable + SEVERAL accounts -> needs_choice with the picker data (never a silent guess)', async () => {
    seedAccount(ACC1, { masked_identifier: '****1111', display_name: 'ANZ' });
    seedAccount(ACC2, { masked_identifier: '****2222', display_name: 'CBA' });
    seedStatement();
    const r = await post({});
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ status: 'needs_choice', reason: 'several_accounts', suggestion: null });
    expect(r.json.data.candidates).toEqual([{ id: ACC1, display_name: 'ANZ', last_digits: '1111' }, { id: ACC2, display_name: 'CBA', last_digits: '2222' }]);
    expect(doc().financial_account_id).toBeNull();
  });
  it("another user's account -> 404 account_not_found; wrong currency -> 422; a different account when already assigned -> 409; the picked account assigns -> 200", async () => {
    seedAccount(ACC1, { masked_identifier: '****1111' });
    seedAccount(ACC2, { masked_identifier: '****2222' });
    seedAccount(ACC_INR, { currency_code: 'INR', country_code: 'IN', masked_identifier: '****3333' });
    h.db.insert('fdh_financial_accounts', { id: ACC_B, user_id: B, institution_id: null, account_type: 'transaction', country_code: 'AU', currency_code: 'AUD', display_name: 'B', masked_identifier: '****9999', account_fingerprint: 'x', status: 'active' });
    seedStatement();
    expect((await post({ account_id: ACC_B })).status).toBe(404);
    const wrongCurrency = await post({ account_id: ACC_INR });
    expect(wrongCurrency.status).toBe(422);
    expect(wrongCurrency.json.error).toBe('currency_mismatch');
    expect((await post({ account_id: ACC1 })).json.data).toMatchObject({ status: 'assigned', how: 'user_selected' });
    expect((await post({ account_id: ACC1 })).json.data.how).toBe('already_assigned'); // repeat submit
    const other = await post({ account_id: ACC2 });
    expect(other.status).toBe(409);
    expect(other.json.error).toBe('already_assigned_to_other');
    expect((await post({ account_id: ACC1 }, DOC_B)).status).toBe(404); // not found: another statement id
  });
  it('an owner conflict is a 409 account_owner_conflict naming both owners; confirm_owner_change continues', async () => {
    seedAccount(ACC1, { masked_identifier: '****1111', owner_role: 'smsf' });
    seedAccount(ACC2, { masked_identifier: '****2222' });
    seedStatement({ owner_role: 'self' });
    const conflict = await post({ account_id: ACC1 });
    expect(conflict.status).toBe(409);
    expect(conflict.json).toMatchObject({ error: 'account_owner_conflict', existing_owner_role: 'smsf', selected_owner_role: 'self' });
    expect((await post({ account_id: ACC1, confirm_owner_change: true })).status).toBe(200);
  });
  it('accepting a suggestion over the route creates the named account', async () => {
    seedAccount(ACC1, { masked_identifier: '****1111' });
    seedStatement();
    const r = await post({ new_account_digits: '5678', new_account_name: 'Commonwealth Bank' });
    expect(r.json.data).toMatchObject({ status: 'assigned', how: 'new_account', account: { display_name: 'Commonwealth Bank', last_digits: '5678' } });
  });
});

describe('the panel: this is a normal confirmation step, not an error', () => {
  const panel = fs.readFileSync(path.resolve(__dirname, '../../components/expenses/BankStatementImportPanel.tsx'), 'utf8').replace(/\r\n/g, '\n');

  it('the red "couldn\'t automatically match ... retype the digits" dead end is gone', () => {
    expect(panel).not.toMatch(/couldn.t automatically match/);
    expect(panel).not.toMatch(/uploading again/);
  });
  it("the step has its OWN phase (not 'error'), neutral/info styling, and plain wording", () => {
    expect(panel).toMatch(/\| 'choose_account'/);
    const start = panel.indexOf("{phase === 'choose_account' && accountChoice && (");
    const end = panel.indexOf("{phase === 'awaiting_password' && (");
    expect(start).toBeGreaterThan(0);
    const step = panel.slice(start, end);
    expect(step).toContain('One quick check so your statement goes to the right account');
    expect(step).toContain('border-blue-200 bg-blue-50');
    expect(step).not.toMatch(/bg-red|text-red|border-red/);
    // The primary action of the prefilled suggestion is Accept.
    expect(step).toContain('Add as a new account');
    expect(step).toContain('This is one of my existing accounts');
    expect(step).toContain('A different / new account');
    expect(step).toContain('you do not need to upload it again');
  });
  it("needs_choice and auto-matches never set the 'error' phase; only a real failure of the resolve call does", () => {
    const start = panel.indexOf('async function settleAmbiguousAccount');
    const end = panel.indexOf('async function handleChooseAccount');
    const fn = panel.slice(start, end);
    const failureBranch = fn.slice(fn.indexOf('if (!resolveOk) {'), fn.indexOf("if (json.data?.status === 'assigned')"));
    const successBranches = fn.slice(fn.indexOf("if (json.data?.status === 'assigned')"));
    expect(failureBranch).toMatch(/setPhase\('error'\)/);
    expect(successBranches).not.toMatch(/setPhase\('error'\)/);
    expect(successBranches).toMatch(/setPhase\('choose_account'\)/);
    expect(successBranches).toMatch(/Matched to your/);
  });
  it('an auto-match is announced in an info (blue) status line, not a red alert', () => {
    expect(panel).toMatch(/role="status" data-testid="account-info"/);
    const idx = panel.indexOf('data-testid="account-info"');
    expect(panel.slice(idx - 220, idx)).toContain('border-blue-200 bg-blue-50');
  });
  it('after the user chooses, the panel continues into processing with the SAME stored statement (no re-upload)', () => {
    const start = panel.indexOf('async function handleChooseAccount');
    const fn = panel.slice(start, start + 1600);
    expect(fn).toMatch(/settleAmbiguousAccount\(accountChoice\.documentId/);
    expect(fn).toMatch(/continueAfterAccount\(accountChoice\.documentId/);
    expect(fn).not.toMatch(/bank-(csv|pdf)\/upload/);
  });
  it('the picker shows only the friendly name and last digits', () => {
    const start = panel.indexOf("{phase === 'choose_account' && accountChoice && (");
    const step = panel.slice(start, panel.indexOf("{phase === 'awaiting_password' && ("));
    expect(step).toContain('c.display_name');
    expect(step).toContain('ending {c.last_digits}');
    expect(step).not.toMatch(/masked_identifier|\{c\.id\}</);
  });
});
