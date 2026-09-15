/**
 * PC5 (M4) — automated self-checks for PC5's own non-negotiable
 * prohibitions (K.3, K.12, K.17, K.20), in this repository's established
 * grep-based prohibition-test style (see
 * `tests/unit/aieIiAdapterProhibitions.test.ts` and
 * `tests/unit/fdh1Isolation.test.ts`, whose comment-stripping technique
 * this file reuses for the same reason: a blunt source scan otherwise
 * punishes the file that HONESTLY DOCUMENTS why it must not do something,
 * and rewards deleting the explanation instead of the code).
 *
 * These are deliberately blunt structural checks, not a substitute for the
 * behavioural tests alongside them. They exist to catch an accidental
 * regression a reviewer might miss — a new import, a new table, a new
 * status write — rather than to prove the design is right.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const PC5_LIB_DIR = join(ROOT, 'lib', 'pc5');
const PC5_API_DIR = join(ROOT, 'app', 'api', 'pc5');
const MIGRATION = join(ROOT, 'supabase', 'migrations', '0153_pc5_governed_resolution.sql');

/** Same stripper as `aieIiAdapterProhibitions.test.ts` — handles line and
 * block comments and the three string forms well enough for this corpus. */
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
      if (ch === '\n') out += ch;
      i += 1;
      continue;
    }
    if (ch === '\\') { out += source.slice(i, i + 2); i += 2; continue; }
    if ((state === 'single' && ch === "'") || (state === 'double' && ch === '"') || (state === 'template' && ch === '`')) state = 'code';
    out += ch;
    i += 1;
  }
  return out;
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

function pc5Sources(): { name: string; text: string; code: string }[] {
  return [...walk(PC5_LIB_DIR), ...walk(PC5_API_DIR), ...walk(join(ROOT, 'components', 'pc5'))].map((full) => {
    const text = readFileSync(full, 'utf8');
    return { name: full.slice(ROOT.length + 1).replace(/\\/g, '/'), text, code: stripComments(text) };
  });
}

describe('PC5 K.3 — no second exception system', () => {
  it('PC5 owns NO table of its own for exceptions, statuses, queues or counts', () => {
    const migration = readFileSync(MIGRATION, 'utf8');
    // The one table 0153 creates is domain data (an ownership breakdown),
    // not an exception ledger.
    const created = [...migration.matchAll(/create table (?:if not exists )?(\w+)/gi)].map((m) => m[1]);
    expect(created).toEqual(['ii_ownership_allocation']);
    expect(migration).not.toMatch(/create table\s+\w*(unresolved|exception|review_item|resolution_item|queue)/i);
  });

  it('the migration adds NO new status vocabulary for exceptions — it reuses aie_unresolved_item\'s', () => {
    const migration = readFileSync(MIGRATION, 'utf8');
    // The only status CHECK it introduces is the allocation lifecycle,
    // which is the same three values `ii_goal_allocations` already uses.
    const statusChecks = [...migration.matchAll(/status text not null default '(\w+)' check \(status in \(([^)]+)\)\)/gi)];
    expect(statusChecks).toHaveLength(1);
    expect(statusChecks[0][2].replace(/['\s]/g, '')).toBe('active,superseded,removed');
    expect(migration).not.toMatch(/check \(status in \([^)]*in_review/i);
  });

  it('no PC5 source file opens a PostgREST query against aie_unresolved_item at all — reads AND writes go through AIE\'s repository', () => {
    // Tests the PROPERTY, not a substring: `.from('aie_unresolved_item')`
    // is what a direct query looks like. The bare table NAME legitimately
    // appears elsewhere — `decide.ts` records it as an audit
    // `subjectType`, which identifies what a decision was about and
    // touches nothing. An earlier draft of this assertion banned the
    // substring and failed on exactly that, which is the blunt-check
    // failure mode this file's own header warns about.
    for (const f of pc5Sources()) {
      expect(f.code.includes(".from('aie_unresolved_item')"), `${f.name} must not query aie_unresolved_item directly`).toBe(false);
    }
  });

  it('no PC5 source file queries any other aie_ table directly either', () => {
    for (const f of pc5Sources()) {
      const directQueries = [...f.code.matchAll(/\.from\('(aie_\w+)'\)/g)].map((m) => m[1]);
      expect(directQueries, `${f.name} must reach AIE tables only through lib/aie/db/repository.ts`).toEqual([]);
    }
  });

  it('no PC5 source file writes ii_review_items — AIE exceptions are projected ALONGSIDE the R9 Review Centre, never INTO it', () => {
    for (const f of pc5Sources()) {
      expect(f.code.includes("'ii_review_items'"), `${f.name} must not touch ii_review_items`).toBe(false);
    }
  });

  it('PC5 never writes a "resolved" or "superseded" AIE item status — only a real re-reconciliation may assert the condition is gone', () => {
    for (const f of pc5Sources()) {
      expect(f.code, `${f.name} must not set an item status`).not.toMatch(/newStatus:\s*['"](resolved|superseded|rejected)['"]/);
    }
  });
});

describe('PC5 K.20 — PC5 cannot direct-write canonical Investment Intelligence tables', () => {
  const CANONICAL_TABLES = [
    'ii_accounts',
    'ii_instruments',
    'ii_transactions',
    'ii_holding_snapshots',
    'ii_portfolio_truth_status',
    'ii_instrument_identifiers',
    'ii_source_documents',
    'ii_fhip_publications',
    'investments',
    'assets',
    'retirement_accounts',
  ];
  const MUTATION_VERBS = ['.insert(', '.update(', '.upsert(', '.delete(', '.rpc('];

  it('every canonical-table access in PC5 is a SELECT, with no mutation verb anywhere near it', () => {
    for (const f of pc5Sources()) {
      for (const table of CANONICAL_TABLES) {
        const marker = `.from('${table}')`;
        let at = f.code.indexOf(marker);
        while (at !== -1) {
          const window = f.code.slice(at, at + 400);
          for (const verb of MUTATION_VERBS) {
            expect(window.includes(verb), `${f.name}: ${marker} is followed by ${verb}`).toBe(false);
          }
          expect(window.includes('.select('), `${f.name}: ${marker} must be a read`).toBe(true);
          at = f.code.indexOf(marker, at + 1);
        }
      }
    }
  });

  it('no PC5 file imports the canonical write service or the II document processor', () => {
    for (const f of pc5Sources()) {
      expect(f.code, `${f.name} must not reference processSourceDocument`).not.toMatch(/processSourceDocument/);
      expect(f.code, `${f.name} must not reference acceptAndWriteInvestmentCandidates`).not.toMatch(/acceptAndWriteInvestmentCandidates/);
      expect(f.code, `${f.name} must not import the acceptance gate`).not.toMatch(/from '@\/lib\/aie\/review\/accept'/);
    }
  });

  it('the ONE table PC5 writes has SELECT-only RLS, so a browser cannot forge an allocation', () => {
    const migration = readFileSync(MIGRATION, 'utf8');
    expect(migration).toMatch(/create policy "select own ii_ownership_allocation" on ii_ownership_allocation\s*\n\s*for select using \(user_id = auth\.uid\(\)\)/);
    // No insert/update/delete policy, and emphatically not `for all`.
    expect(migration).not.toMatch(/on ii_ownership_allocation\s*\n\s*for (all|insert|update|delete)/i);
  });

  it('the migration carries a cross-tenant FK guard — a valid id belonging to someone else is refused at the database', () => {
    const migration = readFileSync(MIGRATION, 'utf8');
    expect(migration).toMatch(/create or replace function public\.ii_ownership_allocation_assert_owner/);
    expect(migration).toMatch(/create trigger trg_ii_ownership_allocation_owner/);
    for (const column of ['ii_account_id', 'owner_member_id', 'owner_business_entity_id', 'aie_run_id']) {
      expect(migration, `the guard must check ${column}`).toMatch(new RegExp(`does not belong to user_id`, 'i'));
      expect(migration).toContain(column);
    }
  });
});

describe('PC5 K.12 — no recoverable original value, anywhere', () => {
  it('no PC5 file imports or references a reveal/decrypt path', () => {
    for (const f of pc5Sources()) {
      expect(f.code, `${f.name} must not call revealMaskedToken`).not.toMatch(/revealMaskedToken/);
      expect(f.code, `${f.name} must not reference the deleted token-map crypto`).not.toMatch(/tokenMapCrypto|findMaskTokenCiphertext|persistMaskTokenMap/);
      expect(f.code, `${f.name} must not query the mask token map`).not.toMatch(/aie_mask_token_map/);
    }
  });

  it('the reversible token-map crypto module is genuinely GONE from the repository, not merely unused', () => {
    expect(existsSync(join(ROOT, 'lib', 'aie', 'masking', 'tokenMapCrypto.ts'))).toBe(false);
  });

  it('the correction-overlay view types recoverability as the LITERAL false, so it cannot be made conditional later without a compile error', () => {
    const types = readFileSync(join(ROOT, 'lib', 'pc5', 'types.ts'), 'utf8');
    expect(types).toMatch(/originalValueIsRecoverable:\s*false;/);
  });

  it('the resolution UI offers no reveal control and says the masking is one-way', () => {
    const ui = readFileSync(join(ROOT, 'components', 'pc5', 'ResolutionDetailClient.tsx'), 'utf8');
    expect(stripComments(ui)).not.toMatch(/reveal/i);
    expect(ui).toMatch(/one-way|cannot be shown again/i);
  });
});

describe('PC5 K.17 — no blind bulk action exists', () => {
  it('no PC5 route accepts an array of item ids', () => {
    for (const f of pc5Sources()) {
      if (!f.name.startsWith('app/api/pc5/')) continue;
      expect(f.code, `${f.name} must not accept a bulk id list`).not.toMatch(/itemIds|item_ids|bulk/i);
    }
  });

  it('the bulk flag exists but is wired to nothing that could act in bulk', () => {
    const flags = readFileSync(join(ROOT, 'lib', 'pc5', 'featureFlags.ts'), 'utf8');
    expect(flags).toMatch(/isPc5BulkResolutionEnabled/);
    const consumers = pc5Sources().filter((f) => f.name !== 'lib/pc5/featureFlags.ts' && f.code.includes('isPc5BulkResolutionEnabled'));
    expect(consumers.map((c) => c.name), 'the bulk flag must have no consumer — PC5 ships no bulk action').toEqual([]);
  });
});

describe('PC5 K.20 — every route proves ownership rather than trusting a path parameter', () => {
  it('every PC5 route requires an authenticated, country-confirmed user before doing anything', () => {
    const routes = pc5Sources().filter((f) => f.name.startsWith('app/api/pc5/') && f.name.endsWith('route.ts'));
    expect(routes.length, 'PC5 must have routes to check').toBeGreaterThan(0);
    for (const r of routes) {
      expect(r.code, `${r.name} must require a user`).toMatch(/requireCountryConfirmedUser as requireUser/);
      expect(r.code, `${r.name} must short-circuit an unauthenticated caller`).toMatch(/if \(!user\) return unauthenticated!/);
    }
  });

  it('no PC5 route takes a userId from the request — the authenticated identity is the only one used', () => {
    for (const f of pc5Sources()) {
      if (!f.name.startsWith('app/api/pc5/')) continue;
      expect(f.code, `${f.name} must not read a user id from the body or query`).not.toMatch(/body\.(userId|user_id)|searchParams\.get\(['"]user/);
    }
  });

  it('the country code used for re-reconciliation is resolved from the profile, never from the request body', () => {
    const decide = readFileSync(join(PC5_API_DIR, 'resolutions', '[itemId]', 'decide', 'route.ts'), 'utf8');
    expect(decide).toMatch(/resolveHouseholdCountryForUser\(user\.id\)/);
    expect(stripComments(decide)).not.toMatch(/body\.countryCode|parsed\.data\.countryCode/);
  });
});

describe('PC5 — the migration claims a free version and reuses existing vocabularies', () => {
  it('is numbered 0153 and is the only 0153', () => {
    const files = readdirSync(join(ROOT, 'supabase', 'migrations')).filter((f) => f.startsWith('0153'));
    expect(files).toEqual(['0153_pc5_governed_resolution.sql']);
  });

  it('reproduces every pre-existing ii_audit_events event type verbatim when widening the CHECK', () => {
    const migration = readFileSync(MIGRATION, 'utf8');
    const prior = readFileSync(join(ROOT, 'supabase', 'migrations', '0067_ii_r9_review_centre.sql'), 'utf8');
    const priorTypes = [...prior.matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]);
    const r9Types = ['goal_allocation_created', 'forecast_integration_run', 'review_item_created', 'review_acknowledged', 'review_dismissed'];
    for (const t of r9Types) {
      expect(priorTypes, `${t} should exist in 0067`).toContain(t);
      expect(migration, `0153 must reproduce ${t}`).toContain(`'${t}'`);
    }
  });

  it('declares PC5 has no production authority', () => {
    expect(readFileSync(MIGRATION, 'utf8')).toMatch(/PRODUCTION AUTHORITY: NONE/);
  });
});
