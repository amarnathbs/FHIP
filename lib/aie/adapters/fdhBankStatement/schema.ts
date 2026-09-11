/**
 * AIE-1.3 — FDH bank-statement adapter: schema registration (AIE13-AI-07,
 * "require strict bank-statement JSON Schema with no extra properties").
 *
 * DISCLOSED LIMITATION. `lib/aie/orchestrator.ts`'s `runExtractionPipeline`
 * hardcodes every AI-fallback call to AIE-1.1's own generic
 * `AIE_GENERIC_FIELD_COMPLETION_SCHEMA_NAME`/`_VERSION` (see that file:
 * "the ONE typed internal extraction operation") — no per-adapter schema
 * selection hook exists yet in AIE-1.1 core for the actual provider-facing
 * envelope. This adapter therefore registers its own schema for two
 * narrower, real purposes rather than claiming it gates the live AI call
 * (which it does not, honestly, this pass):
 *   1. `FDH_BANK_INSTITUTION_HINT_SCHEMA` — the CLOSED enum an institution
 *      hint candidate must satisfy before this adapter's reconciliation
 *      layer will even treat it as displayable evidence (see
 *      `reconciliation.ts#extractInstitutionHintForDisplay`, which additionally
 *      requires `sourceMethod === 'ai'`). A free-text institution name from
 *      the model is never accepted — only one of FDH-5's own already-
 *      certified adapter ids.
 *   2. `FDH_BANK_STATEMENT_EXTRACTION_SCHEMA` — documents, and is asserted
 *      against in tests, the exact shape `parser.ts`'s deterministic
 *      candidates conform to (AIE13 deliverable 3: "versioned bank-statement
 *      schemas and example envelopes") — a traceability/test artefact, not
 *      (this pass) a live AI-output gate.
 */

import { z } from 'zod';
import { aieSchemaRegistry } from '../../schema/schemaRegistry';
import { PDF_BANK_ADAPTER_REGISTRY } from '@/lib/financial-data-hub/bank-pdf/adapters/registry';
import { FDH_RECONCILIATION_STATUSES } from '@/lib/financial-data-hub/constants/enums';

export const FDH_BANK_INSTITUTION_HINT_SCHEMA_NAME = 'fdh_bank_institution_hint';
export const FDH_BANK_INSTITUTION_HINT_SCHEMA_VERSION = '1';

/** Closed enum, generated from the SAME certified-adapter registry FDH-5
 * itself detects against — impossible for this list to silently drift from
 * what is actually certified (no hand-maintained duplicate list). */
export const CERTIFIED_PDF_BANK_ADAPTER_IDS = PDF_BANK_ADAPTER_REGISTRY.map((a) => a.id) as [string, ...string[]];

export const fdhBankInstitutionHintSchema = z
  .object({
    adapterId: z.enum(CERTIFIED_PDF_BANK_ADAPTER_IDS),
    sourceReferenceId: z.string().min(1),
  })
  .strict();

aieSchemaRegistry.register({
  name: FDH_BANK_INSTITUTION_HINT_SCHEMA_NAME,
  version: FDH_BANK_INSTITUTION_HINT_SCHEMA_VERSION,
  schema: fdhBankInstitutionHintSchema,
  ownerAdapterId: 'aie_fdh_bank_statement_bridge_v1',
});

export const FDH_BANK_STATEMENT_EXTRACTION_SCHEMA_NAME = 'fdh_bank_statement_extraction';
export const FDH_BANK_STATEMENT_EXTRACTION_SCHEMA_VERSION = '1';

const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'must be a plain decimal string');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO 8601 date (YYYY-MM-DD)');

/** Mirrors `AcceptedPdfTransactionPlan` (FDH-5, `bank-pdf/orchestrator.ts`)
 * — see this file's own header for why this is a documentation/test schema,
 * not (this pass) a live AI-output validation gate. */
export const fdhBankStatementTransactionRowSchema = z
  .object({
    sourceRowNumber: z.number().int().positive(),
    transactionDate: isoDate,
    descriptionClean: z.string().max(500),
    amountOriginal: decimalString,
    creditDebit: z.enum(['debit', 'credit']),
    balanceAfter: decimalString.nullable(),
    dedupStatus: z.enum(['unique', 'duplicate_confirmed', 'duplicate_candidate']),
  })
  .strict();

export const fdhBankStatementExtractionSchema = z
  .object({
    adapterId: z.enum(CERTIFIED_PDF_BANK_ADAPTER_IDS),
    reconciliationStatus: z.enum(FDH_RECONCILIATION_STATUSES),
    rows: z.array(fdhBankStatementTransactionRowSchema).max(5000),
  })
  .strict();

aieSchemaRegistry.register({
  name: FDH_BANK_STATEMENT_EXTRACTION_SCHEMA_NAME,
  version: FDH_BANK_STATEMENT_EXTRACTION_SCHEMA_VERSION,
  schema: fdhBankStatementExtractionSchema,
  ownerAdapterId: 'aie_fdh_bank_statement_bridge_v1',
});
