// FDH raw-file backstop -- a statement document whose evidence is written is
// not forced to `rejected` (2026-09-25, other-PDF AI proof). Written to FAIL
// on origin/main 8b6692c.
//
// Found LIVE on DEV: the liability, retirement and AU-investment services
// write their evidence rows but never move the document out of `queued`
// (native parse and AI confirm alike). The 50-minute backstop then forced
// every such document to `rejected` -- evidence written, awaiting approval --
// the same class as release-register F-4 for payslips.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { updates, db } = vi.hoisted(() => ({
  updates: [] as Array<{ table: string; patch: Record<string, unknown> }>,
  db: { current: {} as Record<string, Array<Record<string, unknown>>> },
}));

vi.mock('@/lib/financial-data-hub/services/auditLog', () => ({ recordDocumentAuditEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/financial-data-hub/services/aiFallbackDrafts', () => ({ documentsWithPendingAiFallbackDrafts: vi.fn().mockResolvedValue(new Set()) }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from(table: string) {
      let rows = (db.current[table] ?? []).slice();
      let patch: Record<string, unknown> | null = null;
      const b: Record<string, unknown> = {
        select: () => b,
        not: () => b,
        limit: () => b,
        returns: () => b,
        eq(col: string, v: unknown) { rows = rows.filter((r) => r[col] === v); return b; },
        in(col: string, vs: unknown[]) { rows = rows.filter((r) => vs.includes(r[col])); return b; },
        update(p: Record<string, unknown>) { patch = p; return b; },
        then(res: (v: unknown) => unknown) {
          if (patch) { updates.push({ table, patch }); for (const r of rows) Object.assign(r, patch); }
          return Promise.resolve({ data: rows, error: null }).then(res);
        },
      };
      return b;
    },
  }),
}));

const OLD = new Date(Date.now() - 3 * 3600_000).toISOString();
const doc = (id: string, status: string) => ({
  id, user_id: 'u', processing_status: status, raw_document_purge_status: 'not_required', raw_document_storage_reference: `u/${id}.csv`,
  uploaded_at: OLD, created_at: OLD, raw_document_purge_due_at: null,
});

beforeEach(() => {
  updates.length = 0;
  db.current = {
    fdh_statement_uploads: [doc('with-evidence', 'queued'), doc('no-evidence', 'queued')],
    fdh_liability_statements: [{ statement_upload_id: 'with-evidence' }],
    fdh_retirement_statements: [],
    fdh_investment_statements: [],
  };
});

describe('enforceRawFileHardBackstop', () => {
  it('purges the file of a queued document WITH statement evidence but keeps its status; a queued document with nothing is still rejected', async () => {
    const { enforceRawFileHardBackstop } = await import('@/lib/financial-data-hub/services/purge');
    await enforceRawFileHardBackstop(50);
    const [withEv, noEv] = db.current.fdh_statement_uploads;
    expect(withEv.processing_status).toBe('queued');
    expect(withEv.raw_document_purge_status).toBe('pending');
    expect(noEv.processing_status).toBe('rejected');
    expect(noEv.raw_document_purge_status).toBe('pending');
  });
});
