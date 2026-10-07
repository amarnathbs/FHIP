// Shared journey steps (DEV, real routes on the app server): upload + accept a synthetic statement, generate a report, read it back.
import fs from 'node:fs';
import path from 'node:path';
import { api, db, OUT, USERS, userIdOf } from './_lib.mjs';

export const FUND = { A: '575b7dc3-dc60-4218-8b75-5ef68c964afe', B: '31a05b68-05f1-49d8-8d87-334e221e5740', C: '70c403e9-a81a-43be-9bcf-b03edf88ec0f', D: '2c5322cb-cb50-485c-8c9e-216b2dc6b580', E: '37a3d60e-47db-4fb9-af8b-4a174dfa1f2f' };

export async function uploadAndAccept(email, statementId, { documentType = 'cas_statement', owner } = {}) {
  const self = await api(email, 'POST', '/api/ownership/self');
  const memberId = self.json?.data?.memberId;
  const pdf = fs.readFileSync(path.join(OUT, 'statements', `${statementId}.pdf`));
  const fd = new FormData();
  fd.append('file', new Blob([pdf], { type: 'application/pdf' }), `${statementId}.pdf`);
  fd.append('meta', JSON.stringify({ sourceKey: 'manual', documentType, countryCode: 'IN', owner: owner ?? { kind: 'member', memberId } }));
  const r = new Response(fd);
  const up = await api(email, 'POST', '/api/investment-intelligence/source-documents', { body: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get('content-type') });
  const docId = up.json?.data?.id;
  if (!docId) return { ok: false, step: 'upload', status: up.status, body: up.text.slice(0, 300) };
  const proc = await api(email, 'POST', `/api/investment-intelligence/source-documents/${docId}/process`, { json: {} });
  return { ok: proc.status === 200, step: 'process', status: proc.status, docId, memberId, deduplicated: up.json?.data?.deduplicated === true };
}

export async function generate(email, period = 'since_first_held', maxTries = 6) {
  let g;
  for (let i = 0; i < maxTries; i++) {
    g = await api(email, 'POST', '/api/reports/fund-analytics', { json: { period } });
    if (g.status !== 202) break;
    await new Promise((r) => setTimeout(r, 8000));
  }
  return { status: g.status, id: g.json?.data?.report?.id ?? null, summary: g.json?.data?.report ?? null, body: g.text.slice(0, 300) };
}

export async function readReport(email, id) {
  const r = await api(email, 'GET', `/api/reports/fund-analytics/${id}`);
  return { status: r.status, report: r.json?.data?.report, summary: r.json?.data?.summary, checksum: r.json?.data?.manifestChecksum, text: r.text };
}

/** Raw stored report row (service role) for byte-level immutability comparisons. */
export async function storedRow(id) {
  const { data } = await db.from('nav2_fund_analytics_reports').select('id, user_id, version_number, report_json, manifest_json, manifest_checksum, created_at').eq('id', id).single();
  return data;
}

export const cacheRows = async (instrumentIds) => (await db.from('nav2_result_cache').select('cache_key, instrument_id, invalidated_at, actual_end, definition_version, risk_free_dataset_id').in('instrument_id', instrumentIds)).data ?? [];
export { api, db, USERS, userIdOf };
