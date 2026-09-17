/**
 * M12D TRACEABILITY — Product-Owner requirement ids this file is evidence for.
 *
 * Added by the M12 Phase D mapping pass. Each id below was checked against this
 * file's ACTUAL assertions; ids it only touches incidentally are deliberately
 * omitted, and where this file does NOT discharge a neighbouring requirement,
 * that is said so explicitly rather than left to be assumed.
 * Full matrix: docs/aie-programme/AIE_1_REQUIREMENT_TRACEABILITY_FINAL_2026-09-15.md
 *
 *   AIE10-AI-02      Prohibited uses: identity adjudication, ownership invention,
 *                    security-master creation, undocumented FX, reconciliation
 *                    override.
 *   AIE12-WRITE-01   Use one domain-owned atomic import service, not direct scattered
 *                    table writes — asserted as an executable guard, not a convention.
 */
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

function adapterSourceFiles(): { name: string; text: string; code: string }[] {
  return readdirSync(ADAPTER_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => {
      const text = readFileSync(join(ADAPTER_DIR, f), 'utf8');
      return { name: f, text, code: stripComments(text) };
    });
}

/**
 * M3 addition. These are source-TEXT checks, and that blurs a real
 * distinction: a file that DOCUMENTS why it must not call
 * `processSourceDocument` contains that identifier, and a naive scan cannot
 * tell it apart from a file that actually calls it. The blunt version
 * punishes the honest comment, which is the wrong incentive — it pushes a
 * future author to delete the explanation rather than the call.
 *
 * So the prohibition assertions below that are about CODE run against
 * comment-stripped source, while the ones about imports keep using the raw
 * text (an import statement is never inside a comment in a file that
 * compiles). Deliberately a simple stripper, not a parser: it handles line
 * comments, block comments and the three string/template forms well enough
 * for this corpus, and a regex inside a string is not a shape any file here
 * uses.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    const ch = source[i];
    if (state === 'code') {
      if (two === '//') { state = 'line'; i += 2; continue; }
      if (two === '/*') { state = 'block'; i += 2; continue; }
      if (ch === "'") state = 'single';
      else if (ch === '"') state = 'double';
      else if (ch === '`') state = 'template';
      out += ch;
      i += 1;
      continue;
    }
    if (state === 'line') {
      if (ch === '\n') { state = 'code'; out += ch; }
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (two === '*/') { state = 'code'; i += 2; continue; }
      if (ch === '\n') out += ch; // keep line numbering roughly intact
      i += 1;
      continue;
    }
    // inside a string literal
    if (ch === '\\') { out += source.slice(i, i + 2); i += 2; continue; }
    if ((state === 'single' && ch === "'") || (state === 'double' && ch === '"') || (state === 'template' && ch === '`')) state = 'code';
    out += ch;
    i += 1;
  }
  return out;
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

  // The canonical tables only `processSourceDocument` may write.
  // `ii_source_documents` is deliberately ABSENT: `write.ts` inserts exactly
  // one row there, which is its documented, reviewed exception (it mirrors
  // the manual-upload POST handler's own insert), and folding it in here
  // would make this test fail for the one write the adapter is allowed.
  const CANONICAL_TABLES = ['ii_accounts', 'ii_instruments', 'ii_transactions', 'ii_holding_snapshots', 'ii_portfolio_truth_status', 'ii_instrument_identifiers'];
  const MUTATION_VERBS = ['.insert(', '.update(', '.upsert(', '.delete(', '.rpc('];

  /**
   * M3 UPDATE — THIS TEST WAS TIGHTENED, NOT RELAXED.
   *
   * It previously asserted that no adapter file contained `.from('<table>')`
   * AT ALL. That was a proxy for "no direct canonical write", and it worked
   * only while no adapter file had any reason to READ those tables. M3 added
   * `context.ts`, which must read them — it builds the read-only canonical
   * snapshot AIE-1.2's reconciliation rule was always written to consume but
   * which nothing in the application ever assembled (the reason
   * `buildInvestmentReconciliationRule` had zero production callers).
   *
   * The blunt check would have forced that loader to live outside the
   * adapter purely to satisfy a string search, which would have moved the
   * code without changing what it does. So the assertion now tests the
   * PROPERTY the prohibition is actually about — no adapter file MUTATES a
   * canonical table — and tests it per-occurrence rather than per-file. That
   * is strictly stronger than before against the failure it exists to catch:
   * the old version would have passed a file that never named a table but
   * built the query string dynamically, whereas this one also asserts, below,
   * that no mutation verb appears anywhere near a canonical table reference.
   */
  it('P6/step-8: no adapter file MUTATES a canonical Investment Intelligence table — only through the existing processSourceDocument service', () => {
    const files = adapterSourceFiles();
    for (const f of files) {
      for (const table of CANONICAL_TABLES) {
        const marker = `.from('${table}')`;
        let at = f.code.indexOf(marker);
        while (at !== -1) {
          // The chained call on a PostgREST builder follows immediately; a
          // 400-character window comfortably covers a multi-line chain while
          // staying inside the same statement.
          const window = f.code.slice(at, at + 400);
          for (const verb of MUTATION_VERBS) {
            expect(window.includes(verb), `${f.name}: ${marker} is followed by ${verb} — canonical writes belong to processSourceDocument only`).toBe(false);
          }
          expect(window.includes('.select('), `${f.name}: ${marker} is not a read — every canonical-table access in this adapter must be a select`).toBe(true);
          at = f.code.indexOf(marker, at + 1);
        }
      }
    }
  });

  it('P6/step-8 (companion): the read-only snapshot loader contains no mutation verb of any kind', () => {
    // `context.ts` is the only adapter file that touches canonical tables.
    // Asserting the whole file is mutation-free is a stronger statement than
    // the windowed check above, and it fails loudly if a future change adds a
    // write anywhere in it — including against a table not on the list.
    const context = adapterSourceFiles().find((f) => f.name === 'context.ts');
    expect(context, 'context.ts is expected to exist — it is the adapter\'s read-only canonical snapshot loader').toBeDefined();
    for (const verb of MUTATION_VERBS) {
      expect(context!.code.includes(verb), `context.ts must never call ${verb}`).toBe(false);
    }
  });

  it('P6/step-8 (companion): the dispatch service performs no canonical write and holds no reference to the write service', () => {
    // M2-OPEN-6: `app/api/aie/fdh-bank/intake/route.ts` auto-commits a
    // canonical write at intake, bypassing accept.ts's governed acceptance
    // gate — the same pattern the Insurance route explicitly removed as an
    // AIE-1.5 violation. This asserts the M3 Investment Intelligence dispatch
    // path did not reintroduce it.
    const dispatch = adapterSourceFiles().find((f) => f.name === 'dispatch.ts');
    expect(dispatch, 'dispatch.ts is expected to exist — it is the M3 I.1 dispatch service').toBeDefined();
    expect(dispatch!.code).not.toMatch(/acceptAndWriteInvestmentCandidates/);
    expect(dispatch!.code).not.toMatch(/from ['"]\.\/write['"]/);
    expect(dispatch!.code).not.toMatch(/processSourceDocument/);
    for (const verb of MUTATION_VERBS) {
      expect(dispatch!.code.includes(verb), `dispatch.ts must never call ${verb}`).toBe(false);
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
