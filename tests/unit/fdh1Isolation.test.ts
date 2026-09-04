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
    // FDH-8 closure (2026-08-25): AppShell.tsx's global nav gained ONE line
    // — `{ type: 'link', label: 'Financial Activity', href:
    // '/financial-data-hub/activity' }` — a plain route-string label, not a
    // TypeScript `import`/`require` of any FDH module code. This test's
    // detector is a naive substring search (`includes('financial-data-hub')`)
    // rather than an actual import-graph walk, so it cannot distinguish "a
    // dashboard imported FDH's engine" (the real thing this test guards
    // against, still forbidden) from "the app shell's nav links to an FDH
    // route by URL string" (unavoidable for ANY module with its own nav
    // entry, and not a violation of FDH's analytical-isolation guarantee —
    // AppShell contains zero `from '@/lib/financial-data-hub...'` imports,
    // verified by hand at the time this exception was added). Approved as
    // exactly one file, not a directory, so any future file that starts
    // importing real FDH code would still be caught.
    // FDH-9 hardening pass (2026-08-26): incomeAdapter.ts and
    // lib/import-bridge/types.ts both trip the same naive-substring
    // limitation the FDH-8 exception above already documents. Neither
    // file has any `from '@/lib/financial-data-hub...'` import — verified
    // by hand at the time this exception was added, same standard as the
    // AppShell.tsx precedent — the literal text 'financial-data-hub'
    // appears only in prose comments explaining why they deliberately do
    // NOT import from there (incomeAdapter.ts: "Deliberately a PLAIN SHAPE
    // rather than an import from `lib/financial-data-hub/payslip/types`");
    // types.ts's own header explains the same split. Approved as exactly
    // these two files, not a directory, so a future file that starts
    // genuinely importing FDH code would still be caught.
    //
    // FDH-9 live-DEV-cert + Income-tab pass (2026-08-26): two more files trip
    // the identical naive-substring limitation, for the identical reason —
    // verified by hand, same standard as above:
    //   - lib/import-bridge/incomeProposalService.ts has no
    //     `from '@/lib/financial-data-hub...'` import (it duplicates the one
    //     six-line function it would otherwise have needed from
    //     `payslip/frequency.ts` — see its own `canonicalIncomeFrequencyFor`
    //     comment — and leaves the one FDH document-audit-event write to its
    //     API-route caller instead of importing `auditLog.ts` itself); the
    //     substring appears only in prose explaining exactly that.
    //   - components/income/PayslipImportPanel.tsx is the Income-tab payslip
    //     UI (spec section 3: FDH-9 is not a new top-level destination, it
    //     lives behind Income). It never imports anything from
    //     `lib/financial-data-hub`; every reference is a `fetch()` call to a
    //     public `/api/financial-data-hub/...` route string — the same
    //     relationship any external HTTP client has to that API, not a
    //     module import of FDH's internals. Approved as exactly these two
    //     files, not a directory.
    const FDH_APPROVED_CONSUMER_FILES = [
      path.join(REPO_ROOT, 'components', 'ui', 'AppShell.tsx'),
      path.join(REPO_ROOT, 'lib', 'import-bridge', 'adapters', 'incomeAdapter.ts'),
      path.join(REPO_ROOT, 'lib', 'import-bridge', 'types.ts'),
      path.join(REPO_ROOT, 'lib', 'import-bridge', 'incomeProposalService.ts'),
      path.join(REPO_ROOT, 'components', 'income', 'PayslipImportPanel.tsx'),
      // FDH-10 (2026-08-27): components/liabilities/LiabilityImportPanel.tsx
      // trips the identical naive-substring limitation, for the identical
      // reason as PayslipImportPanel.tsx above — verified by hand, same
      // standard: it is the Liabilities-tab statement-import UI (spec
      // section 2: FDH-10 is not a new top-level destination, it lives
      // behind Liabilities). It never imports anything from
      // `lib/financial-data-hub`; every reference is a `fetch()` call to a
      // public `/api/financial-data-hub/...` route string.
      path.join(REPO_ROOT, 'components', 'liabilities', 'LiabilityImportPanel.tsx'),
      // FDH-11 (2026-08-29): components/investments/AuInvestmentStatementImportPanel.tsx
      // trips the identical naive-substring limitation, for the identical
      // reason as PayslipImportPanel.tsx/LiabilityImportPanel.tsx above —
      // verified by hand, same standard: it is the Investments-tab
      // statement-import UI (spec section 76: FDH-11 is not a new
      // top-level destination, it lives behind Investments). It never
      // imports anything from `lib/financial-data-hub`; every reference is
      // a `fetch()` call to a public `/api/financial-data-hub/...` route
      // string.
      path.join(REPO_ROOT, 'components', 'investments', 'AuInvestmentStatementImportPanel.tsx'),
      // FDH-11 (2026-08-29): unlike the FDH-9/FDH-10 exceptions above, these
      // four ARE real, intentional imports of FDH module code — not a
      // naive-substring false positive. `lib/investment-import-bridge/` is
      // the deliberate one-way FDH-evidence -> canonical-Investment-
      // Intelligence adapter FDH1_INVESTMENT_BOUNDARY.md section 6 sketched
      // and left for FDH-11 to build (see
      // docs/financial-data-hub/FDH11_INVESTMENT_INTELLIGENCE_BRIDGE.md).
      // It lives OUTSIDE `lib/financial-data-hub/` for the exact reason
      // `lib/import-bridge/` does (this same test's own module-header
      // rationale): it must be able to import Investment Intelligence code,
      // which nothing inside the Hub itself may ever do (see the
      // 'FDH-1 investment boundary' describe block below and
      // `tests/unit/fdh11Isolation.test.ts`). Importing FDH's own PURE
      // matching/evidence types from here is the intended, narrow shape of
      // that bridge — approved as exactly these four files, not a
      // directory, so a future file that starts importing FDH code from
      // anywhere else would still be caught.
      path.join(REPO_ROOT, 'lib', 'investment-import-bridge', 'types.ts'),
      path.join(REPO_ROOT, 'lib', 'investment-import-bridge', 'auAccountResolution.ts'),
      path.join(REPO_ROOT, 'lib', 'investment-import-bridge', 'auSecurityResolution.ts'),
      path.join(REPO_ROOT, 'lib', 'investment-import-bridge', 'applyAuStatementActivity.ts'),
      // FDH-12 (2026-08-30): three more files.
      //
      // The first two trip the identical naive-substring limitation the
      // FDH-9/FDH-10/FDH-11 exceptions above document, for the identical
      // reason — verified by hand, same standard:
      //   - components/retirement/RetirementStatementImportPanel.tsx is the
      //     Retirement-tab statement-import UI (spec section 146: FDH-12 is
      //     not a new top-level destination, it lives behind Retirement). It
      //     imports nothing from `lib/financial-data-hub`; every reference is
      //     a `fetch()` call to a public `/api/financial-data-hub/...` route
      //     string.
      //   - lib/import-bridge/adapters/retirementAdapter.ts follows
      //     incomeAdapter.ts's and liabilityAdapter.ts's precedent exactly:
      //     it deliberately does NOT import the Hub's own matching module and
      //     keeps its own isolation-safe copy, and the literal substring
      //     appears only in the prose explaining that choice.
      path.join(REPO_ROOT, 'components', 'retirement', 'RetirementStatementImportPanel.tsx'),
      path.join(REPO_ROOT, 'lib', 'import-bridge', 'adapters', 'retirementAdapter.ts'),
      // The third IS a real, intentional import of FDH module code — not a
      // naive-substring false positive — and is the exact analogue of the
      // four `lib/investment-import-bridge/` entries above.
      // `lib/retirement-import-bridge/retirementAccountResolution.ts` exists
      // OUTSIDE the Hub precisely BECAUSE of this file's own
      // 'names an Input Data register in exactly one file' rule: matching a
      // statement to a canonical account necessarily READS
      // `retirement_accounts`, which no file under `lib/financial-data-hub/`
      // may ever name. It reads canonical Retirement and writes only FDH-12's
      // own statement row; it performs no canonical mutation, which
      // `tests/unit/fdh12Isolation.test.ts` asserts mechanically.
      path.join(REPO_ROOT, 'lib', 'retirement-import-bridge', 'retirementAccountResolution.ts'),
      // G4 (2026-09-04): two more files trip the identical naive-substring
      // limitation this test's own header already documents, for the
      // identical reason — verified by hand, same standard as the AppShell.tsx
      // and incomeAdapter.ts precedents above:
      //   - lib/nav/appNavCapability.ts's NAV_HREF_MODULE_MAP has one entry,
      //     `'/financial-data-hub/activity': 'FINANCIAL_DATA_HUB'` — a plain
      //     route-string key mapped to a ModuleKey enum value, not a
      //     TypeScript `import`/`require` of any FDH module code (exactly
      //     AppShell.tsx's own precedent, which this map was extracted to
      //     work alongside).
      //   - lib/services/appCapability.ts's APP_CAPABILITY_MANIFEST has one
      //     prose `note` field documenting a G5-deferred defect at
      //     app/api/financial-data-hub/investment-statement/[documentId]/
      //     account-match/route.ts:47 — the literal substring appears only in
      //     that explanatory string, not in any import.
      // Neither file has any `from '@/lib/financial-data-hub...'` import.
      // Approved as exactly these two files, not a directory, so a future
      // file that starts genuinely importing FDH code would still be caught.
      path.join(REPO_ROOT, 'lib', 'nav', 'appNavCapability.ts'),
      path.join(REPO_ROOT, 'lib', 'services', 'appCapability.ts'),
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
        if (FDH_APPROVED_CONSUMER_FILES.includes(file)) continue;
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
    // MATCH ON THE REPO-RELATIVE PATH, NOT THE ABSOLUTE ONE.
    //
    // TEST DEFECT FOUND AND FIXED DURING FDH-12 CERTIFICATION (2026-08-30).
    // This filter previously tested the ABSOLUTE path, so any checkout whose
    // directory name happens to contain "fdh" or "financial-data" — for
    // instance the `fhip-fdh12` worktree this phase was built in, or the
    // `fdh4`-named worktree that produced the same false positive during
    // FDH-4 — made EVERY file under `app/` match, and the loop below then
    // failed on unrelated routes such as
    // `app/api/investment-intelligence/source-documents/[id]/parse/route.ts`.
    //
    // The consequence was worse than a spurious failure: because the filter
    // over-selected, `fdhFiles.length` was satisfied by unrelated files, so
    // the "at least its upload-lifecycle routes" assertion at the end of this
    // test would still have passed even if every real FDH route were deleted.
    // The relative path is what the assertion body already uses, so this
    // makes the filter and the assertion agree.
    const fdhFiles = walk(appDir).filter((f) =>
      /financial-data|fdh/i.test(path.relative(REPO_ROOT, f).replace(/\\/g, '/')));
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

  it('uses the service-role client ONLY in the seven FDH-3/R7/R8/FDH-5/FDH-9 files documented to need it', () => {
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
      // FDH-9 (migration 0091) adds a SEVENTH: payslipProcessingService.ts —
      // the exact same carve-out bankPdfProcessingService.ts already
      // established, applied to the payslip pipeline's own document-lifecycle
      // writes on `fdh_statement_uploads` (no new table, no new trigger
      // target). Every read uses the ordinary RLS-scoped client (including
      // the payroll-evidence insert itself — `fdh_payroll_events`/
      // `fdh_payroll_components` carry ordinary "own row" RLS policies, spec
      // section 10's documented deliberate choice, so no elevated client is
      // needed or used for those two tables); every admin write is explicitly
      // re-scoped by `.eq('user_id', userId)` regardless of RLS bypass,
      // matching the same discipline.
      path.join(FDH_LIB, 'services', 'payslipProcessingService.ts'),
      // FDH-11 (migration 0106) adds an EIGHTH: investmentStatementProcessingService.ts —
      // the exact same carve-out established for every prior *ProcessingService.ts
      // file, applied to `fdh_investment_statements`/`_positions`/`_activities`
      // (no ii_ table, no new trigger target outside FDH-11's own three
      // evidence tables). Every read uses the ordinary RLS-scoped ownership
      // pattern (re-checked via `.eq('user_id', userId)` regardless of
      // bypass); the module never imports Investment Intelligence code
      // (separately enforced by `tests/unit/fdh11Isolation.test.ts`).
      path.join(FDH_LIB, 'services', 'investmentStatementProcessingService.ts'),
      // FDH-12 (migration 0112) adds a NINTH:
      // retirementStatementProcessingService.ts — the same carve-out again,
      // applied to `fdh_retirement_statements`/`_activities`/`_positions`.
      // The service role is what makes migration 0112 PART F's
      // authoritative-write triggers meaningful: those triggers refuse
      // system-owned column writes from the `authenticated` role, so this file
      // is the ONLY thing that can set reconciliation_status,
      // account_match_status, payslip_match_status and the rest. Every read
      // uses the ordinary RLS-scoped client and every admin write is
      // explicitly re-scoped by `.eq('user_id', userId)` regardless of bypass.
      // The module never writes a canonical register — separately enforced by
      // `tests/unit/fdh12Isolation.test.ts`.
      path.join(FDH_LIB, 'services', 'retirementStatementProcessingService.ts'),
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
