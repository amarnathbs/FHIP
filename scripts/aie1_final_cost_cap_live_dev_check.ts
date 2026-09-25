/**
 * AIE-1 final production completion (2026-09-25) -- LIVE DEV spend-cap check.
 *
 * Mode `pre-0195` is the NEGATIVE CONTROL against the DEV database as it is
 * today (0152 semantics): each defect must be demonstrably PRESENT. Mode
 * `post-0195` is the same run after the PO applies migration 0195 to DEV: each
 * defect must be GONE. Amounts are micro-dollars; the ledger's reserved/settled
 * figures are snapshotted first and restored at the end (DEV only), and every
 * probe key is prefixed `aie1-final-costprobe-` so it is identifiable.
 *
 * The exhaustion step goes through the REAL application function
 * (`requestPayslipAiExtraction`) with the real OpenAI provider configured, and
 * proves the provider is never called (outcome budget_exhausted, no request id,
 * ledger attempt count unchanged).
 *
 * Run: npx tsx scripts/aie1_final_cost_cap_live_dev_check.ts pre-0195|post-0195
 */
import { devFetch, env, BASE, ANON, assertDev, makeChecker, recordArtefact } from './aie1_final_dev_harness.mjs';
import { randomBytes } from 'node:crypto';

const mode = process.argv[2];
if (mode !== 'pre-0195' && mode !== 'post-0195') { console.error('usage: pre-0195 | post-0195'); process.exit(2); }
const post = mode === 'post-0195';
const { check, summary } = makeChecker(`AIE1-COST-${post ? 'POST' : 'PRE'}`);
const P = `aie1-final-costprobe-${Date.now()}`;
const TINY = 0.000001;

async function rpc(fn: string, args: Record<string, unknown>) {
  return devFetch(`/rest/v1/rpc/${fn}`, { method: 'POST', body: args });
}
async function ledger() {
  return (await devFetch('/rest/v1/aie_ai_cost_ledger?id=eq.global&select=*')).json[0];
}
const reserve = (key: string, amount = TINY, allowance = 10) => rpc('aie_reserve_ai_cost', { p_ledger_id: 'global', p_amount_usd: amount, p_allowance_usd: allowance, p_idempotency_key: key });
const settleV1 = (key: string, reserved = TINY) => rpc('aie_settle_ai_cost', { p_ledger_id: 'global', p_reserved_usd: reserved, p_actual_usd: 0, p_input_tokens: 0, p_output_tokens: 0, p_idempotency_key: key });

async function main() {
  const snap = await ledger();
  console.log(`ledger before: allowance=${snap.allowance_usd} reserved=${snap.reserved_usd} settled=${snap.settled_usd} attempts=${snap.total_attempts}`);

  // 1. Replay after settlement (D1).
  const k1 = `${P}-replay`;
  recordArtefact({ kind: 'aie_ai_cost_attempt', id: k1 });
  const r1 = await reserve(k1);
  if (post) await rpc('aie_settle_ai_cost_v2', { p_ledger_id: 'global', p_idempotency_key: k1, p_actual_usd: 0, p_input_tokens: 0, p_output_tokens: 0, p_model: 'gpt-4o-mini', p_provider_request_ids: [], p_call_outcome: 'probe', p_billing_uncertain: false });
  else await settleV1(k1);
  const r2 = await reserve(k1);
  const replayAdmitted = r2.json?.[0]?.reserved === true;
  if (post) check('D1: a settled key replayed is REFUSED (no unmetered call possible)', r1.json?.[0]?.reserved === true && !replayAdmitted, JSON.stringify({ first: r1.json, replay: r2.json }));
  else check('NEGATIVE CONTROL D1: DEV (0152) RE-ADMITS a settled key -- the unmetered-call defect is live', r1.json?.[0]?.reserved === true && replayAdmitted, JSON.stringify({ first: r1.json, replay: r2.json }));

  // 2. Concurrent same-key reservations (D2).
  const before2 = await ledger();
  const k2 = `${P}-concurrent`;
  recordArtefact({ kind: 'aie_ai_cost_attempt', id: k2 });
  const results = await Promise.all(Array.from({ length: 12 }, () => reserve(k2)));
  const admitted = results.filter((r) => r.json?.[0]?.reserved === true).length;
  const after2 = await ledger();
  const reservedDelta = Number(after2.reserved_usd) - Number(before2.reserved_usd);
  const reservations = Math.round(reservedDelta / TINY);
  if (post) check('D2: 12 concurrent calls with ONE key reserve exactly once and admit exactly once', admitted === 1 && reservations === 1, `admitted=${admitted} reservations=${reservations}`);
  else check('CONTROL D2 (observational): 12 concurrent same-key calls under 0152', true, `admitted=${admitted} reservations=${reservations} (more than 1 = leaked reservation)`);

  // 3. Caller-supplied allowance (D7): can the caller raise the cap?
  const k3 = `${P}-raise`;
  recordArtefact({ kind: 'aie_ai_cost_attempt', id: k3 });
  const big = Number(snap.allowance_usd) * 5;
  const r3 = await reserve(k3, big, 1000);
  const l3 = await ledger();
  if (post) check('D7: an allowance above the stored ceiling cannot admit spend past it', r3.json?.[0]?.reserved === false && Number(l3.allowance_usd) === Number(snap.allowance_usd), JSON.stringify({ r: r3.json, allowance: l3.allowance_usd }));
  else check('NEGATIVE CONTROL D7: DEV (0152) lets the CALLER raise the cap', r3.json?.[0]?.reserved === true && Number(l3.allowance_usd) === 1000, JSON.stringify({ r: r3.json, allowance: l3.allowance_usd }));
  if (!post && r3.json?.[0]?.reserved === true) await settleV1(k3, big);

  // 4. anon privilege.
  assertDev(BASE);
  const anonRes = await fetch(`${BASE}/rest/v1/rpc/aie_reserve_ai_cost`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_ledger_id: 'global', p_amount_usd: TINY, p_allowance_usd: 10, p_idempotency_key: `${P}-anon` }) });
  recordArtefact({ kind: 'aie_ai_cost_attempt', id: `${P}-anon` });
  if (post) check('PRIV: the public anon key can NOT call aie_reserve_ai_cost', anonRes.status === 401 || anonRes.status === 403 || anonRes.status === 404, `http ${anonRes.status}`);
  else check('NEGATIVE CONTROL PRIV: the public anon key CAN call aie_reserve_ai_cost in DEV today', anonRes.status === 200, `http ${anonRes.status}`);
  if (!post && anonRes.status === 200) await settleV1(`${P}-anon`);

  // 5. Exhaustion through the real application path (provider never called).
  const l5 = await ledger();
  process.env.NEXT_PUBLIC_SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.AIE_AI_PROVIDER = 'openai';
  process.env.AIE_OPENAI_API_KEY = env.AIE_OPENAI_API_KEY;
  process.env.AIE_AI_FALLBACK_ENABLED = 'true';
  process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('hex');
  // An allowance that leaves room for nothing: what is already reserved+settled.
  process.env.AIE_AI_COST_ALLOWANCE_USD = String(Number(l5.reserved_usd) + Number(l5.settled_usd) + 0.0000005);
  const { requestPayslipAiExtraction } = await import('../lib/aie/adapters/payslip');
  const out = await requestPayslipAiExtraction({ maskedText: 'Remittance advice. Net amount 100.00 paid 1 August 2026.', requestId: `${P}-exhaust` });
  const l5b = await ledger();
  check('EXHAUSTION: the real application path returns budget_exhausted and never calls OpenAI (no request id, attempts unchanged)',
    out.outcome === 'budget_exhausted' && (out.evidence?.providerRequestIds ?? []).length === 0 && Number(l5b.total_attempts) === Number(l5.total_attempts),
    JSON.stringify({ outcome: out.outcome, requestIds: out.evidence?.providerRequestIds, attempts: [l5.total_attempts, l5b.total_attempts] }));

  // Restore the DEV ledger figures this probe moved (DEV only; the probe's own
  // attempt rows stay as evidence, identifiable by prefix).
  await devFetch('/rest/v1/aie_ai_cost_ledger?id=eq.global', { method: 'PATCH', body: { allowance_usd: snap.allowance_usd, reserved_usd: snap.reserved_usd, settled_usd: snap.settled_usd } });
  const fin = await ledger();
  console.log(`ledger restored: allowance=${fin.allowance_usd} reserved=${fin.reserved_usd} settled=${fin.settled_usd} attempts=${fin.total_attempts}`);
  process.exit(summary() === 0 ? 0 : 1);
}
main().catch((e) => { console.error('FATAL', e instanceof Error ? e.message : e); process.exit(2); });
