/**
 * M12E — launches the Next dev server for section 16's accessibility re-run.
 *
 * WHY THIS EXISTS. `scripts/m12c_pc5_accessibility_live_dev.ts` requires a
 * running dev server with `AIE_REVIEW_PC5_PROJECTION_ENABLED=true`. An agent
 * worktree has no `.env.local` of its own, and this mission's standing
 * discipline is that none is ever CREATED in a worktree — no secret is written
 * to any persisted config file. So the shared checkout's copy is READ into this
 * process's environment and handed to the child, exactly the way every other
 * live-DEV script in `scripts/` sources its credentials.
 *
 * No credential is printed, copied to disk, or committed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CANDIDATES = ['.env.local', path.join('D:', 'FHIP', '.env.local')];
const envPath = CANDIDATES.find((p) => fs.existsSync(p));
if (!envPath) {
  console.error('REFUSING: no .env.local found in the worktree or the shared checkout.');
  process.exit(1);
}

const env = { ...process.env };
for (const line of fs.readFileSync(envPath, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

// Hard safety: never point a dev server at production.
if (env.PRODUCTION_SUPABASE_URL && env.NEXT_PUBLIC_SUPABASE_URL === env.PRODUCTION_SUPABASE_URL) {
  console.error('REFUSING: NEXT_PUBLIC_SUPABASE_URL equals PRODUCTION_SUPABASE_URL.');
  process.exit(1);
}

env.AIE_REVIEW_PC5_PROJECTION_ENABLED = 'true';

const port = process.argv[2] ?? '3958';
console.log(`launching next dev on port ${port} (env names loaded: ${Object.keys(env).filter((k) => /SUPABASE|AIE_/.test(k)).sort().join(', ')})`);

const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['next', 'dev', '-p', port], {
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
child.on('exit', (c) => process.exit(c ?? 0));
