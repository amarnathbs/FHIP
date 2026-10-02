/**
 * Owner-before-upload -- certification / live scripts must not call an owner-required upload route without an
 * owner (PO final-completion item g).
 *
 * Two parts:
 *   1. The shared helper (scripts/lib/syntheticOwner.mjs): route -> flow mapping, owner injection into a route,
 *      translation of the retired loose `owner_role`, and Self / Spouse / Joint / SMSF resolution through the
 *      app's own routes.
 *   2. A repository-wide guard: every script that posts to an owner-required upload route either goes through
 *      the helper / the canonical-cert api() (which injects an owner) or names an owner explicitly. A script
 *      that does neither is STALE and fails here. The predicate is itself proven with a negative control.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as helper from '../../scripts/lib/syntheticOwner.mjs';

const SELF = 'a1111111-1111-4111-8111-111111111111';
const SPOUSE = 'a2222222-2222-4222-8222-222222222222';

function fakeRequest(opts: { spouse?: boolean } = {}) {
  const calls: Array<{ method: string; route: string; json?: unknown }> = [];
  const request = async (method: string, route: string, json?: unknown) => {
    calls.push({ method, route, json });
    if (route === '/api/ownership/self') return { status: 200, json: { data: { memberId: SELF } } };
    if (route.startsWith('/api/ownership/options')) {
      return { status: 200, json: { data: { members: opts.spouse ? [{ id: SPOUSE, ownerRole: 'spouse' }] : [] } } };
    }
    if (route === '/api/household-members') return { status: 200, json: { data: { id: SPOUSE } } };
    return { status: 404, json: null };
  };
  return { request, calls };
}

describe('syntheticOwner helper', () => {
  it('maps every owner-required upload route to its flow, and nothing else', () => {
    expect(helper.flowForUploadRoute('/api/financial-data-hub/bank-csv/upload?a=1')).toBe('bank');
    expect(helper.flowForUploadRoute('/api/financial-data-hub/bank-pdf/upload?a=1')).toBe('bank');
    expect(helper.flowForUploadRoute('/api/financial-data-hub/liability-statement/upload?a=1')).toBe('liability');
    expect(helper.flowForUploadRoute('/api/financial-data-hub/retirement-statement/upload')).toBe('retirement');
    expect(helper.flowForUploadRoute('/api/financial-data-hub/investment-statement/upload?x')).toBe('au_investment');
    expect(helper.flowForUploadRoute('/api/financial-data-hub/bank-csv/abc/process')).toBeNull();
    expect(helper.flowForUploadRoute('/api/financial-data-hub/bank-transactions/categorise')).toBeNull();
  });

  it('maps owner-bearing document types for upload sessions (and not the owner-less ones)', () => {
    expect(helper.flowForDocumentType('payslip')).toBe('payslip');
    expect(helper.flowForDocumentType('bank_statement')).toBe('bank');
    expect(helper.flowForDocumentType('loan_statement')).toBe('liability');
    expect(helper.flowForDocumentType('tax_document')).toBeNull();
    expect(helper.flowForDocumentType('other')).toBeNull();
  });

  it('routeWithOwner sets owner=<json> and removes the retired loose owner_role', () => {
    const r = helper.routeWithOwner('/api/financial-data-hub/bank-csv/upload?country_code=AU&owner_role=spouse', { kind: 'member', memberId: SELF });
    const q = new URLSearchParams(r.split('?')[1]);
    expect(q.get('owner_role')).toBeNull();
    expect(JSON.parse(q.get('owner') as string)).toEqual({ kind: 'member', memberId: SELF });
    expect(q.get('country_code')).toBe('AU');
    expect(helper.legacyOwnerRoleOf('/x?owner_role=spouse')).toBe('spouse');
    expect(helper.routeHasOwner('/x?owner=%7B%7D')).toBe(true);
    expect(helper.routeHasOwner('/x?a=1')).toBe(false);
  });

  it('resolves Self through POST /api/ownership/self (never a client-chosen id)', async () => {
    const { request, calls } = fakeRequest();
    expect(await helper.resolveSyntheticOwner(request, 'self', 'bank')).toEqual({ kind: 'member', memberId: SELF });
    expect(calls).toEqual([{ method: 'POST', route: '/api/ownership/self', json: undefined }]);
  });

  it('resolves an existing Spouse, and only ADDS a synthetic one to the same user when none exists', async () => {
    const has = fakeRequest({ spouse: true });
    expect(await helper.resolveSyntheticOwner(has.request, 'spouse', 'bank')).toEqual({ kind: 'member', memberId: SPOUSE });
    expect(has.calls.some((c) => c.route === '/api/household-members')).toBe(false);
    const none = fakeRequest();
    expect(await helper.resolveSyntheticOwner(none.request, 'partner', 'bank')).toEqual({ kind: 'member', memberId: SPOUSE });
    expect(none.calls.filter((c) => c.route === '/api/household-members')).toHaveLength(1);
  });

  it('Joint: no shares for bank / liability / retirement, a 50/50 split for AU investment; SMSF is a bare kind', async () => {
    const a = fakeRequest({ spouse: true });
    expect(await helper.resolveSyntheticOwner(a.request, 'joint', 'bank')).toEqual({ kind: 'joint' });
    expect(await helper.resolveSyntheticOwner(a.request, 'joint', 'au_investment')).toEqual({
      kind: 'joint',
      allocations: [{ memberId: SELF, basisPoints: 5000 }, { memberId: SPOUSE, basisPoints: 5000 }],
    });
    expect(await helper.resolveSyntheticOwner(a.request, 'smsf', 'bank')).toEqual({ kind: 'smsf' });
  });

  it('NEGATIVE: an unsupported role throws -- it never silently falls back to Self', async () => {
    await expect(helper.resolveSyntheticOwner(fakeRequest().request, 'company' as never, 'bank')).rejects.toThrow(/unsupported owner role/);
  });
});

// ---------------------------------------------------------------------------------------------
// Repository-wide guard.
// ---------------------------------------------------------------------------------------------
const OWNER_REQUIRED_ROUTE = /(bank-csv\/upload|bank-pdf\/upload|liability-statement\/upload|retirement-statement\/upload|investment-statement\/upload|documents\/upload-sessions['"`?]|investment-intelligence\/source-documents['"`]\s*,\s*\{\s*method:\s*'POST'|aie\/fdh-bank\/intake|aie\/investment-intelligence\/intake)/;
const HANDLES_OWNER = /(syntheticOwner|resolveSyntheticOwner|session\.mjs|owner=|owner:|\bowner\b\s*[,}]|'owner'|"owner")/;

/**
 * PURE. A script is STALE when it posts to an owner-required route and names no owner at all.
 * A canonical-cert script that makes NO raw fetch() goes through the harness api() / call() wrapper, which
 * injects the owner (asserted separately below), so it is handled even though it never says "owner".
 */
export function isStaleOwnerScript(source: string, relPath = ''): boolean {
  if (!OWNER_REQUIRED_ROUTE.test(source) || HANDLES_OWNER.test(source)) return false;
  const viaHarnessApi = relPath.startsWith('canonical_cert/') && !/\bfetch\(/.test(source);
  return !viaHarnessApi;
}

function listScripts(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listScripts(p, out);
    else if (/\.(mjs|ts|js|cjs)$/.test(e.name) && !p.includes(`${path.sep}evidence${path.sep}`)) out.push(p);
  }
  return out;
}

describe('no certification / live script calls an owner-required route without an owner', () => {
  const root = path.resolve(__dirname, '../../scripts');
  const scripts = listScripts(root);

  it('the scan covers the scripts that matter', () => {
    const touching = scripts.filter((p) => OWNER_REQUIRED_ROUTE.test(fs.readFileSync(p, 'utf8')));
    expect(touching.length).toBeGreaterThan(25);
  });

  it('every script that posts to an owner-required route handles the owner', () => {
    const rel = (p: string) => path.relative(root, p).replace(/\\/g, '/');
    const stale = scripts.filter((p) => isStaleOwnerScript(fs.readFileSync(p, 'utf8'), rel(p))).map(rel);
    expect(stale).toEqual([]);
  });

  it('NEGATIVE CONTROL: the predicate flags a script that uploads with no owner, and accepts the same script once it names one', () => {
    const stale = "await fetch(`${APP}/api/financial-data-hub/bank-csv/upload?country_code=AU&currency_code=AUD`, { method: 'POST', body: csv });";
    expect(isStaleOwnerScript(stale)).toBe(true);
    // a canonical-cert script with a raw fetch() does NOT get the harness exemption
    expect(isStaleOwnerScript(stale, 'canonical_cert/x.ts')).toBe(true);
    expect(isStaleOwnerScript("await call(e, 'POST', '/api/financial-data-hub/bank-csv/upload?x=1')", 'canonical_cert/x.ts')).toBe(false);
    expect(isStaleOwnerScript(stale.replace('currency_code=AUD', 'currency_code=AUD&owner=${o}'))).toBe(false);
    expect(isStaleOwnerScript("import { api } from './lib/session.mjs'; await api(e, 'POST', '/api/financial-data-hub/bank-csv/upload?x=1')")).toBe(false);
  });

  it('the shared canonical-cert api() injects an owner for every owner-required route and honours `owner: null`', () => {
    const src = fs.readFileSync(path.resolve(root, 'canonical_cert/lib/session.mjs'), 'utf8');
    expect(src).toMatch(/flowForUploadRoute\(route\)/);
    expect(src).toMatch(/opts\.owner === null/);
    expect(src).toMatch(/flowForDocumentType\(opts\.json\.document_type\)/);
  });
});
