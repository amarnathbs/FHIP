/**
 * Proves the dev server cannot see production keys: runs Next's OWN env loader (@next/env
 * loadEnvConfig, what `next dev` calls) over this worktree's .env.local in a child process whose env
 * comes from childEnv(), and checks every PRODUCTION_* key comes out EMPTY.
 * Negative control (--negative-control): the same child with the keys DELETED instead of blanked must
 * see them populated again from .env.local -- showing the check can fail.
 * Prints key names and emptiness only, never a value.
 */
import { spawnSync } from 'node:child_process';
import { childEnv, loadDevEnv } from './lib/env.mjs';

const negative = process.argv.includes('--negative-control');
const { env: fileEnv } = loadDevEnv();
const prodKeys = Object.keys(fileEnv).filter((k) => k.startsWith('PRODUCTION_'));
const env = childEnv();
if (negative) for (const k of prodKeys) delete env[k];
const probe = `const { loadEnvConfig } = require('@next/env'); loadEnvConfig(process.cwd(), true, { info(){}, error(){} });
const keys = ${JSON.stringify(prodKeys)}; console.log(JSON.stringify(Object.fromEntries(keys.map((k) => [k, (process.env[k] ?? '') === '' ? 'EMPTY' : 'POPULATED']))));`;
const r = spawnSync(process.execPath, ['-e', probe], { env, encoding: 'utf8' });
if (r.status !== 0) { console.error(r.stderr); process.exit(1); }
const seen = JSON.parse(r.stdout.trim());
console.log(`${negative ? 'NEGATIVE CONTROL (keys deleted, not blanked)' : 'childEnv()'}: ${JSON.stringify(seen)}`);
const populated = Object.values(seen).filter((v) => v === 'POPULATED').length;
if (!prodKeys.length) { console.error('no PRODUCTION_* keys in .env.local: nothing to prove'); process.exit(2); }
if (negative ? populated === 0 : populated > 0) { console.error('FAIL'); process.exit(1); }
console.log(negative ? 'negative control behaves as expected (deleting is NOT enough)' : 'PASS: Next sees no production key');
