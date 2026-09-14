/**
 * M3 (Phase 4), item I.4 — the versioned, strict AI INVESTMENT DOCUMENT-FACTS
 * contract.
 *
 * HOW THIS DIFFERS FROM THE SCHEMA THAT ALREADY EXISTED, AND WHY BOTH STAY.
 *
 * `schema.ts` in this same directory registers
 * `aie_ii_adapter_field_completion` — a deliberately tiny schema whose closed
 * `fieldName` enum contains exactly one entry
 * (`sourceDescriptionClarification`). That schema answers the question "the
 * deterministic parser read this line but one narrative fragment was
 * illegible; what does it say?" It is a GAP-FILLING contract and it is
 * correct for that job. It is not removed or widened here.
 *
 * This file answers a different question, the one I.4 actually specifies:
 * "describe the document's facts, in a strict, versioned shape, with evidence
 * and explicit reason codes for anything missing or ambiguous". That is a
 * whole-document contract, and it is what makes the I.7 deterministic-vs-AI
 * disagreement comparison possible at all — you cannot compare two sources
 * field by field unless the AI side speaks in fields.
 *
 * THE ANTI-INVENTION RULES ARE ENFORCED BY SHAPE, NOT BY POLICY TEXT.
 * Global invariant D.4 forbids the model inventing ownership, transactions,
 * units, NAV, dates, currencies or FX, and D.5 says `null + reason_code` is
 * valid while a plausible guess is not. Concretely, in this schema:
 *
 *   - Every scalar that could be guessed is `.nullable()` and is paired with
 *     a `missingReasonCode` drawn from a CLOSED enum. There is no way to
 *     express "I don't know" other than by naming why, so a model that wants
 *     to emit a value has to emit one, and a model that cannot has to say
 *     which of four reasons applies.
 *   - `isin` is nullable with a `presentOnDocument` boolean beside it. I.4 is
 *     explicit that an ISIN may be returned "only when present in evidence",
 *     and D.4 forbids inventing an instrument identifier. A model that
 *     returns an ISIN while claiming it was not printed is a SCHEMA
 *     REJECTION via the refinement below, not a judgement call at a call
 *     site that could be forgotten.
 *   - There is NO field anywhere for a canonical id — no accountId, no
 *     instrumentId, no userId, no householdId, no taxLotId. The model is
 *     structurally unable to name a canonical row, so "AI must never invent
 *     ... a canonical instrument" is not a rule the reconciler has to check;
 *     it is a sentence the schema cannot express.
 *   - There is NO confidence field. P4/REC-04: a confidence score must never
 *     be able to change a reconciliation outcome, and the cheapest way to
 *     guarantee that is to give the model no channel to report one.
 *   - `folioToken` is a TOKEN, not a folio. By the time any text reaches a
 *     provider it has been through `maskText`, so the model only ever sees
 *     `[MASKED:folio_number:hmac:...]`. Since M3 those tokens are stable per
 *     (user, folio), which is exactly what makes "account/folio stable
 *     token" (I.4's own wording) a meaningful field rather than a per-call
 *     nonce.
 *
 * `.strict()` at every level composes with JSC-03's unknown-key rejection:
 * an extra property anywhere — including one the model was talked into
 * emitting by injected document text — fails validation rather than being
 * silently dropped.
 *
 * VERSIONING. `AIE_II_DOCUMENT_FACTS_SCHEMA_VERSION` is part of the registry
 * key, and `aie_ai_completion_attempt` records the name and version of the
 * schema each attempt was validated against. A future field addition bumps
 * the version rather than mutating this one in place, so an old recorded
 * attempt stays interpretable against the schema it was actually judged by.
 */

import { z } from 'zod';
import { aieSchemaRegistry } from '../../schema/schemaRegistry';
import { II_ADAPTER_ID } from './parserAdapter';

export const AIE_II_DOCUMENT_FACTS_SCHEMA_NAME = 'aie_ii_document_facts';
export const AIE_II_DOCUMENT_FACTS_SCHEMA_VERSION = '1';

/** CLOSED. D.5: "`null + reason_code` is valid; a plausible guess is not."
 * Every one of these says something about the DOCUMENT, never about the
 * model's own certainty — `low_confidence` is deliberately absent. */
export const II_MISSING_REASON_CODES = [
  'not_present_on_document',
  'illegible',
  'ambiguous',
  'conflicting_values_on_document',
] as const;

/** CLOSED. Mirrors `IiTransactionType` in
 * `lib/services/investment-intelligence/types.ts` exactly, plus `unknown`.
 * Deliberately NOT imported and spread from that type: this is a wire
 * contract with a version attached, and it must be able to stay stable while
 * the internal enum evolves. A mismatch is caught by the test that asserts
 * this list against the canonical one, which fails loudly and makes the
 * version bump a conscious decision rather than an accident. */
export const II_AI_TRANSACTION_TYPE_CANDIDATES = [
  'purchase',
  'sip',
  'redemption',
  'switch_in',
  'switch_out',
  'dividend',
  'reinvestment',
  'transfer',
  'merger',
  'fee',
  'tax',
  'adjustment',
  'unknown',
] as const;

/** Where on the document a fact came from. I.4: "source page/line/region".
 * Required on every fact — an assertion with no provenance is not evidence,
 * and D.3 (source evidence is immutable) has nothing to anchor to without
 * it. */
const sourceLocationSchema = z
  .object({
    page: z.number().int().min(1).nullable(),
    line: z.number().int().min(1).nullable(),
    /** Verbatim text of the line the fact was read from, capped. Lets a
     * reviewer and the I.7 comparator see WHAT was read, not just where. */
    rawText: z.string().max(400).nullable(),
  })
  .strict();

const missingReasonSchema = z.enum(II_MISSING_REASON_CODES).nullable();

/** A decimal carried as a STRING, never a JSON number. JSON numbers are
 * IEEE-754 doubles and this codebase's entire II money layer is exact scaled
 * integers (`decimal.ts`) precisely because a double silently loses units and
 * NAV precision. Accepting a number here would reintroduce that at the one
 * boundary where it is hardest to notice. */
const decimalStringSchema = z
  .string()
  .regex(/^-?\d{1,18}(\.\d{1,6})?$/, 'must be an exact decimal string, not a float')
  .nullable();

const transactionFactSchema = z
  .object({
    transactionDateIso: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    /** The statement's own narrative, verbatim. This is EVIDENCE, and it is
     * what a human reviewer reads when the type candidate is disputed. */
    narrative: z.string().max(400).nullable(),
    transactionTypeCandidate: z.enum(II_AI_TRANSACTION_TYPE_CANDIDATES),
    amount: decimalStringSchema,
    units: decimalStringSchema,
    navOrPrice: decimalStringSchema,
    /** The running unit balance the statement prints after this line. The
     * single most valuable cross-check the deterministic reconciler has, and
     * the reason roll-forward can catch a missing row rather than only a
     * wrong one. */
    runningUnitBalance: decimalStringSchema,
    /** Stamp duty, STT and similar. Named as fees rather than folded into
     * `amount` so a fee is never silently treated as an economic purchase. */
    feeAmount: decimalStringSchema,
    feeKind: z.enum(['stamp_duty', 'stt', 'other', 'none']),
    missingReasonCode: missingReasonSchema,
    sourceLocation: sourceLocationSchema,
  })
  .strict();

const positionFactSchema = z
  .object({
    /** A MASKED TOKEN (`[MASKED:folio_number:hmac:...]`), never a folio. See
     * this file's header. */
    folioToken: z.string().max(120).nullable(),
    amcOrInstitutionText: z.string().max(200).nullable(),
    schemeText: z.string().max(300).nullable(),
    /** D.4: "AI may NOT invent ... a canonical instrument." I.4: an
     * identifier "only when present in evidence". The paired boolean is what
     * the cross-field refinement below enforces against. */
    isin: z
      .string()
      .regex(/^[A-Z]{2}[A-Z0-9]{9}\d$/)
      .nullable(),
    isinPresentOnDocument: z.boolean(),
    /** I.4 "opening balance evidence". Kept as its own field, NOT as a
     * transaction with type `purchase` — PC4-INV-08's whole point is that an
     * opening balance is evidence of a position, not an acquisition, and a
     * schema that can only express it as a transaction invites exactly that
     * mistake. */
    openingUnitBalance: decimalStringSchema,
    openingBalanceStatedOnDocument: z.boolean(),
    closingUnits: decimalStringSchema,
    statementNav: decimalStringSchema,
    statementNavDateIso: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    statementMarketValue: decimalStringSchema,
    missingReasonCode: missingReasonSchema,
    sourceLocation: sourceLocationSchema,
    transactions: z.array(transactionFactSchema).max(500),
  })
  .strict();

export const investmentDocumentFactsSchema = z
  .object({
    schemaVersion: z.literal(AIE_II_DOCUMENT_FACTS_SCHEMA_VERSION),
    documentTypeCandidate: z.enum(['cas_statement', 'folio_details_statement', 'account_statement', 'unknown']),
    /** The RTA/registrar the document says produced it, as text. Never a
     * canonical `ii_sources.source_key` — mapping text to a canonical source
     * is a deterministic decision, not the model's. */
    sourceInstitutionText: z.string().max(200).nullable(),
    statementPeriodStartIso: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    statementPeriodEndIso: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    statementAsOfDateIso: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    positions: z.array(positionFactSchema).max(200),
    /** Document-level reason when the model could read essentially nothing.
     * Present so "I could not read this" has a structured expression and
     * does not have to be inferred from an empty `positions` array. */
    missingReasonCode: missingReasonSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    value.positions.forEach((position, index) => {
      // D.4 / I.4: an ISIN may be returned ONLY when it is present in the
      // evidence. A model that supplies one while stating it was not printed
      // has invented an instrument identifier, which is the single most
      // damaging invention available to it — it would resolve to the WRONG
      // real fund rather than to nothing.
      if (position.isin !== null && position.isinPresentOnDocument === false) {
        ctx.addIssue({
          code: 'custom',
          path: ['positions', index, 'isin'],
          message: 'isin supplied while isinPresentOnDocument is false — an ISIN may only be reported when it appears in the evidence (D.4)',
        });
      }
      // Symmetry guard: claiming an ISIN was printed while supplying none is
      // also incoherent, and would let a model assert the existence of
      // evidence it did not produce.
      if (position.isin === null && position.isinPresentOnDocument === true) {
        ctx.addIssue({
          code: 'custom',
          path: ['positions', index, 'isinPresentOnDocument'],
          message: 'isinPresentOnDocument is true but no isin was supplied',
        });
      }
      // PC4-INV-08 expressed in the wire contract: an opening balance may be
      // reported only when the document states one. Otherwise a model could
      // manufacture an opening position, which is precisely how a fabricated
      // tax lot with an invented cost base gets created downstream.
      if (position.openingUnitBalance !== null && position.openingBalanceStatedOnDocument === false) {
        ctx.addIssue({
          code: 'custom',
          path: ['positions', index, 'openingUnitBalance'],
          message: 'openingUnitBalance supplied while openingBalanceStatedOnDocument is false — an opening balance must be printed evidence, never inferred (PC4-INV-08)',
        });
      }
    });
  });

export type InvestmentDocumentFacts = z.infer<typeof investmentDocumentFactsSchema>;

let registered = false;

export function registerInvestmentDocumentFactsSchema(): void {
  if (registered) return;
  aieSchemaRegistry.register({
    name: AIE_II_DOCUMENT_FACTS_SCHEMA_NAME,
    version: AIE_II_DOCUMENT_FACTS_SCHEMA_VERSION,
    schema: investmentDocumentFactsSchema,
    ownerAdapterId: II_ADAPTER_ID,
  });
  registered = true;
}
