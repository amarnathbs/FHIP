// M5 (Part L.4) — runner for the real-OpenAI provider proof.
//
// Exists because the proof reads its configuration from `process.env`
// directly (by design: it must prove the APPLICATION's own provider
// selection, not a harness's), while this repository keeps its secrets in
// `.env.local`. This loads that file and spawns vitest with the opt-in gate
// set, so no secret is ever typed on a command line, written to a shell
// history, or interpolated into a log line.
//
// `.env.local` here is UTF-8 with a BOM and CRLF endings — the exact hazard
// M3 recorded as M3-OPEN-3, where `split('\n')` plus a `(.*)$` regex silently
// matches ZERO keys and yields an empty environment with no error. Parsed
// defensively, and asserted non-empty before anything is spawned.
import fs from 'fs';
import crypto from 'crypto';
import { spawnSync } from 'child_process';

const raw = fs.readFileSync('.env.local', 'utf8').replace(/^﻿/, '');
const env = {};
for (const line of raw.split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

if (!env.AIE_OPENAI_API_KEY) {
  console.error('FAIL: AIE_OPENAI_API_KEY not parsed from .env.local — refusing to run.');
  process.exit(1);
}
console.log(`parsed ${Object.keys(env).length} keys from .env.local (values never printed)`);
console.log(`AIE_OPENAI_API_KEY present: yes (length class ${env.AIE_OPENAI_API_KEY.length > 40 ? 'long' : 'short'})`);

// ---------------------------------------------------------------------------
// AIE_MASK_TOKEN_ENCRYPTION_KEY — the operator item (OA-6) that is STILL open.
//
// M2's H.6 proof passed 4/4 when masking used the counter-based token scheme,
// which derived nothing from a key. M3 replaced that with a keyed one-way
// HMAC (`identifierToken.ts`), which REQUIRES this key and throws without it.
// So M2's recorded 4/4 is no longer reproducible as recorded: re-run today
// with the environment as it actually is, it fails 3/4 at the masking stage.
// That failure is CORRECT — it is the fail-closed design working — but under
// the Part W standard it means M2's H.6 evidence cannot be cited as still
// holding without saying so.
//
// To turn "unexercisable" into real evidence, an EPHEMERAL key is generated
// here when the environment has none. It is:
//   * random per run, held only in this process's memory,
//   * passed to the child only through its env, never a command line,
//   * never printed, never written to disk, never committed,
//   * NOT a provisioning action — OA-6 remains open and is reported as open.
// A run under an ephemeral key proves the CODE PATH works; it does not prove
// the environment is configured, and this script says which it did.
const hadEnvKey = Boolean(env.AIE_MASK_TOKEN_ENCRYPTION_KEY);
if (!hadEnvKey) {
  env.AIE_MASK_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
}
console.log(
  `AIE_MASK_TOKEN_ENCRYPTION_KEY: ${
    hadEnvKey
      ? 'PROVISIONED in .env.local'
      : 'ABSENT from .env.local (OA-6 still open) — using an EPHEMERAL in-memory key for this run only'
  }`
);

const result = spawnSync(
  'npx',
  ['vitest', 'run', '--config', 'vitest.live-dev.config.ts', 'tests/live-dev/aieM2RealProviderProof.live.test.ts'],
  {
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      ...env,
      AIE_M2_LIVE_PROVIDER_PROOF: '1',
      AIE_AI_PROVIDER: 'openai',
      AIE_AI_FALLBACK_ENABLED: 'true',
    },
  }
);
process.exit(result.status ?? 1);
