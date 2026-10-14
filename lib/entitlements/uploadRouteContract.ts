/**
 * Premium Upload Entitlement -- the pure source analysis behind the CI contract
 * (tests/unit/premiumUploadInventoryContract.test.ts). No file-system access here, so the same functions can be
 * pointed at a synthetic route in a negative control.
 *
 * What it recognises as CUSTOMER FILE INGESTION in an API route file: reading a multipart body or raw request bytes,
 * creating an upload session / import document / AIE intake, writing a source document to storage, issuing a signed
 * upload credential, or running the fixture importer. A route that shows any of these must be in the inventory (and
 * gated), or be an Admin / system route, or be on the short, justified allow-list of look-alikes.
 */

import type { GatedRoute } from './financialImportInventory';

export const INGESTION_SIGNALS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'multipart body', pattern: /\.formData\(\)/ },
  { name: 'raw request bytes', pattern: /\b(?:req|request)\.arrayBuffer\(\)/ },
  { name: 'signed upload credential', pattern: /createSignedUploadUrl|createSignedUploadToken/ },
  { name: 'direct storage upload', pattern: /\.storage\s*\.from\([^)]*\)\s*\.upload\(/ },
  { name: 'upload session / document creation', pattern: /\bcreateUploadSession\(|\bcompleteUpload\(/ },
  { name: 'AIE intake creation', pattern: /\bcreateIntake\(/ },
  { name: 'source-document storage write', pattern: /\buploadSourceDocumentObject\(|\buploadDocumentObject\(/ },
  { name: 'fixture importer', pattern: /\bimportManualFixture\(/ },
  { name: 'bank statement upload service', pattern: /\buploadBank(?:Csv|Pdf)\(/ },
  { name: 'statement upload-and-process service', pattern: /\buploadAnd[A-Za-z]+Statement\(/ },
];

export function detectIngestionSignals(source: string): string[] {
  return INGESTION_SIGNALS.filter((s) => s.pattern.test(source)).map((s) => s.name);
}

/** Index of the first place the handler reads the request body (so a guard can be required to come BEFORE it). */
export function firstBodyReadIndex(source: string): number {
  const patterns = [/\b(?:req|request)\.formData\(\)/, /\b(?:req|request)\.arrayBuffer\(\)/, /\b(?:req|request)\.json\(\)/, /\b(?:req|request)\.text\(\)/, /\b(?:req|request)\.blob\(\)/, /\b(?:req|request)\.body\b/];
  const hits = patterns.map((p) => source.search(p)).filter((i) => i >= 0);
  return hits.length ? Math.min(...hits) : -1;
}

export function importsCentralCapability(source: string): boolean {
  return /from\s+['"]@\/lib\/entitlements\/financialDataImport['"]/.test(source);
}

export function guardCallIndex(source: string, entry: Pick<GatedRoute, 'guard' | 'surface'>): number {
  const fn = entry.guard === 'admission' ? 'refuseUnlessFinancialImportAllowed' : 'refuseUnlessImportRunMayStart';
  const re = new RegExp(`${fn}\\(\\s*[A-Za-z_.]+\\s*,\\s*'${entry.surface.replace(/\./g, '\\.')}'`);
  return source.search(re);
}

/** True when the guard's refusal is actually returned (not computed and ignored). */
export function guardResultIsReturned(source: string): boolean {
  return /if\s*\(\s*importDenied\s*\)\s*return\s+importDenied\s*;/.test(source);
}

export function checkGatedRouteSource(source: string, entry: GatedRoute): string[] {
  const problems: string[] = [];
  if (!importsCentralCapability(source)) problems.push('does not import the central capability');
  const at = guardCallIndex(source, entry);
  if (at < 0) problems.push(`does not call ${entry.guard === 'admission' ? 'refuseUnlessFinancialImportAllowed' : 'refuseUnlessImportRunMayStart'} with surface '${entry.surface}'`);
  if (at >= 0 && !guardResultIsReturned(source)) problems.push('computes the refusal but does not return it');
  // An ADMISSION route receives the file, so it must refuse before reading ANY of the body. A run-start route receives only
  // a document id and a tiny JSON body (a password / a re-parse flag the decision may need), never a file, so only the
  // admission rule is enforced on the body.
  const body = firstBodyReadIndex(source);
  if (entry.guard === 'admission' && at >= 0 && body >= 0 && body < at) problems.push('reads the request body BEFORE the Premium guard');
  // The guard must also come after authentication (it needs the session user's id) -- an anonymous request is a 401 first.
  const auth = source.search(/requireUser\(\)|requireModuleCapability\(|requireCountryConfirmedUser\(\)/);
  if (at >= 0 && auth >= 0 && auth > at) problems.push('calls the Premium guard before authenticating the caller');
  return problems;
}

/** Strips a guard from a route source (used only by the negative controls to prove the contract detects removal). */
/** Source with comments removed, so a rule about code is not tripped by prose that mentions a word. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

export function stripGuard(source: string): string {
  return source
    .replace(/^\s*const importDenied = await refuseUnless[\s\S]*?;\s*\n/m, '')
    .replace(/^\s*if \(importDenied\) return importDenied;\s*\n/m, '');
}
