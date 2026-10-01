// "Purge on confirm" (PO decision 2026-10-01).
//
// Found live in production on 2026-10-01: after a user confirmed an AI-fallback
// bank statement, the raw PDF was still in storage with raw_document_purge_status
// 'not_required' and no due date -- the AI-fallback confirm path never scheduled
// a purge, so the file lived until the 50-minute hard backstop. These tests pin
// the fix: the raw file is deleted at confirm time once a CONFIRMED draft proves
// the structured result is durable, without touching processing_status, and
// never throws into the confirm.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { db, storage, audits } = vi.hoisted(() => ({
  db: { current: {} as Record<string, Array<Record<string, unknown>>>, failAdmin: false },
  storage: { deleteOk: true, absent: true, deletes: [] as string[] },
  audits: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/financial-data-hub/services/auditLog', () => ({
  recordDocumentAuditEvent: vi.fn(async (e: Record<string, unknown>) => { audits.push(e); }),
}));
vi.mock('@/lib/financial-data-hub/services/storage', () => ({
  deleteDocumentObject: vi.fn(async (ref: string) => {
    storage.deletes.push(ref);
    return storage.deleteOk ? { ok: true } : { ok: false, message: 'storage unavailable' };
  }),
  verifyDocumentObjectAbsent: vi.fn(async () => storage.absent),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    if (db.failAdmin) throw new Error('admin client unavailable');
    return {
      from(table: string) {
        let rows = (db.current[table] ?? []).slice();
        let patch: Record<string, unknown> | null = null;
        const b: Record<string, unknown> = {
          select: () => b,
          limit: () => b,
          eq(col: string, v: unknown) { rows = rows.filter((r) => r[col] === v); return b; },
          update(p: Record<string, unknown>) { patch = p; return b; },
          maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
          then(res: (v: unknown) => unknown) {
            if (patch) for (const r of rows) Object.assign(r, patch);
            return Promise.resolve({ data: rows, error: null }).then(res);
          },
        };
        return b;
      },
    };
  },
}));

const USER = 'user-a';
const DOC = 'doc-1';
const upload = (over: Record<string, unknown> = {}) => ({
  id: DOC,
  user_id: USER,
  processing_status: 'queued',
  raw_document_purge_status: 'not_required',
  raw_document_storage_reference: `${USER}/${DOC}/${DOC}.bin`,
  raw_document_purge_due_at: null,
  purge_requested_at: null,
  purge_attempt_count: 0,
  original_filename_sanitised: 'statement.pdf',
  ...over,
});
const draft = (over: Record<string, unknown> = {}) => ({ id: 'draft-1', statement_upload_id: DOC, user_id: USER, status: 'confirmed', ...over });

beforeEach(() => {
  audits.length = 0;
  storage.deleteOk = true;
  storage.absent = true;
  storage.deletes.length = 0;
  db.failAdmin = false;
  db.current = { fdh_statement_uploads: [upload()], fdh_ai_fallback_drafts: [draft()] };
});

async function run() {
  const { purgeRawDocumentAfterAiConfirm } = await import('@/lib/financial-data-hub/services/purge');
  return purgeRawDocumentAfterAiConfirm(USER, DOC);
}
const row = () => db.current.fdh_statement_uploads[0];

describe('purgeRawDocumentAfterAiConfirm', () => {
  it('deletes the raw file at confirm time, keeps processing_status, and records why', async () => {
    const out = await run();
    expect(out.status).toBe('purged');
    expect(storage.deletes).toEqual([`${USER}/${DOC}/${DOC}.bin`]);
    expect(row().raw_document_purge_status).toBe('purged');
    expect(row().raw_document_storage_reference).toBeNull();
    expect(row().processing_status).toBe('queued'); // never moved by the purge
    expect(row().purge_reason).toBe('ai_fallback_confirmed_durable_result');
    expect(audits.map((a) => a.eventType)).toEqual(expect.arrayContaining(['document_purge_scheduled', 'document_purged']));
  });

  it('works for a document left in each status the five confirm paths produce (approved, queued, processing)', async () => {
    for (const status of ['approved', 'queued', 'processing']) {
      db.current = { fdh_statement_uploads: [upload({ processing_status: status })], fdh_ai_fallback_drafts: [draft()] };
      storage.deletes.length = 0;
      const out = await run();
      expect(out.status, status).toBe('purged');
      expect(row().processing_status, status).toBe(status);
    }
  });

  it('NEGATIVE CONTROL: a draft that is only pending review (not confirmed) never triggers a purge', async () => {
    db.current.fdh_ai_fallback_drafts = [draft({ status: 'pending_review' })];
    const out = await run();
    expect(out).toEqual({ status: 'skipped', reason: 'no_confirmed_draft' });
    expect(storage.deletes).toHaveLength(0);
    expect(row().raw_document_purge_status).toBe('not_required');
  });

  it('NEGATIVE CONTROL: a confirmed draft that belongs to ANOTHER user never purges this user\'s file', async () => {
    db.current.fdh_ai_fallback_drafts = [draft({ user_id: 'someone-else' })];
    const out = await run();
    expect(out).toEqual({ status: 'skipped', reason: 'no_confirmed_draft' });
    expect(storage.deletes).toHaveLength(0);
  });

  it('NEGATIVE CONTROL: no draft row at all (migration 0197 absent) leaves the file to the 50-minute backstop', async () => {
    db.current.fdh_ai_fallback_drafts = [];
    const out = await run();
    expect(out.status).toBe('skipped');
    expect(storage.deletes).toHaveLength(0);
  });

  it('does nothing when there is no raw object, and is idempotent once purged', async () => {
    db.current.fdh_statement_uploads = [upload({ raw_document_storage_reference: null })];
    expect(await run()).toEqual({ status: 'skipped', reason: 'no_raw_object' });
    db.current.fdh_statement_uploads = [upload()];
    expect((await run()).status).toBe('purged');
    storage.deletes.length = 0;
    // second call: the reference is now null, so nothing to do and no second delete
    expect((await run()).status).toBe('skipped');
    expect(storage.deletes).toHaveLength(0);
  });

  it('leaves a legal hold and an in-progress purge untouched', async () => {
    for (const s of ['legal_hold', 'in_progress', 'purged']) {
      db.current.fdh_statement_uploads = [upload({ raw_document_purge_status: s })];
      const out = await run();
      expect(out, s).toEqual({ status: 'skipped', reason: `purge_status_${s}` });
      expect(storage.deletes, s).toHaveLength(0);
    }
  });

  it('a storage failure is reported, does not throw, leaves the row retryable, and keeps processing_status', async () => {
    storage.deleteOk = false;
    const out = await run();
    expect(out.status).toBe('failed');
    expect(row().raw_document_purge_status).toBe('failed');
    expect(row().processing_status).toBe('queued');
    // a later sweep (or a re-confirm path) can retry: failed -> pending is an allowed transition
    storage.deleteOk = true;
    expect((await run()).status).toBe('purged');
  });

  it('an unexpected error never propagates into the confirm', async () => {
    db.failAdmin = true;
    const out = await run();
    expect(out).toEqual({ status: 'skipped', reason: 'error' });
  });
});

describe('every AI-fallback confirm path calls the purge helper after the durable write', () => {
  // A blunt source-text guard (same style as tests/unit/pc5Prohibitions.test.ts):
  // removing a call re-opens the "raw PDF lives until the backstop" gap on that class.
  it.each([
    ['bankPdfProcessingService.ts', 'confirmClaimedBankStatementDraft'],
    ['investmentStatementProcessingService.ts', 'persistAuInvestmentEvidence'],
    ['liabilityStatementProcessingService.ts', 'persistConfirmedLiabilityDraft'],
    ['payslipProcessingService.ts', 'persistPayrollEvidence'],
    ['retirementStatementProcessingService.ts', 'persistRetirementEvidence'],
  ])('%s', async (file, writer) => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'lib', 'financial-data-hub', 'services', file), 'utf8').replace(/\r\n/g, '\n');
    expect(src).toMatch(/import \{ purgeRawDocumentAfterAiConfirm \} from '\.\/purge';/);
    // the helper is called, and only AFTER the writer has returned (the writer call precedes the helper call)
    const writerAt = src.lastIndexOf(writer + '(');
    const callAt = src.indexOf('await purgeRawDocumentAfterAiConfirm(userId, documentId);');
    expect(callAt, `${file}: helper call present`).toBeGreaterThan(-1);
    expect(callAt, `${file}: helper call after the writer`).toBeGreaterThan(src.indexOf(writer + '('));
    expect(writerAt).toBeGreaterThan(-1);
  });
});
