/**
 * Start the Next.js dev server on LOCALHOST, pointed at DEV, on a given port.
 *
 *   node scripts/canonical_cert/dev_server.mjs --range A        # port from RANGE_PORTS (A=3971 ... D=3974)
 *   node scripts/canonical_cert/dev_server.mjs --port 3975
 *
 * - Env comes from .env.local (worktree, else D:\FHIP\.env.local); lib/env.mjs REFUSES unless it is DEV.
 * - Every PRODUCTION_* variable is BLANKED in the child's environment ('' -- deleting is not enough,
 *   because Next re-reads .env.local and only fills keys that are undefined).
 * - AIE_OPENAI_API_KEY is blanked too unless --allow-openai is passed: a certification journey must not
 *   make paid OpenAI calls by accident (the native parsers never need it).
 * - Binds to 127.0.0.1 only (-H), never to the LAN.
 * - One dev server per WORKTREE (they share .next/). Each certifier runs in its own worktree.
 * - Bundler: when node_modules is a junction/symlink (the standard agent-worktree setup), Turbopack
 *   refuses to start ("Symlink [project]/node_modules is invalid, it points out of the filesystem root",
 *   because next.config pins turbopack.root to the worktree), so --webpack is used automatically.
 *   Force either with --webpack / --turbopack.
 *
 * Wait for readiness with:  node scripts/canonical_cert/dev_server.mjs --wait --port 3971
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { childEnv, fingerprint, loadDevEnv } from './lib/env.mjs';
import { RANGE_PORTS } from './lib/users.mjs';

const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const range = arg('--range');
const port = Number(arg('--port') ?? (range ? RANGE_PORTS[range] : NaN));
if (!Number.isInteger(port)) { console.error('usage: dev_server.mjs --range A|B|C|D  or  --port N  [--wait] [--allow-openai]'); process.exit(1); }

if (args.includes('--wait')) {
  const deadline = Date.now() + 240_000;
  let ready = false;
  while (!ready && Date.now() <= deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/login`, { redirect: 'manual' });
      if (r.status < 500) { console.log(`ready: http://127.0.0.1:${port} (GET /login -> ${r.status})`); ready = true; }
    } catch { /* not up yet */ }
    if (!ready) await new Promise((r) => setTimeout(r, 2000));
  }
  if (!ready) { console.error(`not ready after 240s on port ${port}`); process.exitCode = 1; }
} else {

const { ref, anonKey, serviceKey } = loadDevEnv();
const env = childEnv();
if (!args.includes('--allow-openai')) env.AIE_OPENAI_API_KEY = ''; // '' (not delete): see childEnv()
// --count-requests: preload count_supabase_requests.cjs in the server process(es), so a journey can
// record how many Supabase round trips each app request makes (timing model for the 28 s limit).
if (args.includes('--count-requests')) {
  const preload = new URL('./count_supabase_requests.cjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --require ${preload}`.trim();
  console.log('counting Supabase requests per server process (.canonical-cert/sb-requests-<pid>.json)');
}
console.log(`next dev -> http://127.0.0.1:${port}  (DEV project ${ref}; anon ${fingerprint(anonKey)}, service ${fingerprint(serviceKey)}; PRODUCTION_* stripped; OpenAI key ${env.AIE_OPENAI_API_KEY ? 'KEPT' : 'removed'})`);
let linkedModules = false;
try { linkedModules = fs.lstatSync('node_modules').isSymbolicLink(); } catch { /* no node_modules */ }
const bundler = args.includes('--turbopack') ? '--turbopack' : args.includes('--webpack') || linkedModules ? '--webpack' : '--turbopack';
console.log(`bundler: ${bundler}${linkedModules ? ' (node_modules is a junction/symlink)' : ''}`);
const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['next', 'dev', bundler, '-p', String(port), '-H', '127.0.0.1'], {
  env, stdio: 'inherit', shell: process.platform === 'win32',
});
child.on('exit', (c) => process.exit(c ?? 0));
}
