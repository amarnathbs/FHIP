/**
 * Statement imports: resume after a reload, re-uploads that lead to the
 * original, apply exactly once, and the screens reading what the API sends
 * (2026-09-25; the payslip panel's production fixes, for every other type).
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDb, type Row } from './support/inMemorySupabase';

const h = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof import('./support/inMemorySupabase').createInMemoryDb> }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db.client }));
vi.mock('@/lib/financial-data-hub/services/auditLog', () => ({ recordDocumentAuditEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/financial-data-hub/constants/featureFlags', async (orig) => ({
  ...(await orig<typeof import('@/lib/financial-data-hub/constants/featureFlags')>()),
  isFdhDocumentUploadEnabled: () => true,
}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  requireCountryConfirmedUser: async () => ({ user: { id: 'user-1', email: null }, unauthenticated: null }),
}));
const uploadRetirement = vi.fn();
vi.mock('@/lib/financial-data-hub/services/retirementStatementProcessingService', async (orig) => ({
  ...(await orig<typeof import('@/lib/financial-data-hub/services/retirementStatementProcessingService')>()),
  uploadAndProcessRetirementStatement: (...a: unknown[]) => uploadRetirement(...a),
}));
const iiDownload = vi.fn(async () => ({ bytes: null, error: 'the file must not be read to resume a review' }));
vi.mock('@/lib/services/investment-intelligence/storage', async (orig) => ({
  ...(await orig<typeof import('@/lib/services/investment-intelligence/storage')>()),
  downloadSourceDocumentObject: () => iiDownload(),
}));

import { listWaitingImports } from '@/lib/financial-data-hub/services/waitingImports';
import { discardPendingAiFallbackDraft } from '@/lib/financial-data-hub/services/aiFallbackDrafts';
import { POST as liabilityProposalPOST } from '@/app/api/financial-data-hub/liability-statement/[documentId]/proposal/route';
import { POST as retirementProposalPOST } from '@/app/api/financial-data-hub/retirement-statement/[documentId]/proposal/route';
import { POST as retirementUploadPOST } from '@/app/api/financial-data-hub/retirement-statement/upload/route';
import { GET as waitingGET } from '@/app/api/financial-data-hub/waiting-imports/route';
import { processSourceDocument } from '@/lib/services/investment-intelligence/documentProcessing';
import { normaliseProposedFields } from '@/lib/import-bridge/proposedFieldShape';
import { normaliseWaitingImports } from '@/components/financial-data-hub/WaitingImports';

h.db = createInMemoryDb();
const U = 'user-1';
const root = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const upload = (id: string, over: Row = {}): Row => ({
  id, user_id: U, document_type: 'credit_card_statement', country_code: 'AU', currency_code: 'AUD',
  processing_status: 'queued', created_at: '2026-09-25T10:00:00Z', ...over,
});

beforeEach(() => {
  uploadRetirement.mockReset();
  iiDownload.mockClear();
});

// ---------------------------------------------------------------------------
describe('B. what the user left part-way through is listed, so it can be continued after a reload', () => {
  it('credit card / loan: an AI reading to check, a statement to approve, and a comparison never applied -- but nothing finished, nothing of another user', async () => {
    const draft = { header: { institutionName: 'Synthetic Card Co', statementPeriodEnd: '2026-08-31' }, activities: [], allActivitiesListed: true, warnings: [] };
    h.db.reset({
      fdh_statement_uploads: [
        upload('u-draft', { created_at: '2026-09-25T12:00:00Z' }),
        upload('u-review', { document_type: 'loan_statement' }),
        upload('u-compare'),
        upload('u-applied'),
        upload('u-draft-rejected', { processing_status: 'rejected' }),
        upload('u-theirs', { user_id: 'user-2' }),
      ],
      fdh_ai_fallback_drafts: [
        { user_id: U, statement_upload_id: 'u-draft', document_type: 'liability_statement', status: 'pending_review', payload: draft, created_at: '2026-09-25T12:01:00Z' },
        { user_id: U, statement_upload_id: 'u-draft-rejected', document_type: 'liability_statement', status: 'pending_review', payload: draft, created_at: '2026-09-25T12:02:00Z' },
        { user_id: U, statement_upload_id: 'u-review', document_type: 'liability_statement', status: 'discarded', payload: draft, created_at: '2026-09-25T12:03:00Z' },
        { user_id: 'user-2', statement_upload_id: 'u-theirs', document_type: 'liability_statement', status: 'pending_review', payload: draft, created_at: '2026-09-25T12:04:00Z' },
      ],
      fdh_liability_statements: [
        { id: 's-review', user_id: U, statement_upload_id: 'u-review', approval_status: 'pending', institution_name: 'Synthetic Lender', statement_period_end: '2026-08-31', created_at: '2026-09-25T11:00:00Z' },
        { id: 's-compare', user_id: U, statement_upload_id: 'u-compare', approval_status: 'approved', institution_name: null, statement_period_end: null, created_at: '2026-09-25T10:30:00Z' },
        { id: 's-applied', user_id: U, statement_upload_id: 'u-applied', approval_status: 'approved', institution_name: null, statement_period_end: null, created_at: '2026-09-25T10:00:00Z' },
        { id: 's-theirs', user_id: 'user-2', statement_upload_id: 'u-theirs', approval_status: 'pending', institution_name: null, statement_period_end: null, created_at: '2026-09-25T10:00:00Z' },
      ],
      fhip_import_proposals: [
        { id: 'p-ready', user_id: U, source_liability_statement_id: 's-compare', status: 'ready' },
        { id: 'p-applied', user_id: U, source_liability_statement_id: 's-applied', status: 'applied' },
      ],
    });
    const items = await listWaitingImports(U, 'liability');
    expect(items.map((i) => [i.document_id, i.stage])).toEqual([
      ['u-draft', 'ai_draft'],
      ['u-review', 'review'],
      ['u-compare', 'compare'],
    ]);
    expect(items[0]).toMatchObject({ label: 'Synthetic Card Co', period_end: '2026-08-31', ai_fallback_draft: draft, document_type: 'credit_card_statement', country_code: 'AU', currency_code: 'AUD' });
    expect(items[1]).toMatchObject({ document_type: 'loan_statement', label: 'Synthetic Lender' });
  });

  it('investment statements: approved with lines still to apply is waiting; fully applied is finished', async () => {
    h.db.reset({
      fdh_statement_uploads: [upload('u-apply', { document_type: 'investment_statement' }), upload('u-done', { document_type: 'investment_statement' })],
      fdh_investment_statements: [
        { id: 'i-apply', user_id: U, statement_upload_id: 'u-apply', approval_status: 'approved', institution_name: 'Synthetic Broker', statement_end_date: '2026-08-31', created_at: '2026-09-25T10:00:00Z' },
        { id: 'i-done', user_id: U, statement_upload_id: 'u-done', approval_status: 'approved', institution_name: null, statement_end_date: null, created_at: '2026-09-25T09:00:00Z' },
      ],
      fdh_investment_statement_activities: [
        { user_id: U, statement_id: 'i-apply', apply_status: 'pending' },
        { user_id: U, statement_id: 'i-done', apply_status: 'applied' },
      ],
      fdh_investment_statement_positions: [],
    });
    expect((await listWaitingImports(U, 'investment')).map((i) => [i.document_id, i.stage])).toEqual([['u-apply', 'apply']]);
  });

  it('retirement: an SMSF statement (routed elsewhere, never approvable here) is not listed', async () => {
    h.db.reset({
      fdh_statement_uploads: [upload('u-super', { document_type: 'super_statement' }), upload('u-smsf', { document_type: 'super_statement' })],
      fdh_retirement_statements: [
        { id: 'r-1', user_id: U, statement_upload_id: 'u-super', approval_status: 'pending', fund_name: 'Synthetic Super', statement_end_date: '2026-06-30', smsf_classification: 'not_smsf', created_at: '2026-09-25T10:00:00Z' },
        { id: 'r-2', user_id: U, statement_upload_id: 'u-smsf', approval_status: 'pending', fund_name: 'Family SMSF', statement_end_date: null, smsf_classification: 'smsf_detected', created_at: '2026-09-25T10:00:00Z' },
      ],
      fhip_import_proposals: [],
    });
    expect((await listWaitingImports(U, 'retirement')).map((i) => i.document_id)).toEqual(['u-super']);
  });

  it('bank statements: only AI readings to check (saved transactions have their own review page)', async () => {
    h.db.reset({
      fdh_statement_uploads: [upload('u-bank', { document_type: 'bank_statement', processing_status: 'processing' })],
      fdh_ai_fallback_drafts: [{ user_id: U, statement_upload_id: 'u-bank', document_type: 'bank_statement', status: 'pending_review', payload: { institutionName: 'Synthetic Bank', rows: [] }, created_at: '2026-09-25T10:00:00Z' }],
    });
    expect((await listWaitingImports(U, 'bank')).map((i) => [i.document_id, i.stage, i.label])).toEqual([['u-bank', 'ai_draft', 'Synthetic Bank']]);
  });

  it('the route answers the list, and refuses an unknown kind', async () => {
    h.db.reset({ fdh_statement_uploads: [], fdh_ai_fallback_drafts: [] });
    const good = await waitingGET(new Request('http://x/api/financial-data-hub/waiting-imports?kind=bank'));
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ data: { items: [] } });
    expect((await waitingGET(new Request('http://x/api/financial-data-hub/waiting-imports?kind=payroll'))).status).toBe(422);
  });

  it('"This doesn\'t look right" discards the reading so it is not offered again -- own pending draft only, zero rows reported', async () => {
    h.db.reset({
      fdh_ai_fallback_drafts: [
        { id: 'd1', user_id: U, statement_upload_id: 'u1', status: 'pending_review' },
        { id: 'd2', user_id: 'user-2', statement_upload_id: 'u2', status: 'pending_review' },
      ],
    });
    expect(await discardPendingAiFallbackDraft(U, 'u1')).toEqual({ discarded: true });
    expect(h.db.tables.fdh_ai_fallback_drafts[0].status).toBe('discarded');
    expect(await discardPendingAiFallbackDraft(U, 'u2')).toEqual({ discarded: false });
    expect(h.db.tables.fdh_ai_fallback_drafts[1].status).toBe('pending_review');
    expect(await discardPendingAiFallbackDraft(U, 'u1')).toEqual({ discarded: false });
  });
});

// ---------------------------------------------------------------------------
describe('C. a re-upload leads to the original, never a dead end', () => {
  it("the retirement upload route answers with the ORIGINAL upload's id (it used to send the copy's, which has no statement)", async () => {
    uploadRetirement.mockResolvedValue({
      document: { id: 'copy', processing_status: 'queued' }, statementId: 'rs-orig', pipelineStatus: 'duplicate_statement',
      duplicateOfDocumentId: 'orig', activitiesExtracted: 0, activitiesDeduplicated: 0, positionsExtracted: 0,
    });
    const res = await retirementUploadPOST(new Request('http://x/api/financial-data-hub/retirement-statement/upload?jurisdiction=AU&currency_code=AUD', { method: 'POST', body: new Uint8Array([1, 2, 3]) }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ document_id: 'orig', duplicate_of_document_id: 'orig', pipeline_status: 'duplicate_statement' });
  });
});

// ---------------------------------------------------------------------------
describe('apply exactly once: a statement whose comparison was already decided is never offered again', () => {
  it('credit card / loan: 409 already_decided, and no new proposal is written', async () => {
    h.db.reset({
      fdh_liability_statements: [{ id: 's1', user_id: U, statement_upload_id: 'orig', statement_type: 'credit_card', approval_status: 'approved', currency_code: 'AUD', reconciliation_status: 'reconciled' }],
      fhip_import_proposals: [{ id: 'p1', user_id: U, source_liability_statement_id: 's1', status: 'applied', applied_at: '2026-09-25T10:00:00Z', generated_at: '2026-09-25T09:59:00Z' }],
      liabilities: [],
    });
    const res = await liabilityProposalPOST(new Request('http://x'), { params: Promise.resolve({ documentId: 'orig' }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'already_decided', outcome: 'applied', proposal_id: 'p1' });
    expect(h.db.writes.filter((w) => w.table === 'fhip_import_proposals')).toEqual([]);
  });

  it('retirement: "keep my existing" counts as decided too', async () => {
    h.db.reset({
      fdh_retirement_statements: [{ id: 'r1', user_id: U, statement_upload_id: 'orig', approval_status: 'approved', smsf_classification: 'not_smsf', retirement_jurisdiction: 'AU', currency_code: 'AUD', account_match_status: 'new_account_confirmed' }],
      fhip_import_proposals: [{ id: 'p2', user_id: U, source_retirement_statement_id: 'r1', status: 'dismissed', dismissed_at: '2026-09-25T10:00:00Z', generated_at: '2026-09-25T09:59:00Z' }],
      retirement_accounts: [],
    });
    const res = await retirementProposalPOST(new Request('http://x'), { params: Promise.resolve({ documentId: 'orig' }) });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'already_decided', outcome: 'kept_existing' });
    expect(h.db.writes.filter((w) => w.table === 'fhip_import_proposals')).toEqual([]);
  });

  it('a statement with only a ready (undecided) proposal still gets its comparison', async () => {
    h.db.reset({
      fdh_liability_statements: [{ id: 's1', user_id: U, statement_upload_id: 'orig', statement_type: 'credit_card', facility_type: 'credit_card', approval_status: 'approved', currency_code: 'AUD', reconciliation_status: 'reconciled', closing_balance: 100 }],
      fhip_import_proposals: [{ id: 'p-ready', user_id: U, source_liability_statement_id: 's1', status: 'ready', generated_at: '2026-09-25T09:59:00Z' }],
      liabilities: [],
    });
    const res = await liabilityProposalPOST(new Request('http://x'), { params: Promise.resolve({ documentId: 'orig' }) });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe('Investment Intelligence: resuming an AI review never reads the file again', () => {
  it('a document awaiting AI review answers with its existing review -- no download, no new parse run', async () => {
    h.db.reset({
      ii_source_documents: [{ id: 'sd1', user_id: U, status: 'ai_review_pending', storage_path: 'ii/x.pdf', mime_type: 'application/pdf' }],
      ii_ai_extraction_reviews: [{ id: 'rev-1', user_id: U, source_document_id: 'sd1', status: 'pending_review', created_at: '2026-09-25T10:00:00Z' }],
      ii_document_parse_runs: [],
    });
    const r = await processSourceDocument({ userId: U, sourceDocumentId: 'sd1' });
    expect(r).toMatchObject({ ok: false, status: 'ai_review_pending', aiExtractionReviewId: 'rev-1' });
    expect(iiDownload).not.toHaveBeenCalled();
    expect(h.db.writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('A. the screens read the rows the API actually sends', () => {
  it("retirement: the comparison rows are camelCase draft fields; the panel normalises them instead of casting snake_case", () => {
    const route = read('app/api/financial-data-hub/retirement-statement/[documentId]/proposal/route.ts');
    expect(route).toContain('fields: draft.fields'); // the adapter draft: camelCase
    const draftFields = [
      { fieldName: 'current_balance', valueKind: 'money', proposedValue: '81234.5600', existingValue: '80000.0000', isRecommended: true, requiresConfirmation: false, reasonCode: 'statement_balance' },
      { fieldName: 'employer_contribution', valueKind: 'money', proposedValue: '950.0000', existingValue: null, isRecommended: true, requiresConfirmation: true, reasonCode: 'confirm' },
    ];
    const fields = normaliseProposedFields(draftFields);
    // The panel's own default-selection rule: recommended and not needing confirmation.
    expect(fields.filter((f) => f.isRecommended && !f.requiresConfirmation).map((f) => f.fieldName)).toEqual(['current_balance']);
    const panel = read('components/retirement/RetirementStatementImportPanel.tsx');
    expect(panel).toContain('normaliseProposedFields(body.fields)');
    expect(panel).not.toMatch(/body\.fields as ProposalField\[\]/);
    expect(panel).not.toMatch(/f\.field_name|f\.is_recommended|f\.proposed_value/);
  });

  it('credit card / loan: the review query selects every column the panel reads', () => {
    const src = read('lib/import-bridge/liabilityProposalService.ts');
    const fn = src.slice(src.indexOf('export async function getLiabilityProposalForReview'));
    const select = fn.slice(fn.indexOf("from('fhip_import_proposal_fields')"), fn.indexOf('.eq(', fn.indexOf("from('fhip_import_proposal_fields')")));
    for (const col of ['field_name', 'value_kind', 'proposed_value', 'existing_value', 'is_recommended', 'requires_confirmation', 'reason_code']) {
      expect(select, `review query no longer selects ${col}`).toContain(col);
    }
  });

  it('the waiting list: the screen and the service agree on every field', () => {
    const fieldsOf = (src: string, iface: string) => {
      const body = src.slice(src.indexOf(`export interface ${iface}`), src.indexOf('}', src.indexOf(`export interface ${iface}`)));
      return [...body.matchAll(/^\s+([a-z_]+)\??:/gm)].map((m) => m[1]).sort();
    };
    const service = fieldsOf(read('lib/financial-data-hub/services/waitingImports.ts'), 'WaitingImport');
    const screen = fieldsOf(read('components/financial-data-hub/WaitingImports.tsx'), 'WaitingImport');
    expect(service.length).toBeGreaterThan(5);
    expect(screen).toEqual(service);
    // A malformed row is dropped rather than rendered blank and unclickable.
    expect(normaliseWaitingImports([{ document_id: 'd', stage: 'review' }, { document_id: '', stage: 'review' }, { stage: 'review' }, { document_id: 'x', stage: 'nonsense' }, null]).map((w) => w.document_id)).toEqual(['d']);
  });
});

// ---------------------------------------------------------------------------
describe('every statement panel is wired the same way', () => {
  const panels: Array<[string, string]> = [
    ['components/liabilities/LiabilityImportPanel.tsx', 'liability'],
    ['components/retirement/RetirementStatementImportPanel.tsx', 'retirement'],
    ['components/investments/AuInvestmentStatementImportPanel.tsx', 'investment'],
    ['components/expenses/BankStatementImportPanel.tsx', 'bank'],
  ];
  it.each(panels)('%s lists what is waiting, discards a rejected reading, and says so on a re-upload', (file, kind) => {
    const src = read(file);
    expect(src).toContain(`useWaitingImports('${kind}')`);
    expect(src).toMatch(/<WaitingImportsList /);
    expect(src).toContain('discardAiDraft(documentId)');
    expect(src).toContain('DUPLICATE_UPLOAD_MESSAGE');
  });

  it.each(panels)('%s never passes a click event into a function that takes an optional document id', (file) => {
    // The payslip panel's trap: `onClick={fn}` hands the click event to fn's
    // first parameter once fn gains an optional one.
    expect(read(file)).not.toMatch(/onClick=\{handleGenerateProposal\}/);
  });
});
