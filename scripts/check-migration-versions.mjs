#!/usr/bin/env node
/**
 * Migration-collision guard.
 *
 * Three feature streams (Investment Intelligence, Resources, Phase 0C) were
 * once developed in parallel off main and each allocated the same "next"
 * migration numbers, so versions 0031-0040 were claimed twice. DEV survived it
 * because every migration was applied by hand, but no fresh database could be
 * rebuilt deterministically: two different files claimed the same version.
 *
 * This guard fails the build if two files in the ACTIVE migration directory
 * ever share a version prefix again. It deliberately inspects only
 * supabase/migrations — supabase/migration_archive holds preserved historical
 * artefacts that are never executed and are expected to reuse old numbers.
 *
 * Usage:  node scripts/check-migration-versions.mjs
 * Exit:   0 = one file per version; 1 = duplicate versions found.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ACTIVE_DIR = path.join(ROOT, 'supabase', 'migrations');
export const ARCHIVE_DIR = path.join(ROOT, 'supabase', 'migration_archive');

/** @returns {{version: string, files: string[]}[]} duplicate groups, if any */
export function findDuplicateVersions(dir = ACTIVE_DIR) {
  const byVersion = new Map();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql'))) {
    const m = /^(\d+)_/.exec(file);
    if (!m) throw new Error(`Migration filename does not start with a numeric version: ${file}`);
    const version = m[1];
    if (!byVersion.has(version)) byVersion.set(version, []);
    byVersion.get(version).push(file);
  }
  return [...byVersion.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([version, files]) => ({ version, files: files.sort() }));
}

/** @returns {string[]} version prefixes with no file, i.e. holes in the chain */
export function findVersionGaps(dir = ACTIVE_DIR) {
  const versions = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => parseInt(/^(\d+)_/.exec(f)[1], 10))
    .sort((a, b) => a - b);
  const gaps = [];
  for (let v = versions[0]; v < versions[versions.length - 1]; v++) {
    if (!versions.includes(v)) gaps.push(String(v).padStart(4, '0'));
  }
  return gaps;
}

/** The version a new migration should claim. */
export function nextVersion(dir = ACTIVE_DIR) {
  const max = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .reduce((acc, f) => Math.max(acc, parseInt(/^(\d+)_/.exec(f)[1], 10)), 0);
  return String(max + 1).padStart(4, '0');
}

// Run directly (not when imported by the test suite).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dupes = findDuplicateVersions();
  const count = fs.readdirSync(ACTIVE_DIR).filter((f) => f.endsWith('.sql')).length;
  if (dupes.length > 0) {
    console.error('\nMIGRATION VERSION COLLISION\n');
    for (const { version, files } of dupes) {
      console.error(`  version ${version} is claimed by ${files.length} files:`);
      for (const f of files) console.error(`    - supabase/migrations/${f}`);
    }
    console.error(
      '\nA fresh database cannot be rebuilt deterministically while two files share a\n' +
      'version. Renumber whichever migration is still unmerged and unapplied to\n' +
      `version ${nextVersion()} or later. Never renumber a migration that has already\n` +
      'been applied to a shared environment — re-emit its effects forward instead.\n' +
      'See docs/architecture/ADR_MIGRATION_LINEAGE_RECONCILIATION.md.\n'
    );
    process.exit(1);
  }
  const gaps = findVersionGaps();
  console.log(`OK: ${count} active migrations, one file per version, next version is ${nextVersion()}.`);
  if (gaps.length) console.log(`Note: unused version numbers in the chain: ${gaps.join(', ')}`);
  process.exit(0);
}
