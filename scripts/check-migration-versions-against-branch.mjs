#!/usr/bin/env node
/**
 * Cross-branch migration-collision guard.
 *
 * `scripts/check-migration-versions.mjs` only ever inspects ONE checked-out
 * working tree — it catches two files claiming the same version inside a
 * single branch, but it structurally cannot catch two DIFFERENT branches
 * each independently allocating "the next number after main" while neither
 * can see the other's allocation. That is exactly what happened between
 * `feature/financial-data-hub-fdh-3-document-lifecycle` and
 * `feature/investment-intelligence-r6-security-final`: both forked from an
 * ancestor of `main`, both landed on `0058`, and neither branch's own guard
 * run ever had the other file to compare against.
 *
 * This script closes that gap. It compares the ACTIVE migration directory
 * (supabase/migrations) as committed on HEAD (or a given ref) against the
 * same directory on a target branch/ref (default: origin/main) using `git
 * show`, so it works even against a ref that has never been checked out.
 *
 * For every version number present on either side:
 *   - version only on one side                          -> fine (new work)
 *   - version on both sides, same filename, same bytes   -> fine (shared
 *     ancestry — e.g. after a real merge, or a rename that both sides now
 *     carry identically)
 *   - version on both sides, same filename, different
 *     bytes                                              -> COLLISION
 *   - version on both sides, DIFFERENT filenames          -> COLLISION
 *     (this is the FDH-3/R6 case: two independently-authored files that
 *     happen to claim the same version number)
 *
 * Archived migrations (supabase/migration_archive) are never inspected —
 * same scope rule as check-migration-versions.mjs. They are historical
 * artefacts, not active chain members, and legitimately reuse old numbers.
 *
 * Usage:
 *   node scripts/check-migration-versions-against-branch.mjs [--against=<ref>] [--ref=<ref>]
 *   npm run check:migrations:against-main
 *
 * Options:
 *   --against=<ref>   Target ref to compare against. Default: origin/main
 *   --ref=<ref>        "Our" ref to read instead of the working tree/HEAD.
 *                       Default: HEAD (uses `git show <ref>:<path>` too, so
 *                       this also works uncommitted-changes-free against a
 *                       branch tip without checking it out).
 *
 * Exit: 0 = no cross-branch collision; 1 = collision found; 2 = usage/git error.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACTIVE_SUBPATH = 'supabase/migrations';

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

/** List `{name, blobSha}` for every .sql file under supabase/migrations at `ref`. */
export function listMigrationsAtRef(ref) {
  let out;
  try {
    out = git(['ls-tree', '-r', ref, '--', ACTIVE_SUBPATH]);
  } catch (e) {
    throw new Error(`Could not read ${ACTIVE_SUBPATH} at ref "${ref}": ${e.message}`);
  }
  const files = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    // "<mode> blob <sha>\t<path>"
    const [meta, filePath] = line.split('\t');
    const parts = meta.split(' ');
    const blobSha = parts[2];
    const name = filePath.slice(ACTIVE_SUBPATH.length + 1);
    if (name.endsWith('.sql')) files.push({ name, blobSha });
  }
  return files;
}

/** @returns {Map<string, {name: string, blobSha: string}[]>} version -> files, for one ref */
function byVersion(files) {
  const m = new Map();
  for (const f of files) {
    const match = /^(\d+)_/.exec(f.name);
    if (!match) continue; // non-conforming names are check-migration-versions.mjs's job, not ours
    const version = match[1];
    if (!m.has(version)) m.set(version, []);
    m.get(version).push(f);
  }
  return m;
}

/**
 * Compare two refs' active migration directories.
 * @returns {{version: string, ours: {name:string,blobSha:string}, theirs: {name:string,blobSha:string}, reason: string}[]}
 */
export function findCrossBranchCollisions(oursFiles, theirsFiles) {
  const ours = byVersion(oursFiles);
  const theirs = byVersion(theirsFiles);
  const collisions = [];
  for (const [version, ourFiles] of ours) {
    if (!theirs.has(version)) continue;
    const theirFiles = theirs.get(version);
    // Compare every pairing on this version; a collision is any pairing that
    // isn't a byte-identical same-name match.
    for (const of_ of ourFiles) {
      for (const tf of theirFiles) {
        const sameFile = of_.name === tf.name && of_.blobSha === tf.blobSha;
        if (sameFile) continue; // legitimate shared ancestry
        const reason =
          of_.name !== tf.name
            ? `different files claim version ${version}`
            : `same filename "${of_.name}" but different content (blob ${of_.blobSha} vs ${tf.blobSha})`;
        collisions.push({ version, ours: of_, theirs: tf, reason });
      }
    }
  }
  return collisions;
}

function parseArgs(argv) {
  const opts = { against: 'origin/main', ref: 'HEAD' };
  for (const arg of argv) {
    const m = /^--(against|ref)=(.*)$/.exec(arg);
    if (m) opts[m[1]] = m[2];
  }
  return opts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { against, ref } = parseArgs(process.argv.slice(2));
  let oursFiles, theirsFiles;
  try {
    oursFiles = listMigrationsAtRef(ref);
    theirsFiles = listMigrationsAtRef(against);
  } catch (e) {
    console.error(`\nCROSS-BRANCH MIGRATION GUARD: could not compare — ${e.message}\n`);
    process.exit(2);
  }
  const collisions = findCrossBranchCollisions(oursFiles, theirsFiles);
  if (collisions.length > 0) {
    console.error(`\nCROSS-BRANCH MIGRATION VERSION COLLISION ("${ref}" vs "${against}")\n`);
    for (const c of collisions) {
      console.error(`  version ${c.version}: ${c.reason}`);
      console.error(`    ${ref}:      supabase/migrations/${c.ours.name}  (blob ${c.ours.blobSha.slice(0, 12)})`);
      console.error(`    ${against}: supabase/migrations/${c.theirs.name}  (blob ${c.theirs.blobSha.slice(0, 12)})`);
    }
    console.error(
      '\nA branch carrying a migration must be re-diffed against the merge target before\n' +
      'merging. If your migration collides with one already on the target branch,\n' +
      'renumber YOURS to the next free version after the target branch\'s highest — never\n' +
      'renumber a migration already applied to a shared environment; re-emit or shift\n' +
      'forward instead (see docs/architecture/ADR_0058_FDH3_II_R6_RECONCILIATION.md and\n' +
      'docs/architecture/ADR_MIGRATION_LINEAGE_RECONCILIATION.md for two worked examples).\n'
    );
    process.exit(1);
  }
  console.log(`OK: no cross-branch migration collisions between "${ref}" (${oursFiles.length} files) and "${against}" (${theirsFiles.length} files).`);
  process.exit(0);
}
