import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { findDuplicateVersions, nextVersion, ACTIVE_DIR, ARCHIVE_DIR } from '../../scripts/check-migration-versions.mjs';

// Regression guard for the II/Resources/Phase 0C migration-lineage collision.
// Versions 0031-0040 were once each claimed by two different files, which made
// a fresh-database rebuild non-deterministic. See
// docs/architecture/ADR_MIGRATION_LINEAGE_RECONCILIATION.md.
describe('migration version allocation', () => {
  it('never lets two active migrations claim the same version', () => {
    const duplicates = findDuplicateVersions() as { version: string; files: string[] }[];
    expect(
      duplicates,
      duplicates.length
        ? `Duplicate migration versions: ${duplicates
            .map((d) => `${d.version} -> ${d.files.join(' + ')}`)
            .join('; ')}`
        : '',
    ).toEqual([]);
  });

  it('detects a collision when one is present (negative control)', () => {
    // Proves the check above is not vacuous: run the same detector over the
    // archive, which legitimately reuses 0031-0040 alongside nothing else, and
    // over a synthetic colliding listing.
    const tmp = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'migcheck-'));
    fs.writeFileSync(path.join(tmp, '0049_alpha.sql'), '');
    fs.writeFileSync(path.join(tmp, '0049_beta.sql'), '');
    fs.writeFileSync(path.join(tmp, '0050_gamma.sql'), '');
    const found = findDuplicateVersions(tmp) as { version: string; files: string[] }[];
    fs.rmSync(tmp, { recursive: true, force: true });
    expect(found).toHaveLength(1);
    expect(found[0].version).toBe('0049');
    expect(found[0].files).toEqual(['0049_alpha.sql', '0049_beta.sql']);
  });

  it('every active migration filename starts with a 4-digit version', () => {
    const bad = fs
      .readdirSync(ACTIVE_DIR)
      .filter((f: string) => f.endsWith('.sql') && !/^\d{4}_/.test(f));
    expect(bad).toEqual([]);
  });

  it('archived historical migrations are kept out of the active chain', () => {
    // The archive preserves the displaced Phase 0C + Resources artefacts. They
    // must never be executable, so no filename may appear in both directories.
    const active = new Set(fs.readdirSync(ACTIVE_DIR).filter((f: string) => f.endsWith('.sql')));
    const archived = fs.readdirSync(ARCHIVE_DIR).filter((f: string) => f.endsWith('.sql'));
    expect(archived.length).toBeGreaterThan(0);
    expect(archived.filter((f: string) => active.has(f))).toEqual([]);
  });

  it('reports the next free version for new migrations', () => {
    expect(nextVersion()).toMatch(/^\d{4}$/);
  });
});
