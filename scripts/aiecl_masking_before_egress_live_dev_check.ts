/**
 * AIE-1 infrastructure-activation mission (section 13: "Verify masking
 * before network egress. Use synthetic identifiers in a controlled test
 * to establish: they occur in the input fixture; they are absent from
 * the outbound provider payload; required financial relationships
 * remain interpretable.").
 *
 * Drives the REAL orchestrator (`lib/aie/orchestrator.ts#runExtractionPipeline`),
 * the REAL Insurance parser/adapter registration, and the REAL masking
 * engine (`lib/aie/masking/piiMasking.ts`) against a synthetic document
 * containing embedded PII-shaped values that are NOT part of any
 * structured field this parser looks for -- exactly the "PII leaked via
 * incidental document text, not a declared field" risk masking exists to
 * close. A gateway wrapping the mock provider (no real OpenAI call is
 * made or needed for this check) CAPTURES the exact systemPrompt/
 * userPrompt this session's real code would send to a real provider.
 *
 * This is a direct function-call live-DEV test (real DEV Supabase rows,
 * real masking/orchestrator code), NOT an HTTP journey -- disclosed
 * explicitly, matching this session's own established discipline never to
 * describe a direct call as a browser/HTTP journey.
 *
 * Run: npx tsx scripts/aiecl_masking_before_egress_live_dev_check.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { buildAieInsuranceFixtureText } from '../tests/support/buildAieInsuranceFixtureText';
import { registerInsuranceAdapter } from '@/lib/aie/adapters/insurance';
import { buildInsuranceReconciliationRule } from '@/lib/aie/adapters/insurance/reconciliation';
import { AIE_INSURANCE_ADAPTER_FIELD_COMPLETION_SCHEMA_NAME, AIE_INSURANCE_ADAPTER_FIELD_COMPLETION_SCHEMA_VERSION } from '@/lib/aie/adapters/insurance/schema';
import { createDefaultDeps, runExtractionPipeline } from '@/lib/aie/orchestrator';
import { AieDocumentAiGateway } from '@/lib/aie/provider/gateway';
import { MockAieProvider } from '@/lib/aie/provider/mockAieProvider';
import type { AieAiProvider, AieAiGenerateRequest, AieAiGenerateResult } from '@/lib/aie/provider/types';
import type { ProviderHealth, CostEstimate } from '@/lib/ai/providers/types';

const repoRoot = path.resolve(__dirname, '..');
function loadEnv() {
  const raw = fs.readFileSync(path.join(repoRoot, '.env.local'), 'utf8').replace(/^﻿/, '');
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnv();
// lib/supabase/admin.ts (imported transitively via the real
// @/lib/aie/orchestrator module under test, through
// lib/aie/db/repository.ts's own recordTransition/etc. calls) reads
// process.env directly -- this script must populate it, not just its own
// local `env` object.
process.env.NEXT_PUBLIC_SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

// REAL FINDING (this session, this script's first run): AIE_MASK_TOKEN_
// ENCRYPTION_KEY was genuinely absent from DEV's own .env.local -- meaning
// lib/aie/masking/tokenMapCrypto.ts#loadKey() threw for ANY real document
// that ever reached the masking/AI-fallback path in the real running app,
// today, before this fix. Not previously caught because every prior
// Insurance regression test used a fixture with `productName` PRESENT,
// which never enters the AI-eligible-gap/masking branch at all. A real
// key has now been generated and added to .env.local for real (not a
// per-process workaround) -- see AIE_1_INFRASTRUCTURE_ACTIVATION_CLOSURE_REGISTER.md.
if (env.AIE_MASK_TOKEN_ENCRYPTION_KEY) {
  process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = env.AIE_MASK_TOKEN_ENCRYPTION_KEY;
} else {
  process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  console.log('NOTE: AIE_MASK_TOKEN_ENCRYPTION_KEY is still not set in .env.local -- using a throwaway key for THIS PROCESS ONLY so this check can run.');
}

let passed = 0, failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`PASS: ${label}`); }
  else { failed++; console.log(`FAIL: ${label}` + (detail !== undefined ? ` -- ${JSON.stringify(detail).slice(0, 1500)}` : '')); }
}

// --- A spy provider: delegates to the real MockAieProvider's behaviour,
// but records the exact request it was handed, so this script can inspect
// precisely what left the masking boundary -- the same object a real
// OpenAiAieProvider would have received. ---
class SpyProvider implements AieAiProvider {
  readonly providerName = 'spy';
  capturedRequests: AieAiGenerateRequest[] = [];
  private readonly delegate = new MockAieProvider({ respond: () => JSON.stringify({ fields: [{ fieldName: 'productName', value: 'Acme SecureLife Term Cover', confidence: 0.9 }] }) });
  async generateStructured(req: AieAiGenerateRequest): Promise<AieAiGenerateResult> {
    this.capturedRequests.push(req);
    return this.delegate.generateStructured(req);
  }
  async validateProviderHealth(): Promise<ProviderHealth> {
    return { healthy: true, checkedAt: new Date().toISOString(), detail: null };
  }
  estimateCost(inputTokens: number, outputTokens: number): CostEstimate {
    return { inputTokens, outputTokens, estimatedCostUsd: 0 };
  }
}

async function main() {
  registerInsuranceAdapter();

  // Real synthetic PII values, embedded in EXTRA lines that are not part
  // of any structured field the Insurance parser looks for -- exactly the
  // "leaked via incidental text" risk. productName is OMITTED so the
  // parser genuinely reaches deterministic_partial with an AI-eligible
  // gap (policyNameClarification) -- confirmed by direct source read of
  // lib/aie/adapters/insurance/parser.ts before writing this script.
  const SYNTHETIC_EMAIL = 'synthetic.masking.check@example.com';
  const SYNTHETIC_TFN = '123 456 789';
  const SYNTHETIC_PAN = 'ABCDE1234F';
  const SYNTHETIC_CARD = '4111 1111 1111 1111';

  const fixtureText =
    buildAieInsuranceFixtureText({ omitFields: ['productName'] }) +
    `\nContact: ${SYNTHETIC_EMAIL}\nTFN: ${SYNTHETIC_TFN}\nPAN: ${SYNTHETIC_PAN}\nCard on file: ${SYNTHETIC_CARD}\n`;

  const SYNTHETIC_VALUES = [SYNTHETIC_EMAIL, SYNTHETIC_TFN, SYNTHETIC_PAN, SYNTHETIC_CARD];
  for (const v of SYNTHETIC_VALUES) {
    check(`setup: synthetic identifier genuinely present in the input fixture (${v})`, fixtureText.includes(v));
  }

  const stamp = Date.now();
  const email = `aiecl-masking-${stamp}@example.com`;
  const password = `Test-${Math.random().toString(36).slice(2)}-Aa1!`;
  let userId = '';
  let intakeId = '';
  let runId = '';

  try {
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw new Error(`create user failed: ${created.error?.message}`);
    userId = created.data.user.id;

    const intake = await admin
      .from('aie_document_intake')
      .insert({ user_id: userId, declared_mime_type: 'application/pdf', byte_size: fixtureText.length, storage_key: null, status: 'ready' })
      .select('id')
      .single();
    if (intake.error) throw new Error(`intake insert failed: ${intake.error.message}`);
    intakeId = intake.data.id;

    const run = await admin.from('aie_extraction_run').insert({ intake_id: intakeId, user_id: userId, run_number: 1, status: 'local_extracting' }).select('id').single();
    if (run.error) throw new Error(`run insert failed: ${run.error.message}`);
    runId = run.data.id;

    const spy = new SpyProvider();
    // AIE_AI_FALLBACK_ENABLED gates AieDocumentAiGateway's own kill switch
    // (defaults OFF) -- set here for THIS standalone process only; never
    // touches the real shared DEV app's own running environment.
    process.env.AIE_AI_FALLBACK_ENABLED = 'true';
    const gateway = new AieDocumentAiGateway(spy);
    const deps = createDefaultDeps(gateway);

    const outcome = await runExtractionPipeline({
      runId,
      intakeId,
      userId,
      extractedText: fixtureText,
      reconcile: buildInsuranceReconciliationRule(),
      deps,
      schemaOverride: {
        schemaName: AIE_INSURANCE_ADAPTER_FIELD_COMPLETION_SCHEMA_NAME,
        schemaVersion: AIE_INSURANCE_ADAPTER_FIELD_COMPLETION_SCHEMA_VERSION,
      },
    });

    check('setup: the AI fallback was genuinely invoked (aiWasUsed=true) -- otherwise this test would prove nothing', outcome.aiWasUsed === true, outcome);
    check('setup: exactly one real provider call was captured', spy.capturedRequests.length === 1, spy.capturedRequests.length);

    const captured = spy.capturedRequests[0];
    // captured.userPrompt is the REAL AieAiGenerateRequest field -- the
    // exact string gateway.ts builds from the caller's maskedUserPrompt
    // and hands to provider.generateStructured(); this IS what a real
    // OpenAiAieProvider would receive and send over the wire.
    const outboundPayload = `${captured?.systemPrompt ?? ''}\n${captured?.userPrompt ?? ''}`;

    for (const v of SYNTHETIC_VALUES) {
      check(`REAL CHECK: synthetic identifier absent from the outbound provider payload (${v})`, !outboundPayload.includes(v), outboundPayload.slice(0, 500));
    }

    // Required financial relationships remain interpretable: the cover
    // amount (a real, non-PII financial figure the adapter's own
    // reconciliation rule needs) must survive masking unmasked.
    check('required financial figure (cover amount) remains interpretable in the outbound payload (masking does not over-redact ordinary financial data)', outboundPayload.includes('500000') || outboundPayload.includes('500,000'), outboundPayload.slice(0, 800));

    // Independent confirmation the masking engine's own token markers are
    // present where the PII used to be -- not just silently dropped text,
    // which would corrupt the document structure for the parser.
    const tokenCount = (outboundPayload.match(/\[MASKED:/g) ?? []).length;
    check('masked payload contains explicit [MASKED:...] tokens in place of the redacted values (not silently dropped)', tokenCount >= 4, tokenCount);

    // Confirm persistMaskTokenMap() genuinely wrote real encrypted rows
    // (this is the exact call that threw before AIE_MASK_TOKEN_ENCRYPTION_KEY
    // was configured) -- not just "no exception was thrown".
    const tokenMapRows = await admin.from('aie_mask_token_map').select('id, token').eq('run_id', runId);
    check('aie_mask_token_map: real encrypted rows were written for this run (persistMaskTokenMap succeeded for real)', (tokenMapRows.data?.length ?? 0) >= 4, tokenMapRows.error?.message ?? tokenMapRows.data?.length);
  } finally {
    if (runId) await admin.from('aie_unresolved_item').delete().eq('run_id', runId);
    if (runId) await admin.from('aie_extraction_run').delete().eq('id', runId);
    if (intakeId) await admin.from('aie_document_intake').delete().eq('id', intakeId);
    if (userId) await admin.auth.admin.deleteUser(userId);

    const residueRun = runId ? await admin.from('aie_extraction_run').select('id').eq('id', runId).maybeSingle() : { data: null };
    const residueIntake = intakeId ? await admin.from('aie_document_intake').select('id').eq('id', intakeId).maybeSingle() : { data: null };
    const residueUser = userId ? await admin.auth.admin.getUserById(userId) : { data: { user: null } };
    const residueTokenMap = runId ? await admin.from('aie_mask_token_map').select('id').eq('run_id', runId) : { data: [] };
    check('ZERO RESIDUE: run gone', !residueRun.data);
    check('ZERO RESIDUE: intake gone', !residueIntake.data);
    check('ZERO RESIDUE: user gone', !residueUser.data.user);
    check('ZERO RESIDUE: mask-token-map rows gone (cascade-deleted with the run)', (residueTokenMap.data ?? []).length === 0, residueTokenMap.data);

    console.log(`\n=== SUMMARY: ${passed}/${passed + failed} checks passed ===`);
    if (failed > 0) process.exitCode = 1;
  }
}

main();
