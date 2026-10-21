// Document2 (4) WP-H (F5/F6/F14) -- the SERVER half: replaceSourceDocumentFile validates a replacement copy against the structured
// provenance the old statement retained BEFORE the file reference is switched. Behavioural: the real service and the real parsers run
// against an in-memory database that applies every filter; storage, the PDF text layer and the malware gate are stubs.
//
// NEGATIVE CONTROLS (each guard is deliberately weakened through a test seam and the SAME scenario must go red, naming the guard):
//   period mismatch accepted . folios ignored . provider ignored . owner ignored . a rejection treated as confirmable
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDb, type Row } from './support/inMemorySupabase';
import { buildMinimalTextPdf } from '../support/buildMinimalPdf';
import { buildWphCas, OTHER_FOLIO, PRIME_FOLIO_APR, PRIME_FOLIO_Q1 } from '../support/buildWphCasText';

type Weaken = null | 'ignore_period' | 'ignore_folios' | 'ignore_provider' | 'ignore_owner' | 'rejections_confirmable';
const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof import('./support/inMemorySupabase').createInMemoryDb>,
  uploads: [] as string[],
  extractCalls: [] as (string | undefined)[],
  text: '' as string,
  needsPassword: null as string | null,
  extractFails: null as null | 'insufficient_text',
  scan: { admitted: true } as { admitted: boolean; reason?: string },
  weaken: null as Weaken,
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db.client }));
vi.mock('@/lib/services/investment-intelligence/storage', async (orig) => ({
  ...(await orig<typeof import('@/lib/services/investment-intelligence/storage')>()),
  uploadSourceDocumentObject: async (key: string) => {
    h.uploads.push(key);
    return { error: null };
  },
  deleteSourceDocumentObject: async () => ({ error: null }),
}));
vi.mock('@/lib/services/investment-intelligence/pdfExtraction', () => ({
  extractPdfText: async (_b: Uint8Array, password?: string) => {
    h.extractCalls.push(password);
    if (h.needsPassword && password !== h.needsPassword) return { ok: false as const, kind: password ? ('wrong_password' as const) : ('password_required' as const), error: 'password' };
    if (h.extractFails) return { ok: false as const, kind: h.extractFails, error: 'no text' };
    return { ok: true as const, text: h.text, pageCount: 1 };
  },
}));
vi.mock('@/lib/services/investment-intelligence/realScanAdmission', () => ({
  scanReplacementCandidate: async () => (h.scan.admitted ? { admitted: true as const, verdict: null } : { admitted: false as const, reason: h.scan.reason as 'pending' | 'blocked' | 'scanner_unavailable' }),
  recordAdmittedReplacementScan: async () => undefined,
  II_SCAN_BLOCKED_MESSAGE: 'blocked-message',
  II_SCAN_UNAVAILABLE_MESSAGE: 'unavailable-message',
}));
// The test seam for the negative controls: the real comparison, optionally weakened by dropping one family of differences.
vi.mock('@/lib/services/investment-intelligence/replacementIdentity', async (orig) => {
  const real = await orig<typeof import('@/lib/services/investment-intelligence/replacementIdentity')>();
  const families: Record<string, RegExp> = { ignore_period: /^(period_|as_of_)/, ignore_folios: /^(no_common_folio|folios_differ|institution_differs)/, ignore_provider: /^(provider_differs|document_type_differs)/, ignore_owner: /^owner_/ };
  return {
    ...real,
    compareStatementIdentity: (...args: Parameters<typeof real.compareStatementIdentity>) => {
      const v = real.compareStatementIdentity(...args);
      const re = h.weaken ? families[h.weaken] : undefined;
      if (!re) return v;
      const differences = v.differences.filter((d) => !re.test(d.code));
      return { ...v, differences, decision: (differences.some((d) => d.severity === 'reject') ? 'rejected' : differences.length > 0 ? 'needs_confirmation' : 'match') as typeof v.decision };
    },
    unconfirmedDifferences: (v: Parameters<typeof real.unconfirmedDifferences>[0], confirmed: readonly string[]) =>
      h.weaken === 'rejections_confirmable' ? v.differences.filter((d) => !confirmed.includes(d.code)) : real.unconfirmedDifferences(v, confirmed),
  };
});

import { replaceSourceDocumentFile } from '@/lib/services/investment-intelligence/sourceDocumentReplacement';

const U = 'user-1';
const copyBytes = (tag: string) => new Uint8Array(buildMinimalTextPdf([[`copy ${tag}`]]));
const Q1 = buildWphCas({ periodStart: '01-Jan-2025', periodEnd: '31-Mar-2025', folios: [PRIME_FOLIO_Q1] });
const APR = buildWphCas({ periodStart: '01-Jan-2025', periodEnd: '30-Apr-2025', folios: [PRIME_FOLIO_APR] });
const OTHER = buildWphCas({ periodStart: '01-Apr-2023', periodEnd: '31-Mar-2024', folios: [OTHER_FOLIO] });
const RAVI = buildWphCas({ periodStart: '01-Jan-2025', periodEnd: '31-Mar-2025', folios: [{ ...PRIME_FOLIO_Q1, holderName: 'Ravi Rao' }] });
const UNKNOWN_HOLDER = buildWphCas({ periodStart: '01-Jan-2025', periodEnd: '31-Mar-2025', folios: [{ ...PRIME_FOLIO_Q1, holderName: 'A B Rao' }] });

function doc(over: Row = {}): Row {
  return {
    id: 'doc1',
    user_id: U,
    status: 'parsed',
    storage_path: 'user-1/old.pdf',
    storage_purged_at: '2025-04-02T00:00:00Z',
    storage_purge_error: null,
    checksum: 'oldchecksum0000',
    original_filename: 'old.pdf',
    mime_type: 'application/pdf',
    file_size: 10,
    owner_member_id: 'm-asha',
    country_code: 'IN',
    source_detected: 'cams',
    document_type_detected: 'cas_statement',
    statement_period_start: '2025-01-01',
    statement_period_end: '2025-03-31',
    statement_as_of_date: '2025-03-31',
    malware_scan_status: 'clean',
    malware_scan_object_ref: null,
    malware_scan_admission_deadline_at: null,
    malware_scan_decided_at: null,
    ...over,
  };
}

/** What a processed statement leaves behind: an account for folio 1122334455, its fund (with ISIN) and a holding line from this document. */
const RETAINED: Record<string, Row[]> = {
  ii_accounts: [{ id: 'acc1', user_id: U, folio_number: '1122334455', institution_name: 'Prime Mutual Fund', source_document_id: 'doc1' }],
  ii_instruments: [{ id: 'ins1', instrument_name: 'Prime Flexi Cap Fund', isin: 'INF999K01AB1' }],
  ii_instrument_identifiers: [{ id: 'idf1', instrument_id: 'ins1', identifier_scheme: 'isin', identifier_value: 'INF999K01AB1' }],
  ii_holding_snapshots: [{ id: 'hs1', user_id: U, source_document_id: 'doc1', account_id: 'acc1', instrument_id: 'ins1', as_of_date: '2025-03-31' }],
  ii_transactions: [],
  ii_transaction_source_links: [],
  household_members: [
    { id: 'm-asha', user_id: U, full_name: 'Asha Rao', relationship: 'self', is_active: true },
    { id: 'm-ravi', user_id: U, full_name: 'Ravi Rao', relationship: 'spouse', is_active: true },
  ],
};

function seed(documents: Row[] = [doc()], extra: Record<string, Row[]> = RETAINED) {
  const copyOf = Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  h.db.reset({ ii_source_documents: documents, ii_document_parse_runs: [], ii_audit_events: [], ii_reconciliation_cases: [], ...copyOf });
  h.uploads.length = 0;
  h.extractCalls.length = 0;
  h.text = Q1;
  h.needsPassword = null;
  h.extractFails = null;
  h.scan = { admitted: true };
  h.weaken = null;
}

beforeEach(() => {
  h.db = createInMemoryDb();
  seed();
});

const attach = (over: { password?: string; confirm?: string[]; tag?: string } = {}) =>
  replaceSourceDocumentFile({ userId: U, sourceDocumentId: 'doc1', filename: 'new.pdf', mimeType: 'application/pdf', bytes: copyBytes(over.tag ?? 'a'), password: over.password, confirmedDifferences: over.confirm });
const docRow = () => h.db.tables.ii_source_documents[0];
const untouched = () => {
  expect(h.uploads, 'nothing is stored for a copy that was not accepted').toEqual([]);
  expect(docRow().storage_path).toBe('user-1/old.pdf');
  expect(docRow().checksum).toBe('oldchecksum0000');
  expect(docRow().storage_purged_at).toBe('2025-04-02T00:00:00Z');
};

describe('accepted: the same statement', () => {
  it('a re-downloaded copy of the same statement is attached to the SAME row, with the identity check recorded on the audit trail', async () => {
    const r = await attach();
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.ok && r.identity.decision).toBe('match');
    expect(r.ok && r.identity.comparedOn).toEqual(expect.arrayContaining(['fund house or registrar (provider)', 'statement period', 'folio numbers', 'schemes (ISIN)', 'owner']));
    expect(docRow().storage_path).toBe(h.uploads[0]);
    const audit = h.db.tables.ii_audit_events.find((e) => e.event_type === 'upload')?.metadata as { identityCheck: Record<string, unknown> };
    expect(audit.identityCheck).toMatchObject({ decision: 'match', differences: [], confirmedDifferences: [], previousPeriodStart: '2025-01-01', previousPeriodEnd: '2025-03-31', newPeriodStart: '2025-01-01', newPeriodEnd: '2025-03-31' });
  });
});

/** Each scenario is a function with NAMED assertions, so a negative control can prove the name goes red when the guard is removed. */
const scenarios = {
  async periodMismatchRefused() {
    h.text = OTHER; // 01-04-2023 to 31-03-2024: no overlap
    const r = await attach();
    expect(r.ok, 'period mismatch accepted').toBe(false);
    untouched();
  },
  async periodOnlyMismatchRefused() {
    // same provider, folio, fund and holder; only the period is a different financial year
    h.text = buildWphCas({ periodStart: '01-Apr-2023', periodEnd: '31-Mar-2024', folios: [PRIME_FOLIO_Q1] });
    const r = await attach();
    expect(r.ok, 'period mismatch accepted').toBe(false);
    expect(!r.ok && r.identity?.differences.map((d) => d.code)).toEqual(['period_no_overlap']);
    untouched();
  },
  async extendedPeriodNeedsConfirmation() {
    h.text = APR; // overlaps but is a month longer
    const r = await attach();
    expect(r.ok, 'period mismatch accepted').toBe(false);
    expect(!r.ok && r.code).toBe('replacement_needs_confirmation');
    untouched();
  },
  async differentFolioRefused() {
    h.text = buildWphCas({ periodStart: '01-Jan-2025', periodEnd: '31-Mar-2025', folios: [{ ...OTHER_FOLIO, isin: PRIME_FOLIO_Q1.isin }] });
    const r = await attach();
    expect(r.ok, 'folio mismatch accepted').toBe(false);
    expect(!r.ok && r.identity?.differences.map((d) => d.code)).toContain('no_common_folio');
    untouched();
  },
  async differentProviderRefused() {
    h.db.tables.ii_source_documents[0].source_detected = 'kfintech'; // the old statement was a KFintech one; the copy is a CAMS one
    const r = await attach();
    expect(r.ok, 'provider mismatch accepted').toBe(false);
    untouched();
  },
  async otherMembersStatementRefused() {
    h.text = RAVI;
    const r = await attach();
    expect(r.ok, "another member's statement accepted").toBe(false);
    untouched();
  },
  async rejectionCannotBeConfirmed() {
    h.text = OTHER;
    const r = await attach({ confirm: ['period_no_overlap', 'no_common_folio', 'schemes_differ'] });
    expect(r.ok, 'a rejection was confirmed').toBe(false);
    expect(!r.ok && r.code).toBe('replacement_identity_conflict');
    untouched();
  },
};

describe('refused: a different statement (422, nothing changed, before anything is stored)', () => {
  it('a period with no overlap is refused, in plain words with day-first dates, and the database and storage are untouched', async () => {
    h.text = OTHER;
    const r = await attach();
    expect(r).toMatchObject({ ok: false, httpStatus: 422, code: 'replacement_identity_conflict' });
    expect(!r.ok && r.message).toBe(
      'This copy covers 01-04-2023 to 31-03-2024, but the statement it would replace covers 01-01-2025 to 31-03-2025. The two periods do not overlap, so this is a different statement. Upload it as a new statement instead. Nothing was changed. ' +
        'None of the folios in this copy (ending 6655) is a folio of the statement it would replace (ending 4455). This is a different statement, so it was not attached. Nothing was changed.',
    );
    untouched();
    expect(h.db.writes.filter((w) => w.table === 'ii_source_documents')).toEqual([]);
  });
  it.each([
    ['periodMismatchRefused', scenarios.periodMismatchRefused],
    ['periodOnlyMismatchRefused', scenarios.periodOnlyMismatchRefused],
    ['differentFolioRefused', scenarios.differentFolioRefused],
    ['differentProviderRefused', scenarios.differentProviderRefused],
    ['otherMembersStatementRefused', scenarios.otherMembersStatementRefused],
    ['rejectionCannotBeConfirmed', scenarios.rejectionCannotBeConfirmed],
    ['extendedPeriodNeedsConfirmation', scenarios.extendedPeriodNeedsConfirmation],
  ])('%s', async (_n, run) => {
    await run();
  });
  it('the refusal is on the audit trail (what differed and what was compared), never with a file name or a figure', async () => {
    h.text = OTHER;
    await attach();
    const ev = h.db.tables.ii_audit_events.find((e) => (e.metadata as { reason?: string })?.reason === 'replacement_identity_rejected');
    expect(ev).toBeTruthy();
    expect(JSON.stringify(ev?.metadata)).not.toMatch(/9988776655|1122334455|new\.pdf/);
  });
});

describe('needs confirmation: a materially different period or folio set', () => {
  it('unconfirmed -> 409 with the differences in plain words and the summary of what the copy is; confirmed (by code) -> attached, and the confirmation is on the audit trail', async () => {
    h.text = APR;
    const first = await attach();
    expect(first).toMatchObject({ ok: false, httpStatus: 409, code: 'replacement_needs_confirmation' });
    expect(!first.ok && first.message).toContain('This copy covers 01-01-2025 to 30-04-2025, but the statement it would replace covers 01-01-2025 to 31-03-2025. The periods overlap but are not the same.');
    expect(!first.ok && first.message).toContain('Nothing has been changed yet. Confirm only if this really is the same statement.');
    expect(!first.ok && first.identity?.candidateSummary).toBe('This file is a CAMS consolidated account statement covering 01-01-2025 to 30-04-2025, with 1 folio (ending 4455).');
    untouched();

    const second = await attach({ confirm: ['period_differs'] });
    expect(second.ok, JSON.stringify(second)).toBe(true);
    expect(docRow().storage_path).toBe(h.uploads[0]);
    const audit = h.db.tables.ii_audit_events.find((e) => e.event_type === 'upload')?.metadata as { identityCheck: Record<string, unknown> };
    expect(audit.identityCheck).toMatchObject({ decision: 'needs_confirmation', differences: ['period_differs'], confirmedDifferences: ['period_differs'], newPeriodEnd: '2025-04-30' });
  });
  it('confirming a DIFFERENT code than the one that differs does not help', async () => {
    h.text = APR;
    const r = await attach({ confirm: ['folios_differ'] });
    expect(r).toMatchObject({ ok: false, code: 'replacement_needs_confirmation' });
    untouched();
  });
  it('a holder name that matches nobody is a confirmable difference, shown masked', async () => {
    h.text = UNKNOWN_HOLDER;
    const r = await attach();
    expect(r).toMatchObject({ ok: false, httpStatus: 409 });
    expect(!r.ok && r.message).toMatch(/holder printed on this copy \(A B R\*\*\)/);
    expect(!r.ok && r.message).not.toContain('A B Rao');
  });
});

describe('retained provenance missing: the safest rule, said plainly', () => {
  it('no period retained but folios and provider are: compared on those, the period is listed as not compared, and a copy that agrees is accepted', async () => {
    h.db.tables.ii_source_documents[0].statement_period_start = null;
    h.db.tables.ii_source_documents[0].statement_period_end = null;
    h.db.tables.ii_source_documents[0].statement_as_of_date = null;
    h.db.tables.ii_holding_snapshots[0].as_of_date = null;
    const r = await attach();
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.ok && r.identity.notComparedOn).toContain('statement period (the old statement kept no record of it)');
  });
  it('the retained as-of date is taken from the holding lines when the document row has none', async () => {
    h.db.tables.ii_source_documents[0].statement_period_start = null;
    h.db.tables.ii_source_documents[0].statement_period_end = null;
    h.db.tables.ii_source_documents[0].statement_as_of_date = null; // the holding line still says 31-03-2025
    h.text = buildWphCas({ periodStart: '01-Jan-2025', periodEnd: '30-Jun-2025', folios: [{ ...PRIME_FOLIO_Q1, closingDate: '30-Jun-2025' }] });
    const r = await attach();
    expect(r).toMatchObject({ ok: false, code: 'replacement_needs_confirmation' });
    expect(!r.ok && r.identity?.differences.map((d) => d.code)).toEqual(['as_of_differs']);
  });
  it('NOTHING retained (the old statement was never read): needs confirmation, with a summary of what the copy is; confirmed -> attached', async () => {
    seed([doc({ status: 'password_required', source_detected: null, document_type_detected: null, statement_period_start: null, statement_period_end: null, statement_as_of_date: null })], { household_members: RETAINED.household_members });
    const first = await attach();
    expect(first).toMatchObject({ ok: false, httpStatus: 409, code: 'replacement_needs_confirmation' });
    expect(!first.ok && first.identity?.differences.map((d) => d.code)).toEqual(['nothing_retained_to_compare']);
    expect(!first.ok && first.identity?.candidateSummary).toMatch(/^This file is a CAMS consolidated account statement covering 01-01-2025 to 31-03-2025/);
    untouched();
    const second = await attach({ confirm: ['nothing_retained_to_compare'] });
    expect(second.ok).toBe(true);
  });
});

describe('password-protected copies', () => {
  it('a protected copy with no password is asked for it (422), nothing is stored or changed, and the password is never echoed', async () => {
    h.needsPassword = 'right-pw';
    const r = await attach();
    expect(r).toMatchObject({ ok: false, httpStatus: 422, code: 'password_required_for_check' });
    expect(!r.ok && r.message).toMatch(/is not stored/);
    untouched();
  });
  it('a wrong password is named as wrong', async () => {
    h.needsPassword = 'right-pw';
    const r = await attach({ password: 'wrong-pw' });
    expect(r).toMatchObject({ ok: false, httpStatus: 422, code: 'wrong_password_for_check' });
    expect(JSON.stringify(r)).not.toContain('wrong-pw');
    untouched();
  });
  it('the right password reads the copy, the check runs, and the password is not written anywhere', async () => {
    h.needsPassword = 'right-pw';
    const r = await attach({ password: 'right-pw' });
    expect(r.ok).toBe(true);
    expect(h.extractCalls).toEqual(['right-pw']);
    expect(JSON.stringify([h.db.writes, h.db.tables.ii_audit_events])).not.toContain('right-pw');
  });
});

describe('unreadable copies', () => {
  it('a file with no readable text cannot replace a statement that was read successfully before (422)', async () => {
    h.extractFails = 'insufficient_text';
    const r = await attach();
    expect(r).toMatchObject({ ok: false, httpStatus: 422, code: 'replacement_identity_conflict' });
    expect(!r.ok && r.message).toMatch(/no readable text/);
    untouched();
  });
  it('but when the old statement was never recognised either, the person may confirm', async () => {
    seed([doc({ source_detected: null, document_type_detected: null, statement_period_start: null, statement_period_end: null, statement_as_of_date: null })], { household_members: RETAINED.household_members });
    h.extractFails = 'insufficient_text';
    expect(await attach()).toMatchObject({ ok: false, httpStatus: 409 });
    expect((await attach({ confirm: ['unverifiable_copy'] })).ok).toBe(true);
  });
  it('a document that is not a statement at all is unreadable too (not guessed)', async () => {
    h.text = 'Certificate of Insurance\nPolicy Number: XYZ-000-111\nNot a statement.';
    expect(await attach()).toMatchObject({ ok: false, httpStatus: 422, code: 'replacement_identity_conflict' });
    untouched();
  });
});

describe('the malware verdict comes BEFORE the copy is read', () => {
  it.each(['pending', 'blocked', 'scanner_unavailable'] as const)('%s: the copy is never parsed and nothing changes', async (reason) => {
    h.scan = { admitted: false, reason };
    const r = await attach();
    expect(r.ok).toBe(false);
    expect(h.extractCalls, 'unscanned bytes must not reach the PDF parser').toEqual([]);
    untouched();
  });
});

describe('cross-tenant', () => {
  it("another user's statement is 404 (non-enumerating): the copy is never read, nothing is stored", async () => {
    seed([doc({ user_id: 'user-2' })]);
    const r = await attach();
    expect(r).toMatchObject({ ok: false, httpStatus: 404, code: 'not_found' });
    expect(h.extractCalls).toEqual([]);
    expect(h.uploads).toEqual([]);
  });
  it("another user's folios, fund and holdings never count as this statement's retained provenance", async () => {
    // the only retained rows belong to user-2: for user-1 the statement kept nothing, so the copy needs confirmation rather than matching on someone else's data
    seed(
      [doc({ source_detected: null, document_type_detected: null, statement_period_start: null, statement_period_end: null, statement_as_of_date: null })],
      {
        ...RETAINED,
        ii_accounts: [{ id: 'acc1', user_id: 'user-2', folio_number: '1122334455', institution_name: 'Prime Mutual Fund', source_document_id: 'doc1' }],
        ii_holding_snapshots: [{ id: 'hs1', user_id: 'user-2', source_document_id: 'doc1', account_id: 'acc1', instrument_id: 'ins1', as_of_date: '2025-03-31' }],
      },
    );
    const r = await attach();
    expect(!r.ok && r.identity?.differences.map((d) => d.code)).toEqual(['nothing_retained_to_compare']);
  });
});

/** The control must fail with a real AssertionError that carries the named message, or the guard it stands for is not guarding anything. */
async function expectRed(assertion: () => unknown, named: string): Promise<void> {
  let failure: Error | null = null;
  try {
    await assertion();
  } catch (e) {
    failure = e as Error;
  }
  if (!failure) throw new Error(`the assertion did NOT fail against the deliberately broken rule (${named}): the test cannot detect this regression`);
  expect(failure.name).toBe('AssertionError');
  expect(failure.message).toContain(named);
}

describe('NEGATIVE CONTROLS: each guard, removed, turns its scenario red', () => {
  it('period mismatch accepted -> the no-overlap scenario and the needs-confirmation scenario both fail', async () => {
    h.weaken = 'ignore_period';
    await expectRed(() => scenarios.periodOnlyMismatchRefused(), 'period mismatch accepted');
    seed();
    h.weaken = 'ignore_period';
    await expectRed(() => scenarios.extendedPeriodNeedsConfirmation(), 'period mismatch accepted');
  });
  it('folios ignored -> the different-folio scenario fails', async () => {
    h.weaken = 'ignore_folios';
    await expectRed(() => scenarios.differentFolioRefused(), 'folio mismatch accepted');
  });
  it('provider ignored -> the different-provider scenario fails', async () => {
    h.weaken = 'ignore_provider';
    await expectRed(() => scenarios.differentProviderRefused(), 'provider mismatch accepted');
  });
  it("owner ignored -> another member's statement is accepted and the scenario fails", async () => {
    h.weaken = 'ignore_owner';
    await expectRed(() => scenarios.otherMembersStatementRefused(), "another member's statement accepted");
  });
  it('a rejection treated as confirmable -> the "cannot be confirmed" scenario fails', async () => {
    h.weaken = 'rejections_confirmable';
    await expectRed(() => scenarios.rejectionCannotBeConfirmed(), 'a rejection was confirmed');
  });
  it('and with no weakening every scenario is green (the controls above are not failing for an unrelated reason)', async () => {
    for (const run of Object.values(scenarios)) {
      seed();
      await run();
    }
  });
});
