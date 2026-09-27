/* eslint-disable @typescript-eslint/no-explicit-any -- certification harness: untyped JSON route responses */
/**
 * SECURITY REVIEW (range D) -- cross-tenant split lines.
 *
 * fdh_transaction_allocations has an "own rows" RLS policy and a FOREIGN KEY to fdh_transactions, but
 * nothing checks that the parent transaction belongs to the allocation's user (the FK check bypasses
 * RLS). 0212's new guard trigger is SECURITY INVOKER, so it cannot see a foreign parent either. The
 * unique key (transaction_id, allocation_sequence) is global. Probe: the attacker (knowing one of the
 * victim's transaction ids) inserts an allocation on it; the victim then saves a split through the app.
 *
 *   CERT_PORT=3974 npx tsx scripts/canonical_cert/secrev/scenario_allocation_tenant.ts --victim V --attacker A
 */
import { call, expect, results, saveEvidence } from './lib';
import { importAndApproveBank, rowsFor, userIdOf } from './flows';
import { loadDevEnv } from '../lib/env.mjs';
import { loadSession } from '../lib/session.mjs';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const victim = arg('--victim')!;
const attacker = arg('--attacker')!;
const evidence: Record<string, unknown> = {};

async function asUser(email: string, method: string, path: string, body?: unknown) {
  const { url, anonKey } = loadDevEnv();
  const s = loadSession(email);
  const chunk = (n: string) => { const m = n.match(/^sb-[a-z0-9]+-auth-token(?:\.(\d+))?$/); return m ? Number(m[1] ?? -1) : null; };
  const raw = Object.entries(s.cookies as Record<string, string>).filter(([n]) => chunk(n) !== null).sort(([a], [b]) => (chunk(a) as number) - (chunk(b) as number)).map(([, v]) => v).join('');
  const token = JSON.parse(raw.startsWith('base64-') ? Buffer.from(raw.slice(7), 'base64url').toString('utf8') : raw).access_token;
  const res = await fetch(`${url}${path}`, { method, headers: { apikey: anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

async function main() {
  const victimId = await userIdOf(victim);
  const attackerId = await userIdOf(attacker);
  const bank = await importAndApproveBank(victim, [
    { date: '2026-08-10', description: 'SECREV GROCER AND HARDWARE', amount: -120, category: null },
  ], { masked: 'xxxx7407', filename: 'fhip-test-bank-secrev-victim.csv', approve: false });
  const txn = bank.txns[0];
  evidence.victimTxn = { id: txn?.id, approval: txn?.approval_status };
  // The attacker's forged split line on the victim's transaction (the id is assumed leaked).
  const forged = await asUser(attacker, 'POST', '/rest/v1/fdh_transaction_allocations', { user_id: attackerId, transaction_id: txn.id, allocation_sequence: 1, economic_transaction_type: 'expense', amount: 1, currency_code: 'AUD' });
  evidence.forged = { status: forged.status, body: forged.text.slice(0, 300) };
  expect(forged.status >= 400, 'an allocation can never be attached to another user\'s transaction', { status: forged.status, body: forged.text.slice(0, 200) });
  // The victim saves a split through the app (split route -> fdh8_replace_transaction_allocations).
  const split = await call(victim, 'POST', `/api/financial-data-hub/bank-transactions/${txn.id}/split`, { json: { allocations: [{ economic_transaction_type: 'expense', amount: 100 }, { economic_transaction_type: 'expense', amount: 20 }] } });
  evidence.victimSplit = { status: split.status, body: JSON.stringify(split.json).slice(0, 300) };
  expect(split.status < 300, 'the victim can still split their own transaction', evidence.victimSplit);
  const own = await rowsFor('fdh_transaction_allocations', victimId, 'id,allocation_sequence,amount', (q) => q.eq('transaction_id', txn.id));
  const foreign = await rowsFor('fdh_transaction_allocations', attackerId, 'id,allocation_sequence,amount', (q) => q.eq('transaction_id', txn.id));
  evidence.after = { victimRows: own, attackerRowsOnVictimTxn: foreign };
  saveEvidence('secrev_allocation_tenant', { evidence, results });
  console.log(JSON.stringify(evidence, null, 1));
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
}
main().catch((e) => { console.error(e); saveEvidence('secrev_allocation_tenant_error', { evidence, results, error: String(e?.stack ?? e) }); process.exitCode = 1; });
