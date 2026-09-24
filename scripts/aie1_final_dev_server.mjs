/**
 * AIE-1 final production completion (2026-09-25) -- launches `next dev`
 * against DEV with the production AIE flag shape PLUS every per-class AI flag,
 * so the DEV journeys exercise what a full production activation would run.
 *
 * Credentials are READ from the shared checkout's .env.local and from the
 * local AWS CLI profile into this process's environment and handed to the
 * child. Nothing is printed, written to disk or committed. PRODUCTION_* values
 * are REMOVED from the child's environment so no code path in the dev server
 * can reach production, and the server refuses to start unless the Supabase
 * host is the DEV project.
 *
 * Run: node scripts/aie1_final_dev_server.mjs [port]
 */
import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const DEV_HOST = 'vqycarelcoijzwlpkpcz.supabase.co';
const env = { ...process.env };
for (const line of fs.readFileSync('D:/FHIP/.env.local', 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
  const i = line.indexOf('=');
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, '');
}
for (const k of Object.keys(env)) if (k.startsWith('PRODUCTION_')) delete env[k];
if (new URL(env.NEXT_PUBLIC_SUPABASE_URL).host !== DEV_HOST) {
  console.error('REFUSING: NEXT_PUBLIC_SUPABASE_URL is not the DEV project.');
  process.exit(2);
}

const aws = (k) => execFileSync('aws', ['configure', 'get', k], { encoding: 'utf8' }).trim();

Object.assign(env, {
  // Real S3 + GuardDuty (DEV bucket, DEV plan 7ad04d8fdccaad20ae8f).
  AIE_REAL_MALWARE_SCAN_ENABLED: 'true',
  AIE_MALWARE_S3_BUCKET: 'fhip-aie-dev-01-879807128139-ap-southeast-2-an',
  AIE_MALWARE_S3_REGION: 'ap-southeast-2',
  AIE_MALWARE_S3_ACCOUNT_ID: '879807128139',
  AIE_MALWARE_AWS_ACCESS_KEY_ID: aws('aws_access_key_id'),
  AIE_MALWARE_AWS_SECRET_ACCESS_KEY: aws('aws_secret_access_key'),
  // Production's global AIE flags.
  AIE_DOCUMENT_INTAKE_ENABLED: 'true',
  AIE_AI_FALLBACK_ENABLED: 'true',
  AIE_II_ADAPTER_ENABLED: 'true',
  // Real GPT-4o mini through the application path.
  AIE_AI_PROVIDER: 'openai',
  AIE_AI_MODEL: 'gpt-4o-mini',
  // Ephemeral masking key: tokens are one-way, nothing needs it later.
  AIE_MASK_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  // Every per-class AI flag ON (production has them unset).
  AIE_PAYSLIP_AI_FALLBACK_ENABLED: 'true',
  AIE_BANK_STATEMENT_AI_FALLBACK_ENABLED: 'true',
  AIE_INVESTMENT_STATEMENT_AI_FALLBACK_ENABLED: 'true',
  AIE_LIABILITY_AI_FALLBACK_ENABLED: 'true',
  AIE_RETIREMENT_STATEMENT_AI_FALLBACK_ENABLED: 'true',
  II_AI_FALLBACK_ENABLED: 'true',
  // Production's cohort SHAPE: enforced, EMAIL-ONLY allowlist (synthetic).
  AIE_PILOT_COHORT_ENFORCED: 'true',
  AIE_PILOT_COHORT_EMAILS: 'aie1-final-pilot-a@fhip-test.invalid,aie1-final-pilot-b@fhip-test.invalid',
  II_AI_FALLBACK_PILOT_COHORT_ENFORCED: 'true',
  II_AI_FALLBACK_PILOT_COHORT_EMAILS: 'aie1-final-pilot-a@fhip-test.invalid,aie1-final-pilot-b@fhip-test.invalid',
});
delete env.AIE_PILOT_COHORT_USER_IDS;
delete env.AIE_AI_COST_ALLOWANCE_USD;

if (process.argv[2] === 'build') {
  // Release gate: a production build of this branch with DEV connection values
  // (prerender needs a Supabase URL). Nothing is deployed. The type-check
  // phase needs the larger heap this repo always uses for tsc.
  env.NODE_OPTIONS = '--max-old-space-size=8192';
  const b = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['next', 'build', '--webpack'], { env, stdio: 'inherit', shell: process.platform === 'win32' });
  b.on('exit', (c) => process.exit(c ?? 0));
} else {
const port = process.argv[2] ?? '3961';
console.log(`next dev on :${port} against DEV; flags set: ${Object.keys(env).filter((k) => /^(AIE_|II_AI)/.test(k) && !/KEY|SECRET/.test(k)).sort().join(', ')}`);
const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['next', 'dev', '--webpack', '-p', port], { env, stdio: 'inherit', shell: process.platform === 'win32' });
child.on('exit', (c) => process.exit(c ?? 0));
}
