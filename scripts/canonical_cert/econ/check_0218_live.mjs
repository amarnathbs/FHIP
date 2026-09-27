/**
 * Behavioural confirmation that migration 0218 (security review hardening) is live on DEV: the probe
 * script only covers 0207-0214, so this checks 0218's own SR-04 fix directly -- anon must NOT be able
 * to execute the WP-15 entry points (fdh15_apply_asset_proposal / fdh15_apply_expense_proposals).
 * Read-only / no-op: the RPC call is expected to be REFUSED before it reads or writes anything.
 */
import { anonClient } from '../lib/env.mjs';

async function main() {
  const anon = await anonClient();
  const r1 = await anon.rpc('fdh15_apply_asset_proposal', { p_proposal_id: '00000000-0000-0000-0000-000000000000', p_decision: 'add_new', p_selected_fields: null });
  const r2 = await anon.rpc('fdh15_apply_expense_proposals', { p_decisions: [] });
  const out = {
    fdh15_apply_asset_proposal: { error: r1.error ? { code: r1.error.code, message: r1.error.message } : null, data: r1.data },
    fdh15_apply_expense_proposals: { error: r2.error ? { code: r2.error.code, message: r2.error.message } : null, data: r2.data },
  };
  console.log(JSON.stringify(out, null, 2));
  const refused = (r) => Boolean(r.error) && (r.error.code === '42501' || /permission denied/i.test(r.error.message ?? ''));
  const ok = refused(r1.error ? { error: r1.error } : { error: null }) && refused(r2.error ? { error: r2.error } : { error: null });
  console.log(ok ? 'PASS: anon refused on both WP-15 entry points (0218 SR-04 live)' : 'FAIL: anon was not refused -- 0218 may not be live');
  process.exitCode = ok ? 0 : 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
