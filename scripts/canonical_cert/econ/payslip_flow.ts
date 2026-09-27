/* eslint-disable @typescript-eslint/no-explicit-any -- certification harness: untyped JSON route responses */
/** The Income -> Import payslip panel's request sequence (upload session -> complete -> process -> approve -> proposal). */
import { call } from './lib';
import { payslipPdf, type Month, type PayslipParams } from '../documents/builders';

export async function uploadPayslip(email: string, m: Month, salt: string, p: PayslipParams = {}) {
  const doc = payslipPdf(m, salt, p);
  const s = await call(email, 'POST', '/api/financial-data-hub/documents/upload-sessions', { json: { document_type: 'payslip', source_type: 'pdf_native', country_code: 'AU', declared_mime_type: 'application/pdf', declared_file_size_bytes: doc.bytes.length } });
  if (s.status >= 300) throw new Error(`upload-session HTTP ${s.status}: ${s.text.slice(0, 300)}`);
  const c = await call(email, 'POST', `/api/financial-data-hub/documents/upload-sessions/${s.json.data.session_id}/complete`, { body: doc.bytes, contentType: 'application/pdf' });
  if (c.status >= 300) throw new Error(`complete HTTP ${c.status}: ${c.text.slice(0, 300)}`);
  const documentId = c.json.data.document_id as string;
  const proc = await call(email, 'POST', `/api/financial-data-hub/payslip/${documentId}/process`);
  const review = await call(email, 'GET', `/api/financial-data-hub/payslip/${documentId}`);
  return { documentId, oracle: doc.oracle, complete: c.json?.data, process: { status: proc.status, json: proc.json }, review: review.json?.data };
}

export async function approvePayslip(email: string, documentId: string, owner = 'self') {
  const ap = await call(email, 'POST', `/api/financial-data-hub/payslip/${documentId}/approve`, { json: { income_owner: owner, acknowledge_review: true, replaces_earlier: false } });
  const pr = await call(email, 'POST', `/api/financial-data-hub/payslip/${documentId}/proposal`);
  return { approve: { status: ap.status, json: ap.json }, proposal: { status: pr.status, json: pr.json }, proposalId: pr.json?.data?.proposal_id as string | undefined, fields: (pr.json?.data?.fields ?? []) as any[] };
}

export function incomeApplyRoute(proposalId: string) { return `/api/financial-data-hub/income-proposals/${proposalId}/apply`; }

/** The Income panel's selection: every recommended, non-confirmation field (add_new) / changed ones (update). */
export function payslipPanelSelection(fields: any[]): string[] {
  return fields.filter((f) => f.is_recommended && !f.requires_confirmation && f.proposed_value !== f.existing_value).map((f) => f.field_name);
}
