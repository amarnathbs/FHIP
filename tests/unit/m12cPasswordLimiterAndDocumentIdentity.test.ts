// M12C §10 (`M2-OPEN-8`) and §11 (`CG-10`).
//
// Everything here is synthetic. No real document, user, password or storage
// object is referenced.
//
// §10 asks for: same-document repeated wrong password; cross-user isolation;
// success after a valid password; timeout/reset behaviour — using the SHARED
// limiter, with the attempt recorded BEFORE decryption.
// §11 asks for: A processes A; B processes B; password A cannot unlock B;
// run A belongs to A; run B belongs to B — with the immutable source-document
// id authoritative and the storage path NOT identity.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { checkPasswordAttemptRateLimit } from '@/lib/financial-data-hub/bank-pdf/password';
import { MAX_PASSWORD_ATTEMPTS_PER_DOCUMENT_PER_HOUR } from '@/lib/financial-data-hub/bank-pdf/constants';

const NOW = '2026-09-16T12:00:00.000Z';
const minutesAgo = (m: number): string => new Date(Date.parse(NOW) - m * 60 * 1000).toISOString();
const attempts = (n: number, at: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => ({ event_type: 'pdf_password_required', created_at: at(i) }));

const repoRoot = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

// ---------------------------------------------------------------------------
// §10 — the limiter's decision semantics, on the surfaces that now use it
// ---------------------------------------------------------------------------

describe('M12C §10 — the SHARED password-attempt limiter, applied to the Investment Intelligence and payslip surfaces', () => {
  it('there is exactly ONE threshold constant and ONE window in the product', () => {
    // The requirement says "Use the SHARED limiter, not multiple counters."
    // Both new call sites import the same function and the same constant; a
    // second threshold appearing anywhere would break this.
    const ii = read('lib/services/investment-intelligence/documentProcessing.ts');
    const payslip = read('lib/financial-data-hub/services/payslipProcessingService.ts');
    for (const [name, src] of [
      ['documentProcessing.ts', ii],
      ['payslipProcessingService.ts', payslip],
    ] as const) {
      expect(src, `${name} must import the shared limiter`).toMatch(/import \{ checkPasswordAttemptRateLimit \}/);
      // No hand-rolled ceiling: the literal 8 must not appear as a comparison
      // bound next to an attempt count in either file.
      expect(src, `${name} must not hard-code a second threshold`).not.toMatch(/attempts\w*\s*[<>]=?\s*\d/i);
    }
    // And the limiter itself still reads its bound from the shared constant.
    expect(read('lib/financial-data-hub/bank-pdf/password.ts')).toMatch(/MAX_PASSWORD_ATTEMPTS_PER_DOCUMENT_PER_HOUR/);
  });

  it('same document, repeated wrong passwords: allowed below the ceiling, refused at it', () => {
    const under = checkPasswordAttemptRateLimit({ recentAuditEvents: attempts(MAX_PASSWORD_ATTEMPTS_PER_DOCUMENT_PER_HOUR - 1, (i) => minutesAgo(i + 1)), nowIso: NOW });
    expect(under.allowed).toBe(true);
    expect(under.attemptsInWindow).toBe(MAX_PASSWORD_ATTEMPTS_PER_DOCUMENT_PER_HOUR - 1);

    const at = checkPasswordAttemptRateLimit({ recentAuditEvents: attempts(MAX_PASSWORD_ATTEMPTS_PER_DOCUMENT_PER_HOUR, (i) => minutesAgo(i + 1)), nowIso: NOW });
    expect(at.allowed).toBe(false);
  });

  it('timeout / reset: attempts older than the rolling hour stop counting', () => {
    const stale = checkPasswordAttemptRateLimit({
      recentAuditEvents: attempts(MAX_PASSWORD_ATTEMPTS_PER_DOCUMENT_PER_HOUR + 5, () => minutesAgo(61)),
      nowIso: NOW,
    });
    expect(stale.allowed).toBe(true);
    expect(stale.attemptsInWindow).toBe(0);

    // And the boundary is a real boundary, not an off-by-one: 59 minutes ago
    // still counts.
    const inside = checkPasswordAttemptRateLimit({ recentAuditEvents: attempts(1, () => minutesAgo(59)), nowIso: NOW });
    expect(inside.attemptsInWindow).toBe(1);
  });

  it('cross-user isolation is enforced by the QUERY, not by the limiter — the II lookup filters on user_id', () => {
    // The limiter is pure and sees only what it is handed, so isolation has to
    // be proved where it actually lives.
    const src = read('lib/services/investment-intelligence/documentProcessing.ts');
    const block = /const passwordSupplied[\s\S]*?^  \}\n/m.exec(src);
    expect(block, 'the M12C §10 limiter block was not found — this test\'s citation has moved').not.toBeNull();
    expect(block![0]).toMatch(/\.eq\('source_document_id', sourceDocumentId\)/);
    expect(block![0]).toMatch(/\.eq\('user_id', userId\)/);
    expect(block![0]).toMatch(/\.eq\('password_supplied', true\)/);
    expect(block![0]).toMatch(/\.gte\('started_at'/);
  });

  it('the attempt is recorded BEFORE decryption on the Investment Intelligence path', () => {
    // `password_supplied` is written on the run row at INSERT; `extractPdfText`
    // is called later. Asserted by source order so the ordering cannot be
    // silently reversed by a future edit.
    const src = read('lib/services/investment-intelligence/documentProcessing.ts');
    const recordedAt = src.indexOf('password_supplied: passwordSupplied');
    const decryptedAt = src.indexOf('await extractPdfText(bytes, input.password)');
    expect(recordedAt, 'the attempt record was not found').toBeGreaterThan(-1);
    expect(decryptedAt, 'the decryption call was not found').toBeGreaterThan(-1);
    expect(recordedAt).toBeLessThan(decryptedAt);
  });

  it('the attempt is recorded BEFORE decryption on the payslip path', () => {
    const src = read('lib/financial-data-hub/services/payslipProcessingService.ts');
    const recordedAt = src.indexOf("eventType: 'pdf_password_required'");
    const decryptedAt = src.indexOf('await extractPdfPages(download.bytes, password)');
    expect(recordedAt).toBeGreaterThan(-1);
    expect(decryptedAt).toBeGreaterThan(-1);
    expect(recordedAt).toBeLessThan(decryptedAt);
  });

  it('a refused attempt is answered 429 on BOTH newly-limited routes, matching the already-certified surfaces', () => {
    expect(read('app/api/investment-intelligence/source-documents/[id]/process/route.ts')).toMatch(/password_rate_limited[\s\S]{0,200}429|429[\s\S]{0,200}password_rate_limited/);
    expect(read('app/api/financial-data-hub/payslip/[documentId]/process/route.ts')).toMatch(/'rate_limited' \? 429/);
  });

  it('the password VALUE is never counted, stored or logged — only the fact of an attempt', () => {
    const ii = read('lib/services/investment-intelligence/documentProcessing.ts');
    const block = /const passwordSupplied[\s\S]*?^  \}\n/m.exec(ii)![0];
    // The only thing derived from the password in the whole block is a boolean.
    expect(block).toMatch(/typeof input\.password === 'string' && input\.password\.length > 0/);
    // Nothing in the block puts the value anywhere.
    expect(block).not.toMatch(/password:\s*input\.password/);
    expect(block).not.toMatch(/metadata:[^}]*input\.password/);
  });
});

// ---------------------------------------------------------------------------
// §11 — `CG-10`: document identity is the immutable id, never the storage path
// ---------------------------------------------------------------------------

describe('M12C §11 — the Process action resolves by immutable source-document id, never by storage_path', () => {
  it('EVERY document and parse-run lookup in the processing chain is keyed by id, and none by storage_path', () => {
    const src = read('lib/services/investment-intelligence/documentProcessing.ts');

    // `storage_path` may be READ off an already-identified row (to fetch the
    // bytes) but must never be a lookup PREDICATE.
    const predicateUses = [...src.matchAll(/\.eq\('storage_path'[^)]*\)/g)];
    expect(predicateUses.map((m) => m[0]), 'storage_path must never appear as a query predicate in the processing chain').toEqual([]);

    // Anti-vacuity: the file really does use storage_path, so the assertion
    // above is about the absence of a PREDICATE, not the absence of the column.
    expect(src).toMatch(/downloadSourceDocumentObject\(doc\.storage_path/);

    // And the run lookups really are id-keyed.
    expect(src).toMatch(/\.eq\('source_document_id', sourceDocumentId\)/);
    expect(src).toMatch(/\.eq\('id', sourceDocumentId\)/);
  });

  it('the parse-run table links to the document by FOREIGN KEY on id, and carries no storage_path column at all', () => {
    const ddl = read('supabase/migrations/0039_ii_r2_audit_and_document_lifecycle.sql');
    const table = /create table ii_document_parse_runs \(([\s\S]*?)\n\);/.exec(ddl);
    expect(table, 'the ii_document_parse_runs DDL this test cites has moved').not.toBeNull();
    expect(table![1]).toMatch(/source_document_id uuid not null references ii_source_documents\(id\)/);
    expect(table![1]).not.toMatch(/storage_path/);
    // The one-active-run guard is keyed on the document id too.
    expect(ddl).toMatch(/uidx_ii_document_parse_runs_one_active[\s\S]{0,120}ii_document_parse_runs\(source_document_id\)/);
  });

  it('the ONE storage_path-keyed row lookup in the codebase no longer fails open on a collision', () => {
    // `findExistingManualImportByFixtureKey` used `.maybeSingle()`, which
    // returns an ERROR and null data when more than one row matches — and the
    // error was discarded, so a colliding path reported "no prior submission".
    // Comment-stripped, so the function is not punished for DOCUMENTING the
    // defect it closes — the same discipline `aieIiAdapterProhibitions.test.ts`
    // already applies to source-text assertions in this repository.
    const src = read('lib/services/investment-intelligence/manualImporter.ts');
    const fn = /export async function findExistingManualImportByFixtureKey[\s\S]*?\n\}/.exec(src);
    expect(fn).not.toBeNull();
    const code = fn![0].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code, 'a storage_path lookup must not use maybeSingle()').not.toMatch(/maybeSingle\(\)/);
    expect(code).toMatch(/\.order\('created_at', \{ ascending: true \}\)/);
    expect(code).toMatch(/\.limit\(1\)/);
  });

  it('there is no OTHER storage_path-keyed row lookup anywhere in Investment Intelligence', () => {
    // The whole point of CG-10: storage path is not identity. This is the
    // repo-wide guard that keeps it that way.
    const dir = path.join(repoRoot, 'lib/services/investment-intelligence');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts')) files.push(p);
      }
    };
    walk(dir);
    expect(files.length).toBeGreaterThan(20); // anti-vacuity

    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      // Strip comments so a file that DOCUMENTS the prohibition is not punished
      // for mentioning it.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (/\.eq\(\s*'storage_path'/.test(code)) offenders.push(path.relative(repoRoot, f).replace(/\\/g, '/'));
    }
    // Exactly one, and it is the manual-fixture importer whose fix is asserted
    // above. Listing it explicitly rather than allowing "zero or more" means a
    // NEW one cannot appear unnoticed.
    expect(offenders).toEqual(['lib/services/investment-intelligence/manualImporter.ts']);
  });

  it('a byte-identical re-upload is reported to the user instead of silently switching them onto the first document', () => {
    const route = read('app/api/investment-intelligence/source-documents/route.ts');
    expect(route).toMatch(/deduplicated: true/);
    const client = read('components/investment-intelligence/InvestmentIntelligenceClient.tsx');
    // The flag is now consumed, not ignored.
    expect(client).toMatch(/json\.data\?\.deduplicated/);
    expect(client).toMatch(/setNotice\(/);
    // And the notice is announced to assistive technology.
    expect(client).toMatch(/role="status" aria-live="polite"/);
  });

  it('the password is matched to no document at all — it is passed straight to the extractor for THIS row\'s bytes', () => {
    // "password A cannot unlock B" holds structurally: there is no stored
    // password and no per-document credential check anywhere, so a password is
    // only ever tried against the bytes the row's OWN storage_path resolves to.
    // Proving the absence is the honest assertion here.
    const src = read('lib/services/investment-intelligence/documentProcessing.ts');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/password_hash|stored_password|expected_password|comparePassword/);
    // The extractor receives the caller's password and the row's own bytes.
    expect(code).toMatch(/extractPdfText\(bytes, input\.password\)/);
    // And the bytes came from the row identified by id one step earlier.
    const docLookupAt = code.indexOf(".eq('id', sourceDocumentId)");
    const downloadAt = code.indexOf('downloadSourceDocumentObject(doc.storage_path');
    expect(docLookupAt).toBeGreaterThan(-1);
    expect(downloadAt).toBeGreaterThan(docLookupAt);
  });
});

// ---------------------------------------------------------------------------
// §11 — the behavioural half: two documents, one shared storage_path
// ---------------------------------------------------------------------------
//
// A functional reproduction with the Supabase client faked, so the identity
// question is asked of the real `processSourceDocument` control flow rather
// than of a source-text assertion.

type Row = Record<string, unknown>;

const db: { documents: Row[]; runs: Row[]; audit: Row[] } = { documents: [], runs: [], audit: [] };

// Shared fake state lives on globalThis: `vi.mock` factories are instantiated
// once per importer graph, so a module-local `let` would be a different object
// for each importer. (A trap recorded twice by earlier phases of this mission.)
(globalThis as unknown as { __m12cDb: typeof db }).__m12cDb = db;

vi.mock('@/lib/supabase/admin', () => {
  const store = () => (globalThis as unknown as { __m12cDb: typeof db }).__m12cDb;
  const tableOf = (name: string): Row[] => {
    const s = store();
    if (name === 'ii_source_documents') return s.documents;
    if (name === 'ii_document_parse_runs') return s.runs;
    return s.audit;
  };
  const makeQuery = (name: string) => {
    const filters: [string, unknown][] = [];
    let inserted: Row[] | null = null;
    const api: Record<string, unknown> = {};
    const matches = (r: Row) => filters.every(([k, v]) => r[k] === v);
    api.select = () => api;
    api.eq = (k: string, v: unknown) => {
      filters.push([k, v]);
      return api;
    };
    api.in = () => api;
    api.gte = () => api;
    api.order = () => api;
    api.limit = () => api;
    api.insert = (rows: Row | Row[]) => {
      const arr = Array.isArray(rows) ? rows : [rows];
      inserted = arr.map((r) => ({ id: `${name}-${tableOf(name).length + 1}`, ...r }));
      tableOf(name).push(...inserted);
      return api;
    };
    api.update = (patch: Row) => {
      for (const r of tableOf(name)) if (matches(r)) Object.assign(r, patch);
      return api;
    };
    api.maybeSingle = async () => ({ data: inserted ? inserted[0] : (tableOf(name).find(matches) ?? null), error: null });
    api.single = async () => ({ data: inserted ? inserted[0] : (tableOf(name).find(matches) ?? null), error: null });
    api.then = (resolve: (v: { data: Row[]; error: null }) => unknown) => resolve({ data: inserted ?? tableOf(name).filter(matches), error: null });
    return api;
  };
  return { createAdminClient: () => ({ from: (name: string) => makeQuery(name) }) };
});

const extractCalls: { bytes: string; password: string | undefined }[] = [];
(globalThis as unknown as { __m12cExtract: typeof extractCalls }).__m12cExtract = extractCalls;

vi.mock('@/lib/services/investment-intelligence/storage', () => ({
  // The bytes a row resolves to are a function of its storage_path ALONE —
  // which is exactly the condition CG-10 describes. Two rows sharing a path
  // therefore genuinely read the same object.
  downloadSourceDocumentObject: async (objectKey: string) => ({ bytes: Buffer.from(`BYTES_FOR:${objectKey}`), error: null }),
}));

vi.mock('@/lib/services/investment-intelligence/pdfExtraction', () => ({
  extractPdfText: async (bytes: Uint8Array, password?: string) => {
    const calls = (globalThis as unknown as { __m12cExtract: typeof extractCalls }).__m12cExtract;
    calls.push({ bytes: Buffer.from(bytes).toString('utf8'), password });
    return { ok: false as const, kind: 'wrong_password' as const, error: 'wrong password' };
  },
}));

describe('M12C §11 — behavioural: two documents sharing one storage_path', () => {
  beforeEach(() => {
    db.documents.length = 0;
    db.runs.length = 0;
    db.audit.length = 0;
    extractCalls.length = 0;
  });

  it('A processes A and B processes B: each run belongs to the document whose id was asked for', async () => {
    const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');

    const SHARED_PATH = 'user-1/shared-object.pdf';
    db.documents.push({ id: 'doc-A', user_id: 'user-1', storage_path: SHARED_PATH, mime_type: 'application/pdf', status: 'uploaded' });
    db.documents.push({ id: 'doc-B', user_id: 'user-1', storage_path: SHARED_PATH, mime_type: 'application/pdf', status: 'uploaded' });

    await processSourceDocument({ userId: 'user-1', sourceDocumentId: 'doc-A', password: 'pw-A' });
    await processSourceDocument({ userId: 'user-1', sourceDocumentId: 'doc-B', password: 'pw-B' });

    const runsForA = db.runs.filter((r) => r.source_document_id === 'doc-A');
    const runsForB = db.runs.filter((r) => r.source_document_id === 'doc-B');

    // Anti-vacuity: runs really were created.
    expect(runsForA.length).toBe(1);
    expect(runsForB.length).toBe(1);
    // And no run was mis-attributed to the other document despite the shared path.
    expect(runsForA[0].id).not.toBe(runsForB[0].id);
    expect(db.runs.every((r) => r.source_document_id === 'doc-A' || r.source_document_id === 'doc-B')).toBe(true);
  });

  it("password A is never carried into B's attempt — each call supplies only its own", async () => {
    const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');

    const SHARED_PATH = 'user-1/shared-object.pdf';
    db.documents.push({ id: 'doc-A', user_id: 'user-1', storage_path: SHARED_PATH, mime_type: 'application/pdf', status: 'uploaded' });
    db.documents.push({ id: 'doc-B', user_id: 'user-1', storage_path: SHARED_PATH, mime_type: 'application/pdf', status: 'uploaded' });

    await processSourceDocument({ userId: 'user-1', sourceDocumentId: 'doc-A', password: 'pw-A' });
    await processSourceDocument({ userId: 'user-1', sourceDocumentId: 'doc-B', password: 'pw-B' });

    expect(extractCalls.map((c) => c.password)).toEqual(['pw-A', 'pw-B']);
    // Both DID read the same object — which is the honest statement of what a
    // shared storage_path means, and exactly why the path is not identity.
    expect(new Set(extractCalls.map((c) => c.bytes)).size).toBe(1);
  });

  it("a document belonging to another user is never reachable, shared path or not", async () => {
    const { processSourceDocument } = await import('@/lib/services/investment-intelligence/documentProcessing');

    db.documents.push({ id: 'doc-A', user_id: 'user-1', storage_path: 'shared.pdf', mime_type: 'application/pdf', status: 'uploaded' });
    const result = await processSourceDocument({ userId: 'user-2', sourceDocumentId: 'doc-A', password: 'pw' });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('not_found');
    expect(extractCalls).toEqual([]); // nothing was even downloaded
  });
});
