// READ-ONLY: what the five standing DEV fixture users currently hold in the investment-intelligence tables (counts only; no names, no amounts).
import { db, USERS, userIdOf } from '../nav2_stage3/_lib.mjs';
const tables = ['ii_source_documents', 'ii_accounts', 'ii_transactions', 'ii_holding_snapshots', 'ii_portfolio_truth_status', 'ii_reconciliation_cases', 'ii_fhip_publications', 'ii_investment_date_inputs', 'nav2_fund_analytics_reports', 'investments', 'ii_audit_events'];
for (const [k, email] of Object.entries(USERS)) {
  const id = await userIdOf(email);
  const prof = (await db.from('user_profiles').select('country_of_residence,country_confirmed_at').eq('user_id', id).maybeSingle()).data;
  const ent = (await db.from('user_entitlements').select('plan_tier,effective_from,effective_to').eq('user_id', id).maybeSingle()).data;
  const row = {};
  for (const t of tables) {
    const c = await db.from(t).select('*', { count: 'exact', head: true }).eq('user_id', id);
    row[t.replace('ii_', '')] = c.error ? 'n/a' : c.count;
  }
  console.log(k, id.slice(0, 8), JSON.stringify({ country: prof?.country_of_residence, confirmed: !!prof?.country_confirmed_at, plan: ent?.plan_tier, from: ent?.effective_from, to: ent?.effective_to }), JSON.stringify(row));
}
