/**
 * AIE other-PDF AI proof (2026-09-25) -- Investment Intelligence: a
 * PROVIDER-LEVEL live DEV check with REAL gpt-4o-mini.
 *
 * WHY ONLY PROVIDER-LEVEL. The II AI path stages its reading in
 * `ii_ai_extraction_reviews` (migration 0160), and 0160 is NOT applied on DEV
 * (PostgREST: PGRST205, table absent). So the full journey -- upload, real
 * scan, staged review, accept, one canonical write, replay refused, PDF
 * purged -- cannot run on DEV until the PO applies 0160 and 0202. What CAN be
 * proven now, and is proven here, is the half that talks to OpenAI: the exact
 * production provider (same gateway, same schema, same prompt, the line-item
 * output budget, real cost reserve/settle on the DEV ledger), reading a
 * synthetic statement the deterministic II parsers cannot identify, masked by
 * the same maskText the processing service uses.
 *
 * DEV only: refuses unless the Supabase URL is the DEV project; PRODUCTION_*
 * values are never loaded. Prints no document text.
 *
 * Run: npx tsx scripts/aie1_other_pdf_ii_provider_live_dev_check.ts
 */
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';

const DEV_HOST = 'vqycarelcoijzwlpkpcz.supabase.co';
for (const line of fs.readFileSync('D:/FHIP/.env.local', 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
  const i = line.indexOf('=');
  if (i <= 0) continue;
  const k = line.slice(0, i).trim();
  if (k.startsWith('PRODUCTION_')) continue;
  process.env[k] = line.slice(i + 1).trim().replace(/^"|"$/g, '');
}
if (new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).host !== DEV_HOST) { console.error('REFUSING: not the DEV project'); process.exit(2); }
Object.assign(process.env, {
  AIE_AI_PROVIDER: 'openai', AIE_AI_MODEL: 'gpt-4o-mini', AIE_AI_FALLBACK_ENABLED: 'true', II_AI_FALLBACK_ENABLED: 'true',
  AIE_MASK_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
});

/** Synthetic, letter-style CAS. EXPECTED (by hand): one holding,
 * SYNTHETIC BLUECHIP FUND - DIRECT PLAN - GROWTH, ISIN INF000S00001,
 * 1 purchase on 2026-08-05 of 100.000 units at NAV 50.0000 = 5000.00,
 * closing 100.000 units, NAV 52.5000 on 2026-08-31, market value
 * 100 x 52.50 = 5250.00; cost value derived from the purchase = 5000.00. */
export const II_EXPECTED = { units: 100, marketValue: 5250, costValue: 5000, purchaseAmount: 5000, purchaseUnits: 100, asOf: '2026-08-31' } as const;
const PII = ['Zelda Quarrington', 'ABCDE1234F', 'zelda.q@example.invalid', '0412 555 019'];
const TEXT = [
  'Imaginary Registrar - quarterly holdings letter (synthetic test document)',
  `Investor: ${PII[0]}`,
  `PAN: ${PII[1]}`,
  `Email: ${PII[2]}`,
  `Mobile: ${PII[3]}`,
  'Folio SYN-2026-0001 with Imaginary Asset Management.',
  'In your SYNTHETIC BLUECHIP FUND - DIRECT PLAN - GROWTH holding (ISIN INF000S00001) you had no units before this period.',
  'On 5 August 2026 you purchased 100.000 units at a NAV of 50.0000 for 5000.00.',
  'On 31 August 2026 you held 100.000 units; the NAV that day was 52.5000, so the market value was 5250.00.',
].join('\n');

async function main() {
  const { parseExtractedDocument } = await import('../lib/services/investment-intelligence/parsers/registry');
  const { maskText } = await import('../lib/aie/masking/piiMasking');
  const { resolveAieDocumentProvider } = await import('../lib/services/investment-intelligence/aiFallbackDocumentExtraction');
  const { createAdminClient } = await import('../lib/supabase/admin');
  let pass = 0, fail = 0;
  const check = (label: string, ok: boolean, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  II-PROV  ${label}${detail ? '\n        ' + detail : ''}`); };

  const det = parseExtractedDocument(TEXT);
  check('the deterministic II parser registry cannot identify this statement (the AI-fallback trigger)', !det.parser || !det.parsed, JSON.stringify({ source: det.detection.detection.sourceKey, confidence: det.detection.detection.confidence }));

  const masked = maskText(TEXT, { tenantKey: 'aie1-other-ii-provider-check' }).maskedText;
  const survivors = PII.filter((p) => masked.includes(p));
  check('masking: 4 planted synthetic personal details, 0 survive into the request text', survivors.length === 0, `survivors=${survivors.length}`);

  const admin = createAdminClient();
  const before = (await admin.from('aie_ai_cost_ledger').select('settled_usd,reserved_usd,total_attempts').eq('id', 'global').single()).data as any;
  const provider = await resolveAieDocumentProvider();
  let result: any = null;
  let error: string | null = null;
  try { result = await provider!({ maskedDocumentText: masked }); } catch (e) { error = e instanceof Error ? e.message : String(e); }
  const after = (await admin.from('aie_ai_cost_ledger').select('settled_usd,reserved_usd,total_attempts').eq('id', 'global').single()).data as any;
  const ev = result?.evidence ?? null;
  check('real gpt-4o-mini returned a schema-valid reading (line-item output budget)', !!result && !error, error ?? '');
  const h = result?.holdings?.[0];
  const tx = h?.transactions?.[0];
  check('reading equals the hand-computed values (1 holding: 100 units, market value 5250.00, derived cost 5000.00; 1 purchase 5000.00 for 100 units; as of 2026-08-31)',
    !!h && result.holdings.length === 1 && h.units === II_EXPECTED.units && h.marketValue === II_EXPECTED.marketValue && h.costValue === II_EXPECTED.costValue && h.asOfDateIso === II_EXPECTED.asOf
      && h.transactions.length === 1 && Math.abs(tx.amount) === II_EXPECTED.purchaseAmount && tx.units === II_EXPECTED.purchaseUnits,
    JSON.stringify(h ? { n: result.holdings.length, units: h.units, mv: h.marketValue, cost: h.costValue, asOf: h.asOfDateIso, tx: h.transactions.map((t: any) => `${t.dateIso} ${t.canonicalType} ${t.amount} u=${t.units}`) } : null));
  check('no planted personal detail comes back in the model output', !PII.some((p) => JSON.stringify(result ?? {}).includes(p)));
  const attempt = ev ? (await admin.from('aie_ai_cost_attempt').select('*').eq('idempotency_key', ev.idempotencyKey).maybeSingle()).data as any : null;
  check('spend reserved and settled on the DEV ledger with model, request id and tokens recorded',
    !!attempt && attempt.model === 'gpt-4o-mini' && (attempt.provider_request_ids ?? []).length >= 1 && Number(attempt.settled_usd) > 0 && Number(attempt.reserved_usd) >= Number(attempt.settled_usd)
      && Number(after.total_attempts) === Number(before.total_attempts) + 1 && Number(after.reserved_usd) === Number(before.reserved_usd),
    JSON.stringify({ settledDeltaUsd: Number(after.settled_usd) - Number(before.settled_usd), attempt: attempt ? { reserved: attempt.reserved_usd, settled: attempt.settled_usd, model: attempt.model, req: attempt.provider_request_ids, in: attempt.input_tokens, out: attempt.output_tokens, outcome: attempt.call_outcome } : null }));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e instanceof Error ? e.message : e); process.exit(2); });
