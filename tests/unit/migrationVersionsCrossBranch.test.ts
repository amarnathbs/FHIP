import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  findCrossBranchCollisions,
  listMigrationsAtRef,
} from '../../scripts/check-migration-versions-against-branch.mjs';

// Regression guard for the FDH-3 / Investment Intelligence R6 migration-0058
// collision: two unmerged sibling branches, forked from different points on
// main's history, each independently allocated "0058" for genuinely
// unrelated schema. `check-migration-versions.mjs` (the single-working-tree
// guard) could not have caught this — neither branch's own checkout ever
// contained the other branch's file. This suite exercises the cross-branch
// guard's pure comparison function with synthetic file lists (no real git
// refs needed) plus one check against real repository history proving the
// tool would have caught the actual historical collision, and one proving
// archived migrations are excluded.
// See docs/architecture/ADR_0058_FDH3_II_R6_RECONCILIATION.md.

describe('cross-branch migration collision guard', () => {
  it('(a) same version + byte-identical content on both sides -> not a collision', () => {
    const ours = [{ name: '0060_shared.sql', blobSha: 'aaaa1111' }];
    const theirs = [{ name: '0060_shared.sql', blobSha: 'aaaa1111' }];
    expect(findCrossBranchCollisions(ours, theirs)).toEqual([]);
  });

  it('(b) same version, different filenames -> FAIL with both filenames named', () => {
    const ours = [{ name: '0058_fdh3_document_lifecycle_upload_storage.sql', blobSha: '8baa342c5506' }];
    const theirs = [{ name: '0058_ii_r6_p1_tax_engine.sql', blobSha: 'f23a79dc20ff' }];
    const collisions = findCrossBranchCollisions(ours, theirs);
    expect(collisions).toHaveLength(1);
    expect(collisions[0].version).toBe('0058');
    expect(collisions[0].ours.name).toBe('0058_fdh3_document_lifecycle_upload_storage.sql');
    expect(collisions[0].theirs.name).toBe('0058_ii_r6_p1_tax_engine.sql');
    expect(collisions[0].reason).toMatch(/different files claim version 0058/);
  });

  it('(b2) same version, SAME filename but different content -> FAIL, not silently treated as identical', () => {
    const ours = [{ name: '0060_seed.sql', blobSha: 'edited0001' }];
    const theirs = [{ name: '0060_seed.sql', blobSha: 'original01' }];
    const collisions = findCrossBranchCollisions(ours, theirs);
    expect(collisions).toHaveLength(1);
    expect(collisions[0].reason).toMatch(/different content/);
  });

  it('(c) a new unique migration version on our side only -> PASS (no collision)', () => {
    const ours = [
      { name: '0058_fdh3_document_lifecycle_upload_storage.sql', blobSha: '8baa342c5506' },
      { name: '0064_new_unique_work.sql', blobSha: 'brandnew01' },
    ];
    const theirs = [{ name: '0058_fdh3_document_lifecycle_upload_storage.sql', blobSha: '8baa342c5506' }];
    expect(findCrossBranchCollisions(ours, theirs)).toEqual([]);
  });

  it('(d) archived (non-executable) migration duplicates are never fed to the comparator, so they cannot collide', () => {
    // The guard only ever calls findCrossBranchCollisions with files already
    // scoped to supabase/migrations (via listMigrationsAtRef, which reads
    // exactly that subpath). supabase/migration_archive legitimately reuses
    // old version numbers and must never surface here.
    const ours = listMigrationsAtRef('HEAD');
    const archiveDir = path.resolve(__dirname, '../../supabase/migration_archive');
    const archivedNames = fs.existsSync(archiveDir)
      ? fs.readdirSync(archiveDir).filter((f) => f.endsWith('.sql'))
      : [];
    expect(archivedNames.length).toBeGreaterThan(0); // sanity: the archive is non-empty and thus a real test
    const activeNames = new Set(ours.map((f) => f.name));
    for (const archived of archivedNames) {
      expect(activeNames.has(archived)).toBe(false);
    }
  });

  it('reproduces the actual historical FDH-3/R6 collision from real git history', () => {
    // a471a1b = FDH-3 branch HEAD; 3af02e3 = II R6-security-final branch HEAD.
    // Both refs must still be reachable locally for this test to be meaningful.
    const oursFiles = listMigrationsAtRef('a471a1b');
    const theirsFiles = listMigrationsAtRef('3af02e3');
    const collisions = findCrossBranchCollisions(oursFiles, theirsFiles);
    const at0058 = collisions.find((c) => c.version === '0058');
    expect(at0058).toBeDefined();
    expect([at0058!.ours.name, at0058!.theirs.name].sort()).toEqual([
      '0058_fdh3_document_lifecycle_upload_storage.sql',
      '0058_ii_r6_p1_tax_engine.sql',
    ]);
  });

  it('the reconciled integration branch (HEAD) has zero collisions against origin/main', () => {
    const ours = listMigrationsAtRef('HEAD');
    const theirs = listMigrationsAtRef('origin/main');
    expect(findCrossBranchCollisions(ours, theirs)).toEqual([]);
  });
});
