// BENCH-1 Phase 2 - static render-contract test for the Market Index Data Admin client.
// There is no DOM environment in this repository, so this reads the component SOURCE and asserts
// the rules that must hold for every screen: no server-only imports, no secrets, no raw HTML
// injection, accessible buttons, the ARIA tab pattern, a live region, safe external links, the exact
// file-input filter, and that every API path the client can call is on the agreed contract list.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');
const DIR = path.join(ROOT, 'components', 'admin', 'benchmarkData');
const CLIENT = path.join(ROOT, 'components', 'admin', 'BenchmarkDataClient.tsx');

const files = [CLIENT, ...readdirSync(DIR).filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => path.join(DIR, f))];
const sources = new Map(files.map((f) => [path.relative(ROOT, f).replace(/\\/g, '/'), readFileSync(f, 'utf8')]));
const all = [...sources.values()].join('\n');
const LOGIC = 'components/admin/benchmarkData/benchmarkDataUiLogic.ts';

const CONTRACT_PATHS = new Set([
  'overview', 'upload/inspect', 'upload', 'jobs', 'jobs/:id', 'jobs/:id/errors', 'jobs/:id/publish', 'jobs/:id/cancel', 'jobs/:id/rollback',
  'templates/:name', 'help', 'catalogue', 'catalogue/:id/verify', 'entitlements', 'entitlements/:id/approve', 'entitlements/:id/revoke',
  'mappings', 'mappings/:id/review', 'mappings/unmapped', 'mappings/held', 'factsheet/changes', 'factsheet/changes/:id/review', 'factsheet/sources', 'factsheet/sources/:id/terms', 'ingestion/:id/mode',
]);

describe('Market Index Data client: static render contract', () => {
  it('the client entry is a use-client default export with no props', () => {
    const s = sources.get('components/admin/BenchmarkDataClient.tsx') as string;
    expect(s.startsWith("'use client';")).toBe(true);
    expect(s).toMatch(/export default function BenchmarkDataClient\(\)/);
  });

  it('NEVER imports server-only modules: only type imports and pure helpers from the services tree', () => {
    // Pure helpers only (no imports of their own, no I/O): the layout list, and the benchmark-name matcher
    // the mapping form uses to SUGGEST a catalogue entry for what the reviewer typed.
    const allowedRuntime = new Set([
      '@/lib/services/investment-intelligence/benchmarkData/fileIngest/layouts',
      '@/lib/services/investment-intelligence/benchmarkData/benchmarkNameMatcher',
    ]);
    for (const [name, src] of sources) {
      for (const m of src.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+'([^']+)';/gm)) {
        const spec = m[2];
        const isType = Boolean(m[1]);
        expect(spec, `${name}: server-only import`).not.toMatch(/guards|supabase|next\/headers|server-only|adminAuth|routeSupport|publishService|uploadService|liveDeps|orchestrator|^node:|^fs$|^crypto$/);
        if (spec.startsWith('@/lib/services/') && !isType) expect(allowedRuntime.has(spec), `${name}: runtime import of ${spec}`).toBe(true);
      }
    }
  });

  it('has no secret or privileged-client reference and no raw HTML injection', () => {
    expect(all).not.toMatch(/dangerouslySetInnerHTML/);
    expect(all).not.toMatch(/\.innerHTML\s*=/);
    expect(all).not.toMatch(/createAdminClient|SERVICE_ROLE|service_role|process\.env/);
    expect(all).not.toMatch(/eval\(|new Function\(/);
  });

  it('every <button> has accessible text or an aria-label', () => {
    let count = 0;
    for (const [name, src] of sources) {
      for (const m of src.matchAll(/<button\b[\s\S]*?<\/button>/g)) {
        count++;
        const block = m[0];
        const open = /^<button[\s\S]*?[^=]>/.exec(block);
        expect(open, `${name}: unparsable button`).not.toBeNull();
        const inner = block.slice((open as RegExpExecArray)[0].length, -'</button>'.length).trim();
        const hasLabel = /aria-label=/.test((open as RegExpExecArray)[0]);
        expect(hasLabel || inner.length > 0, `${name}: empty button: ${block.slice(0, 80)}`).toBe(true);
      }
      // wrapper components must never be used empty either
      expect(src, `${name}: empty Btn`).not.toMatch(/<(Btn|LinkBtn)\b[^>]*>\s*<\/(Btn|LinkBtn)>/);
    }
    expect(count).toBeGreaterThan(0);
  });

  it('uses the ARIA tab pattern and a live region', () => {
    const s = sources.get('components/admin/BenchmarkDataClient.tsx') as string;
    for (const needle of ['role="tablist"', 'role="tab"', 'role="tabpanel"', 'aria-selected=', 'aria-controls=', 'aria-labelledby=', 'tabIndex=']) expect(s, needle).toContain(needle);
    expect(all).toMatch(/aria-live="polite"/);
    expect(all).toMatch(/role="alert"/);
  });

  it('every target="_blank" link carries rel noopener', () => {
    let n = 0;
    for (const [name, src] of sources) {
      for (const m of src.matchAll(/<a\b[\s\S]*?>/g)) {
        if (/target="_blank"/.test(m[0])) {
          n++;
          expect(m[0], `${name}: ${m[0]}`).toMatch(/rel="noopener noreferrer"/);
        }
      }
    }
    expect(n).toBeGreaterThan(0);
  });

  it('the file input accepts exactly .csv,.xlsx', () => {
    const inputs = [...all.matchAll(/<input\b[^>]*type="file"[^>]*>/g)].map((m) => m[0]);
    expect(inputs.length).toBe(1);
    for (const i of inputs) expect(i).toMatch(/accept="\.csv,\.xlsx"/);
  });

  it('every API path the client can call is on the contract list, and only the logic module builds paths', () => {
    // Raw API strings live only in the logic module (as API_BASE).
    for (const [name, src] of sources) if (name !== LOGIC) expect(src, `${name}: raw api path`).not.toMatch(/\/api\//);
    const logic = sources.get(LOGIC) as string;
    const found = new Set<string>();
    for (const m of logic.matchAll(/`\$\{API_BASE\}\/([^`]*)`/g)) found.add(m[1].replace(/\$\{seg\([A-Za-z]+\)\}/g, ':id'));
    // template(name) is the only path whose parameter is a name, not an id
    const normalised = new Set([...found].map((p) => (p === 'templates/:id' ? 'templates/:name' : p)));
    for (const p of normalised) expect(CONTRACT_PATHS.has(p), `path not on the contract list: ${p}`).toBe(true);
    for (const p of CONTRACT_PATHS) expect(normalised.has(p), `contract path never built: ${p}`).toBe(true);
    expect(logic).toMatch(/export const API_BASE = '\/api\/admin\/investment-intelligence\/benchmark-data'/);
  });

  it('fetch is used only in the api helper, same-origin, with an abort signal', () => {
    for (const [name, src] of sources) if (name !== 'components/admin/benchmarkData/api.ts') expect(src, name).not.toMatch(/\bfetch\(/);
    const api = sources.get('components/admin/benchmarkData/api.ts') as string;
    expect(api).toMatch(/credentials: 'same-origin'/);
    expect(api).toMatch(/signal: init\.signal/);
    expect(api).toMatch(/new AbortController\(\)/);
    expect(api).toMatch(/ac\.abort\(\)|ref\.current\?\.abort\(\)/);
  });

  it('never claims manual import is automatic', () => {
    expect(all).not.toMatch(/automatic(ally)? updat(e|es|ed) (daily|every)/i);
    expect(sources.get(LOGIC)).toMatch(/Manual import/);
  });
});
