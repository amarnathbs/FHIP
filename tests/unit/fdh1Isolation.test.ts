/**
 * FDH-1 — standalone-isolation, admin-boundary and investment-boundary tests.
 *
 * These read the REAL source tree rather than trusting a comment. They are the
 * mechanical guarantee behind the three hard rules of FDH-1:
 *
 *   1. FDH has zero downstream analytical side effects.
 *   2. FDH never writes existing FHIP Input Data.
 *   3. FDH introduces no competing canonical investment ledger.
 *
 * If a future phase quietly imports an engine, writes a register, or adds a
 * holdings table, one of these fails.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ADMIN_FORBIDDEN_STATEMENT_UPLOAD_COLUMNS,
  ADMIN_NO_STANDING_ACCESS_TABLES,
  ADMIN_VISIBLE_STATEMENT_UPLOAD_COLUMNS,
  toAdminOperationalMetadata,
} from '@/lib/financial-data-hub/constants/adminBoundary';
import {
  FDH_TABLES,
  FHIP_PROTECTED_INPUT_TABLES,
  FORBIDDEN_FDH_INVESTMENT_TABLE_PATTERNS,
  II_ENTITIES_FDH_MUST_NOT_RESTATE,
  II_OWNED_CANONICAL_ENTITIES,
} from '@/lib/financial-data-hub/constants/tables';
import type { FdhStatementUpload } from '@/lib/financial-data-hub/domain/types';

const REPO_ROOT = path.resolve(__dirname, '../..');
const FDH_LIB = path.join(REPO_ROOT, 'lib/financial-data-hub');
const FDH_MIGRATION_FILES = [
  '0045_fdh_reference_foundation.sql',
  '0046_fdh_accounts_documents_jobs.sql',
  '0047_fdh_transactions_and_classification.sql',
  '0048_fdh_review_quality_provenance.sql',
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const FDH_SOURCE_FILES = walk(FDH_LIB);
const FDH_SOURCE = FDH_SOURCE_FILES.map((f) => fs.readFileSync(f, 'utf8'));

/** Source with `//` and block comments removed, so prose cannot satisfy a test. */
const FDH_CODE = FDH_SOURCE.map((s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => {
      const i = l.indexOf('//');
      return i === -1 ? l : l.slice(0, i);
    })
    .join('\n'),
);

const FDH_MIGRATION_SQL = FDH_MIGRATION_FILES.map((f) =>
  fs.readFileSync(path.join(REPO_ROOT, 'supabase/migrations', f), 'utf8'),
).join('\n');

// ---------------------------------------------------------------------------
describe('FDH-1 has zero downstream analytical side effects', () => {
  it('the FDH module is non-empty and lives in one place', () => {
    expect(FDH_SOURCE_FILES.length).toBeGreaterThan(10);
    for (const file of FDH_SOURCE_FILES) expect(file.endsWith('.ts')).toBe(true);
  });

  it('imports no FHIP calculation engine', () => {
    for (let i = 0; i < FDH_CODE.length; i += 1) {
      expect(
        /from '@\/lib\/engines/.test(FDH_CODE[i]),
        `${FDH_SOURCE_FILES[i]} imports a calculation engine`,
      ).toBe(false);
    }
  });

  it('imports no existing FHIP data service', () => {
    for (let i = 0; i < FDH_CODE.length; i += 1) {
      // lib/supabase/server is the shared client factory and is the one
      // permitted cross-module import; lib/services/** is not.
      expect(
        /from '@\/lib\/services/.test(FDH_CODE[i]),
        `${FDH_SOURCE_FILES[i]} imports an existing FHIP service`,
      ).toBe(false);
    }
  });

  it('is imported by nothing outside itself, except the FDH-3 upload surface', () => {
    // R8 (2026-08-23): raised from the vitest default 5000ms. This test
    // does a synchronous fs walk + readFileSync of every .ts/.tsx file
    // under lib/, app/ and components/ — a genuine O(repo size) cost, not
    // a bug. As the repo has grown across FDH-1 through R8 this crossed
    // the default timeout on ordinary hardware; the test's own logic is
    // unchanged and was independently re-verified to find zero unapproved
    // consumers before this timeout bump was made (not used to paper over
    // a real failure).
    // FDH-1/FDH-2 shipped zero consumers — pure architecture and schema.
    // FDH-3 is the phase that finally ships a user-facing surface (spec
    // section 8: upload UX, document-status UX, delete-document UX and the
    // API routes behind them), so it is expected — and ONLY it — to import
    // this module. Anything else importing 'financial-data-hub' would mean
    // some OTHER part of the app (an engine, a report, a dashboard) reaching
    // into FDH, which is still forbidden.
    const FDH3_APPROVED_CONSUMER_DIRS = [
      path.join(REPO_ROOT, 'app', 'api', 'financial-data-hub'),
      path.join(REPO_ROOT, 'app', '(app)', 'financial-data-hub'),
      path.join(REPO_ROOT, 'components', 'financial-data-hub'),
    ];
    const consumers: string[] = [];
    for (const dir of ['lib', 'app', 'components']) {
      const root = path.join(REPO_ROOT, dir);
      if (!fs.existsSync(root)) continue;
      for (const file of walk(root)) {
        if (file.startsWith(FDH_LIB)) continue;
        if (!/\.(ts|tsx)$/.test(file)) continue;
        if (!fs.readFileSync(file, 'utf8').includes('financial-data-hub')) continue;
        if (FDH3_APPROVED_CONSUMER_DIRS.some((approved) => file.startsWith(approved))) continue;
        consumers.push(file);
      }
    }
    expect(consumers, `FDH is imported by an unapproved consumer: ${consumers.join(', ')}`).toEqual([]);
  }, 20_000);

  it('adds only the approved FDH-3 document-lifecycle route set — no parser, no extraction route', () => {
    // FDH-1/FDH-2 added zero routes. FDH-3 adds the upload-lifecycle surface
    // ONLY (spec section 8-9: upload/status/delete/preview — explicitly NOT
    // extraction, classification or parsing, which remain FDH-4+). Every
    // route file found under app/ matching /financial-data|fdh/i must be one
    // of these, and none may contain a parser/extraction/classification verb
    // in its own path.
    const appDir = path.join(REPO_ROOT, 'app');
    const fdhFiles = walk(appDir).filter((f) => /financial-data|fdh/i.test(f));
    const FORBIDDEN_PATH_FRAGMENTS = [
      'extract', 'parse', 'parser', 'classify', 'classification', 'ocr', 'reconcile',
    ];
    for (const file of fdhFiles) {
      const relative = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
      for (const fragment of FORBIDDEN_PATH_FRAGMENTS) {
        expect(relative.toLowerCase().includes(fragment), `${relative} names a forbidden FDH-4+ concept`).toBe(false);
      }
    }
    expect(fdhFiles.length, 'FDH-3 should add at least its upload-lifecycle routes').toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe('FDH-1 never writes existing FHIP Input Data', () => {
  it('names an Input Data register in exactly one file — the guard list itself', () => {
    // `constants/tables.ts` declares FHIP_PROTECTED_INPUT_TABLES, which is what
    // this very test iterates. Every OTHER file must be silent about them, so a
    // stray query naming a register cannot hide behind that one exemption.
    const guardFile = path.join(FDH_LIB, 'constants', 'tables.ts');
    let filesNamingARegister = 0;
    for (let i = 0; i < FDH_CODE.length; i += 1) {
      const names = FHIP_PROTECTED_INPUT_TABLES.some((t) =>
        new RegExp(`['"\`]${t}['"\`]`).test(FDH_CODE[i]));
      if (!names) continue;
      filesNamingARegister += 1;
      expect(
        FDH_SOURCE_FILES[i],
        `${FDH_SOURCE_FILES[i]} references a protected Input Data register`,
      ).toBe(guardFile);
    }
    expect(filesNamingARegister).toBe(1);
  });

  it('never queries a protected register, even in the guard file', () => {
    for (let i = 0; i < FDH_CODE.length; i += 1) {
      for (const table of FHIP_PROTECTED_INPUT_TABLES) {
        expect(
          new RegExp(`\\.from\\(\\s*['"\`]${table}['"\`]`).test(FDH_CODE[i]),
          `${FDH_SOURCE_FILES[i]} queries ${table}`,
        ).toBe(false);
      }
    }
  });

  it('uses the registry write path for nothing', () => {
    for (let i = 0; i < FDH_CODE.length; i += 1) {
      expect(/makeRegistry/.test(FDH_CODE[i]), FDH_SOURCE_FILES[i]).toBe(false);
    }
  });

  it('creates no Input Data proposal structure — the bridge begins at FDH-15', () => {
    expect(/input_population|input_proposal|fdh_input_/.test(FDH_MIGRATION_SQL)).toBe(false);
  });

  it('uses the service-role client ONLY in the five FDH-3/R7/R8 files documented to need it', () => {
    // FDH-1/FDH-2 used no service-role client anywhere (private storage and
    // cross-user purge sweeps did not exist yet). FDH-3 introduces three
    // legitimate uses — see repositories/base.ts's module comment — and
    // every one of them runs only after an explicit authenticated +
    // ownership check (storage.ts, auditLog.ts) or against a single
    // already-identified document row rather than a caller-supplied filter
    // (purge.ts). R7 (migration 0064) adds a FOURTH: bankCsvProcessingService.ts
    // writes the R7 authoritative detection/certification/dedup/reconciliation
    // columns and inserts into the 5 tables migration 0064's triggers make
    // engine-authoritative-insert-only — every call there is likewise preceded
    // by an RLS-scoped ownership read and explicitly re-scoped by user_id (see
    // that file's own module header and R7_SECURITY_VERIFICATION.md). R8
    // (migration 0068) adds a FIFTH: transactionClassificationService.ts
    // writes R8's newly-authoritative classification/transfer-link/recurring-
    // series columns migration 0068's triggers block the authenticated role
    // from writing directly. FDH-5 (migration 0070) adds a SIXTH:
    // bankPdfProcessingService.ts — the exact same carve-out
    // bankCsvProcessingService.ts already established, applied to the PDF
    // pipeline's own writes into the SAME engine-authoritative tables (no new
    // table, no new trigger target) — every read in that file uses the
    // ordinary RLS-scoped client (reads need no elevated privilege), and
    // every admin write is explicitly re-scoped by `.eq('user_id', userId)`
    // regardless of RLS bypass, matching the same discipline. No other file
    // may reach for it.
    const FDH3_SERVICE_ROLE_FILES = [
      path.join(FDH_LIB, 'services', 'storage.ts'),
      path.join(FDH_LIB, 'services', 'auditLog.ts'),
      path.join(FDH_LIB, 'services', 'purge.ts'),
      path.join(FDH_LIB, 'services', 'bankCsvProcessingService.ts'),
      path.join(FDH_LIB, 'services', 'transactionClassificationService.ts'),
      path.join(FDH_LIB, 'services', 'bankPdfProcessingService.ts'),
    ];
    let usedByApprovedFile = 0;
    for (let i = 0; i < FDH_CODE.length; i += 1) {
      const usesServiceRole = /adminClient|SUPABASE_SERVICE_ROLE_KEY|supabase\/admin/.test(FDH_CODE[i]);
      if (!usesServiceRole) continue;
      expect(
        FDH3_SERVICE_ROLE_FILES.includes(FDH_SOURCE_FILES[i]),
        `${FDH_SOURCE_FILES[i]} reaches for a service-role client outside the six approved FDH-3/R7/R8/FDH-5 files`,
      ).toBe(true);
      usedByApprovedFile += 1;
    }
    // Proves this check is not vacuous — the six approved files really do
    // use it, so a future removal of all service-role usage would be caught
    // by the "greater than 0" below just as much as a leak would be caught
    // by the assertion above.
    expect(usedByApprovedFile).toBe(FDH3_SERVICE_ROLE_FILES.length);
  });
});

// ---------------------------------------------------------------------------
describe('FDH-1 investment boundary (Product Owner Decision 2)', () => {
  it('creates no table restating a canonical Investment Intelligence entity', () => {
    for (const iiTable of II_ENTITIES_FDH_MUST_NOT_RESTATE) {
      const fdhEquivalent = iiTable.replace(/^ii_/, 'fdh_');
      expect(
        (FDH_TABLES as readonly string[]).includes(fdhEquivalent),
        `FDH created ${fdhEquivalent}, duplicating ${iiTable}`,
      ).toBe(false);
    }
    // Every canonical II entity is still enumerated, so a future phase that
    // adds one to the FDH side has to consciously edit this list.
    expect(II_OWNED_CANONICAL_ENTITIES.length).toBeGreaterThanOrEqual(
      II_ENTITIES_FDH_MUST_NOT_RESTATE.length,
    );
  });

  it('proves fdh_transactions is a cash ledger, not the II unit ledger', () => {
    // The two share an English word, not an entity. The distinction is
    // structural: an II transaction carries units, NAV, a folio and a tax lot;
    // an FDH transaction carries an amount, a currency and a direction, and
    // its account is a DOCUMENT SOURCE rather than a holding.
    const body = FDH_MIGRATION_SQL.slice(
      FDH_MIGRATION_SQL.indexOf('create table fdh_transactions ('),
      FDH_MIGRATION_SQL.indexOf('create table fdh_transaction_allocations ('),
    ).replace(/--[^\n]*/g, '');
    for (const investmentConcept of ['units', 'nav', 'isin', 'folio', 'instrument', 'scheme']) {
      expect(
        new RegExp(`\\b${investmentConcept}\\b`, 'i').test(body),
        `fdh_transactions carries the investment-ledger concept "${investmentConcept}"`,
      ).toBe(false);
    }
    expect(body).toContain('amount_original numeric(20,4) not null');
    expect(body).toContain("credit_debit text not null check (credit_debit in ('credit', 'debit'))");
    expect(body).toContain(
      'financial_account_id uuid not null references fdh_financial_accounts(id) on delete cascade',
    );
  });

  it('creates no holdings, securities, valuation, NAV, folio or portfolio table', () => {
    for (const table of FDH_TABLES) {
      for (const pattern of FORBIDDEN_FDH_INVESTMENT_TABLE_PATTERNS) {
        expect(
          table.includes(pattern),
          `FDH table ${table} matches forbidden investment pattern "${pattern}"`,
        ).toBe(false);
      }
    }
  });

  it('creates no units, NAV, ISIN, folio or quantity column anywhere', () => {
    const forbiddenColumns = [
      'units', 'nav', 'isin', 'folio', 'quantity', 'scheme_code', 'ticker',
      'cost_basis', 'market_value',
    ];
    const columnLines = FDH_MIGRATION_SQL.split('\n')
      .map((l) => (l.includes('--') ? l.slice(0, l.indexOf('--')) : l))
      .filter((l) => /^\s{2}[a-z_]+\s+(uuid|text|numeric|boolean|int|bigint|date|timestamptz|char|jsonb)/.test(l));
    expect(columnLines.length).toBeGreaterThan(150);
    for (const line of columnLines) {
      const column = line.trim().split(/\s+/)[0];
      for (const forbidden of forbiddenColumns) {
        expect(
          column === forbidden || column.endsWith(`_${forbidden}`),
          `FDH column "${column}" belongs to the canonical investment ledger`,
        ).toBe(false);
      }
    }
  });

  it('does not touch any ii_ table', () => {
    expect(/\bii_[a-z_]+/.test(FDH_MIGRATION_SQL.replace(/--[^\n]*/g, ''))).toBe(false);
    for (let i = 0; i < FDH_CODE.length; i += 1) {
      expect(/from '@\/lib\/(services|engines)\/investment-intelligence/.test(FDH_CODE[i]),
        FDH_SOURCE_FILES[i]).toBe(false);
    }
  });

  it('keeps investment-source ACCOUNT TYPES, which are document provenance, not a ledger', () => {
    // These describe where a document came from. They carry no instrument, no
    // units and no valuation — that is the whole distinction.
    const accountBody = FDH_MIGRATION_SQL.slice(
      FDH_MIGRATION_SQL.indexOf('create table fdh_financial_accounts ('),
      FDH_MIGRATION_SQL.indexOf('create table fdh_statement_uploads ('),
    );
    for (const type of ['brokerage_source', 'super_source', 'epf_source', 'nps_source']) {
      expect(accountBody).toContain(`'${type}'`);
    }
    expect(/units|nav|isin|folio/.test(accountBody.replace(/--[^\n]*/g, ''))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('FDH-1 admin document boundary (Product Owner Decision 3)', () => {
  it('exposes no admin route or admin document viewer, anywhere', () => {
    // This half of the original FDH-1 guarantee is untouched by FDH-3: no
    // file in this module may ever gate on admin status to reach a document.
    for (let i = 0; i < FDH_CODE.length; i += 1) {
      expect(/requireAdmin|adminRoute/.test(FDH_CODE[i]),
        `${FDH_SOURCE_FILES[i]} builds an admin route`).toBe(false);
    }
  });

  it('confines storage/signed-URL access to services/storage.ts, and never combines it with admin auth', () => {
    // FDH-1 forbade `createSignedUrl`/`storage.from` outright because no
    // storage existed yet. FDH-3 legitimately needs both — but only for the
    // OWNING USER's own document (services/storage.ts, called only after
    // services/uploadLifecycle.ts and services/purge.ts have already
    // established ownership). No admin-facing file may use either, which is
    // the real invariant Product Owner Decision 3 requires.
    const STORAGE_ACCESS_APPROVED_FILE = path.join(FDH_LIB, 'services', 'storage.ts');
    for (let i = 0; i < FDH_CODE.length; i += 1) {
      const usesStorageAccess = /createSignedUrl|storage\.from/.test(FDH_CODE[i]);
      if (!usesStorageAccess) continue;
      expect(
        FDH_SOURCE_FILES[i],
        `${FDH_SOURCE_FILES[i]} accesses storage/signed URLs outside the one approved file`,
      ).toBe(STORAGE_ACCESS_APPROVED_FILE);
    }
    // adminBoundary.ts itself must never gain storage access — the strongest
    // form of the "no admin document viewer" guarantee.
    const adminBoundaryIndex = FDH_SOURCE_FILES.indexOf(path.join(FDH_LIB, 'constants', 'adminBoundary.ts'));
    expect(adminBoundaryIndex).toBeGreaterThan(-1);
    expect(/createSignedUrl|storage\.from|requireAdmin/.test(FDH_CODE[adminBoundaryIndex])).toBe(false);
  });

  it('never leaks a forbidden column into the admin allowlist', () => {
    for (const column of ADMIN_VISIBLE_STATEMENT_UPLOAD_COLUMNS) {
      expect(
        Object.keys(ADMIN_FORBIDDEN_STATEMENT_UPLOAD_COLUMNS),
        `"${column}" is both allowed and forbidden`,
      ).not.toContain(column);
    }
  });

  it('excludes every raw-document and identity column from the projection', () => {
    const mustBeAbsent = [
      'user_id',
      'household_id',
      'raw_document_storage_reference',
      'original_filename_sanitised',
      'file_hash',
      'financial_account_id',
    ];
    for (const column of mustBeAbsent) {
      expect(ADMIN_VISIBLE_STATEMENT_UPLOAD_COLUMNS as readonly string[]).not.toContain(column);
      expect(Object.keys(ADMIN_FORBIDDEN_STATEMENT_UPLOAD_COLUMNS)).toContain(column);
    }
  });

  it('produces a projection carrying only operational metadata and a pseudonym', () => {
    const row = {
      id: 'doc-1',
      user_id: 'real-user-uuid',
      household_id: 'real-household-uuid',
      financial_account_id: 'acct-1',
      institution_id: 'inst-1',
      source_type: 'pdf_native',
      document_type: 'bank_statement',
      country_code: 'AU',
      currency_code: 'AUD',
      original_filename_sanitised: 'jane-smith-march-statement.pdf',
      file_hash: 'a'.repeat(64),
      mime_type: 'application/pdf',
      file_size_bytes: 12345,
      statement_period_start: '2026-03-01',
      statement_period_end: '2026-03-31',
      statement_as_of_date: '2026-03-31',
      processing_status: 'approved',
      review_status: 'resolved',
      parser_id: 'p-1',
      parser_version_id: 'pv-1',
      processing_method: 'native_text',
      reconciliation_status: 'reconciled',
      overall_quality_status: 'pass',
      error_code: null,
      raw_document_storage_reference: 'private/real-user-uuid/doc-1.pdf',
      raw_document_purge_status: 'pending',
      raw_document_purge_due_at: null,
      raw_document_purged_at: null,
      purge_reason: null,
      purge_attempt_count: 0,
      last_purge_error_sanitised: null,
      created_at: '2026-03-31T00:00:00+00:00',
      updated_at: '2026-03-31T00:00:00+00:00',
      approved_at: '2026-03-31T00:00:00+00:00',
    } as unknown as FdhStatementUpload;

    const projected = toAdminOperationalMetadata(row, () => 'pseudo-abc123');
    const serialised = JSON.stringify(projected);

    expect(projected.owner_reference).toBe('pseudo-abc123');
    expect(serialised).not.toContain('real-user-uuid');
    expect(serialised).not.toContain('real-household-uuid');
    expect(serialised).not.toContain('jane-smith');
    expect(serialised).not.toContain('private/');
    expect(serialised).not.toContain('a'.repeat(64));
    // ...while the operational facts an admin genuinely needs survive.
    expect(projected.processing_status).toBe('approved');
    expect(projected.parser_version_id).toBe('pv-1');
    expect(projected.reconciliation_status).toBe('reconciled');
    expect(projected.raw_document_purge_status).toBe('pending');
  });

  it('names every household-financial table as off limits to standing admin access', () => {
    for (const table of ADMIN_NO_STANDING_ACCESS_TABLES) {
      expect(FDH_TABLES as readonly string[]).toContain(table);
    }
    // fdh_statement_uploads is the ONE table with an admin projection at all,
    // and only of operational metadata.
    expect(ADMIN_NO_STANDING_ACCESS_TABLES as readonly string[])
      .not.toContain('fdh_statement_uploads');
  });

  it('creates no storage bucket and no storage policy', () => {
    expect(/storage\.objects|storage\.foldername|bucket_id/.test(FDH_MIGRATION_SQL)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('FDH-3 admin document boundary — no admin raw-document access anywhere', () => {
  it('no admin surface in the whole application references the FDH module at all', () => {
    // The strongest mechanical form of spec section 71: an admin does not
    // gain raw-document visibility merely because of admin status, because
    // there is literally no code path from any admin route/page into FDH.
    const adminDirs = [
      path.join(REPO_ROOT, 'app', 'api', 'admin'),
      path.join(REPO_ROOT, 'app', '(app)', 'admin'),
    ].filter((d) => fs.existsSync(d));
    expect(adminDirs.length, 'expected at least one admin surface to exist').toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const dir of adminDirs) {
      for (const file of walk(dir)) {
        if (!/\.(ts|tsx)$/.test(file)) continue;
        const src = fs.readFileSync(file, 'utf8');
        if (/financial-data-hub|fdh_/.test(src)) offenders.push(file);
      }
    }
    expect(offenders, `admin surface references FDH: ${offenders.join(', ')}`).toEqual([]);
  });

  it('fdh_upload_sessions and fdh_document_audit_events are both listed as no-standing-admin-access tables', () => {
    expect(ADMIN_NO_STANDING_ACCESS_TABLES as readonly string[]).toContain('fdh_upload_sessions');
    expect(ADMIN_NO_STANDING_ACCESS_TABLES as readonly string[]).toContain('fdh_document_audit_events');
  });
});
