// Pure helpers for scripts/check-deploy-size.mjs and tests/unit/deploySizeGuard.test.ts.
//
// WHAT THIS MODELS (read before trusting a number)
//   Amplify Hosting (WEB_COMPUTE) packages `.next` (amplify.yml: baseDirectory .next, files **\/*) plus the
//   node_modules files Next traced for the server. Amplify's own packager is not observable from this repository,
//   so the figure computed here is a MODEL, calibrated against the one real number the repo has
//   (docs/ops/AMPLIFY_BUILD_SIZE_FIX_2026-10-01.md, build #270: Amplify said 232,331,902 bytes, the model said
//   186,842,218 for the same commit, so the model UNDER-reports by ~45MB on the Windows machine it was calibrated
//   on). Use it for growth (deltas) and ranking, and keep the budget below the hard limit by that calibration gap.
//
//   modelled size = bytes of `.next` that survive the amplify.yml deletions
//                 + bytes of every file named by a `*.nft.json` that lives OUTSIDE `.next` (deduplicated)
//
//   amplify.yml deletions that are mirrored here (keep in sync with amplify.yml):
//     rm -rf .next/cache
//     find .next -type f -name '*.map' -not -path '.next/static/*' -delete
import fs from 'node:fs';
import path from 'node:path';

/** Amplify's hard ceiling for the build output (220 MiB), taken from the failure text of builds #127/#246/#270. */
export const AMPLIFY_MAX_BYTES = 230_686_720;

/** Normalise a path to forward slashes (Windows and Linux builds then classify identically). */
export function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * True when amplify.yml deletes this file before Amplify packages `.next`.
 * @param relPosix path relative to the `.next` directory, forward slashes
 */
export function isPrunedByAmplifyYml(relPosix) {
  if (relPosix === 'cache' || relPosix.startsWith('cache/')) return true;
  if (relPosix.endsWith('.map') && !(relPosix === 'static' || relPosix.startsWith('static/'))) return true;
  return false;
}

/** Depth-first walk that never follows symbolic links; calls `visit(absPath, stat)` for every regular file. */
export function walkFiles(dir, visit) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(abs, visit);
    else if (entry.isFile()) {
      try {
        visit(abs, fs.statSync(abs));
      } catch {
        /* vanished mid-walk: ignore */
      }
    }
  }
}

/** Bucket key of a `.next` file: first two path segments (e.g. `server/chunks`, `static/chunks`), else the first. */
export function nextBucket(relPosix) {
  const seg = relPosix.split('/');
  if (seg.length <= 1) return '(root files)';
  if (seg[0] === 'server' || seg[0] === 'static') return seg.length > 2 ? `${seg[0]}/${seg[1]}` : seg[0];
  return seg[0];
}

/**
 * Sizes the `.next` directory.
 * @returns {{ shippedBytes:number, prunedBytes:number, shippedFiles:number, byBucket:Map<string,number>, prunedByKind:{cache:number,maps:number}, files:Array<{rel:string,size:number}> }}
 */
export function measureNextDir(nextDir, { applyPrune = true } = {}) {
  const out = {
    shippedBytes: 0,
    prunedBytes: 0,
    shippedFiles: 0,
    byBucket: new Map(),
    prunedByKind: { cache: 0, maps: 0 },
    files: [],
  };
  walkFiles(nextDir, (abs, st) => {
    const rel = toPosix(path.relative(nextDir, abs));
    if (applyPrune && isPrunedByAmplifyYml(rel)) {
      out.prunedBytes += st.size;
      if (rel.startsWith('cache/')) out.prunedByKind.cache += st.size;
      else out.prunedByKind.maps += st.size;
      return;
    }
    out.shippedBytes += st.size;
    out.shippedFiles += 1;
    const b = nextBucket(rel);
    out.byBucket.set(b, (out.byBucket.get(b) ?? 0) + st.size);
    out.files.push({ rel, size: st.size });
  });
  return out;
}

/** Every `*.nft.json` under the `.next` directory (outside `cache/`, which the build deletes anyway). */
export function findNftFiles(nextDir) {
  const found = [];
  walkFiles(nextDir, (abs) => {
    if (!abs.endsWith('.nft.json')) return;
    const rel = toPosix(path.relative(nextDir, abs));
    if (rel === 'cache' || rel.startsWith('cache/')) return;
    found.push(abs);
  });
  return found;
}

/**
 * Union of the files named by every nft trace that live OUTSIDE `.next` (those inside are already counted by
 * measureNextDir). A name is resolved relative to the directory of the trace file that lists it.
 * @returns {Map<string, number>} absolute path -> size
 */
export function collectTracedFiles(nextDir) {
  const nextAbs = path.resolve(nextDir);
  const out = new Map();
  for (const nft of findNftFiles(nextDir)) {
    let json;
    try {
      json = JSON.parse(fs.readFileSync(nft, 'utf8'));
    } catch {
      continue;
    }
    const base = path.dirname(nft);
    for (const name of json.files ?? []) {
      const abs = path.resolve(base, name);
      if (abs === nextAbs || abs.startsWith(nextAbs + path.sep)) continue;
      if (out.has(abs)) continue;
      try {
        const st = fs.statSync(abs);
        if (st.isFile()) out.set(abs, st.size);
      } catch {
        /* listed but absent (optional dependency of another platform): not shipped */
      }
    }
  }
  return out;
}

/** `node_modules/@scope/name/...` or `node_modules/name/...` -> package name; null when not under node_modules. */
export function packageOf(absPath) {
  const p = toPosix(absPath);
  const marker = '/node_modules/';
  const at = p.lastIndexOf(marker);
  if (at < 0) return null;
  const rest = p.slice(at + marker.length).split('/');
  if (rest[0].startsWith('@')) return rest.length >= 2 ? `${rest[0]}/${rest[1]}` : rest[0];
  return rest[0];
}

/** Install directory of a traced package file (path up to and including the package folder). */
export function packageDirOf(absPath) {
  const p = toPosix(absPath);
  const marker = '/node_modules/';
  const at = p.lastIndexOf(marker);
  if (at < 0) return null;
  const rest = p.slice(at + marker.length).split('/');
  const take = rest[0].startsWith('@') ? 2 : 1;
  return p.slice(0, at + marker.length) + rest.slice(0, take).join('/');
}

/**
 * Groups traced files by package. `copies` is the number of distinct install directories (>1 means the package is
 * installed more than once, e.g. nested under another package).
 * @returns {Array<{name:string, bytes:number, files:number, copies:number}>} sorted by bytes desc
 */
export function groupTracedByPackage(traced) {
  const m = new Map();
  for (const [abs, size] of traced) {
    const name = packageOf(abs) ?? '(not in node_modules)';
    const dir = packageDirOf(abs) ?? '(none)';
    let e = m.get(name);
    if (!e) m.set(name, (e = { name, bytes: 0, files: 0, dirs: new Set() }));
    e.bytes += size;
    e.files += 1;
    e.dirs.add(dir);
  }
  return [...m.values()]
    .map((e) => ({ name: e.name, bytes: e.bytes, files: e.files, copies: e.dirs.size }))
    .sort((a, b) => b.bytes - a.bytes);
}

/** Native-addon packages carry their platform in the name; return the ones that are not for `linux`. */
export function nonLinuxNativePackages(packages) {
  return packages.filter((p) => /(win32|darwin|freebsd|android)/.test(p.name) && !/linux/.test(p.name));
}

/** Full measurement of a finished `next build`. */
export function measureDeploy(nextDir, { applyPrune = true } = {}) {
  const next = measureNextDir(nextDir, { applyPrune });
  const traced = collectTracedFiles(nextDir);
  let tracedBytes = 0;
  for (const s of traced.values()) tracedBytes += s;
  const packages = groupTracedByPackage(traced);
  return {
    nextBytes: next.shippedBytes,
    nextPrunedBytes: next.prunedBytes,
    nextPrunedByKind: next.prunedByKind,
    nextFiles: next.shippedFiles,
    nextByBucket: [...next.byBucket.entries()].map(([name, bytes]) => ({ name, bytes })).sort((a, b) => b.bytes - a.bytes),
    tracedBytes,
    tracedFiles: traced.size,
    packages,
    totalBytes: next.shippedBytes + tracedBytes,
  };
}

/** Verdict used by the CLI and its unit test. */
export function judge(totalBytes, { budgetBytes, limitBytes = AMPLIFY_MAX_BYTES }) {
  return {
    overBudget: totalBytes > budgetBytes,
    overLimit: totalBytes > limitBytes,
    budgetMarginBytes: budgetBytes - totalBytes,
    limitMarginBytes: limitBytes - totalBytes,
  };
}

export function formatBytes(n) {
  return `${n.toLocaleString('en-US')} B (${(n / 1048576).toFixed(2)} MiB)`;
}
