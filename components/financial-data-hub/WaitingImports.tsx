'use client';

/**
 * "Continue where you left off" for the statement import panels (2026-09-25).
 *
 * Closing a statement panel, or reloading the page, used to strand whatever
 * the user was part-way through -- an AI reading awaiting a check, evidence
 * awaiting approval, a comparison never applied -- because nothing on screen
 * listed it. The payslip panel fixed this for payslips with its own waiting
 * list; this is the shared version for the liability, retirement, investment
 * and bank-statement panels, so they cannot drift apart.
 *
 * Talks to `GET /api/financial-data-hub/waiting-imports` over fetch() only
 * (the row shape is declared here, not imported, for the same reason every
 * FDH panel does so -- see fdh1Isolation.test.ts).
 */

import { useCallback, useEffect, useState } from 'react';

export type WaitingImportKind = 'liability' | 'retirement' | 'investment' | 'bank';
export type WaitingImportStage = 'ai_draft' | 'review' | 'compare' | 'apply';

/** One row of `GET /waiting-imports`, in the API's own snake_case. */
export interface WaitingImport {
  document_id: string;
  stage: WaitingImportStage;
  document_type: string | null;
  country_code: string | null;
  currency_code: string | null;
  uploaded_at: string | null;
  label: string | null;
  period_end: string | null;
  ai_fallback_draft?: unknown;
}

/** Plain words for where the user left off. */
export const WAITING_STAGE_TEXT: Record<WaitingImportStage, string> = {
  ai_draft: 'read by AI — waiting for you to check it',
  review: 'waiting for you to check and approve it',
  compare: 'approved — waiting for you to compare and apply it',
  apply: 'approved — waiting for you to apply it',
};

const DOCUMENT_TYPE_TEXT: Record<string, string> = {
  credit_card_statement: 'Credit card statement',
  loan_statement: 'Loan statement',
  super_statement: 'Super statement',
  epf_statement: 'Retirement statement',
  investment_statement: 'Investment statement',
  bank_statement: 'Bank statement',
};

/** What every panel says when a re-upload is carried on with the original
 * (the payslip panel's wording). */
export const DUPLICATE_UPLOAD_MESSAGE = 'You have already uploaded this statement, so FHIP is continuing with the copy already on file.';

/** Keeps only well-formed rows, so a changed API can never render a blank,
 * unclickable entry (the payslip panel's 2026-09-25 field-shape lesson). */
export function normaliseWaitingImports(raw: unknown): WaitingImport[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (r): r is WaitingImport =>
      typeof r === 'object' && r !== null && typeof (r as WaitingImport).document_id === 'string'
      && (r as WaitingImport).document_id !== '' && typeof (r as WaitingImport).stage === 'string'
      && (r as WaitingImport).stage in WAITING_STAGE_TEXT,
  );
}

export function useWaitingImports(kind: WaitingImportKind) {
  const [items, setItems] = useState<WaitingImport[]>([]);
  const reload = useCallback(() => {
    fetch(`/api/financial-data-hub/waiting-imports?kind=${kind}`)
      .then((res) => (res.ok ? res.json() : { data: { items: [] } }))
      .then((json) => setItems(normaliseWaitingImports(json?.data?.items)))
      .catch(() => setItems([]));
  }, [kind]);
  useEffect(() => {
    reload();
  }, [reload]);
  return { items, reload };
}

/** Marks an AI reading as not right, so it is not offered again. Best effort:
 * a failure leaves the draft resumable, never loses the user's work. */
export async function discardAiDraft(documentId: string): Promise<void> {
  try {
    await fetch(`/api/financial-data-hub/documents/${documentId}/ai-draft/discard`, { method: 'POST' });
  } catch {
    // Best effort only.
  }
}

export function WaitingImportsList({
  items,
  busy,
  onContinue,
}: {
  items: WaitingImport[];
  busy: boolean;
  onContinue: (item: WaitingImport) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section className="mt-4 space-y-2" aria-labelledby="statements-waiting-heading">
      <h3 id="statements-waiting-heading" className="text-sm font-semibold">
        {items.length === 1 ? 'You have a statement to finish' : `You have ${items.length} statements to finish`}
      </h3>
      <ul className="space-y-2">
        {items.map((w) => (
          <li
            key={`${w.stage}-${w.document_id}`}
            className="flex flex-wrap items-center justify-between gap-2 rounded border border-gray-200 px-3 py-2 text-sm"
          >
            <span>
              {DOCUMENT_TYPE_TEXT[w.document_type ?? ''] ?? 'Statement'}
              {w.label && ` · ${w.label}`}
              {w.period_end && ` · to ${w.period_end}`}
              {' · '}
              {WAITING_STAGE_TEXT[w.stage]}
            </span>
            <button
              type="button"
              onClick={() => onContinue(w)}
              disabled={busy}
              className="rounded bg-trust px-3 py-1 text-white disabled:opacity-50"
            >
              Continue
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
