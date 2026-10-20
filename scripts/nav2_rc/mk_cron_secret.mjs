// Writes the server's CRON_SECRET (from this worktree's DEV-only .env.local) to test-artifacts/nav2_stage3/.cron_secret, where the Stage 3 journeys read it.
// The file is a secret: it is deleted by the cleanup script and must never be committed. Prints only the length.
import fs from 'node:fs';
import path from 'node:path';
import { loadDevEnv } from '../canonical_cert/lib/env.mjs';
const d = loadDevEnv();
const s = d.env.CRON_SECRET;
if (!s) throw new Error('no CRON_SECRET');
const dir = path.resolve(process.cwd(), 'test-artifacts', 'nav2_stage3');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, '.cron_secret'), s);
console.log('cron secret file written, length', s.length);
