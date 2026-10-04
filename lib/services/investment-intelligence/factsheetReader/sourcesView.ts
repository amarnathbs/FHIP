// The "Factsheet sources" panel: the registered fund-house documents and whether their terms are approved.
// Pure and client-safe (no I/O, no secrets). No personal data: the reviewer's identity is NOT returned, only when the
// status was last set and the note that was recorded with it.

import { checkViewFromAttempt, type FactsheetCheckView } from './adminView';

export type TermsDecision = 'approved' | 'not_reviewed' | 'declined';
export const TERMS_DECISIONS: readonly TermsDecision[] = ['approved', 'not_reviewed', 'declined'];

export interface FactsheetSourceAdminView {
  id: string;
  sourceKey: string;
  amcName: string;
  documentType: string;
  url: string;
  host: string;
  amfiSchemeCodes: string[];
  termsReviewStatus: string;
  /** When the status was last set by a person (null = never reviewed). */
  termsReviewedAt: string | null;
  termsReviewNote: string | null;
  enabled: boolean;
  /** The latest reader attempt on this source (any scheme), or null when the reader has never tried it. */
  lastResult: FactsheetCheckView | null;
}

export interface FactsheetSourcesResponse {
  state: 'ok';
  sources: FactsheetSourceAdminView[];
}

export interface SourceRow {
  id: string;
  source_key: string;
  amc_name: string;
  document_type: string;
  url: string;
  host: string;
  amfi_scheme_codes: string[] | null;
  terms_review_status: string;
  terms_reviewed_at: string | null;
  terms_review_note: string | null;
  enabled: boolean;
}

export function buildFactsheetSourceViews(rows: readonly SourceRow[], attempts: ReadonlyArray<{ source_id: string; attempted_at: string; outcome: string; document_date: string | null }>): FactsheetSourceAdminView[] {
  const latest = new Map<string, FactsheetCheckView>();
  for (const a of [...attempts].sort((x, y) => y.attempted_at.localeCompare(x.attempted_at))) {
    if (latest.has(a.source_id)) continue;
    const v = checkViewFromAttempt(a);
    if (v) latest.set(a.source_id, v);
  }
  return rows
    .map((r) => ({
      id: r.id,
      sourceKey: r.source_key,
      amcName: r.amc_name,
      documentType: r.document_type,
      url: r.url,
      host: r.host,
      amfiSchemeCodes: (r.amfi_scheme_codes ?? []).map(String),
      termsReviewStatus: r.terms_review_status,
      termsReviewedAt: r.terms_reviewed_at,
      termsReviewNote: r.terms_review_note,
      enabled: r.enabled === true,
      lastResult: latest.get(r.id) ?? null,
    }))
    .sort((a, b) => a.sourceKey.localeCompare(b.sourceKey));
}
