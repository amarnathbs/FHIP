/**
 * Sign an allocated fixture user in for localhost journeys.
 *
 *   node scripts/canonical_cert/signin.mjs --range A --email forecast.tc001@example.test [--method mint|password]
 *   node scripts/canonical_cert/signin.mjs --range A --email ... --browser-js   # prints document.cookie JS for
 *                                                                               # the 127.0.0.1:<port> tab
 *   node scripts/canonical_cert/signin.mjs --revoke --email ...                 # end the session
 *
 * Refuses an email outside the given range (USER_RANGES.json), so certifiers cannot collide.
 * Prints only the user id, method and cookie NAMES -- never a token (except --browser-js, on request).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signIn, revoke, loadSession, browserCookieScript } from './lib/session.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const email = arg('--email');
if (!email) { console.error('usage: signin.mjs --range A --email <fixture email> [--method mint|password] [--browser-js] | --revoke --email <email>'); process.exit(1); }

// NOTE: no process.exit() after network I/O -- on Windows/Node 24 it can trip a libuv assertion
// (UV_HANDLE_CLOSING) and turn a success into exit 127. process.exitCode is used instead.
async function main() {
  if (args.includes('--revoke')) {
    await revoke(email);
    console.log(`revoked session for ${email}`);
    return;
  }
  const range = arg('--range');
  const ranges = JSON.parse(fs.readFileSync(path.join(here, 'USER_RANGES.json'), 'utf8')).ranges;
  const entry = ranges[range]?.find((u) => u.email === email);
  if (!entry) { console.error(`REFUSING: ${email} is not in range ${range}. Use only your own range (users.mjs show ${range ?? '<range>'}).`); process.exitCode = 1; return; }
  const method = arg('--method') ?? (entry.signIn.includes('password') ? 'password' : 'mint');
  if (!entry.signIn.includes(method)) { console.error(`REFUSING: ${entry.set} users support ${entry.signIn.join('/')} only.`); process.exitCode = 1; return; }
  if (args.includes('--browser-js')) { console.log(browserCookieScript(loadSession(email))); return; }
  const r = await signIn(email, { method });
  if (entry.devUserId && r.userId !== entry.devUserId) throw new Error(`signed-in id ${r.userId} != allocated id ${entry.devUserId}`);
  console.log(`signed in ${email} (${r.userId}) via ${r.method}; cookies: ${r.cookieNames.join(', ')}; session file: ${path.relative(process.cwd(), r.file)}`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
