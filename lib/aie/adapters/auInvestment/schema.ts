/**
 * AIE AU investment-statement (FDH-11) AI-fallback adapter — versioned
 * whole-document facts contract.
 *
 * WHAT THE MODEL IS ASKED FOR, AND WHY IT IS SO LITTLE. Exactly what a human
 * reads off an AU broker/fund statement: the header (which institution, which
 * period, which statement date), the holdings table (security, code, ISIN,
 * units, unit price, market value, valuation date) and the activity table
 * (what kind of line, the dates, the security, the units and price, the
 * amount, the brokerage). That is all.
 *
 * Everything else an `fdh_investment_statements` / `_positions` /
 * `_activities` row needs — the statement type, the base currency, the
 * account identity, the reconciliation verdict, the security match, the
 * bank match, the approval state — is either CALLER CONTEXT established before
 * the AI was ever asked, or DERIVED afterwards by the existing, already
 * certified deterministic code (`securityMatching.ts`,
 * `holdingsReconciliation.ts`, `bankMatching.ts`, `cashReconciliation.ts`).
 * The AI is used as a reader for a CSV layout the deterministic extractor
 * could not segment, never as a second implementation of the pipeline. An
 * AI-read statement therefore faces exactly the same matching and
 * reconciliation arithmetic as a natively-parsed one and cannot be approved
 * on weaker evidence.
 *
 * WHAT IS DELIBERATELY ABSENT.
 *   - No `currencyCode`: this pipeline is AU-only and the currency comes from
 *     the upload session the user themselves created (AUD). Currency is never
 *     AI-derived anywhere in this codebase.
 *   - No account identifier of any kind — not even a masked one. FDH-11's
 *     masked account identifier is typed by the user on the upload form, and
 *     an AU statement's account reference is a HIN/SRN, which
 *     `lib/aie/masking/piiMasking.ts` tokenises before egress: asking the
 *     model for it could therefore only ever return a masking token or an
 *     identifier this module has spent real effort NOT to carry. Identity is
 *     caller context (spec sections 20, 23).
 *   - No `statementType`: it follows from the kind of export the user said
 *     they were uploading, not from the model's impression of the page.
 *   - No confidence field anywhere (P4/REC-04).
 *
 * MONEY AND QUANTITIES ARE EXACT DECIMAL STRINGS, NOT JSON NUMBERS. This is
 * not a stylistic choice here: `AuStatementPositionEvidence.quantity` and
 * `AuStatementTransactionEvidence.amount` are typed `string` in
 * `lib/financial-data-hub/investment/types.ts` precisely to keep IEEE-754
 * float loss out of a share registry's 6-decimal unit holdings, so a JSON
 * number would be a TYPE ERROR at the mapping boundary rather than a silent
 * rounding. The shared builders in `../shared/factsFields.ts` enforce it.
 */

import { z } from 'zod';
import { aieSchemaRegistry } from '../../schema/schemaRegistry';
import {
  aieDateField,
  aieTextField,
  aieMissingReasonSchema,
  aieLineItemMoney,
  aieLineItemQuantity,
  aieLineItemDate,
} from '../shared/factsFields';
import { AU_STATEMENT_TRANSACTION_TYPES } from '@/lib/financial-data-hub/investment/types';

export const AIE_AU_INVESTMENT_FACTS_SCHEMA_NAME = 'aie_au_investment_statement_document_facts';
export const AIE_AU_INVESTMENT_FACTS_SCHEMA_VERSION = '1';

/**
 * Hard caps on rows in one extraction, one per array.
 *
 * Sized against the line-item output budget
 * (`getAieAiMaxOutputTokensPerLineItemDocument()`, ~4096 output tokens), not
 * chosen aesthetically — and set LOWER per array than the bank-statement
 * adapter's single 80 because this document type has TWO arrays sharing that
 * one budget: a portfolio statement that also prints its activity history can
 * fill both. A truncated response is not a cheap failure here (it is billed
 * and returns nothing usable), so the caps are deliberately conservative.
 *
 * A statement with more rows than this does not fail silently: the model is
 * asked to state whether it listed every line (`allRowsListed`), that claim is
 * shown to the user in words during review, and — far more usefully, because
 * it does not depend on the model being honest — the reviewed rows are still
 * put through FDH-11's own holdings reconciliation, where missing units show
 * up as a variance rather than as a clean import.
 */
export const AIE_AU_INVESTMENT_MAX_HOLDINGS = 40;
export const AIE_AU_INVESTMENT_MAX_TRANSACTIONS = 40;

/** One holdings line as PRINTED. Flat and small on purpose: a per-field
 * `missingReasonCode` envelope on every row would multiply the token cost of
 * the whole document for no benefit, because a row the model could not read
 * should simply be omitted. */
export const auInvestmentHoldingSchema = z
  .object({
    /** The security's printed name. Required: a holding with no identity at
     * all is not reviewable evidence, and `AuStatementPositionEvidence`
     * requires it. */
    securityNameRaw: z.string().min(1).max(300),
    /** The exchange code as printed (e.g. `VAS`). Null when the layout prints
     * only a name. Never normalised here — `securityMatching.ts` owns that. */
    tickerRaw: z.string().max(32).nullable(),
    isin: z.string().max(32).nullable(),
    /** Units held. Required, as exact decimal string — a position without a
     * unit count cannot be reconciled against anything, and
     * `AuStatementPositionEvidence.quantity` is non-optional. */
    quantity: aieLineItemQuantity,
    /** UNIT PRICE USES THE WIDER `aieLineItemQuantity` DECIMAL, NOT
     * `aieLineItemMoney`, AND THAT IS DELIBERATE. Australian share and
     * managed-fund statements routinely print unit prices to 3-6 decimal
     * places (a fund's unit price of `2.73548` is ordinary, not exotic),
     * while the shared money builder caps at 2 — a real price would therefore
     * be REJECTED as schema-invalid and lose the whole extraction. The shared
     * builders are owned by another dispatch and are not edited from here, so
     * this reuses the wider decimal string that already exists rather than
     * inventing a third regex. Both are exact decimal strings; only the
     * allowed precision differs. */
    unitPrice: aieLineItemQuantity.nullable(),
    marketValue: aieLineItemMoney.nullable(),
    /** The "as at" date printed against the holdings table, when the layout
     * prints one per row. Null is normal and is filled from the caller's own
     * statement date at mapping time — never guessed by the model. */
    valuationDate: aieLineItemDate.nullable(),
  })
  .strict();

export type AuInvestmentHoldingFacts = z.infer<typeof auInvestmentHoldingSchema>;

/** One activity line as PRINTED.
 *
 * `transactionType` is drawn from FDH-11's OWN closed statement vocabulary
 * (`AU_STATEMENT_TRANSACTION_TYPES`) rather than a vocabulary invented here,
 * so an AI-read line and a natively-parsed line are the same kind of thing to
 * `transactionClassification.ts` downstream. The vocabulary already contains
 * `UNKNOWN`, which is the honest answer for a line whose meaning is not
 * printed — the model is told to use it rather than pick the nearest-looking
 * type. */
export const auInvestmentActivitySchema = z
  .object({
    transactionType: z.enum(AU_STATEMENT_TRANSACTION_TYPES),
    tradeDate: aieLineItemDate.nullable(),
    /** Kept SEPARATE from `tradeDate` and never conflated with it (FDH-11 spec
     * section 53) — a T+2 settlement is a genuinely different date and the
     * evidence row stores both. */
    settlementDate: aieLineItemDate.nullable(),
    securityNameRaw: z.string().max(300).nullable(),
    tickerRaw: z.string().max(32).nullable(),
    quantity: aieLineItemQuantity.nullable(),
    /** Wider decimal precision than money, for the same reason as the
     * holdings row's `unitPrice` above. */
    unitPrice: aieLineItemQuantity.nullable(),
    /** POSITIVE MAGNITUDE ONLY. Direction/meaning is carried by
     * `transactionType` and derived downstream, exactly as
     * `AuStatementTransactionEvidence.amount`'s own contract requires; a
     * signed amount here would be a second, contradictory encoding. */
    amount: aieLineItemMoney,
    /** Brokerage printed against this line, when the layout prints it as a
     * separate column rather than as its own `BROKERAGE` row. */
    brokerage: aieLineItemMoney.nullable(),
  })
  .strict();

export type AuInvestmentActivityFacts = z.infer<typeof auInvestmentActivitySchema>;

export const auInvestmentDocumentFactsSchema = z
  .object({
    schemaVersion: z.literal(AIE_AU_INVESTMENT_FACTS_SCHEMA_VERSION),
    documentMissingReasonCode: aieMissingReasonSchema,
    /** The broker/fund name as printed. Used only as a FALLBACK for a user who
     * left the institution box empty on the upload form — what the user typed
     * always wins, because it is the one value they can be sure of. */
    institutionName: aieTextField(200),
    statementDate: aieDateField(),
    statementPeriodStart: aieDateField(),
    statementPeriodEnd: aieDateField(),
    /** The model's own claim that it listed every printed holding and activity
     * line. Recorded and shown to the user, never trusted as the only check —
     * see `AIE_AU_INVESTMENT_MAX_HOLDINGS`. */
    allRowsListed: z.boolean(),
    holdings: z.array(auInvestmentHoldingSchema).max(AIE_AU_INVESTMENT_MAX_HOLDINGS),
    transactions: z.array(auInvestmentActivitySchema).max(AIE_AU_INVESTMENT_MAX_TRANSACTIONS),
  })
  .strict();

export type AuInvestmentDocumentFacts = z.infer<typeof auInvestmentDocumentFactsSchema>;

let registered = false;

/** Idempotent — safe to call from multiple module-load sites and tests, the
 * same convention as every other adapter's `register*Schema()`. */
export function registerAuInvestmentDocumentFactsSchema(): void {
  if (registered) return;
  aieSchemaRegistry.register({
    name: AIE_AU_INVESTMENT_FACTS_SCHEMA_NAME,
    version: AIE_AU_INVESTMENT_FACTS_SCHEMA_VERSION,
    schema: auInvestmentDocumentFactsSchema,
    ownerAdapterId: 'aie_au_investment_statement_ai_fallback_v1',
  });
  registered = true;
}
