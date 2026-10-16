/* eslint-disable @typescript-eslint/no-explicit-any -- DEV harness: untyped PostgREST JSON read back for assertions */
/**
 * AIE per-user DAILY spend cap (PO decision 16-10-2026) -- LIVE DEV check. Run it AFTER the Product Owner has applied
 * docs/ai/po_apply_per_user_cap/dev (migration 0284) to DEV. It refuses to run before that.
 *
 * DEV only: refuses unless NEXT_PUBLIC_SUPABASE_URL is the DEV project, and every PRODUCTION_* value in .env.local is
 * skipped, never loaded. It creates NO user and types NO password: it borrows two EXISTING fixture users (an e-mail
 * on the reserved @fhip-test.invalid domain, or the fixture accounts named in the environment) and uses their ids only
 * as the attribution of probe reservations. It prints no secret, no e-mail and no document text (ids are shown as an
 * 8 character prefix).
 *
 * PART 1 (always) -- the atomic SQL function over real HTTP with REAL parallelism (the one thing PGlite cannot show):
 *   P1 many simultaneous reservations for one user admit exactly the user's headroom and no more (no overshoot)
 *   P2 a second user is independent
 *   P3 a replayed key is refused as a replay and charges nothing
 *   P4 a refused request is recorded as user_daily_cap_reached with nothing reserved, global ledger unchanged
 *   P5 settling at a lower actual cost gives that user headroom back
 *   P6 an attempt from the previous UTC day does not count (rollover)
 *   P7 the global allowance still refuses a user under their own cap
 *   P8 the public anon key cannot call the function
 *   Afterwards the probe rows are deleted and the ledger figures are restored to the snapshot taken first.
 *
 * PART 2 (only with --real) -- the real application path with the real provider (gpt-4o-mini, the approved model):
 *   R1 with the user's remaining daily allowance held by an open reservation, the real adapter call is refused as
 *      user_daily_cap_reached and OpenAI is never called (no provider request id, ledger attempt count unchanged)
 *   R2 after the hold is released, the same call is admitted, reaches OpenAI once and is settled against that user
 *   The R2 spend (a fraction of a cent) is real and is NOT reversed: its attempt row stays as evidence.
 *
 * Run: npx tsx scripts/aie_user_cap_live_dev_check.ts            (Part 1 only)
 *      npx tsx scripts/aie_user_cap_live_dev_check.ts --real     (Parts 1 and 2)
 */
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';

const DEV_HOST = 'vqycarelcoijzwlpkpcz.supabase.co';
const REAL = process.argv.includes('--real');

for (const line of fs.readFileSync('D:/FHIP/.env.local', 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
  const i = line.indexOf('=');
  if (i <= 0) continue;
  const k = line.slice(0, i).trim();
  if (k.startsWith('PRODUCTION_')) continue; // never loaded
  process.env[k] = line.slice(i + 1).trim().replace(/^"|"$/g, '');
}
for (const k of Object.keys(process.env)) if (k.startsWith('PRODUCTION_')) delete process.env[k];

const BASE = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!BASE || new URL(BASE).host !== DEV_HOST) {
  console.error('REFUSING: NEXT_PUBLIC_SUPABASE_URL is not the DEV project');
  process.exit(2);
}

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = '') {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`);
}

async function http(p: string, opts: { method?: string; body?: unknown; key?: string; prefer?: string } = {}) {
  if (new URL(BASE).host !== DEV_HOST) throw new Error('DEV host assertion failed');
  const key = opts.key ?? SERVICE;
  const res = await fetch(`${BASE}${p}`, {
    method: opts.method ?? 'GET',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(opts.prefer ? { Prefer: opts.prefer } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not json */
  }
  return { ok: res.ok, status: res.status, json, text };
}

const STAMP = Date.now();
const PREFIX = `ucap-live-${STAMP}`;
const short = (id: string) => id.slice(0, 8);
let keyN = 0;
const nextKey = (tag: string) => `${PREFIX}-${tag}-${(keyN += 1)}`;

const reserveV2 = (key: string, amount: number, user: string, opts: { allowance?: number; cap?: number | null } = {}) =>
  http('/rest/v1/rpc/aie_reserve_ai_cost_v2', {
    method: 'POST',
    body: { p_ledger_id: 'global', p_amount_usd: amount, p_allowance_usd: opts.allowance ?? 10, p_idempotency_key: key, p_user_id: user, p_user_daily_cap_usd: opts.cap === undefined ? null : opts.cap },
  });
const settleV2 = (key: string, actual: number) =>
  http('/rest/v1/rpc/aie_settle_ai_cost_v2', {
    method: 'POST',
    body: { p_ledger_id: 'global', p_idempotency_key: key, p_actual_usd: actual, p_input_tokens: 0, p_output_tokens: 0, p_model: 'gpt-4o-mini', p_provider_request_ids: [], p_call_outcome: 'probe', p_billing_uncertain: false },
  });
const ledger = async () => (await http('/rest/v1/aie_ai_cost_ledger?id=eq.global&select=*')).json[0];

async function utcDayStartIso(): Promise<string> {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}
/** What the database counts for this user today (settled when settled, else reserved). */
async function usedToday(user: string): Promise<number> {
  const since = encodeURIComponent(await utcDayStartIso());
  const r = await http(`/rest/v1/aie_ai_cost_attempt?user_id=eq.${user}&created_at=gte.${since}&select=reserved_usd,settled_usd`);
  return (r.json as any[]).reduce((s, x) => s + Number(x.settled_usd ?? x.reserved_usd), 0);
}

async function pickFixtureUsers(): Promise<string[]> {
  const res = await http('/auth/v1/admin/users?page=1&per_page=200');
  const users: Array<{ id: string; email?: string }> = res.json?.users ?? [];
  const named = (process.env.AIE_UCAP_FIXTURE_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const byDomain = users.filter((u) => /@fhip-test\.invalid$/i.test(u.email ?? '')).map((u) => u.id);
  return [...new Set([...named, ...byDomain])].slice(0, 2);
}

async function main() {
  // Preflight: the migration must be applied.
  const pre = await http('/rest/v1/aie_ai_cost_ledger?id=eq.global&select=allowance_usd,user_daily_cap_usd,reserved_usd,settled_usd,total_attempts');
  if (!pre.ok) {
    console.error(`PREFLIGHT FAILED (http ${pre.status}): migration 0284 is not applied on DEV yet. Apply docs/ai/po_apply_per_user_cap/dev first.`);
    process.exit(3);
  }
  const snap = pre.json[0];
  console.log(`ledger before: allowance=${snap.allowance_usd} per_user_daily_cap=${snap.user_daily_cap_usd} reserved=${snap.reserved_usd} settled=${snap.settled_usd} attempts=${snap.total_attempts}`);
  const capColumn = Number(snap.user_daily_cap_usd);

  const users = await pickFixtureUsers();
  if (users.length < 2) {
    console.error('PREFLIGHT FAILED: fewer than two existing fixture users (e-mail on @fhip-test.invalid, or ids listed in AIE_UCAP_FIXTURE_USER_IDS).');
    process.exit(3);
  }
  const [A, B] = users;
  console.log(`fixture users (existing, borrowed for attribution only): A=${short(A)} B=${short(B)}`);

  // ---------------- PART 1: the SQL function, real parallel HTTP ----------------
  const STEP = 0.1;
  const headA = Math.max(capColumn - (await usedToday(A)), 0);
  const headB = Math.max(capColumn - (await usedToday(B)), 0);
  const expectA = Math.floor(headA / STEP + 1e-9);
  const expectB = Math.floor(headB / STEP + 1e-9);
  console.log(`headroom today: A=${headA.toFixed(4)} (expect ${expectA} x ${STEP}) B=${headB.toFixed(4)} (expect ${expectB} x ${STEP})`);
  if (expectA < 2 || expectB < 2) {
    console.error('PREFLIGHT FAILED: a fixture user already has too little headroom today to run the probe. Re-run after 00:00 UTC or choose other fixture users.');
    process.exit(3);
  }

  const lBefore = await ledger();
  try {
    const keysA: string[] = [];
    const burst = async (user: string, n: number, keys: string[]) =>
      Promise.all(
        Array.from({ length: n }, () => {
          const k = nextKey('burst');
          keys.push(k);
          return reserveV2(k, STEP, user).then((r) => ({ key: k, row: r.json?.[0], status: r.status }));
        }),
      );

    const resA = await burst(A, expectA + 12, keysA);
    const admittedA = resA.filter((r) => r.row?.reserved === true);
    check(`P1 ${resA.length} simultaneous reservations for user A: exactly the headroom (${expectA}) admitted, no overshoot`, admittedA.length === expectA && resA.every((r) => r.status === 200), `admitted=${admittedA.length} refused=${resA.length - admittedA.length}`);
    const refusedReasons = new Set(resA.filter((r) => r.row?.reserved === false).map((r) => r.row.refusal_reason));
    check('P1b every refusal carries the typed per-user reason', refusedReasons.size === 1 && refusedReasons.has('user_daily_cap'), JSON.stringify([...refusedReasons]));
    const usedA = await usedToday(A);
    check('P1c the database total for user A today never exceeds the cap', usedA <= capColumn + 1e-9, `used=${usedA.toFixed(6)} cap=${capColumn}`);

    const keysB: string[] = [];
    const resB = await burst(B, expectB + 5, keysB);
    check('P2 user B is independent of user A being at the cap', resB.filter((r) => r.row?.reserved === true).length === expectB, `admitted=${resB.filter((r) => r.row?.reserved === true).length} expected=${expectB}`);

    const dupKey = admittedA[0].key;
    const lMid = await ledger();
    const dup = await reserveV2(dupKey, STEP, A);
    const lAfterDup = await ledger();
    check('P3 a replayed key is refused as a replay and charges nothing', dup.json?.[0]?.reserved === false && dup.json?.[0]?.refusal_reason === 'replay' && Number(lAfterDup.reserved_usd) === Number(lMid.reserved_usd), JSON.stringify(dup.json));

    const refusedKey = resA.find((r) => r.row?.reserved === false)!.key;
    const attemptRow = (await http(`/rest/v1/aie_ai_cost_attempt?idempotency_key=eq.${refusedKey}&select=admission_outcome,reserved_usd,user_id`)).json?.[0];
    check('P4 a refused request is recorded as user_daily_cap_reached, nothing reserved, attributed to the user', attemptRow?.admission_outcome === 'user_daily_cap_reached' && Number(attemptRow?.reserved_usd) === 0 && attemptRow?.user_id === A, JSON.stringify(attemptRow));
    const lAfterBursts = await ledger();
    check('P4b the global ledger reserved total equals exactly what was admitted', Math.abs(Number(lAfterBursts.reserved_usd) - Number(lBefore.reserved_usd) - (admittedA.length + resB.filter((r) => r.row?.reserved === true).length) * STEP) < 1e-6, `delta=${(Number(lAfterBursts.reserved_usd) - Number(lBefore.reserved_usd)).toFixed(6)}`);

    for (const r of admittedA.slice(0, 3)) await settleV2(r.key, 0.0001);
    const again = await reserveV2(nextKey('after-settle'), STEP * 2, A);
    check('P5 settling three reservations at a much lower actual cost gives user A headroom back', again.json?.[0]?.reserved === true, JSON.stringify(again.json));

    // P6: move every probe attempt of user A to the previous UTC day -> A has full headroom again.
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    await http(`/rest/v1/aie_ai_cost_attempt?idempotency_key=like.${PREFIX}-*&user_id=eq.${A}`, { method: 'PATCH', body: { created_at: yesterday } });
    const usedAfterShift = await usedToday(A);
    const rolled = await reserveV2(nextKey('rollover'), STEP * Math.max(expectA - 1, 1), A);
    check('P6 attempts from the previous UTC day do not count (rollover)', rolled.json?.[0]?.reserved === true && usedAfterShift < usedA, `used before shift=${usedA.toFixed(4)} after=${usedAfterShift.toFixed(4)} reserve=${JSON.stringify(rolled.json?.[0])}`);

    const lowAllowance = await reserveV2(nextKey('global'), 0.0001, B, { allowance: 0.00000001 });
    check('P7 the global allowance still refuses a user under their own cap (reason budget_exhausted)', lowAllowance.json?.[0]?.reserved === false && lowAllowance.json?.[0]?.refusal_reason === 'budget_exhausted', JSON.stringify(lowAllowance.json));

    const anon = await http('/rest/v1/rpc/aie_reserve_ai_cost_v2', { method: 'POST', key: ANON, body: { p_ledger_id: 'global', p_amount_usd: 0.000001, p_allowance_usd: 10, p_idempotency_key: nextKey('anon'), p_user_id: A, p_user_daily_cap_usd: null } });
    check('P8 the public anon key cannot call the per-user function', anon.status === 401 || anon.status === 403 || anon.status === 404, `http ${anon.status}`);

  } finally {
    // cleanup of PART 1
    await http(`/rest/v1/aie_ai_cost_attempt?idempotency_key=like.${PREFIX}-*`, { method: 'DELETE' });
    await http('/rest/v1/aie_ai_cost_ledger?id=eq.global', { method: 'PATCH', body: { reserved_usd: snap.reserved_usd, settled_usd: snap.settled_usd, total_attempts: snap.total_attempts } });
    const lRestored = await ledger();
    check('cleanup: probe rows deleted and the ledger figures restored to the snapshot', Number(lRestored.reserved_usd) === Number(snap.reserved_usd) && Number(lRestored.settled_usd) === Number(snap.settled_usd) && Number(lRestored.total_attempts) === Number(snap.total_attempts), `reserved=${lRestored.reserved_usd} settled=${lRestored.settled_usd} attempts=${lRestored.total_attempts}`);

  }

  // ---------------- PART 2: the real application path ----------------
  if (REAL) {
    Object.assign(process.env, {
      AIE_AI_PROVIDER: 'openai',
      AIE_AI_MODEL: 'gpt-4o-mini',
      AIE_AI_FALLBACK_ENABLED: 'true',
      AIE_MASK_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    });
    delete process.env.AIE_USER_DAILY_COST_CAP_USD;
    const { maskText } = await import('../lib/aie/masking/piiMasking');
    const { computeConservativeReservationUsd } = await import('../lib/aie/cost/costAdmission');
    const { requestBankStatementAiExtraction, BANK_STATEMENT_AI_EXTRACTION_SYSTEM_PROMPT } = await import('../lib/aie/adapters/bankStatement');
    const { getAieAiMaxOutputTokensPerLineItemDocument } = await import('../lib/aie/config');

    const TEXT = [
      'Harbourline Mutual Bank (synthetic test institution)',
      'This letter covers your everyday account from 1 August 2026 to 31 August 2026.',
      'You began the month with 2000.00 in the account.',
      'On 3 August 2026 your employer paid in 1850.00 as salary.',
      'On 7 August 2026 you paid 950.00 for rent.',
      'You finished the month with 2900.00 in the account.',
    ].join('\n');
    const masked = maskText(TEXT, { tenantKey: `ucap-live-${STAMP}` }).maskedText;
    const need = computeConservativeReservationUsd('gpt-4o-mini', { promptChars: BANK_STATEMENT_AI_EXTRACTION_SYSTEM_PROMPT.length + masked.length, maxOutputTokens: getAieAiMaxOutputTokensPerLineItemDocument() });
    const used0 = await usedToday(A);
    // The cap override can only LOWER the stored cap: set it so that exactly one call fits when nothing is held.
    process.env.AIE_USER_DAILY_COST_CAP_USD = String(used0 + need * 1.5);
    console.log(`real path: one call reserves about US$${need.toFixed(6)}; today's use for A=${used0.toFixed(6)}; cap override=${process.env.AIE_USER_DAILY_COST_CAP_USD} (lowers the stored ${capColumn})`);

    const hold = nextKey('hold');
    const held = await reserveV2(hold, need * 0.9, A, { cap: used0 + need * 1.5 });
    check('R0 a hold of 90 percent of one call is admitted for user A (their allowance is now mostly spoken for)', held.json?.[0]?.reserved === true, JSON.stringify(held.json));

    const l1 = await ledger();
    const refused = await requestBankStatementAiExtraction({ maskedText: masked, requestId: `ucap-live-${STAMP}-refused`, userId: A });
    const l2 = await ledger();
    check('R1 the real adapter call is refused as user_daily_cap_reached and OpenAI is never called', refused.outcome === 'user_daily_cap_reached' && (refused.evidence?.providerRequestIds ?? []).length === 0, `outcome=${refused.outcome} requestIds=${(refused.evidence?.providerRequestIds ?? []).length}`);
    check('R1b the refusal moved no spend (ledger reserved and settled unchanged)', Number(l1.reserved_usd) === Number(l2.reserved_usd) && Number(l1.settled_usd) === Number(l2.settled_usd), `reserved ${l1.reserved_usd} -> ${l2.reserved_usd}`);

    await settleV2(hold, 0);
    const l3 = await ledger();
    const real = await requestBankStatementAiExtraction({ maskedText: masked, requestId: `ucap-live-${STAMP}-real`, userId: A });
    const l4 = await ledger();
    const ev = real.evidence;
    const row = ev ? (await http(`/rest/v1/aie_ai_cost_attempt?idempotency_key=eq.${encodeURIComponent(ev.idempotencyKey)}&select=user_id,reserved_usd,settled_usd,model,provider_request_ids,admission_outcome`)).json?.[0] : null;
    check('R2 after the hold is released the same call is admitted, reaches OpenAI, and is settled against user A', (ev?.providerRequestIds ?? []).length >= 1 && row?.user_id === A && row?.admission_outcome === 'admitted' && Number(row?.settled_usd) > 0 && Number(row?.settled_usd) <= Number(row?.reserved_usd), `outcome=${real.outcome} spendUsd=${(Number(l4.settled_usd) - Number(l3.settled_usd)).toFixed(6)} model=${row?.model} requestIds=${(ev?.providerRequestIds ?? []).length}`);
    console.log(`        (the R2 spend is real and stays on the DEV ledger: key ${ev?.idempotencyKey ?? '(none)'}; the hold row ${hold} is kept as evidence too)`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL', e instanceof Error ? e.message : e);
  process.exit(2);
});
