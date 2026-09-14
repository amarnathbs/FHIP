import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

// AIE-1.2 — automated self-checks for this phase's own non-negotiable
// prohibitions (spec section 4), mirroring this repo's established
// grep-based prohibition-test pattern (see e.g.
// tests/unit/fdh1Isolation.test.ts's own documented substring-search
// technique). These are DELIBERATELY blunt source-text checks, not a
// substitute for AIE-1.6's real certification — they catch an accidental
// regression (a new import, a new field) a reviewer might otherwise miss.

const ADAPTER_DIR = join(process.cwd(), 'lib', 'aie', 'adapters', 'investment-intelligence');

function adapterSourceFiles(): { name: string; text: string }[] {
  return readdirSync(ADAPTER_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ name: f, text: readFileSync(join(ADAPTER_DIR, f), 'utf8') }));
}

describe('AIE-1.2 — non-negotiable prohibitions, self-checked (spec section 4)', () => {
  it('P2/step-1: no adapter file imports an AI provider or provider-selection module directly — only the shared AIE-1.1 gateway may', () => {
    const files = adapterSourceFiles();
    for (const f of files) {
      expect(f.text).not.toMatch(/from ['"]@\/lib\/ai\/providers/);
      expect(f.text).not.toMatch(/from ['"]@\/lib\/ai\/gateway/);
      expect(f.text.includes("from '../../provider")).toBe(false); // no direct import of AIE's own provider-calling surface either — only the orchestrator (outside this adapter) wires the gateway in
    }
  });

  it('P6/step-8: no adapter file writes directly to a canonical Investment Intelligence table — only through the existing processSourceDocument service', () => {
    const files = adapterSourceFiles();
    const canonicalTables = ['ii_accounts', 'ii_instruments', 'ii_transactions', 'ii_holding_snapshots', 'ii_portfolio_truth_status', 'ii_instrument_identifiers'];
    for (const f of files) {
      for (const table of canonicalTables) {
        // A .from('table_name') call would be the direct-write pattern
        // every other canonical write in this codebase uses — none of
        // these adapter files should contain one.
        expect(f.text.includes(`.from('${table}')`)).toBe(false);
      }
    }
  });

  it('P7/step-10: no second unresolved-item/exception table is created or referenced by name — only aie_unresolved_item (via AIE-1.1\'s own repository)', () => {
    const files = adapterSourceFiles();
    for (const f of files) {
      expect(f.text).not.toMatch(/create table\s+\w*(unresolved|exception|reconciliation_queue)/i);
    }
    // The one adapter-owned table this phase DOES create is a pure
    // provenance link, not an exception system — confirmed by name and by
    // the migration's own header disclosure.
    const migration = readFileSync(join(process.cwd(), 'supabase', 'migrations', '0141_aie1_2_investment_adapter_link.sql'), 'utf8');
    expect(migration).toMatch(/create table aie_ii_adapter_link/);
    expect(migration).not.toMatch(/create table\s+\w*unresolved/i);
  });

  it('P9/step-11: the canonical-write feature flag is referenced by every write path and defaults OFF (no env var is auto-set to "true" anywhere in the adapter source)', () => {
    const files = adapterSourceFiles();
    const writeFile = files.find((f) => f.name === 'write.ts')!;
    expect(writeFile.text).toContain('isIiAdapterCanonicalWriteEnabled()');
    for (const f of files) {
      expect(f.text).not.toMatch(/AIE_II_ADAPTER_CANONICAL_WRITE_ENABLED\s*=\s*['"]true['"]/);
    }
  });

  it('step-4: the document catalogue names at least one certified class and at least one deferred class — never blanket "supported"', () => {
    const catalogueFile = adapterSourceFiles().find((f) => f.name === 'documentCatalogue.ts')!;
    expect(catalogueFile.text).toContain("status: 'certified'");
    expect(catalogueFile.text).toContain("status: 'deferred'");
  });

  it('PC6 exclusion: no adapter file references any pricing/NAV-feed/benchmark ingestion module (out of scope for this entire phase)', () => {
    const files = adapterSourceFiles();
    for (const f of files) {
      expect(f.text).not.toMatch(/from ['"]@\/lib\/(engines\/investment-intelligence\/(benchmark|navReturn)|market-data)/);
    }
  });
});
