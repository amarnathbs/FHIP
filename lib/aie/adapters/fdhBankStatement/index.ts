/**
 * AIE-1.3 — FDH bank-statement adapter: module entry point.
 *
 * Importing this module (once, at process start — `route.ts` does this)
 * registers:
 *   1. This adapter's schemas into AIE-1.1's shared `aieSchemaRegistry`
 *      (`schema.ts`'s side-effecting `aieSchemaRegistry.register(...)` calls).
 *   2. A STATELESS classification-only `RegisteredParser` into AIE-1.1's
 *      global `aieParserRegistry` — satisfying AIE13-AI-01 ("wrap existing
 *      certified bank adapters as AIE deterministic parsers") for the part
 *      of FDH-5 that genuinely has no per-request dependency (institution/
 *      layout sniffing). The full, request-scoped transaction-row parser
 *      (`createFdhBankStatementParser`, see `parser.ts`'s header for why) is
 *      NOT registered here — it is constructed per-intake by `route.ts`.
 */

import './schema';
import { aieParserRegistry } from '../../classifier/registry';
import { detectPdfBankAdapter } from '@/lib/financial-data-hub/bank-pdf/detection';
import type { RegisteredParser } from '../../classifier/registry';
import { ADAPTER_ID_FIELD_NAME } from './types';

export const FDH_BANK_CLASSIFICATION_ADAPTER_ID = 'aie_fdh_bank_statement_classification_v1';

/** Classification-only: reports WHICH certified institution/layout an
 * already-extracted statement text most likely belongs to, and nothing
 * else. Registered globally because it is genuinely stateless (unlike
 * transaction-row extraction, institution detection needs no account-scoped
 * dedup index) — see `types.ts`'s header for the full explanation of why
 * the row-level parser is a per-request factory instead. */
export const fdhBankStatementClassificationParser: RegisteredParser = {
  adapterId: FDH_BANK_CLASSIFICATION_ADAPTER_ID,
  version: '1',
  moduleHint: 'fdh_bank',
  sniff(extractedText: string): boolean {
    const detection = detectPdfBankAdapter(extractedText);
    return detection.status !== 'unsupported_layout';
  },
  parse(extractedText: string) {
    const detection = detectPdfBankAdapter(extractedText);
    if (detection.status === 'detected' && detection.adapter) {
      return {
        outcome: 'complete' as const,
        documentClass: 'fdh_bank_statement',
        candidates: [{ fieldName: ADAPTER_ID_FIELD_NAME, valueRaw: detection.adapter.id, isNull: false, sourceMethod: 'deterministic' as const }],
        aiEligibleGaps: [],
      };
    }
    return { outcome: 'not_applicable' as const, candidates: [], aiEligibleGaps: [] };
  },
};

let registered = false;
export function registerFdhBankStatementAdapter(): void {
  if (registered) return;
  registered = true;
  try {
    aieParserRegistry.register(fdhBankStatementClassificationParser);
  } catch {
    // Already registered by a prior import in the same process (e.g. hot
    // reload / multiple route modules importing this index) — the registry
    // itself already refuses a duplicate id+version; swallow only THAT
    // specific, harmless case rather than crashing route initialisation.
  }
}

registerFdhBankStatementAdapter();

export * from './types';
export * from './parser';
export * from './reconciliation';
export * from './atomicImport';
export * from './featureFlags';
export * from './schema';
