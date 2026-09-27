/**
 * End EVERY auth session of the given range-B users (global sign-out). Used when the harness's own
 * `signin.mjs --revoke` (scope 'local') fails because the stored access token has expired: the stale
 * sessions would otherwise stay open server-side. Mints one fresh session (existing users only), then
 * signs out with scope 'global', which ends that one and every older one. Prints no token.
 *
 *   node scripts/canonical_cert/econ/revoke_all_sessions.mjs a@x b@y ...
 */
import fs from 'node:fs';
import { signIn, loadSession } from '../lib/session.mjs';
import { serviceClient } from '../lib/env.mjs';

const admin = await serviceClient();
for (const email of process.argv.slice(2)) {
  try {
    await signIn(email, { method: 'mint' });
    const s = loadSession(email);
    const raw = Object.entries(s.cookies).filter(([n]) => /^sb-[a-z0-9]+-auth-token(\.\d+)?$/.test(n))
      .sort(([a], [b]) => Number(a.split('.')[1] ?? -1) - Number(b.split('.')[1] ?? -1)).map(([, v]) => v).join('');
    const decoded = raw.startsWith('base64-') ? Buffer.from(raw.slice(7), 'base64url').toString('utf8') : raw;
    const { error } = await admin.auth.admin.signOut(JSON.parse(decoded).access_token, 'global');
    const file = `${process.cwd()}/.canonical-cert/session-${email.replace(/[^a-z0-9._-]/gi, '_')}.json`;
    fs.rmSync(file, { force: true });
    console.log(`${email}: ${error ? `FAILED ${error.message}` : 'all sessions ended (global sign-out)'}`);
    if (error) process.exitCode = 1;
  } catch (e) {
    console.log(`${email}: FAILED ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
}
