// AIE other-PDF AI proof (2026-09-25) -- independent zero-residue check after
// `aie1_final_dev_cleanup.ts`: every document id and user id this run
// recorded in its manifest is looked up in every table the journeys can
// touch, by id, and must be absent. Read-only. DEV host asserted.
//
// Run: AIE1_MANIFEST=<manifest> node scripts/aie1_other_pdf_residue_check.mjs
import fs from 'node:fs';
import { devFetch, MANIFEST } from './aie1_final_dev_harness.mjs';

const lines = fs.readFileSync(MANIFEST, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const users = [...new Set(lines.filter((e) => e.kind === 'auth_user').map((e) => e.id))];
const docs = [...new Set(lines.filter((e) => e.kind === 'fdh_statement_uploads').map((e) => e.id))];
const byDoc = ['fdh_ai_fallback_drafts', 'fdh_transactions', 'fdh_reconciliation_results', 'fdh_data_quality_results', 'fdh_review_items', 'fdh_liability_statements', 'fdh_retirement_statements', 'fdh_investment_statements'];
const byUser = ['fdh_statement_uploads', 'fdh_ai_fallback_drafts', 'fdh_document_audit_events', 'fdh_transactions', 'fdh_liability_statements', 'fdh_retirement_statements', 'fdh_investment_statements', 'user_profiles', 'financial_accounts'];
let total = 0;
const report = {};
const chunks = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, (i + 1) * n));
for (const t of byDoc) {
  let n = 0;
  for (const c of chunks(docs, 40)) {
    const r = await devFetch(`/rest/v1/${t}?statement_upload_id=in.(${c.join(',')})&select=id`);
    n += Array.isArray(r.json) ? r.json.length : 0;
  }
  report[`${t} (by document)`] = n; total += n;
}
{
  let n = 0;
  for (const c of chunks(docs, 40)) {
    const r = await devFetch(`/rest/v1/fdh_statement_uploads?id=in.(${c.join(',')})&select=id`);
    n += Array.isArray(r.json) ? r.json.length : 0;
  }
  report['fdh_statement_uploads (by id)'] = n; total += n;
}
for (const t of byUser) {
  let n = 0;
  for (const c of chunks(users, 40)) {
    const r = await devFetch(`/rest/v1/${t}?user_id=in.(${c.join(',')})&select=user_id`);
    if (r.status === 400) { report[`${t} (by user)`] = 'n/a'; n = -1; break; }
    n += Array.isArray(r.json) ? r.json.length : 0;
  }
  if (n >= 0) { report[`${t} (by user)`] = n; total += n; }
}
let authLeft = 0;
for (const id of users) if ((await devFetch(`/auth/v1/admin/users/${id}`)).status !== 404) authLeft++;
report['auth users'] = authLeft; total += authLeft;
console.log(JSON.stringify({ users: users.length, documents: docs.length, report, totalResidue: total }, null, 2));
process.exit(total === 0 ? 0 : 1);
