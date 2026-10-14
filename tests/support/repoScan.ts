/**
 * Fast repository scans for the standing CI contracts.
 *
 * Reading thousands of source files one by one through the Node fs API takes minutes on a loaded Windows machine (the
 * repo-walking tests in this repository are known to time out under parallel load). `git ls-files` / `git grep` answer
 * the same questions from the index in about a second. They include UNTRACKED files too (`--cached --others`,
 * `--untracked`), so a brand-new route that has not been `git add`ed yet is still scanned. If git is unavailable the
 * helpers fall back to walking the directories, so the contract never silently scans nothing.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const posix = (p: string) => p.split('\\').join('/');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === '.git') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(posix(relative(ROOT, p)));
  }
  return out;
}

function git(args: string[]): string[] | null {
  try {
    const out = execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch (e) {
    // `git grep` exits 1 when nothing matches: that is an answer (empty), not a failure.
    if ((e as { status?: number }).status === 1) return [];
    return null;
  }
}

/** Every file (tracked or untracked, not ignored) under the given repo-relative paths. */
export function listFiles(paths: string[]): string[] {
  const viaGit = git(['ls-files', '--cached', '--others', '--exclude-standard', '--', ...paths]);
  if (viaGit && viaGit.length > 0) return viaGit.map(posix);
  return paths.flatMap((p) => {
    try {
      return statSync(join(ROOT, p)).isDirectory() ? walk(join(ROOT, p)) : [posix(p)];
    } catch {
      return [];
    }
  });
}

/** Files under `paths` whose content matches the extended regex (a SUPERSET filter is fine: callers re-check precisely). */
export function grepFiles(extendedRegex: string, paths: string[]): string[] {
  const viaGit = git(['grep', '--untracked', '-l', '-I', '-E', extendedRegex, '--', ...paths]);
  if (viaGit) return viaGit.map(posix);
  // Fallback: no git. Walk and test in JS (the regex dialect for these simple patterns is the same).
  const re = new RegExp(extendedRegex);
  return paths.flatMap((p) => listFiles([p])).filter((f) => re.test(readFileSync(join(ROOT, f), 'utf8')));
}
