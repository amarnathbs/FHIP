/**
 * PDF statement routes -- launches `next dev` against DEV (project vqycarelcoijzwlpkpcz ONLY) with the real S3 + GuardDuty scan, the real
 * gpt-4o-mini provider, every AI-fallback switch, and the THREE PDF route switches ON. For DEV verification only.
 *
 * Credentials are READ from the shared checkout's .env.local and from the local AWS CLI profile into this process's environment and handed
 * to the child. Nothing is printed, written to disk or committed. PRODUCTION_* values are REMOVED from the child's environment, and the
 * server refuses to start unless the Supabase host is the DEV project.
 *
 * Run: node scripts/pdf_routes_dev_server.mjs [port]
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
  // Real S3 + GuardDuty (DEV bucket, DEV plan).
  AIE_REAL_MALWARE_SCAN_ENABLED: 'true',
  AIE_MALWARE_S3_BUCKET: 'fhip-aie-dev-01-879807128139-ap-southeast-2-an',
  AIE_MALWARE_S3_REGION: 'ap-southeast-2',
  AIE_MALWARE_S3_ACCOUNT_ID: '879807128139',
  AIE_MALWARE_AWS_ACCESS_KEY_ID: aws('aws_access_key_id'),
  AIE_MALWARE_AWS_SECRET_ACCESS_KEY: aws('aws_secret_access_key'),
  AIE_DOCUMENT_INTAKE_ENABLED: 'true',
  AIE_AI_FALLBACK_ENABLED: 'true',
  AIE_II_ADAPTER_ENABLED: 'true',
  // Real GPT-4o mini through the application path (the existing provider selection; no new provider).
  AIE_AI_PROVIDER: 'openai',
  AIE_AI_MODEL: 'gpt-4o-mini',
  // Ephemeral masking key: tokens are one-way, nothing needs it later.
  AIE_MASK_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  // The per-class AI switches the CSV fallbacks already have (production has them unset).
  AIE_LIABILITY_AI_FALLBACK_ENABLED: 'true',
  AIE_RETIREMENT_STATEMENT_AI_FALLBACK_ENABLED: 'true',
  AIE_INVESTMENT_STATEMENT_AI_FALLBACK_ENABLED: 'true',
  // THE THREE PDF ROUTE SWITCHES (default OFF everywhere; ON here for DEV verification only).
  AIE_LIABILITY_PDF_ROUTE_ENABLED: 'true',
  AIE_RETIREMENT_PDF_ROUTE_ENABLED: 'true',
  AIE_AU_INVESTMENT_PDF_ROUTE_ENABLED: 'true',
});
delete env.AIE_PILOT_COHORT_ENFORCED;
delete env.AIE_PILOT_COHORT_EMAILS;
delete env.AIE_PILOT_COHORT_USER_IDS;
delete env.AIE_AI_COST_ALLOWANCE_USD;

const port = process.argv[2] ?? '3993';
console.log(`next dev on :${port} against DEV; switches set: ${Object.keys(env).filter((k) => /^(AIE_.*(ENABLED|PROVIDER|MODEL)$)/.test(k)).sort().join(', ')}`);
const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['next', 'dev', '--webpack', '-p', port], { env, stdio: 'inherit', shell: process.platform === 'win32' });
child.on('exit', (c) => process.exit(c ?? 0));
