/**
 * FDH-5 — Bank PDF Statement Engine: adapter/layout detection (spec sections
 * 28-31, 95-96).
 *
 * DETERMINISTIC: full-text marker scoring -> best/second-best gap check ->
 * DETECTED / AMBIGUOUS / UNSUPPORTED_LAYOUT. Never relies on the filename or
 * on the user's selected institution alone (spec 29) — mirrors
 * `bank-csv/detection.ts`'s exact confidence-gap discipline
 * (`PDF_DETECTION_CONFIDENCE_GAP`/`PDF_DETECTION_MIN_CONFIDENCE`, spec 96:
 * "do not weaken the threshold merely to pass fixtures").
 */

import { PDF_BANK_ADAPTER_REGISTRY } from './adapters/registry';
import type { PdfBankAdapter } from './adapters/types';
import { PDF_DETECTION_CONFIDENCE_GAP, PDF_DETECTION_MIN_CONFIDENCE } from './constants';

export type PdfDetectionStatus = 'detected' | 'ambiguous' | 'unsupported_layout';

export interface PdfAdapterCandidateScore {
  adapterId: string;
  score: number;
}

export interface PdfDetectionResult {
  status: PdfDetectionStatus;
  adapter: PdfBankAdapter | null;
  confidence: number | null;
  candidates: PdfAdapterCandidateScore[];
}

export function detectPdfBankAdapter(fullText: string): PdfDetectionResult {
  const candidates: PdfAdapterCandidateScore[] = PDF_BANK_ADAPTER_REGISTRY.map((adapter) => ({
    adapterId: adapter.id,
    score: adapter.scoreText(fullText),
  })).sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (!best || best.score < PDF_DETECTION_MIN_CONFIDENCE) {
    return { status: 'unsupported_layout', adapter: null, confidence: best?.score ?? 0, candidates };
  }

  const runnerUp = candidates[1];
  if (runnerUp && runnerUp.score >= PDF_DETECTION_MIN_CONFIDENCE && best.score - runnerUp.score < PDF_DETECTION_CONFIDENCE_GAP) {
    // spec 96: never silently pick a winner when two candidates are this
    // close — never weakened, regardless of how tempting a fixture makes it.
    return { status: 'ambiguous', adapter: null, confidence: best.score, candidates };
  }

  const adapter = PDF_BANK_ADAPTER_REGISTRY.find((a) => a.id === best.adapterId) ?? null;
  return { status: 'detected', adapter, confidence: best.score, candidates };
}
