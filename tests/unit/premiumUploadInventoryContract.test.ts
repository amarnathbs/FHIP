/**
 * Premium Upload Entitlement -- the standing CI contract (pages 19-20, 40, 150, 216, 221-225).
 *
 * It fails when
 *   (1) a listed customer upload / processing route stops calling the central Premium capability, calls it after
 *       reading the body (admission routes), or ignores its answer;
 *   (2) a NEW customer route that ingests a file appears (multipart / raw bytes / signed credential / storage write /
 *       upload session / intake / fixture importer) without being added to lib/entitlements/financialImportInventory.ts;
 *   (3) an Admin or scheduled-system route starts calling the consumer capability (staff must not need Premium);
 *   (4) a manual-entry route starts depending on the capability (Free manual entry must stay Free);
 *   (5) an inventory entry points at a file that no longer exists;
 *   (6) the capability starts writing billing state or trusting the browser;
 *   (7) the committed documentation matrix drifts from the code;
 *   (8) a signed upload credential, a customer storage write policy, a plan-aware canonical loader, or an unlisted
 *       importer of the capability appears.
 *
 * NEGATIVE CONTROLS (same file): the checker is run against real route sources with the guard stripped, moved after the
 * body read, or its result ignored, and against a synthetic brand-new upload route -- each must be REPORTED. A green
 * contract that could not go red would be worthless.
 *
 * Scans use `git ls-files` / `git grep` (tests/support/repoScan.ts): reading thousands of files through fs takes minutes
 * on a loaded machine, which is why repo-walking tests in this repository are known to time out under parallel load.
 */
import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ADMIN_AND_SYSTEM_EXEMPT_PREFIXES,
  GATED_ROUTES,
  MANUAL_ENTRY_ROUTE_DIRS,
  REVIEW_CONTINUATION_ROUTES,
  inventoryCounts,
} from '@/lib/entitlements/financialImportInventory';
import { renderInventoryMatrixMarkdown } from '@/lib/entitlements/inventoryMatrix';
import {
  checkGatedRouteSource,
  detectIngestionSignals,
  firstBodyReadIndex,
  importsCentralCapability,
  stripComments,
  stripGuard,
} from '@/lib/entitlements/uploadRouteContract';
import { grepFiles, listFiles } from '../support/repoScan';

// Repository scans are I/O bound; on a loaded machine they take far longer than the 5 s default (this repo's known repo-walking-test hazard).
vi.setConfig({ testTimeout: 180_000 });

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const routeFiles = listFiles(['app/api']).filter((p) => p.endsWith('/route.ts'));
const gatedFiles = new Set(GATED_ROUTES.map((r) => r.file));
const isExempt = (file: string) => ADMIN_AND_SYSTEM_EXEMPT_PREFIXES.some((e) => file.startsWith(e.prefix));

/**
 * Routes that LOOK like ingestion to the scanner but are not customer file ingestion. Each is justified; the list is
 * deliberately tiny so a new look-alike has to be argued for in review.
 */
const KNOWN_LOOKALIKES: Record<string, string> = {
  'app/api/reports/[id]/exports/route.ts':
    "Stores the PDF/export the SERVER renders from the user's own report into the report-exports bucket. Nothing the customer supplied is uploaded; Premium export is gated separately by canExportReports().",
  'app/api/investment-intelligence/positions/manual/route.ts':
    'MANUAL entry of a direct listed holding (Free). It uses importManualFixture only as its internal writer; no file, no upload, no extraction. It must stay Free.',
};

// A superset prefilter for `git grep` (ERE); the precise signal rules in uploadRouteContract.ts re-check each candidate.
const INGESTION_PREFILTER =
  'formData\\(\\)|arrayBuffer\\(\\)|createSigned(Upload)|\\.upload\\(|createUploadSession\\(|completeUpload\\(|createIntake\\(|admitIntake\\(|uploadSourceDocumentObject|uploadDocumentObject|importManualFixture|uploadBank(Csv|Pdf)\\(|uploadAnd[A-Za-z]+Statement\\(';

describe('inventory is real', () => {
  it('the route scan sees the real estate (not vacuous)', () => {
    expect(routeFiles.length).toBeGreaterThan(300);
  });

  it('every inventory entry names an existing route file with the declared method and a unique surface id', () => {
    const surfaces = new Set<string>();
    for (const e of GATED_ROUTES) {
      expect(existsSync(join(ROOT, e.file)), `${e.file} missing`).toBe(true);
      expect(new RegExp(`export\\s+async\\s+function\\s+${e.method}\\b`).test(read(e.file)), `${e.file} has no ${e.method} handler`).toBe(true);
      expect(surfaces.has(e.surface), `duplicate surface ${e.surface}`).toBe(false);
      surfaces.add(e.surface);
    }
    for (const r of REVIEW_CONTINUATION_ROUTES) expect(existsSync(join(ROOT, r.file)), `${r.file} missing`).toBe(true);
  });

  it('records the exact counts the Product Owner asked for', () => {
    // Update these deliberately when the estate changes; the point is that the tally is explicit and reviewed.
    expect(inventoryCounts()).toEqual({
      gatedRoutes: 28,
      admissionRoutes: 13,
      runStartRoutes: 15,
      reviewContinuationRoutesExempt: 13,
      adminAndSystemExemptPrefixes: 7,
      manualEntryRouteDirs: 14,
    });
  });
});

describe('(1) every listed route calls the central capability, first, and honours its answer', () => {
  for (const entry of GATED_ROUTES) {
    it(`${entry.surface}  <-  ${entry.file}`, () => {
      expect(checkGatedRouteSource(read(entry.file), entry)).toEqual([]);
    });
  }
});

describe('(2) no customer file-ingestion route exists outside the inventory', () => {
  const candidates = grepFiles(INGESTION_PREFILTER, ['app/api']).filter((f) => f.endsWith('/route.ts'));

  it('discovery over the whole app/api tree', () => {
    const unlisted = candidates
      .filter((f) => !isExempt(f) && !gatedFiles.has(f) && !(f in KNOWN_LOOKALIKES))
      .map((f) => ({ f, signals: detectIngestionSignals(read(f)) }))
      .filter((x) => x.signals.length > 0);
    expect(unlisted, `ungated ingestion routes (add them to lib/entitlements/financialImportInventory.ts and call the guard): ${JSON.stringify(unlisted)}`).toEqual([]);
  }, 60_000);

  it('the scanner actually finds the real estate (not vacuous): every admission route shows an ingestion signal', () => {
    for (const e of GATED_ROUTES.filter((g) => g.guard === 'admission')) {
      expect(detectIngestionSignals(read(e.file)).length, `${e.file}: scanner saw nothing -- scanner has drifted`).toBeGreaterThan(0);
    }
    for (const f of Object.keys(KNOWN_LOOKALIKES)) expect(detectIngestionSignals(read(f)).length, f).toBeGreaterThan(0);
  });
});

describe('(3) Admin and scheduled-system routes never depend on the consumer plan', () => {
  it('no exempt route imports the central capability', () => {
    const importers = grepFiles('lib/entitlements/financialDataImport', ['app/api']);
    expect(importers.length).toBeGreaterThan(20); // the scan sees the gated estate...
    expect(importers.filter((f) => isExempt(f))).toEqual([]); // ...and none of it is Admin / system
  });

  it('every admin upload route is governed by the admin role/capability layer instead', () => {
    const adminUploads = candidates().filter((f) => f.startsWith('app/api/admin/') && detectIngestionSignals(read(f)).length > 0);
    expect(adminUploads.length).toBeGreaterThanOrEqual(3); // benchmarks, market index data (x2) at least -- proves the scan sees them
    // guardBulkImport is the Resources Bulk Upload capability layer (lib/resources/import/access.ts: 401, country gate, 403 unless canBulkImportResources).
    for (const f of adminUploads) expect(/adminRoute|requireAdmin|requireSuperAdmin|guardBulkImport|[Cc]apabilit/.test(read(f)), `${f} has no admin guard`).toBe(true);
    // Recommendations CSV upload is admin-governed too (it carries its body via text, so check it by name).
    expect(read('app/api/admin/recommendations/upload/route.ts')).toMatch(/requireAdmin/);
  });

  it('the Resources admin tree is untouched by the consumer capability (staff need no Premium)', () => {
    const resources = routeFiles.filter((f) => f.startsWith('app/api/admin/resources/'));
    expect(resources.length).toBeGreaterThan(10);
    const importers = new Set(grepFiles('lib/entitlements/', ['app/api/admin']));
    expect(resources.filter((f) => importers.has(f))).toEqual([]);
  });

  function candidates() {
    return grepFiles(INGESTION_PREFILTER, ['app/api']).filter((f) => f.endsWith('/route.ts'));
  }
});

describe('(4) manual entry stays Free', () => {
  it('no manual-entry route calls the import capability', () => {
    const manual = routeFiles.filter((f) => MANUAL_ENTRY_ROUTE_DIRS.some((d) => f === `${d}/route.ts` || f.startsWith(`${d}/`)));
    expect(manual.length).toBeGreaterThan(30); // not vacuous
    const importers = new Set(grepFiles('lib/entitlements/', ['app/api']));
    expect(manual.filter((f) => importers.has(f))).toEqual([]);
    for (const d of MANUAL_ENTRY_ROUTE_DIRS) {
      expect(routeFiles.some((f) => f === `${d}/route.ts` || f.startsWith(`${d}/`)), `${d} has no routes`).toBe(true);
    }
  });

  it('the shared manual-entry grid and its configs do not depend on the import capability', () => {
    const files = listFiles(['components/grid', 'lib/grid']).filter((p) => /\.(ts|tsx)$/.test(p));
    expect(files.length).toBeGreaterThan(3);
    expect(grepFiles('financialDataImport|useFinancialImportAccess|ImportLocked', ['components/grid', 'lib/grid'])).toEqual([]);
  });

  it('review / apply / delete / privacy continuation routes do not call the capability (a downgrade must not strand data)', () => {
    for (const r of REVIEW_CONTINUATION_ROUTES) expect(importsCentralCapability(read(r.file)), r.file).toBe(false);
  });
});

describe('(6) the capability is read-only against billing state', () => {
  it('nothing in the entitlement module writes plan_tier or calls a payment provider', () => {
    for (const f of ['lib/entitlements/financialDataImport.ts', 'lib/entitlements/financialDataImportContract.ts', 'lib/entitlements/useFinancialImportAccess.ts']) {
      const src = stripComments(read(f));
      expect(src, f).not.toMatch(/\.(update|upsert|insert|delete)\(/);
      expect(src, f).not.toMatch(/from\s+['"]stripe['"]|razorpay|checkout\.sessions|subscriptions\.(retrieve|list)/i);
      expect(src, f).not.toMatch(/localStorage|sessionStorage|document\.cookie/); // no browser authority
    }
  });

  it('the checkout return path does not unlock uploads: nothing under lib/entitlements writes premium', () => {
    const writers = grepFiles("plan_tier[[:space:]]*:[[:space:]]*['\"]premium['\"]", ['lib/entitlements', 'app/api/financial-data-hub', 'app/api/aie']);
    expect(writers).toEqual([]);
  });
});

describe('(8) no reusable upload credential, no storage write path for customers, canonical data is plan-blind', () => {
  it('nothing in the application issues a signed UPLOAD credential (uploads are server-mediated; Free cannot obtain a token)', () => {
    const offenders = grepFiles('createSignedUploadUrl|createSignedUploadToken', ['app', 'lib', 'components']).filter((f) => !f.startsWith('lib/entitlements/'));
    expect(offenders, 'a signed upload credential must be added to the inventory and gated by the Premium capability first').toEqual([]);
  });

  it('storage policies grant authenticated users no write on the customer document buckets (SELECT only)', () => {
    const migrations = grepFiles('storage\\.objects', ['supabase/migrations']);
    expect(migrations.length).toBeGreaterThan(2);
    const offenders: string[] = [];
    for (const f of migrations) {
      const sql = read(f);
      for (const m of sql.matchAll(/create\s+policy\s+"[^"]+"\s+on\s+storage\.objects\s+for\s+(insert|update|delete|all)[\s\S]{0,400}?(fdh-source-documents|investment-source-documents|aie-[a-z-]+)/gi)) {
        offenders.push(`${f}: ${m[1]} on ${m[2]}`);
      }
    }
    expect(offenders).toEqual([]);
    // ...and the SELECT-only policies that DO exist are for the owner only.
    expect(read('supabase/migrations/0058_fdh3_document_lifecycle_upload_storage.sql')).toMatch(/create policy "own fdh source document objects" on storage\.objects\s+for select/);
  });

  it('the canonical loaders / read models / engines never branch on the upload capability (a downgrade cannot hide imported data)', () => {
    const dirs = ['lib/read-models', 'lib/engines', 'lib/import-bridge', 'lib/canonical-data', 'lib/investment-import-bridge', 'lib/retirement-import-bridge'];
    expect(listFiles(dirs).length).toBeGreaterThan(50); // not vacuous
    expect(grepFiles('financialDataImport|useFinancialImportAccess|resolveFinancialImportAccess', [...dirs, 'lib/services/dashboardData.ts'])).toEqual([]);
  });

  it('only the documented set of server modules imports the capability (no sprinkling across unrelated code)', () => {
    const importers = grepFiles("lib/entitlements/financialDataImport['\"]", ['app', 'lib']).filter((f) => !f.startsWith('lib/entitlements/'));
    const allowed = new Set<string>([
      ...GATED_ROUTES.map((g) => g.file),
      'app/api/financial-data-hub/upload-status/route.ts',
      'app/(app)/financial-data-hub/page.tsx',
      'lib/financial-data-hub/services/uploadLifecycle.ts',
      'lib/financial-data-hub/services/importRunPosition.ts',
      'lib/aie/importRunPosition.ts',
      'lib/aie/intakeAdmission.ts',
      'lib/services/investment-intelligence/importRunPosition.ts',
    ]);
    expect(importers.filter((f) => !allowed.has(f))).toEqual([]);
  });
});

describe('(7) the committed documentation matrix cannot drift from the code', () => {
  it('docs/entitlements/PREMIUM_UPLOAD_ENTITLEMENT.md embeds exactly the generated inventory matrix', () => {
    const doc = read('docs/entitlements/PREMIUM_UPLOAD_ENTITLEMENT.md');
    expect(doc).toContain(renderInventoryMatrixMarkdown());
  });
});

describe('NEGATIVE CONTROLS -- the contract demonstrably breaks when the gate is removed', () => {
  const sample = GATED_ROUTES.find((g) => g.surface === 'fdh.bank_csv.upload')!;
  const runSample = GATED_ROUTES.find((g) => g.surface === 'fdh.payslip.process')!;
  const normal = (rel: string) => read(rel).split('\r\n').join('\n');

  it('baseline: the real sources pass', () => {
    expect(checkGatedRouteSource(normal(sample.file), sample)).toEqual([]);
    expect(checkGatedRouteSource(normal(runSample.file), runSample)).toEqual([]);
  });

  it('strip the guard => reported (admission and run-start)', () => {
    const a = checkGatedRouteSource(stripGuard(normal(sample.file)), sample);
    expect(a.length).toBeGreaterThan(0);
    expect(a.join(' ')).toMatch(/does not call refuseUnlessFinancialImportAllowed/);
    const b = checkGatedRouteSource(stripGuard(normal(runSample.file)), runSample);
    expect(b.join(' ')).toMatch(/does not call refuseUnlessImportRunMayStart/);
  });

  it('ignore the answer (compute the refusal, do not return it) => reported', () => {
    const src = normal(sample.file).replace('if (importDenied) return importDenied;', 'void importDenied;');
    expect(checkGatedRouteSource(src, sample).join(' ')).toMatch(/does not return it/);
  });

  it('move the guard AFTER the body read => reported', () => {
    const original = normal(sample.file);
    const start = original.indexOf('  // Premium Upload Entitlement');
    const endMarker = 'if (importDenied) return importDenied;\n';
    const end = original.indexOf(endMarker) + endMarker.length;
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const guardLines = original.slice(start, end);
    const without = original.slice(0, start) + original.slice(end);
    const statement = 'const arrayBuffer = await req.arrayBuffer();\n';
    const at = without.indexOf(statement) + statement.length;
    expect(at).toBeGreaterThan(statement.length);
    const moved = without.slice(0, at) + guardLines + without.slice(at);
    expect(firstBodyReadIndex(moved)).toBeGreaterThanOrEqual(0);
    expect(checkGatedRouteSource(moved, sample).join(' ')).toMatch(/BEFORE the Premium guard/);
  });

  it('a wrong surface id (copy-paste) => reported', () => {
    const src = normal(sample.file).replace("'fdh.bank_csv.upload'", "'fdh.something.else'");
    expect(checkGatedRouteSource(src, sample).join(' ')).toMatch(/surface 'fdh\.bank_csv\.upload'/);
  });

  it('calling the guard before authentication => reported', () => {
    const original = normal(sample.file);
    const auth = 'const { user, unauthenticated } = await requireUser();\n  if (!user) return unauthenticated!;\n';
    expect(original).toContain(auth);
    // swap: the guard block first, authentication after
    const start = original.indexOf('  // Premium Upload Entitlement');
    const endMarker = 'if (importDenied) return importDenied;\n';
    const end = original.indexOf(endMarker) + endMarker.length;
    const guardLines = original.slice(start, end);
    const without = original.slice(0, start) + original.slice(end);
    const swapped = without.replace(auth, guardLines + '  ' + auth);
    expect(checkGatedRouteSource(swapped, sample).join(' ')).toMatch(/before authenticating/);
  });

  it('a brand-new ungated upload route is flagged by the discovery scan', () => {
    const brandNew = `import { requireCountryConfirmedUser as requireUser, ok } from '@/lib/api';
export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const form = await req.formData();
  return ok({ received: form.get('file') != null });
}`;
    expect(detectIngestionSignals(brandNew)).toContain('multipart body');
    expect(!gatedFiles.has('app/api/new-bank-thing/upload/route.ts') && detectIngestionSignals(brandNew).length > 0).toBe(true);
  });

  it('a future connector / signed-credential route is recognised as ingestion too', () => {
    expect(detectIngestionSignals("const { data } = await admin.storage.from('x').createSignedUploadUrl(path);")).toContain('signed upload credential');
    expect(detectIngestionSignals("await admin.storage.from('docs').upload(key, bytes);")).toContain('direct storage upload');
  });

  it('an Admin route that starts requiring Premium is flagged', () => {
    const adminRoute = `import { refuseUnlessFinancialImportAllowed } from '@/lib/entitlements/financialDataImport';`;
    expect(importsCentralCapability(adminRoute)).toBe(true); // i.e. check (3) above would fail for it
  });
});
