/* eslint-disable @typescript-eslint/no-explicit-any -- DEV harness */
/**
 * Document2 (4) WP-G: measures the REAL AI reading time of one PART of a bank statement (the unit the background job sends), on DEV only.
 * Label for what it proves: DEV-verified timing of the provider call (real gpt-4o-mini, real cost reservation on the DEV ledger).
 * It needs NO job tables. It sizes the part (lines per part) and the per-call timeout used by the job.
 *
 * SAFETY: DEV host asserted; PRODUCTION_* removed; one passwordless synthetic user (deleted at the end); synthetic text only; prints
 * timings and token counts, never a secret.
 *
 *   npx tsx scripts/doc2_4_wp_g_ai_timing.ts [partLinesCsv]   e.g. 10,20,28,40
 */
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';

const DEV_HOST = 'vqycarelcoijzwlpkpcz.supabase.co';
for (const line of fs.readFileSync('D:/FHIP/.env.local', 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
  const i = line.indexOf('=');
  if (i > 0 && !process.env[line.slice(0, i).trim()]) process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"|"$/g, '');
}
for (const k of Object.keys(process.env)) if (k.startsWith('PRODUCTION_')) delete process.env[k];
if (new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).host !== DEV_HOST) throw new Error('REFUSING: not the DEV project');
Object.assign(process.env, {
  AIE_AI_FALLBACK_ENABLED: 'true',
  AIE_AI_PROVIDER: 'openai',
  AIE_AI_MODEL: 'gpt-4o-mini',
  AIE_MASK_TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
});
delete process.env.AIE_AI_COST_ALLOWANCE_USD;

const BASE = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = async (p: string, init: RequestInit = {}) => fetch(`${BASE}${p}`, { ...init, headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });

function part(n: number, salt: number) {
  let bal = 20000;
  const lines: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const dr = i % 7 !== 0;
    const amt = Math.round((10 + (((i + salt) * 7919) % 900) + 0.35) * 100) / 100;
    bal = Math.round((bal + (dr ? -amt : amt)) * 100) / 100;
    lines.push(`${String(1 + (i % 28)).padStart(2, '0')}/09/2026 | PURCHASE ${i + 1 + salt} | ${dr ? amt.toFixed(2) : ''} | ${dr ? '' : amt.toFixed(2)} | ${bal.toFixed(2)}`);
  }
  return `[This is part 2 of 9 of one bank statement (pages 3 to 4). Report only the transaction lines printed in THIS part, in the order printed. Statement header figures only if printed in this part, otherwise null. Set allTransactionsListed to true only if every transaction line in this part is listed.]\n${lines.join('\n')}`;
}

async function main() {
  const sizes = (process.argv[2] ?? '10,20,28,40').split(',').map(Number);
  const email = `wpg-ai-${Date.now()}@fhip-test.invalid`;
  const created = await (await admin('/auth/v1/admin/users', { method: 'POST', body: JSON.stringify({ email, email_confirm: true }) })).json();
  const userId = created.id as string;
  if (!userId) throw new Error('could not create the synthetic user');
  const { requestBankStatementAiExtraction } = await import('../lib/aie/adapters/bankStatement/gateway');
  const results: any[] = [];
  try {
    for (const n of sizes) {
      const one = async (salt: number) => {
        const t0 = Date.now();
        const out = await requestBankStatementAiExtraction({ maskedText: part(n, salt), requestId: `timing-${n}-${salt}`, userId, timeoutMs: 15_000, maxTransientRetries: 0 });
        return { ms: Date.now() - t0, outcome: out.outcome, rows: out.outcome === 'success' ? out.facts.transactions.length : null, inTok: (out as any).evidence?.inputTokens, outTok: (out as any).evidence?.outputTokens };
      };
      const serial = [await one(0), await one(100)];
      const t0 = Date.now();
      const parallel = await Promise.all([200, 300, 400, 500].map((s) => one(s)));
      const row = { lines: n, serial, parallelOf4WallMs: Date.now() - t0, parallel };
      results.push(row);
      console.log(JSON.stringify(row));
    }
  } finally {
    await admin(`/auth/v1/admin/users/${userId}`, { method: 'DELETE' }).catch(() => undefined);
  }
  fs.writeFileSync('C:/Users/user/AppData/Local/Temp/claude/D--FHIP--claude-worktrees-audit-lr-2026-09-21/e1468c38-4b9f-45c2-b862-ab8725ccd725/scratchpad/wpg_ai_timing.json', JSON.stringify(results, null, 1));
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
