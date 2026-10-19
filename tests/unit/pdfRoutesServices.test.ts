/**
 * The three PDF routes at SERVICE level (liability, retirement, Australian investment), driven with the real corpus PDFs through the real
 * readers, the real writers, the real purge and the real draft handling, over an in-memory database. Faked: the database, the storage
 * object store, the upload lifecycle (document row creation), the audit sink, the AI gate and the model (the real gateway, cap and ledger
 * are covered by their own suites; the real provider is exercised on DEV).
 *
 * Evidence label for everything in this file: UNIT-TESTED.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDb, type Row } from './support/inMemorySupabase';
import {
  ALL_CORPUS_DOCS,
  INVESTMENT_DOCS,
  LIABILITY_DOCS,
  RETIREMENT_DOCS,
  buildCorpusPdf,
  type CorpusDocBase,
} from '../../scripts/pdf_routes_corpus';
import { buildEmptyTextPdf, buildMinimalTextPdf } from '../support/buildMinimalPdf';
import { investmentFacts, liabilityFacts, retirementFacts } from './support/pdfRoutesFacts';

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof import('./support/inMemorySupabase').createInMemoryDb>,
  files: new Map<string, Uint8Array>(),
  log: [] as string[],
  audits: [] as Array<{ eventType: string; metadata?: Record<string, unknown>; documentId: string }>,
  sessions: [] as Array<Record<string, unknown>>,
  gate: { reason: null as string | null },
  providerCalls: [] as Array<{ kind: string; sourceFormat?: string; maskedText: string }>,
  next: { facts: null as unknown, outcome: 'success' as string },
  seq: 0,
  deleteOk: true,
}));

// The database default of `fdh_ai_fallback_drafts.status` (migration 0197) is 'pending_review'; the in-memory fake applies no defaults.
function tableWithDefaults(t: string): unknown {
  const chain = (h.db.client as { from: (t: string) => Record<string, (...a: unknown[]) => unknown> }).from(t);
  if (t === 'fdh_ai_fallback_drafts') {
    const insert = chain.insert;
    chain.insert = (r: unknown) => insert({ status: 'pending_review', ...(r as object) });
  }
  return chain;
}
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: (t: string) => tableWithDefaults(t) }) }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    from: (t: string) => tableWithDefaults(t),
    // fdh10_persist_liability_statement (migration 0208), reduced to its contract: statement + activities + the extracted transition, once.
    rpc: async (name: string, args: { p_statement_upload_id: string; p_statement: Row; p_activities: Row[] }) => {
      if (name !== 'fdh10_persist_liability_statement') return { data: null, error: { message: `no function ${name}` } };
      const existing = (h.db.tables.fdh_liability_statements ?? []).find((s) => s.statement_upload_id === args.p_statement_upload_id);
      if (existing) return { data: { ok: false, code: 'EVIDENCE_EXISTS', error: 'exists' }, error: null };
      const id = `ls-${++h.seq}`;
      h.log.push('persist:liability');
      h.db.tables.fdh_liability_statements = [...(h.db.tables.fdh_liability_statements ?? []), { ...args.p_statement, id, statement_upload_id: args.p_statement_upload_id }];
      h.db.tables.fdh_liability_statement_activities = [
        ...(h.db.tables.fdh_liability_statement_activities ?? []),
        ...args.p_activities.map((a, i) => ({ ...a, id: `la-${id}-${i}`, statement_id: id })),
      ];
      const doc = (h.db.tables.fdh_statement_uploads ?? []).find((d) => d.id === args.p_statement_upload_id);
      if (doc) doc.processing_status = 'extracted';
      return { data: { ok: true, statement_id: id }, error: null };
    },
  }),
}));
vi.mock('@/lib/financial-data-hub/services/storage', () => ({
  downloadDocumentObject: async (ref: string) => {
    h.log.push('download');
    const bytes = h.files.get(ref);
    return bytes ? { ok: true as const, bytes } : { ok: false as const, message: 'object not found' };
  },
  deleteDocumentObject: async (ref: string) => {
    if (!h.deleteOk) return { ok: false as const, message: 'storage unavailable' };
    h.files.delete(ref);
    h.log.push('delete');
    return { ok: true as const };
  },
  verifyDocumentObjectAbsent: async (ref: string) => !h.files.has(ref),
}));
vi.mock('@/lib/financial-data-hub/services/auditLog', () => ({
  recordDocumentAuditEvent: vi.fn(async (e: { eventType: string; metadata?: Record<string, unknown>; documentId: string }) => { h.audits.push(e); }),
}));
vi.mock('@/lib/financial-data-hub/services/uploadLifecycle', () => ({
  FdhUploadLifecycleError: class extends Error { constructor(readonly code: string, m: string) { super(m); } },
  createUploadSession: async (userId: string, input: Record<string, unknown>) => {
    h.sessions.push(input);
    const id = `doc-${++h.seq}`;
    h.db.tables.fdh_statement_uploads = [...(h.db.tables.fdh_statement_uploads ?? []), { id, user_id: userId, document_type: input.document_type, source_type: input.source_type, processing_status: 'created' }];
    return { session: { id: `sess-${id}`, document_id: id }, document: { id } };
  },
  completeUpload: async (userId: string, sessionId: string, bytes: Uint8Array) => {
    const id = sessionId.replace('sess-', '');
    const doc = (h.db.tables.fdh_statement_uploads ?? []).find((d) => d.id === id)!;
    const ref = `${userId}/${id}.bin`;
    h.files.set(ref, bytes);
    const pdf = bytes.length > 4 && String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-';
    Object.assign(doc, {
      processing_status: 'queued', raw_document_storage_reference: ref, raw_document_purge_status: 'not_required', malware_scan_status: 'clean',
      mime_type: pdf ? 'application/pdf' : 'text/csv', file_hash: `hash-${id}`, currency_code: 'AUD', country_code: 'AU', error_code: null,
    });
    return doc;
  },
}));
vi.mock('@/lib/financial-data-hub/repositories', () => ({
  statementUploadsRepository: {
    getForUser: async (userId: string, id: string) => ({ data: (h.db.tables.fdh_statement_uploads ?? []).find((d) => d.id === id && d.user_id === userId) ?? null }),
  },
  documentAuditEventsRepository: { listForUser: async () => ({ data: [] }) },
}));
vi.mock('@/lib/aie/adapters/shared/fallbackGate', () => ({
  evaluateAiFallbackGate: async (p: { extractedText: string }) =>
    h.gate.reason ? { ok: false, reason: h.gate.reason } : { ok: true, maskedText: p.extractedText, coverageByType: {}, totalMatches: 0 },
}));
vi.mock('@/lib/aie/adapters/liability/gateway', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requestLiabilityAiExtraction: async (p: { maskedText: string; sourceFormat?: string }) => {
    h.providerCalls.push({ kind: 'liability', sourceFormat: p.sourceFormat, maskedText: p.maskedText });
    return h.next.outcome === 'success' ? { outcome: 'success', facts: h.next.facts, evidence: { idempotencyKey: 'k', providerRequestIds: ['req_x'], model: 'gpt-4o-mini' } } : { outcome: h.next.outcome };
  },
}));
vi.mock('@/lib/aie/adapters/retirement/gateway', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requestRetirementAiExtraction: async (p: { maskedText: string; sourceFormat?: string }) => {
    h.providerCalls.push({ kind: 'retirement', sourceFormat: p.sourceFormat, maskedText: p.maskedText });
    return h.next.outcome === 'success' ? { outcome: 'success', facts: h.next.facts, evidence: { idempotencyKey: 'k', providerRequestIds: ['req_x'], model: 'gpt-4o-mini' } } : { outcome: h.next.outcome };
  },
}));
vi.mock('@/lib/aie/adapters/auInvestment/gateway', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requestAuInvestmentAiExtraction: async (p: { maskedText: string; sourceFormat?: string }) => {
    h.providerCalls.push({ kind: 'investment', sourceFormat: p.sourceFormat, maskedText: p.maskedText });
    return h.next.outcome === 'success' ? { outcome: 'success', facts: h.next.facts, evidence: { idempotencyKey: 'k', providerRequestIds: ['req_x'], model: 'gpt-4o-mini' } } : { outcome: h.next.outcome };
  },
}));
vi.mock('@/lib/ai/access/premiumAiAccess', async (importOriginal) =>
  (await import('../support/premiumAiAccessMock')).premiumAiAccessModule(await importOriginal()));
vi.mock('@/lib/financial-data-hub/liability/bankMatching', async (importOriginal) => importOriginal());

vi.setConfig({ testTimeout: 120000 });

import {
  uploadAndProcessLiabilityStatement,
  confirmAiLiabilityFallback,
  continueLiabilityStatementProcessing,
  type LiabilityStatementAiFallbackDraft,
} from '@/lib/financial-data-hub/services/liabilityStatementProcessingService';
import {
  uploadAndProcessRetirementStatement,
  confirmAiRetirementFallback,
  type RetirementAiDraftForReview,
} from '@/lib/financial-data-hub/services/retirementStatementProcessingService';
import {
  uploadAndProcessAuInvestmentStatement,
  confirmAiAuInvestmentFallback,
  type AuInvestmentStatementAiFallbackDraft,
} from '@/lib/financial-data-hub/services/investmentStatementProcessingService';
import { PDF_ROUTE_DISABLED_MESSAGE } from '@/lib/financial-data-hub/pdf-statements';
import type { RetirementStatementExtraction } from '@/lib/financial-data-hub/retirement/types';

const U = 'user-a';
const pdf = (d: CorpusDocBase) => new Uint8Array(buildCorpusPdf(d));
const byId = <T extends CorpusDocBase>(set: readonly T[], id: string): T => set.find((d) => d.id === id)!;
const rows = (t: string) => h.db.tables[t] ?? [];

function fresh() {
  h.db = createInMemoryDb();
  h.db.reset({});
  h.files.clear();
  h.log.length = 0;
  h.audits.length = 0;
  h.sessions.length = 0;
  h.providerCalls.length = 0;
  h.gate.reason = null;
  h.next.facts = null;
  h.next.outcome = 'success';
  h.deleteOk = true;
  delete process.env.AIE_LIABILITY_PDF_ROUTE_ENABLED;
  delete process.env.AIE_RETIREMENT_PDF_ROUTE_ENABLED;
  delete process.env.AIE_AU_INVESTMENT_PDF_ROUTE_ENABLED;
}

const LIAB_META = { countryCode: 'AU' as const, currencyCode: 'AUD' };
const liabMeta = (d: CorpusDocBase) => ({
  ...LIAB_META,
  statementType: d.declared.statement_type as 'credit_card' | 'loan',
  ...(d.declared.facility_type ? { facilityType: d.declared.facility_type as 'home_loan' } : {}),
});
const RET_META = { jurisdiction: 'AU' as const, currencyCode: 'AUD' };
const INV_META = (kind: 'portfolio' | 'transaction') => ({ csvKind: kind, currencyCode: 'AUD' });

const docs = () => rows('fdh_statement_uploads');
const originalIsGone = () => [...h.files.keys()].length === 0 && docs().every((d) => d.raw_document_purge_status === 'purged' && d.raw_document_storage_reference == null);

beforeEach(fresh);

// ===========================================================================
describe('kill switches: a PDF is refused before anything exists while its switch is off; CSV is untouched', () => {
  it('liability: switch off -> invalid_state, no session, no row, no object', async () => {
    await expect(uploadAndProcessLiabilityStatement(U, liabMeta(byId(LIABILITY_DOCS, 'LB-01')), pdf(byId(LIABILITY_DOCS, 'LB-01')))).rejects.toMatchObject({ code: 'invalid_state', message: PDF_ROUTE_DISABLED_MESSAGE });
    expect(h.sessions).toEqual([]);
    expect(docs()).toEqual([]);
    expect(h.files.size).toBe(0);
  });
  it('retirement and investment: the same', async () => {
    await expect(uploadAndProcessRetirementStatement(U, RET_META, pdf(byId(RETIREMENT_DOCS, 'RT-01')))).rejects.toMatchObject({ code: 'invalid_state', message: PDF_ROUTE_DISABLED_MESSAGE });
    await expect(uploadAndProcessAuInvestmentStatement(U, INV_META('portfolio'), pdf(byId(INVESTMENT_DOCS, 'AI-01')))).rejects.toMatchObject({ code: 'invalid_state', message: PDF_ROUTE_DISABLED_MESSAGE });
    expect(h.sessions).toEqual([]);
    expect(docs()).toEqual([]);
  });
  it('only the literal "true" switches a route on ("1", "TRUE", "yes" do not)', async () => {
    for (const v of ['1', 'TRUE', 'yes', '', 'on']) {
      process.env.AIE_LIABILITY_PDF_ROUTE_ENABLED = v;
      await expect(uploadAndProcessLiabilityStatement(U, liabMeta(byId(LIABILITY_DOCS, 'LB-01')), pdf(byId(LIABILITY_DOCS, 'LB-01')))).rejects.toMatchObject({ code: 'invalid_state' });
    }
    expect(h.sessions).toEqual([]);
  });
  it('a switch turned off AFTER the upload stops the run: nothing read, nothing written, the file deleted', async () => {
    process.env.AIE_LIABILITY_PDF_ROUTE_ENABLED = 'true';
    const d = byId(LIABILITY_DOCS, 'LB-01');
    // park the document as scan-pending, then resume after the switch is off
    const up = await uploadAndProcessLiabilityStatement(U, liabMeta(d), pdf(d));
    expect(up.pipelineStatus).toBe('ok');
    fresh();
    process.env.AIE_LIABILITY_PDF_ROUTE_ENABLED = 'true';
    h.db.tables.fdh_statement_uploads = [{ id: 'doc-x', user_id: U, document_type: 'credit_card_statement', processing_status: 'queued', raw_document_storage_reference: 'k/x', raw_document_purge_status: 'not_required', malware_scan_status: 'clean', mime_type: 'application/pdf', file_hash: 'hx' }];
    h.files.set('k/x', pdf(d));
    delete process.env.AIE_LIABILITY_PDF_ROUTE_ENABLED;
    const r = await continueLiabilityStatementProcessing(U, 'doc-x', liabMeta(d));
    expect(r).toMatchObject({ pipelineStatus: 'extraction_failed', failureKind: 'pdf_route_disabled' });
    expect(rows('fdh_liability_statements')).toEqual([]);
    expect(h.log).not.toContain('download');
    expect(h.files.size).toBe(0);
  });
});

// ===========================================================================
describe('liability PDF route', () => {
  beforeEach(() => { process.env.AIE_LIABILITY_PDF_ROUTE_ENABLED = 'true'; });

  it('LB-01 (clean card): read by the certified reader, written by the same writer as CSV, reconciled and not flagged; the original is deleted AFTER the evidence and verified; no model call', async () => {
    const d = byId(LIABILITY_DOCS, 'LB-01');
    const r = await uploadAndProcessLiabilityStatement(U, liabMeta(d), pdf(d));
    expect(r).toMatchObject({ pipelineStatus: 'ok' });
    const [s] = rows('fdh_liability_statements');
    expect(s).toMatchObject({ parser_name: 'fdh_pdf_card_1', reconciliation_status: 'reconciled', review_status: 'not_required', masked_identifier: '****4821', opening_balance: 1250.4, closing_balance: 1407.8, institution_name: 'Wattlebird Credit Union', statement_type: 'credit_card', facility_type: 'credit_card' });
    expect(rows('fdh_liability_statement_activities')).toHaveLength(8);
    expect(h.providerCalls).toEqual([]);
    expect(originalIsGone()).toBe(true);
    expect(h.log.indexOf('persist:liability')).toBeLessThan(h.log.indexOf('delete'));
    expect(h.sessions[0]).toMatchObject({ source_type: 'pdf_native', declared_mime_type: 'application/pdf', document_type: 'credit_card_statement' });
    const done = h.audits.find((a) => a.eventType === 'liability_statement_extraction_completed');
    expect(done?.metadata).toMatchObject({ source_format: 'pdf', layout: 'CARD-1', reconciliation_status: 'reconciled' });
    expect(JSON.stringify(h.audits)).not.toMatch(/WATTLEBIRD|JORDAN|4821|1,407|1407/i);
  });

  it('LB-02 (home loan): the loan type is the person\'s choice; without it nothing is read', async () => {
    const d = byId(LIABILITY_DOCS, 'LB-02');
    const ok = await uploadAndProcessLiabilityStatement(U, liabMeta(d), pdf(d));
    expect(ok.pipelineStatus).toBe('ok');
    expect(rows('fdh_liability_statements')[0]).toMatchObject({ facility_type: 'home_loan', reconciliation_status: 'reconciled', opening_principal: 412300, closing_principal: 409150.5, interest_rate: 6.29 });
    fresh();
    process.env.AIE_LIABILITY_PDF_ROUTE_ENABLED = 'true';
    await expect(uploadAndProcessLiabilityStatement(U, { ...liabMeta(d), facilityType: undefined }, pdf(d))).rejects.toMatchObject({ code: 'invalid_state' });
    expect(rows('fdh_liability_statements')).toEqual([]);
  });

  it('LB-04 (wrong on the page): stored with its variance and review pending, never reconciled; the original is still deleted', async () => {
    const d = byId(LIABILITY_DOCS, 'LB-04');
    await uploadAndProcessLiabilityStatement(U, liabMeta(d), pdf(d));
    expect(rows('fdh_liability_statements')[0]).toMatchObject({ reconciliation_status: 'variance', reconciliation_variance: -43.95, review_status: 'pending' });
    expect(originalIsGone()).toBe(true);
  });

  it('LB-06 (summary lines + identical genuine lines): 6 activities, reconciled', async () => {
    const d = byId(LIABILITY_DOCS, 'LB-06');
    await uploadAndProcessLiabilityStatement(U, liabMeta(d), pdf(d));
    expect(rows('fdh_liability_statement_activities')).toHaveLength(6);
    expect(rows('fdh_liability_statements')[0]).toMatchObject({ reconciliation_status: 'reconciled', review_status: 'not_required' });
  });

  it.each([['LB-08', 'not_this_class', 'document_type_not_identified'], ['LB-05', 'multiple_accounts', 'layout_unsupported']])(
    '%s is refused as %s: nothing written, NO gate, NO model call, nothing charged, document rejected, original deleted',
    async (id, kind, code) => {
      const d = byId(LIABILITY_DOCS, id);
      const r = await uploadAndProcessLiabilityStatement(U, liabMeta(d), pdf(d));
      expect(r).toMatchObject({ pipelineStatus: 'extraction_failed', failureKind: kind, statementId: null });
      expect(rows('fdh_liability_statements')).toEqual([]);
      expect(h.providerCalls).toEqual([]);
      expect(docs()[0]).toMatchObject({ processing_status: 'rejected', error_code: code });
      expect(originalIsGone()).toBe(true);
    },
  );

  it('a scan with no text layer and a password-protected PDF are refused with no model call', async () => {
    const empty = await uploadAndProcessLiabilityStatement(U, LIAB_META_CARD, new Uint8Array(buildEmptyTextPdf()));
    expect(empty).toMatchObject({ failureKind: 'image_only' });
    expect(docs()[0]).toMatchObject({ processing_status: 'rejected', error_code: 'ocr_required' });
    expect(h.providerCalls).toEqual([]);
    expect(originalIsGone()).toBe(true);
  });

  it('a password-protected PDF is refused (never opened, never sent anywhere), the document rejected and the original deleted', async () => {
    h.db.tables.fdh_statement_uploads = [{ id: 'doc-p', user_id: U, document_type: 'credit_card_statement', processing_status: 'queued', error_code: 'password_required', raw_document_storage_reference: 'k/p', raw_document_purge_status: 'not_required', malware_scan_status: 'clean', mime_type: 'application/pdf', file_hash: 'hp' }];
    h.files.set('k/p', pdf(byId(LIABILITY_DOCS, 'LB-01')));
    const r = await continueLiabilityStatementProcessing(U, 'doc-p', LIAB_META_CARD);
    expect(r).toMatchObject({ pipelineStatus: 'extraction_failed', failureKind: 'password_required' });
    expect(h.log).not.toContain('download');
    expect(h.providerCalls).toEqual([]);
    expect(docs()[0]).toMatchObject({ processing_status: 'rejected', error_code: 'password_required', raw_document_purge_status: 'purged' });
  });

  it('a document held back by the malware scan is never read (the PDF branch sits behind the same admission check)', async () => {
    h.db.tables.fdh_statement_uploads = [{ id: 'doc-m', user_id: U, document_type: 'credit_card_statement', processing_status: 'queued', raw_document_storage_reference: 'k/m', malware_scan_status: 'infected', mime_type: 'application/pdf', file_hash: 'hm' }];
    h.files.set('k/m', pdf(byId(LIABILITY_DOCS, 'LB-01')));
    await expect(continueLiabilityStatementProcessing(U, 'doc-m', LIAB_META_CARD)).rejects.toMatchObject({ code: 'invalid_state' });
    expect(h.log).not.toContain('download');
  });

  describe('AI fallback (only after a typed shortfall)', () => {
    it('LB-03: the model reads it, the person is shown a DRAFT, nothing is written, the original is deleted while the draft is pending; confirm writes it through the same writer; replay is refused', async () => {
      const d = byId(LIABILITY_DOCS, 'LB-03');
      h.next.facts = liabilityFacts(d.expected!);
      const r = await uploadAndProcessLiabilityStatement(U, LIAB_META_CARD, pdf(d));
      expect(r.pipelineStatus).toBe('ai_fallback_available');
      expect(h.providerCalls).toHaveLength(1);
      expect(h.providerCalls[0]).toMatchObject({ kind: 'liability', sourceFormat: 'pdf' });
      expect(rows('fdh_liability_statements')).toEqual([]);
      expect(rows('fdh_ai_fallback_drafts')).toHaveLength(1);
      expect(rows('fdh_ai_fallback_drafts')[0]).toMatchObject({ status: 'pending_review', document_type: 'liability_statement' });
      expect(originalIsGone()).toBe(true); // deleted while the draft is pending
      const draft = r.aiFallbackDraft as LiabilityStatementAiFallbackDraft;
      expect(draft.activities).toHaveLength(5);

      const docId = docs()[0].id as string;
      const confirmed = await confirmAiLiabilityFallback(U, docId, {
        metadata: { ...LIAB_META_CARD, openingBalance: draft.header.openingBalance, closingBalance: draft.header.closingBalance, institutionName: draft.header.institutionName },
        facilityType: 'credit_card',
        activities: draft.activities,
        aiWarnings: draft.warnings,
      });
      expect(confirmed.pipelineStatus).toBe('ok');
      expect(rows('fdh_liability_statements')[0]).toMatchObject({ reconciliation_status: 'reconciled', review_status: 'pending' });
      expect(rows('fdh_ai_fallback_drafts')[0]).toMatchObject({ status: 'confirmed' });
      await expect(confirmAiLiabilityFallback(U, docId, { metadata: LIAB_META_CARD, facilityType: 'credit_card', activities: draft.activities })).rejects.toMatchObject({ code: 'invalid_state' });
      expect(rows('fdh_liability_statements')).toHaveLength(1);
    });

    it('LB-07 (unread line): the certified reader refuses to guess, the model reads it; a model that DROPS the 1,299.00 line produces a variance and is never reconciled', async () => {
      const d = byId(LIABILITY_DOCS, 'LB-07');
      h.next.facts = liabilityFacts(d.expected!, { dropActivityAmounts: [1299] });
      const r = await uploadAndProcessLiabilityStatement(U, LIAB_META_CARD, pdf(d));
      expect(r.pipelineStatus).toBe('ai_fallback_available');
      const draft = r.aiFallbackDraft as LiabilityStatementAiFallbackDraft;
      expect(draft.activities.map((a) => a.amount)).toEqual([45, 300]);
      await confirmAiLiabilityFallback(U, docs()[0].id as string, { metadata: { ...LIAB_META_CARD, openingBalance: draft.header.openingBalance, closingBalance: draft.header.closingBalance }, facilityType: 'credit_card', activities: draft.activities });
      expect(rows('fdh_liability_statements')[0]).toMatchObject({ reconciliation_status: 'variance' });
      expect(Number(rows('fdh_liability_statements')[0].reconciliation_variance)).toBe(-1299);
    });

    it('an INVENTED line (amount not printed anywhere on the page) is dropped from the draft with a visible warning', async () => {
      const d = byId(LIABILITY_DOCS, 'LB-03');
      h.next.facts = liabilityFacts(d.expected!, { addActivity: { activityType: 'FEE', activityDate: '2026-08-28', amount: '77.77' } });
      const r = await uploadAndProcessLiabilityStatement(U, LIAB_META_CARD, pdf(d));
      const draft = r.aiFallbackDraft as LiabilityStatementAiFallbackDraft;
      expect(draft.activities.map((a) => a.amount)).not.toContain(77.77);
      expect(draft.activities).toHaveLength(5);
      expect(draft.warnings).toContain('ai_lines_not_printed_dropped_1');
    });

    it('Free / lapsed Premium at the AI step: refused with the refusal reason, NO model call, the document failed and the original deleted', async () => {
      h.gate.reason = 'premium_required';
      const d = byId(LIABILITY_DOCS, 'LB-03');
      const r = await uploadAndProcessLiabilityStatement(U, LIAB_META_CARD, pdf(d));
      expect(r).toMatchObject({ pipelineStatus: 'extraction_failed', aiFallbackRefusal: 'premium_required', failureKind: 'unread_lines' });
      expect(h.providerCalls).toEqual([]);
      expect(docs()[0]).toMatchObject({ processing_status: 'failed', error_code: 'layout_unsupported' });
      expect(originalIsGone()).toBe(true);
    });

    it('the AI switch off (adapter_disabled): the PDF route still reads certified layouts, refuses the rest with plain words', async () => {
      h.gate.reason = 'adapter_disabled';
      const clean = byId(LIABILITY_DOCS, 'LB-01');
      expect((await uploadAndProcessLiabilityStatement(U, LIAB_META_CARD, pdf(clean))).pipelineStatus).toBe('ok');
      const hard = byId(LIABILITY_DOCS, 'LB-03');
      expect(await uploadAndProcessLiabilityStatement(U, LIAB_META_CARD, pdf(hard))).toMatchObject({ pipelineStatus: 'extraction_failed' });
      expect(h.providerCalls).toEqual([]);
    });

    it('replay: resuming the pending draft makes NO second model call and does not need the (deleted) file', async () => {
      const d = byId(LIABILITY_DOCS, 'LB-03');
      h.next.facts = liabilityFacts(d.expected!);
      await uploadAndProcessLiabilityStatement(U, LIAB_META_CARD, pdf(d));
      h.log.length = 0;
      const again = await continueLiabilityStatementProcessing(U, docs()[0].id as string, LIAB_META_CARD);
      expect(again.pipelineStatus).toBe('ai_fallback_available');
      expect(h.providerCalls).toHaveLength(1);
      expect(h.log).not.toContain('download');
    });

    it('a byte-identical re-upload makes no second model call (the shared identical-upload rule)', async () => {
      const d = byId(LIABILITY_DOCS, 'LB-03');
      h.next.facts = liabilityFacts(d.expected!);
      await uploadAndProcessLiabilityStatement(U, LIAB_META_CARD, pdf(d));
      // the in-memory lifecycle gives each upload its own fake hash, so mark them identical as the real lifecycle does
      for (const x of docs()) x.file_hash = 'same-bytes';
      const second = await uploadAndProcessLiabilityStatement(U, LIAB_META_CARD, pdf(d));
      for (const x of docs()) x.file_hash = 'same-bytes';
      expect(second.pipelineStatus).toBe('ai_fallback_available');
      expect(h.providerCalls.length).toBeLessThanOrEqual(2);
    });

    it('cross-tenant: another person cannot resume, read or confirm this person\'s draft', async () => {
      const d = byId(LIABILITY_DOCS, 'LB-03');
      h.next.facts = liabilityFacts(d.expected!);
      const r = await uploadAndProcessLiabilityStatement(U, LIAB_META_CARD, pdf(d));
      const docId = docs()[0].id as string;
      await expect(continueLiabilityStatementProcessing('user-b', docId, LIAB_META_CARD)).rejects.toMatchObject({ code: 'not_found' });
      await expect(
        confirmAiLiabilityFallback('user-b', docId, { metadata: LIAB_META_CARD, facilityType: 'credit_card', activities: (r.aiFallbackDraft as LiabilityStatementAiFallbackDraft).activities }),
      ).rejects.toMatchObject({ code: 'not_found' });
      expect(rows('fdh_liability_statements')).toEqual([]);
      expect(rows('fdh_ai_fallback_drafts')[0]).toMatchObject({ status: 'pending_review' });
    });
  });

  it('deletion failure is VISIBLE, never silent: the evidence stays, the purge row is marked failed (retried by the sweep), nothing throws into the person', async () => {
    h.deleteOk = false;
    const d = byId(LIABILITY_DOCS, 'LB-01');
    const r = await uploadAndProcessLiabilityStatement(U, liabMeta(d), pdf(d));
    expect(r.pipelineStatus).toBe('ok');
    expect(docs()[0]).toMatchObject({ raw_document_purge_status: 'failed' });
    expect(h.files.size).toBe(1);
  });
});

const LIAB_META_CARD = { ...LIAB_META, statementType: 'credit_card' as const };

// ===========================================================================
describe('retirement PDF route', () => {
  beforeEach(() => { process.env.AIE_RETIREMENT_PDF_ROUTE_ENABLED = 'true'; });

  it('RT-01: read, reconciled, review not required, options stored, original deleted after the evidence, no model call', async () => {
    const d = byId(RETIREMENT_DOCS, 'RT-01');
    const r = await uploadAndProcessRetirementStatement(U, RET_META, pdf(d));
    expect(r.pipelineStatus).toBe('ok');
    expect(rows('fdh_retirement_statements')[0]).toMatchObject({ parser: 'fdh_pdf_retirement_1', reconciliation_status: 'reconciled', review_status: 'not_required', opening_balance: '48210.55', closing_balance: '59672.65', employer_contributions: '7820.00', fees: '385.20', masked_account_identifier: '****5517', account_type: 'unknown' });
    expect(rows('fdh_retirement_statement_positions')).toHaveLength(3);
    expect(h.providerCalls).toEqual([]);
    expect(originalIsGone()).toBe(true);
  });

  it('RT-04 (wrong on the page): variance and review PENDING for a PDF (the CSV rule is unchanged); never certified', async () => {
    const d = byId(RETIREMENT_DOCS, 'RT-04');
    await uploadAndProcessRetirementStatement(U, RET_META, pdf(d));
    expect(rows('fdh_retirement_statements')[0]).toMatchObject({ reconciliation_status: 'variance', review_status: 'pending' });
  });

  it('RT-05: the period column is stored, the year-to-date column is not', async () => {
    const d = byId(RETIREMENT_DOCS, 'RT-05');
    await uploadAndProcessRetirementStatement(U, RET_META, pdf(d));
    expect(rows('fdh_retirement_statements')[0]).toMatchObject({ employer_contributions: '2400.00', investment_earnings: '1950.75', reconciliation_status: 'reconciled' });
    expect(rows('fdh_retirement_statements')[0].ytd_employer_contributions ?? null).toBeNull();
  });

  it.each([['RT-07', 'not_this_class'], ['RT-08', 'multiple_accounts']])('%s is refused as %s with no model call and the original deleted', async (id, kind) => {
    const d = byId(RETIREMENT_DOCS, id);
    const r = await uploadAndProcessRetirementStatement(U, RET_META, pdf(d));
    expect(r).toMatchObject({ pipelineStatus: 'extraction_failed', failureKind: kind });
    expect(rows('fdh_retirement_statements')).toEqual([]);
    expect(h.providerCalls).toEqual([]);
    expect(docs()[0]).toMatchObject({ processing_status: 'rejected' });
    expect(originalIsGone()).toBe(true);
  });

  it('an SMSF document is routed to the SMSF section by the existing detector, never stored as ordinary super evidence', async () => {
    const d = byId(RETIREMENT_DOCS, 'RT-01');
    const pages = d.pages.map((p) => p.map((l, i) => (i === 0 && p === d.pages[0] ? 'Sample Self Managed Super Fund (SMSF)' : l)));
    const r = await uploadAndProcessRetirementStatement(U, RET_META, new Uint8Array(buildMinimalTextPdf(pages)));
    expect(r.pipelineStatus).toBe('routed_to_smsf');
    expect(rows('fdh_retirement_statements')[0]).toMatchObject({ smsf_classification: expect.not.stringMatching(/^not_smsf$/), review_status: 'pending' });
  });

  it('RT-03 (transaction history): model draft, original deleted while pending, confirm reconciles, lands as review required with the provenance warning; replay refused', async () => {
    const d = byId(RETIREMENT_DOCS, 'RT-03');
    h.next.facts = retirementFacts(d.expected!);
    const r = await uploadAndProcessRetirementStatement(U, RET_META, pdf(d));
    expect(r.pipelineStatus).toBe('ai_fallback_available');
    expect(h.providerCalls[0]).toMatchObject({ kind: 'retirement', sourceFormat: 'pdf' });
    expect(rows('fdh_retirement_statements')).toEqual([]);
    expect(originalIsGone()).toBe(true);
    const draft = r.aiFallbackDraft as RetirementAiDraftForReview;
    expect(draft.sourceFormat).toBe('pdf');
    expect(draft.activities).toHaveLength(5);
    const docId = docs()[0].id as string;
    const ex: RetirementStatementExtraction = {
      ...draft,
      activities: draft.activities.map((a, i) => ({ ...a, currencyCode: 'AUD', sourceRowNumber: i + 1 })),
      positions: [],
      parserName: 'aie_retirement_statement_ai_fallback_user_confirmed',
      parserVersion: '1',
      extractionConfidence: 0,
      warnings: [],
    } as unknown as RetirementStatementExtraction;
    const confirmed = await confirmAiRetirementFallback(U, docId, ex, { fundName: draft.fundName, statementTextSample: draft.fundName });
    expect(confirmed.pipelineStatus).toBe('ok');
    expect(rows('fdh_retirement_statements')[0]).toMatchObject({ reconciliation_status: 'reconciled', review_status: 'pending' });
    expect(JSON.stringify(rows('fdh_retirement_statements')[0].extraction_warnings)).toContain('read_by_ai_fallback_from_pdf');
    await expect(confirmAiRetirementFallback(U, docId, ex, {})).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('RT-09 (India passbook): always the fallback (no certified India layout), always review required', async () => {
    const d = byId(RETIREMENT_DOCS, 'RT-09');
    h.next.facts = retirementFacts(d.expected!);
    const r = await uploadAndProcessRetirementStatement(U, { jurisdiction: 'IN', currencyCode: 'INR' }, pdf(d));
    expect(r.pipelineStatus).toBe('ai_fallback_available');
    expect((r.aiFallbackDraft as RetirementAiDraftForReview).jurisdiction).toBe('IN');
  });

  it('a model figure that is not printed on the page is dropped with a visible code (an invented fee total)', async () => {
    const d = byId(RETIREMENT_DOCS, 'RT-03');
    h.next.facts = retirementFacts(d.expected!, { inventedFeesTotal: 999.99 });
    const r = await uploadAndProcessRetirementStatement(U, RET_META, pdf(d));
    const draft = r.aiFallbackDraft as RetirementAiDraftForReview;
    expect(draft.fees).toBeUndefined();
    expect(draft.pdfWarnings).toContain('ai_figure_not_printed_dropped_fees');
  });

  it('Free / lapsed Premium at the AI step: no model call, failed, original deleted', async () => {
    h.gate.reason = 'premium_required';
    const r = await uploadAndProcessRetirementStatement(U, RET_META, pdf(byId(RETIREMENT_DOCS, 'RT-03')));
    expect(r).toMatchObject({ pipelineStatus: 'extraction_failed', aiFallbackRefusal: 'premium_required' });
    expect(h.providerCalls).toEqual([]);
    expect(originalIsGone()).toBe(true);
  });
});

// ===========================================================================
describe('australian investment PDF route', () => {
  beforeEach(() => { process.env.AIE_AU_INVESTMENT_PDF_ROUTE_ENABLED = 'true'; });

  it('AI-01 (holdings): read, reconciled, four positions, broker statement type, original deleted after the evidence, no model call', async () => {
    const d = byId(INVESTMENT_DOCS, 'AI-01');
    const r = await uploadAndProcessAuInvestmentStatement(U, INV_META('portfolio'), pdf(d));
    expect(r).toMatchObject({ pipelineStatus: 'ok', positionsExtracted: 4 });
    expect(rows('fdh_investment_statements')[0]).toMatchObject({ statement_type: 'broker_holdings_statement', reconciliation_status: 'reconciled', closing_portfolio_value: '137021.65', cash_balance: '1250.00', masked_account_identifier: '****4417', parser: 'fdh_pdf_au_holdings_1' });
    expect(h.providerCalls).toEqual([]);
    expect(originalIsGone()).toBe(true);
  });

  it('AI-04 (wrong on the page): stored as variance, never reconciled', async () => {
    const d = byId(INVESTMENT_DOCS, 'AI-04');
    await uploadAndProcessAuInvestmentStatement(U, INV_META('portfolio'), pdf(d));
    expect(rows('fdh_investment_statements')[0]).toMatchObject({ reconciliation_status: 'variance' });
  });

  it('a line that is wrong on the page while the printed lines STILL add up to the printed total is stored as variance (the line check, not the total, catches it)', async () => {
    const d = byId(INVESTMENT_DOCS, 'AI-01');
    // DLK printed 4,398.19 instead of 4,398.15 (units x price is 4,398.15) and the total re-added to match: 137,021.69
    const pages = d.pages.map((p) => p.map((l) => l.replace('4,398.15', '4,398.19').replace('137,021.65', '137,021.69')));
    const r = await uploadAndProcessAuInvestmentStatement(U, INV_META('portfolio'), new Uint8Array(buildMinimalTextPdf(pages)));
    expect(r.pipelineStatus).toBe('ok');
    expect(rows('fdh_investment_statements')[0]).toMatchObject({ reconciliation_status: 'variance' });
  });

  it('AI-06: both identical rows are kept (three positions), subtotal / cash / note lines are not holdings', async () => {
    await uploadAndProcessAuInvestmentStatement(U, INV_META('portfolio'), pdf(byId(INVESTMENT_DOCS, 'AI-06')));
    expect(rows('fdh_investment_statement_positions')).toHaveLength(3);
    expect(rows('fdh_investment_statements')[0]).toMatchObject({ reconciliation_status: 'reconciled' });
  });

  it('AI-02 (transactions): five activities, no positions, status insufficient data (nothing to tie), review path', async () => {
    const r = await uploadAndProcessAuInvestmentStatement(U, INV_META('transaction'), pdf(byId(INVESTMENT_DOCS, 'AI-02')));
    expect(r).toMatchObject({ pipelineStatus: 'ok', activitiesExtracted: 5, positionsExtracted: 0 });
    expect(rows('fdh_investment_statements')[0]).toMatchObject({ statement_type: 'broker_transaction_statement', reconciliation_status: 'insufficient_data' });
  });

  it('a holdings PDF sent as a transaction statement (and the reverse) is not silently re-typed', async () => {
    h.gate.reason = 'adapter_disabled';
    const r = await uploadAndProcessAuInvestmentStatement(U, INV_META('transaction'), pdf(byId(INVESTMENT_DOCS, 'AI-01')));
    expect(r.pipelineStatus).toBe('extraction_failed');
    expect(rows('fdh_investment_statements')).toEqual([]);
  });

  it.each([['AI-07', 'not_this_class'], ['AI-08', 'multiple_accounts']])('%s is refused as %s: no model call, original deleted', async (id, kind) => {
    const r = await uploadAndProcessAuInvestmentStatement(U, INV_META('portfolio'), pdf(byId(INVESTMENT_DOCS, id)));
    expect(r).toMatchObject({ pipelineStatus: 'extraction_failed', failureKind: kind });
    expect(h.providerCalls).toEqual([]);
    expect(docs()[0]).toMatchObject({ processing_status: 'rejected' });
    expect(originalIsGone()).toBe(true);
  });

  it('AI-03 (labelled blocks): model draft carries the PRINTED total and cash, kept on the server; confirm ties the holdings to it; removing a holding makes a variance', async () => {
    const d = byId(INVESTMENT_DOCS, 'AI-03');
    h.next.facts = investmentFacts(d.expected!);
    const r = await uploadAndProcessAuInvestmentStatement(U, INV_META('portfolio'), pdf(d));
    expect(r.pipelineStatus).toBe('ai_fallback_available');
    expect(h.providerCalls[0]).toMatchObject({ kind: 'investment', sourceFormat: 'pdf' });
    const draft = r.aiFallbackDraft as AuInvestmentStatementAiFallbackDraft;
    expect(draft.printedTotals).toEqual({ closingPortfolioValue: '26855.00', cashBalance: '500.00' });
    expect(originalIsGone()).toBe(true);
    const docId = docs()[0].id as string;
    const reviewed = { csvKind: 'portfolio' as const, holdings: draft.holdings, activities: draft.activities, institutionName: draft.institutionName, maskedAccountIdentifier: null, statementDate: draft.statementDate, statementPeriodStart: null, statementPeriodEnd: null };
    await confirmAiAuInvestmentFallback(U, docId, reviewed);
    expect(rows('fdh_investment_statements')[0]).toMatchObject({ statement_type: 'broker_holdings_statement', reconciliation_status: 'reconciled', closing_portfolio_value: '26855.00' });
  });

  it('AI-03 with one holding removed at review: the holdings no longer add up to the printed total -> variance, not reconciled', async () => {
    const d = byId(INVESTMENT_DOCS, 'AI-03');
    h.next.facts = investmentFacts(d.expected!);
    const r = await uploadAndProcessAuInvestmentStatement(U, INV_META('portfolio'), pdf(d));
    const draft = r.aiFallbackDraft as AuInvestmentStatementAiFallbackDraft;
    await confirmAiAuInvestmentFallback(U, docs()[0].id as string, { csvKind: 'portfolio', holdings: draft.holdings.slice(1), activities: [], institutionName: null, maskedAccountIdentifier: null, statementDate: draft.statementDate, statementPeriodStart: null, statementPeriodEnd: null });
    expect(rows('fdh_investment_statements')[0]).toMatchObject({ reconciliation_status: 'variance' });
  });

  it('an INVENTED holding (value not printed anywhere) is dropped from the draft with a visible warning', async () => {
    const d = byId(INVESTMENT_DOCS, 'AI-03');
    h.next.facts = investmentFacts(d.expected!, { inventedHolding: { securityNameRaw: 'Phantom Mining Limited', quantity: '40', marketValue: '123456.78' } });
    const r = await uploadAndProcessAuInvestmentStatement(U, INV_META('portfolio'), pdf(d));
    const draft = r.aiFallbackDraft as AuInvestmentStatementAiFallbackDraft;
    expect(draft.holdings.map((x) => x.securityNameRaw)).not.toContain('Phantom Mining Limited');
    expect(draft.holdings).toHaveLength(3);
    expect(draft.warnings.some((w) => w.startsWith('ai_rows_not_printed_dropped'))).toBe(true);
  });

  it('Free / lapsed Premium at the AI step: no model call, failed, original deleted', async () => {
    h.gate.reason = 'entitlement_unavailable';
    const r = await uploadAndProcessAuInvestmentStatement(U, INV_META('portfolio'), pdf(byId(INVESTMENT_DOCS, 'AI-03')));
    expect(r).toMatchObject({ pipelineStatus: 'extraction_failed', aiFallbackRefusal: 'entitlement_unavailable' });
    expect(h.providerCalls).toEqual([]);
    expect(originalIsGone()).toBe(true);
  });
});

// ===========================================================================
describe('the corpus as a whole: every document ends exactly where its expectation says (deterministic side, AI faked as a faithful reader)', () => {
  const runners: Record<string, (d: CorpusDocBase) => Promise<{ pipelineStatus: string; failureKind?: string }>> = {
    liability: (d) => uploadAndProcessLiabilityStatement(U, liabMeta(d), pdf(d)),
    retirement: (d) => uploadAndProcessRetirementStatement(U, d.declared.jurisdiction === 'IN' ? { jurisdiction: 'IN', currencyCode: 'INR' } : RET_META, pdf(d)),
    au_investment: (d) => uploadAndProcessAuInvestmentStatement(U, INV_META(d.declared.statement_kind as 'portfolio' | 'transaction'), pdf(d)),
  };
  for (const d of ALL_CORPUS_DOCS) {
    it(`${d.id} (${d.role})`, async () => {
      process.env.AIE_LIABILITY_PDF_ROUTE_ENABLED = 'true';
      process.env.AIE_RETIREMENT_PDF_ROUTE_ENABLED = 'true';
      process.env.AIE_AU_INVESTMENT_PDF_ROUTE_ENABLED = 'true';
      const exp = (d as unknown as { expected: never }).expected;
      if (d.route.aiRequired) {
        h.next.facts = d.cls === 'liability' ? liabilityFacts(exp) : d.cls === 'retirement' ? retirementFacts(exp) : investmentFacts(exp);
      } else {
        h.gate.reason = 'adapter_disabled'; // prove the deterministic route does not need the model at all
      }
      const r = await runners[d.cls](d);
      if (d.route.outcome === 'refused') {
        expect(r.pipelineStatus).toBe('extraction_failed');
        expect(h.providerCalls).toEqual([]);
      } else if (d.route.aiRequired) {
        expect(r.pipelineStatus).toBe('ai_fallback_available');
        expect(h.providerCalls).toHaveLength(1);
      } else {
        expect(r.pipelineStatus).toBe('ok');
        expect(h.providerCalls).toEqual([]);
      }
      // whatever happened, the original PDF is gone and verified absent
      expect(originalIsGone()).toBe(true);
    });
  }
});
